// ============================================================
// main.js … アプリの入口（ここから動き始める）
//
// やっていること:
//   1. 起動：キャラクターデータを読み、通信係を準備する
//   2. 入室：ルームを作る／参加する／リロード後に元のルームへ戻る
//   3. 同期：ルームのデータが変わるたびに、画面を描き直す
//   4. 操作：ボタンが押されたら room.js の操作を呼ぶ
//   5. 自動処理：全員が決定したら、結果を計算する
//   6. 効果音：画面が切り替わった瞬間に、場面に合った音を鳴らす
//
// 画面の描画そのものは views.js、ルールの計算は game-logic.js、音を鳴らす仕組みは sound.js にあります。
// ============================================================

import {
  CHARACTERS_URL,
  ROOM_ID_LENGTH,
  NAME_MAX_LENGTH,
  DEFAULT_PLAYER_NAME,
  DRUMROLL_MS,
  DEFAULT_VOLUME,
} from './config.js';
import {
  $,
  escapeHtml,
  showScreen,
  showToast,
  confirmDialog,
  copyText,
  prepareCharacters,
} from './util.js';
import { initBackend, backend, isDemoMode } from './backend.js';
import { makeQrSvg } from './qr.js';
import { initSound, playSound, getVolume, setVolume } from './sound.js';
import {
  DRAW_DECISION,
  modeOf,
  rulesOf,
  originalSettingsOf,
  compatibilityOf,
  roundKeyOf,
  turnKey,
  allActiveSubmitted,
  isBanned,
  isExactHit,
  isLastReveal,
  judgeResult,
  listParticipants,
} from './game-logic.js';
import * as roomApi from './room.js';
import * as views from './views.js';

// ブラウザに覚えさせておく項目の名前
const STORAGE_ROOM = 'thbj-room';   // 最後に入ったルームID（リロード後に戻るため）
const STORAGE_NAME = 'thbj-name';   // 最後に使ったプレイヤー名
const STORAGE_HINT = 'thbj-hint';   // オリジナルで初心者のヒントを表示するか（'1' なら表示）
const RETURN_LIMIT_MS = 12 * 60 * 60 * 1000;   // これより古いルームには自動で戻らない（12時間）

/** アプリ全体の状態。画面はすべてこの中身をもとに描かれる */
const app = {
  uid: null,             // 自分のID
  characters: [],        // キャラクターの配列
  charById: new Map(),   // キャラid → キャラクター
  roomId: null,          // いまいるルームのID（入っていなければ null）
  room: null,            // ルームの最新データ
  hostUid: null,         // いまのホストのID（ホストが変わったことに気づくために覚えておく）
  stopWatching: null,    // ルームの監視をやめる関数
  selectedCharId: null,  // 一覧でタップして選んでいるキャラ（決定前）
  myPick: null,          // 自分が決定した選択 { roundKey, charId }
  pickerRoundKey: null,  // キャラ一覧を描画済みのラウンド
  revealRoundKey: null,  // 結果公開の演出を表示済みのラウンド
  submitting: false,     // 決定を送信中か
  showHint: false,       // オリジナルで初心者のヒントを表示するか（この端末だけの設定）
  view: null,            // 直前に表示した場面（'lobby'、'g1t2:select' など。効果音を鳴らす瞬間を見分けるため）
  drumrollUntil: 0,      // 最終結果のドラムロールが終わる時刻（それまで勝者を伏せる）
  drumroll: null,        // 鳴っているドラムロール（止めるため）
};

// ============================================================
// 1. 起動
// ============================================================
async function start() {
  bindEvents();
  try {
    app.characters = await loadCharacters();
    app.charById = new Map(app.characters.map((c) => [c.id, c]));
    app.uid = await initBackend();
  } catch (error) {
    console.error(error);
    $('loading-text').textContent =
      '起動できませんでした：' + (backend ? backend.describeError(error) : error.message);
    $('btn-reload').hidden = false;
    return;
  }

  $('banner-demo').hidden = !isDemoMode;
  app.showHint = backend.storage.getItem(STORAGE_HINT) === '1';
  initSound(backend.storage);
  if (getVolume() > 0) volumeBeforeMute = getVolume();
  views.renderVolume(getVolume());
  views.renderTop();
  watchConnection();
  await openFirstScreen();
}

/**
 * キャラクターデータ(JSON)を読み込む。
 * データは人気投票の順位順に入っているが、一覧では順位が分からないよう、
 * ここで50音順に並べ替える（検索用の文字列もここで用意する）。
 */
