// ============================================================
// backend-local.js … お試し用の通信係（Firebase なしで動く）
//
// データをブラウザの localStorage に保存し、同じブラウザの
// 「別のタブ」同士で同期します。Firebase の設定をする前に、
// 1台のPCでタブを複数開いて、ゲームの流れを確認するためのものです。
//
// ・タブ1つ = プレイヤー1人（タブごとに別のIDを持つ）
// ・別の端末（スマホ同士など）とは同期しません
//
// backend-firebase.js と同じ名前・同じ動きの関数をそろえています。
// ============================================================

const KEY_PREFIX = 'thbj-demo/';

let uid = null;
const watchers = new Map();   // ルームID → 変化を知らせる関数の集まり

/** ルームIDなどを覚えておく場所（タブごとに別々。タブを閉じると消える） */
export const storage = window.sessionStorage;

// ---- localStorage の読み書き ---------------------------------------
function load(key) {
  const text = window.localStorage.getItem(KEY_PREFIX + key);
  return text ? JSON.parse(text) : null;
}

/**
 * Firebase は「null」や「空のオブジェクト {}」を保存しません（消えます）。
 * お試しモードでも同じ動きになるよう、保存前に取り除きます。
 */
function prune(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = prune(child);
    if (pruned !== undefined) result[key] = pruned;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function save(key, value) {
  const pruned = prune(value);
  if (pruned === undefined) {
    window.localStorage.removeItem(KEY_PREFIX + key);
  } else {
    window.localStorage.setItem(KEY_PREFIX + key, JSON.stringify(pruned));
  }
}

function saveRoom(roomId, room) {
  save(`rooms/${roomId}`, room);
  notify(roomId);
}

/** このタブで見ている人に、ルームの最新の値を知らせる */
function notify(roomId) {
  const callbacks = watchers.get(roomId);
  if (!callbacks) return;
  const room = load(`rooms/${roomId}`);
  for (const callback of callbacks) callback(room);
}

// 他のタブが localStorage を書き換えると、このイベントが届く
window.addEventListener('storage', (event) => {
  const roomPrefix = `${KEY_PREFIX}rooms/`;
  if (event.key && event.key.startsWith(roomPrefix)) {
    notify(event.key.slice(roomPrefix.length));
  }
});

function permissionDenied() {
  const error = new Error('PERMISSION_DENIED');
  error.code = 'PERMISSION_DENIED';
  return error;
}

// ---- 通信係の関数 ---------------------------------------------------

/** 準備をして、自分のID(uid)を返す。タブごとに別のIDになる */
export async function init() {
  uid = storage.getItem('thbj-demo-uid');
  if (!uid) {
    uid = 'demo-' + Math.random().toString(36).slice(2, 10);
    storage.setItem('thbj-demo-uid', uid);
  }
  return uid;
}

export function serverTime() {
  return Date.now();
}

/** お試しモードは常に「接続中」 */
export function onConnectionChange(callback) {
  callback(true);
  return () => {};
}

export async function getRoom(roomId) {
  return load(`rooms/${roomId}`);
}

export function watchRoom(roomId, onChange) {
  if (!watchers.has(roomId)) watchers.set(roomId, new Set());
  watchers.get(roomId).add(onChange);
  // Firebase と同じく、最初に現在の値を1回知らせる
  queueMicrotask(() => {
    if (watchers.get(roomId)?.has(onChange)) onChange(load(`rooms/${roomId}`));
  });
  return () => watchers.get(roomId)?.delete(onChange);
}

export async function createRoom(roomId, room) {
  if (load(`rooms/${roomId}`)) return false;
  saveRoom(roomId, room);
  return true;
}

export async function writeMyPlayer(roomId, player) {
  const room = load(`rooms/${roomId}`);
  if (!room) throw permissionDenied();
  const exists = Boolean(room.players && room.players[uid]);
  // Firebase のルールと同じ：ゲーム開始後は新しく参加できない
  if (!exists && room.state.status !== 'lobby') throw permissionDenied();
  room.players = room.players || {};
  if (player === null) {
    delete room.players[uid];
  } else {
    room.players[uid] = player;
  }
  saveRoom(roomId, room);
}

// ---- オンライン表示（プレゼンス）--------------------------------
let presenceRoomId = null;

function setOnline(value) {
  if (!presenceRoomId) return;
  const room = load(`rooms/${presenceRoomId}`);
  if (!room || !room.players || !room.players[uid]) return;
  if (room.players[uid].online === value) return;
  room.players[uid].online = value;
  saveRoom(presenceRoomId, room);
}

export function startPresence(roomId) {
  presenceRoomId = roomId;
  setOnline(true);
}

export async function stopPresence(markOffline) {
  if (markOffline) setOnline(false);
  presenceRoomId = null;
}

// タブを閉じる・リロードするときに「オフライン」にする
window.addEventListener('pagehide', () => setOnline(false));
window.addEventListener('pageshow', () => setOnline(true));

export async function updateState(roomId, updater) {
  const room = load(`rooms/${roomId}`);
  if (!room || !room.state) return false;
  if (!room.players || !room.players[uid]) throw permissionDenied();
  const next = updater(structuredClone(room.state));
  if (next === undefined) return false;   // 何もしない（中止）
  room.state = next;
  saveRoom(roomId, room);
  return true;
}

export async function submitPick(roomId, roundKey, charId) {
  const room = load(`rooms/${roomId}`);
  const me = room?.state?.scores?.[uid];
  const picks = load(`picks/${roomId}`) || {};
  const round = picks[roundKey] || {};
  // Firebase のルールと同じ：参加者で、OUTでなく、まだ送っていないときだけ書ける
  if (!me || me.out !== false || round[uid] !== undefined) throw permissionDenied();

  round[uid] = charId;
  picks[roundKey] = round;
  save(`picks/${roomId}`, picks);

  room.submitted = room.submitted || {};
  room.submitted[roundKey] = room.submitted[roundKey] || {};
  room.submitted[roundKey][uid] = true;
  saveRoom(roomId, room);
}

export async function readPicks(roomId, roundKey) {
  const room = load(`rooms/${roomId}`);
  const round = (load(`picks/${roomId}`) || {})[roundKey] || {};
  // Firebase のルールと同じ：自分が決定済み、またはOUTの人だけ読める
  const iAmOut = room?.state?.scores?.[uid]?.out === true;
  if (round[uid] === undefined && !iAmOut) throw permissionDenied();
  return round;
}

export async function readMyPick(roomId, roundKey) {
  const round = (load(`picks/${roomId}`) || {})[roundKey] || {};
  return round[uid] ?? null;
}

export function describeError(error) {
  if (error?.code === 'PERMISSION_DENIED') return 'その操作は許可されていません。';
  return String(error?.message || error);
}
