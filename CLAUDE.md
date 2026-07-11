# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a two-layer system for building and querying a RAG corpus of Nan Huaijin's (南怀瑾) works:

- **Root** — A static browser-side RAG workbench (`index.html` + `app.js` + `styles.css`). Users import `.txt`/`.md` files locally; all search runs client-side via keyword matching + character n-gram similarity against an in-memory chunk index persisted to `localStorage`. No server, no build step, no dependencies.
- **`rag/`** — The data pipeline that produces the corpus the workbench consumes. PowerShell scripts handle the metadata/catalog/TOC layer; Python scripts handle authorized full-text crawling and chunking into embedding-ready JSONL. See `rag/CLAUDE.md` for the full pipeline documentation.

There is no build system, no test suite, and no package manager anywhere in this repo.

## Architecture

```
User-dropped .txt/.md  ──►  app.js (in-browser chunker + searcher)  ──►  evidence-constrained answer
                                      ▲
                                      │  (optional: pre-built corpus)
                                      │
rag/crawl_nanhuaijin_fulltext.py  ──►  nanhuaijin_documents.jsonl (quanxue.cn: 5,841 ch)
rag/crawl_shixiu_fulltext.py      ──►  shixiu_documents.jsonl      (shixiu.net: 115 ch)
rag/crawl_guoxue_fulltext.py      ──►  guoxue_documents.jsonl      (guoxue.r12345.com: 29 ch)
rag/crawl_supplement_fulltext.py  ──►  supplement_documents.jsonl  (nianjue.org + book853.com: 10 ch)
rag/crawl_docx_fulltext.py        ──►  docx_documents.jsonl        (本地精校 docx: 183 ch)
rag/chunk_documents.py            ──►  nanhuaijin_chunks.jsonl + shixiu_chunks.jsonl + guoxue_chunks.jsonl + supplement_chunks.jsonl + docx_chunks.jsonl
                                                                     (55,637 + 5,432 + 2,796 + 158 + 7,569 = 71,592 chunks)
```

### Root web app (`app.js`)

The single-file JS app is organized as a pipeline:

1. **Import** — Files are read via `FileReader`, normalized (`normalizeText`), deduped by content hash (`shortHash`), and stored in `localStorage`.
2. **Chunking** — `splitIntoChunks` detects chapter/section headings (regex patterns for Chinese heading conventions), then `packParagraphs` greedily merges paragraphs into chunks of target ~520 chars (max 900). Long texts are split at sentence boundaries (`。！？`).
3. **Indexing** — Each chunk gets a searchable `searchText` field (title + section + body) and a character n-gram frequency map (`makeGrams`, n=2–4) for fuzzy matching.
4. **Search** — `scoreChunk` combines keyword token matching (weighted by field: title > section > body), exact-phrase boost, and cosine-like n-gram overlap. Results are ranked and thresholded.
5. **Answer** — `buildConservativeAnswer` strictly distinguishes "not found in current library" from "never said by the author." Generates a copyable evidence-constrained prompt for LLM use.

State is flat: `state.docs[]`, `state.chunks[]`, `state.lastResults[]`, `state.lastPrompt`.

### rag/ data pipeline

Two tracks, documented in detail at `rag/CLAUDE.md`:

- **Metadata track** (PowerShell): `build_nanhuaijin_catalog.ps1` → catalog files (125 rows, with `source` column) → `crawl_nanhuaijin_toc_only.ps1` → TOC markdown files. Regex-based HTML parsing, no DOM parser.
- **Full-text track** (Python): Two crawlers — `crawl_nanhuaijin_fulltext.py` for quanxue.cn (UTF-8, 95 works, 5,841 chapters) and `crawl_shixiu_fulltext.py` for shixiu.net (GBK, 7 works, 115 chapters). Plus `crawl_guoxue_fulltext.py` for guoxue.r12345.com (UTF-8, 3 works, 29 chapters — clean source for 维摩诘的花雨满天, 瑜伽师地论讲座, 宗镜录略讲). Plus `crawl_supplement_fulltext.py` for scattered sources (2 works, 10 chapters — 中国文化与佛学八讲, 人生的起点和终站). Plus `crawl_docx_fulltext.py` for local docx manuscripts (10 works, 183 chapters — 太湖楞严讲习录 164章, 太湖版达摩多罗禅经 11章, 准提法系列 8篇). All five output JSONL consumed by `chunk_documents.py` → chunk JSONL (71,592 chunks total across five sources). Uses `requests` + BeautifulSoup + python-docx.

