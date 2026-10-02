// ============================================================
// backend.js … 「通信係」を選ぶ
//
// このゲームは、データの保存・同期を行う「通信係（backend）」を
// 2種類持っています。どちらも同じ名前の関数を持っているので、
// ゲーム側のコードは通信係の中身を気にせずに使えます。
//
//   backend-firebase.js … 本番用。Firebase を使い、別々のスマホ同士で遊べる
//   backend-local.js    … お試し用。同じブラウザの別タブ同士でだけ遊べる
//
// ---- 通信係が持っている関数（両方のファイルで共通）----
//   init()                              準備をして、自分のID(uid)を返す
//   storage                             ルームIDなどを覚えておく保存場所
//   serverTime()                        「現在時刻」として保存する値
//   onConnectionChange(callback)        接続／切断を知らせてもらう
//   getRoom(roomId)                     ルームを1回だけ読む
//   watchRoom(roomId, onChange, onError)ルームの変化を受け取り続ける
//   createRoom(roomId, room)            ルームを作る（すでにあれば false）
//   writeMyPlayer(roomId, player)       自分のプレイヤー情報を書く（null で削除）
//   startPresence(roomId)               「オンライン」の印をつけ始める
//   stopPresence(markOffline)           それをやめる
//   updateState(roomId, updater)        ゲーム状態を安全に書き換える
//   submitPick(roomId, roundKey, id)    自分の選択を送る（やり直し不可）
//   readPicks(roomId, roundKey)         全員の選択を読む（自分が決定した後だけ）
//   readMyPick(roomId, roundKey)        自分の選択を読む
//   describeError(error)                エラーを日本語の説明にする
// ============================================================

import { firebaseConfig } from './firebase-config.js';

const params = new URLSearchParams(window.location.search);

/**
 * お試しモードかどうか。
 * ・firebase-config.js が未設定のとき
 * ・URLの末尾に ?demo をつけたとき（設定済みでもお試しモードで開ける）
 */
export const isDemoMode = !firebaseConfig.apiKey || params.has('demo');

/** 選ばれた通信係。initBackend() のあとで使えるようになる */
export let backend = null;

/** 自分のID。initBackend() のあとで使えるようになる */
export let myUid = null;

export async function initBackend() {
  // 必要な方だけを読み込む（お試しモードでは Firebase を読み込まない）
  backend = isDemoMode
    ? await import('./backend-local.js')
    : await import('./backend-firebase.js');
  myUid = await backend.init();
  return myUid;
}
