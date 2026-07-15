#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_epub_books.py — 从「南怀瑾著作全收录.epub」提取全部著作全文。

输入: ../data_new/南怀瑾著作全收录.epub
输出: epub_documents.jsonl（兼容 chunk_documents.py 格式）

章节标题来源: 优先使用 EPUB NCX 目录中的准确标题，仅在无 NCX 条目时
回退到文本首行提取。

提取目标: EPUB 全部 48 个条目 → 合并多卷本后为 43 部独立著作。
多卷本合并规则:
  - 我说《参同契》（上/中/下册）→ 我说参同契
  - 维摩诘的花雨满天（上/下册）→ 维摩诘的花雨满天
  - 列子臆说(上/中/下册)     → 列子臆说
"""

import argparse
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

# data_new 在 /Users/.../nan/data_new/，是 nanhuaijin-rag 的兄弟目录
_RAG_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_DIR = os.path.dirname(_RAG_DIR)
_PROJECT_PARENT = os.path.dirname(_REPO_DIR)
EPUB_PATH = os.path.join(_PROJECT_PARENT, "data_new", "南怀瑾著作全收录.epub")

# EPUB 全部 48 个顶层条目（从 toc.ncx 解析）
ALL_BOOKS = [
    # == 儒家典籍 ==
    {"epub_title": "论语别裁",                 "start": 1,    "end": 28,   "work": "论语别裁"},
    {"epub_title": "话说中庸",                  "start": 28,   "end": 40,   "work": "话说中庸"},
    {"epub_title": "原本大学微言",              "start": 40,   "end": 56,   "work": "原本大学微言"},
    {"epub_title": "孟子旁通",                  "start": 98,   "end": 109,  "work": "孟子旁通"},
    {"epub_title": "孟子与万章",                "start": 109,  "end": 116,  "work": "孟子与万章"},
    {"epub_title": "孟子与离娄",                "start": 116,  "end": 124,  "work": "孟子与离娄"},
    {"epub_title": "孟子与公孙丑",              "start": 124,  "end": 132,  "work": "孟子与公孙丑"},
    {"epub_title": "孟子与尽心篇",              "start": 132,  "end": 139,  "work": "孟子与尽心篇"},
    {"epub_title": "孟子与滕文公、告子",        "start": 139,  "end": 148,  "work": "孟子与滕文公、告子"},
    {"epub_title": "孔子和他的弟子们",          "start": 1097, "end": 1110, "work": "孔子和他的弟子们"},
    # == 佛经解读 ==
    {"epub_title": "金刚经说什么",              "start": 56,   "end": 98,   "work": "金刚经说什么"},
    {"epub_title": "维摩诘的花雨满天（上册）",   "start": 243,  "end": 254,  "work": "维摩诘的花雨满天"},
    {"epub_title": "维摩诘的花雨满天（下册）",   "start": 254,  "end": 266,  "work": "维摩诘的花雨满天"},
    {"epub_title": "瑜伽师地论 声闻地讲录",     "start": 359,  "end": 384,  "work": "瑜伽师地论 声闻地讲录"},
    {"epub_title": "药师经的济世观",            "start": 819,  "end": 960,  "work": "药师经的济世观"},
    {"epub_title": "楞严大义今释",              "start": 1160, "end": 1179, "work": "楞严大义今释"},
    {"epub_title": "圆觉经略说",                "start": 1179, "end": 1200, "work": "圆觉经略说"},
    {"epub_title": "学佛者的基本信念",          "start": 1200, "end": 1216, "work": "学佛者的基本信念"},
    {"epub_title": "如何修证佛法",              "start": 1059, "end": 1097, "work": "如何修证佛法"},
    {"epub_title": "定慧初修",                  "start": 1145, "end": 1160, "work": "定慧初修"},
    # == 道家 ==
    {"epub_title": "我说《参同契》（上册）",     "start": 148,  "end": 180,  "work": "我说参同契"},
    {"epub_title": "我说《参同契》（中册）",     "start": 180,  "end": 211,  "work": "我说参同契"},
    {"epub_title": "我说《参同契》（下册）",     "start": 211,  "end": 243,  "work": "我说参同契"},
    {"epub_title": "老子他说：初续合集",         "start": 469,  "end": 483,  "work": "老子他说"},
    {"epub_title": "庄子諵譁",                  "start": 440,  "end": 455,  "work": "庄子諵譁"},
    {"epub_title": "列子臆说(上册)",            "start": 266,  "end": 296,  "work": "列子臆说"},
    {"epub_title": "列子臆说(中册)",            "start": 296,  "end": 329,  "work": "列子臆说"},
    {"epub_title": "列子臆说(下册)",            "start": 329,  "end": 359,  "work": "列子臆说"},
    {"epub_title": "中国道教发展史略述",         "start": 503,  "end": 518,  "work": "中国道教发展史略述"},
    {"epub_title": "禅宗与道家",                "start": 1134, "end": 1145, "work": "禅宗与道家"},
    # == 易经 ==
    {"epub_title": "易经系传别讲",              "start": 557,  "end": 567,  "work": "易经系传别讲"},
    {"epub_title": "易经杂说",                  "start": 567,  "end": 738,  "work": "易经杂说"},
    # == 禅宗/修行 ==
    {"epub_title": "禅话",                      "start": 798,  "end": 819,  "work": "禅话"},
    {"epub_title": "禅海蠡测",                  "start": 1026, "end": 1059, "work": "禅海蠡测"},
    {"epub_title": "大圆满禅定休息简说",        "start": 1110, "end": 1134, "work": "大圆满禅定休息简说"},
    {"epub_title": "静坐修道与长生不老",        "start": 738,  "end": 798,  "work": "静坐修道与长生不老"},
    # == 讲演/杂说 ==
    {"epub_title": "廿一世纪初的前言后语",       "start": 384,  "end": 405,  "work": "廿一世纪初的前言后语"},
    {"epub_title": "漫谈中国文化",              "start": 405,  "end": 413,  "work": "漫谈中国文化"},
    {"epub_title": "禅与生命的认知初讲",         "start": 413,  "end": 426,  "work": "禅与生命的认知初讲"},
    {"epub_title": "小言黄帝内经与生命科学",     "start": 426,  "end": 440,  "work": "小言黄帝内经与生命科学"},
    {"epub_title": "人生的起点和终站",           "start": 455,  "end": 463,  "work": "人生的起点和终站"},
    {"epub_title": "南怀瑾与彼得圣吉",           "start": 463,  "end": 469,  "work": "南怀瑾与彼得·圣吉"},
    {"epub_title": "答问青壮年参禅者",           "start": 483,  "end": 493,  "work": "答问青壮年参禅者"},
    {"epub_title": "南怀瑾讲演录",              "start": 493,  "end": 503,  "work": "南怀瑾讲演录"},
    {"epub_title": "中国佛教发展史略述",         "start": 518,  "end": 529,  "work": "中国佛教发展史略述"},
    {"epub_title": "新旧教育的变与惑",           "start": 529,  "end": 557,  "work": "新旧教育的变与惑"},
    {"epub_title": "历史的经验",                "start": 960,  "end": 1015, "work": "历史的经验"},
    {"epub_title": "中国文化泛言增订本",         "start": 1015, "end": 1026, "work": "中国文化泛言"},
]

# NCX 中识别为前言的标题关键词
PREAMBLE_KEYWORDS = [
    '版权信息', '版权页', '编者的话', '出版说明',
    '再版记言', '再版说明', '前言', '新版说明',
    '繁体再版前言', '自序', '序言', '再版序',
    '修订版序', '修订版说明', '写在前面',
    '编辑说明',
]

MIN_CONTENT_CHARS = 100
NCX_NS = {'ncx': 'http://www.daisy.org/z3986/2005/ncx/'}


# ── NCX 章节标题索引 ──────────────────────────────

def build_ncx_index(epub_zip):
    """解析 toc.ncx，构建 file_index → (chapter_title, is_preamble) 映射。

    对于每个 HTML 文件，使用 NCX 中第一个引用它的 navPoint 的标题
    （即层级最高的那个），以获取准确的章/节标题。
    """
    ncx_xml = epub_zip.read('toc.ncx').decode('utf-8', errors='ignore')
    root = ET.fromstring(ncx_xml)
    navMap = root.find('.//ncx:navMap', NCX_NS)

    file_map = {}  # int → str

    def walk_navpoints(parent, _depth=0):
        for np in parent.findall('ncx:navPoint', NCX_NS):
            label = np.find('ncx:navLabel/ncx:text', NCX_NS)
            content = np.find('ncx:content', NCX_NS)
            title = label.text.strip() if label is not None and label.text else ''
            src = content.get('src', '') if content is not None else ''

            m = re.search(r'index_split_(\d+)', src)
            if m:
                idx = int(m.group(1))
                if idx not in file_map:
                    file_map[idx] = title

            walk_navpoints(np, _depth + 1)

    walk_navpoints(navMap)
    return file_map


def get_chapter_title(file_idx, ncx_index):
    """获取章节标题：优先 NCX，回退为 None（后续由正文提取）。"""
    return ncx_index.get(file_idx, None)


def is_preamble_title(title):
    """判断标题是否为前言类页面。"""
    if not title:
        return False
    for kw in PREAMBLE_KEYWORDS:
        if kw in title:
            return True
    return False


# ── HTML 文本提取 ──────────────────────────────────

def extract_text_from_html(html_content):
    """Extract plain text from an EPUB HTML file."""
    text = re.sub(r'<style[^>]*>.*?</style>', '', html_content, flags=re.DOTALL)
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL)
    text = re.sub(r'<(?:br|p|div|h[1-6]|li|tr|hr)[^>]*/?>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = text.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    text = text.replace('&quot;', '"').replace('&#39;', "'").replace('&ldquo;', '"').replace('&rdquo;', '"')
    text = text.replace('&lsquo;', "'").replace('&rsquo;', "'").replace('&mdash;', '—').replace('&ndash;', '–')
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r'[ \t]{2,}', ' ', text)
    lines = [l.strip() for l in text.split('\n')]
    text = '\n'.join(lines)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def extract_fallback_heading(text):
    """当 NCX 无标题时，从文本首行提取章节标题（回退方案）。"""
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    for line in lines[:6]:
        if not line:
            continue
        if line in ('南怀瑾著作全收录', '封面', '版权信息'):
            continue
        if len(line) <= 80:
            return line
    return "正文"


def is_toc_page(text):
    """Detect table of contents page by short-line density."""
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    if len(lines) < 5:
        return False
    short_lines = [l for l in lines if len(l) <= 30]
    if len(short_lines) > len(lines) * 0.6:
        return True
    first_lines = '\n'.join(lines[:5])
    if '目录' in first_lines and len(lines) > 20:
        return True
    return False


def is_ad_page(text):
    """Detect advertising boilerplate / empty cover pages."""
    if re.match(r'^东方出版社南怀瑾作品', text.strip()):
        return True
    if re.match(r'^图书在版编目', text.strip()):
        return True
    if '东方出版社南怀瑾作品' in text:
        return True
    if text.lstrip().startswith('Table of Contents'):
        return True
    if len(text) < MIN_CONTENT_CHARS:
        return True
    return False


# ── 核心提取逻辑 ──────────────────────────────────

def extract_book(epub_zip, book_info, ncx_index):
    """Extract full text for one book entry from the EPUB.

    使用 NCX 索引获取准确的章节标题。前言页面（编者的话、出版说明
    等）合并为单个"前言"章节。
    """
    work = book_info["work"]
    start = book_info["start"]
    end = book_info["end"]

    docs = []

    for idx in range(start, end):
        fname = f"index_split_{idx:03d}.html"
        try:
            html = epub_zip.read(fname).decode('utf-8', errors='ignore')
        except KeyError:
            continue

        text = extract_text_from_html(html)
        text = re.sub(r'^南怀瑾著作全收录\s*', '', text).strip()

        if not text:
            continue

        # Skip ads / too-short / TOC pages
        if is_ad_page(text):
            continue
        if is_toc_page(text):
            continue

        # Get chapter title: NCX first, fallback to text extraction
        chapter_title = get_chapter_title(idx, ncx_index)
        if chapter_title is None:
            chapter_title = extract_fallback_heading(text)

        # Skip the book title itself (cover page)
        if chapter_title == book_info["epub_title"]:
            continue

        # The combined EPUB appends machine-generated cross-book TOCs after
        # some titles.  They are navigation data, not the selected book body.
        if chapter_title == '正文' and '版权信息' in text:
            continue

        # Clean text
        text = re.sub(r'\n南怀瑾著作全收录\s*\n', '\n', text)
        text = re.sub(r'\n东方出版社南怀瑾作品[\s\S]*$', '', text)
        text = text.strip()

        if len(text) < MIN_CONTENT_CHARS:
            continue

        doc = {
            "work": work,
            "chapter_title": chapter_title,
            "text": text,
            "char_count": len(text),
            "source_url": f"epub:南怀瑾著作全收录#{work}",
            "source": "epub:南怀瑾著作全收录",
            "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        }
        docs.append(doc)

    # Merge consecutive preamble pages into one "前言"
    merged = []
    preamble_buf = []
    for doc in docs:
        if is_preamble_title(doc["chapter_title"]):
            preamble_buf.append(doc)
        else:
            if preamble_buf:
                merged.append(_make_preamble_doc(work, preamble_buf))
                preamble_buf = []
            merged.append(doc)
    if preamble_buf:
        merged.append(_make_preamble_doc(work, preamble_buf))

    # Assign chapter numbers
    for i, doc in enumerate(merged):
        doc["chapter_no"] = i
        doc["chapter_no_in_work"] = i + 1

    return merged


def _make_preamble_doc(work, preamble_docs):
    """Merge multiple preamble documents into one."""
    merged_text = '\n\n'.join(d["text"] for d in preamble_docs)
    return {
        "work": work,
        "chapter_title": "前言",
        "text": merged_text,
        "char_count": len(merged_text),
        "source_url": f"epub:南怀瑾著作全收录#{work}",
        "source": "epub:南怀瑾著作全收录",
        "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    }


# ── 主流程 ────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="从 EPUB 提取全部著作")
    parser.add_argument("--out", default="epub_documents.jsonl",
                        help="输出文件 (默认: epub_documents.jsonl)")
    parser.add_argument("--epub", default=EPUB_PATH,
                        help="EPUB 文件路径")
    parser.add_argument("--dry-run", action="store_true",
                        help="仅分析结构，不生成输出")
    parser.add_argument("--limit", type=int, default=0,
                        help="仅处理前 N 个条目（用于测试）")
    args = parser.parse_args()

    if not os.path.exists(args.epub):
        print(f"❌ EPUB 文件不存在: {args.epub}")
        sys.exit(1)

    epub_zip = zipfile.ZipFile(args.epub)

    # Build NCX index for accurate chapter titles
    print("解析 NCX 目录索引...")
    ncx_index = build_ncx_index(epub_zip)
    print(f"  已索引 {len(ncx_index)} 个文件\n")

    # Track unique works for multi-volume dedup
    work_order = []
    seen_works = set()
    for book in ALL_BOOKS:
        w = book["work"]
        if w not in seen_works:
            seen_works.add(w)
            work_order.append(w)

    books_to_extract = ALL_BOOKS[:args.limit] if args.limit else ALL_BOOKS
    work_stats = {}  # work → list of docs (accumulated across volumes)

    for book in books_to_extract:
        epub_title = book["epub_title"]
        work = book["work"]
        print(f"{'=' * 60}")
        print(f"提取: {epub_title}")
        print(f"  → 归属作品: {work}")
        print(f"  范围: index_split_{book['start']:03d} ~ index_split_{book['end'] - 1:03d}")

        docs = extract_book(epub_zip, book, ncx_index)

        if not docs:
            print(f"  ⚠ 未提取到内容！")
            continue

        chars = sum(d["char_count"] for d in docs)
        print(f"  章节数: {len(docs)}")
        print(f"  字数: {chars:,}")

        # Show headings for verification
        for i, d in enumerate(docs[:5]):
            print(f"  [{i+1}] {d['chapter_title']} ({d['char_count']:,} 字)")
        if len(docs) > 5:
            mid = len(docs) // 2
            print(f"  ...")
            print(f"  [{mid}] {docs[mid]['chapter_title']} ({docs[mid]['char_count']:,} 字)")
            print(f"  ...")
            for i, d in enumerate(docs[-2:], len(docs) - 1):
                print(f"  [{i}] {d['chapter_title']} ({d['char_count']:,} 字)")

        if work not in work_stats:
            work_stats[work] = []
        work_stats[work].extend(docs)

    # Merge multi-volume: renumber chapters within each work
    print(f"\n{'=' * 60}")
    print("合并多卷本 & 重新编号...")
    all_docs = []
    for work in work_order:
        if work not in work_stats:
            continue
        docs = work_stats[work]
        for i, doc in enumerate(docs):
            doc["chapter_no"] = i
            doc["chapter_no_in_work"] = i + 1
        all_docs.extend(docs)

    total_chars = sum(d["char_count"] for d in all_docs)
    print(f"\n{'=' * 60}")
    print(f"汇总: {len(all_docs)} 章, {total_chars:,} 字 "
          f"({total_chars/10000:.1f} 万字)")
    print(f"独立作品: {len(work_stats)} 部")

    # Per-work summary
    print(f"\n--- 作品明细 ---")
    for work in work_order:
        if work not in work_stats:
            continue
        docs = work_stats[work]
        chars = sum(d["char_count"] for d in docs)
        real = [d for d in docs if d["chapter_title"] != "前言"]
        print(f"  {work}: {len(docs)} 章 ({len(real)} 正文 + {len(docs) - len(real)} 前言), {chars:,} 字")

    if not args.dry_run and all_docs:
        out_path = os.path.join(_RAG_DIR, args.out)
        with open(out_path, 'w', encoding='utf-8') as f:
            for doc in all_docs:
                f.write(json.dumps(doc, ensure_ascii=False) + '\n')

        size_kb = os.path.getsize(out_path) / 1024
        print(f"\n✓ 输出: {out_path} ({size_kb:.0f} KB)")
        print(f"  下一步: python3 chunk_documents.py --in {args.out} --out epub_chunks.jsonl")

    epub_zip.close()


if __name__ == "__main__":
    main()
