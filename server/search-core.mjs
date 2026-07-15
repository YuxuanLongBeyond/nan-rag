const QUERY_NOISE = /南怀瑾|南先生|南老师|先生|老师|请问|请教|能否|可以|如何|怎么|怎样|什么是|是什么|为什么|为何|认为|看待|理解|解释|讲过|说过|一下|相关/g;
const CONNECTORS = /(?:以及|关于|对于|其中|里的|中的|和|与|及|对)/g;
const SINGLE_CHAR_TERMS = new Set([
  "仁", "义", "礼", "智", "信", "道", "德", "心", "气", "禅", "佛",
  "空", "定", "慧", "戒", "命", "性", "孝", "诚", "静", "观",
]);

function segmentWords(value) {
  if (typeof Intl?.Segmenter !== "function") return [];
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return [...segmenter.segment(value)]
    .filter((item) => item.isWordLike)
    .map((item) => item.segment.toLowerCase());
}

export function normalizeQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(QUERY_NOISE, " ")
    .replace(/[^\u3400-\u9fffa-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const normalized = normalizeQuery(value);
  const latin = normalized.match(/[a-z0-9]+/g) || [];
  const runs = normalized.match(/[\u3400-\u9fff]+/g) || [];
  const tokens = [...latin];

  for (const run of runs) {
    if (run.length <= 10) tokens.push(run);
    for (const word of segmentWords(run)) {
      if (word.length >= 2 || SINGLE_CHAR_TERMS.has(word)) tokens.push(word);
    }
    for (let n = 2; n <= Math.min(4, run.length); n += 1) {
      for (let i = 0; i <= run.length - n; i += 1) {
        tokens.push(run.slice(i, i + n));
      }
    }
  }
  return [...new Set(tokens)];
}

export function buildSearchTerms(value, maxTerms = 5) {
  const normalized = normalizeQuery(value);
  if (!normalized) return [];

  const terms = [];
  const add = (term) => {
    const clean = term.replace(/\s+/g, "").trim();
    if ((clean.length < 2 && !SINGLE_CHAR_TERMS.has(clean)) || terms.includes(clean)) return;
    terms.push(clean);
  };

  for (const run of normalized.split(/\s+/)) {
    if (run.length <= 14) add(run);
    for (const part of run.replace(CONNECTORS, " ").split(/\s+/)) add(part);
    for (const word of segmentWords(run)) {
      if (word.length >= 2 || SINGLE_CHAR_TERMS.has(word)) add(word);
    }
    if (run.length >= 3) {
      add(run.slice(-2));
      add(run.slice(0, 2));
      add(run.slice(-3));
      add(run.slice(0, 3));
    }
  }

  const grams = tokenize(normalized)
    .filter((token) => token.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const gram of grams) {
    if (terms.length >= maxTerms) break;
    add(gram);
  }

  return terms.slice(0, maxTerms);
}

export function normalizeSemanticTerms(values, query = "", maxTerms = 8) {
  if (!Array.isArray(values)) return [];
  const normalizedQuery = normalizeQuery(query).replace(/\s+/g, "");
  const terms = [];
  for (const value of values) {
    const clean = normalizeQuery(value).replace(/\s+/g, "");
    if (clean.length < 2 || clean.length > 18) continue;
    if (normalizedQuery.includes(clean) || terms.includes(clean)) continue;
    terms.push(clean);
    if (terms.length >= maxTerms) break;
  }
  return terms;
}

export function buildSemanticSearchTerms(query, semanticTerms, maxTerms = 8) {
  const terms = buildSearchTerms(query, 3);
  for (const term of normalizeSemanticTerms(semanticTerms, query)) {
    if (!terms.includes(term)) terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  return terms;
}

function makeGrams(value) {
  const clean = String(value || "").normalize("NFKC").toLowerCase()
    .replace(/[^\u3400-\u9fffa-z0-9]+/g, "");
  const grams = new Map();
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i <= clean.length - n; i += 1) {
      const gram = clean.slice(i, i + n);
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }
  }
  return grams;
}

function cosineLike(a, b) {
  let overlap = 0;
  let aSize = 0;
  let bSize = 0;
  for (const [gram, count] of a) {
    aSize += count * count;
    overlap += Math.min(count, b.get(gram) || 0);
  }
  for (const count of b.values()) bSize += count * count;
  return aSize && bSize ? overlap / Math.sqrt(aSize * bSize) : 0;
}

