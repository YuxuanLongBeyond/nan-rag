CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_chunks (
  id text PRIMARY KEY,
  index_pos integer NOT NULL,
  work text NOT NULL,
  chapter text NOT NULL DEFAULT '',
  content text NOT NULL,
  source_url text NOT NULL DEFAULT '',
  char_count integer NOT NULL DEFAULT 0,
  embedding halfvec(384),
  build_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding halfvec(384);

CREATE TABLE IF NOT EXISTS rag_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_chunks_work_idx ON rag_chunks (work);

-- GIN trigram 在当前 6 万条语料上约占 278 MB，接近 Neon 免费容量上限。
-- GiST 签名索引保留模糊匹配能力，同时为片段向量和 ANN 索引腾出空间。
DROP INDEX IF EXISTS rag_chunks_search_trgm_idx;
CREATE INDEX IF NOT EXISTS rag_chunks_search_trgm_gist_idx
  ON rag_chunks USING gist
  ((lower(work || ' ' || chapter || ' ' || content)) gist_trgm_ops(siglen=64));

CREATE OR REPLACE FUNCTION rag_search_term(p_term text, p_limit integer DEFAULT 120)
RETURNS TABLE (
  id text,
  work text,
  chapter text,
  content text,
  source_url text,
  char_count integer,
  db_score real
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.id,
    c.work,
    c.chapter,
    c.content,
    c.source_url,
    c.char_count,
    GREATEST(
      word_similarity(lower(p_term), lower(c.work || ' ' || c.chapter || ' ' || c.content)),
      similarity(lower(p_term), lower(c.work)),
      similarity(lower(p_term), lower(c.chapter)),
      CASE
        WHEN lower(c.work || ' ' || c.chapter || ' ' || c.content)
             LIKE '%' || lower(p_term) || '%'
        THEN 0.9
        ELSE 0.0
      END
    )::real AS db_score
  FROM rag_chunks AS c
  WHERE
    lower(p_term) <% lower(c.work || ' ' || c.chapter || ' ' || c.content)
    OR lower(c.work || ' ' || c.chapter || ' ' || c.content)
       LIKE '%' || lower(p_term) || '%'
  ORDER BY db_score DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 300);
$$;

-- pg_trgm 的 word_similarity 对一、二字中文词需要扫描大量候选。
-- 短词只做字面包含召回，避免多个短词叠加后拖垮 Serverless 请求。
CREATE OR REPLACE FUNCTION rag_search_short_term(p_term text, p_limit integer DEFAULT 120)
RETURNS TABLE (
  id text,
  work text,
  chapter text,
  content text,
  source_url text,
  char_count integer,
  db_score real
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.id,
    c.work,
    c.chapter,
    c.content,
    c.source_url,
    c.char_count,
    CASE
      WHEN lower(c.work) LIKE '%' || lower(p_term) || '%' THEN 1.0
      WHEN lower(c.chapter) LIKE '%' || lower(p_term) || '%' THEN 0.97
      ELSE 0.9
    END::real AS db_score
  FROM rag_chunks AS c
  WHERE lower(c.work || ' ' || c.chapter || ' ' || c.content)
        LIKE '%' || lower(p_term) || '%'
  ORDER BY db_score DESC, c.index_pos
  LIMIT LEAST(GREATEST(p_limit, 1), 300);
$$;

-- 一次语料扫描同时处理多个短词，再按每个词分别保留 p_limit 条。
-- 结果与逐词调用 rag_search_short_term 等价，避免语义扩展包含多个二字词时
-- 重复扫描整张表。
CREATE OR REPLACE FUNCTION rag_search_short_terms(
  p_terms text[],
  p_limit integer DEFAULT 120
)
RETURNS TABLE (
  search_term text,
  id text,
  work text,
  chapter text,
  content text,
  source_url text,
  char_count integer,
  db_score real
)
LANGUAGE sql
STABLE
AS $$
  WITH base AS MATERIALIZED (
    SELECT
      c.id,
      c.index_pos,
      c.work,
      c.chapter,
      c.content,
      c.source_url,
      c.char_count,
      lower(c.work || ' ' || c.chapter || ' ' || c.content) AS search_text
    FROM rag_chunks AS c
  ), ranked AS (
    SELECT
      term.value AS search_term,
      b.id,
      b.work,
      b.chapter,
      b.content,
      b.source_url,
      b.char_count,
      CASE
        WHEN lower(b.work) LIKE '%' || lower(term.value) || '%' THEN 1.0
        WHEN lower(b.chapter) LIKE '%' || lower(term.value) || '%' THEN 0.97
        ELSE 0.9
      END::real AS db_score,
      row_number() OVER (
        PARTITION BY term.value
        ORDER BY
          CASE
            WHEN lower(b.work) LIKE '%' || lower(term.value) || '%' THEN 1.0
            WHEN lower(b.chapter) LIKE '%' || lower(term.value) || '%' THEN 0.97
            ELSE 0.9
          END DESC,
          b.index_pos
      ) AS result_rank
    FROM base AS b
    CROSS JOIN LATERAL unnest(p_terms) AS term(value)
    WHERE b.search_text LIKE '%' || lower(term.value) || '%'
  )
  SELECT
    ranked.search_term,
    ranked.id,
    ranked.work,
    ranked.chapter,
    ranked.content,
    ranked.source_url,
    ranked.char_count,
    ranked.db_score
  FROM ranked
  WHERE ranked.result_rank <= LEAST(GREATEST(p_limit, 1), 300)
  ORDER BY ranked.search_term, ranked.result_rank;
$$;

CREATE OR REPLACE FUNCTION rag_search_exact(p_query text, p_limit integer DEFAULT 300)
RETURNS TABLE (
  id text,
  work text,
  chapter text,
  content text,
  source_url text,
  char_count integer,
  db_score real
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.id,
    c.work,
    c.chapter,
    c.content,
    c.source_url,
    c.char_count,
    LEAST(
      1.0,
      0.55 +
      CASE WHEN lower(c.chapter) LIKE '%' || lower(p_query) || '%' THEN 0.25 ELSE 0 END +
      CASE WHEN lower(c.work) LIKE '%' || lower(p_query) || '%' THEN 0.20 ELSE 0 END
    )::real AS db_score
  FROM rag_chunks AS c
  WHERE lower(c.work || ' ' || c.chapter || ' ' || c.content)
        LIKE '%' || lower(p_query) || '%'
  ORDER BY db_score DESC, c.index_pos
  LIMIT LEAST(GREATEST(p_limit, 1), 500);
$$;

CREATE OR REPLACE FUNCTION rag_search_vector(
  p_embedding halfvec(384),
  p_limit integer DEFAULT 120
)
RETURNS TABLE (
  id text,
  work text,
  chapter text,
  content text,
  source_url text,
  char_count integer,
  db_score real,
  vector_score real
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.id,
    c.work,
    c.chapter,
    c.content,
    c.source_url,
    c.char_count,
    (1 - (c.embedding <=> p_embedding))::real AS db_score,
    (1 - (c.embedding <=> p_embedding))::real AS vector_score
  FROM rag_chunks AS c
  WHERE c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_embedding
  LIMIT LEAST(GREATEST(p_limit, 1), 300);
$$;

-- 未配置在线 embedding 服务时，以最强字面命中片段的向量质心继续扩展近邻。
-- 这是可解释的语义邻域补召回，不冒充直接的问题向量。
CREATE OR REPLACE FUNCTION rag_search_vector_neighbors(
  p_seed_ids text[],
  p_limit integer DEFAULT 120
)
RETURNS TABLE (
  id text,
  work text,
  chapter text,
  content text,
  source_url text,
  char_count integer,
  db_score real,
  vector_score real
)
LANGUAGE sql
STABLE
AS $$
  WITH centroid AS (
    SELECT avg(c.embedding)::halfvec(384) AS embedding
    FROM rag_chunks AS c
    WHERE c.id = ANY(p_seed_ids) AND c.embedding IS NOT NULL
  )
  SELECT
    c.id,
    c.work,
    c.chapter,
    c.content,
    c.source_url,
    c.char_count,
    (1 - (c.embedding <=> centroid.embedding))::real AS db_score,
    (1 - (c.embedding <=> centroid.embedding))::real AS vector_score
  FROM rag_chunks AS c
  CROSS JOIN centroid
  WHERE c.embedding IS NOT NULL AND centroid.embedding IS NOT NULL
  ORDER BY c.embedding <=> centroid.embedding
  LIMIT LEAST(GREATEST(p_limit, 1), 300);
$$;
