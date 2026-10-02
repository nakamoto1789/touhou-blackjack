#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人気投票のExcelファイルから、ゲーム用のキャラクターデータ (data/characters.json) を作るスクリプト。

使い方（touhou-blackjack フォルダで実行）:

    python tools/convert_excel.py                  ← Excelを自動で探す
    python tools/convert_excel.py "C:/path/結果.xlsx"  ← Excelの場所を指定する

Excelから使うのは「順位」と「名前」の2列だけです。
（前回・ポイント・コメントなどの列は読み飛ばします）

追加のライブラリは不要です。.xlsx は「XMLファイルをZIPでまとめたもの」なので、
Pythonに最初から入っている zipfile と xml だけで読めます。
"""

import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

# ---- 設定 -------------------------------------------------------------
SHEET_NAME = "人気投票結果"   # 読み込むシート名
RANK_HEADER = "順位"          # 点数として使う列の見出し
NAME_HEADER = "名前"          # キャラクター名の列の見出し

PROJECT_DIR = Path(__file__).resolve().parent.parent   # touhou-blackjack フォルダ
OUTPUT_PATH = PROJECT_DIR / "data" / "characters.json"
YOMI_PATH = PROJECT_DIR / "tools" / "yomi.json"        # 検索用のよみがな（手作業で管理）

# .xlsx の中のXMLで使われている「名前空間」
NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def find_excel_file():
    """引数が無いとき、近くのフォルダから人気投票のExcelを探す。"""
    for folder in (PROJECT_DIR, PROJECT_DIR.parent):
        candidates = sorted(folder.glob("*人気投票*.xlsx"))
        if candidates:
            return candidates[0]
    return None


def rich_text(node):
    """<si> や <is> の中の文字列を取り出す。

    文字列は <t> に直接入っているか、書式つきの場合は <r><t> に分かれて入っている。
    Excelが自動で付ける「ふりがな」(<rPh>) の中の <t> は名前ではないので読まない。
    """
    parts = []
    direct = node.find(f"{{{NS_MAIN}}}t")
    if direct is not None:
        parts.append(direct.text or "")
    for run in node.findall(f"{{{NS_MAIN}}}r"):
        text = run.find(f"{{{NS_MAIN}}}t")
        if text is not None:
            parts.append(text.text or "")
    return "".join(parts)


def read_shared_strings(archive):
    """Excelで保存し直したファイルは、文字列が sharedStrings.xml にまとめられる。"""
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    return [rich_text(item) for item in root.findall(f"{{{NS_MAIN}}}si")]


def find_sheet_path(archive, sheet_name):
    """シート名から、ZIPの中のXMLファイルの場所を調べる。"""
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {r.get("Id"): r.get("Target") for r in rels.findall(f"{{{NS_PKG_REL}}}Relationship")}

    sheets = workbook.find(f"{{{NS_MAIN}}}sheets").findall(f"{{{NS_MAIN}}}sheet")
    names = [s.get("name") for s in sheets]
    for sheet in sheets:
        if sheet.get("name") == sheet_name:
            target = targets[sheet.get(f"{{{NS_REL}}}id")]
            return target.lstrip("/") if target.startswith("/") else "xl/" + target
    raise SystemExit(f"エラー: シート「{sheet_name}」が見つかりません。（あるシート: {names}）")


def cell_text(cell, shared_strings):
    """1つのセルの値を文字列として取り出す。"""
    cell_type = cell.get("t")
    if cell_type == "inlineStr":   # セルの中に直接書かれた文字列
        inline = cell.find(f"{{{NS_MAIN}}}is")
        return rich_text(inline) if inline is not None else ""
    value = cell.find(f"{{{NS_MAIN}}}v")
    if value is None or value.text is None:
        return ""
    if cell_type == "s":           # 共有文字列（番号で参照）
        return shared_strings[int(value.text)]
    return value.text              # 数値など


def read_rows(excel_path):
    """シートを「列の文字(A,B,C…) → 値」の辞書のリストとして読む。"""
    with zipfile.ZipFile(excel_path) as archive:
        shared_strings = read_shared_strings(archive)
        sheet_path = find_sheet_path(archive, SHEET_NAME)
        sheet = ET.fromstring(archive.read(sheet_path))

    rows = []
    for row in sheet.find(f"{{{NS_MAIN}}}sheetData").findall(f"{{{NS_MAIN}}}row"):
        values = {}
        for cell in row.findall(f"{{{NS_MAIN}}}c"):
            column = re.match(r"[A-Z]+", cell.get("r")).group(0)   # "D12" → "D"
            values[column] = cell_text(cell, shared_strings).strip()
        rows.append(values)
    return rows


def build_characters(rows):
    """見出し行を探し、「順位」と「名前」だけを取り出す。"""
    header_index = None
    for index, row in enumerate(rows):
        if RANK_HEADER in row.values() and NAME_HEADER in row.values():
            header_index = index
            break
    if header_index is None:
        raise SystemExit(f"エラー: 「{RANK_HEADER}」「{NAME_HEADER}」の見出しが見つかりません。")

    header = rows[header_index]
    rank_column = next(col for col, text in header.items() if text == RANK_HEADER)
    name_column = next(col for col, text in header.items() if text == NAME_HEADER)

    characters = []
    for row in rows[header_index + 1:]:
        name = row.get(name_column, "")
        rank_text = row.get(rank_column, "")
        if not name and not rank_text:
            continue   # 空行
        try:
            rank = int(float(rank_text))
        except ValueError:
            print(f"  スキップ: 順位が数値ではありません → {row}")
            continue
        if not name or rank < 1:
            print(f"  スキップ: 名前が空、または順位が不正です → {row}")
            continue
        characters.append({"rank": rank, "name": name})

    # 順位の小さい順に並べる（同率順位はExcelでの並び順のまま）
    characters.sort(key=lambda c: c["rank"])
    return characters


def main():
    excel_path = Path(sys.argv[1]) if len(sys.argv) > 1 else find_excel_file()
    if excel_path is None or not excel_path.exists():
        raise SystemExit("エラー: Excelファイルが見つかりません。パスを引数で指定してください。")
    print(f"読み込み: {excel_path}")

    characters = build_characters(read_rows(excel_path))

    names = [c["name"] for c in characters]
    duplicated = sorted({n for n in names if names.count(n) > 1})
    if duplicated:
        raise SystemExit(f"エラー: 同じ名前が複数あります → {duplicated}")

    yomi_table = json.loads(YOMI_PATH.read_text(encoding="utf-8")) if YOMI_PATH.exists() else {}

    # id は「同じキャラかどうか」の判定に使う通し番号。
    # 同率順位（同じ rank）のキャラがいるので、rank だけでは区別できない。
    result = []
    missing_yomi = []
    for index, character in enumerate(characters, start=1):
        entry = {"id": index, "rank": character["rank"], "name": character["name"]}
        yomi = yomi_table.get(character["name"])
        if yomi:
            entry["yomi"] = yomi
        elif re.search(r"[\u4e00-\u9fff々]", character["name"]):
            missing_yomi.append(character["name"])   # 漢字があるのによみがなが無い
        result.append(entry)

    # 1キャラ1行で書き出す（人が見ても読みやすく、差分も分かりやすい）
    lines = [json.dumps(entry, ensure_ascii=False) for entry in result]
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text("[\n  " + ",\n  ".join(lines) + "\n]\n", encoding="utf-8")

    ranks = [c["rank"] for c in result]
    tied = sorted({r for r in ranks if ranks.count(r) > 1})
    print(f"書き出し: {OUTPUT_PATH}")
    print(f"  キャラクター数: {len(result)}")
    print(f"  順位の範囲    : {min(ranks)}位 〜 {max(ranks)}位")
    print(f"  同率順位      : {tied if tied else 'なし'}")
    if missing_yomi:
        print(f"  よみがな未登録（漢字名）: {len(missing_yomi)}件 → tools/yomi.json に追加するとひらがな検索できます")
        for name in missing_yomi:
            print(f"    - {name}")


if __name__ == "__main__":
    main()
