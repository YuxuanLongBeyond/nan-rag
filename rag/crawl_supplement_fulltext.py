#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crawl_supplement_fulltext.py — 补充抓取南怀瑾著作(分散来源),输出 JSONL。

针对《大全.jpg》中缺失但在 quanxue.cn / shixiu.net / guoxue.r12345.com
之外的网站上可以找到的著作,逐一抓取。

当前抓取:
  - 中国文化与佛学八讲 (nianjue.org, 单页, ~3万字)
  - 人生的起点和终站 (book853.com, 分页, ~6讲)

⚠️ 授权闸门:南怀瑾先生著作仍在著作权保护期内。本脚本仅在
   "公版 / 开放许可 / 你已明确获得授权" 的情况下使用。
   运行必须显式加 --i-have-authorization,否则拒绝执行。

断点续传:已抓的 chapter_url 会被跳过(append 模式)。
"""

import argparse
import json
import re
import sys
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

OUT_DEFAULT = "supplement_documents.jsonl"
ERRORS_DEFAULT = "supplement_crawl_errors.jsonl"
UA = "rag-corpus-builder/0.1 (local; authorized use)"
TODAY = "2026-07-11"

# ── 预定义抓取清单 ──────────────────────────────────────────
# 每个条目: {work, category, source_label, urls, extractor}
# extractor 是函数名,负责从 HTML 提取 (title, text)
PREBUILT = [
    {
        "work": "中国文化与佛学八讲",
        "category": "佛家典籍解读",
        "source_label": "nianjue.org",
        "urls": [
            ("全文", "https://nianjue.org/article/47/470133.html"),
        ],
        "single_page": True,  # 全部内容在一个页面
    },
    {
        "work": "人生的起点和终站",
        "category": "佛家典籍解读",
        "source_label": "book853.com",
        "urls": [
            ("第一讲 纽约的寺庙", "http://book853.com/show.aspx?id=1688&cid=44"),
            ("第一讲 前生后世的问题", "http://book853.com/show.aspx?id=1688&cid=44&page=3"),
            ("第一讲 因果的科学性", "http://book853.com/show.aspx?id=1688&cid=44&page=4"),
            ("第一讲 变易生死分段生死", "http://book853.com/show.aspx?id=1688&cid=44&page=5"),
            ("第一讲 我们都是化身", "http://book853.com/show.aspx?id=1688&cid=44&page=6"),
            ("第一讲 道理分四种", "http://book853.com/show.aspx?id=1688&cid=44&page=7"),
            ("第二讲", "http://book853.com/show.aspx?id=1688&cid=44&page=8"),
            ("第三讲", "http://book853.com/show.aspx?id=1688&cid=44&page=9"),
            ("第四讲", "http://book853.com/show.aspx?id=1688&cid=44&page=10"),
        ],
        "single_page": False,
    },
]


def fetch(url, timeout, retries, delay, session, encoding_hint=None):
    """带指数退避的重试 GET,返回 HTML 文本。"""
    last_err = None
    for attempt in range(retries + 1):
        try:
            resp = session.get(url, timeout=timeout, verify=False)
            resp.raise_for_status()
            if encoding_hint:
                resp.encoding = encoding_hint
            elif resp.encoding is None or resp.encoding.lower() == "iso-8859-1":
                resp.encoding = resp.apparent_encoding or "utf-8"
            return resp.text
        except Exception as e:
            last_err = e
            if attempt < retries:
                backoff = (2 ** attempt) * 0.5
                time.sleep(backoff)
    raise last_err


def extract_nianjue(html):
    """从 nianjue.org 页面提取标题和正文。"""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    title = ""
    for sel in ["h1", "h2", ".article-title"]:
        node = soup.select_one(sel) if sel.startswith(".") else soup.find(sel)
        if node:
            t = node.get_text(separator=" ", strip=True)
            if t and len(t) > 3:
                title = re.split(r"\s*[—\-|]\s*", t)[0].strip()
                break
    if not title:
        tnode = soup.find("title")
        if tnode:
            t = tnode.get_text(separator=" ", strip=True)
            t = re.split(r"\s*[—\-|]\s*", t)[0].strip()
            if t:
                title = t

    # 尝试找到主要内容区域
    body = None
    for sel in [".article-content", ".article_body", "#article_content",
                 ".post-content", ".entry-content", ".content"]:
        node = soup.select_one(sel)
        if node:
            body = node
            break
    if body is None:
        body = soup.body or soup

    text = body.get_text(separator="\n", strip=True)
    text = re.sub(r"\n{3,}", "\n\n", text)

    # 清理页首导航噪音
    text = _clean_nianjue_header(text)

    return title, text.strip()


def _clean_nianjue_header(text):
    """移除 nianjue.org 页面顶部的导航/面包屑/相关文章列表。"""
    lines = text.split("\n")
    # 找到真正的正文开始位置(通常以标题开头)
    start_idx = 0
    nav_keywords = ["念覺學佛網", "積德改命", "深信因果", "素食護生",
                    "戒除邪淫", "佛教故事", "佛教知識", "法師開示",
                    "戒殺放生", "學佛感應", "幸福人生", "熱門文章",
                    "居士文章", "大德居士", "念覺學佛網", ">>"]
    for i, line in enumerate(lines):
        stripped = line.strip()
        # 跳过明显的导航行
        if any(kw in stripped for kw in nav_keywords):
            start_idx = i + 1
            continue
        # 到达正文(通常以标题或"第X讲"开始)
        if len(stripped) > 10 and ("中國文化與佛學" in stripped or
                                    "中国文化与佛学" in stripped or
                                    "第" in stripped[:5]):
            start_idx = i
            break
    return "\n".join(lines[start_idx:])


def extract_book853(html):
    """从 book853.com 页面提取标题和正文。"""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    title = ""
    for sel in ["h1", "h2", "h3"]:
        node = soup.find(sel)
        if node:
            t = node.get_text(separator=" ", strip=True)
            if t and len(t) > 2:
                title = t
                break
    if not title:
        tnode = soup.find("title")
        if tnode:
            t = tnode.get_text(separator=" ", strip=True)
            t = re.split(r"\s*[—\-|]\s*", t)[0].strip()
            if t:
                title = t

    # 找到主要内容的 div
    body = None
    for sel in ["#content", ".content", "#main", "article", ".article"]:
        node = soup.select_one(sel)
        if node:
            body = node
            break
    if body is None:
        body = soup.body or soup

    # 移除导航链接区域
    for tag in body.find_all(["a", "script", "style"]):
        tag.decompose()

    text = body.get_text(separator="\n", strip=True)
    text = re.sub(r"\n{3,}", "\n\n", text)

    # 清理导航噪音
    text = _clean_book853(text)

    return title, text.strip()


def _clean_book853(text):
    """移除 book853.com 页面的导航/侧边栏噪音。"""
    lines = text.split("\n")
    # 找到正文开始
    start_idx = 0
    nav_phrases = ["主站：", "七葉佛教中心", "支持書舍的建設",
                   "書本報錯", "留言板", "你好", "登錄", "註冊",
                   "搜索", "知名法師", "初入佛門", "佛理專研",
                   "佛教徒生活", "深入經藏", "淨土經典", "淨宗專集",
                   "淨土法師文集", "禪宗專集", "藏傳佛教", "因果感應",
                   "素食放生", "教史傳記", "一門深入", "佛典故事",
                   "戒律規行", "咒偈儀軌", "長篇套書", "精選文集",
                   "民間善書", "健康書籍", "贊助方式", "戒邪淫網",
                   "首頁", "Facebook"]
    for i, line in enumerate(lines):
        stripped = line.strip()
        if any(phrase in stripped for phrase in nav_phrases):
            start_idx = i + 1
            continue
        if len(stripped) > 10:
            start_idx = i
            break

    # 清理尾部广告/版权
    end_idx = len(lines)
    tail_phrases = ["Copyright", "©", "版權所有", "Powered by",
                    "分享到", "Facebook", "Line", "Twitter"]
    for i in range(len(lines) - 1, -1, -1):
        stripped = lines[i].strip()
        if any(phrase in stripped for phrase in tail_phrases):
            end_idx = i
        elif len(stripped) > 5:
            break

    return "\n".join(lines[start_idx:end_idx])


def load_done(out_path):
    """读取已有输出,返回已抓 chapter_url 集合(断点续传)。"""
    done = set()
    try:
        with open(out_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    if obj.get("chapter_url"):
                        done.add(obj["chapter_url"])
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        pass
    return done


def crawl_single_page_work(work_info, args, session, done, out_fp, err_fp, global_no):
    """抓取单页型作品:全部内容在一个 URL 中。"""
    n_new = 0
    n_skip = 0
    chapter_counter = global_no

    for ci, (label, url) in enumerate(work_info["urls"], 1):
        if url in done:
            n_skip += 1
            continue
        try:
            html = fetch(url, args.timeout, args.retries, args.delay, session)

            if "nianjue" in work_info["source_label"]:
                title, text = extract_nianjue(html)
            else:
                title, text = extract_nianjue(html)  # fallback

            chapter_title = label or title or "untitled"
            chapter_counter += 1
            rec = {
                "work": work_info["work"],
                "category": work_info["category"],
                "work_url": url,
                "chapter_no": chapter_counter,
                "chapter_no_in_work": ci,
                "chapter_title": chapter_title,
                "chapter_url": url,
                "char_count": len(text),
                "text": text,
                "retrieved": TODAY,
                "source": work_info["source_label"],
            }
            out_fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out_fp.flush()
            done.add(url)
            n_new += 1
            print(f"   [{ci}] {chapter_title} ({len(text)} 字)", flush=True)
        except Exception as e:
            err_fp.write(json.dumps(
                {"stage": "chapter", "work": work_info["work"], "url": url,
                 "error": str(e)}, ensure_ascii=False) + "\n")
            err_fp.flush()
            print(f"   [{ci}] !! 失败: {e}", flush=True)
        time.sleep(args.delay)

    return n_new, n_skip, chapter_counter


def crawl_multi_page_work(work_info, args, session, done, out_fp, err_fp, global_no):
    """抓取分页型作品:多个 URL 按序抓取并合并为章节。"""
    n_new = 0
    n_skip = 0
    chapter_counter = global_no

    for ci, (label, url) in enumerate(work_info["urls"], 1):
        if url in done:
            n_skip += 1
            continue
        try:
            html = fetch(url, args.timeout, args.retries, args.delay, session)

            if "book853" in work_info["source_label"]:
                title, text = extract_book853(html)
            else:
                title, text = extract_book853(html)  # fallback

            chapter_title = label or title or "untitled"
            chapter_counter += 1
            rec = {
                "work": work_info["work"],
                "category": work_info["category"],
                "work_url": work_info["urls"][0][1],  # first URL as work_url
                "chapter_no": chapter_counter,
                "chapter_no_in_work": ci,
                "chapter_title": chapter_title,
                "chapter_url": url,
                "char_count": len(text),
                "text": text,
                "retrieved": TODAY,
                "source": work_info["source_label"],
            }
            out_fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out_fp.flush()
            done.add(url)
            n_new += 1
            print(f"   [{ci}/{len(work_info['urls'])}] {chapter_title} ({len(text)} 字)", flush=True)
        except Exception as e:
            err_fp.write(json.dumps(
                {"stage": "chapter", "work": work_info["work"], "url": url,
                 "error": str(e)}, ensure_ascii=False) + "\n")
            err_fp.flush()
            print(f"   [{ci}] !! 失败: {e}", flush=True)
        time.sleep(args.delay)

    return n_new, n_skip, chapter_counter


def main():
    ap = argparse.ArgumentParser(description="补充抓取南怀瑾著作(分散来源) → JSONL")
    ap.add_argument("--i-have-authorization", action="store_true",
                    help="确认内容为公版/开放许可/已获授权。必填闸门。")
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--errors", default=ERRORS_DEFAULT)
    ap.add_argument("--delay", type=float, default=0.5, help="请求间隔(秒)")
    ap.add_argument("--timeout", type=int, default=20)
    ap.add_argument("--retries", type=int, default=3)
    args = ap.parse_args()

    if not args.i_have_authorization:
        sys.exit(
            "本脚本仅用于公版/开放许可/已获授权内容。\n"
            "南怀瑾先生著作仍在著作权保护期内,确认你已获得授权后,加 --i-have-authorization 再运行。"
        )

    # 禁用 SSL 警告(部分站点证书可能有问题)
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    done = load_done(args.out)
    session = requests.Session()
    session.headers.update({"User-Agent": UA})

    err_fp = open(args.errors, "a", encoding="utf-8")
    out_fp = open(args.out, "a", encoding="utf-8")
    total_new = 0
    total_skip = 0
    global_no = 0

    for wi, work_info in enumerate(PREBUILT, 1):
        work_title = work_info["work"]
        print(f"[{wi}/{len(PREBUILT)}] {work_title} ({work_info['source_label']})", flush=True)

        if work_info.get("single_page", False):
            n_new, n_skip, global_no = crawl_single_page_work(
                work_info, args, session, done, out_fp, err_fp, global_no)
        else:
            n_new, n_skip, global_no = crawl_multi_page_work(
                work_info, args, session, done, out_fp, err_fp, global_no)

        total_new += n_new
        total_skip += n_skip

    out_fp.close()
    err_fp.close()
    print(f"\n完成:新抓 {total_new},跳过(已存在) {total_skip}。")
    print(f"  输出: {args.out}")


if __name__ == "__main__":
    main()
