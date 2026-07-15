import { neon } from "@neondatabase/serverless";

export class DatabaseTimeoutError extends Error {
  constructor(timeoutMs, options = {}) {
    super(`Database request timed out after ${timeoutMs}ms`, options);
    this.name = "DatabaseTimeoutError";
    this.code = "DATABASE_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

export async function runDatabaseQuery(operation, timeoutMs = 8000) {
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  const controller = new AbortController();
  let timer;

  try {
    const sql = neon(connectionString, {
      fetchOptions: { signal: controller.signal },
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DatabaseTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    return await Promise.race([operation(sql), timeout]);
  } catch (error) {
    if (error instanceof DatabaseTimeoutError) throw error;
    if (controller.signal.aborted) {
      throw new DatabaseTimeoutError(timeoutMs, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function safeMessage(error) {
  return String(error?.message || "")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url-redacted]")
    .slice(0, 500);
}

export function databaseErrorCode(error) {
  if (error?.code === "DATABASE_TIMEOUT") return "DATABASE_TIMEOUT";
  const message = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
  if (/blocked network|not allowed to connect|ip.*not allowed/.test(message)) {
    return "NETWORK_BLOCKED";
  }
  if (/password authentication failed|authentication failed|invalid password/.test(message)) {
    return "AUTHENTICATION_FAILED";
  }
  if (/database .* does not exist/.test(message)) return "DATABASE_NOT_FOUND";
  if (/relation .* does not exist|undefined table/.test(message)) return "SCHEMA_MISSING";
  if (/fetch failed|enotfound|econnreset|econnrefused|network/.test(message)) {
    return "NETWORK_ERROR";
  }
  return error?.code || error?.cause?.code || "DATABASE_UNAVAILABLE";
}

export function databaseErrorDetails(error, startedAt = Date.now()) {
  const connectionString = String(process.env.DATABASE_URL || "");
  return {
    code: databaseErrorCode(error),
    elapsedMs: Date.now() - startedAt,
    region: process.env.VERCEL_REGION || "local",
    nodeVersion: process.version,
    pooled: /-pooler\./i.test(connectionString),
    errorName: error?.name || "Error",
    errorMessage: safeMessage(error),
    causeName: error?.cause?.name || null,
    causeCode: error?.cause?.code || null,
    causeMessage: safeMessage(error?.cause) || null,
  };
}

export function isDatabaseTimeout(error) {
  return error?.code === "DATABASE_TIMEOUT";
}