async function loadCharacters() {
  const response = await fetch(CHARACTERS_URL);
  if (!response.ok) throw new Error('キャラクターデータを読み込めませんでした。');
  return prepareCharacters(await response.json());
}

/** 通信が切れたらお知らせを出す（一瞬の切断では出さない） */
function watchConnection() {
  let timer = null;
  backend.onConnectionChange((connected) => {
    clearTimeout(timer);
    if (connected) {
      $('banner-offline').hidden = true;
    } else {
      timer = setTimeout(() => {
        $('banner-offline').hidden = false;
      }, 2500);
    }
  });
}

/** 最初に表示する画面を決める */
async function openFirstScreen() {
  const urlRoomId = roomApi.normalizeRoomId(new URLSearchParams(location.search).get('room'));
  const savedRoomId = backend.storage.getItem(STORAGE_ROOM);

  // 招待リンク（?room=XXXXX）で開いたとき：
  // すでにそのルームに入っていればそのまま戻り、まだなら参加画面（ルームID入力済み）を出す
  if (urlRoomId.length === ROOM_ID_LENGTH) {
    if (await canReturnTo(urlRoomId)) {
      enterRoom(urlRoomId);
    } else {
      openJoinScreen(urlRoomId);
    }
    return;
  }

  // ふつうに開いたとき：前回のルームにまだ入っていれば、そこへ戻る（リロード対策）
  if (savedRoomId && (await canReturnTo(savedRoomId))) {
    enterRoom(savedRoomId);
    return;
  }
  backend.storage.removeItem(STORAGE_ROOM);
  showScreen('top');
}

/** そのルームに「すでに入っている人」として戻れるか */
async function canReturnTo(roomId) {
  try {
    const room = await backend.getRoom(roomId);
    if (!room || !room.state || !room.players?.[app.uid]) return false;
    return Date.now() - room.createdAt < RETURN_LIMIT_MS;
  } catch (error) {
    console.warn('ルームの確認に失敗', error);
    return false;
  }
}

// ============================================================
// 2. 入室・退出
// ============================================================

/** ルームに入り、データの変化を受け取り始める */
function enterRoom(roomId) {
  app.roomId = roomId;
  app.room = null;
  app.view = null;   // 入った直後の画面では効果音を鳴らさない（リロードで戻ったときなど）
  backend.storage.setItem(STORAGE_ROOM, roomId);
  backend.startPresence(roomId);
  app.stopWatching = backend.watchRoom(roomId, onRoomChange, (error) => {
    console.error(error);
    exitRoom(backend.describeError(error));
  });
}

/** 自分の画面をトップに戻す（データベースは書き換えない） */
function exitRoom(message) {
  if (app.stopWatching) app.stopWatching();
  stopDrumroll();
  Object.assign(app, {
    roomId: null,
    room: null,
    hostUid: null,
    stopWatching: null,
    selectedCharId: null,
    myPick: null,
    pickerRoundKey: null,
    revealRoundKey: null,
    submitting: false,
    view: null,
    drumrollUntil: 0,
  });
  backend.storage.removeItem(STORAGE_ROOM);

  // URLに ?room=XXXXX が残っていると、リロードで参加画面に戻ってしまうので消す
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);

  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  updateWakeLock();
  showScreen('top');
  if (message) showToast(message, 'error');
}

/** ゲームを続けられないとき：メッセージと「もう一度読み込む」ボタンだけの画面にして止まる */
function stopWithMessage(message) {
  if (app.stopWatching) app.stopWatching();
  app.stopWatching = null;
  $('loading-text').textContent = message;
  $('btn-reload').hidden = false;
  showScreen('loading');
}

/**
 * ルームから退出して、最初の画面に戻る。
 * （待機中なら名簿から自分が消え、ゲーム中ならオフラインになる）
 *
 * 画面は「すぐに」最初の画面へ戻す。退出したことをルームに書き込む通信は、その裏で行う。
 * 通信の完了を待ってから画面を戻すと、電波が悪いときに、いつまでも戻れなくなるため。
 * （通信が切れていても、つながり直したときに自動で送られる）
 */
function leaveRoom() {
  const { roomId, room } = app;
  exitRoom();   // ルームの監視を止めて、最初の画面へ
  roomApi.leaveRoom(roomId, room).catch((error) => console.warn('退出の書き込みに失敗', error));
}

