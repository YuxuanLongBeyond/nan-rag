#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crawl_nanhuaijin_fulltext.py — 抓取南怀瑾专区著作的章节全文,输出 nanhuaijin_documents.jsonl。

⚠️ 授权闸门:南怀瑾先生著作仍在著作权保护期内。本脚本仅在
   "公版 / 开放许可 / 你已明确获得授权" 的情况下使用,与仓库内
   scrape_public_domain_to_md.ps1 的 -ConfirmPublicDomain 同义。
   运行必须显式加 --i-have-authorization,否则拒绝执行。

两段式:作品 index 页 → 章节链接 → 章节正文。
- 断点续传:已抓的 chapter_url 会被跳过(append 模式)。
- 礼貌:自定义 UA + 请求间隔 + 失败指数退避。
- 每章 try/except,出错记入错误文件,不中断整轮。
"""
import argparse
import csv
import json
import re
import sys
import time
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

CATALOG_DEFAULT = "nanhuaijin_catalog.csv"
OUT_DEFAULT = "nanhuaijin_documents.jsonl"
ERRORS_DEFAULT = "nanhuaijin_crawl_errors.jsonl"
UA = "rag-corpus-builder/0.1 (local; authorized use)"
TODAY = "2026-07-06"  # 固定日期,避免脚本内取系统时间造成不一致

# href 终止符:索引/导航页本身,不当作章节
INDEX_HREF_RE = re.compile(r"index\.html?$", re.IGNORECASE)
CHAPTER_HREF_RE = re.compile(r"\.html?$", re.IGNORECASE)
SKIP_HREF_RE = re.compile(r"^(#|javascript:|mailto:)", re.IGNORECASE)


def slugify(name):
    safe = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    safe = re.sub(r"\s+", "_", safe)
    return safe or "untitled"


def fetch(url, timeout, retries, delay, session):
    """带指数退避的重试 GET,返回 HTML 文本。"""
    last_err = None
    for attempt in range(retries + 1):
        try:
            resp = session.get(url, timeout=timeout)
            resp.raise_for_status()
            # 站点多为 UTF-8;requests 的 apparent_encoding 兜底
            if resp.encoding is None or resp.encoding.lower() == "iso-8859-1":
                resp.encoding = resp.apparent_encoding or "utf-8"
            return resp.text
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < retries:
                backoff = (2 ** attempt) * 0.5
                time.sleep(backoff)
    raise last_err


def extract_chapter_links(html, work_url):
    """复用 Get-ChapterLinks 逻辑:同 host、同 base 目录、.html、去重保序、排除自身与 index 页。"""
    work_uri = urlparse(work_url)
    base_dir = work_url[: work_url.rfind("/") + 1]
    soup = BeautifulSoup(html, "html.parser")
    links = {}  # 保序去重
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if SKIP_HREF_RE.match(href):
            continue
        if not CHAPTER_HREF_RE.search(href):
            continue
        if INDEX_HREF_RE.search(href):
            continue  # 索引/导航页,非章节
        absu = urljoin(work_url, href)
        uri = urlparse(absu)
        if uri.netloc != work_uri.netloc:
            continue
        if not absu.startswith(base_dir):
            continue
        if absu == work_url:
            continue
        label = a.get_text(separator=" ", strip=True)
        if not label:
            label = re.sub(r"\.[^.]+$", "", uri.path.rsplit("/", 1)[-1])
        if absu not in links:
            links[absu] = label
    return list(links.items())  # [(url, label), ...]


def extract_title_and_body(html):
    """标题取 h1>h2>h3>title;正文取 body 内 <p> 文本,<p> 过短则回退 whole-body。"""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    title = ""
    for sel in ["h1", "h2", "h3", "title"]:
        node = soup.find(sel)
        if node:
            t = node.get_text(separator=" ", strip=True)
            if t:
                title = t
                break

    body = soup.body or soup
    paras = [p.get_text(separator=" ", strip=True) for p in body.find_all("p")]
    paras = [p for p in paras if p]
    text = "\n\n".join(paras)
    if len(text) < 50:
        text = body.get_text(separator="\n", strip=True)
        text = re.sub(r"\n{3,}", "\n\n", text)
    return title, text.strip()


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


def main():
    ap = argparse.ArgumentParser(description="抓取南怀瑾著作章节全文 → JSONL")
    ap.add_argument("--i-have-authorization", action="store_true",
                    help="确认内容为公版/开放许可/已获授权。必填闸门。")
    ap.add_argument("--catalog", default=CATALOG_DEFAULT)
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--errors", default=ERRORS_DEFAULT)
    ap.add_argument("--delay", type=float, default=0.5, help="请求间隔(秒)")
    ap.add_argument("--timeout", type=int, default=20)
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--max-works", type=int, default=0, help="只抓前 N 部作品(0=全部)")
    ap.add_argument("--max-pages", type=int, default=0, help="每部作品只抓前 N 章(0=全部)")
    ap.add_argument("--work", default="", help="只爬标题包含该子串的作品(大小写无关;可命中多部)")
    ap.add_argument("--include-related", action="store_true", help="也抓 related 纪念/资料类")
    args = ap.parse_args()

    if not args.i_have_authorization:
        sys.exit(
            "本脚本仅用于公版/开放许可/已获授权内容。\n"
            "南怀瑾先生著作仍在著作权保护期内,确认你已获得授权后,加 --i-have-authorization 再运行。"
        )

    done = load_done(args.out)
    session = requests.Session()
    session.headers.update({"User-Agent": UA})

    # 读目录(utf-8-sig 兼容 BOM)
    with open(args.catalog, "r", encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.DictReader(f) if r.get("url")]
    allowed = {"work_or_article"}
    if args.include_related:
        allowed.add("related")
    works = [r for r in rows if r.get("type") in allowed]
    # 只抓 quanxue.cn 源,跳过 shixiu.net / paid_only 等
    works = [r for r in works
             if r.get("source", "quanxue.cn") == "quanxue.cn"]
    if args.work:
        needle = args.work.lower()
        works = [r for r in works if needle in r.get("title", "").lower()]
        if not works:
            sys.exit(f"没有标题包含 {args.work!r} 的作品。")
        if len(works) > 1:
            print(f"--work {args.work!r} 命中 {len(works)} 部,将全部抓取:", file=sys.stderr)
            for r in works:
                print(f"  - {r.get('title')}", file=sys.stderr)
    if args.max_works > 0:
        works = works[: args.max_works]

    total_works = len(works)
    err_fp = open(args.errors, "a", encoding="utf-8")
    out_fp = open(args.out, "a", encoding="utf-8")
    global_no = 0
    n_new = 0
    n_skip = 0
    n_err = 0

    for wi, work in enumerate(works, 1):
        work_title = work.get("title", "").strip()
        category = work.get("category", "").strip()
        work_url = work["url"].strip()

        # 1) 取作品 index 页 → 章节列表
        try:
            index_html = fetch(work_url, args.timeout, args.retries, args.delay, session)
        except Exception as e:  # noqa: BLE001
            err_fp.write(json.dumps(
                {"stage": "index", "work": work_title, "url": work_url,
                 "error": str(e)}, ensure_ascii=False) + "\n")
            err_fp.flush()
            n_err += 1
            print(f"[{wi}/{total_works}] !! index 失败 {work_title}: {e}", flush=True)
            continue
        time.sleep(args.delay)

        chapters = extract_chapter_links(index_html, work_url)
        # 单页作品兜底:把 index 页本身当作唯一章节
        single_page = False
        if not chapters:
            chapters = [(work_url, work_title)]
            single_page = True
        if args.max_pages > 0:
            chapters = chapters[: args.max_pages]

        print(f"[{wi}/{total_works}] {work_title} — {len(chapters)} 章"
              f"{' (单页兜底)' if single_page else ''}", flush=True)

        for ci, (chap_url, chap_label) in enumerate(chapters, 1):
            if chap_url in done:
                n_skip += 1
                continue
            try:
                html = fetch(chap_url, args.timeout, args.retries, args.delay, session)
                title, text = extract_title_and_body(html)
                chapter_title = chap_label or title or "untitled"
                global_no += 1
                rec = {
                    "work": work_title,
                    "category": category,
                    "work_url": work_url,
                    "chapter_no": global_no,
                    "chapter_no_in_work": ci,
                    "chapter_title": chapter_title,
                    "chapter_url": chap_url,
                    "char_count": len(text),
                    "text": text,
                    "retrieved": TODAY,
                }
                out_fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
                out_fp.flush()
                done.add(chap_url)
                n_new += 1
                print(f"   [{ci}/{len(chapters)}] {chapter_title} ({len(text)} 字)", flush=True)
            except Exception as e:  # noqa: BLE001
                err_fp.write(json.dumps(
                    {"stage": "chapter", "work": work_title, "url": chap_url,
                     "error": str(e)}, ensure_ascii=False) + "\n")
                err_fp.flush()
                n_err += 1
                print(f"   [{ci}/{len(chapters)}] !! 失败 {chap_url}: {e}", flush=True)
            time.sleep(args.delay)

    out_fp.close()
    err_fp.close()
    print(f"\n完成:新抓 {n_new},跳过(已存在) {n_skip},失败 {n_err}。", flush=True)
    print(f"  输出: {args.out}", flush=True)
    if n_err:
        print(f"  错误: {args.errors}", flush=True)


if __name__ == "__main__":
    main()
