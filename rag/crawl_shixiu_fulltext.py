#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crawl_shixiu_fulltext.py — 抓取实修驿站(shixiu.net)南怀瑾著作章节全文,输出 JSONL。

补充 quanxue.cn 缺失的南怀瑾著作:
  - 中庸讲记(录音整理,19集)
  - 楞严经讲座(录音整理,68集,~107万字)
  - 答问青壮年参禅者(部分)
  - 漫谈中国文化(部分)
  - 南怀瑾老师诗词选辑
  注: 维摩诘的花雨满天 已移至 crawl_guoxue_fulltext.py

⚠️ 授权闸门:南怀瑾先生著作仍在著作权保护期内。本脚本仅在
   "公版 / 开放许可 / 你已明确获得授权" 的情况下使用。
   运行必须显式加 --i-have-authorization,否则拒绝执行。

站点结构(shixiu.net,编码 gbk):
  目录型: /nanshi/zhuzuo/{slug}/ → 列出章节链接 → 每章一个 .html
  单篇型: /nanshi/zhuzuo/qt/{id}.html → 直接内容

断点续传:已抓的 chapter_url 会被跳过(append 模式)。
礼貌:自定义 UA + 请求间隔 + 失败指数退避。
每章 try/except,出错记入错误文件,不中断整轮。
"""

import argparse
import json
import re
import sys
import time
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

SITE = "http://m.shixiu.net"
OUT_DEFAULT = "shixiu_documents.jsonl"
ERRORS_DEFAULT = "shixiu_crawl_errors.jsonl"
UA = "rag-corpus-builder/0.1 (local; authorized use)"
TODAY = "2026-07-11"

# ── 预定义抓取清单 ──────────────────────────────────────────
# 格式: (work_title, category, index_url, is_directory)
# is_directory=True: index_url 是目录页,需要先抓章节链接再逐章抓
# is_directory=False: index_url 就是内容页,直接抓
PREBUILT_LIST = [
    # 录音整理讲记(quanxue.cn 缺失)
    ("中庸讲记（录音整理）", "录音整理讲记",
     f"{SITE}/nanshi/zhuzuo/zhongyong/", True),
    ("楞严经讲座（录音整理）", "录音整理讲记",
     f"{SITE}/nanshi/zhuzuo/lyjjz/", True),

    # 佛家典籍(quanxue.cn 可能不全)
    # 注: 维摩诘的花雨满天 已移至 crawl_guoxue_fulltext.py(guoxue.r12345.com 源更干净)
    ("禅秘要法（录音整理）", "打坐禅定",
     f"{SITE}/nanshi/zhuzuo/cmyf/", True),

    # 单篇/部分内容
    ("答问青壮年参禅者", "打坐禅定",
     f"{SITE}/nanshi/zhuzuo/qt/4880.html", False),
    ("漫谈中国文化", "南怀瑾杂文集",
     f"{SITE}/nanshi/zhuzuo/qt/4881.html", False),
    ("南怀瑾老师诗词选辑", "录音整理讲记",
     f"{SITE}/nanshi/zhuzuo/qt/4855.html", False),
    ("南怀瑾先生著作诗词", "录音整理讲记",
     f"{SITE}/nanshi/zhuzuo/qt/4856.html", False),
]

# href 终止符:导航链接,非章节
SKIP_HREF_RE = re.compile(r"^(#|javascript:|mailto:)", re.IGNORECASE)
CHAPTER_HREF_RE = re.compile(r"\.html?$", re.IGNORECASE)


def slugify(name):
    safe = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    safe = re.sub(r"\s+", "_", safe)
    return safe or "untitled"


def fetch(url, timeout, retries, delay, session):
    """带指数退避的重试 GET,返回 HTML 文本(shixiu.net 编码为 gbk)。"""
    last_err = None
    for attempt in range(retries + 1):
        try:
            resp = session.get(url, timeout=timeout)
            resp.raise_for_status()
            # shixiu.net 使用 gbk 编码
            if resp.encoding is None or resp.encoding.lower() == "iso-8859-1":
                resp.encoding = "gbk"
            return resp.text
        except Exception as e:
            last_err = e
            if attempt < retries:
                backoff = (2 ** attempt) * 0.5
                time.sleep(backoff)
    raise last_err


def extract_chapter_links(html, index_url):
    """从目录页提取章节链接列表。
    shixiu.net 目录页:章节链接在 <a href='slug/XXXX.html'> 中。
    只保留与 index_url 同目录的 .html 链接,排除 index_url 自身和返回首页的链接。
    """
    base_dir = index_url[: index_url.rfind("/") + 1]
    soup = BeautifulSoup(html, "html.parser")
    links = {}  # 保序去重
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if SKIP_HREF_RE.match(href):
            continue
        if not CHAPTER_HREF_RE.search(href):
            continue
        absu = urljoin(index_url, href)
        if not absu.startswith(base_dir):
            continue
        if absu == index_url:
            continue
        label = a.get_text(separator=" ", strip=True)
        if not label:
            label = re.sub(r"\.[^.]+$", "", absu.rsplit("/", 1)[-1])
        # 跳过明显的导航链接
        if label in ("首页", "返回首页", "返回顶部", "南怀瑾老师", "南师著作"):
            continue
        if absu not in links:
            links[absu] = label
    return list(links.items())


def extract_title_and_body(html):
    """从 shixiu.net 内容页提取标题和正文。"""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    title = ""
    for sel in ["h1", "h2", "h3", "title"]:
        node = soup.find(sel)
        if node:
            t = node.get_text(separator=" ", strip=True)
            if t:
                # title 标签通常包含 "--手机实修驿站" 等后缀,截断
                if sel == "title":
                    t = re.split(r"\s*[—\-|]\s*", t)[0].strip()
                if t:
                    title = t
                    break

    body = soup.body or soup
    # 移除导航和广告
    for tag in body.find_all(["a", "script", "style"]):
        tag.decompose()

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


def crawl_directory_work(work_title, category, index_url, args, session,
                         done, out_fp, err_fp):
    """抓取目录型作品:先取 index → 提取章节链接 → 逐章抓取。"""
    n_new = 0
    n_skip = 0
    n_err = 0

    try:
        index_html = fetch(index_url, args.timeout, args.retries, args.delay, session)
    except Exception as e:
        err_fp.write(json.dumps(
            {"stage": "index", "work": work_title, "url": index_url,
             "error": str(e)}, ensure_ascii=False) + "\n")
        err_fp.flush()
        print(f"  !! index 失败: {e}", flush=True)
        return n_new, n_skip, 1

    time.sleep(args.delay)
    chapters = extract_chapter_links(index_html, index_url)
    if not chapters:
        print(f"  未找到章节链接,跳过", flush=True)
        return n_new, n_skip, n_err

    if args.max_pages > 0:
        chapters = chapters[: args.max_pages]

    print(f"  {len(chapters)} 章", flush=True)

    for ci, (chap_url, chap_label) in enumerate(chapters, 1):
        if chap_url in done:
            n_skip += 1
            continue
        try:
            html = fetch(chap_url, args.timeout, args.retries, args.delay, session)
            title, text = extract_title_and_body(html)
            chapter_title = chap_label or title or "untitled"
            rec = {
                "work": work_title,
                "category": category,
                "work_url": index_url,
                "chapter_no": ci,
                "chapter_title": chapter_title,
                "chapter_url": chap_url,
                "char_count": len(text),
                "text": text,
                "retrieved": TODAY,
                "source": "shixiu.net",
            }
            out_fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out_fp.flush()
            done.add(chap_url)
            n_new += 1
            print(f"   [{ci}/{len(chapters)}] {chapter_title} ({len(text)} 字)", flush=True)
        except Exception as e:
            err_fp.write(json.dumps(
                {"stage": "chapter", "work": work_title, "url": chap_url,
                 "error": str(e)}, ensure_ascii=False) + "\n")
            err_fp.flush()
            n_err += 1
            print(f"   [{ci}/{len(chapters)}] !! 失败: {e}", flush=True)
        time.sleep(args.delay)

    return n_new, n_skip, n_err


def crawl_single_work(work_title, category, page_url, args, session,
                      done, out_fp, err_fp):
    """抓取单篇作品:直接抓取页面。"""
    if page_url in done:
        return 0, 1, 0
    try:
        html = fetch(page_url, args.timeout, args.retries, args.delay, session)
        title, text = extract_title_and_body(html)
        chapter_title = title or work_title
        rec = {
            "work": work_title,
            "category": category,
            "work_url": page_url,
            "chapter_no": 1,
            "chapter_title": chapter_title,
            "chapter_url": page_url,
            "char_count": len(text),
            "text": text,
            "retrieved": TODAY,
            "source": "shixiu.net",
        }
        out_fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
        out_fp.flush()
        done.add(page_url)
        print(f"   {chapter_title} ({len(text)} 字)", flush=True)
        return 1, 0, 0
    except Exception as e:
        err_fp.write(json.dumps(
            {"stage": "single", "work": work_title, "url": page_url,
             "error": str(e)}, ensure_ascii=False) + "\n")
        err_fp.flush()
        print(f"  !! 失败: {e}", flush=True)
        return 0, 0, 1


def main():
    ap = argparse.ArgumentParser(description="抓取 shixiu.net 南怀瑾著作章节全文 → JSONL")
    ap.add_argument("--i-have-authorization", action="store_true",
                    help="确认内容为公版/开放许可/已获授权。必填闸门。")
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--errors", default=ERRORS_DEFAULT)
    ap.add_argument("--delay", type=float, default=0.5, help="请求间隔(秒)")
    ap.add_argument("--timeout", type=int, default=20)
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--max-pages", type=int, default=0,
                    help="每部作品只抓前 N 章(0=全部)")
    ap.add_argument("--work", default="",
                    help="只爬标题包含该子串的作品(大小写无关)")
    ap.add_argument("--add-url", default="",
                    help="额外添加一个目录页 URL,格式: 标题|URL (如: 中庸讲记|http://...). 可多次使用 --add-url.")
    args = ap.parse_args()

    if not args.i_have_authorization:
        sys.exit(
            "本脚本仅用于公版/开放许可/已获授权内容。\n"
            "南怀瑾先生著作仍在著作权保护期内,确认你已获得授权后,加 --i-have-authorization 再运行。"
        )

    done = load_done(args.out)
    session = requests.Session()
    session.headers.update({"User-Agent": UA})

    # 构建抓取清单
    works = list(PREBUILT_LIST)
    if args.work:
        needle = args.work.lower()
        works = [(t, c, u, d) for t, c, u, d in works if needle in t.lower()]
        if not works:
            sys.exit(f"没有标题包含 {args.work!r} 的作品。")

    total_works = len(works)
    err_fp = open(args.errors, "a", encoding="utf-8")
    out_fp = open(args.out, "a", encoding="utf-8")
    total_new = 0
    total_skip = 0
    total_err = 0

    for wi, (work_title, category, url, is_dir) in enumerate(works, 1):
        print(f"[{wi}/{total_works}] {work_title}", flush=True)
        if is_dir:
            n_new, n_skip, n_err = crawl_directory_work(
                work_title, category, url, args, session, done, out_fp, err_fp)
        else:
            n_new, n_skip, n_err = crawl_single_work(
                work_title, category, url, args, session, done, out_fp, err_fp)
        total_new += n_new
        total_skip += n_skip
        total_err += n_err

    out_fp.close()
    err_fp.close()
    print(f"\n完成:新抓 {total_new},跳过(已存在) {total_skip},失败 {total_err}。")
    print(f"  输出: {args.out}")
    if total_err:
        print(f"  错误: {args.errors}")


if __name__ == "__main__":
    main()
