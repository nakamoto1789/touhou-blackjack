// ============================================================
// sound.js … 効果音を鳴らす
//
// しくみ:
//   ・ブラウザに入っている「Web Audio API」（音を作ったり鳴らしたりする仕組み）を使う。
//     音のファイル（mp3）は最初に1回だけ読み込み、すぐ鳴らせる形（AudioBuffer）にしておく。
//   ・スマホのブラウザは、画面を1回さわるまで音を出せない決まりになっている。
//     そのため、最初にさわったとき（「参加する」を押したときなど）に音を使えるようにする。
//   ・音の大きさ（0〜100）は、この端末だけに覚えさせる（ルームのデータには書かない）。
//   ・iPhone では、消音スイッチ（マナーモード）がオンのときは鳴らない（この方式の音は消音スイッチに従う）。
//
// どの音を、どのファイルで鳴らすかは config.js の SOUNDS で決める。
// ファイルが見つからないときは、その音だけが鳴らない（ゲームはそのまま続けられる）。
// ============================================================

import { SOUNDS, SOUND_DIR, DEFAULT_VOLUME } from './config.js';

const STORAGE_VOLUME = 'thbj-volume';   // この端末の音の大きさ（0〜100）

let storage = null;              // 設定を覚えておく場所（backend.storage）
let context = null;              // AudioContext（音を鳴らす装置）。最初にさわったときに作る
let master = null;               // 全部の音の大きさをまとめて変えるつまみ（GainNode）
let volume = DEFAULT_VOLUME;     // 音の大きさ（0〜100）
const buffers = new Map();       // 効果音の名前 → 読み込んだ音（AudioBuffer）
let loading = null;              // 全部の音の読み込みが終わると完了する Promise
const scheduled = new Set();     // 鳴っている音・鳴る予定の音を取り消す関数（音の装置が止まったときに、まとめて取り消すため）

// 読み込みや音の装置の再開を待って鳴らすときに、これより遅れたら鳴らさない（秒）。場面とずれた音は、ないほうがよいため
const MAX_LATE_S = 2;

/**
 * 起動時に1回だけ呼ぶ。保存してある音の大きさを読み、
 * 「画面を最初にさわったら音を使えるようにする」準備をする。
 */
export function initSound(store) {
  storage = store;
  const saved = storage.getItem(STORAGE_VOLUME);
  if (saved !== null && Number.isFinite(Number(saved))) volume = clampVolume(Number(saved));

  // capture: true … ボタンの処理より先に呼ばれるようにする（ボタンを押した瞬間に音が使えるように）
  // 一度音を使えるようにしたあとも、スマホが音を止めていたら、さわったときに再開する
  for (const type of ['pointerdown', 'touchend', 'keydown']) {
    document.addEventListener(type, unlockSound, { capture: true, passive: true });
  }

  // 別のアプリから戻ってきたとき：止められていた音の装置を、さわる前に動かせるなら動かしておく
  // （ブラウザによっては、画面をさわるまで動かせない。そのときは、さわったときに unlockSound が動かす）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && context && context.state !== 'running') {
      context.resume().catch(() => {});
    }
  });
}

/** 画面をさわったときに呼ばれる。音を鳴らす装置を作り（1回目だけ）、止まっていたら動かす */
function unlockSound() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;   // 音を鳴らせないブラウザ（何もしない）

  if (!context) {
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.value = gainOf(volume);
    master.connect(context.destination);

    // 古いiPhoneは「さわった瞬間に何か1つ鳴らす」と音が使えるようになるので、無音を一瞬だけ鳴らす
    const silence = context.createBufferSource();
    silence.buffer = context.createBuffer(1, 1, 22050);
    silence.connect(context.destination);
    silence.start(0);

    // 音の装置が止められたとき（スマホで別のアプリに切り替えた・画面を消した・電話が来たなど）は、
    // 鳴る予定だった音を取り消す。止まっている間も予定は残るので、そのままだと、
    // あとで動き出した瞬間（次に画面をさわったときなど）に、場面と関係なく鳴ってしまう
    context.onstatechange = () => {
      if (context.state === 'running') return;
      for (const cancel of scheduled) cancel();
    };

    loading = loadAllSounds();
  }
  if (context.state !== 'running') context.resume().catch(() => {});
}

