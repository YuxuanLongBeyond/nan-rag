#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_static_corpus.py — 将 chunk JSONL 转换为静态站点可用的格式。

输入: rag/ 目录下的 5 个 *_chunks.jsonl 文件
输出:
  1. search_index.json   — 紧凑搜索索引（id, work, chapter_title, searchText, text_preview）
  2. corpus/{work}.json  — 按作品分片的全文语料
  3. works_manifest.json — 作品清单（文件名、chunk 数、大小）

用途: 为南怀瑾 RAG 静态站点（GitHub Pages）提供数据层。
"""

import json
import os
import re
import sys
from collections import OrderedDict

# ── 配置 ──────────────────────────────────────────
RAG_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(RAG_DIR)
CORPUS_DIR = os.path.join(PROJECT_DIR, "corpus")

CHUNK_FILES = [
    "nanhuaijin_chunks.jsonl",
    "shixiu_chunks.jsonl",
    "guoxue_chunks.jsonl",
    "supplement_chunks.jsonl",
    "docx_chunks.jsonl",
]

OUT_INDEX = os.path.join(PROJECT_DIR, "search_index.json")
OUT_MANIFEST = os.path.join(PROJECT_DIR, "works_manifest.json")
TEXT_PREVIEW_LEN = 150


def sanitize_filename(name):
    """将作品名转为安全的文件名（保留中文）。"""
    # 替换文件系统不安全字符
    name = re.sub(r'[\\/:*?"<>|]', '_', name)
    # 去除首尾空格和点
    name = name.strip('. ')
    return name


def load_chunks():
    """加载所有 chunk JSONL，返回统一格式的 chunk 列表。"""
    chunks = []
    seen_ids = set()
    stats = {}

    for fname in CHUNK_FILES:
        fpath = os.path.join(RAG_DIR, fname)
        if not os.path.exists(fpath):
            print(f"  ⚠ 跳过（文件不存在）: {fname}")
            continue

        count = 0
        with open(fpath, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # 统一 id 字段（不同来源的 JSONL 字段名略有差异）
                chunk_id = obj.get("id", "")
                if not chunk_id:
                    # 用 work + chapter_no 构造 id
                    work = obj.get("work", "未知")
                    ch_no = obj.get("chapter_no", obj.get("chunk_no", 0))
                    chunk_id = f"{work}:{ch_no:04d}"

                if chunk_id in seen_ids:
                    continue
                seen_ids.add(chunk_id)

                # 标准化字段
                text = obj.get("text", "")
                work = obj.get("work", "未知作品")
                chapter_title = obj.get("chapter_title", "")
                source_url = obj.get("source_url", obj.get("chapter_url", ""))
                char_count = obj.get("char_count", len(text))

                # 构建 searchText（用于客户端关键词匹配）
                normalized = re.sub(r'\s+', ' ', text[:TEXT_PREVIEW_LEN]).strip()
                search_text = f"{work} {chapter_title} {normalized}".lower()

                chunks.append({
                    "id": chunk_id,
                    "work": work,
                    "chapter_title": chapter_title,
                    "source_url": source_url,
                    "char_count": char_count,
                    "text_preview": text[:TEXT_PREVIEW_LEN],
                    "searchText": search_text,
                    "text": text,
                })
                count += 1

        stats[fname] = count
        print(f"  ✓ {fname}: {count} chunks")

    return chunks, stats


def build_search_index(chunks):
    """生成紧凑搜索索引（不含 full text）。

    s (searchText) 不存储 — 客户端由 w + c + p 重建即可，节省 ~40% 体积。
    u (source_url) 不存储 — 在 corpus 中，搜索阶段不需要。
    """
    index = []
    for c in chunks:
        index.append({
            "id": c["id"],
            "w": c["work"],
            "c": c["chapter_title"],
            "n": c["char_count"],
            "p": c["text_preview"],
        })
    return index


def build_corpus(chunks):
    """按作品分片，生成 corpus/{work}.json。"""
    os.makedirs(CORPUS_DIR, exist_ok=True)

    # 按 work 分组
    by_work = OrderedDict()
    for c in chunks:
        work = c["work"]
        if work not in by_work:
            by_work[work] = []
        by_work[work].append(c)

    manifest = {}
    total_size = 0

    for work, work_chunks in by_work.items():
        safe_name = sanitize_filename(work)
        filename = f"{safe_name}.json"
        filepath = os.path.join(CORPUS_DIR, filename)

        # 构建 corpus 记录: {id: {t: text, c: chapter_title, u: source_url}}
        corpus = {}
        for c in work_chunks:
            corpus[c["id"]] = {
                "t": c["text"],
                "c": c["chapter_title"],
                "u": c["source_url"],
            }

        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(corpus, f, ensure_ascii=False, separators=(',', ':'))

        file_size = os.path.getsize(filepath)
        total_size += file_size

        manifest[work] = {
            "file": f"corpus/{filename}",
            "chunks": len(work_chunks),
            "size": file_size,
        }

        print(f"  ✓ corpus/{filename}: {len(work_chunks)} chunks, {file_size/1024:.0f} KB")

    return manifest, total_size


def main():
    print("=" * 60)
    print("南怀瑾 RAG 静态语料库构建工具")
    print("=" * 60)

    # 1. 加载 chunk
    print("\n[1/4] 加载 chunk JSONL...")
    chunks, stats = load_chunks()
    print(f"  总计: {len(chunks)} chunks, {sum(c['char_count'] for c in chunks):,} 字")

    if not chunks:
        print("\n❌ 未找到任何 chunk 文件，请先运行 crawl 和 chunk 脚本。")
        sys.exit(1)

    # 2. 生成搜索索引
    print("\n[2/4] 生成搜索索引...")
    search_index = build_search_index(chunks)
    with open(OUT_INDEX, 'w', encoding='utf-8') as f:
        json.dump(search_index, f, ensure_ascii=False, separators=(',', ':'))
    index_size = os.path.getsize(OUT_INDEX)
    print(f"  ✓ search_index.json: {len(search_index)} 条, {index_size/1024:.0f} KB")

    # 3. 生成 corpus
    print("\n[3/4] 生成全文语料（按作品分片）...")
    manifest, corpus_total = build_corpus(chunks)
    with open(OUT_MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"  ✓ works_manifest.json: {len(manifest)} 部作品")
    print(f"  ✓ corpus/ 总大小: {corpus_total/1024/1024:.1f} MB")

    # 4. 汇总
    print("\n[4/4] 生成完毕！")
    print(f"""
  输出文件:
    {OUT_INDEX}   ({index_size/1024:.0f} KB)
    {OUT_MANIFEST}   ({os.path.getsize(OUT_MANIFEST)/1024:.0f} KB)
    {CORPUS_DIR}/   ({len(manifest)} 个文件, {corpus_total/1024/1024:.1f} MB)

  作品统计: {len(manifest)} 部
  总 chunks: {len(chunks)}
  总字数: {sum(c['char_count'] for c in chunks):,}

  gzip 预估（CDN 自动压缩）:
    搜索索引: ~{index_size/1024/4:.0f} KB
    全文语料: ~{corpus_total/1024/1024/4:.0f} MB

  下一步: 将 corpus/ search_index.json works_manifest.json
          与 index.html app.js styles.css 一起部署到 GitHub Pages。
""")


if __name__ == "__main__":
    main()
