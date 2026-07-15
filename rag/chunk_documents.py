#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chunk_documents.py — 把 crawl_nanhuaijin_fulltext.py 产出的 documents.jsonl
切分成嵌入就绪的 chunks.jsonl。

纯本地、无网络、可反复重跑:改 --chunk / --overlap 重新生成,无需重爬。

切分策略(paragraph-aware):
  1. 按 \\n\\n 切成段落(crawler 已用 \\n\\n 连接 <p>);
  2. 超过 chunk 的段落先硬切成 ≤ chunk 的子段;
  3. 贪心地把段落合并进 chunk,相邻 chunk 之间携带 overlap 字符的尾部上下文。

注:chunk 是目标尺寸而非硬上限(为保留段落完整性会有 ±overlap 量级的浮动)。
"""
import argparse
import json
import re

IN_DEFAULT = "nanhuaijin_documents.jsonl"
OUT_DEFAULT = "nanhuaijin_chunks.jsonl"


def slugify(name):
    safe = re.sub(r'[\\/:*?"<>|]', "_", name or "").strip()
    safe = re.sub(r"\s+", "_", safe)
    return safe or "untitled"


def split_oversized(para, chunk, overlap):
    """把单条超长段落切成若干 ≤ chunk 的子段,步长 chunk-overlap。"""
    step = max(1, chunk - overlap)
    pieces = []
    i = 0
    while i < len(para):
        pieces.append(para[i : i + chunk])
        if i + chunk >= len(para):
            break
        i += step
    return pieces


def chunk_text(text, chunk, overlap):
    paras = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
    # 先把超长段落归一成 ≤ chunk 的 unit
    units = []
    for p in paras:
        if len(p) <= chunk:
            units.append(p)
        else:
            units.extend(split_oversized(p, chunk, overlap))

    chunks = []
    buf = ""
    for u in units:
        cand = (buf + "\n\n" + u) if buf else u
        if not buf:
            buf = u
        elif len(cand) <= chunk:
            buf = cand
        else:
            chunks.append(buf)
            carry = buf[-overlap:] if overlap > 0 else ""
            # split_oversized() 已让相邻子段重叠；这里不能再次把同一段
            # carry 拼进去，否则每个 chunk 内会出现一遍重复句。
            if carry and u.startswith(carry):
                buf = u
            else:
                buf = (carry + "\n\n" + u) if carry else u
    if buf:
        chunks.append(buf)
    return [c.strip() for c in chunks if c.strip()]


def main():
    ap = argparse.ArgumentParser(description="documents.jsonl → chunks.jsonl")
    ap.add_argument("--in", dest="inp", default=IN_DEFAULT)
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--chunk", type=int, default=500, help="目标 chunk 字符数")
    ap.add_argument("--overlap", type=int, default=80, help="相邻 chunk 重叠字符数")
    args = ap.parse_args()

    if args.overlap >= args.chunk:
        raise SystemExit(f"--overlap ({args.overlap}) 必须小于 --chunk ({args.chunk})")

    n_docs = 0
    n_chunks = 0
    empty_docs = 0
    with open(args.inp, "r", encoding="utf-8") as fin, \
         open(args.out, "w", encoding="utf-8") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            doc = json.loads(line)
            n_docs += 1
            text = doc.get("text", "") or ""
            work_slug = slugify(doc.get("work", "untitled"))
            chap_no = doc.get("chapter_no", 0)
            pieces = chunk_text(text, args.chunk, args.overlap)
            if not pieces:
                empty_docs += 1
                continue
            for ci, piece in enumerate(pieces, 1):
                rec = {
                    "id": f"{work_slug}:{chap_no:04d}:{ci:03d}",
                    "text": piece,
                    "work": doc.get("work", ""),
                    "category": doc.get("category", ""),
                    "chapter_no": chap_no,
                    "chapter_no_in_work": doc.get("chapter_no_in_work", 0),
                    "chapter_title": doc.get("chapter_title", ""),
                    "source_url": doc.get(
                        "source_url", doc.get("chapter_url", doc.get("work_url", ""))
                    ),
                    "chunk_no": ci,
                    "char_count": len(piece),
                }
                fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n_chunks += 1

    print(f"完成:文档 {n_docs} → chunk {n_chunks}(空文档 {empty_docs} 跳过)。")
    print(f"  平均每文档 {n_chunks / max(1, n_docs - empty_docs):.1f} chunk")
    print(f"  输出: {args.out}")


if __name__ == "__main__":
    main()
