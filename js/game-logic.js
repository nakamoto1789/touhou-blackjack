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
//        ↓  ホストがモードを選ぶ／オリジナルの設定を選ぶ（withMode / withOriginalSettings）
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
//     ---- ここから下の3つは、オリジナル（持つ／持たない）のときだけ入る ----
//     pickStyle: 'draw',       //   ランダムに出たキャラを「持つ／持たない」で遊ぶ
//     drawStyle: 'random',     //   'random' … 人ごとに違うキャラ ／ 'shared' … 全員に同じキャラ
//     hintBand: 50,            //   初心者のヒントで見える順位の範囲の幅（50 なら「51〜100位」のように出る）
//   },
//   original: { base: 'hard', drawStyle: 'random' },  // ホストが選んだオリジナルの設定（選んだときだけ入る）
//   turn: 1,                   // 現在のターン (1〜rules.maxTurns)
//   phase: 'select' | 'reveal',// 選択中 / 結果公開中
//   scores: {                  // 参加者ごとの点数。out は「バーストしたか」
//     <uid>: { name: '霊夢', order: 0, total: 87, out: false }
//   },
//   banned:  { c3: 1 },        // 使用禁止キャラ（キー: 'c'+キャラid、値: 禁止になったターン）
//   draws:   { t1: { <uid>: キャラid } },  // オリジナルで、各ターンにその人に出たキャラ
//   history: { t1: { <uid>: {…ターン結果…} } }   // 各ターンの結果
// }
//
// ※ scores の out という名前は、Firebase のセキュリティルール（database.rules.json）と
//    お試しモード（backend-local.js）が見ているので、変えないでください。
// ============================================================

import { GAME_MODES, DEFAULT_MODE, MIN_PLAYERS, MAX_PLAYERS } from './config.js';

// ---- ルール ------------------------------------------------------------

/**
 * ルールの項目（意味は上の「ゲームの状態の形」と config.js を参照）。
 * 最初の5つはどのモードにもあり、残りの3つはオリジナル（持つ／持たない）のときだけ入る。
 */
export const RULE_KEYS = [
  'targetScore', 'burstScore', 'maxTurns', 'minRank', 'maxRank',
  'pickStyle', 'drawStyle', 'hintBand',
];

/** キャラの出し方の種類（このファイルの drawTurn が、それぞれの出し方を知っている） */
const DRAW_STYLE_IDS = ['random', 'shared'];

/**
 * オリジナルで送る「持つ／持たない」の値。
 * 選択を送る場所（picks）は「数字なら書ける」決まりなので、数字で表す。
 * （0 にしないのは、「まだ送っていない」と区別しやすくするため）
 */
export const DRAW_DECISION = { keep: 1, pass: -1 };

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
 * （数字が1以上の整数で、バーストする点数が目標値より大きく、順位の開始と終了が逆になっていない。
 *   オリジナルの項目があるときは、その中身も正しい）
 */
export function isValidRules(rules) {
  if (!rules || typeof rules !== 'object') return false;
  const { targetScore, burstScore, maxTurns, minRank, maxRank } = rules;
  const numbersOk =
    isCount(targetScore) &&
    isCount(burstScore) &&
    burstScore > targetScore &&
    isCount(maxTurns) &&
    isCount(minRank) &&
    (maxRank == null || (isCount(maxRank) && maxRank >= minRank));
  if (!numbersOk) return false;
  if (rules.pickStyle == null) return true;   // ハード・ノーマルの形
  return rules.pickStyle === 'draw' && DRAW_STYLE_IDS.includes(rules.drawStyle) && isCount(rules.hintBand);
}

/** オリジナル（ランダムに出たキャラを持つ／持たない）のルールか */
export function isDrawRules(rules) {
  return rules?.pickStyle === 'draw';
}

// ---- ゲームモード ------------------------------------------------------

