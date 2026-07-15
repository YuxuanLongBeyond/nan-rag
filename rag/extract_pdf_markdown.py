#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Extract the reviewed PDF-to-Markdown sources into RAG documents.

The archive currently contains three books.  Only two are selected here:

* 洞山指月: the PDF extraction is complete and replaces the partial web preview.
* 金粟轩纪年诗: a new work, extracted by poem/annotation section.

The OCR Markdown for 南师所讲呼吸法门精要 is deliberately retained only as a
source file: the existing chapter-by-chapter web text is longer and cleaner.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path


RAG_DIR = Path(__file__).resolve().parent
PROJECT_DIR = RAG_DIR.parent
DEFAULT_SOURCE_DIR = PROJECT_DIR / "data" / "pdf" / "markdown"
DEFAULT_OUT = RAG_DIR / "pdf_markdown_documents.jsonl"

DONGSHAN_TITLES = [
    "第一讲 药山惟俨禅师（一）",
    "第二讲 药山惟俨禅师（二）",
    "第三讲 药山惟俨禅师（三）",
    "第四讲 云岩昙晟禅师",
    "第五讲 洞山良价禅师（一）",
    "第六讲 洞山良价禅师（二）",
    "第七讲 洞山良价禅师（三）",
    "第八讲 洞山良价禅师（四）",
    "第九讲 洞山良价禅师（五）",
    "第十讲 洞山良价禅师（六）",
    "第十一讲 洞山良价禅师（七）",
    "第十二讲 洞山良价禅师（八）",
    "第十三讲 曹山本寂禅师（一）",
    "第十四讲 曹山本寂禅师（二）",
    "第十五讲 曹山本寂禅师（三）",
    "第十六讲 五位君臣（一）",
    "第十七讲 五位君臣（二）",
    "第十八讲 五位君臣（三）",
    "第十九讲 五位君臣（四）",
    "第二十讲 五位君臣（五）",
    "第二十一讲 五位君臣（六）",
    "第二十二讲 宝镜三昧（一）",
    "第二十三讲 宝镜三昧（二）",
    "第二十四讲 宝镜三昧（三）",
    "第二十五讲 宝镜三昧（四）",
    "第二十六讲 宝镜三昧（五）",
]

POETRY_COLLECTIONS = {
    "西行集", "海屋集", "海东集", "掩关集", "美京集", "佚诗集",
}


def find_source(root: Path, filename: str) -> Path:
    matches = list(root.rglob(filename))
    if not matches:
        raise FileNotFoundError(f"未找到 {filename}；请先把 data.rar 解压到 {root}")
    if len(matches) > 1:
        raise RuntimeError(f"发现多个同名文件 {filename}：{matches}")
    return matches[0]


def clean_ocr_text(text: str) -> str:
    """Remove layout markup while preserving the author's wording."""
    text = text.replace("\ufeff", "").replace("\u200b", "")
    text = re.sub(r"!\[[^\]]*\]\([^\n)]*\)", "", text)

    # MinerU represents footnote marks and speaker initials as LaTeX.
    text = re.sub(
        r"\$\\(?:mathbf|mathbb)\s*\{\s*([A-Za-z])\s*\}\$",
        r"\1",
        text,
    )
    text = re.sub(
        r"\$\\textcircled\s*\{\s*(?:\\scriptsize\s*\{\s*)*([0-9]+)(?:\s*\})*\s*\}\$",
        r"〔\1〕",
        text,
    )
    text = re.sub(r"\$\\bigcirc\$", "○", text)
    text = re.sub(r"\$[^$]{0,160}\$", "", text)

    # A few high-confidence, systematic OCR confusions in this batch.
    text = text.replace("日：", "曰：")
    text = text.replace("吩附", "吩咐").replace("自已", "自己")
    text = text.replace("泽天央", "泽天夬")

    lines = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = re.sub(r"^#{1,6}\s*", "", raw.strip())
        line = re.sub(r"[ \t\u3000]+", " ", line).strip()
        if line:
            lines.append(line)
        elif lines and lines[-1] != "":
            lines.append("")
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def extract_dongshan(content_path: Path, retrieved: str) -> list[dict]:
    items = json.loads(content_path.read_text(encoding="utf-8"))
    # Alternating-page headers repeat.  The first body page is one PDF page
    # before the first running header; the preceding title page is discarded.
    starts = []
    previous_number = None
    numeral_order = [
        "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
        "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八",
        "十九", "二十", "二十一", "二十二", "二十三", "二十四", "二十五", "二十六",
    ]
    number_map = {value: index + 1 for index, value in enumerate(numeral_order)}
    for item in items:
        if item.get("type") != "discarded":
            continue
        match = re.match(r"^第\s*([一二三四五六七八九十]+)\s*讲", (item.get("text") or ""))
        if not match:
            continue
        number = number_map.get(match.group(1))
        if number and number != previous_number:
            starts.append((number, max(0, int(item["page_idx"]) - 1)))
            previous_number = number

    if [number for number, _ in starts] != list(range(1, 27)):
        raise RuntimeError(f"《洞山指月》章节页识别异常：{starts}")

    text_by_page: dict[int, list[str]] = {}
    for item in items:
        if item.get("type") != "text":
            continue
        value = clean_ocr_text(item.get("text") or "")
        if value:
            text_by_page.setdefault(int(item["page_idx"]), []).append(value)

    records = []
    for index, ((number, start), title) in enumerate(zip(starts, DONGSHAN_TITLES)):
        # Page 299 starts the publisher's catalogue, not the book body.
        end = starts[index + 1][1] if index + 1 < len(starts) else 299
        paragraphs = []
        for page in range(start, end):
            paragraphs.extend(text_by_page.get(page, []))
        text = clean_ocr_text("\n\n".join(paragraphs))
        if len(text) < 500:
            raise RuntimeError(f"《洞山指月》{title} 正文过短：{len(text)} 字")
        records.append({
            "work": "洞山指月",
            "category": "禅宗/修行",
            "chapter_no": number,
            "chapter_no_in_work": number,
            "chapter_title": title,
            "text": text,
            "char_count": len(text),
            "source_url": f"file://data/pdf/markdown/{content_path.name}#page={start + 1}",
            "source": "本地 PDF 转 Markdown（完整本）",
            "retrieved": retrieved,
        })
    return records