// ============================================================
// 3. 同期：ルームのデータが変わるたびに呼ばれる
// ============================================================
function onRoomChange(room) {
  if (!app.roomId) return;   // もう退出している

  if (!room || !room.state) {
    exitRoom('ルームが見つかりません。（削除された可能性があります）');
    return;
  }
  if (!room.players?.[app.uid]) {
    exitRoom('このルームには参加していません。');
    return;
  }

  // ゲーム中のルームのルールを、この画面（読み込み済みのプログラム）で正しく扱えるか確かめる。
  // 扱えないまま進めると、人によって違うルールで計算してしまうので、ここで止まる。
  const compatibility = compatibilityOf(room.state);
  if (compatibility === 'reload') {
    // ゲームが更新されてモードやルールが増えたのに、古い画面のまま開いている → 再読み込みすれば直る
    stopWithMessage('ゲームが新しくなっています。ページを再読み込みしてください。');
    return;
  }
  if (compatibility === 'broken') {
    // 前のバージョンの画面から始められたゲーム → この画面では続けられないので、ルームから出る
    // （出ておかないと、再読み込みしても同じルームに戻ってきてしまう）
    app.room = room;
    leaveRoom();
    stopWithMessage(
      'このルームのゲームは、古いバージョンの画面から始められたため、続けられません。' +
        '全員がページを再読み込みしてから、ルームを作り直してください。'
    );
    return;
  }

  app.room = room;
  noticeHostChange();
  try {
    render();
    autoActions();
  } catch (error) {
    console.error('画面の更新に失敗', error);
  }
  updateWakeLock();
}

/**
 * ホストが自分に変わったら知らせる。
 * （ホストが退出したり、通信が切れたりすると、残っている人のうち最初に入室した人がホストになる）
 */
function noticeHostChange() {
  const hostUid = roomApi.hostUidOf(app.room);
  const becameHost = app.hostUid !== null && app.hostUid !== hostUid && hostUid === app.uid;
  app.hostUid = hostUid;
  if (!becameHost) return;
  showToast(
    app.room.state.status === 'lobby'
      ? 'あなたがホストになりました。ゲームモードの選択とゲーム開始ができます。'
      : 'あなたがホストになりました。ゲームを進められます。'
  );
}

/** ルームの状態に合った画面を表示する */
function render() {
  if (!app.room) return;
  const state = app.room.state;

  // 効果音：直前に表示していた場面と比べて、切り替わった瞬間なら音を鳴らす
  const view = viewKeyOf(state);
  const previousView = app.view;
  app.view = view;
  if (previousView !== null && previousView !== view) playSceneSound(previousView, state);

  // ゲームが始まったら、待機画面で開いていた招待用のQRコードは閉じる
  if (state.status !== 'lobby' && $('dialog-qr').open) $('dialog-qr').close();

  if (state.status === 'lobby') {
    showScreen('lobby');
    views.renderLobby(app);
    return;
  }

  if (state.status === 'finished') {
    showScreen('result');
    views.renderResult(app);
    // ドラムロールのあいだは、勝者と順位を伏せておく（style.css の .is-drumroll）
    $('screen-result').classList.toggle('is-drumroll', Date.now() < app.drumrollUntil);
    return;
  }

  const roundKey = roundKeyOf(state);

  if (state.phase === 'reveal') {
    showScreen('reveal');
    // カードの演出は1ターンにつき1回だけ（データが届くたびにやり直さない）
    if (app.revealRoundKey !== roundKey) {
      app.revealRoundKey = roundKey;
      views.renderRevealCards(app);
      window.scrollTo(0, 0);
    }
    views.renderRevealFooter(app);
    return;
  }

  // ---- 選択フェーズ ----
  showScreen('game');
  // 新しいターンに入ったときだけ、選択と検索をリセットして一覧を作り直す
  // （毎回作り直すと、検索中の文字やスクロール位置が消えてしまうため）
  if (app.pickerRoundKey !== roundKey) {
    app.pickerRoundKey = roundKey;
    app.selectedCharId = null;
    $('input-search').value = '';
    views.renderCharList(app);
    window.scrollTo(0, 0);
  }
  views.renderGame(app);
}

// ============================================================
// 5. 自動処理：全員が決定したら結果を計算する
// ============================================================
let resolvingKey = null;   // 結果を計算中のラウンド（二重に実行しないため）
let restoringKey = null;   // 自分の選択を読み直し中のラウンド

