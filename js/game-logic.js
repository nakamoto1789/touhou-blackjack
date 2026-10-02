// ============================================================
// game-logic.js … ゲームのルール（計算だけを行う部分）
//
// このファイルの関数は「入力を受け取って結果を返すだけ」で、
// 画面や通信には一切触りません。そのため、
//   ・ルールを変えたいときはこのファイルだけ見ればよい
//   ・tests/ のテストで正しさを確認できる
// という利点があります。
//
// ---- ルールが決まってから、計算と画面に使われるまで ----
//
//   ゲームモードの設定（config.js の GAME_MODES）
//        ↓  ホストがモードを選ぶ／オリジナルのルールを決める（withMode / withOriginalRules）
//   ゲームの状態（state.rules）   … ルームに1つだけ保存され、全員が同じものを見る
//        ↓  rulesOf(state)
//   計算（このファイル）と 画面（views.js）
//
// 計算も画面も、ルールは必ず rulesOf(state) から読みます（config.js の数字を直接は見ません）。
// そのため、モードを増やしたり数字を変えたりしても、計算の部分は書き換えずに済みます。
//
// ---- ゲームの状態 (state) の形 ----
// {
//   status: 'lobby' | 'playing' | 'finished',
//   gameNo: 1,                 // このルームで何回目のゲームか
//   mode: 'hard',              // ゲームモード（config.js の GAME_MODES の名前）
//   rules: {                   // 選ばれているモードのルール。ゲームが始まると変わらない
//     targetScore: 150,        //   目標値
//     burstScore: 151,         //   バーストする点数（合計がこの点数以上になったらバースト）
//     maxTurns: 5,             //   ターン数
//     minRank: 1,              //   使えるキャラクターの順位（開始）
//     maxRank: 50,             //   使えるキャラクターの順位（終了）。無ければ「最後の順位まで」
//   },
//   original: { …rules と同じ形… },  // ホストが決めたオリジナルのルール（決めたときだけ入る）
//   turn: 1,                   // 現在のターン (1〜rules.maxTurns)
//   phase: 'select' | 'reveal',// 選択中 / 結果公開中
//   scores: {                  // 参加者ごとの点数。out は「バーストしたか」
//     <uid>: { name: '霊夢', order: 0, total: 87, out: false }
//   },
//   banned:  { c3: 1 },        // 使用禁止キャラ（キー: 'c'+キャラid、値: 禁止になったターン）
//   history: { t1: { <uid>: {…ターン結果…} } }   // 各ターンの結果
// }
//
// ※ scores の out という名前は、Firebase のセキュリティルール（database.rules.json）と
//    お試しモード（backend-local.js）が見ているので、変えないでください。
// ============================================================

import { GAME_MODES, DEFAULT_MODE, ORIGINAL_LIMITS, MIN_PLAYERS, MAX_PLAYERS } from './config.js';

// ---- ルール ------------------------------------------------------------

/** ルールの項目。この5つで、1つのゲームのルールが決まる（意味は config.js を参照） */
export const RULE_KEYS = ['targetScore', 'burstScore', 'maxTurns', 'minRank', 'maxRank'];

/** 1以上の整数か */
function isCount(value) {
  return Number.isInteger(value) && value >= 1;
}

/** ルールの項目だけを取り出した、新しいオブジェクトを作る（値が入っていない項目は含めない） */
function pickRules(source) {
  const rules = {};
  for (const key of RULE_KEYS) {
    if (source[key] != null) rules[key] = source[key];
  }
  return rules;
}

/**
 * ルールとして使える形か。
 * （数字が1以上の整数で、バーストする点数が目標値より大きく、順位の開始と終了が逆になっていない）
 */
export function isValidRules(rules) {
  if (!rules || typeof rules !== 'object') return false;
  const { targetScore, burstScore, maxTurns, minRank, maxRank } = rules;
  return (
    isCount(targetScore) &&
    isCount(burstScore) &&
    burstScore > targetScore &&
    isCount(maxTurns) &&
    isCount(minRank) &&
    (maxRank == null || (isCount(maxRank) && maxRank >= minRank))
  );
}

// ---- ゲームモード ------------------------------------------------------

/** そのモードが選べるか（準備中のモードや、知らない名前は false） */
export function isModeAvailable(id) {
  return Boolean(GAME_MODES[id] && GAME_MODES[id].available);
}

/** モードの「画面に出す情報」を取り出す: { id, name, description, available, custom } */
function modeInfo(id) {
  const { name, description, available, custom } = GAME_MODES[id];
  return { id, name, description, available: Boolean(available), custom: Boolean(custom) };
}

/** 画面に並べるモードの一覧（config.js に書いた順）: [{ id, name, description, available, custom }, …] */
export function listModes() {
  return Object.keys(GAME_MODES).map(modeInfo);
}

