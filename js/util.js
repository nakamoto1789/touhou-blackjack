// ============================================================
// util.js … どの画面でも使う小さな道具
// ============================================================

/** idからHTMLの要素を取り出す。例: $('btn-start') */
export function $(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`id="${id}" の要素が index.html にありません`);
  return element;
}

/**
 * 文字列をHTMLに埋め込んでも安全な形にする。
 * プレイヤー名は利用者が自由に入力できるので、そのままHTMLに入れると
 * 「<script>…」のような文字で画面を壊されるおそれがある。必ずこれを通す。
 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 検索用に文字をそろえる。
 * ・全角英数字 → 半角、大文字 → 小文字
 * ・カタカナ → ひらがな（「ふらん」で「フランドール」が見つかるように）
 * ・空白や「・」などの記号を取り除く（「博麗霊夢」で「博麗 霊夢」が見つかるように）
 */
export function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\s・、,（）()\-〜~]/g, '');
}

/**
 * 入力された文字を、0以上の整数にする（全角の数字「１００」も読める）。
 * 数字だけでできていないとき（空欄・小数・マイナス・文字まじり）は NaN を返す。
 */
export function parseWholeNumber(text) {
  const digits = String(text ?? '').normalize('NFKC').trim();
  return /^\d{1,9}$/.test(digits) ? Number(digits) : NaN;
}

// ---- キャラクター一覧の準備（50音順と検索）--------------------------

/** 50音の「行」。左が見出し、右がその行に入るひらがな（濁点つき・小さい字も同じ行） */
const KANA_ROWS = [
  ['あ', 'あいうえおぁぃぅぇぉゔ'],
  ['か', 'かきくけこがぎぐげご'],
  ['さ', 'さしすせそざじずぜぞ'],
  ['た', 'たちつてとだぢづでどっ'],
  ['な', 'なにぬねの'],
  ['は', 'はひふへほばびぶべぼぱぴぷぺぽ'],
  ['ま', 'まみむめも'],
  ['や', 'やゆよゃゅょ'],
  ['ら', 'らりるれろ'],
  ['わ', 'わゐゑをんゎ'],
];

/** よみがなの最初の文字から、50音の「行」を返す。例: 'はくれいれいむ' → 'は'、'ぱちゅりー' → 'は' */
export function kanaRowOf(reading) {
  const first = normalizeText(reading).charAt(0);
  const row = KANA_ROWS.find(([, letters]) => letters.includes(first));
  return row ? row[0] : 'その他';
}

// 日本語の辞書と同じ順（50音順）で文字を比べる道具。濁点や「ー」も辞書と同じ扱いになる
const kanaCollator = new Intl.Collator('ja');

/** 2つのよみがなを50音順で比べる（並べ替えに使う）。a が先なら負の数を返す */
export function compareKana(a, b) {
  return kanaCollator.compare(a, b);
}

/**
 * 読み込んだキャラクターに、検索と並べ替えのための情報をつけ、
 * 50音順に並べた新しい配列を返す。
 *   searchKey … 検索用（名前とよみがなを、ひらがな・記号なしにしてつなげたもの）
 *   sortKey   … 並べ替え用のよみがな
 *   kanaRow   … 50音の行（一覧の見出し「あ」「か」… に使う）
 */
export function prepareCharacters(characters) {
  for (const character of characters) {
    character.searchKey = `${normalizeText(character.name)}|${normalizeText(character.yomi)}`;
    // 漢字を含む名前は yomi（よみがな）を、かなだけの名前は名前そのものを「よみ」として使う
    character.sortKey = normalizeText(character.yomi || character.name);
    character.kanaRow = kanaRowOf(character.sortKey);
  }
  return [...characters].sort((a, b) => compareKana(a.sortKey, b.sortKey) || a.id - b.id);
}

/**
 * 検索語に合うキャラクターを返す（空なら全員）。
 * 名前でも、よみがなでも見つかる。
 * 順位では検索できない（キャラクターを選ぶ段階では、順位を分からなくするため）。
 */
export function searchCharacters(characters, queryText) {
  const query = normalizeText(queryText);
  if (!query) return characters;
  return characters.filter((character) => character.searchKey.includes(query));
}

/** 画面を切り替える。例: showScreen('lobby') → id="screen-lobby" だけを表示 */
export function showScreen(name) {
  const target = $(`screen-${name}`);
  if (target.classList.contains('active')) return;
  for (const screen of document.querySelectorAll('.screen')) {
    screen.classList.toggle('active', screen === target);
  }
  document.body.dataset.screen = name;
  window.scrollTo(0, 0);
}

// ---- トースト（画面下に数秒だけ出るメッセージ）----------------------
let toastTimer = null;

/** @param {'info' | 'error'} kind */
export function showToast(message, kind = 'info') {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast toast-${kind}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

// ---- 確認ダイアログ --------------------------------------------------
/**
 * 「OK / キャンセル」を選んでもらう。
 * @returns {Promise<boolean>} OKなら true
 * 使い方: if (await confirmDialog({ title: '退出しますか？' })) { … }
 */
export function confirmDialog({ title, message = '', okLabel = 'OK', cancelLabel = 'キャンセル' }) {
  const dialog = $('dialog-confirm');
  if (dialog.open) return Promise.resolve(false);   // すでに別の確認を表示中（連打対策）
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = okLabel;
  $('confirm-cancel').textContent = cancelLabel;

  return new Promise((resolve) => {
    const finish = (answer) => {
      $('confirm-ok').onclick = null;
      $('confirm-cancel').onclick = null;
      dialog.oncancel = null;
      dialog.close();
      resolve(answer);
    };
    $('confirm-ok').onclick = () => finish(true);
    $('confirm-cancel').onclick = () => finish(false);
    dialog.oncancel = (event) => {   // Escキーや「戻る」で閉じたとき
      event.preventDefault();
      finish(false);
    };
    dialog.showModal();
  });
}

/** テキストをクリップボードにコピーする。成功したら true */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