function autoActions() {
  const state = app.room.state;
  if (state.status !== 'playing' || state.phase !== 'select') return;

  const me = state.scores[app.uid];
  if (!me) return;   // 観戦者は何もしない

  const roundKey = roundKeyOf(state);
  const submitted = app.room.submitted?.[roundKey] || {};

  // リロードした直後など、「決定済みなのに、誰を選んだか手元にない」ときは読み直す
  if (!me.out && submitted[app.uid] && app.myPick?.roundKey !== roundKey) {
    restoreMyPick(roundKey);
  }

  // 全員の選択を読めるのは「自分が決定済み」か「バーストした（out）」人だけ。
  // その人たちの端末が、全員そろったことに気づいた時点で結果を計算する。
  const canReadPicks = me.out || submitted[app.uid];
  if (canReadPicks && allActiveSubmitted(state, submitted)) {
    resolveTurn(roundKey);
  }
}

async function resolveTurn(roundKey) {
  if (resolvingKey === roundKey) return;
  resolvingKey = roundKey;

  let done = false;
  try {
    done = await roomApi.resolveTurn(app.roomId, app.room, app.charById);
  } catch (error) {
    console.warn('結果の計算に失敗', error);
  }
  if (done) return;

  // 書き込めなかったとき：ほかの端末が先に計算したなら、もう選択フェーズではないので
  // 何も起きない。本当に失敗していた場合に備えて、少し待ってからもう一度確かめる。
  setTimeout(() => {
    if (resolvingKey === roundKey) resolvingKey = null;
    if (app.room) autoActions();
  }, 3000);
}

async function restoreMyPick(roundKey) {
  if (restoringKey === roundKey) return;
  restoringKey = roundKey;
  try {
    const charId = await backend.readMyPick(app.roomId, roundKey);
    const stillSameRound = app.room && roundKeyOf(app.room.state) === roundKey;
    if (charId && stillSameRound) {
      app.myPick = { roundKey, charId };
      render();
    }
  } catch (error) {
    console.warn('自分の選択の読み直しに失敗', error);
    restoringKey = null;
  }
}

// ============================================================
// 6. 効果音：場面が切り替わった瞬間に鳴らす
//   ・鳴らすのは「切り替わる前の場面を、この端末で見ていた」ときだけ。
//     リロードした直後や、途中から入ったときは鳴らさない（同じ音が何度も鳴らないように）
//   ・各スマホが「自分の結果」に合わせて鳴らす。結果公開の瞬間、あちこちで違う音が鳴る
//   ・どの音のファイルを使うかは config.js の SOUNDS で決める
// ============================================================

// ターン結果のカードが現れる時間（style.css の .reveal-card と同じ数字にしておく）
const REVEAL_FIRST_CARD_S = 0.7;   // 最初のカードが現れるまで（秒）
const REVEAL_CARD_GAP_S = 0.75;    // カードとカードの間（秒）
const REVEAL_STAMP_S = 0.6;        // カードが現れてから「バースト」などの印が出るまで（秒）

/** いまの場面を表す文字。例：'lobby'、'g1t2:select'（1ゲーム目・2ターン目の選択中）、'finished:1' */
function viewKeyOf(state) {
  if (state.status === 'lobby') return 'lobby';
  if (state.status === 'finished') return `finished:${state.gameNo}`;
  return `${roundKeyOf(state)}:${state.phase}`;
}

/** 場面が previousView から state に切り替わったときの音 */
function playSceneSound(previousView, state) {
  if (state.status === 'playing' && previousView === 'lobby') {
    playSound('start');   // ゲーム開始：和太鼓でドドン
  } else if (state.status === 'playing' && state.phase === 'reveal' && previousView === `${roundKeyOf(state)}:select`) {
    playRevealSounds(state);
  } else if (state.status === 'finished' && previousView.endsWith(':reveal')) {
    startDrumroll();
  }
}

/**
 * ターンの結果公開：全員に「ジャン！」。
 * そのあと、自分のカードに「バースト」などの印が出るタイミングで、自分の結果に合った音を重ねる。
 */
function playRevealSounds(state) {
  playSound('reveal');
  const result = state.history?.[turnKey(state.turn)]?.[app.uid];
  if (!result) return;   // 観戦中（このターンの結果がない）

  let name = null;
  if (result.out) name = 'burst';                                               // チーン
  else if (result.outcome === 'duplicate') name = 'duplicate';                  // ガーン
  else if (result.outcome === 'none' || result.outcome === 'invalid') name = 'zero';   // えっ？
  else if (isLastReveal(state) && isExactHit(rulesOf(state), result.after)) name = 'exact';   // テッテレー
  if (!name) return;   // ふつうに加点・見送り：「ジャン！」だけ

  // 自分のカードが何番目に現れるか（views.js の renderRevealCards と同じ並び順）
  const index = listParticipants(state).findIndex((player) => player.uid === app.uid);
  // 動きを減らす設定の人は、カードがいっせいに出るので、少しだけ間をあけて鳴らす
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const delay = reduced ? 0.8 : REVEAL_FIRST_CARD_S + index * REVEAL_CARD_GAP_S + REVEAL_STAMP_S;
  playSound(name, { delay });
}