/** config.js の SOUNDS に書いた音を、全部読み込んでおく */
async function loadAllSounds() {
  await Promise.all(
    Object.entries(SOUNDS).map(async ([name, sound]) => {
      try {
        const response = await fetch(SOUND_DIR + sound.file);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        buffers.set(name, await decode(data));
      } catch (error) {
        console.warn(`効果音「${sound.file}」を読み込めませんでした。sounds フォルダにあるか確かめてください。`, error);
      }
    })
  );
}

/** mp3 のデータを、鳴らせる形（AudioBuffer）にする（古いSafariでも動く書き方） */
function decode(data) {
  return new Promise((resolve, reject) => context.decodeAudioData(data, resolve, reject));
}

/**
 * 効果音を鳴らす。
 * 次のときは、待ってから鳴らす。ただし MAX_LATE_S 秒以上遅れるなら鳴らさない（場面とずれるため）。
 *   ・音の読み込みがまだ終わっていない（リロード直後の最初のタップのすぐあとなど）
 *   ・音の装置が止められている（スマホで別のアプリから戻ってきた直後など）
 * @param {string} name   config.js の SOUNDS の名前（'reveal' など）
 * @param {object} [options]
 * @param {number} [options.delay] 何秒後に鳴らすか（画面の演出に合わせるため）
 * @returns {{ stop: () => void } | null} 途中で止めるための道具（鳴らせなかったときは null）
 */
export function playSound(name, { delay = 0 } = {}) {
  // どの場面で、どの音を鳴らそうとしたかを記録する（開発者ツールのコンソールで確かめられる）
  console.debug(`効果音：${name}（${delay}秒後）`);

  // まだ画面をさわっていない・音の大きさが0 のときは鳴らさない
  if (!context || !SOUNDS[name] || volume === 0) return null;

  const requestedAt = performance.now();
  let cancel = null;       // 鳴り始めたあと（鳴る予定に入れたあと）に止める関数
  let stopped = false;     // 鳴る予定に入れる前に「止めて」と言われたか

  const start = () => {
    const buffer = buffers.get(name);
    if (stopped || !buffer) return;              // 止められた・ファイルがない
    if (context.state !== 'running') return;     // 音の装置が止まったまま（あとで動き出したときに、遅れて鳴らないように）
    const late = (performance.now() - requestedAt) / 1000;   // 待ったせいで遅れた秒数
    if (late > MAX_LATE_S) return;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = Boolean(SOUNDS[name].loop);
    const gain = context.createGain();   // この音だけの大きさ
    gain.gain.value = SOUNDS[name].volume ?? 1;
    source.connect(gain);
    gain.connect(master);
    source.start(context.currentTime + Math.max(0, delay - late));

    // すっと小さくしてから止める（いきなり止めると「プツッ」と音が出るため）
    cancel = () => {
      scheduled.delete(cancel);
      const now = context.currentTime;
      gain.gain.setTargetAtTime(0, now, 0.05);
      try {
        source.stop(now + 0.3);
      } catch {
        // すでに止まっているときは何もしない
      }
    };
    scheduled.add(cancel);
    source.onended = () => scheduled.delete(cancel);   // 鳴り終わったら、取り消す対象から外す
  };

  // 鳴らす前に待つもの：音の読み込み・止められている音の装置の再開
  const waits = [];
  if (!buffers.has(name)) waits.push(loading);
  if (context.state !== 'running') waits.push(context.resume());
  if (waits.length === 0) start();
  else Promise.all(waits).then(start, () => {});

  return {
    stop() {
      stopped = true;
      cancel?.();
    },
  };
}

/** いまの音の大きさ（0〜100） */
export function getVolume() {
  return volume;
}

/** 音の大きさを変えて、この端末に覚えさせる（0〜100） */
export function setVolume(value) {
  volume = clampVolume(value);
  if (master) master.gain.setTargetAtTime(gainOf(volume), context.currentTime, 0.02);
  storage?.setItem(STORAGE_VOLUME, String(volume));
}

function clampVolume(value) {
  return Math.round(Math.min(100, Math.max(0, value)));
}

/**
 * 音の大きさ（0〜100）を、実際に掛ける倍率（0〜1）にする。
 * 人の耳は、音の強さが「何倍になったか」で大きさを感じるので、そのまま割合にすると
 * つまみの上の方ではほとんど変わらず、下の方で急に小さくなったように聞こえる。
 * 2乗にすると、つまみを動かした量と、聞こえる大きさの変わり方が近くなる。
 *   例：50 → 0.25倍、70 → 0.49倍、100 → 1倍
 */
function gainOf(value) {
  return (value / 100) ** 2;
}
