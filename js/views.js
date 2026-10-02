// ============================================================
// views.js … 画面の描画（データ → 見た目）
//
// このファイルの関数は、受け取った app（アプリの状態）をもとに
// index.html の中身を書き換えるだけです。
// ボタンを押したときの処理は main.js にあります。
//
// app の中身（main.js で定義）:
//   app.uid            自分のID
//   app.roomId         いまいるルームのID
//   app.room           ルームの最新データ（players / state / submitted）
//   app.characters     キャラクターの配列
//   app.charById       キャラid → キャラクター
//   app.selectedCharId 一覧でタップして選んでいるキャラ（決定前）
//   app.myPick         自分が決定した選択 { roundKey, charId }
//
// ★順位とポイントを表示してよいのは「結果が公開された後」だけ★
//   キャラクターを選ぶ画面（一覧・検索結果・確認欄・決定後の表示）には、
//   順位もポイントも出しません。「選ぶと何点になるか」を隠すのがこのゲームの決まりです。
//   表示するのは、ターン結果画面（renderRevealCards）と最終結果画面（renderResult）だけです。
// ============================================================

import { MIN_PLAYERS, MAX_PLAYERS, VOTE_NAME } from './config.js';
import { $, escapeHtml, normalizeText, searchCharacters } from './util.js';
import {
  rulesOf,
  modeOf,
  listModes,
  presetRules,
  listUsableCharacters,
  rankSpanOf,
  findRuleProblems,
  roundKeyOf,
  turnKey,
  isBanned,
  listParticipants,
  isLastReveal,
  judgeResult,
} from './game-logic.js';
import { listPlayers, isOnline, hostUidOf, startCandidates } from './room.js';

/** バーストしたことを表す、赤いハンコ風の印 */
const BURST_STAMP = '<span class="stamp-out">バースト</span>';

/** 名前の横につける「あなた」の印 */
function meTag(app, uid) {
  return uid === app.uid ? '<span class="tag tag-me">あなた</span>' : '';
}

/** そのuidの人の名前（ゲーム中は参加者の名前、待機中は名簿の名前） */
function nameOf(room, uid) {
  return room.state.scores?.[uid]?.name ?? room.players?.[uid]?.name ?? '？';
}

// ---- ルールを言葉にする ----------------------------------------------
// 画面に出すルールの説明は、すべて rules（そのゲームのルール）から作ります。
// 「150」や「50位」のような数字を、ここに直接は書きません。

/**
 * 「使えるキャラクターの範囲」について調べる。
 *   all   … 全キャラクターを使えるか
 *   count … 使えるキャラクターの人数
 *   last  … 範囲の終わりの順位
 *   text  … 範囲を言葉にしたもの。例: '全キャラクター' / '人気投票 1〜50 位'
 */
function rangeInfo(rules, characters) {
  const count = listUsableCharacters(rules, characters).length;
  const all = count === characters.length;
  const last = rules.maxRank ?? rankSpanOf(characters).last;
  return { all, count, last, text: all ? '全キャラクター' : `人気投票 ${rules.minRank}〜${last} 位` };
}

/**
 * ルールを「項目の名前」と「内容」の組にして返す。
 * 例: [['目標値', '50 点'], ['バースト', '51 点以上'], ['ターン数', '5 ターン'], ['キャラクター', '人気投票 1〜50 位（50人）']]
 * 待機画面のルールの欄と、オリジナルで開始する前の確認に使う。
 */
export function rulesRows(rules, characters) {
  const range = rangeInfo(rules, characters);
  return [
    ['目標値', `${rules.targetScore} 点`],
    ['バースト', `${rules.burstScore} 点以上`],
    ['ターン数', `${rules.maxTurns} ターン`],
    ['キャラクター', `${range.text}（${range.count}人）`],
  ];
}

