// ============================================================
// game-logic.js … ゲームのルール（計算だけを行う部分）
//
// このファイルの関数は「入力を受け取って結果を返すだけ」で、
// 画面や通信には一切触りません。そのため、
//   ・ルールを変えたいときはこのファイルだけ見ればよい
//   ・tests/ のテストで正しさを確認できる
// という利点があります。
//
// ---- ゲームの状態 (state) の形 ----
// {
//   status: 'lobby' | 'playing' | 'finished',
//   gameNo: 1,                 // このルームで何回目のゲームか
//   difficulty: 'lunatic',     // 難易度（config.js の DIFFICULTY_SETTINGS の名前）
//   turn: 1,                   // 現在のターン (1〜その難易度のターン数)
//   phase: 'select' | 'reveal',// 選択中 / 結果公開中
//   scores: {                  // 参加者ごとの点数
//     <uid>: { name: '霊夢', order: 0, total: 87, out: false }
//   },
//   banned:  { c3: 1 },        // 使用禁止キャラ（キー: 'c'+キャラid、値: 禁止になったターン）
//   history: { t1: { <uid>: {…ターン結果…} } }   // 各ターンの結果
// }
// ============================================================

import { DIFFICULTY_SETTINGS, DEFAULT_DIFFICULTY, MIN_PLAYERS, MAX_PLAYERS } from './config.js';

// ---- 難易度 ----------------------------------------------------------

/** その難易度が選べるか（準備中の難易度や、知らない名前は false） */
export function isDifficultyAvailable(id) {
  return Boolean(DIFFICULTY_SETTINGS[id] && DIFFICULTY_SETTINGS[id].available);
}

/**
 * 難易度の名前から、その設定を取り出す。
 * 返す値: { id: 'lunatic', label: 'Lunatic', available: true, targetScore: 150, maxTurns: 5 }
 * 選べない難易度や、難易度の記録がない古いデータのときは、既定の難易度の設定を返す。
 */
export function difficultyOf(id) {
  const key = isDifficultyAvailable(id) ? id : DEFAULT_DIFFICULTY;
  return { id: key, ...DIFFICULTY_SETTINGS[key] };
}

/** そのゲームに適用されるルール（＝そのゲームの難易度の設定） */
export function rulesOf(state) {
  return difficultyOf(state?.difficulty);
}

/** 画面に並べる難易度の一覧: [{ id, label, available }, …] */
export function listDifficulties() {
  return Object.entries(DIFFICULTY_SETTINGS).map(([id, settings]) => ({ id, ...settings }));
}

/**
 * 待機中に難易度を変えた状態を返す。
 * ゲーム開始後や、選べない難易度のときは変えない（undefined を返す）。
 */
export function withDifficulty(state, id) {
  if (state.status !== 'lobby' || !isDifficultyAvailable(id)) return undefined;
  return { ...state, difficulty: id };
}

// ---- 状態を作る -------------------------------------------------------

/** ゲーム開始前（待機中）の状態を作る */
export function createLobbyState(gameNo = 0, difficulty = DEFAULT_DIFFICULTY) {
  return { status: 'lobby', gameNo, difficulty: difficultyOf(difficulty).id };
}

/**
 * ゲーム開始時の状態を作る。難易度はここで決まり、ゲームが終わるまで変わらない。
 * @param {Array<{uid: string, name: string}>} participants 参加者（表示したい順）
 * @param {number} gameNo このルームで何回目のゲームか
 * @param {string} difficulty 難易度の名前
 */
export function createGameState(participants, gameNo, difficulty = DEFAULT_DIFFICULTY) {
  if (!isDifficultyAvailable(difficulty)) {
    throw new Error('この難易度はまだ遊べません');
  }
  if (participants.length < MIN_PLAYERS) {
    throw new Error(`${MIN_PLAYERS}人以上いないとゲームを開始できません`);
  }
  if (participants.length > MAX_PLAYERS) {
    throw new Error(`参加できるのは${MAX_PLAYERS}人までです`);
  }
  const scores = {};
  participants.forEach((player, index) => {
    scores[player.uid] = { name: player.name, order: index, total: 0, out: false };
  });
  return { status: 'playing', gameNo, difficulty, turn: 1, phase: 'select', scores };
}

/**
 * 「どのゲームの何ターン目か」を表すキー。例: 'g1t3'
 * 選択を保存する場所の名前に使います。
 */
export function roundKeyOf(state) {
  return `g${state.gameNo}t${state.turn}`;
}

/** 使用禁止リスト(banned)で使うキー。例: キャラid 3 → 'c3' */
export function banKey(charId) {
  return `c${charId}`;
}

/** 各ターンの結果(history)で使うキー。例: 3ターン目 → 't3' */
export function turnKey(turn) {
  return `t${turn}`;
}

/** そのキャラクターが使用禁止かどうか */
export function isBanned(state, charId) {
  return Boolean(state.banned && state.banned[banKey(charId)]);
}

/** 参加者を表示順に並べた配列にする: [{ uid, name, order, total, out }, …] */
export function listParticipants(state) {
  return Object.entries(state.scores || {})
    .map(([uid, score]) => ({ uid, ...score }))
    .sort((a, b) => a.order - b.order);
}

/** まだOUTになっていない（＝このターン選択する）参加者のuid一覧 */
export function activeUids(state) {
  return listParticipants(state)
    .filter((player) => !player.out)
    .map((player) => player.uid);
}

