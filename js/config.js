// ============================================================
// config.js … ゲームの設定値
//
// ルールの数値を変えたいときは、このファイルだけを書き換えれば
// ゲーム全体に反映されます。
// ============================================================

/**
 * ゲームモードごとの設定。ルールはモードごとに別々に持っています。
 * （ほかのモードの数字を借りたり、「150点のゲーム」を前提にしたりはしていません）
 *
 *   name        … 画面に表示する名前
 *   description … 待機画面のモード選択に出す、ひとことの説明
 *   available   … true なら選べる。false にすると「準備中」と表示され、選べなくなる
 *   custom      … true のモードは、ホストが待機画面でルールを決められる（オリジナル）。
 *                 そのとき下の5つは「最初に入っている値」になる
 *
 *   ---- ルール（この5つで、1つのゲームのルールが決まる）----
 *   targetScore … 目標値
 *   burstScore  … バーストする点数。合計がこの点数「以上」になったらバースト
 *   maxTurns    … ターン数
 *   minRank     … 使えるキャラクターの範囲（人気投票の順位）の「開始」
 *   maxRank     … 使えるキャラクターの範囲の「終了」。
 *                 null にすると「最後の順位まで」（人数はキャラクターデータから自動で決まる）
 *
 * 画面には、ここに書いた順番で並びます。
 * モードを増やすときは、ここに1つ足すだけです。（くわしくは docs/DESIGN.md の「ゲームモード」を参照）
 */
export const GAME_MODES = {
  hard: {
    name: 'ハード',
    description: '150点を目指す',
    available: true,
    targetScore: 150,
    burstScore: 151,
    maxTurns: 5,
    minRank: 1,
    maxRank: null,   // 全キャラクター
  },

  normal: {
    name: 'ノーマル',
    description: '50点を目指す',
    available: true,
    targetScore: 50,
    burstScore: 51,
    maxTurns: 5,
    minRank: 1,
    maxRank: 50,     // 人気投票 1〜50位
  },

  original: {
    name: 'オリジナル',
    description: '自分でルールを設定',
    available: true,
    custom: true,    // ホストが待機画面でルールを決める。下は最初に入っている値
    targetScore: 100,
    burstScore: 101,
    maxTurns: 5,
    minRank: 1,
    maxRank: null,
  },
};

/** ルームを作った直後に選ばれているモード（上の設定の名前で指定する。available が true のものにする） */
export const DEFAULT_MODE = 'hard';

/**
 * オリジナルで設定できる値の上限（入力のチェックに使う）。
 * 下限は、目標値とターン数が 1、バーストする点数が「目標値 + 1」です。
 * 順位の範囲は、キャラクターデータにある順位（1位〜最後の順位）の中で決められます。
 */
export const ORIGINAL_LIMITS = {
  maxTargetScore: 9999,   // 目標値
  maxBurstScore: 10000,   // バーストする点数
  maxTurns: 20,           // ターン数
};

/** 順位のもとになっている人気投票の名前（説明文に使う） */
export const VOTE_NAME = '第22回東方Project人気投票';

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