/** 「遊び方」に出す、そのルールの説明文 */
function describeRules(rules, characters) {
  const range = rangeInfo(rules, characters);
  const ranks = rules.minRank === 1 ? `上位${range.last}位` : `${rules.minRank}〜${range.last}位`;
  const using = range.all
    ? `${VOTE_NAME}の順位を使って`
    : `${VOTE_NAME}の${ranks}のキャラクターだけを使って`;
  return (
    `${using}、${rules.targetScore}点を目指します。` +
    `${rules.maxTurns}回の選択で、${rules.targetScore}点にできるだけ近づけてください。` +
    `${rules.burstScore}点以上になるとバーストです。`
  );
}

/**
 * 「スティールはない」「最後の選択に注意」の注意書き。
 * @param {string} lastPick 最後の選択を表す言葉。例: '5回目（最後）'
 */
function stealNote(lastPick) {
  return (
    '※このゲームには、相手の点数を奪う「スティール」はありません。' +
    `${lastPick}の選択で、目標値にちょうど近くなるように注意してください。`
  );
}

// ============================================================
// 1. トップ画面
// ============================================================

/** いま遊べるモードを並べる。例: 'ハード：150点を目指す ／ ノーマル：50点を目指す ／ オリジナル：自分でルールを設定' */
export function renderTop() {
  // 幅が足りないときに言葉の途中で改行されないよう、モードごとに <span> に入れている
  $('hero-modes').innerHTML = listModes()
    .filter((mode) => mode.available)
    .map((mode) => `<span>${escapeHtml(mode.name)}：${escapeHtml(mode.description)}</span>`)
    .join(' ／ ');
}

// ============================================================
// 4. 待機画面
// ============================================================
export function renderLobby(app) {
  const { room } = app;
  const players = listPlayers(room);
  const hostUid = hostUidOf(room);
  const iAmHost = hostUid === app.uid;
  const readyCount = startCandidates(room).length;   // 開始したら参加できる人数

  $('lobby-room-id').textContent = app.roomId;
  $('lobby-count').textContent = `${players.length}人（最大${MAX_PLAYERS}人）`;

  $('lobby-players').innerHTML = players
    .map((player) => {
      const online = isOnline(room, player.uid);
      return `
        <li class="player-item ${online ? '' : 'is-offline'}">
          <span class="player-name">${escapeHtml(player.name)}</span>
          ${meTag(app, player.uid)}
          ${player.uid === hostUid ? '<span class="tag tag-host">ホスト</span>' : ''}
          ${online ? '' : '<span class="tag tag-offline">オフライン</span>'}
        </li>`;
    })
    .join('');

  renderModeCard(app, iAmHost);

  // 「ゲーム開始」はホストにだけ表示。人数が足りないあいだは押せない
  const startButton = $('btn-start');
  startButton.hidden = !iAmHost;
  startButton.disabled = readyCount < MIN_PLAYERS;

  let message;
  if (!iAmHost) {
    message = `ホスト（${nameOf(room, hostUid)}）がゲームを開始するのを待っています…`;
  } else if (readyCount < MIN_PLAYERS) {
    message = `${MIN_PLAYERS}人以上そろうと開始できます。ルームIDを伝えて、参加してもらいましょう。`;
  } else {
    message = `${readyCount}人でゲームを開始できます。`;
  }
  $('lobby-message').textContent = message;
}

/**
 * 待機画面の「ゲームモードを選択」のカードを描く（モードの一覧・ルール・オリジナルの設定欄）。
 * 選ばれているモードとルールは、ルームのデータ（state.mode / state.rules）から読むので、全員の画面で同じになる。
 * 選べるのはホストだけ。ほかの人には、同じ一覧とルールが「見るだけ」の状態で表示される。
 */
