# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two layers of scraping tooling that build a corpus catalog **and** a RAG-ready text corpus from two sources — `quanxue.cn` (UTF-8) and `shixiu.net` (GBK) — centered on the Nan Huaijin (南怀瑾) section:

- **PowerShell scripts** (`.ps1`) — the metadata/catalog/TOC layer. Output is structured Markdown/CSV/JSON metadata only.
- **Python scripts** (`.py`) — the full-text → JSONL layer (`crawl_nanhuaijin_fulltext.py`, `crawl_shixiu_fulltext.py`, `chunk_documents.py`), gated on explicit authorization (see below). Produces embedding-ready chunks from two sources.

This is **not** a running application — there is no build, no tests, no package manager. The PowerShell scripts target Windows `powershell` / Linux `pwsh`; the Python scripts run under `python3` (requests + BeautifulSoup). Note: the deployment box this repo lives on has **no `pwsh`**, so on that host only the `.py` tools run.

## The rights guardrail (read first)

This is the single most important constraint in the repo and it spans every script plus the README. Nan Huaijin's works are still under copyright, so the Nan Huaijin tooling is **deliberately scoped to metadata only** — titles, categories, and URLs — and never extracts full text. This is enforced by design:

- `build_nanhuaijin_catalog.ps1` and `crawl_nanhuaijin_toc_only.ps1` capture only catalog entries and table-of-contents links. Their output headers say "full text intentionally excluded." Do not weaken these to grab body text.
- Only `scrape_public_domain_to_md.ps1` (PowerShell) and `crawl_nanhuaijin_fulltext.py` (Python) extract full text. Each **hard-fails without its confirmation switch** — `-ConfirmPublicDomain` and `--i-have-authorization` respectively — and both are meant solely for public-domain, openly licensed, or explicitly authorized content. `crawl_nanhuaijin_fulltext.py` is the *only* path that extracts Nan Huaijin full text, and it requires the operator to assert authorization. Preserve these gates; do not add silent full-text extraction.
- The authorization basis is the operator's responsibility (scope of license: commercial vs. non-commercial, whether redistribution is allowed). The flag encodes that assertion; it does not verify it.
- Honor per-request delays and the same-host / same-directory link scoping already in place when modifying crawl behavior.

## The script pipeline

```
build_nanhuaijin_catalog.ps1   →  nanhuaijin_catalog.{csv,json,md}
        │                          (125 items: 114 works + 11 "related"; source column)
        ├──────────────────────────────────────────────┐
        ▼                                              ▼
crawl_nanhuaijin_toc_only.ps1 (PS)         crawl_nanhuaijin_fulltext.py (Python; --i-have-authorization)
(metadata only)                            (consumes CSV → filters source==quanxue.cn → 95 works)
        │                                              │
        ▼                                              ▼
nanhuaijin_toc_md/{NNN-title}.md         nanhuaijin_documents.jsonl  ──►  chunk_documents.py  ──►  nanhuaijin_chunks.jsonl
+ _summary.* + _index.md                 (5,841 chapters, 54 MB)             (55,637 chunks, 81 MB)

                                    crawl_shixiu_fulltext.py (Python; --i-have-authorization)
                                    (consumes PREBUILT_LIST → m.shixiu.net, GBK → 7 works)
                                               │
                                               ▼
                                    shixiu_documents.jsonl  ──►  chunk_documents.py  ──►  shixiu_chunks.jsonl
                                    (115 chapters, ~4 MB)          (--in shixiu_documents.jsonl)   (5,432 chunks, ~8 MB)

                                    crawl_guoxue_fulltext.py (Python; --i-have-authorization)
                                    (consumes PREBUILT_LIST → guoxue.r12345.com, UTF-8 → 3 works)
                                               │
                                               ▼
                                    guoxue_documents.jsonl  ──►  chunk_documents.py  ──►  guoxue_chunks.jsonl
                                    (29 chapters)                 (--in guoxue_documents.jsonl)   (2,796 chunks)

                                    crawl_supplement_fulltext.py (Python; --i-have-authorization)
                                    (consumes PREBUILT → nianjue.org + book853.com → 2 works)
                                               │
                                               ▼
                                    supplement_documents.jsonl  ──►  chunk_documents.py  ──►  supplement_chunks.jsonl
                                    (10 chapters)                    (--in supplement_documents.jsonl) (158 chunks)

                                    crawl_docx_fulltext.py (Python; --i-have-authorization)
                                    (reads local data/*.docx → 10 works)
                                               │
                                               ▼
                                    docx_documents.jsonl  ──►  chunk_documents.py  ──►  docx_chunks.jsonl
                                    (183 chapters)                (--in docx_documents.jsonl)   (7,569 chunks)

scrape_public_domain_to_md.ps1  →  public_domain_md/<book>/  (separate track, full text, public domain only)
```

