CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS rag_chunks (
  id text PRIMARY KEY,
  index_pos integer NOT NULL,
  work text NOT NULL,
  chapter text NOT NULL DEFAULT '',
  content text NOT NULL,
  source_url text NOT NULL DEFAULT '',
  char_count integer NOT NULL DEFAULT 0,
  build_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rag_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_chunks_work_idx ON rag_chunks (work);
CREATE INDEX IF NOT EXISTS rag_chunks_search_trgm_idx
  ON rag_chunks USING gin
  ((lower(work || ' ' || chapter || ' ' || content)) gin_trgm_ops);

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