function renderModeCard(app, iAmHost) {
  const state = app.room.state;
  const current = modeOf(state);
  const rules = rulesOf(state);

  // ---- モードの一覧 ----
  $('lobby-mode-title').textContent = iAmHost ? 'ゲームモードを選択' : 'ゲームモード';
  $('lobby-modes').innerHTML = listModes()
    .map((mode) => {
      const selected = mode.id === current.id;
      const classes = ['mode-row', selected ? 'is-selected' : '', mode.available ? '' : 'is-soon'].join(' ');
      return `
        <li>
          <button type="button" class="${classes}" data-mode="${escapeHtml(mode.id)}"
                  aria-pressed="${selected}" ${iAmHost ? '' : 'disabled'}>
            <span class="mode-radio" aria-hidden="true"></span>
            <span class="mode-text">
              <span class="mode-name">${escapeHtml(mode.name)}</span>
              <span class="mode-detail">${escapeHtml(mode.description)}</span>
            </span>
            ${mode.available ? '' : '<span class="mode-tag">準備中</span>'}
          </button>
        </li>`;
    })
    .join('');

  // ---- オリジナルの設定欄（ホストがオリジナルを選んでいるあいだだけ出す）----
  // 入力欄に値を入れるのは「出し始めるとき」だけ。
  // ルームのデータが届くたびに入れ直すと、入力している途中の文字が消えてしまうため。
  const editing = iAmHost && current.custom;
  const form = $('original-form');
  if (editing && form.hidden) fillOriginalForm(app, rules);
  form.hidden = !editing;

  // ---- 選ばれているモードのルール（設定欄を出しているあいだは、こちらは隠す）----
  const box = $('lobby-rules');
  box.hidden = editing;
  box.innerHTML = `
    <p class="rules-box-title">${escapeHtml(current.name)}のルール${current.custom ? '（ホストが設定）' : ''}</p>
    <dl>
      ${rulesRows(rules, app.characters)
        .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join('')}
    </dl>`;

  $('lobby-mode-note').textContent = iAmHost
    ? `モード：${current.name}（ゲームを開始すると変更できません）`
    : `モード：${current.name}（ホストが選びます）`;
}

// ---- オリジナルの設定欄 ----

/** 設定欄の入力欄の id（ルールの項目名 → 入力欄の id） */
export const ORIGINAL_INPUTS = {
  targetScore: 'input-original-target',
  burstScore: 'input-original-burst',
  maxTurns: 'input-original-turns',
  minRank: 'input-original-min-rank',
  maxRank: 'input-original-max-rank',
};

/** 設定欄に、ルールの値を入れる */
function fillOriginalForm(app, rules) {
  // 順位の「終了」が決まっていないルール（最後の順位まで）は、データにある最後の順位を入れる
  const values = { ...rules, maxRank: rules.maxRank ?? rankSpanOf(app.characters).last };
  for (const [key, id] of Object.entries(ORIGINAL_INPUTS)) {
    $(id).value = values[key];
  }
  renderOriginalCheck(app, values);
}

/**
 * 設定欄の下に、「その順位の範囲にいるキャラクターの人数」と、入力の問題点を表示する。
 * @param {object} rules 入力欄から読んだ値（数字でない入力は NaN）
 * @returns {string[]} 見つかった問題（なければ空の配列）
 */
export function renderOriginalCheck(app, rules) {
  const problems = findRuleProblems(rules, app.characters);

  const rangeReadable =
    Number.isInteger(rules.minRank) && Number.isInteger(rules.maxRank) && rules.minRank <= rules.maxRank;
  $('original-count').textContent = rangeReadable
    ? `この範囲のキャラクター：${listUsableCharacters(rules, app.characters).length}人`
    : '';

  const error = $('error-original');
  error.hidden = problems.length === 0;
  error.textContent = problems.join('\n');
  return problems;
}

/** ルームを出るときに、設定欄を閉じておく（次に出すとき、新しいルームの設定が入るように） */
export function resetLobby() {
  $('original-form').hidden = true;
}

