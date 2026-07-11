#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
crawl_weread_fulltext.py — 从微信读书( weread.qq.com )抓取南怀瑾著作全文,输出 JSONL。

依赖: requests (已安装)

使用方法:
  1. 浏览器打开 weread.qq.com 并扫码登录
  2. F12 → Console → 输入: document.cookie → 复制输出
  3. 运行:
     python3 crawl_weread_fulltext.py --i-have-authorization \
       --cookies "wr_skey=xxx; wr_vid=xxx; wr_gid=xxx; ..."

⚠️ 授权闸门: 南怀瑾先生著作仍在著作权保护期内。本脚本仅在
   "公版 / 开放许可 / 你已明确获得授权" 的情况下使用。
   运行必须显式加 --i-have-authorization,否则拒绝执行。

技术说明:
  微信读书对正文做了加密保护。本脚本尝试三种方式获取明文:
    A) 章节 API (e_{chapterUid} 端点,可能直接返回 HTML)
    B) reader 页面解析 (需要解密 key)
    C) 通过 book.qq.com 的 QQ阅读 API (备用)
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from urllib.parse import urljoin

import requests

WEREAD_BASE = "https://weread.qq.com"
QQREAD_BASE = "https://book.qq.com"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
OUT_DEFAULT = "weread_documents.jsonl"
ERRORS_DEFAULT = "weread_crawl_errors.jsonl"
TODAY = "2026-07-11"

# ── 目标作品: 作品名 → 微信读书 bookId ─────────────────────
# bookId 从 weread.qq.com 搜索结果或图书 URL 中获取.
# 已知:
#   大圆满禅定休息简说: https://weread.qq.com/web/reader/609329e0813ab7245g017073
#       → bookId = 609329e0813ab7245g017073 (去掉 reader/ 前缀)
# 用户也可在微信读书中搜索其他目标书,把 bookId 加到这里.
TARGET_BOOKS = [
    {
        "work": "大圆满禅定休息简说",
        "category": "佛家典籍解读",
        "bookId": "609329e0813ab7245g017073",
        "source_label": "微信读书",
    },
    # 以下是待确认 bookId 的:
    # {"work": "禅与生命的认知初讲", "category": "打坐禅定",
    #  "bookId": "???", "source_label": "QQ阅读"},
    # {"work": "南怀瑾讲演录2004-2006", "category": "南怀瑾杂文集",
    #  "bookId": "???", "source_label": "微信读书"},
    # {"work": "南怀瑾与彼得·圣吉", "category": "南怀瑾杂文集",
    #  "bookId": "???", "source_label": "微信读书"},
    # {"work": "洞山指月", "category": "佛家典籍解读",
    #  "bookId": "???", "source_label": "微信读书"},
]


