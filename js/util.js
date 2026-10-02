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