`build_nanhuaijin_catalog.ps1` — one-shot fetch of the index page; regex-extracts the `<div id="index_left">` section, walks `<caption>` (category headers) and `<a>` (links) tokens in order, classifies each link as `work_or_article` (default) vs `related` (paths under `other/*`).

`crawl_nanhuaijin_toc_only.ps1` — reads the CSV, keeps only `type -eq "work_or_article"`, fetches each work's index page, and records its chapter links (de-duped, same-host, same-directory only). Per-item `try/catch` writes a status row rather than aborting the run. Metadata only.

`crawl_nanhuaijin_fulltext.py` — the authorized full-text track for quanxue.cn. Same two-stage crawl as the TOC script (work index → chapter links, same-host/same-directory scoping), but then fetches each chapter's body (BeautifulSoup, `<p>` text with whole-body fallback) and emits one JSONL line per chapter. Reads catalog CSV and filters to `source == "quanxue.cn"` rows only. **Resumable** (re-reads `--out` and skips already-fetched `chapter_url`s), polite (UA + `--delay` + exponential backoff), per-chapter error isolation (`--errors`). Scale: 5,841 chapters across 95 works.

`crawl_shixiu_fulltext.py` — the authorized full-text track for shixiu.net (mobile site `m.shixiu.net`). Same architecture as the quanxue.cn crawler (two-stage: work index → chapter links → chapter body), but adapted for GBK encoding: `fetch()` explicitly sets `resp.encoding = 'gbk'`. Uses a `PREBUILT_LIST` of 7 works (4 directory-type + 3 single-article) rather than reading the catalog CSV. Two entry points: `crawl_directory_work()` for multi-chapter works and `crawl_single_work()` for single-page articles. Output includes `"source": "shixiu.net"` field. Scale: 115 chapters across 7 works. **Note:** 维摩诘的花雨满天 was moved to `crawl_guoxue_fulltext.py` (guoxue.r12345.com has cleaner HTML without the malformed `<p>` nesting that caused 1–4M char extraction artifacts on shixiu.net).

`crawl_guoxue_fulltext.py` — the authorized full-text track for guoxue.r12345.com (a cleaner mirror of shixiu.net in the 实修驿站 ecosystem). Same architecture as the other crawlers but simplified: uses `body.get_text()` for extraction instead of `find_all('p')` because guoxue.r12345.com pages use heavily malformed HTML with unclosed `<p>` tags that cause 144x–206x text duplication with the standard parser. UTF-8 encoding, clean output. Currently targets 3 works: 维摩诘的花雨满天 (17 chapters, ~52万字), 瑜伽师地论讲座 (3 chapters, ~3万字), 宗镜录略讲/guoxue版 (9 chapters, ~62万字). PREBUILT_LIST is extensible for additional works from this mirror.

`crawl_supplement_fulltext.py` — the authorized full-text track for one-off supplementary works from scattered sources (nianjue.org, book853.com, etc.). Targets works from the 大全.jpg compendium that are NOT available on the three main sources (quanxue/shixiu/guoxue). Handles both single-page (nianjue.org) and multi-page paginated (book853.com) extraction patterns. Currently targets 2 works: 中国文化与佛学八讲 (1 chapter, ~3万字) from nianjue.org, 人生的起点和终站 (9 chapters, ~3.5万字) from book853.com.

`crawl_docx_fulltext.py` — the authorized full-text track for local docx manuscripts in `../data/`. Extracts text from pre-compiled Word documents using python-docx, with three extraction modes: `lengyan` (splits at "楞严经NNN" chapter markers), `damo` (splits at major section markers after skipping TOC), and `single` (full document as one chapter). Currently targets 10 works: 太湖楞严讲习录 (164 chapters, ~183万字), 太湖版达摩多罗禅经讲座 (11 chapters, ~61万字), and 8 准提法-related texts (~7万字 combined). Output total: 183 chapters, ~251万字.

`chunk_documents.py` — pure-local, no network. Reads a documents JSONL (default `nanhuaijin_documents.jsonl`, override with `--in`), splits each chapter into paragraph-aware overlapping chunks (`--chunk` default 500, `--overlap` default 80), writes chunks JSONL. Re-runnable: changing chunk size regenerates chunks without re-crawling. Run separately for each source: `--in nanhuaijin_documents.jsonl --out nanhuaijin_chunks.jsonl`, `--in shixiu_documents.jsonl --out shixiu_chunks.jsonl`, `--in guoxue_documents.jsonl --out guoxue_chunks.jsonl`, `--in supplement_documents.jsonl --out supplement_chunks.jsonl`, `--in docx_documents.jsonl --out docx_chunks.jsonl`. Combined output: 71,592 chunks across five sources.

## Common commands

Run from PowerShell (Windows `powershell`, or `pwsh` on Linux — the scripts use `Invoke-WebRequest`, `[regex]`, and `[System.Net.WebUtility]`, all available cross-platform):