function coverage(text, tokens) {
  let matched = 0;
  let total = 0;
  for (const token of tokens) {
    if (token.length < 2 && !SINGLE_CHAR_TERMS.has(token)) continue;
    const weight = token.length === 1 ? 0.55 : Math.min(2.5, token.length / 2);
    total += weight;
    if (text.includes(token)) matched += weight;
  }
  return total ? matched / total : 0;
}

export function rankCandidates(rows, query, mode, topK, minScore, semanticTerms = []) {
  const tokens = tokenize(query);
  const focusTerms = buildSearchTerms(query).filter((term) => term.length <= 4);
  const queryGrams = makeGrams(query);
  const phrase = normalizeQuery(query).replace(/\s+/g, "");
  const semanticSignals = normalizeSemanticTerms(semanticTerms, query).map((term) => ({
    term,
    tokens: tokenize(term),
    grams: makeGrams(term),
  }));

  const scored = rows.map((row) => {
    const text = `${row.work || ""} ${row.chapter || ""} ${row.content || ""}`.toLowerCase();
    const compact = text.replace(/\s+/g, "");
    const dbScore = Math.max(0, Math.min(1, Number(row.db_score) || 0));

    if (mode === "exact") {
      return { row, score: Math.max(0.2, dbScore) };
    }

    const keywordScore = coverage(text, tokens);
    const focusScore = coverage(text, focusTerms);
    const titleScore = coverage(String(row.chapter || "").toLowerCase(), tokens);
    const ngramScore = cosineLike(queryGrams, makeGrams(text));
    const exactBoost = phrase.length >= 3 && compact.includes(phrase) ? 0.12 : 0;
    let semanticScore = 0;
    let semanticTitleScore = 0;
    if (mode === "semantic") {
      const textGrams = makeGrams(text);
      const semanticValues = [];
      const semanticTitle = `${row.work || ""} ${row.chapter || ""}`.toLowerCase();
      for (const signal of semanticSignals) {
        const exact = compact.includes(signal.term) ? 1 : 0;
        const related = coverage(text, signal.tokens) * 0.65 +
          cosineLike(signal.grams, textGrams) * 0.35;
        semanticValues.push(Math.max(exact, related));
        if (semanticTitle.replace(/\s+/g, "").includes(signal.term)) {
          semanticTitleScore = 1;
        } else {
          semanticTitleScore = Math.max(
            semanticTitleScore,
            coverage(semanticTitle, signal.tokens),
          );
        }
      }
      if (semanticValues.length > 0) {
        const strongest = Math.max(...semanticValues);
        const average = semanticValues.reduce((sum, value) => sum + value, 0) /
          semanticValues.length;
        semanticScore = strongest * 0.45 + average * 0.55;
      }
    }

    let score;
    if (mode === "semantic") {
      score = dbScore * 0.14 + keywordScore * 0.12 + ngramScore * 0.08 +
        semanticScore * 0.48 + semanticTitleScore * 0.10 +
        titleScore * 0.03 + exactBoost;
    } else if (mode === "broad") {
      score = dbScore * 0.18 + keywordScore * 0.22 + focusScore * 0.22 +
        ngramScore * 0.25 + titleScore * 0.08 + exactBoost;
    } else {
      score = dbScore * 0.12 + keywordScore * 0.23 + focusScore * 0.32 +
        ngramScore * 0.15 + titleScore * 0.08 + exactBoost;
    }
    return { row, score: Math.min(1, score) };
  });

  scored.sort((a, b) => b.score - a.score);
  const selected = [];
  const deferred = [];
  const sectionCounts = new Map();
  for (const result of scored) {
    if (result.score < minScore) continue;
    const section = `${result.row.work}\u0000${result.row.chapter}`;
    const count = sectionCounts.get(section) || 0;
    if (count < 2 && selected.length < topK) {
      selected.push(result);
      sectionCounts.set(section, count + 1);
    } else {
      deferred.push(result);
    }
  }
  for (const result of deferred) {
    if (selected.length >= topK) break;
    selected.push(result);
  }
  return selected;
}

export function mergeCandidateSets(resultSets) {
  const merged = new Map();
  for (const rows of resultSets) {
    for (const row of rows) {
      const previous = merged.get(row.id);
      if (!previous || Number(row.db_score) > Number(previous.db_score)) {
        merged.set(row.id, row);
      }
    }
  }
  return [...merged.values()];
}
