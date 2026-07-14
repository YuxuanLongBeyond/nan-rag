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
import struct
import sys
import argparse
from collections import OrderedDict

# sentence-transformers 是可选依赖，仅用于生成语义向量
try:
    from sentence_transformers import SentenceTransformer
    HAS_SENTENCE_TRANSFORMERS = True
except ImportError:
    HAS_SENTENCE_TRANSFORMERS = False

# ── 配置 ──────────────────────────────────────────
RAG_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(RAG_DIR)
CORPUS_DIR = os.path.join(PROJECT_DIR, "corpus")

CHUNK_FILES = [
    "epub_chunks.jsonl",       # EPUB 优先 — 最干净的全文数据
    "nanhuaijin_quanji_chunks.jsonl",  # 南怀瑾全集 txt 补充（13部短篇开示）
    "new_works_chunks.jsonl",  # data_new 新增作品（对日抗战/素书/海航讲座）
    "nanhuaijin_chunks.jsonl",
    "shixiu_chunks.jsonl",
    "guoxue_chunks.jsonl",
    "supplement_chunks.jsonl",
    "docx_chunks.jsonl",
    "zhangyue_chunks.jsonl",
]

# EPUB 中已有的作品名（从 extract_epub_books.py 的 ALL_BOOKS 推导）
# 这些作品在其他来源中的 chunk 将被跳过，以 EPUB 版本为准
EPUB_WORKS = {
    "论语别裁", "话说中庸", "原本大学微言", "孟子旁通",
    "孟子与万章", "孟子与离娄", "孟子与公孙丑", "孟子与尽心篇",
    "孟子与滕文公、告子", "孔子和他的弟子们",
    "金刚经说什么", "维摩诘的花雨满天", "瑜伽师地论 声闻地讲录",
    "药师经的济世观", "楞严大义今释", "圆觉经略说",
    "学佛者的基本信念", "如何修证佛法", "定慧初修",
    "我说参同契", "老子他说", "庄子諵譁", "列子臆说",
    "中国道教发展史略述", "禅宗与道家",
    "易经系传别讲", "易经杂说",
    "禅话", "禅海蠡测", "大圆满禅定休息简说",
    "静坐修道与长生不老",
    "廿一世纪初的前言后语", "漫谈中国文化", "禅与生命的认知初讲",
    "小言黄帝内经与生命科学", "人生的起点和终站",
    "南怀瑾与彼得·圣吉", "答问青壮年参禅者", "南怀瑾讲演录",
    "中国佛教发展史略述", "新旧教育的变与惑",
    "历史的经验", "中国文化泛言",
}

# 作品名称变体映射：其他来源 → EPUB 标准名
# 用于在非 EPUB 来源中识别应被跳过作品
WORK_NAME_ALIASES = {
    "老子他说(上下)": "老子他说",
    "庄子諵譁(2017年)": "庄子諵譁",
    "中国道教发展史略": "中国道教发展史略述",
    "中国佛教发展史略": "中国佛教发展史略述",
    "《金刚经》说什么": "金刚经说什么",
    "《楞严》大义今释": "楞严大义今释",
    "《圆觉经》略说": "圆觉经略说",
    "《药师经》的济世观": "药师经的济世观",
    "廿一世纪初的前言后语": "廿一世纪初的前言后语",
    "二十一世纪初的前言后语": "廿一世纪初的前言后语",
    "南怀瑾讲演录2004-2006": "南怀瑾讲演录",
    "漫谈中国文化——金融·企业·国学": "漫谈中国文化",
    "亦新亦旧的一代": "新旧教育的变与惑",
    "瑜伽师地论讲座": "瑜伽师地论 声闻地讲录",
    "南《瑜伽师地论》": "瑜伽师地论 声闻地讲录",
    "人生的起点和终站": "人生的起点和终站",
}


def _normalize_work_name(work):
    """将作品名标准化为 EPUB 标准名（如果存在映射）。"""
    return WORK_NAME_ALIASES.get(work, work)


def _is_epub_covered(work):
    """检查作品是否已被 EPUB 覆盖（含名称变体）。"""
    return work in EPUB_WORKS or _normalize_work_name(work) in EPUB_WORKS

