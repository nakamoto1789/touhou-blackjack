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

import { MIN_PLAYERS, MAX_PLAYERS } from './config.js';
import { $, escapeHtml, normalizeText, searchCharacters } from './util.js';
import {
  rulesOf,
  listDifficulties,
  roundKeyOf,
  turnKey,
  isBanned,
  listParticipants,
  isLastReveal,
  judgeResult,
} from './game-logic.js';
import { listPlayers, isOnline, hostUidOf, startCandidates } from './room.js';

/** 名前の横につける「あなた」の印 */
function meTag(app, uid) {
  return uid === app.uid ? '<span class="tag tag-me">あなた</span>' : '';
}

/** そのuidの人の名前（ゲーム中は参加者の名前、待機中は名簿の名前） */
function nameOf(room, uid) {
  return room.state.scores?.[uid]?.name ?? room.players?.[uid]?.name ?? '？';
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

  renderDifficultyList(app, iAmHost);

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
 * 待機画面の「難易度を選択」の一覧を描く。
 * 選ばれている難易度はルームのデータ（state.difficulty）から読むので、全員の画面で同じになる。
 * 選べるのはホストだけ。ほかの人には、同じ一覧が「見るだけ」の状態で表示される。
 */
function renderDifficultyList(app, iAmHost) {
  const current = rulesOf(app.room.state);

  $('lobby-difficulty-title').textContent = iAmHost ? '難易度を選択' : '難易度';
  $('lobby-difficulties').innerHTML = listDifficulties()
    .map((difficulty) => {
      const selected = difficulty.id === current.id;
      const classes = [
        'difficulty-row',
        selected ? 'is-selected' : '',
        difficulty.available ? '' : 'is-soon',
      ].join(' ');
      return `
        <li>
          <button type="button" class="${classes}" data-difficulty="${escapeHtml(difficulty.id)}"
                  aria-pressed="${selected}" ${iAmHost ? '' : 'disabled'}>
            <span class="difficulty-radio" aria-hidden="true"></span>
            <span class="difficulty-name">${escapeHtml(difficulty.label)}</span>
            <span class="difficulty-tag">${difficulty.available ? 'PLAY' : 'Coming Soon'}</span>
          </button>
        </li>`;
    })
    .join('');

  $('lobby-difficulty-note').textContent = iAmHost
    ? `難易度：${current.label}（ゲームを開始すると変更できません）`
    : `難易度：${current.label}（ホストが選びます）`;
}

// ============================================================
// 5・6 共通：画面上部のステータスバー（ターン・難易度・目標・自分の合計）
// ============================================================
export function renderStatusBar(element, app) {
  const state = app.room.state;
  const rules = rulesOf(state);   // このゲームの難易度の設定（目標値・ターン数）
  const me = state.scores[app.uid];
  const remainingTurns = rules.maxTurns - state.turn;

  let mine;
  if (!me) {
    mine = '<div class="status-total">観戦中</div>';
  } else if (me.out) {
    mine = `<div class="status-total">現在 <b>${me.total}</b> 点 <span class="stamp-out">OUT</span></div>`;
  } else {
    mine = `<div class="status-total">現在 <b>${me.total}</b> 点 <span class="status-rest">あと ${rules.targetScore - me.total}</span></div>`;
  }

  element.innerHTML = `
    <div class="status-row">
      <div class="status-turn">TURN <b>${state.turn}</b> / ${rules.maxTurns}</div>
      <div class="status-remain">${remainingTurns > 0 ? `残り ${remainingTurns} ターン` : '最終ターン'}</div>
      <div class="status-difficulty" title="難易度">${escapeHtml(rules.label)}</div>
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

/** 全員の合計点と状況（決定済み / 選択中 / OUT / 切断中）を並べる */
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
        label = 'OUT';
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
 */
export function renderCharList(app) {
  const state = app.room.state;
  const queryText = $('input-search').value;
  const found = searchCharacters(app.characters, queryText);

  if (found.length === 0) {
    $('char-list').innerHTML =
      `<li class="char-empty">「${escapeHtml(queryText.trim())}」に合うキャラクターが見つかりません</li>`;
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

/** 決定したあと（またはOUT・観戦中）の「待っている」表示を描く */
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
      <p class="waiting-label"><span class="stamp-out">OUT</span></p>
      <p class="waiting-text">${me.total}点で ${rulesOf(state).targetScore} を超えました。<br>ここからは観戦になります。</p>`;
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
  // （全員の選択を読めるのは「自分が決定済み」か「OUT」の人だけなので、その条件もつける）
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
    const rest = rules.targetScore - me.total;
    const picksLeft = rules.maxTurns - state.turn + 1;
    $('picker-hint').textContent =
      rest > 0
        ? `あと ${rest} 点。このターンを入れて、あと ${picksLeft} 回選びます。`
        : `いま ${rules.targetScore} 点ちょうど。加点されるとOUTです（重複して +0 ならセーフ）。`;
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

      // このターンより前にOUTになっていた人
      if (!result) {
        return `
          <li class="reveal-card is-skipped" style="--i:${order++}">
            <div class="reveal-left">
              ${name}
              <div class="reveal-pick">選択なし</div>
            </div>
            <div class="reveal-right">
              <div class="reveal-total">合計 <b>${player.total}</b><span class="stamp-out">OUT</span></div>
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
        invalid: '<span class="reveal-note">使用禁止</span>',
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
            <div class="reveal-total">
              合計 ${result.before} → <b>${result.after}</b>${result.out ? '<span class="stamp-out">OUT</span>' : ''}
            </div>
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
  const { targetScore, label: difficultyLabel } = rulesOf(state);
  const { winners, ranking } = judgeResult(state);

  $('result-difficulty').textContent = `難易度：${difficultyLabel}`;

  // ---- 勝者 ----
  if (winners.length === 0) {
    $('result-winner').className = 'winner-card is-nobody';
    $('result-winner').innerHTML = `
      <p class="winner-label">勝者なし</p>
      <p class="winner-detail">全員が ${targetScore} を超えてOUTになりました</p>`;
  } else {
    const best = ranking[0];
    $('result-winner').className = 'winner-card';
    $('result-winner').innerHTML = `
      <p class="winner-label">🏆 WINNER</p>
      ${ranking
        .filter((p) => p.isWinner)
        .map((p) => `<p class="winner-name">${escapeHtml(p.name)}</p>`)
        .join('')}
      <p class="winner-detail">${best.total}点（${targetScore}との差：${best.diff}）${winners.length > 1 ? '<br>同率1位！' : ''}</p>`;
  }

  // ---- 全員の順位 ----
  $('result-ranking').innerHTML = ranking
    .map((player) => {
      const place = player.out ? 'OUT' : `${player.place}位`;
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
          text = '<span class="history-muted">OUTのため選択なし</span>';
        } else {
          const character = app.charById.get(result.charId);
          const label = character ? `${escapeHtml(character.name)}（${character.rank}位）` : '未選択';
          const note = { ok: '', duplicate: ' 重複', invalid: ' 無効', none: '' }[result.outcome];
          text = `${label} <b>+${result.gained}${note}</b> → ${result.after}${result.out ? ' <span class="text-out">OUT</span>' : ''}`;
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
 * 「遊び方」に出てくる数字（目標値・ターン数）を、難易度の設定に合わせる。
 * ルームに入っているときはそのルームの難易度、入っていないときは既定の難易度を使う。
 */
export function renderRules(app) {
  const rules = rulesOf(app.room?.state);
  $('rules-difficulty').textContent = `（${rules.label}）`;
  for (const element of document.querySelectorAll('[data-rule="target"]')) {
    element.textContent = rules.targetScore;
  }
  for (const element of document.querySelectorAll('[data-rule="turns"]')) {
    element.textContent = rules.maxTurns;
  }
}

/** ゲーム中のメニューに、ルームIDと難易度を表示する */
export function renderMenu(app) {
  $('menu-room-id').textContent = app.roomId;
  $('menu-difficulty').textContent = rulesOf(app.room?.state).label;
}