/** そのモードが選べるか（準備中のモードや、知らない名前は false） */
export function isModeAvailable(id) {
  return Boolean(GAME_MODES[id] && GAME_MODES[id].available);
}

/** モードの「画面に出す情報」を取り出す: { id, name, description, available, draw } */
function modeInfo(id) {
  const { name, description, available, draw } = GAME_MODES[id];
  return { id, name, description, available: Boolean(available), draw: Boolean(draw) };
}

/** 画面に並べるモードの一覧（config.js に書いた順）: [{ id, name, description, available, draw }, …] */
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
 * オリジナルのときは、最初に選ばれている設定（ハードの数字・ランダムキャラクター）のルールを返す。
 */
export function presetRules(id) {
  if (GAME_MODES[id].draw) return drawRulesOf(id, defaultOriginalSettings(id));
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
 * オリジナルを選んだときは、前にホストが選んだ設定があればそれを、なければ最初の設定を使う。
 * ゲーム開始後や、選べないモードのときは変えない（undefined を返す）。
 */
export function withMode(state, id) {
  if (state.status !== 'lobby' || !isModeAvailable(id)) return undefined;
  const rules = GAME_MODES[id].draw ? drawRulesOf(id, originalSettingsOf(state, id)) : presetRules(id);
  return { ...state, mode: id, rules };
}

// ---- オリジナルの設定（数字の借り先・キャラの出し方）--------------------
// オリジナルは、ルールの数字を自分では持たず、ハードかノーマルの数字を借りる。
// ホストが選んだ設定は state.original に { base: 'hard', drawStyle: 'random' } の形で覚える。

/** 「持つ／持たない」で遊ぶモードの名前（config.js で draw: true のモード） */
function drawModeId() {
  return Object.keys(GAME_MODES).find((id) => GAME_MODES[id].draw);
}

/** そのモードの、最初に選ばれている設定 */
function defaultOriginalSettings(modeId) {
  const mode = GAME_MODES[modeId];
  return { base: mode.bases[0], drawStyle: Object.keys(mode.drawStyles)[0] };
}

/** その設定が、そのモードで選べるものか（数字の借り先と、キャラの出し方が、どちらも知っている値か） */
function isValidOriginalSettings(modeId, settings) {
  const mode = GAME_MODES[modeId];
  return Boolean(
    mode?.draw &&
      settings &&
      mode.bases.includes(settings.base) &&
      GAME_MODES[settings.base] &&
      !GAME_MODES[settings.base].draw &&
      DRAW_STYLE_IDS.includes(settings.drawStyle) &&
      mode.drawStyles[settings.drawStyle]
  );
}

/**
 * ホストが選んでいるオリジナルの設定。例: { base: 'hard', drawStyle: 'random' }
 * 選んでいない・前のバージョンの形（数字を入力していたころ）のときは、最初の設定を返す。
 */
export function originalSettingsOf(state, modeId = drawModeId()) {
  const saved = state?.original;
  if (isValidOriginalSettings(modeId, saved)) return { base: saved.base, drawStyle: saved.drawStyle };
  return defaultOriginalSettings(modeId);
}

/**
 * 設定から、オリジナルのルールを作る。
 * 例: ハードの数字・ランダム → { targetScore: 150, …ハードと同じ…, pickStyle: 'draw', drawStyle: 'random', hintBand: 50 }
 */
function drawRulesOf(modeId, settings) {
  return {
    ...pickRules(GAME_MODES[settings.base]),
    pickStyle: 'draw',
    drawStyle: settings.drawStyle,
    hintBand: GAME_MODES[modeId].hintBand[settings.base],
  };
}

/**
 * 待機中に、ホストがオリジナルの設定を選んだ状態を返す。
 * 変えられるのは、オリジナルが選ばれている待機中だけ。
 * ゲーム開始後や、知らない値のときは変えない（undefined を返す）。
 * @param {{ base: string, drawStyle: string }} settings
 */
export function withOriginalSettings(state, settings) {
  const modeId = modeOf(state).id;
  if (state.status !== 'lobby' || !isValidOriginalSettings(modeId, settings)) return undefined;
  const original = { base: settings.base, drawStyle: settings.drawStyle };
  return { ...state, original, rules: drawRulesOf(modeId, original) };
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
//   持つ／持たない           … drawTurn（キャラを出す）と resolveDrawTurn（結果の計算）
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

/**
 * 合計が目標値ちょうどか（「ぴったり賞」になるか）。
 * バーストする点数は必ず目標値より大きいので、ぴったりの人がバーストしていることはない。
 */
export function isExactHit(rules, total) {
  return total === rules.targetScore;
}

/**
 * キャラクターデータにある順位の範囲。例: { first: 1, last: 225 }
 * （人数や順位を 225 と決め打ちせず、データから求める。データを差し替えても、そのまま動く）
 */
export function rankSpanOf(characters) {
  const ranks = characters.map((character) => character.rank);
  return { first: Math.min(...ranks), last: Math.max(...ranks) };
}

/**
 * 初心者のヒント：その順位が入っている「大まかな範囲」。例: 75位 → { from: 51, to: 100 }
 * 範囲の幅は rules.hintBand（ハードの数字なら50位ごと、ノーマルの数字なら10位ごと）。
 * 最後の範囲は、使えるキャラクターの最後の順位で切る（ハードなら「201〜225位」）。
 */
export function hintRangeOf(rules, rank, characters) {
  const band = rules.hintBand;
  const from = rules.minRank + Math.floor((rank - rules.minRank) / band) * band;
  const last = rules.maxRank ?? rankSpanOf(characters).last;
  return { from, to: Math.min(from + band - 1, last) };
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
 * @param {object} [original] ホストが前に選んだオリジナルの設定（あれば覚えておく）
 */
export function createLobbyState(gameNo = 0, modeId = DEFAULT_MODE, original = undefined) {
  const state = { ...OLD_SCREEN_STOPPER, status: 'lobby', gameNo };
  // 前のバージョンの形（数字を入力していたころのルール）は覚えない
  if (isValidOriginalSettings(drawModeId(), original)) {
    state.original = { base: original.base, drawStyle: original.drawStyle };
  }
  return withMode(state, isModeAvailable(modeId) ? modeId : DEFAULT_MODE);
}

/**
 * ゲーム開始時の状態を作る。モードとルールはここで決まり、ゲームが終わるまで変わらない。
 * オリジナルのときは、1ターン目に出るキャラもここで決まる。
 * @param {Array<{uid: string, name: string}>} participants 参加者（表示したい順）
 * @param {number} gameNo このルームで何回目のゲームか
 * @param {object} lobby 待機中の状態。選ばれているモードとルールを引き継ぐ（省くと既定のモード）
 * @param {Array} [characters] キャラクターの配列（オリジナルでキャラを出すのに使う）
 * @param {() => number} [random] 0以上1未満の数を返す乱数（テストでは決まった数を返すものを渡す）
 */
export function createGameState(participants, gameNo, lobby = createLobbyState(), characters = [], random = secureRandom) {
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
  if (mode.draw) {
    // 「もう一度」で待機画面に戻ったとき、同じ設定が選ばれているように覚えておく
    state.original = originalSettingsOf(lobby, mode.id);
    if (characters.length === 0) {
      throw new Error('キャラクターデータがないため、オリジナルを開始できません');
    }
    return drawTurn(state, characters, random);
  }
  return state;
}

/**
 * ゲーム中の状態を、この画面（読み込み済みのプログラム）で正しく扱えるか。
 *   'ok'     … 扱える
 *   'reload' … この画面が知らないモードやルールの項目が入っている
 *              （ゲームが更新されたのに、古い画面のまま開いている）
 *   'broken' … ルールが入っていない、またはモードとルールが合っていない
 *              （前のバージョンの画面から始められたゲーム。たとえば「数字を入力する」オリジナル）
 * 待機中は、モードを選び直せばよいので、いつも 'ok'。
 */
export function compatibilityOf(state) {
  if (state.status === 'lobby') return 'ok';
  if (!state.rules) return 'broken';
  const knowsAllKeys = Object.keys(state.rules).every((key) => RULE_KEYS.includes(key));
  if (!GAME_MODES[state.mode] || !knowsAllKeys) return 'reload';
  // 「持つ／持たない」のモードなのに、そのルールになっていない（またはその逆）
  if (Boolean(GAME_MODES[state.mode].draw) !== isDrawRules(state.rules)) return 'broken';
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

// ---- オリジナル：キャラを出す ------------------------------------------

/**
 * 0以上1未満の乱数。ブラウザに備わっている、予測しにくい乱数（crypto）を使う。
 * （Math.random でも遊べるが、こちらの方が偏りや予測の心配が少ない）
 */
function secureRandom() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** 候補の中から1人を選ぶ */
function pickOne(list, random) {
  return list[Math.floor(random() * list.length)];
}

/**
 * そのターンに出るキャラを決めて、状態（state.draws）に書いた新しい状態を返す。
 * ターンが始まる瞬間（ゲーム開始・「次のターンへ」）に1回だけ呼ばれる。
 * 決めたキャラはルームのデータに残るので、再読み込みしても引き直しにはならない。
 *
 *   ランダムキャラクター（random）… バーストしていない人ごとに別々に選ぶ。その人に一度出たキャラは出さない
 *   固定キャラクター（shared）   … 1人だけ選び、バーストしていない全員に同じキャラを出す。このゲームで一度出たキャラは出さない
 *
 * 選ぶのは、そのルールで使えるキャラクター（ノーマルの数字なら1〜50位）の中から。
 * オリジナル以外のルールのときは、何も変えずにそのまま返す。
 */
export function drawTurn(state, characters, random = secureRandom) {
  const rules = rulesOf(state);
  if (!isDrawRules(rules)) return state;

  const usable = listUsableCharacters(rules, characters);
  const pastDraws = Object.values(state.draws || {});   // これまでのターンに出たキャラ: [{ <uid>: キャラid }, …]
  // 一度出たキャラを除いた候補。万一（範囲が狭すぎて）だれもいなくなったら、全員を候補に戻す
  const candidates = (excluded) => {
    const rest = usable.filter((character) => !excluded.has(character.id));
    return rest.length > 0 ? rest : usable;
  };

  const draws = {};
  if (rules.drawStyle === 'shared') {
    const shown = new Set(pastDraws.flatMap((turnDraws) => Object.values(turnDraws)));
    const character = pickOne(candidates(shown), random);
    for (const uid of activeUids(state)) draws[uid] = character.id;
  } else {
    for (const uid of activeUids(state)) {
      const shown = new Set(pastDraws.map((turnDraws) => turnDraws[uid]).filter((id) => id != null));
      draws[uid] = pickOne(candidates(shown), random).id;
    }
  }
  return { ...state, draws: { ...(state.draws || {}), [turnKey(state.turn)]: draws } };
}

/** このターンに、その人に出たキャラのid（出ていなければ null） */
export function drawnCharIdOf(state, uid) {
  return state.draws?.[turnKey(state.turn)]?.[uid] ?? null;
}

/**
 * ★ゲームの中心となる計算★
 * 1ターン分の選択を受け取り、重複判定・加点・バースト判定を行う。
 *
 * @param {object} state  現在の状態（phase が 'select' のもの）
 * @param {object} picks  { <uid>: キャラid } 全員の選択（オリジナルでは { <uid>: 持つ 1 ／ 持たない -1 }）
 * @param {Map<number, {id:number, rank:number, name:string}>} charById キャラid → キャラクター
 * @returns {object} 結果を反映した新しい状態（phase は 'reveal'）
 */
export function resolveTurn(state, picks, charById) {
  const rules = rulesOf(state);   // このゲームのルール
  if (isDrawRules(rules)) return resolveDrawTurn(state, picks, charById);
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

/**
 * オリジナル（持つ／持たない）の1ターン分の計算。resolveTurn から呼ばれる。
 *   持つ     → 出たキャラの順位を加点（outcome: 'ok'）
 *   持たない → +0（outcome: 'pass'）
 *   決めなかった（ホストが締め切った）→ +0（outcome: 'none'）
 * 「同じキャラを持った人が2人以上なら +0」と使用禁止は、オリジナルでは行わない。
 * どの場合も、公開のときに見せるため、出たキャラのidを結果に残す。
 */
function resolveDrawTurn(state, picks, charById) {
  const rules = rulesOf(state);
  const results = {};
  const scores = {};
  for (const [uid, score] of Object.entries(state.scores)) {
    if (score.out) {            // すでにバーストした人は何も変わらない
      scores[uid] = { ...score };
      continue;
    }

    const character = charById.get(drawnCharIdOf(state, uid));
    let outcome;
    let gained = 0;
    if (picks[uid] === DRAW_DECISION.keep && character) {
      outcome = 'ok';
      gained = pointsFor(rules, character);
    } else if (picks[uid] === DRAW_DECISION.pass) {
      outcome = 'pass';
    } else {
      outcome = 'none';
    }

    const before = score.total;
    const after = before + gained;
    const out = isBurst(rules, after);
    results[uid] = { charId: character ? character.id : 0, outcome, gained, before, after, out };
    scores[uid] = { ...score, total: after, out };
  }

  return {
    ...state,
    phase: 'reveal',
    scores,
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
 * オリジナルのときは、次のターンに出るキャラもここで決まる。
 * @param {Array} [characters] キャラクターの配列（オリジナルでキャラを出すのに使う）
 * @param {() => number} [random] 0以上1未満の数を返す乱数
 */
export function advance(state, characters = [], random = secureRandom) {
  if (isLastReveal(state)) {
    return { ...state, status: 'finished' };
  }
  const next = { ...state, turn: state.turn + 1, phase: 'select' };
  if (!isDrawRules(rulesOf(state))) return next;
  if (characters.length === 0) {
    throw new Error('キャラクターデータがないため、次のキャラを出せません');
  }
  return drawTurn(next, characters, random);
}

/**
 * 最終結果を計算する（勝敗判定）。
 * バーストした人を除き、目標値との差が最も小さい人が勝者（同じ差なら全員勝者）。
 * ハードなら「150に最も近い人」、ノーマルなら「50に最も近い人」になる。
 *
 * 目標値ちょうどの人（ぴったり賞）は差が 0 なので、必ず勝者になる。
 * ぴったり賞は勝ち負けを変えない「おまけの表彰」で、画面の表示だけに使う。
 *
 * @returns {{ winners: string[], ranking: Array<object> }}
 *   ranking の各要素: { uid, name, total, out, diff, exact, place, isWinner }
 *   diff  … 目標値との差（バーストした人は null）
 *   exact … 目標値ちょうどか（ぴったり賞）
 *   place … 順位（バーストした人は null。同じ差なら同じ順位）
 */
export function judgeResult(state) {
  const rules = rulesOf(state);
  const { targetScore } = rules;
  const players = listParticipants(state).map((player) => ({
    uid: player.uid,
    name: player.name,
    order: player.order,
    total: player.total,
    out: player.out,
    // 「どれだけ近いか」なので、差は0以上の数にする。
    // （バーストする点数を目標値より2以上大きくしたルールでは、目標値を少し超えた人も残る）
    diff: player.out ? null : Math.abs(targetScore - player.total),
    exact: !player.out && isExactHit(rules, player.total),
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
