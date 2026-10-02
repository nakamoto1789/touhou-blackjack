// ============================================================
// game-logic.test.js … ゲームルールのテスト
//
// tests/index.html をブラウザで開くと実行され、結果が画面に表示されます。
// ルール（game-logic.js）や一覧の並び順（util.js）を書き換えたら、
// ここで壊れていないか確認できます。
// ============================================================

import { GAME_MODES, DEFAULT_MODE, ORIGINAL_LIMITS } from '../js/config.js';
import {
  RULE_KEYS,
  isValidRules,
  isModeAvailable,
  listModes,
  modeOf,
  presetRules,
  rulesOf,
  withMode,
  withOriginalRules,
  isCharacterUsable,
  listUsableCharacters,
  pointsFor,
  isBurst,
  rankSpanOf,
  neededCharacters,
  findRuleProblems,
  createGameState,
  createLobbyState,
  compatibilityOf,
  roundKeyOf,
  isBanned,
  activeUids,
  allActiveSubmitted,
  resolveTurn,
  isLastReveal,
  advance,
  judgeResult,
} from '../js/game-logic.js';
import { kanaRowOf, compareKana, prepareCharacters, searchCharacters, parseWholeNumber } from '../js/util.js';

// ---- とても小さなテスト用の道具 ------------------------------------
const results = [];