## Critical constraint: copyright guardrail

Nan Huaijin's works remain under copyright. The tooling enforces this at every layer:

- PowerShell metadata scripts capture only titles, categories, and URLs — never body text.
- `crawl_nanhuaijin_fulltext.py` **hard-fails** without `--i-have-authorization`. This is the only path that extracts Nan Huaijin full text, and the flag encodes the operator's assertion of authorization; it does not verify it.
- `scrape_public_domain_to_md.ps1` similarly requires `-ConfirmPublicDomain`.
- Do not add silent full-text extraction or weaken these gates.

## Common commands

### Web app

```bash
# Just open in a browser — no build step
open index.html
```

### Python pipeline (from `rag/`)

```bash
# Install dependencies
pip install requests beautifulsoup4

# Smoke test: 1 work, 3 chapters
python3 crawl_nanhuaijin_fulltext.py --i-have-authorization --max-works 1 --max-pages 3
python3 chunk_documents.py

# Full crawl — all sources (resumable — safe to interrupt and re-run)
python3 crawl_nanhuaijin_fulltext.py --i-have-authorization --delay 0.5
python3 crawl_shixiu_fulltext.py --i-have-authorization --delay 0.5
python3 crawl_guoxue_fulltext.py --i-have-authorization --delay 0.5
python3 crawl_supplement_fulltext.py --i-have-authorization --delay 0.5
python3 crawl_docx_fulltext.py --i-have-authorization

# Chunk all five sources
python3 chunk_documents.py --in nanhuaijin_documents.jsonl --out nanhuaijin_chunks.jsonl
python3 chunk_documents.py --in shixiu_documents.jsonl --out shixiu_chunks.jsonl
python3 chunk_documents.py --in guoxue_documents.jsonl --out guoxue_chunks.jsonl
python3 chunk_documents.py --in supplement_documents.jsonl --out supplement_chunks.jsonl
python3 chunk_documents.py --in docx_documents.jsonl --out docx_chunks.jsonl

# Re-chunk with different settings (no re-crawl needed)
python3 chunk_documents.py --chunk 800 --overlap 120
```

### PowerShell pipeline (from `rag/`; requires Windows `powershell` or Linux `pwsh`)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build_nanhuaijin_catalog.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\crawl_nanhuaijin_toc_only.ps1 -DelayMs 300
powershell -NoProfile -ExecutionPolicy Bypass -File .\scrape_public_domain_to_md.ps1 `
  -StartUrl "https://www.quanxue.cn/ct_daojia/laoziindex.html" -Title "老子" -ConfirmPublicDomain
```

## Key conventions

- **No `pwsh` on this host** — the deployment box has no PowerShell; the `.ps1` scripts are source-of-truth for the catalog/TOC layer but can only be regenerated on a Windows/pwsh machine. Use the `.py` tools on this host.
- **Generated files are committed** — catalog files (`nanhuaijin_catalog.*`) and `nanhuaijin_toc_md/` are generated output. Regenerate via scripts rather than hand-editing.
- **UTF-8 everywhere** — all scripts emit UTF-8; the Python scripts also handle UTF-8 BOM on input (`utf-8-sig`).
- **Politeness** — all crawlers set a descriptive `User-Agent` and enforce per-request delays. Preserve these when modifying crawl behavior.
- **Resumability** — `crawl_nanhuaijin_fulltext.py` appends to its output and skips already-fetched `chapter_url`s on re-run. Interrupting it is safe.
- **Per-item error isolation** — both PowerShell and Python crawlers use per-item `try/catch` (or `try/except`) so one failure doesn't abort the entire run.