/**
 * 最終結果の前のドラムロール。DRUMROLL_MS のあいだ勝者を伏せておき、
 * 終わったらシンバルを鳴らして結果を見せ、自分の結果に合った音を鳴らす。
 */
function startDrumroll() {
  const view = app.view;
  app.drumrollUntil = Date.now() + DRUMROLL_MS;
  app.drumroll = playSound('drumroll');
  setTimeout(() => {
    stopDrumroll();
    app.drumrollUntil = 0;
    if (!app.room || app.view !== view) return;   // そのあいだに退出した・次の場面に進んだ
    playSound('rollEnd');
    playResultSound(app.room.state);
    render();   // 伏せていた勝者と順位を見せる
  }, DRUMROLL_MS);
}

function stopDrumroll() {
  app.drumroll?.stop();
  app.drumroll = null;
}

/** 最終結果：勝者はファンファーレと歓声、負けた人は「ちゃんちゃん♪」、観戦していた人は拍手 */
function playResultSound(state) {
  const { winners, ranking } = judgeResult(state);
  const me = ranking.find((player) => player.uid === app.uid);
  if (me?.isWinner) {
    playSound('win', { delay: 0.3 });
    playSound('cheer', { delay: 0.6 });
  } else if (me || winners.length === 0) {
    playSound('lose', { delay: 0.3 });
  } else {
    playSound('cheer', { delay: 0.3 });
  }
}

// ============================================================
// 4. 操作：ボタンが押されたときの処理
// ============================================================

/** エラーを画面に出す。errorElement があればフォームの中に、なければトーストで */
function showError(error, errorElement) {
  const isGameError = error instanceof roomApi.GameError;
  if (!isGameError) console.error(error);
  const message = isGameError ? error.message : backend.describeError(error);
  if (errorElement) {
    errorElement.textContent = message;
    errorElement.hidden = false;
  } else {
    showToast(message, 'error');
  }
}

/**
 * ボタンの処理を実行する。
 * 実行中はボタンを押せなくし（連打対策）、失敗したらエラーを表示する。
 */
async function runTask(button, task, errorElement) {
  if (button.disabled) return;
  button.disabled = true;
  if (errorElement) errorElement.hidden = true;
  try {
    await task();
  } catch (error) {
    showError(error, errorElement);
  } finally {
    button.disabled = false;
    render();   // ボタンの「押せる／押せない」を最新の状態に合わせ直す
  }
}

function rememberName(name) {
  backend.storage.setItem(STORAGE_NAME, roomApi.cleanName(name));
}

/** 名前の入力欄に最初から入れておく名前（前回使った名前。なければデフォルトの「霊夢」） */
function initialName() {
  return backend.storage.getItem(STORAGE_NAME) || DEFAULT_PLAYER_NAME;
}

function openCreateScreen() {
  $('input-create-name').value = initialName();
  $('error-create').hidden = true;
  showScreen('create');
}

function openJoinScreen(roomId = '') {
  $('input-join-room').value = roomId;
  $('input-join-name').value = initialName();
  $('error-join').hidden = true;
  showScreen('join');
}

/** 「ルームを作成する」 */
function onCreate(event) {
  event.preventDefault();
  const name = $('input-create-name').value;
  runTask(
    $('btn-create'),
    async () => {
      const roomId = await roomApi.createRoom(name);
      rememberName(name);
      enterRoom(roomId);
    },
    $('error-create')
  );
}

/** 「参加する」 */
function onJoin(event) {
  event.preventDefault();
  const roomId = roomApi.normalizeRoomId($('input-join-room').value);
  const name = $('input-join-name').value;
  $('input-join-room').value = roomId;
  runTask(
    $('btn-join'),
    async () => {
      await roomApi.joinRoom(roomId, name);
      if (roomApi.cleanName(name)) rememberName(name);
      enterRoom(roomId);
    },
    $('error-join')
  );
}

/** 招待リンク（開くとルームID入力済みの参加画面になるURL） */
function inviteUrl() {
  const url = new URL(location.href);
  url.hash = '';
  url.searchParams.set('room', app.roomId);
  return url.toString();
}