/**
 * そのゲームのモード。
 * モードの記録がない古いデータのときは、既定のモードを返す。
 */
export function modeOf(state) {
  return modeInfo(GAME_MODES[state?.mode] ? state.mode : DEFAULT_MODE);
}

/**
 * そのモードの、config.js に書いてあるルール。
 * 返す値の例: { targetScore: 50, burstScore: 51, maxTurns: 5, minRank: 1, maxRank: 50 }
 */
export function presetRules(id) {
  return pickRules(GAME_MODES[id]);
}

/**
 * そのゲームに適用されるルール。計算も画面も、ルールは必ずここから読む。
 * ルールの記録がない古いデータ（待機中のルーム）のときは、そのモードの config.js のルールを返す。
 */
export function rulesOf(state) {
  return isValidRules(state?.rules) ? state.rules : presetRules(modeOf(state).id);
}

/**
 * 待機中にモードを選んだ状態を返す。選んだモードのルールが、状態（state.rules）に入る。
 * オリジナルを選んだときは、前にホストが決めたルールがあればそれを、なければ config.js の値を入れる。
 * ゲーム開始後や、選べないモードのときは変えない（undefined を返す）。
 */
export function withMode(state, id) {
  if (state.status !== 'lobby' || !isModeAvailable(id)) return undefined;
  const useOriginal = GAME_MODES[id].custom && isValidRules(state.original);
  return { ...state, mode: id, rules: useOriginal ? state.original : presetRules(id) };
}

/**
 * 待機中にオリジナルのルールを決めた状態を返す。
 * 変えられるのは、ルールを自分で決めるモード（オリジナル）が選ばれているときだけ。
 * ゲーム開始後や、ルールとして使えない値のときは変えない（undefined を返す）。
 */
export function withOriginalRules(state, rules) {
  if (state.status !== 'lobby' || !modeOf(state).custom || !isValidRules(rules)) return undefined;
  const original = pickRules(rules);
  return { ...state, rules: original, original };
}

// ---- ルールによって変わる計算 ------------------------------------------
// 「ルールによって違うところ」は、rules を受け取る小さな関数に分けてあります。
// 新しい種類のルール（特殊ルールなど）を足したいときは、
//   1. config.js のモードの設定に項目を足し、上の RULE_KEYS にもその名前を足す
//   2. 下の関数（または resolveTurn / judgeResult）で、その項目を見て処理を分ける
// の順で直します。その項目を書いていないモードの動きは変わりません。
//
//   使えるキャラクターの範囲 … isCharacterUsable
//   得点計算                 … pointsFor
//   バーストする条件         … isBurst
//   重複したときの扱い       … resolveTurn の「重複」の部分
//   勝敗判定                 … judgeResult
//   ターン数                 … isLastReveal

/** そのキャラクターを、このルールで使えるか（順位が minRank 位〜maxRank 位の中にあるか） */
export function isCharacterUsable(rules, character) {
  // maxRank が入っていなければ、最後の順位まで使える
  return character.rank >= rules.minRank && (rules.maxRank == null || character.rank <= rules.maxRank);
}

/** このルールで使えるキャラクターだけを取り出す（並び順は元のまま） */
export function listUsableCharacters(rules, characters) {
  return characters.filter((character) => isCharacterUsable(rules, character));
}

/** キャラクターを選んだときの加点。いまはどのモードも「順位がそのまま点数」 */
export function pointsFor(rules, character) {
  return character.rank;
}

/**
 * その合計点でバーストするか。
 * 合計が「バーストする点数」以上ならバースト（ハードなら 150 はセーフ、151 でバースト）。
 */
export function isBurst(rules, total) {
  return total >= rules.burstScore;
}

// ---- オリジナルのルールのチェック --------------------------------------

/**
 * キャラクターデータにある順位の範囲。例: { first: 1, last: 225 }
 * （人数や順位を 225 と決め打ちせず、データから求める。データを差し替えても、そのまま動く）
 */
export function rankSpanOf(characters) {
  const ranks = characters.map((character) => character.rank);
  return { first: Math.min(...ranks), last: Math.max(...ranks) };
}

/**
 * 最後のターンまで全員が選べるために必要な、キャラクターの人数。
 * 重複したキャラクターは使用禁止になるので、1ターンに最大「参加人数 ÷ 2」人ずつ減っていく。
 * それでも最後のターンに1人は残るだけの人数が必要。（5ターンなら 9人）
 */
export function neededCharacters(maxTurns) {
  return (maxTurns - 1) * Math.floor(MAX_PLAYERS / 2) + 1;
}

/**
 * ホストが入力したオリジナルのルールに、問題がないか調べる。
 * @param {object} rules 入力された値（数字でない入力は NaN になっている）
 * @param {Array<{rank: number}>} characters キャラクターの配列
 * @returns {string[]} 問題の説明（そのまま画面に出せる文）。問題がなければ空の配列
 */
