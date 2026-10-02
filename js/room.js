// ============================================================
// room.js … ルームとゲーム進行の操作
//
// 「ルームを作る」「参加する」「ゲームを始める」「選択を決定する」
// 「結果を計算する」「次のターンへ進む」といった操作をまとめています。
//
//   画面 (main.js) → このファイル → 通信係 (backend) → Firebase
//                         ↓
//                 ルールの計算 (game-logic.js)
//
// 操作が失敗したときは GameError を投げます。
// GameError のメッセージは、そのまま画面に表示してよい日本語です。
// ============================================================

import { backend, myUid } from './backend.js';
import {
  MIN_PLAYERS,
  MAX_PLAYERS,
  ROOM_ID_LENGTH,
  ROOM_ID_CHARS,
  NAME_MAX_LENGTH,
} from './config.js';
import {
  createLobbyState,
  createGameState,
  roundKeyOf,
  isBanned,
  resolveTurn as resolveTurnLogic,
  advance,
} from './game-logic.js';

/** プレイヤーに見せるメッセージを持ったエラー */
export class GameError extends Error {}

// ---- 入力の整形 ----------------------------------------------------

/** 入力されたルームIDを整える（全角→半角、小文字→大文字、記号や空白を除く） */
export function normalizeRoomId(text) {
  return String(text || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_ID_LENGTH);
}

/** 入力されたプレイヤー名を整える（前後の空白を除き、長すぎる分を切る） */
export function cleanName(text) {
  const name = String(text || '').replace(/\s+/g, ' ').trim();
  return Array.from(name).slice(0, NAME_MAX_LENGTH).join('');
}

/** ランダムなルームIDを作る。例: 'A7K3P' */
function generateRoomId() {
  const numbers = crypto.getRandomValues(new Uint32Array(ROOM_ID_LENGTH));
  return Array.from(numbers, (n) => ROOM_ID_CHARS[n % ROOM_ID_CHARS.length]).join('');
}

/** 同じ名前の人がすでにいたら「名前2」「名前3」…にする */
function makeUniqueName(name, usedNames) {
  if (!usedNames.includes(name)) return name;
  for (let number = 2; ; number++) {
    const candidate = `${name}${number}`;
    if (!usedNames.includes(candidate)) return candidate;
  }
}

// ---- ルームの情報を読むための関数 -----------------------------------

/** ルームにいる人を、入室した順に並べた配列にする: [{ uid, name, online }, …] */
export function listPlayers(room) {
  return Object.entries(room.players || {})
    .map(([uid, player]) => ({ uid, ...player }))
    .sort((a, b) => a.joinedAt - b.joinedAt || a.uid.localeCompare(b.uid));
}

/** その人がオンラインか（自分自身は常にオンライン扱い） */
export function isOnline(room, uid) {
  return uid === myUid || room.players?.[uid]?.online === true;
}

/**
 * いま「ホスト」として操作できる人のuidを返す。
 * 基本はルームを作った人。その人が切断しているあいだは、
 * オンラインの人のうち一番先に入室した人が代わりを務める。
 * （ホストのスマホが切れてもゲームが止まらないようにするため）
 */
export function hostUidOf(room) {
  const players = listPlayers(room);
  // ゲーム中は「参加者」の中から選ぶ（観戦者は全員の選択を読めないため）
  const inGame = room.state.status !== 'lobby' && room.state.scores;
  const candidates = inGame ? players.filter((p) => room.state.scores[p.uid]) : players;

  const creator = candidates.find((p) => p.uid === room.hostUid);
  if (creator && isOnline(room, creator.uid)) return creator.uid;

  const deputy = candidates.find((p) => isOnline(room, p.uid)) || players.find((p) => isOnline(room, p.uid));
  return deputy ? deputy.uid : room.hostUid;
}

// ---- ルームの作成・参加・退出 ---------------------------------------

/**
 * ルームを作成して、そのルームIDを返す。
 * 万一IDが他のルームと重なったら、別のIDで作り直す。
 */
export async function createRoom(playerName) {
  const name = cleanName(playerName);
  if (!name) throw new GameError('プレイヤー名を入力してください。');

  for (let attempt = 0; attempt < 5; attempt++) {
    const roomId = generateRoomId();
    const created = await backend.createRoom(roomId, {
      hostUid: myUid,
      createdAt: backend.serverTime(),
      state: createLobbyState(0),
      players: {
        [myUid]: { name, joinedAt: backend.serverTime(), online: true },
      },
    });
    if (created) return roomId;
  }
  throw new GameError('ルームを作成できませんでした。もう一度試してください。');
}

/**
 * ルームに参加する。
 * @returns {Promise<'joined' | 'rejoined'>} 新しく参加した / もともと入っていた（再入室）
 */