async function onShare() {
  const url = inviteUrl();
  // スマホでは共有メニュー（LINEなど）を開く
  if (navigator.share) {
    try {
      await navigator.share({
        title: '東方人気投票ブラックジャック',
        text: `いっしょに遊ぼう！ ルームID：${app.roomId}`,
        url,
      });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;   // 共有をキャンセルした
    }
  }
  // 共有メニューが使えないときはコピーする
  showToast((await copyText(url)) ? '招待リンクをコピーしました' : url);
}

async function onCopyRoomId() {
  showToast((await copyText(app.roomId)) ? 'ルームIDをコピーしました' : `ルームID：${app.roomId}`);
}

/**
 * 「QRコードを表示」：招待リンクをQRコードにして、大きく表示する。
 * 近くにいる人がスマホのカメラで読み取ると、ルームIDが入った参加画面が開く。
 * （QRコードの中身は「招待リンクを送る」で送られるURLと同じ）
 */
async function onShowQr() {
  const roomId = app.roomId;
  const box = $('qr-box');
  $('qr-room-id').textContent = roomId;
  $('qr-hint').textContent = isDemoMode
    ? 'お試しモードでは、ほかのスマホからは参加できません。このブラウザの別のタブで遊んでください。'
    : 'スマホのカメラで読み取ると、このルームの参加画面が開きます。';
  box.innerHTML = '<p class="qr-message">QRコードを作っています…</p>';
  $('dialog-qr').showModal();

  try {
    const svg = await makeQrSvg(inviteUrl());
    // 作っているあいだに、ダイアログを閉じた・ルームを出たときは何もしない
    if ($('dialog-qr').open && app.roomId === roomId) box.innerHTML = svg;
  } catch (error) {
    console.warn('QRコードの作成に失敗', error);
    box.innerHTML =
      `<p class="qr-message">${escapeHtml(error.message)}<br>` +
      '代わりに「招待リンクを送る」か、ルームIDを伝えてください。</p>';
  }
}

/** 待機画面でゲームモードをタップ（選べるのはホストだけ。ほかの人のボタンは押せない状態になっている） */
function onModeTap(event) {
  const row = event.target.closest('[data-mode]');
  if (!row) return;
  const modeId = row.dataset.mode;
  if (modeId === modeOf(app.room.state).id) return;   // すでに選ばれている
  // 準備中のモードを選ぶと、ここでエラーになってメッセージが出る
  roomApi.setMode(app.roomId, app.room, modeId).catch((error) => showError(error));
}

// ---- オリジナルの設定・初心者のヒント ----

/**
 * 待機画面で、オリジナルの設定（数字の借り先・キャラの出し方）をタップ（選べるのはホストだけ）。
 * 選んだ設定はルームに保存され、参加者の待機画面にも同じ内容が表示される。
 */
function onOriginalOptionTap(event) {
  const row = event.target.closest('[data-original-base], [data-draw-style]');
  if (!row || row.disabled) return;
  const settings = { ...originalSettingsOf(app.room.state) };
  if (row.dataset.originalBase) settings.base = row.dataset.originalBase;
  if (row.dataset.drawStyle) settings.drawStyle = row.dataset.drawStyle;
  roomApi.setOriginalSettings(app.roomId, app.room, settings).catch((error) => showError(error));
}

/**
 * 「初心者（ヒントを表示）」のチェック。この端末にだけ覚えさせる（ルームのデータには書かない）。
 * 次にこの端末で遊ぶときも、同じ設定になる。
 */
function onHintToggle(event) {
  app.showHint = event.target.checked;
  backend.storage.setItem(STORAGE_HINT, app.showHint ? '1' : '0');
}

// ---- 効果音の大きさ（待機画面とゲーム中のメニューにある、同じつまみ）----

let volumeBeforeMute = DEFAULT_VOLUME;   // スピーカーのボタンで消音する前の大きさ（元に戻すため）

/** つまみを動かしているあいだ：大きさを変えて、2つのつまみの表示をそろえる */
function onVolumeInput(event) {
  setVolume(Number(event.target.value));
  views.renderVolume(getVolume());
}

/** つまみから指を離したとき：いまの大きさで「ジャン！」を1回鳴らして、聞こえ方を確かめてもらう */
function onVolumeChange() {
  if (getVolume() > 0) volumeBeforeMute = getVolume();
  playSound('reveal');
}

