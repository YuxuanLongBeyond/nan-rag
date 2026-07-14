# 南怀瑾著作 RAG 检索系统

基于南怀瑾先生著作的全文检索与 AI 问答系统，**自带完整语料库**（70,417 条 chunk，约 3,275 万字），无需导入任何文件。

## 特性

- **自带全部著作** — 涵盖南怀瑾先生主要著作，开箱即用
- **客户端搜索** — 中文 2–4 字词组 + IDF + n-gram 混合检索，浏览器内运行，无需后端
- **AI 辅助回答** — 基于检索到的原文片段生成回答，有效减少幻觉
- **严格出处模式** — 找不到依据时明确告知，不强行编造
- **流式输出** — AI 回答实时流式渲染
- **零成本部署** — 纯静态站点，可部署到 GitHub Pages / Cloudflare Pages
- **隐私安全** — API Key 仅存储于本地浏览器，不上传服务器
- **本地缓存** — 搜索索引缓存到 IndexedDB，二次打开秒开

## 使用方法

1. 打开网站。
2. （可选）在左侧「AI 回答设置」填入 [DeepSeek API Key](https://platform.deepseek.com/api_keys)，用于 AI 生成回答。不填 Key 也可以检索原文，并使用「复制提示词」功能。
3. 在检索框中输入问题或关键词，例如：
   - `什么是"安那般那"？`
   - `南怀瑾如何解释"十六特胜"？`
   - `人体重要气脉`
   - `中脉与修持`
4. 右侧展示：
   - 最相关的原文片段（含作品名、章节标题、来源链接）
   - 命中高亮
5. 点击「AI 回答」基于原文片段生成回答，或点击「复制提示词」手动粘贴到任意 LLM。

## 数据说明

| 数据文件 | 说明 | 大小 |
|----------|------|------|
| `search_index.json` | 连续正文检索索引（每片段 420 字） | ~85 MB（gzip ~27 MB） |
| `corpus/*.json` | 按作品分片的全文语料（138 个文件） | ~102 MB |
| `works_manifest.json` | 作品清单 | ~14 KB |
| `index_version.json` | 索引版本号（用于缓存校验） | 54 B |
| `embeddings.bin` | 语义向量（仅选择语义检索时按需加载） | ~26 MB |

首次访问下载搜索索引（~27 MB gzipped），之后自动从 IndexedDB 加载。语义向量不会在普通检索时后台下载。

## 技术架构

```
用户打开页面
  │
  ├─ fetch index_version.json（54 B，检查版本）
  ├─ 版本匹配 → 从 IndexedDB 加载索引（秒开）
  ├─ 版本更新 → 先用旧缓存 + 后台静默更新
  │
  ├─ 用户输入问题 → 客户端搜索
  │     ├─ 中文问题词组化 + 采样 IDF 候选召回（70,417 条 → top 300）
  │     ├─ 查询覆盖率 + n-gram + 标题/短语加权精排
  │     └─ 同章节结果去冗余
  │
  ├─ 按需加载全文（IndexedDB 缓存）
  │     └─ fetch corpus/{work}.json（首次命中该作品时）
  │
  └─ 调用 AI 生成回答（可选）
        ├─ 构建 prompt（检索片段 + 问题 + 出处约束）
        ├─ fetch DeepSeek API（流式 SSE）
        └─ 流式渲染回答
```

### AI 回答费用

使用 DeepSeek API（`deepseek-chat` 模型），约 ¥1 / 百万 token。一次完整 RAG 查询约 ¥0.001。

## 本地开发

```bash
# 启动本地服务器测试
python3 -m http.server 8080

# 重新生成语料库（需要 rag/ 目录下的 chunk JSONL）
python3 rag/build_static_corpus.py --skip-embeddings

# 运行前端检索回归测试
node --test tests/app.test.js
```

## 部署

将以下文件推送到 GitHub Pages 或 Cloudflare Pages（根目录）：

```
index.html
app.js
styles.css
search_index.json
index_version.json
works_manifest.json
corpus/
```

## 版权声明

本网站收录的南怀瑾先生著作内容受版权保护，仅供个人学习研究使用。使用本工具即表示您承诺不进行商业使用或公开传播。
