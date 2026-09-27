import backend from "../../server.js";

const { handleAnalyze } = backend;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const responseCache = globalThis.__travelRiskAnalyzeCache || new Map();
globalThis.__travelRiskAnalyzeCache = responseCache;

export default async (req) => {
  syncNetlifyEnv("OPENAI_API_KEY");
  syncNetlifyEnv("OPENAI_MODEL");

  if (req.method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const url = new URL(req.url);
  const cacheKey = cacheKeyFor(url);
  const cached = getCachedResponse(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      headers: { ...cached.headers, "X-Travel-Risk-Cache": "HIT" }
    });
  }

  const captured = await captureAnalyzeResponse(url);
  if (captured.status === 200) {
    setCachedResponse(cacheKey, captured);
  }

  return new Response(captured.body, {
    status: captured.status,
    headers: { ...captured.headers, "X-Travel-Risk-Cache": "MISS" }
  });
};

export const config = {
  path: "/api/analyze",
  method: ["GET"]
};

function syncNetlifyEnv(name) {
  if (process.env[name]) return;
  const value = globalThis.Netlify && globalThis.Netlify.env
    ? globalThis.Netlify.env.get(name)
    : "";
  if (value) process.env[name] = value;
}

async function captureAnalyzeResponse(url) {
  let status = 200;
  let headers = { "Content-Type": "application/json; charset=utf-8" };
  let body = "";

  const responseShim = {
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = { ...headers, ...nextHeaders };
    },
    end(content = "") {
      body = content;
    }
  };

  await handleAnalyze(url, responseShim);
  return { status, headers, body };
}

function cacheKeyFor(url) {
  const normalized = new URL(url);
  const sortedParams = new URLSearchParams();
  [...normalized.searchParams.entries()]
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey)
    )
    .forEach(([key, value]) => sortedParams.append(key, value));
  return `${normalized.pathname}?${sortedParams.toString()}`;
}

function getCachedResponse(key) {
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return cached;
}

function setCachedResponse(key, response) {
  responseCache.set(key, {
    ...response,
    createdAt: Date.now()
  });
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