/** スピーカーのボタン：鳴っていれば消音（0）にし、消音中なら元の大きさに戻す */
function onMuteTap() {
  if (getVolume() > 0) {
    volumeBeforeMute = getVolume();
    setVolume(0);
  } else {
    setVolume(volumeBeforeMute);
    playSound('reveal');
  }
  views.renderVolume(getVolume());
}

/** 「ゲーム開始」（ホスト） */
async function onStart() {
  const offlineNames = roomApi
    .listPlayers(app.room)
    .filter((p) => !roomApi.isOnline(app.room, p.uid))
    .map((p) => p.name);
  if (offlineNames.length > 0) {
    const ok = await confirmDialog({
      title: 'このまま開始しますか？',
      message: `${offlineNames.join('、')} はオフラインのため、このゲームには参加できません。`,
      okLabel: '開始する',
    });
    if (!ok) return;
  }
  runTask($('btn-start'), () => roomApi.startGame(app.roomId, app.room, app.characters));
}

/** キャラクター一覧をタップ */
function onCharTap(event) {
  const row = event.target.closest('[data-char-id]');
  if (!row) return;
  const charId = Number(row.dataset.charId);

  if (isBanned(app.room.state, charId)) {
    showToast('このキャラクターは重複したため、もう選べません。', 'error');
    return;
  }

  // スマホの文字入力キーボードを閉じる（下の決定ボタンが隠れないように）
  $('input-search').blur();

  app.selectedCharId = charId;
  views.markSelectedChar(app);
  views.renderPickPanel(app);
}

/** 「このキャラクターを選択」（決定） */
async function onDecide() {
  if (!app.charById.has(app.selectedCharId)) {
    showToast('先に、一覧からキャラクターを選んでください。', 'error');
    return;
  }
  if (app.submitting) return;

  const roundKey = roundKeyOf(app.room.state);
  const charId = app.selectedCharId;
  app.submitting = true;
  app.myPick = { roundKey, charId };   // すぐに「決定済み」の表示へ切り替える
  render();

  try {
    await roomApi.submitPick(app.roomId, app.room, charId, app.charById);
  } catch (error) {
    app.myPick = null;   // 送れなかったら、選択画面に戻す
    showError(error);
  } finally {
    app.submitting = false;
    render();
  }
}

/**
 * オリジナル：「持つ」「持たない」（押すとすぐに決定する。あとから変えられない）
 * @param {boolean} keep 持つなら true
 */
async function onDrawDecision(keep) {
  if (app.submitting) return;
  const roundKey = roundKeyOf(app.room.state);
  app.submitting = true;
  // すぐに「決定済み」の表示へ切り替える（charId のところに「持つ／持たない」の値を入れる）
  app.myPick = { roundKey, charId: keep ? DRAW_DECISION.keep : DRAW_DECISION.pass };
  render();

  try {
    await roomApi.submitDrawDecision(app.roomId, app.room, keep);
  } catch (error) {
    app.myPick = null;   // 送れなかったら、選ぶ画面に戻す
    showError(error);
  } finally {
    app.submitting = false;
    render();
  }
}

/** 「未選択の人を待たずに結果を公開」（ホスト） */
async function onForce() {
  const state = app.room.state;
  const submitted = app.room.submitted?.[roundKeyOf(state)] || {};
  const waitingNames = listParticipants(state)
    .filter((p) => !p.out && !submitted[p.uid])
    .map((p) => p.name);

  const ok = await confirmDialog({
    title: '結果を公開しますか？',
    message: `${waitingNames.join('、')} はまだ選択していません。このまま公開すると、このターンは +0 になります。`,
    okLabel: '公開する',
  });
  if (!ok) return;
  runTask($('btn-force'), () => roomApi.resolveTurn(app.roomId, app.room, app.charById));
}

/** 待機画面の「最初の画面に戻る」 */
async function onLeaveLobby() {
  // ほかに人がいるときだけ確認する（自分だけのルームなら、そのまま戻る）
  const others = roomApi.listPlayers(app.room).filter((p) => p.uid !== app.uid);
  if (others.length > 0) {
    const iAmHost = roomApi.hostUidOf(app.room) === app.uid;
    const ok = await confirmDialog({
      title: '最初の画面に戻りますか？',
      message: iAmHost
        ? 'ルームから退出します。ホストは、残っている人に引き継がれます。'
        : 'ルームから退出します。同じルームIDを入力すれば、また参加できます。',
      okLabel: '戻る',
    });
    if (!ok) return;
  }
  leaveRoom();
}