// ============================================================
// 5・6 共通：画面上部のステータスバー（ターン・モード・目標・自分の合計）
// ============================================================
export function renderStatusBar(element, app) {
  const state = app.room.state;
  const rules = rulesOf(state);   // このゲームのルール（目標値・ターン数など）
  const me = state.scores[app.uid];
  const remainingTurns = rules.maxTurns - state.turn;

  let mine;
  if (!me) {
    mine = '<div class="status-total">観戦中</div>';
  } else if (me.out) {
    mine = `<div class="status-total">現在 <b>${me.total}</b> 点 ${BURST_STAMP}</div>`;
  } else {
    // 目標値まであと何点か。目標値を超えているとき（バーストする点数を目標値より
    // 2以上大きくしたオリジナルのルールで起きる）は、超えた点数を出す
    const rest = rules.targetScore - me.total;
    const restText = rest >= 0 ? `あと ${rest}` : `${-rest} 超過`;
    mine = `<div class="status-total">現在 <b>${me.total}</b> 点 <span class="status-rest">${restText}</span></div>`;
  }

  element.innerHTML = `
    <div class="status-row">
      <div class="status-turn">TURN <b>${state.turn}</b> / ${rules.maxTurns}</div>
      <div class="status-remain">${remainingTurns > 0 ? `残り ${remainingTurns} ターン` : '最終ターン'}</div>
      <div class="status-mode" title="ゲームモード">${escapeHtml(modeOf(state).name)}</div>
      <button class="status-menu" type="button" data-action="menu" aria-label="メニュー">☰</button>
    </div>
    <div class="status-row">
      ${mine}
      <div class="status-target">目標 <b>${rules.targetScore}</b> 点</div>
    </div>`;
}

// ============================================================
// 5. ゲーム画面
// ============================================================

/** 全員の合計点と状況（決定済み / 選択中 / バースト / 切断中）を並べる */
function renderScoreboard(app) {
  const { room } = app;
  const state = room.state;
  const submitted = room.submitted?.[roundKeyOf(state)] || {};

  $('game-scoreboard').innerHTML = listParticipants(state)
    .map((player) => {
      const online = isOnline(room, player.uid);
      let label;
      let className;
      if (player.out) {
        label = 'バースト';
        className = 'is-out';
      } else if (submitted[player.uid]) {
        label = '決定';
        className = 'is-done';
      } else if (!online) {
        label = '切断中';
        className = 'is-offline';
      } else {
        label = '選択中';
        className = 'is-thinking';
      }
      return `
        <li class="score-chip ${className} ${player.uid === app.uid ? 'is-me' : ''}">
          <span class="chip-name">${escapeHtml(player.name)}</span>
          <span class="chip-total">${player.total}</span>
          <span class="chip-status">${label}</span>
        </li>`;
    })
    .join('');
}

/**
 * キャラクター一覧を描く。検索の入力が変わるたび、新しいターンに入るたびに呼ばれる。
 *
 * app.characters は50音順に並んでいる（main.js の loadCharacters で並べ替え済み）。
 * 表示するのは名前だけ。順位やポイントは出さない。
 *
 * 一覧にも検索結果にも、そのゲームのルールで使えるキャラクターだけを出す。
 * （ノーマルなら人気投票 1〜50位の50人。並びは順位順ではなく、50音順のまま）
 */
export function renderCharList(app) {
  const state = app.room.state;
  const rules = rulesOf(state);
  const queryText = $('input-search').value;
  const usable = listUsableCharacters(rules, app.characters);
  const found = searchCharacters(usable, queryText);

  if (found.length === 0) {
    // 全キャラクターの中にはいるのに、このゲームのルールでは使えない場合は、そのことを伝える
    const existsButNotUsable = searchCharacters(app.characters, queryText).length > 0;
    const query = escapeHtml(queryText.trim());
    $('char-list').innerHTML = existsButNotUsable
      ? `<li class="char-empty">「${query}」に合うキャラクターは、${escapeHtml(modeOf(state).name)}では選べません<br>
           （選べるのは${rangeInfo(rules, app.characters).text}のキャラクターだけです）</li>`
      : `<li class="char-empty">「${query}」に合うキャラクターが見つかりません</li>`;
    return;
  }

  // 検索していないとき（全員を表示するとき）だけ、「あ」「か」… の見出しを入れる
  const showHeaders = normalizeText(queryText) === '';
  let lastRow = null;

  $('char-list').innerHTML = found
    .map((character) => {
      const banned = isBanned(state, character.id);
      const classes = [
        'char-row',
        banned ? 'is-banned' : '',
        character.id === app.selectedCharId ? 'is-selected' : '',
      ].join(' ');

      const header =
        showHeaders && character.kanaRow !== lastRow
          ? `<li class="char-header">${escapeHtml(character.kanaRow)}</li>`
          : '';
      lastRow = character.kanaRow;

      return `
        ${header}
        <li>
          <button type="button" class="${classes}" data-char-id="${character.id}"
                  ${banned ? 'aria-disabled="true"' : ''}>
            <span class="char-name">${escapeHtml(character.name)}</span>
            ${banned ? '<span class="char-tag">使用禁止</span>' : ''}
          </button>
        </li>`;
    })
    .join('');
}

