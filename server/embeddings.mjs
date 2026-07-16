import { InferenceClient } from "@huggingface/inference";

export const EMBEDDING_MODEL =
  "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;

const CACHE_LIMIT = 100;
const cache = new Map();

function normalizeVector(value) {
  let vector = value;
  while (Array.isArray(vector) && vector.length === 1 && Array.isArray(vector[0])) {
    vector = vector[0];
  }
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM) return null;
  const numbers = vector.map(Number);
  if (numbers.some((item) => !Number.isFinite(item))) return null;
  const norm = Math.sqrt(numbers.reduce((sum, item) => sum + item * item, 0));
  if (!norm) return null;
  return numbers.map((item) => item / norm);
}

function remember(key, vector) {
  cache.set(key, vector);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

export function vectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM) {
    throw new Error("查询向量维度不正确");
  }
  return `[${vector.map((item) => Number(item).toFixed(7)).join(",")}]`;
}

export async function embedQuery(query, timeoutMs = 8000) {
  const token = process.env.HF_TOKEN;
  if (!token) return { vector: null, reason: "HF_TOKEN_MISSING" };

  const key = String(query || "").normalize("NFKC").trim();
  if (!key) return { vector: null, reason: "EMPTY_QUERY" };
  if (cache.has(key)) return { vector: cache.get(key), reason: "CACHE" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const client = new InferenceClient(token);
    const output = await client.featureExtraction({
      provider: "hf-inference",
      model: EMBEDDING_MODEL,
      inputs: key,
      normalize: true,
    }, { signal: controller.signal });
    const vector = normalizeVector(output);
    if (!vector) return { vector: null, reason: "INVALID_RESPONSE" };
    remember(key, vector);
    return { vector, reason: "REMOTE" };
  } catch (error) {
    console.warn("Query embedding unavailable", {
      name: error?.name,
      message: String(error?.message || error).slice(0, 160),
    });
    return {
      vector: null,
      reason: controller.signal.aborted ? "TIMEOUT" : "PROVIDER_ERROR",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const _test = { normalizeVector };
