# 南怀瑾著作 RAG 检索系统

基于南怀瑾先生著作的全文检索与 AI 问答系统。当前版本使用 **Vercel 前端与 API + Neon Postgres**：本地清洗版包含 136 部作品、63,485 个片段，浏览器只接收每次查询命中的少量片段，不再首次下载约 78 MB 的搜索索引或 26 MB 的向量文件。

## 主要特性

- **轻量首屏** — 只加载 HTML、CSS、JS、作品清单和 API 健康状态
- **服务端中文检索** — PostgreSQL `pg_trgm` 候选召回，Node.js 2–4 字 n-gram 精排
- **智能语义、模糊、精确模式** — 智能语义无需 Key 即可处理常见日常说法；设置用户自己的 DeepSeek Key 后，会进一步扩展传统术语和同义概念
- **多路召回与语义精排** — 综合原问题、扩展概念、命中线索数量和章节多样性排序，并围绕实际命中概念展示摘要
- **完整证据片段** — `/api/search` 直接返回命中的原文、作品、章节和来源链接
- **AI 辅助回答** — 继续支持用户自己的 DeepSeek API Key 和流式回答
- **严格出处模式** — 找不到依据时明确区分“当前资料未找到”和“作者从未说过”
- **可选静态降级** — 本地已有静态资产时，`localhost` 或 URL 加 `?local=1` 可验证旧浏览器索引

## 运行架构

```text
浏览器
  ├─ index.html / app.js / styles.css        Vercel CDN
  ├─ GET  /api/health                       小型状态响应
  └─ POST /api/search                       问题、模式、返回数量
             │
             ▼
       Vercel Function
             │
             ▼
       Neon Postgres + pg_trgm
             │
             └─ 只返回前 3–20 个命中片段
```

`search_index.json`、`embeddings.bin`、`corpus/`、原始数据和 `rag/` 下的 JSONL 是本地生成资产，已通过 `.gitignore` 和 `.vercelignore` 排除：不会提交到 GitHub，也不会进入 Vercel 部署包。Git 只保留可复现的清洗/分块脚本；线上检索只使用 Neon 中已经导入的数据。

语义检索的 DeepSeek API Key 只保存在用户浏览器中。没有 Key 时，浏览器会用本地的日常表达与原著术语映射做基础语义扩展；有 Key 时，再向 DeepSeek 请求更贴合当前问题的扩展词。本站 `/api/search` 只收到问题和扩展词，Vercel 和 Neon 都不会收到或保存用户的 API Key。模型请求失败或没有可靠扩展结果时，会透明降级为增强模糊检索。

## 第一次部署

### 1. 创建 Neon 数据库