/** 一覧の中で、いま選んでいるキャラクターに印をつける */
export function markSelectedChar(app) {
  for (const row of $('char-list').querySelectorAll('.char-row')) {
    row.classList.toggle('is-selected', Number(row.dataset.charId) === app.selectedCharId);
  }
}

/**
 * 画面下の確認欄を描く。出すのは選んだキャラクターの名前だけ。
 * （順位・ポイント・選んだあとの合計は、結果公開まで分からないようにしている）
 */
export function renderPickPanel(app) {
  const state = app.room.state;
  const me = state.scores[app.uid];
  const character = app.charById.get(app.selectedCharId);
  const button = $('btn-decide');

  if (!me || !character) {
    $('pick-info').innerHTML = '<p class="pick-empty">一覧からキャラクターをタップしてください</p>';
    button.classList.add('is-idle');
    return;
  }

  $('pick-info').innerHTML = `
    <p class="pick-name">${escapeHtml(character.name)}</p>
    <p class="pick-note">順位とポイントは、結果公開まで分かりません</p>`;
  button.classList.remove('is-idle');
}

/** 決定したあと（またはバースト・観戦中）の「待っている」表示を描く */
function renderWaiting(app) {
  const { room } = app;
  const state = room.state;
  const roundKey = roundKeyOf(state);
  const me = state.scores[app.uid];
  const submitted = room.submitted?.[roundKey] || {};
  const waitingFor = listParticipants(state).filter((p) => !p.out && !submitted[p.uid]);

  let mine;
  if (!me) {
    mine = `
      <p class="waiting-label">観戦中</p>
      <p class="waiting-text">このゲームには参加していません。<br>次のゲームから参加できます。</p>`;
  } else if (me.out) {
    mine = `
      <p class="waiting-label">${BURST_STAMP}</p>
      <p class="waiting-text">合計が ${me.total} 点になりました。<br>ここからは観戦になります。</p>
      <p class="waiting-note">${rulesOf(state).burstScore} 点以上でバーストです</p>`;
  } else {
    // 自分が選んだキャラクターの名前だけを出す（順位とポイントは結果公開までのお楽しみ）
    const character = app.myPick?.roundKey === roundKey ? app.charById.get(app.myPick.charId) : null;
    mine = character
      ? `
        <p class="waiting-label">あなたの選択（決定済み）</p>
        <p class="waiting-char">${escapeHtml(character.name)}</p>
        <p class="waiting-note">順位とポイントは、全員が決定すると公開されます<br>※ほかの人と重複したら +0 になります</p>`
      : '<p class="waiting-label">あなたの選択（決定済み）</p><p class="waiting-text">読み込み中…</p>';
  }
  $('waiting-mine').innerHTML = mine;

  $('waiting-message').textContent =
    waitingFor.length === 0
      ? '全員の選択が完了しました。結果を集計しています…'
      : `${waitingFor.map((p) => p.name).join('、')} の選択を待っています…`;

  // ホストは、選ばない人がいるときに締め切ることができる。
  // （全員の選択を読めるのは「自分が決定済み」か「バーストした」人だけなので、その条件もつける）
  const iAmHost = hostUidOf(room) === app.uid;
  const canReadPicks = Boolean(me) && (me.out || submitted[app.uid]);
  $('btn-force').hidden = !(iAmHost && canReadPicks && waitingFor.length > 0);
}