OUT_INDEX = os.path.join(PROJECT_DIR, "search_index.json")
OUT_MANIFEST = os.path.join(PROJECT_DIR, "works_manifest.json")
OUT_VERSION = os.path.join(PROJECT_DIR, "index_version.json")
OUT_EMBEDDINGS = os.path.join(PROJECT_DIR, "embeddings.bin")
EMBEDDING_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"
EMBEDDING_DIM = 384
# chunk 默认 500 字、重叠 80 字。索引前 420 字可与下一 chunk 的前部
# 连续覆盖正文，避免旧版只索引前 60 字造成的大量漏召回。
TEXT_PREVIEW_LEN = 420


def sanitize_filename(name):
    """将作品名转为安全的文件名（保留中文）。"""
    # 替换文件系统不安全字符
    name = re.sub(r'[\\/:*?"<>|]', '_', name)
    # 去除首尾空格和点
    name = name.strip('. ')
    return name


def load_chunks():
    """加载所有 chunk JSONL，返回统一格式的 chunk 列表。

    EPUB 数据优先：如果某部作品在 EPUB 中已有完整数据，则跳过
    其他来源中同名作品的 chunk（避免网页抓取的劣质版本覆盖 EPUB）。
    """
    chunks = []
    seen_ids = set()
    epub_works_seen = set()  # 从 EPUB 中已加载的作品
    stats = {}
    skipped_by_epub = {}     # 记录被 EPUB 跳过的统计

    for fname in CHUNK_FILES:
        fpath = os.path.join(RAG_DIR, fname)
        if not os.path.exists(fpath):
            print(f"  ⚠ 跳过（文件不存在）: {fname}")
            continue

        is_epub = fname.startswith("epub_")
        count = 0
        skipped_count = 0
        with open(fpath, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                work = obj.get("work", "未知")

                # 非 EPUB 来源：如果该作品已由 EPUB 覆盖，跳过
                if not is_epub and _is_epub_covered(work):
                    skipped_count += 1
                    continue

                # 统一 id 字段（不同来源的 JSONL 字段名略有差异）
                chunk_id = obj.get("id", "")
                if not chunk_id:
                    # 用 work + chapter_no 构造 id
                    ch_no = obj.get("chapter_no", obj.get("chunk_no", 0))
                    chunk_id = f"{work}:{ch_no:04d}"

                if chunk_id in seen_ids:
                    continue
                seen_ids.add(chunk_id)

                if is_epub:
                    epub_works_seen.add(work)

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

        stats[fname] = {"loaded": count, "skipped": skipped_count}
        if skipped_count > 0:
            print(f"  ✓ {fname}: {count} chunks (跳过 {skipped_count} — 已由 EPUB 覆盖)")
        else:
            print(f"  ✓ {fname}: {count} chunks")
    print(f"  EPUB 覆盖作品数: {len(epub_works_seen)}")

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


def build_embeddings(chunks):
    """为所有 chunk 生成 int8 量化的语义向量。

    返回 (dim, buffer, scale_min, scale_max) 或 None（如果依赖未安装或网络不可达）。
    buffer 是 bytes，包含 N×dim 个 int8 值。
    """
    if not HAS_SENTENCE_TRANSFORMERS:
        print("  ⚠ sentence-transformers 未安装，跳过语义向量生成")
        print("    安装: pip install sentence-transformers")
        return None

    print(f"  加载模型 {EMBEDDING_MODEL}...")
    # 尝试使用国内镜像（hf-mirror.com）加速下载
    import numpy as np
    try:
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        model = SentenceTransformer(EMBEDDING_MODEL)
    except Exception as e:
        print(f"  ⚠ 模型加载失败: {e}")
        print("    提示: 如果网络不通，可以设置环境变量 HF_ENDPOINT=https://hf-mirror.com")
        print("    或者下载模型到本地后用 --model-path 指定路径")
        return None
    dim = model.get_sentence_embedding_dimension()
    print(f"  向量维度: {dim}")

    # 为每个 chunk 构建用于 embedding 的文本
    texts = []
    for c in chunks:
        # 用作品名 + 章节标题 + 前 200 字作为 embedding 输入
        title_part = f"{c['work']} {c['chapter_title']}".strip()
        body_preview = c["text"][:200].replace("\n", " ")
        texts.append(f"{title_part}: {body_preview}")

    print(f"  正在编码 {len(texts)} 个片段（可能需要 10-30 分钟）...")
    embeddings = model.encode(
        texts,
        batch_size=64,
        show_progress_bar=True,
        normalize_embeddings=True,  # L2 归一化，方便客户端用点积代替余弦相似度
    )

    # int8 量化：float32 → int8（min-max 线性量化）
    import numpy as np
    float_min = float(embeddings.min())
    float_max = float(embeddings.max())
    scale = 255.0 / (float_max - float_min) if float_max != float_min else 1.0
    quantized = np.clip(
        ((embeddings - float_min) * scale).astype(np.int32),
        0, 255
    ).astype(np.uint8)

    # 打包为二进制：dim(4B) + quantized(N×dim bytes) + min(4B) + max(4B)
    buffer = struct.pack("<I", dim)
    buffer += quantized.tobytes()
    buffer += struct.pack("<ff", float_min, float_max)

    return dim, buffer, float_min, float_max


def main():
    parser = argparse.ArgumentParser(description="构建静态 RAG 语料与检索索引")
    parser.add_argument(
        "--skip-embeddings",
        action="store_true",
        help="保留现有 embeddings.bin，不重新运行耗时的向量模型",
    )
    args = parser.parse_args()

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

    # 生成版本文件（客户端用于判断是否需要重新下载索引）
    from datetime import datetime, timezone
    version = {
        "v": datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S"),
        "chunks": len(search_index),
        "size": index_size,
    }
    with open(OUT_VERSION, 'w', encoding='utf-8') as f:
        json.dump(version, f, ensure_ascii=False, separators=(',', ':'))
    print(f"  ✓ index_version.json: v{version['v']}")

    # 3. 生成 corpus
    print("\n[3/4] 生成全文语料（按作品分片）...")
    manifest, corpus_total = build_corpus(chunks)
    with open(OUT_MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"  ✓ works_manifest.json: {len(manifest)} 部作品")
    print(f"  ✓ corpus/ 总大小: {corpus_total/1024/1024:.1f} MB")

    # 4. 生成语义向量（可选）
    print("\n[4/5] 生成语义向量...")
    emb_result = None if args.skip_embeddings else build_embeddings(chunks)
    if args.skip_embeddings:
        print("  ↷ 已按参数跳过语义向量生成")
    if emb_result:
        dim, emb_buffer, emb_min, emb_max = emb_result
        with open(OUT_EMBEDDINGS, 'wb') as f:
            f.write(emb_buffer)
        emb_size = os.path.getsize(OUT_EMBEDDINGS)
        print(f"  ✓ embeddings.bin: {dim} 维, {len(chunks)} 条, {emb_size/1024:.0f} KB")

        # 更新版本文件
        version["embeddings"] = {
            "dim": dim,
            "size": emb_size,
        }
        with open(OUT_VERSION, 'w', encoding='utf-8') as f:
            json.dump(version, f, ensure_ascii=False, separators=(',', ':'))
        print(f"  ✓ index_version.json 已更新（含 embeddings 信息）")

    # 5. 汇总
    print("\n[5/5] 生成完毕！")
    print(f"""
  输出文件:
    {OUT_INDEX}   ({index_size/1024:.0f} KB)
    {OUT_VERSION}   ({os.path.getsize(OUT_VERSION)} B)
    {OUT_MANIFEST}   ({os.path.getsize(OUT_MANIFEST)/1024:.0f} KB)""")
    if emb_result:
        print(f"    {OUT_EMBEDDINGS}   ({emb_size/1024:.0f} KB)")
    print(f"""    {CORPUS_DIR}/   ({len(manifest)} 个文件, {corpus_total/1024/1024:.1f} MB)

  作品统计: {len(manifest)} 部
  总 chunks: {len(chunks)}
  总字数: {sum(c['char_count'] for c in chunks):,}

  gzip 预估（CDN 自动压缩）:
    搜索索引: ~{index_size/1024/4:.0f} KB""")
    if emb_result:
        print(f"    语义向量: ~{emb_size/1024/4:.0f} KB")
    print(f"""    全文语料: ~{corpus_total/1024/1024/4:.0f} MB

  下一步: 将 corpus/ search_index.json embeddings.bin works_manifest.json
          与 index.html app.js styles.css 一起部署到 GitHub Pages。
""")


if __name__ == "__main__":
    main()
