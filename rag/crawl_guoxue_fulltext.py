#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crawl_guoxue_fulltext.py — 抓取 guoxue.r12345.com 南怀瑾著作章节全文,输出 JSONL。

guoxue.r12345.com 是实修驿站(shixiu.net)的镜像站,但 HTML 更干净(UTF-8,
无 GBK 乱码问题,页面导航噪音少)。适合抓取 shixiu.net 上质量较差的著作。

当前抓取:
  - 维摩诘的花雨满天 (花雨满天维摩说法): 17章, ~52万字
  - 瑜伽师地论讲座: 3章, ~3万字
  - 宗镜录略讲（guoxue版）: 9章, ~62万字

⚠️ 授权闸门:南怀瑾先生著作仍在著作权保护期内。本脚本仅在
   "公版 / 开放许可 / 你已明确获得授权" 的情况下使用。
   运行必须显式加 --i-have-authorization,否则拒绝执行。

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

SITE = "http://guoxue.r12345.com"
OUT_DEFAULT = "guoxue_documents.jsonl"
ERRORS_DEFAULT = "guoxue_crawl_errors.jsonl"
UA = "rag-corpus-builder/0.1 (local; authorized use)"
TODAY = "2026-07-11"

# ── 预定义抓取清单 ──────────────────────────────────────────
# 格式: (work_title, category, index_url, is_directory)
PREBUILT_LIST = [
    ("维摩诘的花雨满天", "佛家典籍解读",
     f"{SITE}/ext/nanshi/wmsf/index.html", True),
    ("瑜伽师地论讲座", "佛家典籍解读",
     f"{SITE}/ext/nanshi/yqsdn/index.html", True),
    ("宗镜录略讲（guoxue版）", "佛家典籍解读",
     f"{SITE}/ext/nanshi/zjllj/index.html", True),
]

# href 终止符:导航链接,非章节
SKIP_HREF_RE = re.compile(r"^(#|javascript:|mailto:)", re.IGNORECASE)
CHAPTER_HREF_RE = re.compile(r"\.html?$", re.IGNORECASE)

# 导航标签,从章节链接中排除
NAV_LABELS = {"首页", "返回首页", "返回顶部", "南怀瑾老师", "南师著作",
              "返 回", "网站首页", "花雨满天维摩说法"}

# 文本清理:要去掉的行级导航文本
SKIP_LINES = {
    "花雨满天维摩说法", "维摩诘的花雨满天",
    "首页 > 南怀瑾老师 > 南师著作 > 花雨满天维摩说法",
    "首页 > 南怀瑾老师 > 南师著作 > 维摩诘的花雨满天",
}


def slugify(name):
    safe = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    safe = re.sub(r"\s+", "_", safe)
    return safe or "untitled"


def fetch(url, timeout, retries, delay, session):
    """带指数退避的重试 GET,返回 HTML 文本。guoxue.r12345.com 使用 UTF-8。"""
    last_err = None
    for attempt in range(retries + 1):
        try:
            resp = session.get(url, timeout=timeout)
            resp.raise_for_status()
            if resp.encoding is None or resp.encoding.lower() == "iso-8859-1":
                resp.encoding = resp.apparent_encoding or "utf-8"
            return resp.text
        except Exception as e:
            last_err = e
            if attempt < retries:
                backoff = (2 ** attempt) * 0.5
                time.sleep(backoff)
    raise last_err


