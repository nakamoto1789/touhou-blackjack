#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自分のPCでゲームを確認するための、かんたんなWebサーバー。

使い方（touhou-blackjack フォルダで実行）:

    python tools/serve.py              ← http://localhost:8000/ で開ける
    python tools/serve.py 8080         ← ポート番号を変える
    python tools/serve.py --open       ← 起動と同時にブラウザで開く

index.html をダブルクリックして開いても動きません。
（JavaScriptのモジュール機能は http:// でないと使えないため）

Python標準の `python -m http.server` と違う点:
  ・.js ファイルを必ず JavaScript として返す
    （Windowsでは設定によって text/plain になり、動かないことがある）
  ・ブラウザにキャッシュさせない（書き換えがすぐ反映される）
"""

import functools
import http.server
import os
import sys
import webbrowser
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent   # touhou-blackjack フォルダ

# 引数の読み取り: 数字はポート番号、--open はブラウザを開く指定
numbers = [arg for arg in sys.argv[1:] if arg.isdigit()]
PORT = int(numbers[0]) if numbers else 8000
OPEN_BROWSER = "--open" in sys.argv[1:]


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".md": "text/plain; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    # Windowsでは、これを False にしないと同じポートで二重に起動できてしまう
    allow_reuse_address = os.name != "nt"


def main():
    handler = functools.partial(Handler, directory=str(PROJECT_DIR))
    url = f"http://localhost:{PORT}/"
    try:
        # 127.0.0.1 = このPCからだけアクセスできる
        server = Server(("127.0.0.1", PORT), handler)
    except OSError:
        print(f"ポート {PORT} はすでに使われています。")
        print(f"すでに起動している場合は、そのまま {url} を開いてください。")
        print("別の番号で起動するには: python tools/serve.py 8080")
        if OPEN_BROWSER:
            webbrowser.open(url)
        sys.exit(1)

    with server:
        print(f"{url} で公開中です（止めるときは Ctrl + C、またはこの画面を閉じる）")
        if OPEN_BROWSER:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n終了しました")


if __name__ == "__main__":
    main()