function test(name, body) {
  try {
    body();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}

function assertEqual(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label} 期待した値: ${e} ／ 実際の値: ${a}`);
  }
}

function assertThrows(body, label = '') {
  let thrown = false;
  try {
    body();
  } catch {
    thrown = true;
  }
  if (!thrown) throw new Error(`${label} エラーになるはずが、ならなかった`);
}

// ---- テスト用のデータ ----------------------------------------------
// 本物のキャラクターデータを読み込む
const characters = await (await fetch('../data/characters.json')).json();
const charById = new Map(characters.map((c) => [c.id, c]));
const byName = (name) => characters.find((c) => c.name === name);
const byRank = (rank) => characters.find((c) => c.rank === rank);     // その順位のキャラクター

const KOISHI = byName('古明地 こいし');   // 1位
const MARISA = byName('霧雨 魔理沙');     // 2位
const REIMU = byName('博麗 霊夢');        // 3位
const REMILIA = byName('レミリア・スカーレット'); // 5位

/** n人の参加者を作る: A, B, C … */
function players(n) {
  return 'ABCDE'.slice(0, n).split('').map((uid) => ({ uid, name: `プレイヤー${uid}` }));
}

/** そのモードが選ばれている、待機中の状態 */
const lobbyOf = (modeId) => createLobbyState(0, modeId);

/** オリジナルで、ホストがルールを決めた待機中の状態 */
const originalLobby = (rules) => withOriginalRules(lobbyOf('original'), rules);

/** 合計点を直接指定した状態を作る（テストを短く書くため）。lobby を省くとハード */
function stateWithTotals(totals, turn = 1, lobby = undefined) {
  const state = createGameState(players(Object.keys(totals).length), 1, lobby);
  state.turn = turn;
  for (const [uid, total] of Object.entries(totals)) {
    state.scores[uid].total = total;
    state.scores[uid].out = isBurst(rulesOf(state), total);
  }
  return state;
}

// ---- データのテスト ------------------------------------------------
test('データ: キャラクターは225人で、idは重複しない', () => {
  assertEqual(characters.length, 225);
  assertEqual(new Set(characters.map((c) => c.id)).size, 225);
});

test('データ: 仕様の例どおりの順位になっている', () => {
  assertEqual(KOISHI.rank, 1);
  assertEqual(MARISA.rank, 2);
  assertEqual(REIMU.rank, 3);
  assertEqual(byName('フランドール・スカーレット').rank, 4);
  assertEqual(REMILIA.rank, 5);
});

test('データ: 順位の範囲（1位〜最後の順位）は、データから求める', () => {
  assertEqual(rankSpanOf(characters), { first: 1, last: 225 });
  // データが変われば、結果も変わる（225 と決め打ちしていない）
  assertEqual(rankSpanOf(characters.slice(0, 30)), { first: 1, last: 30 });
});

// ---- ゲーム開始のテスト --------------------------------------------
test('開始: 全員0点・1ターン目・選択フェーズで始まる', () => {
  const state = createGameState(players(3), 1);
  assertEqual(state.status, 'playing');
  assertEqual(state.turn, 1);
  assertEqual(state.phase, 'select');
  assertEqual(Object.values(state.scores).map((s) => s.total), [0, 0, 0]);
  assertEqual(roundKeyOf(state), 'g1t1');
});

test('開始: 1人では開始できない／6人では開始できない', () => {
  assertThrows(() => createGameState(players(1), 1), '1人');
  assertThrows(() => createGameState([...players(5), { uid: 'F', name: 'F' }], 1), '6人');
});

// ---- 1ターンの計算のテスト -----------------------------------------
test('加点: 選んだキャラの順位がそのまま加算される', () => {
  const next = resolveTurn(createGameState(players(2), 1), { A: REIMU.id, B: KOISHI.id }, charById);
  assertEqual(next.scores.A.total, 3, '霊夢');
  assertEqual(next.scores.B.total, 1, 'こいし');
  assertEqual(next.history.t1.A, { charId: REIMU.id, outcome: 'ok', gained: 3, before: 0, after: 3, out: false });
  assertEqual(next.phase, 'reveal');
});

test('重複: 同じキャラを選んだ全員が+0になり、他の人は影響を受けない（仕様5の例）', () => {
  const next = resolveTurn(createGameState(players(3), 1), { A: REIMU.id, B: REIMU.id, C: KOISHI.id }, charById);
  assertEqual(next.scores.A.total, 0, 'A');
  assertEqual(next.scores.B.total, 0, 'B');
  assertEqual(next.scores.C.total, 1, 'C');
  assertEqual(next.history.t1.A.outcome, 'duplicate');
  assertEqual(next.history.t1.B.outcome, 'duplicate');
  assertEqual(next.history.t1.C.outcome, 'ok');
});

test('重複: 重複したキャラは使用禁止になり、重複していないキャラは禁止にならない', () => {
  const next = resolveTurn(createGameState(players(3), 1), { A: REIMU.id, B: REIMU.id, C: KOISHI.id }, charById);
  assertEqual(isBanned(next, REIMU.id), true, '霊夢');
  assertEqual(isBanned(next, KOISHI.id), false, 'こいし');
});

test('重複: 3人以上が同じキャラでも全員+0', () => {
  const next = resolveTurn(createGameState(players(4), 1), { A: MARISA.id, B: MARISA.id, C: MARISA.id, D: REIMU.id }, charById);
  assertEqual([next.scores.A.total, next.scores.B.total, next.scores.C.total, next.scores.D.total], [0, 0, 0, 3]);
});

test('重複: 同率順位の「別のキャラ」は重複にならない', () => {
  const tied = characters.filter((c) => c.rank === 195);
  assertEqual(tied.length, 2, '195位は2人');
  const next = resolveTurn(createGameState(players(2), 1), { A: tied[0].id, B: tied[1].id }, charById);
  assertEqual(next.history.t1.A.outcome, 'ok');
  assertEqual(next.history.t1.B.outcome, 'ok');
});

test('使用禁止: 禁止は次のターン以降も続き、選んでも加点されない', () => {
  let state = resolveTurn(createGameState(players(3), 1), { A: REIMU.id, B: REIMU.id, C: KOISHI.id }, charById);
  state = advance(state);
  assertEqual(state.turn, 2);
  assertEqual(isBanned(state, REIMU.id), true, '2ターン目も禁止のまま');

  // 画面では選べないが、もし不正に送られてきても加点しない
  state = resolveTurn(state, { A: REIMU.id, B: MARISA.id, C: MARISA.id }, charById);
  assertEqual(state.history.t2.A.outcome, 'invalid');
  assertEqual(state.scores.A.total, 0);
  assertEqual(isBanned(state, MARISA.id), true, '魔理沙も新たに禁止');
});

test('使用禁止: 禁止キャラを1人だけが選んだ場合も「重複」には数えない', () => {
  let state = resolveTurn(createGameState(players(2), 1), { A: REIMU.id, B: REIMU.id }, charById);
  state = advance(state);
  state = resolveTurn(state, { A: REIMU.id, B: REMILIA.id }, charById);
  assertEqual(state.history.t2.A.outcome, 'invalid');
  assertEqual(state.history.t2.B.outcome, 'ok');
  assertEqual(state.scores.B.total, 5);
});

test('未選択: 選択しなかった人は+0', () => {
  const next = resolveTurn(createGameState(players(2), 1), { A: REIMU.id }, charById);
  assertEqual(next.history.t1.B, { charId: 0, outcome: 'none', gained: 0, before: 0, after: 0, out: false });
});

// ---- バーストのテスト ----------------------------------------------
test('バースト: 判定は「合計がバーストする点数以上」（目標値とは別の数字で決まる）', () => {
  const hard = presetRules('hard');
  assertEqual([isBurst(hard, 149), isBurst(hard, 150), isBurst(hard, 151), isBurst(hard, 152)], [false, false, true, true]);
  const normal = presetRules('normal');
  assertEqual([isBurst(normal, 50), isBurst(normal, 51)], [false, true]);
  // 目標値が同じでも、バーストする点数がちがえば結果がちがう
  assertEqual(isBurst({ targetScore: 150, burstScore: 160 }, 155), false);
});

test('バースト: ハードは150ちょうどならセーフ', () => {
  const next = resolveTurn(stateWithTotals({ A: 147, B: 0 }), { A: REIMU.id, B: KOISHI.id }, charById);
  assertEqual(next.scores.A.total, 150);
  assertEqual(next.scores.A.out, false);
});

test('バースト: ハードは151でバースト', () => {
  const next = resolveTurn(stateWithTotals({ A: 148, B: 0 }), { A: REIMU.id, B: KOISHI.id }, charById);
  assertEqual(next.scores.A.total, 151);
  assertEqual(next.scores.A.out, true);
  assertEqual(next.history.t1.A.out, true);
});

test('バースト: 重複で+0なら、150を超えるはずの選択でもバーストしない', () => {
  const big = byRank(100);
  const next = resolveTurn(stateWithTotals({ A: 100, B: 100 }), { A: big.id, B: big.id }, charById);
  assertEqual([next.scores.A.out, next.scores.B.out], [false, false]);
  assertEqual([next.scores.A.total, next.scores.B.total], [100, 100]);
});

test('バースト: バーストした人は選択する人に含まれず、点数も変わらない', () => {
  const state = stateWithTotals({ A: 153, B: 10, C: 20 }, 3);
  assertEqual(activeUids(state), ['B', 'C']);
  // バーストしたAが（不正に）選択を送ってきても無視される
  const next = resolveTurn(state, { A: KOISHI.id, B: KOISHI.id, C: REIMU.id }, charById);
  assertEqual(next.scores.A.total, 153);
  assertEqual(next.history.t3.A, undefined, 'バーストした人の結果は作られない');
  assertEqual(next.history.t3.B.outcome, 'ok', 'バーストした人の選択は重複判定に含めない');
});

test('決定待ち: バーストした人を除いた全員が決定したら「全員完了」', () => {
  const state = stateWithTotals({ A: 153, B: 10, C: 20 });
  assertEqual(allActiveSubmitted(state, { B: true }), false);
  assertEqual(allActiveSubmitted(state, { B: true, C: true }), true);
  assertEqual(allActiveSubmitted(state, undefined), false);
});

// ---- ターン進行のテスト --------------------------------------------
test('進行: 5ターン目の公開が終わるとゲーム終了', () => {
  let state = createGameState(players(2), 1);
  for (let turn = 1; turn <= 5; turn++) {
    assertEqual(state.turn, turn);
    assertEqual(state.status, 'playing');
    state = resolveTurn(state, { A: KOISHI.id, B: MARISA.id }, charById);
    assertEqual(isLastReveal(state), turn === 5, `${turn}ターン目`);
    state = advance(state);
  }
  assertEqual(state.status, 'finished');
  assertEqual(state.scores.A.total, 5);
  assertEqual(state.scores.B.total, 10);
});

test('進行: 全員がバーストしたら、5ターン目を待たずに終了', () => {
  let state = resolveTurn(createGameState(players(2), 1), { A: byRank(200).id, B: byRank(201).id }, charById);
  assertEqual(isLastReveal(state), true);
  state = advance(state);
  assertEqual(state.status, 'finished');
});

test('進行: 待機状態は lobby。既定のモード（ハード）と、そのルールが入っている', () => {
  const lobby = createLobbyState(2);
  assertEqual([lobby.status, lobby.gameNo, lobby.mode], ['lobby', 2, 'hard']);
  assertEqual(lobby.rules, { targetScore: 150, burstScore: 151, maxTurns: 5, minRank: 1 });
  assertEqual(DEFAULT_MODE, 'hard');
});

// ---- 最終結果のテスト ----------------------------------------------
test('結果: 仕様14の例（A148 B142 C153 D137 E148 → AとEが勝者）', () => {
  const result = judgeResult(stateWithTotals({ A: 148, B: 142, C: 153, D: 137, E: 148 }));
  assertEqual(result.winners, ['A', 'E']);
  assertEqual(result.ranking.map((p) => p.uid), ['A', 'E', 'B', 'D', 'C'], '並び順');
  assertEqual(result.ranking.map((p) => p.place), [1, 1, 3, 4, null], '順位');
  assertEqual(result.ranking.map((p) => p.diff), [2, 2, 8, 13, null], '150との差');
  assertEqual(result.ranking.map((p) => p.isWinner), [true, true, false, false, false]);
});

test('結果: 150ちょうどの人が単独の勝者', () => {
  const result = judgeResult(stateWithTotals({ A: 150, B: 149 }));
  assertEqual(result.winners, ['A']);
});

test('結果: 全員がバーストしたら勝者なし', () => {
  const result = judgeResult(stateWithTotals({ A: 151, B: 200 }));
  assertEqual(result.winners, []);
  assertEqual(result.ranking.every((p) => p.out && p.place === null), true);
});

// ---- ゲームモードのテスト ------------------------------------------
test('モード: ハード・ノーマル・オリジナルの3つで、どれも選べる', () => {
  assertEqual(
    listModes().map((mode) => [mode.id, mode.name, mode.description, mode.available]),
    [
      ['hard', 'ハード', '150点を目指す', true],
      ['normal', 'ノーマル', '50点を目指す', true],
      ['original', 'オリジナル', '自分でルールを設定', true],
    ]
  );
  // ルールを自分で決めるモードは、オリジナルだけ
  assertEqual(listModes().map((mode) => mode.custom), [false, false, true]);
});

test('モード: ハードは 全キャラクター・目標150・バースト151・5ターン', () => {
  // maxRank が入っていない ＝ 最後の順位まで（全キャラクター）
  assertEqual(presetRules('hard'), { targetScore: 150, burstScore: 151, maxTurns: 5, minRank: 1 });
  assertEqual(listUsableCharacters(presetRules('hard'), characters).length, characters.length);
});

test('モード: ノーマルは 1〜50位・目標50・バースト51・5ターン', () => {
  assertEqual(presetRules('normal'), { targetScore: 50, burstScore: 51, maxTurns: 5, minRank: 1, maxRank: 50 });
});

test('モード: どのモードの設定も、ルールとして使える形になっている', () => {
  for (const mode of listModes()) {
    assertEqual(isValidRules(presetRules(mode.id)), true, mode.name);
    assertEqual(Object.keys(presetRules(mode.id)).every((key) => RULE_KEYS.includes(key)), true, mode.name);
  }
});

test('モード: 選んだモードとルールは、ゲーム開始時に記録され、ターンが進んでも変わらない', () => {
  let state = createGameState(players(2), 1, lobbyOf('normal'));
  assertEqual(state.mode, 'normal');
  assertEqual(state.rules, presetRules('normal'));
  state = advance(resolveTurn(state, { A: KOISHI.id, B: MARISA.id }, charById));
  assertEqual(state.turn, 2);
  assertEqual([state.mode, modeOf(state).name], ['normal', 'ノーマル']);
  assertEqual(rulesOf(state), presetRules('normal'));
});

test('モード: 変更できるのは待機中だけ（ゲーム開始後と、知らないモードは不可）', () => {
  const toNormal = withMode(lobbyOf('hard'), 'normal');
  assertEqual([toNormal.status, toNormal.mode], ['lobby', 'normal']);
  assertEqual(toNormal.rules, presetRules('normal'), 'ルールもいっしょに替わる');
  assertEqual(withMode(lobbyOf('normal'), 'hard').rules, presetRules('hard'));
  assertEqual(withMode(lobbyOf('hard'), 'lunatic'), undefined, '知らないモード');
  assertEqual(withMode(createGameState(players(2), 1, lobbyOf('hard')), 'normal'), undefined, 'ゲーム中');
});

test('モード: ルールは状態から読む。設定を書き換えても、進行中のゲームのルールは変わらない', () => {
  const state = createGameState(players(2), 1, lobbyOf('hard'));
  const saved = { ...GAME_MODES.hard };
  GAME_MODES.hard.targetScore = 999;
  GAME_MODES.hard.burstScore = 1000;
  try {
    assertEqual(rulesOf(state).targetScore, 150, '進行中のゲーム');
    assertEqual(isBurst(rulesOf(state), 151), true);
    assertEqual(presetRules('hard').targetScore, 999, 'これから選ぶ分は新しい設定');
  } finally {
    Object.assign(GAME_MODES.hard, saved);
  }
});

test('モード: 準備中（available が false）のモードは選べず、開始もできない', () => {
  GAME_MODES.soon = { name: '準備中のモード', description: '', available: false, targetScore: 10, burstScore: 11, maxTurns: 2, minRank: 1 };
  try {
    assertEqual(isModeAvailable('soon'), false);
    assertEqual(withMode(lobbyOf('hard'), 'soon'), undefined);
    assertEqual(createLobbyState(0, 'soon').mode, 'hard', '選べないモードを指定したら既定のモード');
    assertThrows(() => createGameState(players(2), 1, { status: 'lobby', gameNo: 0, mode: 'soon' }));
  } finally {
    delete GAME_MODES.soon;
  }
});

test('モード: モードやルールの記録がない古いデータ（待機中）は、ハードとして扱う', () => {
  const oldLobby = { status: 'lobby', gameNo: 3, difficulty: 'hard' };   // 前のバージョンの形
  assertEqual(modeOf(oldLobby).id, 'hard');
  assertEqual(rulesOf(oldLobby), presetRules('hard'));
  assertEqual(rulesOf(undefined).targetScore, 150);
  const state = createGameState(players(2), 4, oldLobby);
  assertEqual([state.mode, state.rules.targetScore, state.rules.burstScore], ['hard', 150, 151]);
});

test('モード: 設定を1つ足すだけで、別のルールのゲームになる（将来の追加の確認）', () => {
  // 目標10・バースト11・2ターンのモードを、このテストのあいだだけ足す
  GAME_MODES.sample = { name: 'サンプル', description: '', available: true, targetScore: 10, burstScore: 11, maxTurns: 2, minRank: 1, maxRank: null };
  try {
    let state = createGameState(players(2), 1, lobbyOf('sample'));

    // 1ターン目: A は +5（合計5）、B は +11（11点以上なのでバースト）
    state = resolveTurn(state, { A: REMILIA.id, B: byRank(11).id }, charById);
    assertEqual([state.scores.A.out, state.scores.B.out], [false, true]);
    assertEqual(isLastReveal(state), false, '1ターン目では終わらない');

    // 2ターン目: A は +5 で合計10（ちょうどはセーフ）。2ターンで終了する
    state = resolveTurn(advance(state), { A: REMILIA.id }, charById);
    assertEqual([state.scores.A.total, state.scores.A.out], [10, false]);
    assertEqual(isLastReveal(state), true, '2ターンで終了');
    assertEqual(judgeResult(advance(state)).ranking[0].diff, 0, '目標10との差');
  } finally {
    delete GAME_MODES.sample;
  }
});

// ---- 一覧の並び順と検索のテスト ------------------------------------
// 画面と同じ準備（50音順に並べ、検索用の文字列をつける）をしたキャラクター一覧
const sorted = prepareCharacters(structuredClone(characters));
const sortedNames = sorted.map((c) => c.name);
const rowOf = (name) => sorted.find((c) => c.name === name).kanaRow;
const find = (query) => searchCharacters(sorted, query).map((c) => c.name);

test('並び順: 50音の「行」を判定する（濁点・半濁点・カタカナも同じ行）', () => {
  assertEqual(kanaRowOf('はくれい れいむ'), 'は');
  assertEqual(kanaRowOf('パチュリー'), 'は');
  assertEqual(kanaRowOf('ぎょくと'), 'か');
  assertEqual(kanaRowOf('ドレミー'), 'た');
  assertEqual(kanaRowOf('わかさぎひめ'), 'わ');
});

test('並び順: よみがなの50音順に並ぶ', () => {
  const readings = ['はくれいれいむ', 'きりさめまりさ', 'いぶきすいか', 'ありす', 'しゃめいまるあや', 'いぬばしりもみじ'];
  assertEqual(
    [...readings].sort(compareKana),
    ['ありす', 'いぬばしりもみじ', 'いぶきすいか', 'きりさめまりさ', 'しゃめいまるあや', 'はくれいれいむ']
  );
});

test('並び順: 一覧は順位順ではなく50音順（225人すべてに行がつく）', () => {
  assertEqual(sorted.length, 225);
  assertEqual(sorted.filter((c) => c.kanaRow === 'その他').map((c) => c.name), [], '行が決まらないキャラクター');

  // 見出しは あ→か→さ→…→わ の順に、1回ずつ現れる
  const headers = sorted.map((c) => c.kanaRow).filter((row, index, all) => row !== all[index - 1]);
  assertEqual(headers, ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ']);

  // 順位1位のキャラクターが先頭に来ていない（＝順位順ではない）
  assertEqual(sortedNames[0] === KOISHI.name, false);

  const position = (name) => sortedNames.indexOf(name);
  assertEqual(position('アリス・マーガトロイド') < position('犬走 椛'), true, 'ありす → いぬばしり');
  assertEqual(position('犬走 椛') < position('伊吹 萃香'), true, 'いぬばしり → いぶき');
  assertEqual(position('伊吹 萃香') < position('霧雨 魔理沙'), true, 'いぶき → きりさめ');
  assertEqual(position('霧雨 魔理沙') < position('博麗 霊夢'), true, 'きりさめ → はくれい');
  assertEqual(
    [rowOf('アリス・マーガトロイド'), rowOf('霧雨 魔理沙'), rowOf('射命丸 文'), rowOf('博麗 霊夢')],
    ['あ', 'か', 'さ', 'は']
  );
});

test('検索: 名前でも、よみがなでも見つかる', () => {
  assertEqual(find('霊夢'), ['博麗 霊夢']);
  assertEqual(find('れいむ'), ['博麗 霊夢']);
  assertEqual(find('博麗霊夢'), ['博麗 霊夢'], '空白なしでも');
  assertEqual(find('まりさ'), ['霧雨 魔理沙']);
  assertEqual(find('フラン'), ['フランドール・スカーレット']);
  assertEqual(find('ふらん'), ['フランドール・スカーレット'], 'ひらがなでカタカナの名前');
  assertEqual(find('').length, 225, '空なら全員');
  assertEqual(find('ぜったいにいない'), []);
});

test('検索: 順位の数字では見つからない（選ぶ段階では順位を隠すため）', () => {
  assertEqual(find('3'), [], '3位のキャラクターは出ない');
  assertEqual(find('150'), []);
  // 名前に数字が入っているキャラクターは、名前として見つかる
  assertEqual(find('62'), ['C62サークルカットの娘']);
});

// ---- ハードのテスト（全キャラクター・目標150・バースト151・5ターン）----
const HARD = presetRules('hard');

test('ハード: 全キャラクターを使える（最下位も、51位以下も）', () => {
  assertEqual(listUsableCharacters(HARD, sorted).length, 225);
  assertEqual(isCharacterUsable(HARD, byRank(225)), true, '最下位');
  const next = resolveTurn(
    createGameState(players(2), 1, lobbyOf('hard')),
    { A: byRank(51).id, B: byRank(100).id },
    charById
  );
  assertEqual([next.history.t1.A.outcome, next.scores.A.total, next.scores.A.out], ['ok', 51, false]);
  assertEqual([next.scores.B.total, next.scores.B.out], [100, false], '100点でもバーストしない');
});

test('ハード: 5ターンで終了し、150に最も近い人が勝者', () => {
  let state = createGameState(players(2), 1, lobbyOf('hard'));
  for (let turn = 1; turn <= 5; turn++) {
    state = resolveTurn(state, { A: byRank(30).id, B: byRank(20).id }, charById);   // 毎ターン +30 / +20
    assertEqual(isLastReveal(state), turn === 5, `${turn}ターン目`);
    state = advance(state);
  }
  assertEqual(state.status, 'finished');
  assertEqual([state.scores.A.total, state.scores.B.total], [150, 100]);
  assertEqual(judgeResult(state).winners, ['A']);
});

// ---- ノーマルのテスト（1〜50位・目標50・バースト51・5ターン）----------
const NORMAL = presetRules('normal');
const NORMAL_LOBBY = lobbyOf('normal');
const normalList = listUsableCharacters(NORMAL, sorted);              // 画面に出る「ノーマルの一覧」
const findInNormal = (query) => searchCharacters(normalList, query).map((c) => c.name);

test('ノーマル: 使えるのは1〜50位の50人だけ', () => {
  assertEqual(normalList.length, 50);
  assertEqual(normalList.every((c) => c.rank >= 1 && c.rank <= 50), true);
  assertEqual(isCharacterUsable(NORMAL, byRank(50)), true, '50位');
  assertEqual(isCharacterUsable(NORMAL, byRank(51)), false, '51位');
});

test('ノーマル: 一覧は50位以内だけを50音順に並べたもの（順位順ではない）', () => {
  const readings = normalList.map((c) => c.sortKey);
  assertEqual(readings, [...readings].sort(compareKana), '50音順');
  const ranks = normalList.map((c) => c.rank);
  const inRankOrder = JSON.stringify(ranks) === JSON.stringify([...ranks].sort((a, b) => a - b));
  assertEqual(inRankOrder, false, '順位順には並んでいない');
});

test('ノーマル: 名前・よみがなで検索できる。51位以下は検索しても出ない', () => {
  assertEqual(findInNormal('霊夢'), ['博麗 霊夢']);
  assertEqual(findInNormal('れいむ'), ['博麗 霊夢']);
  const below = byRank(51);
  assertEqual(findInNormal(below.name), [], '51位を名前で');
  assertEqual(findInNormal(below.yomi), [], '51位をよみがなで');
  assertEqual(find(below.name), [below.name], 'ハードの一覧では見つかる');
});

test('ノーマル: 49はセーフ、50ちょうどもセーフ、51はバースト', () => {
  const next = resolveTurn(
    stateWithTotals({ A: 47, B: 49, C: 39 }, 1, NORMAL_LOBBY),
    { A: REIMU.id, B: MARISA.id, C: byRank(10).id },   // +3 / +2 / +10
    charById
  );
  assertEqual([next.scores.A.total, next.scores.A.out], [50, false], '50');
  assertEqual([next.scores.B.total, next.scores.B.out], [51, true], '51');
  assertEqual([next.scores.C.total, next.scores.C.out], [49, false], '49');
});

test('ノーマル: 加点は順位そのまま。50位を選ぶと50点（セーフ）、次に1点でも加点されるとバースト', () => {
  let state = resolveTurn(
    createGameState(players(2), 1, NORMAL_LOBBY),
    { A: byRank(50).id, B: byRank(49).id },
    charById
  );
  assertEqual([state.scores.A.total, state.scores.A.out], [50, false]);
  assertEqual([state.scores.B.total, state.scores.B.out], [49, false]);
  assertEqual(pointsFor(NORMAL, byRank(50)), 50);

  state = resolveTurn(advance(state), { A: KOISHI.id, B: MARISA.id }, charById);   // +1 / +2
  assertEqual([state.scores.A.total, state.scores.A.out], [51, true]);
  assertEqual([state.scores.B.total, state.scores.B.out], [51, true]);
});

test('ノーマル: 50に最も近い人が勝者（A50 B49 C45 D52 E49 → Aが勝者、Dはバースト）', () => {
  const result = judgeResult(stateWithTotals({ A: 50, B: 49, C: 45, D: 52, E: 49 }, 5, NORMAL_LOBBY));
  assertEqual(result.winners, ['A']);
  assertEqual(result.ranking.map((p) => p.uid), ['A', 'B', 'E', 'C', 'D'], '並び順');
  assertEqual(result.ranking.map((p) => p.place), [1, 2, 2, 4, null], '順位');
  assertEqual(result.ranking.map((p) => p.diff), [0, 1, 1, 5, null], '50との差');
});

test('ノーマル: 同じ差なら全員が勝者（A49 B48 C49 D51 E40 → AとC）', () => {
  const result = judgeResult(stateWithTotals({ A: 49, B: 48, C: 49, D: 51, E: 40 }, 5, NORMAL_LOBBY));
  assertEqual(result.winners, ['A', 'C']);
  assertEqual(result.ranking.map((p) => p.uid), ['A', 'C', 'B', 'E', 'D'], '並び順');
  assertEqual(result.ranking.map((p) => p.isWinner), [true, true, false, false, false]);
});

test('ノーマル: 重複は全員+0になり、次のターンから使用禁止（ハードと同じ）', () => {
  let state = resolveTurn(
    createGameState(players(3), 1, NORMAL_LOBBY),
    { A: REIMU.id, B: REIMU.id, C: KOISHI.id },
    charById
  );
  assertEqual([state.scores.A.total, state.scores.B.total, state.scores.C.total], [0, 0, 1]);
  assertEqual(isBanned(state, REIMU.id), true);

  state = resolveTurn(advance(state), { A: REIMU.id, B: MARISA.id, C: REMILIA.id }, charById);
  assertEqual(state.history.t2.A.outcome, 'invalid', '使用禁止のキャラは無効');
  assertEqual([state.scores.A.total, state.scores.B.total, state.scores.C.total], [0, 2, 6]);
});

test('ノーマル: 51位以下のキャラクターは、送られてきても無効（+0。重複にも数えない）', () => {
  const below = byRank(51);
  const next = resolveTurn(
    createGameState(players(3), 1, NORMAL_LOBBY),
    { A: below.id, B: below.id, C: KOISHI.id },
    charById
  );
  assertEqual(
    [next.history.t1.A.outcome, next.history.t1.B.outcome, next.history.t1.C.outcome],
    ['invalid', 'invalid', 'ok']
  );
  assertEqual([next.scores.A.total, next.scores.B.total], [0, 0]);
  assertEqual(isBanned(next, below.id), false, '使用禁止にもならない');
});

test('ノーマル: 5ターンで終了し、50に近い人が勝者', () => {
  let state = createGameState(players(2), 1, NORMAL_LOBBY);
  for (let turn = 1; turn <= 5; turn++) {
    assertEqual(state.status, 'playing', `${turn}ターン目`);
    state = resolveTurn(state, { A: KOISHI.id, B: MARISA.id }, charById);   // 毎ターン +1 / +2
    assertEqual(isLastReveal(state), turn === 5, `${turn}ターン目`);
    state = advance(state);
  }
  assertEqual(state.status, 'finished');
  assertEqual([state.scores.A.total, state.scores.B.total], [5, 10]);
  assertEqual(judgeResult(state).winners, ['B']);
});

// ---- オリジナルのテスト（ホストがルールを決める）----------------------
// 依頼の例：目標100・バースト101・7ターン・1〜100位
const CUSTOM = { targetScore: 100, burstScore: 101, maxTurns: 7, minRank: 1, maxRank: 100 };

test('オリジナル: 最初に入っている値は 目標100・バースト101・5ターン・全キャラクター', () => {
  assertEqual(presetRules('original'), { targetScore: 100, burstScore: 101, maxTurns: 5, minRank: 1 });
  assertEqual(lobbyOf('original').rules, presetRules('original'));
});

test('オリジナル: ホストが決めたルールが状態に入り、そのルールでゲームが進む', () => {
  const lobby = originalLobby(CUSTOM);
  assertEqual(lobby.rules, CUSTOM);
  assertEqual(lobby.original, CUSTOM);

  let state = createGameState(players(2), 1, lobby);
  assertEqual([state.mode, modeOf(state).name], ['original', 'オリジナル']);
  assertEqual(rulesOf(state), CUSTOM);

  // 使えるのは1〜100位。101位は送られてきても無効
  assertEqual(listUsableCharacters(rulesOf(state), characters).length, 100);
  state = resolveTurn(state, { A: byRank(100).id, B: byRank(101).id }, charById);
  assertEqual([state.scores.A.total, state.scores.A.out], [100, false], '100ちょうどはセーフ');
  assertEqual(state.history.t1.B.outcome, 'invalid');

  // 101点でバースト
  state = resolveTurn(advance(state), { A: KOISHI.id, B: MARISA.id }, charById);
  assertEqual([state.scores.A.total, state.scores.A.out], [101, true]);

  // 7ターン制：5ターン目では終わらず、7ターン目で終わる
  for (let turn = 3; turn <= 7; turn++) {
    state = resolveTurn(advance(state), { B: MARISA.id }, charById);
    assertEqual(isLastReveal(state), turn === 7, `${turn}ターン目`);
  }
  assertEqual(advance(state).status, 'finished');
});

test('オリジナル: ルールを決められるのは、オリジナルが選ばれている待機中だけ', () => {
  assertEqual(withOriginalRules(lobbyOf('hard'), CUSTOM), undefined, 'ハードが選ばれているとき');
  assertEqual(withOriginalRules(lobbyOf('normal'), CUSTOM), undefined, 'ノーマルが選ばれているとき');
  assertEqual(withOriginalRules(createGameState(players(2), 1, originalLobby(CUSTOM)), { ...CUSTOM, targetScore: 5, burstScore: 6 }), undefined, 'ゲーム中');
  assertEqual(withOriginalRules(lobbyOf('original'), { ...CUSTOM, burstScore: 100 }), undefined, '矛盾したルール');
});

test('オリジナル: 決めたルールは、ほかのモードに変えて戻しても、「もう一度」でも残る', () => {
  const lobby = originalLobby(CUSTOM);
  const toHard = withMode(lobby, 'hard');
  assertEqual(toHard.rules, presetRules('hard'), 'ハードに変えると、ハードのルールになる');
  assertEqual(withMode(toHard, 'original').rules, CUSTOM, 'オリジナルに戻すと、決めたルールに戻る');

  // ゲームが終わって待機画面に戻るとき（room.js の backToLobby と同じ呼び方）
  const finished = createGameState(players(2), 1, lobby);
  const again = createLobbyState(finished.gameNo, finished.mode, finished.original);
  assertEqual([again.mode, again.gameNo], ['original', 1]);
  assertEqual(again.rules, CUSTOM);
});

test('オリジナル: 入力のチェック。依頼の例と、最初に入っている値は問題なし', () => {
  assertEqual(findRuleProblems(CUSTOM, characters), []);
  assertEqual(findRuleProblems({ ...presetRules('original'), maxRank: 225 }, characters), []);
  assertEqual(findRuleProblems({ targetScore: 50, burstScore: 51, maxTurns: 5, minRank: 1, maxRank: 50 }, characters), []);
});

test('オリジナル: バーストする点数は、目標値より大きくないといけない', () => {
  const count = (rules) => findRuleProblems({ ...CUSTOM, ...rules }, characters).length;
  assertEqual(count({ burstScore: 101 }), 0, '目標値 + 1');
  assertEqual(count({ burstScore: 120 }), 0, '目標値より大きければよい');
  assertEqual(count({ burstScore: 100 }), 1, '目標値と同じ');
  assertEqual(count({ burstScore: 99 }), 1, '目標値より小さい');
  assertEqual(count({ burstScore: NaN }), 1, '数字でない');
  assertEqual(isValidRules({ ...CUSTOM, burstScore: 100 }), false);
});

test('オリジナル: 目標値・ターン数・順位の範囲のチェック', () => {
  const count = (rules) => findRuleProblems({ ...CUSTOM, ...rules }, characters).length;
  assertEqual(count({ targetScore: 0, burstScore: 1 }) > 0, true, '目標値 0');
  assertEqual(count({ targetScore: NaN }), 1, '目標値が数字でない');
  assertEqual(count({ targetScore: ORIGINAL_LIMITS.maxTargetScore + 1, burstScore: ORIGINAL_LIMITS.maxTargetScore + 2 }) > 0, true, '目標値が大きすぎる');
  assertEqual(count({ maxTurns: 0 }), 1, 'ターン数 0');
  assertEqual(count({ maxTurns: ORIGINAL_LIMITS.maxTurns }), 0, 'ターン数の上限');
  assertEqual(count({ maxTurns: ORIGINAL_LIMITS.maxTurns + 1 }), 1, 'ターン数が多すぎる');
  assertEqual(count({ maxTurns: 2.5 }), 1, 'ターン数が小数');
  assertEqual(count({ minRank: 0 }), 1, '開始が 0');
  assertEqual(count({ maxRank: 226 }), 1, '終了がデータの最後の順位より大きい');
  assertEqual(count({ maxRank: 225 }), 0, '終了がデータの最後の順位');
  assertEqual(count({ minRank: 60, maxRank: 50 }), 1, '開始が終了より大きい');
});

test('オリジナル: 最後のターンまで選べるだけの人数が必要（5ターンなら9人）', () => {
  assertEqual([neededCharacters(1), neededCharacters(5), neededCharacters(7)], [1, 9, 13]);
  const five = { targetScore: 20, burstScore: 21, maxTurns: 5, minRank: 1 };
  assertEqual(findRuleProblems({ ...five, maxRank: 8 }, characters).length, 1, '8人では足りない');
  assertEqual(findRuleProblems({ ...five, maxRank: 9 }, characters).length, 0, '9人なら足りる');
});

test('オリジナル: 人数は実際に数える（同率順位で、その順位の人がいない範囲は0人）', () => {
  // 195位が2人いるので、196位の人はいない
  assertEqual(characters.filter((c) => c.rank === 196).length, 0);
  const rules = { targetScore: 200, burstScore: 201, maxTurns: 1, minRank: 196, maxRank: 196 };
  assertEqual(findRuleProblems(rules, characters).length, 1);
  assertEqual(findRuleProblems({ ...rules, minRank: 195 }, characters).length, 0, '195〜196位なら2人');
});

test('オリジナル: 順位の開始が1でない範囲（10〜20位）も使える', () => {
  const rules = { targetScore: 60, burstScore: 61, maxTurns: 3, minRank: 10, maxRank: 20 };
  assertEqual(findRuleProblems(rules, characters), []);
  const list = listUsableCharacters(rules, sorted);
  assertEqual(list.length, 11);
  assertEqual(list.every((c) => c.rank >= 10 && c.rank <= 20), true);
  assertEqual([isCharacterUsable(rules, byRank(9)), isCharacterUsable(rules, byRank(10)), isCharacterUsable(rules, byRank(21))], [false, true, false]);
});

test('オリジナル: バーストする点数を目標値より2以上大きくすると、目標値を超えても残れる', () => {
  const lobby = originalLobby({ targetScore: 100, burstScore: 111, maxTurns: 5, minRank: 1, maxRank: 225 });
  const next = resolveTurn(stateWithTotals({ A: 100, B: 100 }, 1, lobby), { A: REMILIA.id, B: byRank(11).id }, charById);
  assertEqual([next.scores.A.total, next.scores.A.out], [105, false], '105は、111未満なのでセーフ');
  assertEqual([next.scores.B.total, next.scores.B.out], [111, true], '111でバースト');

  // 目標値にいちばん近い人が勝ち。98 と 102 は同じ差なので、どちらも勝者
  const result = judgeResult(stateWithTotals({ A: 98, B: 105, C: 102, D: 111 }, 5, lobby));
  assertEqual(result.winners, ['A', 'C']);
  assertEqual(result.ranking.map((p) => p.diff), [2, 2, 5, null]);
});

// ---- バージョンがちがう画面への対応のテスト --------------------------
test('バージョン: 待機中はいつも扱える。ゲーム中は、ルールが入っていれば扱える', () => {
  assertEqual(compatibilityOf(lobbyOf('hard')), 'ok');
  assertEqual(compatibilityOf({ status: 'lobby', gameNo: 0 }), 'ok', '古い形の待機中');
  assertEqual(compatibilityOf(createGameState(players(2), 1, lobbyOf('normal'))), 'ok');
  assertEqual(compatibilityOf(createGameState(players(2), 1, originalLobby(CUSTOM))), 'ok');
});

test('バージョン: 知らないモードや、知らないルールの項目があるゲーム → 再読み込みを求める', () => {
  const state = createGameState(players(2), 1, lobbyOf('hard'));
  assertEqual(compatibilityOf({ ...state, mode: 'extra' }), 'reload', '知らないモード');
  assertEqual(compatibilityOf({ ...state, rules: { ...state.rules, newRule: true } }), 'reload', '知らない項目');
});

test('バージョン: ルールが入っていないゲーム（前のバージョンの画面から開始）→ 続けられない', () => {
  const oldGame = { status: 'playing', gameNo: 1, difficulty: 'hard', turn: 1, phase: 'select', scores: {} };
  assertEqual(compatibilityOf(oldGame), 'broken');
  assertEqual(compatibilityOf({ ...oldGame, status: 'finished' }), 'broken');
});

test('バージョン: 前のバージョンの画面を止めるための印（difficulty）が入っている', () => {
  assertEqual(createLobbyState(0).difficulty, 'reload');
  assertEqual(createGameState(players(2), 1).difficulty, 'reload');
});

// ---- 数字の入力のテスト --------------------------------------------
test('入力: 数字だけの入力を整数にする（全角の数字も読める）', () => {
  assertEqual(parseWholeNumber('100'), 100);
  assertEqual(parseWholeNumber('１００'), 100, '全角');
  assertEqual(parseWholeNumber(' 7 '), 7, '前後の空白');
  assertEqual(parseWholeNumber(225), 225, '数値のまま渡しても同じ');
  for (const text of ['', '1.5', '-3', 'abc', '1e3', '12点']) {
    assertEqual(Number.isNaN(parseWholeNumber(text)), true, `「${text}」`);
  }
});

// ---- 画面への表示 --------------------------------------------------
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;

document.getElementById('summary').textContent =
  failed === 0 ? `すべて成功（${passed}件）` : `${failed}件 失敗 ／ ${passed}件 成功`;
document.getElementById('summary').className = failed === 0 ? 'ok' : 'ng';

const list = document.getElementById('results');
for (const result of results) {
  const item = document.createElement('li');
  item.className = result.ok ? 'ok' : 'ng';
  item.textContent = (result.ok ? '✔ ' : '✘ ') + result.name + (result.ok ? '' : ` … ${result.message}`);
  list.appendChild(item);
}