async function onLeaveGame() {
  const ok = await confirmDialog({
    title: 'ゲームから抜けますか？',
    message: '同じルームIDを入力すれば、途中から戻れます。',
    okLabel: '抜ける',
  });
  if (ok) leaveRoom();
}

/** すべてのボタンに処理を結びつける（起動時に1回だけ呼ぶ） */
function bindEvents() {
  $('btn-reload').addEventListener('click', () => location.reload());

  for (const input of [$('input-create-name'), $('input-join-name')]) {
    // 名前の入力欄の文字数制限と入力例は、config.js の設定に合わせる
    input.maxLength = NAME_MAX_LENGTH;
    input.placeholder = `例：${DEFAULT_PLAYER_NAME}`;
    // 入力欄をタップしたら中の名前を全部選ぶ（そのまま打てば、自分の名前に置き換わる）
    input.addEventListener('focus', () => setTimeout(() => input.select(), 0));
  }

  // トップ・作成・参加
  $('btn-top-create').addEventListener('click', openCreateScreen);
  $('btn-top-join').addEventListener('click', () => openJoinScreen());
  $('form-create').addEventListener('submit', onCreate);
  $('form-join').addEventListener('submit', onJoin);

  // 待機
  $('btn-copy-id').addEventListener('click', onCopyRoomId);
  $('btn-share').addEventListener('click', onShare);
  $('btn-qr').addEventListener('click', onShowQr);
  $('lobby-modes').addEventListener('click', onModeTap);
  $('original-options').addEventListener('click', onOriginalOptionTap);
  $('input-hint').addEventListener('change', onHintToggle);
  $('btn-start').addEventListener('click', onStart);
  $('btn-leave-lobby').addEventListener('click', onLeaveLobby);

  // 効果音の大きさ（待機画面とゲーム中のメニューの両方のつまみ）
  for (const control of document.querySelectorAll('.volume')) {
    control.querySelector('.volume-slider').addEventListener('input', onVolumeInput);
    control.querySelector('.volume-slider').addEventListener('change', onVolumeChange);
    control.querySelector('.volume-mute').addEventListener('click', onMuteTap);
  }

  // ゲーム
  $('input-search').addEventListener('input', () => views.renderCharList(app));
  $('char-list').addEventListener('click', onCharTap);
  $('btn-decide').addEventListener('click', onDecide);
  $('btn-keep').addEventListener('click', () => onDrawDecision(true));
  $('btn-pass').addEventListener('click', () => onDrawDecision(false));
  $('btn-force').addEventListener('click', onForce);
  $('btn-leave-game').addEventListener('click', onLeaveGame);

  // ターン結果・最終結果
  $('btn-next').addEventListener('click', () => {
    runTask($('btn-next'), () => roomApi.goNext(app.roomId, app.room, app.characters));
  });
  $('btn-again').addEventListener('click', () => {
    runTask($('btn-again'), () => roomApi.backToLobby(app.roomId));
  });
  $('btn-leave-result').addEventListener('click', leaveRoom);

  // data-action="…" がついた要素は、ここでまとめて処理する
  // （ステータスバーの ☰ のように、描き直されるボタンにも効く）
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    switch (target.dataset.action) {
      case 'go-top':
        showScreen('top');
        break;
      case 'rules':
        views.renderRules(app);
        $('dialog-rules').showModal();
        // 開いたときは「とじる」ボタンが選ばれて下までスクロールされるので、先頭に戻す
        $('dialog-rules').scrollTop = 0;
        break;
      case 'menu':
        views.renderMenu(app);
        $('dialog-menu').showModal();
        break;
      case 'close-dialog':
        target.closest('dialog').close();
        break;
    }
  });
}

// ============================================================
// おまけ：ゲーム中は画面を自動で消灯させない
// （スマホがスリープすると通信が切れて、ほかの人を待たせてしまうため）
// 対応していないブラウザでは何も起きない。
// ============================================================
let wakeLock = null;
let wakeLockBusy = false;   // お願いしている最中か（二重にお願いしないため）

async function updateWakeLock() {
  if (wakeLockBusy) return;
  wakeLockBusy = true;
  const playing = app.room?.state?.status === 'playing';
  try {
    if (playing && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!playing && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    // 省電力モードなどで断られることがある。ゲームは問題なく続けられる
  } finally {
    wakeLockBusy = false;
  }
}
// 別のアプリから戻ってきたときは、もう一度お願いし直す必要がある
document.addEventListener('visibilitychange', updateWakeLock);

start();
