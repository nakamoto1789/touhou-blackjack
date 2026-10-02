// ============================================================
// backend-firebase.js … 本番用の通信係（Firebase）
//
// 使っている Firebase の機能は2つだけです。
//   ・Authentication（匿名認証）… 端末ごとに「自分のID(uid)」をもらう
//   ・Realtime Database        … データを保存し、変化を全員に即座に届ける
//
// ---- データベースの中身 ----
//   rooms/{ルームID}/
//     hostUid      ルームを作った人のuid
//     createdAt    作成日時
//     players/{uid}: { name, joinedAt, online }   ルームにいる人
//     state:       ゲームの状態（game-logic.js の説明を参照）
//     submitted/{ラウンド}/{uid}: true            「決定した」という印（全員に見える）
//   picks/{ルームID}/{ラウンド}/{uid}: キャラid    選んだキャラ（★秘密★）
//
// picks を rooms の外に置いているのは、読める人を別々に決めるためです。
// （database.rules.json で「自分が決定した後でないと読めない」と決めている）
// ============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  onDisconnect,
  runTransaction,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js';

import { firebaseConfig } from './firebase-config.js';

let db = null;
let uid = null;

/** ルームIDなどを覚えておく場所（ブラウザを閉じても残る） */
export const storage = window.localStorage;

/** 準備をして、自分のID(uid)を返す */
export async function init() {
  if (!firebaseConfig.databaseURL) {
    throw new Error(
      'firebase-config.js に databaseURL がありません。Firebase コンソールで Realtime Database を作成し、表示されたURLを貼り付けてください。'
    );
  }
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);

  // 匿名認証：名前やメールアドレスなしで、端末ごとのIDをもらう。
  // 一度もらったIDはブラウザに保存されるので、リロードしても同じ人として扱われる。
  const credential = await signInAnonymously(getAuth(app));
  uid = credential.user.uid;
  return uid;
}

/** 「現在時刻」として保存する値（Firebaseのサーバーが時刻に置き換える） */
export function serverTime() {
  return serverTimestamp();
}

/** 接続／切断を知らせてもらう。callback(true) = つながった */
export function onConnectionChange(callback) {
  return onValue(ref(db, '.info/connected'), (snapshot) => callback(snapshot.val() === true));
}

/** ルームを1回だけ読む（無ければ null） */
export async function getRoom(roomId) {
  const snapshot = await get(ref(db, `rooms/${roomId}`));
  return snapshot.exists() ? snapshot.val() : null;
}

/**
 * ルームの変化を受け取り続ける。
 * 誰かがデータを書き換えるたびに onChange(room) が呼ばれる。
 * @returns {Function} 呼ぶと受け取りをやめる関数
 */
export function watchRoom(roomId, onChange, onError) {
  return onValue(ref(db, `rooms/${roomId}`), (snapshot) => onChange(snapshot.val()), onError);
}

/** ルームを作る。同じIDのルームがすでにあれば false */
export async function createRoom(roomId, room) {
  const roomRef = ref(db, `rooms/${roomId}`);
  if ((await get(roomRef)).exists()) return false;
  await set(roomRef, room);
  return true;
}

/** 自分のプレイヤー情報を書く。player が null なら削除（退出） */
export async function writeMyPlayer(roomId, player) {
  const playerRef = ref(db, `rooms/${roomId}/players/${uid}`);
  if (player === null) {
    await remove(playerRef);
  } else {
    await set(playerRef, player);
  }
}

// ---- オンライン表示（プレゼンス）--------------------------------
let presence = null;   // { onlineRef, stopWatching }

/**
 * 「オンライン」の印をつけ始める。
 * onDisconnect は「接続が切れたら、サーバー側でこの値を書いてね」という予約。
 * これにより、ブラウザを閉じたり電波が切れたりしても online が false になる。
 */
