// ============================================================
// main.js … アプリの入口（ここから動き始める）
//
// やっていること:
//   1. 起動：キャラクターデータを読み、通信係を準備する
//   2. 入室：ルームを作る／参加する／リロード後に元のルームへ戻る
//   3. 同期：ルームのデータが変わるたびに、画面を描き直す
//   4. 操作：ボタンが押されたら room.js の操作を呼ぶ
//   5. 自動処理：全員が決定したら、結果を計算する
//
// 画面の描画そのものは views.js、ルールの計算は game-logic.js にあります。
// ============================================================

import { CHARACTERS_URL, ROOM_ID_LENGTH, NAME_MAX_LENGTH, DEFAULT_PLAYER_NAME } from './config.js';
import { $, showScreen, showToast, confirmDialog, copyText, prepareCharacters, parseWholeNumber } from './util.js';
import { initBackend, backend, isDemoMode } from './backend.js';
import {
  modeOf,
  compatibilityOf,
  roundKeyOf,
  allActiveSubmitted,
  isBanned,
  listParticipants,
} from './game-logic.js';
import * as roomApi from './room.js';
import * as views from './views.js';

// ブラウザに覚えさせておく項目の名前
const STORAGE_ROOM = 'thbj-room';   // 最後に入ったルームID（リロード後に戻るため）
const STORAGE_NAME = 'thbj-name';   // 最後に使ったプレイヤー名
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
  });
  backend.storage.removeItem(STORAGE_ROOM);

  // URLに ?room=XXXXX が残っていると、リロードで参加画面に戻ってしまうので消す
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);

  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  views.resetLobby();
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

  if (state.status === 'lobby') {
    showScreen('lobby');
    views.renderLobby(app);
    return;
  }

  if (state.status === 'finished') {
    showScreen('result');
    views.renderResult(app);
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

/** 待機画面でゲームモードをタップ（選べるのはホストだけ。ほかの人のボタンは押せない状態になっている） */
function onModeTap(event) {
  const row = event.target.closest('[data-mode]');
  if (!row) return;
  const modeId = row.dataset.mode;
  if (modeId === modeOf(app.room.state).id) return;   // すでに選ばれている
  // 準備中のモードを選ぶと、ここでエラーになってメッセージが出る
  roomApi.setMode(app.roomId, app.room, modeId).catch((error) => showError(error));
}

// ---- オリジナルのルール設定（ホストだけに出る設定欄）----

/** 設定欄から、入力されている値を読む（数字でない入力は NaN になる） */
function readOriginalForm() {
  const rules = {};
  for (const [key, id] of Object.entries(views.ORIGINAL_INPUTS)) {
    rules[key] = parseWholeNumber($(id).value);
  }
  return rules;
}

/**
 * 設定欄に入力しているとき（1文字ごとに呼ばれる）：
 * キャラクターの人数と、入力の問題点の表示を更新する。
 * 目標値を変えたときは、バーストする点数を自動で「目標値 + 1」にする。
 */
function onOriginalInput(event) {
  if (event.target.id === views.ORIGINAL_INPUTS.targetScore) {
    const targetScore = parseWholeNumber(event.target.value);
    if (Number.isInteger(targetScore)) $(views.ORIGINAL_INPUTS.burstScore).value = targetScore + 1;
  }
  views.renderOriginalCheck(app, readOriginalForm());
}

/**
 * 設定欄の入力を終えたとき（ほかの場所をタップした・キーボードを閉じたときに呼ばれる）：
 * 問題がなければ、ルールをルームに保存する。保存すると、参加者の待機画面にも同じ内容が表示される。
 */
function onOriginalChange() {
  const rules = readOriginalForm();
  if (views.renderOriginalCheck(app, rules).length > 0) return;   // 問題があるあいだは保存しない
  // 全角で入力された数字などを、読み取った数字（半角）に書き直しておく
  for (const [key, id] of Object.entries(views.ORIGINAL_INPUTS)) {
    $(id).value = rules[key];
  }
  roomApi.setOriginalRules(app.roomId, app.room, rules, app.characters).catch((error) => showError(error));
}

/** 「ゲーム開始」（ホスト） */
async function onStart() {
  // オリジナルのときは、設定欄の内容を確かめてもらってから開始する
  let originalRules = null;
  if (modeOf(app.room.state).custom) {
    originalRules = readOriginalForm();
    if (views.renderOriginalCheck(app, originalRules).length > 0) {
      showToast('オリジナルルールの入力を確認してください。', 'error');
      $('original-form').scrollIntoView({ block: 'center' });
      return;
    }
    const ok = await confirmDialog({
      title: 'このルールで開始しますか？',
      message: views
        .rulesRows(originalRules, app.characters)
        .map(([label, value]) => `${label}：${value}`)
        .join('\n'),
      okLabel: '開始する',
    });
    if (!ok) return;
  }

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
  runTask($('btn-start'), () => roomApi.startGame(app.roomId, app.room, originalRules, app.characters));
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
  $('lobby-modes').addEventListener('click', onModeTap);
  $('original-form').addEventListener('input', onOriginalInput);
  $('original-form').addEventListener('change', onOriginalChange);
  for (const id of Object.values(views.ORIGINAL_INPUTS)) {
    // 入力欄をタップしたら中の数字を全部選ぶ（そのまま打てば、新しい数字に置き換わる）
    $(id).addEventListener('focus', (event) => setTimeout(() => event.target.select(), 0));
  }
  $('btn-start').addEventListener('click', onStart);
  $('btn-leave-lobby').addEventListener('click', onLeaveLobby);

  // ゲーム
  $('input-search').addEventListener('input', () => views.renderCharList(app));
  $('char-list').addEventListener('click', onCharTap);
  $('btn-decide').addEventListener('click', onDecide);
  $('btn-force').addEventListener('click', onForce);
  $('btn-leave-game').addEventListener('click', onLeaveGame);

  // ターン結果・最終結果
  $('btn-next').addEventListener('click', () => {
    runTask($('btn-next'), () => roomApi.goNext(app.roomId, app.room));
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