export function findRuleProblems(rules, characters) {
  const { targetScore, burstScore, maxTurns, minRank, maxRank } = rules;
  const { first, last } = rankSpanOf(characters);
  const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  const problems = [];

  const targetOk = inRange(targetScore, 1, ORIGINAL_LIMITS.maxTargetScore);
  if (!targetOk) {
    problems.push(`目標値は 1〜${ORIGINAL_LIMITS.maxTargetScore} の整数で入力してください。`);
  }

  // 目標値とバーストする点数が矛盾しないこと（目標値ちょうどでバーストしてしまう設定は不可）
  if (!inRange(burstScore, 2, ORIGINAL_LIMITS.maxBurstScore)) {
    problems.push(`バーストする点数は 2〜${ORIGINAL_LIMITS.maxBurstScore} の整数で入力してください。`);
  } else if (targetOk && burstScore <= targetScore) {
    problems.push(`バーストする点数は、目標値より大きくしてください（${targetScore + 1} 以上）。`);
  }

  const turnsOk = inRange(maxTurns, 1, ORIGINAL_LIMITS.maxTurns);
  if (!turnsOk) {
    problems.push(`ターン数は 1〜${ORIGINAL_LIMITS.maxTurns} の整数で入力してください。`);
  }

  if (!inRange(minRank, first, last) || !inRange(maxRank, first, last)) {
    problems.push(`順位は ${first}〜${last} の整数で入力してください。`);
  } else if (minRank > maxRank) {
    problems.push('順位は、開始が終了より大きくならないようにしてください。');
  } else if (turnsOk) {
    // 同率順位があるので、人数は「終了 − 開始 + 1」とは限らない。実際に数える
    const count = listUsableCharacters(rules, characters).length;
    const needed = neededCharacters(maxTurns);
    if (count < needed) {
      problems.push(
        `この範囲のキャラクターは ${count} 人です。${maxTurns} ターン遊ぶには ${needed} 人以上必要なので、順位の範囲を広げてください。`
      );
    }
  }

  return problems;
}

// ---- 状態を作る -------------------------------------------------------

/**
 * 前のバージョンの画面を開いたままの人のための印。
 *
 * このゲームは以前、モードを state.difficulty（'hard' / 'lunatic' など）で表していた。
 * そのころの画面を開いたままの人が新しいゲームに入ると、古いルール（Hard＝目標21 など）で
 * 計算してしまう。前のバージョンの画面は、知らない難易度のゲームを見ると
 * 「ページを再読み込みしてください」と表示して止まるので、わざと知らない名前を入れておく。
 * （いまのコードは、この項目を読まない）
 */
const OLD_SCREEN_STOPPER = { difficulty: 'reload' };

/**
 * ゲーム開始前（待機中）の状態を作る。選ばれているモードと、そのルールが入る。
 * @param {number} gameNo このルームで、これまでに遊んだゲームの数
 * @param {string} modeId 選ばれているモードの名前（選べないモードなら、既定のモードになる）
 * @param {object} [original] ホストが前に決めたオリジナルのルール（あれば覚えておく）
 */
export function createLobbyState(gameNo = 0, modeId = DEFAULT_MODE, original = undefined) {
  const state = { ...OLD_SCREEN_STOPPER, status: 'lobby', gameNo };
  if (isValidRules(original)) state.original = pickRules(original);
  return withMode(state, isModeAvailable(modeId) ? modeId : DEFAULT_MODE);
}

/**
 * ゲーム開始時の状態を作る。モードとルールはここで決まり、ゲームが終わるまで変わらない。
 * @param {Array<{uid: string, name: string}>} participants 参加者（表示したい順）
 * @param {number} gameNo このルームで何回目のゲームか
 * @param {object} lobby 待機中の状態。選ばれているモードとルールを引き継ぐ（省くと既定のモード）
 */
