// ============================================================
// config.js … ゲームの設定値
//
// ルールの数値を変えたいときは、このファイルだけを書き換えれば
// ゲーム全体に反映されます。
// ============================================================

/** 目標値。これを「超えたら」OUT（ちょうど150はセーフ） */
export const TARGET_SCORE = 150;

/** ターン数 */
export const MAX_TURNS = 5;

/** ゲームを始められる最少人数 */
export const MIN_PLAYERS = 2;

/** 1つのルームに入れる最大人数 */
export const MAX_PLAYERS = 5;

/** ルームIDの文字数 */
export const ROOM_ID_LENGTH = 5;

/**
 * ルームIDに使う文字。
 * 見間違えやすい文字（0とO、1とIとL）は入れていません。
 */
export const ROOM_ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** プレイヤー名の最大文字数 */
export const NAME_MAX_LENGTH = 10;

/** 画面に表示する人気投票の名前（キャラクターの確認欄に「第22回人気投票：3位」のように出る） */
export const POLL_LABEL = '第22回人気投票';

/** キャラクターデータの場所（index.html から見た相対パス） */
export const CHARACTERS_URL = './data/characters.json';
