// ============================================================
// game-logic.test.js … ゲームルールのテスト
//
// tests/index.html をブラウザで開くと実行され、結果が画面に表示されます。
// ルール（game-logic.js）を書き換えたら、ここで壊れていないか確認できます。
// ============================================================

import { TARGET_SCORE, MAX_TURNS } from '../js/config.js';
import {
  createGameState,
  createLobbyState,
  roundKeyOf,
  isBanned,
  activeUids,
  allActiveSubmitted,
  resolveTurn,
  isLastReveal,
  advance,
  judgeResult,
} from '../js/game-logic.js';

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

const KOISHI = byName('古明地 こいし');   // 1位
const MARISA = byName('霧雨 魔理沙');     // 2位
const REIMU = byName('博麗 霊夢');        // 3位
const REMILIA = byName('レミリア・スカーレット'); // 5位

/** n人の参加者を作る: A, B, C … */
function players(n) {
  return 'ABCDE'.slice(0, n).split('').map((uid) => ({ uid, name: `プレイヤー${uid}` }));
}

/** 合計点を直接指定した状態を作る（テストを短く書くため） */
function stateWithTotals(totals, turn = 1) {
  const state = createGameState(players(Object.keys(totals).length), 1);
  state.turn = turn;
  for (const [uid, total] of Object.entries(totals)) {
    state.scores[uid].total = total;
    state.scores[uid].out = total > TARGET_SCORE;
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

// ---- OUT のテスト --------------------------------------------------
test('OUT: ちょうど150はセーフ', () => {
  const next = resolveTurn(stateWithTotals({ A: 147, B: 0 }), { A: REIMU.id, B: KOISHI.id }, charById);
  assertEqual(next.scores.A.total, 150);
  assertEqual(next.scores.A.out, false);
});

test('OUT: 151はOUT', () => {
  const next = resolveTurn(stateWithTotals({ A: 148, B: 0 }), { A: REIMU.id, B: KOISHI.id }, charById);
  assertEqual(next.scores.A.total, 151);
  assertEqual(next.scores.A.out, true);
  assertEqual(next.history.t1.A.out, true);
});

test('OUT: 重複で+0なら、150を超えるはずの選択でもOUTにならない', () => {
  const big = characters.find((c) => c.rank === 100);
  const next = resolveTurn(stateWithTotals({ A: 100, B: 100 }), { A: big.id, B: big.id }, charById);
  assertEqual([next.scores.A.out, next.scores.B.out], [false, false]);
  assertEqual([next.scores.A.total, next.scores.B.total], [100, 100]);
});

test('OUT: OUTの人は選択する人に含まれず、点数も変わらない', () => {
  const state = stateWithTotals({ A: 153, B: 10, C: 20 }, 3);
  assertEqual(activeUids(state), ['B', 'C']);
  // OUTのAが（不正に）選択を送ってきても無視される
  const next = resolveTurn(state, { A: KOISHI.id, B: KOISHI.id, C: REIMU.id }, charById);
  assertEqual(next.scores.A.total, 153);
  assertEqual(next.history.t3.A, undefined, 'OUTの人の結果は作られない');
  assertEqual(next.history.t3.B.outcome, 'ok', 'OUTの人の選択は重複判定に含めない');
});

test('決定待ち: OUTの人を除いた全員が決定したら「全員完了」', () => {
  const state = stateWithTotals({ A: 153, B: 10, C: 20 });
  assertEqual(allActiveSubmitted(state, { B: true }), false);
  assertEqual(allActiveSubmitted(state, { B: true, C: true }), true);
  assertEqual(allActiveSubmitted(state, undefined), false);
});

// ---- ターン進行のテスト --------------------------------------------
test('進行: 5ターン目の公開が終わるとゲーム終了', () => {
  let state = createGameState(players(2), 1);
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    assertEqual(state.turn, turn);
    assertEqual(state.status, 'playing');
    state = resolveTurn(state, { A: KOISHI.id, B: MARISA.id }, charById);
    assertEqual(isLastReveal(state), turn === MAX_TURNS, `${turn}ターン目`);
    state = advance(state);
  }
  assertEqual(state.status, 'finished');
  assertEqual(state.scores.A.total, 5);
  assertEqual(state.scores.B.total, 10);
});

test('進行: 全員OUTになったら、5ターン目を待たずに終了', () => {
  const over = characters.find((c) => c.rank === 200);
  const other = characters.find((c) => c.rank === 201);
  let state = resolveTurn(createGameState(players(2), 1), { A: over.id, B: other.id }, charById);
  assertEqual(isLastReveal(state), true);
  state = advance(state);
  assertEqual(state.status, 'finished');
});

test('進行: 待機状態は lobby', () => {
  assertEqual(createLobbyState(2), { status: 'lobby', gameNo: 2 });
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

test('結果: 全員OUTなら勝者なし', () => {
  const result = judgeResult(stateWithTotals({ A: 151, B: 200 }));
  assertEqual(result.winners, []);
  assertEqual(result.ranking.every((p) => p.out && p.place === null), true);
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