/** ゲーム画面全体を描く（選択中か、待っているかを切り替える） */
export function renderGame(app) {
  const { room } = app;
  const state = room.state;
  const roundKey = roundKeyOf(state);
  const me = state.scores[app.uid];
  const submitted = room.submitted?.[roundKey] || {};
  const decided = Boolean(submitted[app.uid]) || app.myPick?.roundKey === roundKey;
  const picking = Boolean(me) && !me.out && !decided;

  renderStatusBar($('game-status'), app);
  renderScoreboard(app);

  $('search-row').hidden = !picking;
  $('game-picker').hidden = !picking;
  $('game-waiting').hidden = picking;

  if (picking) {
    const rules = rulesOf(state);
    const rest = rules.targetScore - me.total;         // 目標値まで、あと何点か
    const untilBurst = rules.burstScore - me.total;    // あと何点の加点でバーストするか
    const picksLeft = rules.maxTurns - state.turn + 1;
    let progress;
    if (rest > 0) {
      progress = `あと ${rest} 点（${rules.burstScore} 点以上でバースト）。このターンを入れて、あと ${picksLeft} 回選びます。`;
    } else {
      // 目標値ちょうど、または目標値を超えているとき。
      // （超えたまま残れるのは、バーストする点数を目標値より2以上大きくしたオリジナルのルールだけ）
      const position = rest === 0 ? `いま ${me.total} 点ちょうど。` : `目標を ${-rest} 点超えています。`;
      const danger =
        untilBurst === 1
          ? '加点されるとバーストです（重複して +0 ならセーフ）。'
          : `あと ${untilBurst} 点以上の加点でバーストです。`;
      progress = position + danger;
    }
    // 使えるキャラクターが限られているルール（ノーマルなど）では、そのことも伝える
    const range = rangeInfo(rules, app.characters);
    const rangeNote = range.all ? '' : `選べるのは${range.text}のキャラクターだけです。`;
    $('picker-hint').textContent = progress + rangeNote;
    renderPickPanel(app);
  } else {
    renderWaiting(app);
  }
}

// ============================================================
// 6. ターン結果画面
// ============================================================

/**
 * 全員の選択と点数の変化をカードにして並べる。
 * カードは上から順に時間差で現れる（--i が順番。動きは style.css で指定）。
 * 演出をやり直さないよう、1ターンにつき1回だけ呼ばれる。
 */
export function renderRevealCards(app) {
  const state = app.room.state;
  const results = state.history?.[turnKey(state.turn)] || {};

  $('reveal-title').innerHTML = `<span class="reveal-turn">TURN ${state.turn}</span>結果公開！`;

  let order = 0;
  $('reveal-list').innerHTML = listParticipants(state)
    .map((player) => {
      const result = results[player.uid];
      const name = `<div class="reveal-name">${escapeHtml(player.name)}${meTag(app, player.uid)}</div>`;

      // このターンより前にバーストしていた人
      if (!result) {
        return `
          <li class="reveal-card is-skipped" style="--i:${order++}">
            <div class="reveal-left">
              ${name}
              <div class="reveal-pick">選択なし</div>
            </div>
            <div class="reveal-right">
              <div class="reveal-total">合計 <b>${player.total}</b>${BURST_STAMP}</div>
            </div>
          </li>`;
      }

      // 結果が公開されたので、ここで初めて人気投票の順位と獲得ポイントを見せる
      const character = app.charById.get(result.charId);
      const pick = character
        ? `${escapeHtml(character.name)}<small>人気投票 ${character.rank}位</small>`
        : '（未選択）';
      const notes = {
        ok: '',
        duplicate: '<span class="reveal-note">重複！</span>',
        invalid: '<span class="reveal-note">無効</span>',
        none: '<span class="reveal-note">時間切れ</span>',
      };

      // カードの左側に「だれが・だれを選んだか」、右側に「加点と合計」を並べる
      return `
        <li class="reveal-card is-${result.outcome} ${result.out ? 'is-out' : ''}" style="--i:${order++}">
          <div class="reveal-left">
            ${name}
            <div class="reveal-pick">${pick}</div>
          </div>
          <div class="reveal-right">
            <div class="reveal-gain">${notes[result.outcome]}+${result.gained}</div>
            <div class="reveal-total">合計 ${result.before} → <b>${result.after}</b></div>
            ${result.out ? `<div class="reveal-burst">${BURST_STAMP}</div>` : ''}
          </div>
        </li>`;
    })
    .join('');

  // このターンで新しく使用禁止になったキャラクター
  const bannedNames = [
    ...new Set(
      Object.values(results)
        .filter((result) => result.outcome === 'duplicate')
        .map((result) => app.charById.get(result.charId).name)
    ),
  ];
  const bannedNote = $('reveal-banned');
  bannedNote.hidden = bannedNames.length === 0;
  bannedNote.innerHTML = `<b>使用禁止</b>${bannedNames.map(escapeHtml).join('、')} は、このゲームではもう選べません。`;

  // 全員のカードが出そろってから、下の部分（禁止のお知らせ・ボタン）を出す
  bannedNote.style.setProperty('--i', order);
  $('reveal-footer').style.setProperty('--i', order);
}