```powershell
# Regenerate the Nan Huaijin metadata catalog
powershell -NoProfile -ExecutionPolicy Bypass -File .\build_nanhuaijin_catalog.ps1

# Re-crawl all TOCs (consume the catalog CSV)
powershell -NoProfile -ExecutionPolicy Bypass -File .\crawl_nanhuaijin_toc_only.ps1 -DelayMs 300

# Scrape a public-domain book to Markdown (requires explicit confirmation)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scrape_public_domain_to_md.ps1 `
  -StartUrl "https://www.quanxue.cn/ct_daojia/laoziindex.html" -Title "老子" -ConfirmPublicDomain
```

Useful parameters: `-OutDir`, `-DelayMs` (request gap, default 800 for public-domain / 300 for TOC), `-MaxPages N` (cap a crawl for testing).

Python full-text track (dual-source; requires authorization; ~5,972 chapters total, resumable):

```bash
# Smoke-test: 1 work, 3 chapters, then verify the JSONL files before a full run
python3 crawl_nanhuaijin_fulltext.py --i-have-authorization --max-works 1 --max-pages 3
python3 chunk_documents.py

# Full crawls — all sources (long-running; safe to interrupt — they resume)
python3 crawl_nanhuaijin_fulltext.py --i-have-authorization --delay 0.5
python3 crawl_shixiu_fulltext.py --i-have-authorization --delay 0.5
python3 crawl_guoxue_fulltext.py --i-have-authorization --delay 0.5
python3 crawl_supplement_fulltext.py --i-have-authorization --delay 0.5
python3 crawl_docx_fulltext.py --i-have-authorization

# Chunk all five sources after crawls complete
python3 chunk_documents.py --in nanhuaijin_documents.jsonl --out nanhuaijin_chunks.jsonl
python3 chunk_documents.py --in shixiu_documents.jsonl --out shixiu_chunks.jsonl
python3 chunk_documents.py --in guoxue_documents.jsonl --out guoxue_chunks.jsonl
python3 chunk_documents.py --in supplement_documents.jsonl --out supplement_chunks.jsonl
python3 chunk_documents.py --in docx_documents.jsonl --out docx_chunks.jsonl

# Re-chunk with different settings (no re-crawl needed)
python3 chunk_documents.py --chunk 800 --overlap 120
```

Python parameters: `--i-have-authorization` (required gate), `--delay` (seconds, default 0.5), `--max-works N` / `--max-pages N` (test caps), `--include-related` (also crawl the 11 `related` items), `--chunk` / `--overlap` (chunker, defaults 500 / 80).

## Conventions shared across the PowerShell scripts

- **HTML parsing is regex, not a DOM parser.** Named capture groups + `Singleline,IgnoreCase`. Entities decoded via `[System.Net.WebUtility]::HtmlDecode`. When adding a new extraction, follow this pattern rather than introducing a dependency.
- **Relative → absolute URLs** via `New-Object System.Uri -ArgumentList $baseUri, $href`. Link filtering keeps only same-host links that start with the index page's base directory.
- **Filenames** are sanitized by replacing `[\\/:*?"<>|]` with `_` (`Safe-FileName` / `Get-SafeFileName`), then zero-prefixed with `{0:D3}` for stable ordering (`001-…`, `002-…`).
- **Politeness:** each script sends a descriptive `User-Agent` and sleeps `-DelayMs` between requests. Keep these when extending crawls.
- **Output is always UTF-8** (`-Encoding UTF8`), and `$ErrorActionPreference = "Stop"` is set at the top of every script.
- **Metadata headers** embed source URL + retrieval date in every emitted file; preserve these provenance fields.

The Python scripts follow the same *spirit* but use `requests` + BeautifulSoup instead of regex/`Invoke-WebRequest`, and the same link-scoping rule (same host + same base directory + `.html?$`) is ported verbatim into `extract_chapter_links`. Every emitted JSONL record carries source URL + retrieval date (provenance), mirroring the PowerShell metadata headers.

## Notes

- The catalog files (`nanhuaijin_catalog.*`) and `nanhuaijin_toc_md/` are committed **generated output**, not source. Regenerate via the scripts above rather than hand-editing. The Python outputs (`nanhuaijin_documents.jsonl`, `nanhuaijin_chunks.jsonl`, `nanhuaijin_crawl_errors.jsonl`) are also generated; they are not yet committed in this snapshot.
- `_index.md` records the CSV path the TOC crawl was run against (a Windows path in the current snapshot) — harmless, but don't treat it as authoritative; the real input is `nanhuaijin_catalog.csv` in the repo root.
- This host has no `pwsh`, so the `.ps1` tools can only be regenerated on a Windows/pwsh machine; on this box, use the `.py` tools. The PowerShell scripts remain the source of truth for the catalog/TOC layer.