export function createGameState(participants, gameNo, lobby = createLobbyState()) {
  const mode = modeOf(lobby);
  if (!mode.available) {
    throw new Error('このモードはまだ遊べません');
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
  const state = {
    ...OLD_SCREEN_STOPPER,
    status: 'playing',
    gameNo,
    mode: mode.id,
    rules: rulesOf(lobby),   // このゲームのルール。ここから先は変わらない
    turn: 1,
    phase: 'select',
    scores,
  };
  if (isValidRules(lobby.original)) state.original = lobby.original;
  return state;
}

/**
 * ゲーム中の状態を、この画面（読み込み済みのプログラム）で正しく扱えるか。
 *   'ok'     … 扱える
 *   'reload' … この画面が知らないモードやルールの項目が入っている
 *              （ゲームが更新されたのに、古い画面のまま開いている）
 *   'broken' … ルールが入っていない（もっと前のバージョンの画面から始められたゲーム）
 * 待機中は、モードを選び直せばよいので、いつも 'ok'。
 */
export function compatibilityOf(state) {
  if (state.status === 'lobby') return 'ok';
  if (!state.rules) return 'broken';
  const knowsAllKeys = Object.keys(state.rules).every((key) => RULE_KEYS.includes(key));
  if (!GAME_MODES[state.mode] || !knowsAllKeys) return 'reload';
  return isValidRules(state.rules) ? 'ok' : 'broken';
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

/** まだバーストしていない（＝このターン選択する）参加者のuid一覧 */
export function activeUids(state) {
  return listParticipants(state)
    .filter((player) => !player.out)
    .map((player) => player.uid);
}

/**
 * バーストしていない参加者が全員「決定」を押したか。
 * @param {object} state
 * @param {object} submitted { <uid>: true } 決定済みの人の印
 */
export function allActiveSubmitted(state, submitted = {}) {
  const active = activeUids(state);
  return active.length > 0 && active.every((uid) => submitted[uid] === true);
}

/**
 * ★ゲームの中心となる計算★
 * 1ターン分の選択を受け取り、重複判定・加点・バースト判定を行う。
 *
 * @param {object} state  現在の状態（phase が 'select' のもの）
 * @param {object} picks  { <uid>: キャラid } 全員の選択
 * @param {Map<number, {id:number, rank:number, name:string}>} charById キャラid → キャラクター
 * @returns {object} 結果を反映した新しい状態（phase は 'reveal'）
 */
export function resolveTurn(state, picks, charById) {
  const rules = rulesOf(state);   // このゲームのルール
  const banned = { ...(state.banned || {}) };

  // --- 1) バーストしていない人の「有効な選択」を集める ---------------
  const validPicks = {};   // uid → キャラクター
  for (const uid of activeUids(state)) {
    const character = charById.get(picks[uid]);
    if (!character) continue;                             // 選択なし（または存在しないid）
    if (banned[banKey(character.id)]) continue;           // すでに使用禁止 → 無効な選択
    if (!isCharacterUsable(rules, character)) continue;   // このルールでは使えない → 無効な選択
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
    if (score.out) {            // すでにバーストした人は何も変わらない
      scores[uid] = { ...score };
      continue;
    }

    const character = validPicks[uid];
    let outcome;      // 'ok' | 'duplicate' | 'none' | 'invalid'
    let gained = 0;   // このターンの加点
    let charId = 0;   // 選んだキャラid（選択なしは 0）

    if (!character) {
      // 選択なし、または選べないキャラ（使用禁止・このルールでは対象外）を選んでいた → 加点なし
      const pickedSomething = charById.has(picks[uid]);
      outcome = pickedSomething ? 'invalid' : 'none';
      charId = pickedSomething ? picks[uid] : 0;
    } else if (pickerCount[character.id] >= 2) {
      // 重複：加点0。このキャラはゲーム終了まで使用禁止になる（どのモードでも同じ）
      outcome = 'duplicate';
      charId = character.id;
      banned[banKey(character.id)] = state.turn;
    } else {
      // 通常：得点計算のルールで加点する
      outcome = 'ok';
      charId = character.id;
      gained = pointsFor(rules, character);
    }

    const before = score.total;
    const after = before + gained;
    const out = isBurst(rules, after);   // バーストしたか（合計が「バーストする点数」以上）

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

/** このターンの結果公開が終わったら、ゲームは終了か？（最後のターンか、全員がバーストしたとき） */
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
 * 最終結果を計算する（勝敗判定）。
 * バーストした人を除き、目標値との差が最も小さい人が勝者（同じ差なら全員勝者）。
 * ハードなら「150に最も近い人」、ノーマルなら「50に最も近い人」になる。
 *
 * @returns {{ winners: string[], ranking: Array<object> }}
 *   ranking の各要素: { uid, name, total, out, diff, place, isWinner }
 *   diff  … 目標値との差（バーストした人は null）
 *   place … 順位（バーストした人は null。同じ差なら同じ順位）
 */
export function judgeResult(state) {
  const { targetScore } = rulesOf(state);
  const players = listParticipants(state).map((player) => ({
    uid: player.uid,
    name: player.name,
    order: player.order,
    total: player.total,
    out: player.out,
    // 「どれだけ近いか」なので、差は0以上の数にする。
    // （オリジナルでバーストする点数を目標値より2以上大きくすると、目標値を少し超えた人も残る）
    diff: player.out ? null : Math.abs(targetScore - player.total),
  }));

  const safe = players.filter((player) => !player.out).sort((a, b) => a.diff - b.diff || a.order - b.order);
  const outs = players.filter((player) => player.out).sort((a, b) => a.order - b.order);

  // 全員がバーストしたら勝者なし
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
