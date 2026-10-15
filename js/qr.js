// ============================================================
// qr.js … 招待リンクのQRコードを作る
//
// QRコードの白黒の模様を計算する部分は、外部のライブラリ
// 「qrcode-generator」（作者：Kazuhiko Arase、MITライセンス）を使っています。
// https://github.com/kazuhikoarase/qrcode-generator
//
// ・読み込むのは、最初にQRコードを表示したときの1回だけ（使わない人には読み込ませない）。
//   読み込めなくても、ゲームのほかの部分には影響しない。
// ・integrity（SRI）は、届いたファイルが本物かをブラウザに確かめさせるための値。
//   配布元のファイルが1文字でも書き換えられていたら、ブラウザが実行を拒否する。
//   バージョンを変えるときは、url と integrity を両方とも新しいものに替える
//   （値は https://cdnjs.com/libraries/qrcode-generator に載っている）。
// ============================================================

const QR_LIBRARY = {
  url: 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
  integrity: 'sha512-ZDSPMa/JM1D+7kdg2x3BsruQ6T/JpJo3jWDWkCZsP+5yVyp1KfESqLI+7RqB5k24F7p2cV7i2YHh/890y6P6Sw==',
};

let loading = null;   // 読み込み中・読み込み済みの Promise（2回目からは同じものを使い回す）

/** ライブラリを読み込んで、QRコードを作る関数 qrcode を返す */
function loadLibrary() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = QR_LIBRARY.url;
      script.integrity = QR_LIBRARY.integrity;
      script.crossOrigin = 'anonymous';   // SRI を確かめるために必要な指定
      script.onload = () => {
        if (window.qrcode) resolve(window.qrcode);
        else reject(new Error('QRコードを作れませんでした。'));
      };
      script.onerror = () => {
        // 電波が悪いときなどに、次に開いたとき読み込み直せるようにしておく
        loading = null;
        script.remove();
        reject(new Error('QRコードを作れませんでした。通信の状態を確かめてください。'));
      };
      document.head.append(script);
    });
  }
  return loading;
}

/**
 * 文字列（招待リンクのURL）を表すQRコードを、SVG（図形を文字で書いた画像）にして返す。
 * @param {string} text QRコードにする文字列
 * @returns {Promise<string>} <svg>…</svg> の文字列
 */
export async function makeQrSvg(text) {
  const qrcode = await loadLibrary();
  // 0   … QRコードの大きさ（型番）を、文字数に合わせて自動で決める
  // 'M' … 誤り訂正レベル。コードの約15%が汚れたり欠けたりしても読み取れる
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({
    cellSize: 4,       // 1マスの大きさ（scalable なので、実際の表示の大きさは CSS で決める）
    margin: 16,        // まわりの白い余白。読み取りには4マス分（4 × 4）が必要
    scalable: true,    // 枠の大きさに合わせて伸び縮みさせる
    title: 'ルームに参加するためのQRコード',
  });
}