export async function joinRoom(roomIdText, playerName) {
  const roomId = normalizeRoomId(roomIdText);
  if (roomId.length !== ROOM_ID_LENGTH) {
    throw new GameError(`ルームIDは${ROOM_ID_LENGTH}文字で入力してください。`);
  }

  const room = await backend.getRoom(roomId);
  if (!room || !room.state) {
    throw new GameError('そのルームIDのルームは見つかりません。IDを確認してください。');
  }

  // すでにこのルームにいる人（リロードした・一度戻った）は、そのまま戻れる
  if (room.players && room.players[myUid]) return 'rejoined';

  if (room.state.status !== 'lobby') {
    throw new GameError('このルームはすでにゲームが始まっています。途中参加はできません。');
  }

  const name = cleanName(playerName);
  if (!name) throw new GameError('プレイヤー名を入力してください。');

  const players = listPlayers(room);
  if (players.filter((p) => p.online).length >= MAX_PLAYERS) {
    throw new GameError(`このルームは満員です（最大${MAX_PLAYERS}人）。`);
  }

  await backend.writeMyPlayer(roomId, {
    name: makeUniqueName(name, players.map((p) => p.name)),
    joinedAt: backend.serverTime(),
    online: true,
  });
  return 'joined';
}

/**
 * ルームから退出する。
 * 待機中なら名簿から消える。ゲーム中は「オフライン」になるだけで、
 * 同じルームIDを入力すれば戻れる。
 */
export async function leaveRoom(roomId, room) {
  const inLobby = room?.state?.status === 'lobby';
  await backend.stopPresence(!inLobby);
  if (inLobby) await backend.writeMyPlayer(roomId, null);
}

// ---- ゲームの進行 ---------------------------------------------------

/** いまゲームを開始したら参加することになる人（オンラインの人を入室順に、最大人数まで） */
export function startCandidates(room) {
  return listPlayers(room)
    .filter((p) => isOnline(room, p.uid))
    .slice(0, MAX_PLAYERS);
}

/** ゲームを開始する（ホストの操作） */
export async function startGame(roomId, room) {
  const participants = startCandidates(room);
  if (participants.length < MIN_PLAYERS) {
    throw new GameError(`${MIN_PLAYERS}人以上そろってから開始してください。`);
  }
  await backend.updateState(roomId, (state) => {
    if (state.status !== 'lobby') return undefined;   // すでに開始済み
    return createGameState(participants, (state.gameNo || 0) + 1);
  });
}

/**
 * 自分の選択を決定する。送ったあとは変更できない。
 * 他の人には「決定した」ことだけが伝わり、誰を選んだかは伝わらない。
 */
export async function submitPick(roomId, room, charId, charById) {
  const state = room.state;
  const me = state.scores?.[myUid];
  const roundKey = roundKeyOf(state);

  if (state.status !== 'playing' || state.phase !== 'select') {
    throw new GameError('いまは選択できません。');
  }
  if (!me) throw new GameError('このゲームには参加していません。');
  if (me.out) throw new GameError('OUTになったため、選択できません。');
  if (!charById.has(charId)) throw new GameError('キャラクターを選択してください。');
  if (isBanned(state, charId)) {
    throw new GameError('このキャラクターは重複したため、使用禁止です。');
  }
  if (room.submitted?.[roundKey]?.[myUid]) {
    throw new GameError('このターンはすでに決定済みです。');
  }

  await backend.submitPick(roomId, roundKey, charId);
}

/**
 * このターンの結果を計算して公開する。
 *
 * 全員の選択を読み、game-logic.js の resolveTurn で計算した結果を書き込む。
 * 複数の端末が同時にこの関数を呼んでも、最初の1回だけが反映される
 * （2回目以降は「もう選択フェーズではない」ので何もしない）。
 *
 * まだ決定していない人がいる状態で呼ぶと、その人は「未選択(+0)」になる。
 */
export async function resolveTurn(roomId, room, charById) {
  const roundKey = roundKeyOf(room.state);
  const picks = await backend.readPicks(roomId, roundKey);
  return backend.updateState(roomId, (state) => {
    const stillSelecting =
      state.status === 'playing' && state.phase === 'select' && roundKeyOf(state) === roundKey;
    if (!stillSelecting) return undefined;
    return resolveTurnLogic(state, picks, charById);
  });
}

/** 結果公開のあと、次のターン（または最終結果）へ進む（ホストの操作） */
export async function goNext(roomId, room) {
  const roundKey = roundKeyOf(room.state);
  return backend.updateState(roomId, (state) => {
    const stillRevealing =
      state.status === 'playing' && state.phase === 'reveal' && roundKeyOf(state) === roundKey;
    if (!stillRevealing) return undefined;
    return advance(state);
  });
}

/** 最終結果のあと、同じルームの待機画面に戻る（ホストの操作） */
export async function backToLobby(roomId) {
  return backend.updateState(roomId, (state) => {
    if (state.status !== 'finished') return undefined;
    return createLobbyState(state.gameNo);
  });
}
