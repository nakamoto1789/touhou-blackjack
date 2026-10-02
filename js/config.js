// ============================================================
// config.js … ゲームの設定値
//
// ルールの数値を変えたいときは、このファイルだけを書き換えれば
// ゲーム全体に反映されます。
// ============================================================

/**
 * 難易度ごとの設定。ルールは難易度ごとに別々に持っています。
 *
 * いま遊べるのは Hard と Lunatic です。
 * Easy / Normal は、ルールが決まったら
 *   1. available を true にする
 *   2. 下の3つ（targetScore / maxTurns / maxCharacterRank）を書く
 * だけで選べるようになります。（くわしくは docs/DESIGN.md の「難易度」を参照）
 *
 *   label            … 画面に表示する名前
 *   available        … true なら選べる。false のあいだは「Coming Soon」と表示される
 *   targetScore      … 目標値。これを「超えたら」OUT（ちょうどはセーフ）
 *   maxTurns         … ターン数
 *   maxCharacterRank … 使えるキャラクターの範囲。50 なら「人気投票50位以内」だけ。
 *                       null なら制限なし（全キャラクター）
 *
 * 画面には、ここに書いた順番で並びます。
 */
export const DIFFICULTY_SETTINGS = {
  easy: {
    label: 'Easy',
    available: false,
    // 今後設定
  },

  normal: {
    label: 'Normal',
    available: false,
    // 今後設定
  },

  hard: {
    label: 'Hard',
    available: true,
    targetScore: 21,
    maxTurns: 5,
    maxCharacterRank: 50,
  },

  lunatic: {
    label: 'Lunatic',
    available: true,
    targetScore: 150,
    maxTurns: 5,
    maxCharacterRank: null,
  },
};

/** ルームを作った直後に選ばれている難易度（上の設定の名前で指定する） */
export const DEFAULT_DIFFICULTY = 'lunatic';

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

/** プレイヤー名のデフォルト値（入力欄に最初から入っていて、空欄のまま進んだときにも使われる） */
export const DEFAULT_PLAYER_NAME = '霊夢';

/** キャラクターデータの場所（index.html から見た相対パス） */
export const CHARACTERS_URL = './data/characters.json';