/**
 * OUTでない参加者が全員「決定」を押したか。
 * @param {object} state
 * @param {object} submitted { <uid>: true } 決定済みの人の印
 */
export function allActiveSubmitted(state, submitted = {}) {
  const active = activeUids(state);
  return active.length > 0 && active.every((uid) => submitted[uid] === true);
}

/**
 * ★ゲームの中心となる計算★
 * 1ターン分の選択を受け取り、重複判定・加点・OUT判定を行う。
 *
 * @param {object} state  現在の状態（phase が 'select' のもの）
 * @param {object} picks  { <uid>: キャラid } 全員の選択
 * @param {Map<number, {id:number, rank:number, name:string}>} charById キャラid → キャラクター
 * @returns {object} 結果を反映した新しい状態（phase は 'reveal'）
 */
export function resolveTurn(state, picks, charById) {
  const { targetScore } = rulesOf(state);
  const banned = { ...(state.banned || {}) };

  // --- 1) OUTでない人の「有効な選択」を集める -----------------------
  const validPicks = {};   // uid → キャラクター
  for (const uid of activeUids(state)) {
    const character = charById.get(picks[uid]);
    if (!character) continue;                     // 選択なし（または存在しないid）
    if (banned[banKey(character.id)]) continue;   // すでに使用禁止 → 無効な選択
    validPicks[uid] = character;
  }

  // --- 2) 同じキャラクターを選んだ人数を数える ----------------------
  const pickerCount = {};  // キャラid → 選んだ人数
  for (const character of Object.values(validPicks)) {
    pickerCount[character.id] = (pickerCount[character.id] || 0) + 1;
  }

  // --- 3) 1人ずつ結果を決める ---------------------------------------
  const results = {};
  const scores = {};
  for (const [uid, score] of Object.entries(state.scores)) {
    if (score.out) {            // すでにOUTの人は何も変わらない
      scores[uid] = { ...score };
      continue;
    }

    const character = validPicks[uid];
    let outcome;      // 'ok' | 'duplicate' | 'none' | 'invalid'
    let gained = 0;   // このターンの加点
    let charId = 0;   // 選んだキャラid（選択なしは 0）

    if (!character) {
      // 選択なし、または使用禁止キャラを選んでいた → 加点なし
      const pickedSomething = charById.has(picks[uid]);
      outcome = pickedSomething ? 'invalid' : 'none';
      charId = pickedSomething ? picks[uid] : 0;
    } else if (pickerCount[character.id] >= 2) {
      // 重複：加点0。このキャラはゲーム終了まで使用禁止になる
      outcome = 'duplicate';
      charId = character.id;
      banned[banKey(character.id)] = state.turn;
    } else {
      // 通常：順位がそのまま点数になる
      outcome = 'ok';
      charId = character.id;
      gained = character.rank;
    }

    const before = score.total;
    const after = before + gained;
    const out = after > targetScore;   // 目標値を「超えたら」OUT。ちょうどはセーフ

    results[uid] = { charId, outcome, gained, before, after, out };
    scores[uid] = { ...score, total: after, out };
  }

  return {
    ...state,
    phase: 'reveal',
    scores,
    banned,
    history: { ...(state.history || {}), [turnKey(state.turn)]: results },
  };
}

/** このターンの結果公開が終わったら、ゲームは終了か？ */
export function isLastReveal(state) {
  const everyoneOut = activeUids(state).length === 0;
  return state.turn >= rulesOf(state).maxTurns || everyoneOut;
}

/**
 * 結果公開のあと、次のターン（または最終結果）へ進めた状態を返す。
 */
export function advance(state) {
  if (isLastReveal(state)) {
    return { ...state, status: 'finished' };
  }
  return { ...state, turn: state.turn + 1, phase: 'select' };
}

/**
 * 最終結果を計算する。
 * OUTの人を除き、目標値との差が最も小さい人が勝者（同じ差なら全員勝者）。
 *
 * @returns {{ winners: string[], ranking: Array<object> }}
 *   ranking の各要素: { uid, name, total, out, diff, place, isWinner }
 *   diff  … 目標値との差（OUTの人は null）
 *   place … 順位（OUTの人は null。同じ差なら同じ順位）
 */
export function judgeResult(state) {
  const { targetScore } = rulesOf(state);
  const players = listParticipants(state).map((player) => ({
    uid: player.uid,
    name: player.name,
    order: player.order,
    total: player.total,
    out: player.out,
    diff: player.out ? null : targetScore - player.total,
  }));

  const safe = players.filter((player) => !player.out).sort((a, b) => a.diff - b.diff || a.order - b.order);
  const outs = players.filter((player) => player.out).sort((a, b) => a.order - b.order);

  // 全員OUTなら勝者なし
  const bestDiff = safe.length > 0 ? safe[0].diff : null;

  safe.forEach((player, index) => {
    const previous = safe[index - 1];
    // 1つ上の人と差が同じなら同じ順位にする（1位, 1位, 3位 …）
    player.place = previous && previous.diff === player.diff ? previous.place : index + 1;
    player.isWinner = player.diff === bestDiff;
  });
  outs.forEach((player) => {
    player.place = null;
    player.isWinner = false;
  });

  return {
    winners: safe.filter((player) => player.isWinner).map((player) => player.uid),
    ranking: [...safe, ...outs],
  };
}
