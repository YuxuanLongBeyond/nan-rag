# 爬取与整理交付说明

本目录包含两类结果：

- `nanhuaijin_catalog.md`、`nanhuaijin_catalog.csv`、`nanhuaijin_catalog.json`：南怀瑾专区的书目/栏目索引，不含正文。
- `build_nanhuaijin_catalog.ps1`：重新生成上述索引的脚本。
- `scrape_public_domain_to_md.ps1`：仅用于公版、开放许可或你已明确获得授权内容的 Markdown 爬虫。
- `crawl_nanhuaijin_fulltext.py` / `chunk_documents.py`：Python 全文 → JSONL 工具链，用于在**已获授权**前提下抓取南怀瑾著作章节全文并切分成 RAG 检索语料（需 `python3` + `requests` + `beautifulsoup4`）。

## 重新生成南怀瑾书目索引

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build_nanhuaijin_catalog.ps1
```

## 抓取公版/授权内容为 Markdown

先确认目标内容属于公版、开放许可，或你有明确授权；同时遵守网站服务条款和 robots 规则。确认后再加 `-ConfirmPublicDomain`。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scrape_public_domain_to_md.ps1 `
  -StartUrl "https://www.quanxue.cn/ct_daojia/laoziindex.html" `
  -Title "老子" `
  -ConfirmPublicDomain
```

可选参数：

- `-OutDir`：输出目录，默认是 `outputs/public_domain_md`。
- `-DelayMs`：请求间隔，默认 800ms。
- `-MaxPages`：只抓前 N 页，适合测试。

注意：不要把这个脚本用于批量复制仍受版权保护的现代著作全文，除非你已经获得授权。

## 全量抓取南怀瑾著作章节全文 → JSONL（RAG 语料）

`crawl_nanhuaijin_fulltext.py` 在**已获授权**的前提下，按 `nanhuaijin_catalog.csv` 全量抓取 95 部作品（约 5800 个章节页）的正文，输出 `nanhuaijin_documents.jsonl`（每行一章全文）；再用 `chunk_documents.py` 离线切成 `nanhuaijin_chunks.jsonl`（每行一个 chunk，可直接喂 embedding）。

南怀瑾先生著作仍在著作权保护期内。运行前请确认你已获得授权（公版 / 开放许可 / 明确授权），脚本以 `--i-have-authorization` 作为闸门——该开关由运行者据实声明，**不**替代授权本身。

```bash
# 1) 先冒烟：挑一部小作品验证（例如《神通与特异功能》，4 章）
python3 crawl_nanhuaijin_fulltext.py --i-have-authorization --work "神通与特异功能"
python3 chunk_documents.py
head -1 nanhuaijin_documents.jsonl | python3 -m json.tool
head -1 nanhuaijin_chunks.jsonl      | python3 -m json.tool

# 2) 全量爬取（约 5800 页；--delay 0.5 约需 50 分钟，可随时中断后重跑续传）
python3 crawl_nanhuaijin_fulltext.py --i-have-authorization --delay 0.5

# 3) 爬完后切分（纯本地，可反复重跑、随意调尺寸）
python3 chunk_documents.py
```

常用参数：

- `--i-have-authorization`：**必填**授权闸门。
- `--delay`：请求间隔（秒），默认 0.5。
- `--work "标题子串"`：只抓标题包含该子串的作品（大小写无关，可命中多部）。
- `--max-works N` / `--max-pages N`：分别限制作品数 / 每部作品章节数，测试用（0=不限）。
- `--include-related`：连 11 个 `related` 纪念 / 资料类一起抓（默认只抓 `work_or_article`）。
- `--out` / `--errors`：文档输出与错误记录路径，默认 `nanhuaijin_documents.jsonl` / `nanhuaijin_crawl_errors.jsonl`。
- 切分器：`--in` / `--out` / `--chunk`（默认 500 字）/ `--overlap`（默认 80 字）。

工程特性：**断点续传**（重跑自动跳过已抓的 `chapter_url`，append 写入，中断 / 断网可接续）、**每章 try/except**（失败记入错误文件，不中断整轮）、自定义 UA + 指数退避、全程 UTF-8。每条 JSONL 记录内嵌来源 URL 与抓取日期，便于 RAG 引用回链。

注意：全文抓取仅限已获授权内容；授权范围（是否含商用、能否再分发语料）请自行留证。