/** 結果画面の下の部分（ホストには「次へ」ボタン、ほかの人には待機メッセージ） */
export function renderRevealFooter(app) {
  const { room } = app;
  const state = room.state;
  const last = isLastReveal(state);
  const hostUid = hostUidOf(room);
  const iAmHost = hostUid === app.uid;

  renderStatusBar($('reveal-status'), app);

  const nextButton = $('btn-next');
  nextButton.hidden = !iAmHost;
  nextButton.textContent = last ? '最終結果へ' : `次のターンへ（TURN ${state.turn + 1}）`;

  $('reveal-wait').textContent = iAmHost
    ? ''
    : `ホスト（${nameOf(room, hostUid)}）が${last ? '最終結果' : '次のターン'}へ進めるのを待っています…`;
}

// ============================================================
// 7. 最終結果画面
// ============================================================
export function renderResult(app) {
  const { room } = app;
  const state = room.state;
  const mode = modeOf(state);
  const { targetScore, burstScore } = rulesOf(state);
  const { winners, ranking } = judgeResult(state);

  // オリジナルのときは、どんなルールで遊んだかも添える
  $('result-mode').textContent = mode.custom
    ? `モード：${mode.name}（目標 ${targetScore} 点・${burstScore} 点以上でバースト）`
    : `モード：${mode.name}`;

  // ---- 勝者 ----
  if (winners.length === 0) {
    $('result-winner').className = 'winner-card is-nobody';
    $('result-winner').innerHTML = `
      <p class="winner-label">勝者なし</p>
      <p class="winner-detail">全員がバーストしました（${burstScore} 点以上でバースト）</p>`;
  } else {
    const best = ranking[0];
    const winnerList = ranking.filter((p) => p.isWinner);
    // 勝者が複数いて点数が違うとき（目標値をはさんで同じ差。オリジナルのルールで起きる）は、差だけを出す
    const sameTotal = winnerList.every((p) => p.total === best.total);
    const detail = sameTotal
      ? `${best.total}点（${targetScore}との差：${best.diff}）`
      : `${targetScore}との差：${best.diff}`;
    $('result-winner').className = 'winner-card';
    $('result-winner').innerHTML = `
      <p class="winner-label">🏆 WINNER</p>
      ${winnerList.map((p) => `<p class="winner-name">${escapeHtml(p.name)}</p>`).join('')}
      <p class="winner-detail">${detail}${winners.length > 1 ? '<br>同率1位！' : ''}</p>`;
  }

  // ---- 全員の順位 ----
  $('result-ranking').innerHTML = ranking
    .map((player) => {
      const place = player.out ? 'バースト' : `${player.place}位`;
      const detail = player.out
        ? `${player.total - targetScore} オーバー`
        : `${targetScore}との差：${player.diff}`;
      return `
        <li class="rank-item ${player.isWinner ? 'is-winner' : ''} ${player.out ? 'is-out' : ''}">
          <span class="rank-place">${place}</span>
          <span class="rank-name">${escapeHtml(player.name)}${meTag(app, player.uid)}</span>
          <span class="rank-score"><b>${player.total}</b>点<small>${detail}</small></span>
        </li>`;
    })
    .join('');

  // ---- 各ターンのふりかえり ----
  $('result-history').innerHTML = listParticipants(state)
    .map((player) => {
      const lines = [];
      for (let turn = 1; turn <= state.turn; turn++) {
        const result = state.history?.[turnKey(turn)]?.[player.uid];
        let text;
        if (!result) {
          text = '<span class="history-muted">バーストのため選択なし</span>';
        } else {
          const character = app.charById.get(result.charId);
          const label = character ? `${escapeHtml(character.name)}（${character.rank}位）` : '未選択';
          const note = { ok: '', duplicate: ' 重複', invalid: ' 無効', none: '' }[result.outcome];
          text = `${label} <b>+${result.gained}${note}</b> → ${result.after}${result.out ? ' <span class="text-out">バースト</span>' : ''}`;
        }
        lines.push(`<li><span class="history-turn">T${turn}</span>${text}</li>`);
      }
      return `
        <div class="history-player">
          <p class="history-name">${escapeHtml(player.name)}${meTag(app, player.uid)}</p>
          <ul class="history-lines">${lines.join('')}</ul>
        </div>`;
    })
    .join('');

  // ---- 下の部分 ----
  const hostUid = hostUidOf(room);
  const iAmHost = hostUid === app.uid;
  $('btn-again').hidden = !iAmHost;
  $('result-wait').textContent = iAmHost
    ? ''
    : `ホスト（${nameOf(room, hostUid)}）が「もう一度」を押すと、待機画面に戻ります。`;
}

