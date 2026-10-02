// ============================================================
// firebase-config.js … Firebase への接続情報
//
// Firebase コンソール →「プロジェクトの設定」→「マイアプリ」に表示される
// firebaseConfig の中身を、下の '' の中に貼り付けてください。
// （くわしい手順は README.md の「Firebase の準備」を参照）
//
// ・apiKey が空のあいだは「お試しモード」で動きます。
//   （同じブラウザの別タブ同士でだけ遊べる、動作確認用のモード）
// ・この値は公開されても問題ない「識別用の情報」です。
//   データを守っているのは database.rules.json のセキュリティルールです。
// ============================================================

export const firebaseConfig = {
  apiKey: 'AIzaSyA9WEBXxhDVKlGAibSDgpAlO33KHefLTo8',
  authDomain: 'touhou-blackjack.firebaseapp.com',
  databaseURL: 'https://touhou-blackjack-default-rtdb.asia-southeast1.firebasedatabase.app',      // 例: https://xxxxx-default-rtdb.asia-southeast1.firebasedatabase.app
  projectId: 'touhou-blackjack',
  storageBucket: 'touhou-blackjack.firebasestorage.app',
  messagingSenderId: '962432074525',
  appId: '1:962432074525:web:7a3cdda5ac610bdb7b97f4',
};