def load_done(out_path):
    """读取已有输出,返回已输出的 (work, chapter_title) 集合(断点续传)。"""
    done = set()
    try:
        with open(out_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    done.add((obj.get("work", ""), obj.get("chapter_title", "")))
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        pass
    return done


def parse_cookies(cookie_str):
    """解析 cookie 字符串为 dict。"""
    cookies = {}
    for item in cookie_str.split(";"):
        item = item.strip()
        if not item:
            continue
        if "=" in item:
            k, v = item.split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies


def verify_auth(session):
    """验证 cookie 是否有效。"""
    try:
        resp = session.get(
            f"{WEREAD_BASE}/web/shelf",
            params={"synckey": "0", "userVid": "0"},
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            if "books" in data or "shelfBooks" in data:
                return True, "shelf OK"
            # 有时即使认证通过也返回空书架
            if "errCode" not in data:
                return True, "shelf response OK (maybe empty)"
        return False, f"HTTP {resp.status_code}: {resp.text[:200]}"
    except Exception as e:
        return False, str(e)


def search_books(session, query):
    """搜索图书,返回 [(bookId, title, author), ...]"""
    try:
        resp = session.get(
            f"{WEREAD_BASE}/web/search/global",
            params={"q": query, "type": "book"},
            timeout=15,
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
        results = []
        for b in data.get("books", []):
            info = b.get("bookInfo", b)
            bid = info.get("bookId", "")
            title = info.get("title", "")
            author = info.get("author", "")
            results.append((bid, title, author))
        return results
    except Exception:
        return []


def get_book_info(session, book_id):
    """获取书籍元数据和目录。返回 (title, author, chapters) 或 (None, None, [])"""
    try:
        resp = session.get(
            f"{WEREAD_BASE}/web/book/info",
            params={"bookId": book_id},
            timeout=15,
        )
        if resp.status_code != 200:
            print(f"    book/info HTTP {resp.status_code}", flush=True)
            return None, None, []

        data = resp.json()
        title = data.get("title", "")
        author = data.get("author", "")

        # 优先用 chapterInfos,否则尝试从 info 中直接取
        chapters = []
        if "chapterInfos" in data:
            chapters = data["chapterInfos"]
        elif "tableOfContents" in data:
            chapters = data["tableOfContents"]

        # 如果没有,单独请求 chapterInfos
        if not chapters:
            try:
                resp2 = session.get(
                    f"{WEREAD_BASE}/web/book/chapterInfos",
                    params={"bookId": book_id},
                    timeout=15,
                )
                if resp2.status_code == 200:
                    chapters = resp2.json().get("data", [])
                    if not chapters:
                        chapters = resp2.json().get("chapters", [])
                    if not chapters and isinstance(resp2.json(), list):
                        chapters = resp2.json()
            except Exception:
                pass

        return title, author, chapters
    except Exception as e:
        print(f"    book/info error: {e}", flush=True)
        return None, None, []


def _extract_text_from_html(html):
    """从可能的 HTML 响应中提取纯文本。"""
    from html.parser import HTMLParser

    class TextExtractor(HTMLParser):
        def __init__(self):
            super().__init__()
            self.texts = []
            self.skip = False

        def handle_starttag(self, tag, attrs):
            if tag in ("script", "style", "noscript"):
                self.skip = True

        def handle_endtag(self, tag):
            if tag in ("script", "style", "noscript"):
                self.skip = False
            if tag in ("p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6"):
                self.texts.append("\n")

        def handle_data(self, data):
            if not self.skip:
                t = data.strip()
                if t:
                    self.texts.append(t)

    extractor = TextExtractor()
    extractor.feed(html)
    return "\n".join(extractor.texts)


def fetch_chapter_text(session, book_id, chapter_uid, chapter_title=""):
    """尝试多种方式获取章节正文。

    微信读书的章节内容可能:
      - 直接以 HTML 返回 (e_{chapterUid} 接口)
      - 加密后需要 key 解密 (CBC 模式)
      - 通过 reader 页面承载

    返回 (text, method_used) 或 ("", "none")
    """
    # ── 方式 A: e_ 接口(web reader 用) ──
    try:
        url = f"{WEREAD_BASE}/web/book/chapter/e_{chapter_uid}"
        resp = session.get(url, timeout=20, headers={"Referer": f"{WEREAD_BASE}/web/reader/{book_id}"})
        if resp.status_code == 200:
            text = resp.text.strip()
            if text and len(text) > 100:
                # 判断是否是 HTML
                if text.startswith("{") and text.endswith("}"):
                    # JSON 响应 — 可能包含加密数据
                    try:
                        data = resp.json()
                        # 尝试各种 key
                        for key in ("content", "text", "html", "body", "chapterContent"):
                            if key in data and isinstance(data[key], str) and len(data[key]) > 100:
                                html = data[key]
                                plain = _extract_text_from_html(html)
                                if len(plain) > 50:
                                    return plain, f"e_ JSON.{key}"
                    except json.JSONDecodeError:
                        pass
                elif text.startswith("<"):
                    # HTML 响应
                    plain = _extract_text_from_html(text)
                    if len(plain) > 50:
                        return plain, "e_ HTML"
                else:
                    # 纯文本
                    if len(text) > 50:
                        return text, "e_ plain"
    except Exception:
        pass

    # ── 方式 B: t_ 接口(部分版本用) ──
    try:
        url = f"{WEREAD_BASE}/web/book/chapter/t_{chapter_uid}"
        resp = session.get(url, timeout=20, headers={"Referer": f"{WEREAD_BASE}/web/reader/{book_id}"})
        if resp.status_code == 200:
            text = resp.text.strip()
            if text and len(text) > 100:
                if text.startswith("{"):
                    try:
                        data = resp.json()
                        for key in ("content", "text", "html", "body"):
                            if key in data and isinstance(data[key], str) and len(data[key]) > 100:
                                plain = _extract_text_from_html(data[key])
                                if len(plain) > 50:
                                    return plain, f"t_ JSON.{key}"
                    except json.JSONDecodeError:
                        pass
                elif text.startswith("<"):
                    plain = _extract_text_from_html(text)
                    if len(plain) > 50:
                        return plain, "t_ HTML"
    except Exception:
        pass

    # ── 方式 C: reader 页面(完整 reader URL) ──
    try:
        url = f"{WEREAD_BASE}/web/reader/{book_id}"
        resp = session.get(url, timeout=20)
        if resp.status_code == 200:
            # reader 页面是 SPA,直接 GET 可能只有空壳 HTML.
            # 但有时初始章节内容在 <script> 或 initial state 中.
            html = resp.text
            # 尝试从 JS 变量中提取
            m = re.search(r'window\.__INITIAL_STATE__\s*=\s*({.+?});\s*</script>', html, re.DOTALL)
            if m:
                try:
                    import json as _json
                    state = _json.loads(m.group(1))
                    # 遍历 state 找章节内容
                    pass  # 复杂,暂不深入
                except Exception:
                    pass
    except Exception:
        pass

    return "", "none"


def fetch_chapter_via_read_api(session, book_id, chapter_uid, chapter_idx):
    """通过 read API 获取章节内容(新版微信读书使用的接口)。

    POST /web/book/read
    Body: {bookId, chapterUid, ...}
    """
    try:
        url = f"{WEREAD_BASE}/web/book/read"
        payload = {
            "bookId": book_id,
            "chapterUid": chapter_uid,
            "chapterIdx": chapter_idx,
            "synckey": "0",
        }
        resp = session.post(url, json=payload, timeout=20,
                           headers={"Content-Type": "application/json",
                                   "Referer": f"{WEREAD_BASE}/web/reader/{book_id}"})
        if resp.status_code == 200:
            data = resp.json()
            # 检查是否加密
            if "content" in data:
                content = data["content"]
                if isinstance(content, str) and len(content) > 100:
                    # 可能是 HTML
                    plain = _extract_text_from_html(content)
                    if len(plain) > 50:
                        return plain, "read API"
            # 其他可能的 key
            for key in ("chapterContent", "text", "body", "html"):
                if key in data:
                    val = data[key]
                    if isinstance(val, str) and len(val) > 100:
                        plain = _extract_text_from_html(val)
                        if len(plain) > 50:
                            return plain, f"read API.{key}"
    except Exception:
        pass
    return "", "none"


def flatten_chapters(chapter_list, prefix=""):
    """递归展开章节树。微信读书目录是嵌套的,有 level 字段。"""
    result = []
    for ch in chapter_list:
        title = ch.get("title", "")
        uid = ch.get("chapterUid", "")
        level = ch.get("level", 1)
        full_title = f"{prefix}{title}" if prefix else title
        result.append({
            "title": full_title,
            "chapterUid": uid,
            "level": level,
            "wordCount": ch.get("wordCount", 0),
            "chapterIdx": ch.get("chapterIdx", 0),
        })
        children = ch.get("children") or ch.get("childChapters") or []
        if children:
            result.extend(flatten_chapters(children, f"{full_title} / "))
    return result


def main():
    ap = argparse.ArgumentParser(description="从微信读书抓取南怀瑾著作全文 → JSONL")
    ap.add_argument("--i-have-authorization", action="store_true",
                    help="确认内容为公版/开放许可/已获授权。必填闸门。")
    ap.add_argument("--cookies", default="",
                    help="微信读书 cookie 字符串(从浏览器 F12 Console: document.cookie)")
    ap.add_argument("--cookie-file", default="",
                    help="或者从文件读取 cookie(每行一个 key=value)")
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--errors", default=ERRORS_DEFAULT)
    ap.add_argument("--delay", type=float, default=1.0, help="请求间隔(秒)")
    ap.add_argument("--search", default="", help="搜索关键词(列出匹配的书,不抓取)")
    ap.add_argument("--book-id", default="", help="直接指定 bookId 抓取(覆盖 TARGET_BOOKS)")
    ap.add_argument("--dry-run", action="store_true", help="只验证认证和获取目录,不抓正文")
    args = ap.parse_args()

    if not args.i_have_authorization:
        sys.exit(
            "本脚本仅用于公版/开放许可/已获授权内容。\n"
            "南怀瑾先生著作仍在著作权保护期内,确认你已获得授权后,加 --i-have-authorization 再运行。"
        )

    # ── 加载 cookie ──
    cookie_str = args.cookies
    if args.cookie_file and not cookie_str:
        try:
            with open(args.cookie_file, "r") as f:
                cookie_str = f.read().strip()
        except FileNotFoundError:
            sys.exit(f"Cookie 文件不存在: {args.cookie_file}")

    if not cookie_str:
        # 尝试从环境变量读取
        cookie_str = os.environ.get("WEREAD_COOKIES", "")
        if not cookie_str:
            sys.exit(
                "需要微信读书 Cookie。获取方式:\n"
                "  1. 浏览器打开 weread.qq.com 并扫码登录\n"
                "  2. F12 → Console → 输入 document.cookie 回车\n"
                "  3. 复制输出,然后运行:\n"
                f"     python3 {sys.argv[0]} --i-have-authorization --cookies '粘贴的cookie'\n"
                "或者: export WEREAD_COOKIES='...' 后重新运行。"
            )

    cookies = parse_cookies(cookie_str)
    print(f"已解析 {len(cookies)} 个 cookie key", flush=True)
    required = ["wr_skey", "wr_vid"]
    missing_req = [k for k in required if k not in cookies]
    if missing_req:
        print(f"⚠️  缺少关键 cookie: {missing_req} (可能影响认证)", flush=True)

    session = requests.Session()
    session.headers.update({"User-Agent": UA})
    session.cookies.update(cookies)

    # ── 验证认证 ──
    print("验证微信读书登录状态...", flush=True)
    ok, msg = verify_auth(session)
    if not ok:
        print(f"❌ 认证失败: {msg}", flush=True)
        sys.exit("Cookie 可能已过期,请重新获取。")
    print(f"✅ 认证成功: {msg}", flush=True)

    # ── 搜索模式 ──
    if args.search:
        print(f"\n搜索: {args.search}", flush=True)
        results = search_books(session, args.search)
        if not results:
            print("  无结果", flush=True)
        else:
            for bid, title, author in results:
                print(f"  {title} — {author}")
                print(f"    bookId: {bid}")
                print(f"    reader: https://weread.qq.com/web/reader/{bid}")
        return

    # ── 确定要抓的书 ──
    targets = TARGET_BOOKS.copy()
    if args.book_id:
        targets = [{"work": args.book_id, "category": "", "bookId": args.book_id, "source_label": "微信读书"}]

    if not targets:
        print("没有指定目标书。请在 TARGET_BOOKS 中添加 bookId。", flush=True)
        return

    # ── 断点续传 ──
    done = load_done(args.out)
    err_fp = open(args.errors, "a", encoding="utf-8")
    out_fp = open(args.out, "a", encoding="utf-8")
    total_new = 0
    total_skip = 0
    total_err = 0
    global_no = 0

    for wi, tgt in enumerate(targets, 1):
        work_title = tgt["work"]
        book_id = tgt["bookId"]
        category = tgt["category"]
        source_label = tgt["source_label"]

        print(f"\n[{wi}/{len(targets)}] {work_title} (bookId={book_id})", flush=True)

        # ── 获取目录 ──
        title, author, raw_chapters = get_book_info(session, book_id)
        if not raw_chapters:
            print(f"  !! 无法获取目录", flush=True)
            err_fp.write(json.dumps(
                {"stage": "toc", "work": work_title, "bookId": book_id,
                 "error": "无法获取目录"}, ensure_ascii=False) + "\n")
            total_err += 1
            continue

        chapters = flatten_chapters(raw_chapters)
        display_title = title or work_title
        print(f"  书名: {display_title}")
        if author:
            print(f"  作者: {author}")
        print(f"  章节: {len(chapters)}")
        if chapters:
            print(f"  首章: {chapters[0]['title']} (uid={chapters[0]['chapterUid']})")
            print(f"  末章: {chapters[-1]['title']} (uid={chapters[-1]['chapterUid']})")

        if args.dry_run:
            print("  (dry-run,跳过正文抓取)", flush=True)
            continue

        time.sleep(args.delay)

        # ── 逐章抓取 ──
        n_new = 0
        n_skip = 0
        for ci, ch in enumerate(chapters, 1):
            ch_title = ch["title"]
            ch_uid = ch["chapterUid"]
            ch_idx = ch.get("chapterIdx", ci - 1)

            key = (work_title, ch_title)
            if key in done:
                n_skip += 1
                continue

            if not ch_uid:
                print(f"   [{ci}/{len(chapters)}] {ch_title[:40]} — 无 chapterUid,跳过", flush=True)
                continue

            # 多种方式尝试获取正文
            text, method = fetch_chapter_text(session, book_id, ch_uid, ch_title)
            if not text:
                text, method = fetch_chapter_via_read_api(session, book_id, ch_uid, ch_idx)
            if not text:
                text, method2 = fetch_chapter_via_read_api(session, book_id, str(ch_idx), ch_idx)
                if text:
                    method = method2

            if not text or len(text) < 50:
                print(f"   [{ci}/{len(chapters)}] {ch_title[:40]} — 内容为空/太短 ({len(text)} 字) [{method}]", flush=True)
                err_fp.write(json.dumps(
                    {"stage": "chapter", "work": work_title, "chapter_title": ch_title,
                     "chapterUid": ch_uid, "method_tried": method,
                     "error": f"内容太短 ({len(text)} 字)"}, ensure_ascii=False) + "\n")
                n_skip += 1
                continue

            global_no += 1
            rec = {
                "work": work_title,
                "category": category,
                "work_url": f"https://weread.qq.com/web/reader/{book_id}",
                "chapter_no": global_no,
                "chapter_no_in_work": ci,
                "chapter_title": ch_title,
                "chapter_url": f"https://weread.qq.com/web/reader/{book_id}",
                "char_count": len(text),
                "text": text,
                "retrieved": TODAY,
                "source": source_label,
                "extract_method": method,
            }
            out_fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out_fp.flush()
            done.add(key)
            n_new += 1
            if len(chapters) <= 1:
                print(f"   {ch_title[:50]} ({len(text)} 字) [{method}]", flush=True)
            elif n_new <= 3 or n_new > len(chapters) - 3:
                print(f"   [{ci}/{len(chapters)}] {ch_title[:50]} ({len(text)} 字) [{method}]", flush=True)
            elif n_new == 4:
                print(f"   ...", flush=True)

            time.sleep(args.delay)

        total_new += n_new
        total_skip += n_skip
        print(f"  新抓 {n_new},跳过/失败 {n_skip}", flush=True)

    out_fp.close()
    err_fp.close()
    print(f"\n完成:新抓 {total_new},跳过/失败 {total_skip}。")
    print(f"  输出: {args.out}")
    if total_err:
        print(f"  错误: {args.errors}")


if __name__ == "__main__":
    main()