// ============================================================
// 「遊び方」と「メニュー」のダイアログ
// ============================================================

/**
 * 「遊び方」の中身を、ルールに合わせて入れる。
 *   ルームに入っているとき … そのルームで選ばれているモードの説明と、その数字
 *   入っていないとき       … 遊べるモードすべての説明（数字のところは「目標値」などの言葉にする）
 * どちらのときも、「スティールはない」「最後の選択に注意」の注意書きを出す。
 */
export function renderRules(app) {
  const state = app.room?.state;
  let blocks;      // モードの説明: [[名前, 説明文], …]
  let lastPick;    // 注意書きに入れる「最後の選択」の言い方
  let words;       // 「ゲームの流れ」の data-rule のところに入れる言葉

  if (state) {
    const mode = modeOf(state);
    const rules = rulesOf(state);
    $('rules-mode').textContent = `（${mode.name}）`;
    blocks = [[mode.name, describeRules(rules, app.characters)]];
    lastPick = `${rules.maxTurns}回目（最後）`;
    words = {
      target: `${rules.targetScore}点`,
      burst: `${rules.burstScore}点`,
      turns: `${rules.maxTurns}ターン目`,
    };
  } else {
    const modes = listModes().filter((mode) => mode.available);
    $('rules-mode').textContent = '';
    blocks = modes.map((mode) => [
      mode.name,
      mode.custom
        ? '目標値・バーストする点数・ターン数・使えるキャラクターの順位を、ホストが自由に決めて遊ぶモードです。'
        : describeRules(presetRules(mode.id), app.characters),
    ]);
    // ルールが決まっているモードのターン数がどれも同じなら「5回目（最後）」、ちがえば「最後」と書く
    const turnCounts = new Set(modes.filter((mode) => !mode.custom).map((mode) => presetRules(mode.id).maxTurns));
    lastPick = turnCounts.size === 1 ? `${[...turnCounts][0]}回目（最後）` : '最後';
    words = { target: '目標値', burst: 'バーストする点数', turns: '最後のターン' };
  }

  $('rules-modes').innerHTML =
    blocks
      .map(
        ([name, text]) => `
          <section class="rules-mode-block">
            <h4 class="rules-mode-name">${escapeHtml(name)}</h4>
            <p>${escapeHtml(text)}</p>
          </section>`
      )
      .join('') + `<p class="rules-note">${escapeHtml(stealNote(lastPick))}</p>`;

  for (const element of document.querySelectorAll('[data-rule]')) {
    element.textContent = words[element.dataset.rule];
  }
}

/** ゲーム中のメニューに、ルームIDとゲームモードを表示する */
export function renderMenu(app) {
  $('menu-room-id').textContent = app.roomId;
  $('menu-mode').textContent = modeOf(app.room?.state).name;
}