def extract_chapter_links(html, index_url):
    """从目录页提取章节链接。

    guoxue.r12345.com 的目录页结构:
      <div class="kjwzlb">
        <div class="kjlbbt">花雨满天维摩说法</div>
        <li><a href="4503.html" title="...">...</a></li>
        ...
      </div>

    只保留与 index_url 同目录的相对 .html 链接,排除导航链接。
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
        if label in NAV_LABELS:
            continue
        if absu not in links:
            links[absu] = label
    return list(links.items())


def extract_title_and_body(html):
    """从 guoxue.r12345.com 内容页提取标题和正文。

    ⚠️ guoxue.r12345.com 的 HTML 使用了大量未闭合的 <p> 标签,导致
    BeautifulSoup 的 find_all('p') 产生严重的文本重复(144x-206x)。
    因此本函数使用 body.get_text() 作为主提取路径,不使用 find_all('p')。
    """
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()

    # 提取标题 — 优先用页面顶部的 div.kjbt,其次 <title>
    title = ""
    for sel in ["h1", "h2", "h3"]:
        node = soup.find(sel)
        if node:
            t = node.get_text(separator=" ", strip=True)
            if t:
                title = t
                break

    if not title:
        tnode = soup.find("title")
        if tnode:
            t = tnode.get_text(separator=" ", strip=True)
            t = re.split(r"\s*[—\-]\s*", t)[0].strip()
            if t:
                title = t

    # 主提取路径: body.get_text() — 不受 <p> 嵌套影响
    body = soup.body or soup
    text = body.get_text(separator="\n", strip=True)
    text = re.sub(r"\n{3,}", "\n\n", text)

    # 清理文末导航(下一篇/上一篇/网站首页等)
    text = _clean_trailing_nav(text)

    return title, text.strip()


def _clean_trailing_nav(text):
    """移除文末的导航文字(下一篇/上一篇/网站首页等)。"""
    nav_patterns = [
        r"^《花雨满天维摩说法》\s*$",
        r"^下一篇[：:].*",
        r"^上一篇[：:].*",
        r"^网站首页\s*$",
        r"^返\s*回\s*$",
        r"^首页\s*>\s*南怀瑾老师.*$",
    ]
    lines = text.split("\n")
    # 从末尾向前移除匹配导航模式的行,以及紧邻的章节名行
    while lines:
        last = lines[-1].strip()
        if not last:
            lines.pop()
            continue
        if any(re.match(pat, last) for pat in nav_patterns):
            lines.pop()
            # 也移除紧邻的纯章节名行(如 "佛国品第一")
            while lines and lines[-1].strip() and not any(
                re.match(pat, lines[-1].strip()) for pat in nav_patterns
            ):
                # 只移除不含标点的短行(典型的章节名)
                if len(lines[-1].strip()) < 30 and not re.search(r'[，。！？；：、""''（）]', lines[-1]):
                    lines.pop()
                else:
                    break
        else:
            break
    return "\n".join(lines)


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
                         done, out_fp, err_fp, global_no_start):
    """抓取目录型作品:先取 index → 提取章节链接 → 逐章抓取。"""
    n_new = 0
    n_skip = 0
    n_err = 0
    chapter_counter = global_no_start

    try:
        index_html = fetch(index_url, args.timeout, args.retries, args.delay, session)
    except Exception as e:
        err_fp.write(json.dumps(
            {"stage": "index", "work": work_title, "url": index_url,
             "error": str(e)}, ensure_ascii=False) + "\n")
        err_fp.flush()
        print(f"  !! index 失败: {e}", flush=True)
        return n_new, n_skip, 1, chapter_counter

    time.sleep(args.delay)
    chapters = extract_chapter_links(index_html, index_url)
    if not chapters:
        print(f"  未找到章节链接,跳过", flush=True)
        return n_new, n_skip, n_err, chapter_counter

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
            chapter_counter += 1
            rec = {
                "work": work_title,
                "category": category,
                "work_url": index_url,
                "chapter_no": chapter_counter,
                "chapter_no_in_work": ci,
                "chapter_title": chapter_title,
                "chapter_url": chap_url,
                "char_count": len(text),
                "text": text,
                "retrieved": TODAY,
                "source": "guoxue.r12345.com",
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

    return n_new, n_skip, n_err, chapter_counter


def main():
    ap = argparse.ArgumentParser(description="抓取 guoxue.r12345.com 南怀瑾著作章节全文 → JSONL")
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
    args = ap.parse_args()

    if not args.i_have_authorization:
        sys.exit(
            "本脚本仅用于公版/开放许可/已获授权内容。\n"
            "南怀瑾先生著作仍在著作权保护期内,确认你已获得授权后,加 --i-have-authorization 再运行。"
        )

    done = load_done(args.out)
    session = requests.Session()
    session.headers.update({"User-Agent": UA})

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
    global_no = 0

    for wi, (work_title, category, url, is_dir) in enumerate(works, 1):
        print(f"[{wi}/{total_works}] {work_title}", flush=True)
        if is_dir:
            n_new, n_skip, n_err, global_no = crawl_directory_work(
                work_title, category, url, args, session, done, out_fp, err_fp, global_no)
        else:
            print("  (单篇型暂未实现)", flush=True)
            continue
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