def extract_poetry(markdown_path: Path, retrieved: str) -> list[dict]:
    raw = markdown_path.read_text(encoding="utf-8")
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    try:
        body_start = lines.index("# 西行集")
    except ValueError as error:
        raise RuntimeError("《金粟轩纪年诗》未找到正文起点 # 西行集") from error

    records = []
    collection = ""
    pending_titles: list[str] = []
    current_title = ""
    current_lines: list[str] = []

    def flush() -> None:
        nonlocal current_title, current_lines, pending_titles
        text = clean_ocr_text("\n".join(current_lines))
        title = clean_ocr_text(current_title)
        if not text:
            if title and title not in POETRY_COLLECTIONS:
                pending_titles.append(title)
            current_title = ""
            current_lines = []
            return

        # Collection date ranges are metadata, not standalone search chunks.
        if not title and len(text) < 30 and re.fullmatch(
            r"[甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥一二三四五六七八九〇零—\-]+",
            text,
        ):
            pass
        # OCR sometimes puts the second half of a long heading on the next
        # line.  Keep it as heading context for the following poem.
        elif len(text) < 50 and not re.search(r"[。！？!?）”』]$", text):
            pending_titles.extend(part for part in (title, text.replace("\n", " ")) if part)
        elif title == "注释" and records:
            records[-1]["text"] += f"\n\n注释\n{text}"
            records[-1]["char_count"] = len(records[-1]["text"])
        else:
            parts = [collection, *pending_titles, title]
            chapter_title = " / ".join(part for part in parts if part)
            chapter_no = len(records) + 1
            records.append({
                "work": "金粟轩纪年诗",
                "category": "诗词",
                "chapter_no": chapter_no,
                "chapter_no_in_work": chapter_no,
                "chapter_title": chapter_title or collection or "正文",
                "text": text,
                "char_count": len(text),
                "source_url": f"file://data/pdf/markdown/{markdown_path.name}",
                "source": "本地 PDF 转 Markdown（完整本）",
                "retrieved": retrieved,
            })
        pending_titles = []
        current_title = ""
        current_lines = []

    for raw_line in lines[body_start:]:
        heading = re.match(r"^#{1,6}\s+(.+?)\s*$", raw_line)
        if heading:
            flush()
            value = clean_ocr_text(heading.group(1))
            if value in POETRY_COLLECTIONS:
                collection = value
                pending_titles = []
            else:
                current_title = value
        elif not re.match(r"^!\[", raw_line.strip()):
            current_lines.append(raw_line)
    flush()

    # Preserve short poems, but reject blocks that are only OCR layout debris.
    records = [record for record in records if re.search(r"[\u3400-\u9fff]", record["text"])]
    for index, record in enumerate(records, 1):
        record["chapter_no"] = index
        record["chapter_no_in_work"] = index
    if len(records) < 400:
        raise RuntimeError(f"《金粟轩纪年诗》仅识别出 {len(records)} 个正文单元")
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description="提取 PDF Markdown 并清洗为 documents.jsonl")
    parser.add_argument("--i-have-authorization", action="store_true", required=True)
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    retrieved = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    dongshan = find_source(args.source_dir, "洞山指月_content_list.json")
    poetry = find_source(args.source_dir, "金粟轩纪年诗(南怀瑾)_14226143.md")

    records = [
        *extract_dongshan(dongshan, retrieved),
        *extract_poetry(poetry, retrieved),
    ]
    by_work: dict[str, dict[str, int]] = {}
    for record in records:
        stats = by_work.setdefault(record["work"], {"documents": 0, "chars": 0})
        stats["documents"] += 1
        stats["chars"] += record["char_count"]

    for work, stats in by_work.items():
        print(f"{work}: {stats['documents']} 个正文单元，{stats['chars']:,} 字")
    if args.dry_run:
        return

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as output:
        for record in records:
            output.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(f"输出：{args.out}（{len(records)} 条）")


if __name__ == "__main__":
    main()