export function startPresence(roomId) {
  if (presence) presence.stopWatching();
  const onlineRef = ref(db, `rooms/${roomId}/players/${uid}/online`);
  let connected = false;

  // 「切れたら false にする」予約をしてから、「オンライン」の印をつける
  const markOnline = () => {
    onDisconnect(onlineRef)
      .set(false)
      .then(() => set(onlineRef, true))
      .catch((error) => console.warn('オンライン表示の更新に失敗', error));
  };

  // つながるたび（再接続のたび）に印をつけ直す
  const stopWatchingConnection = onValue(ref(db, '.info/connected'), (snapshot) => {
    connected = snapshot.val() === true;
    if (connected) markOnline();
  });

  // 電波が急に切れて、つなぎ直したとき：古い接続の予約が遅れて実行され、
  // つながっているのに false にされることがある。そのときは、すぐ true に戻す。
  const stopWatchingFlag = onValue(onlineRef, (snapshot) => {
    if (snapshot.val() === false && connected) markOnline();
  });

  presence = {
    onlineRef,
    stopWatching: () => {
      stopWatchingConnection();
      stopWatchingFlag();
    },
  };
}

/** オンライン表示をやめる。markOffline が true なら「オフライン」と書き残す */
export async function stopPresence(markOffline) {
  if (!presence) return;
  const { onlineRef, stopWatching } = presence;
  presence = null;
  stopWatching();
  try {
    await onDisconnect(onlineRef).cancel();
    if (markOffline) await set(onlineRef, false);
  } catch (error) {
    console.warn('オンライン表示の解除に失敗', error);
  }
}

/**
 * ゲーム状態(state)を安全に書き換える。
 *
 * 「読む → 計算する → 書く」の間に他の人が書き換えていたら、Firebaseが
 * 自動で最新の値からやり直してくれる仕組み（トランザクション）を使う。
 * これにより、2人が同時に「結果を計算」しても二重に加点されない。
 *
 * @param {Function} updater 現在の state を受け取り、新しい state を返す関数。
 *                           何もしないとき（もう処理済みなど）は undefined を返す。
 * @returns {Promise<boolean>} 書き換えたら true
 */
export async function updateState(roomId, updater) {
  const result = await runTransaction(ref(db, `rooms/${roomId}/state`), (state) => {
    if (state === null) return undefined;   // まだ読み込めていない → 何もしない
    return updater(state);
  });
  return result.committed;
}

/**
 * 自分の選択を送る。
 * 「選んだキャラ（秘密）」と「決定したという印（公開）」を同時に書き込む。
 * どちらか片方だけが書かれることはない。
 */
export async function submitPick(roomId, roundKey, charId) {
  await update(ref(db), {
    [`picks/${roomId}/${roundKey}/${uid}`]: charId,
    [`rooms/${roomId}/submitted/${roundKey}/${uid}`]: true,
  });
}

/** そのラウンドの全員の選択を読む（自分が決定した後、またはOUTの人だけ読める） */
export async function readPicks(roomId, roundKey) {
  const snapshot = await get(ref(db, `picks/${roomId}/${roundKey}`));
  return snapshot.val() || {};
}

/** 自分の選択を読む（リロード後に表示を戻すため）。無ければ null */
export async function readMyPick(roomId, roundKey) {
  const snapshot = await get(ref(db, `picks/${roomId}/${roundKey}/${uid}`));
  return snapshot.val();
}

/** エラーを、画面に出せる日本語の説明にする */
export function describeError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error);
  if (/auth\/(configuration-not-found|admin-restricted-operation|operation-not-allowed)/.test(code)) {
    return 'Firebase の「匿名認証」が有効になっていません。README の「Firebase の準備」を確認してください。';
  }
  if (/auth\/(api-key-not-valid|invalid-api-key)/.test(code)) {
    return 'firebase-config.js の apiKey が正しくありません。';
  }
  if (/network/i.test(code) || /network/i.test(message)) {
    return 'ネットワークに接続できません。電波の良いところでもう一度試してください。';
  }
  if (/permission[_ ]denied/i.test(code) || /permission[_ ]denied/i.test(message)) {
    return 'データへのアクセスが許可されませんでした。（Firebase のセキュリティルールを確認してください）';
  }
  return message;
}