1. 在 [Neon](https://console.neon.tech/) 创建一个 Postgres 项目。
2. 在项目首页点击 **Connect**，分别复制 pooled 和 direct connection string。
3. 在项目目录创建本地配置：

```bash
cp .env.example .env.local
```

4. 将连接串填入 `.env.local`：

```dotenv
# 开启 Connection pooling，供 Vercel API 使用
DATABASE_URL=postgresql://USER:PASSWORD@POOLER_HOST/DB?sslmode=require

# 关闭 Connection pooling，供本地建表和批量导入使用
DATABASE_URL_UNPOOLED=postgresql://USER:PASSWORD@DIRECT_HOST/DB?sslmode=require
```

`.env.local` 已被 Git 忽略，不要提交真实连接串。

### 2. 导入语料

导入前需要在本地生成或保留 `search_index.json`、`corpus/`、`works_manifest.json` 和 `index_version.json`。其中全文、索引和向量文件不进入 Git 仓库。

```bash
npm install

# 先检查全部索引项能否关联到全文，不连接数据库
npm run db:import -- --dry-run

# 创建表、导入全文、清理旧版本并建立中文检索索引
npm run db:import
```

导入脚本可以重复运行：片段按 `id` 更新，只有完整导入成功后才清理旧版本。如果连接中断，重新执行即可。最后创建 GIN 索引通常是最耗时的一步。

### 3. 本地验证 Vercel API

```bash
npm run dev
```

打开终端显示的本地网址。也可以检查：

```bash
curl http://localhost:3000/api/health
```

如果本地仍保留完整静态资产，可以使用纯静态调试：

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080/?local=1
```

静态调试模式会继续加载大索引，只用于本地降级验证；从 GitHub 新克隆的仓库默认不包含这些资产。

### 4. 部署到 Vercel

1. 将代码推送到 GitHub。
2. 在 Vercel 新建项目并导入该仓库。
3. 在 **Project Settings → Environment Variables** 添加 pooled `DATABASE_URL`，Production、Preview、Development 按需勾选；`DATABASE_URL_UNPOOLED` 只在本地导入，不必放到 Vercel。
4. 触发一次重新部署；环境变量不会自动应用到旧部署。
5. 访问 `https://你的项目.vercel.app/api/health`，确认返回 `"ready": true`。
6. 先用免费的 `.vercel.app` 地址完成检索测试，再购买或绑定正式域名。

## 更新语料

```bash
# PDF 转 Markdown 数据：先解压，再生成清洗后的 documents/chunks
unar -force-overwrite -o data/pdf/markdown data/pdf/data.rar
python3 rag/extract_pdf_markdown.py --i-have-authorization
python3 rag/chunk_documents.py \
  --in rag/pdf_markdown_documents.jsonl \
  --out rag/pdf_markdown_chunks.jsonl

# 根据 rag/ 下现有 chunk 文件重建本地静态资产，不重复生成向量
python3 rag/build_static_corpus.py --skip-embeddings

# 检查质量和导入关联，不连接数据库
npm run corpus:audit
npm run db:import -- --dry-run

# 确认新 Neon 可连接后再同步到 Postgres
npm run db:import
```

PDF 批次会加入完整的《洞山指月》和《金粟轩纪年诗》；RAR 中《南师所讲呼吸法门精要》的 OCR 质量低于现有分章文本，因此只保留为原始数据源，不覆盖当前语料。数据库元信息中的版本取自 `index_version.json`，`/api/health` 会展示当前已导入的版本、作品数和片段数。

## 测试与检查

```bash
npm test
npm run check
npm run corpus:audit
npm run retrieval:eval
```

测试覆盖本地与 DeepSeek 语义扩展、无 Key 降级、Key 隔离、服务端查询词清洗、跨表达召回、候选合并、语义精排、章节多样性和 HTML 安全渲染。`retrieval:eval` 会遍历本地完整语料，分别验证精准、模糊、语义三种模式，因此需要先生成被 Git 忽略的 `corpus/`。

## 关键文件

| 文件 | 用途 |
|---|---|
| `api/search.mjs` | Vercel 检索 API |
| `api/health.mjs` | 数据库就绪状态 |
| `server/search-core.mjs` | 查询清洗、候选合并和中文精排 |
| `db/schema.sql` | Postgres 表、索引和检索函数 |
| `scripts/import-db.mjs` | 将现有索引和按作品语料导入 Postgres |
| `scripts/audit-corpus.mjs` | 检查乱码、格式残留、重复片段和索引一致性 |
| `rag/extract_pdf_markdown.py` | 清洗 PDF Markdown 并按章节/诗作结构化 |
| `rag/chunk_documents.py` | 按段落切分正文并生成带重叠的检索片段 |
| `.gitignore` / `.vercelignore` | 防止本地语料和生成资产被上传 |
| `app.js` | 前端检索、结果展示和静态降级逻辑 |

## 成本与容量提示

当前清洗后的本地全文 JSON 约 87 MB，Postgres 还会占用表、WAL 和 `pg_trgm` 索引空间。导入后应在 Neon 控制台确认实际占用；如果接近套餐限制，可升级为按量付费，或下一步把正文移到 Cloudflare R2、数据库只保存检索字段。

## 版权声明

本项目语料受版权保护，仅供已获得合法使用权限的个人学习研究场景。不要将全文数据库、API 或网站用于未经授权的公开传播或商业用途。
