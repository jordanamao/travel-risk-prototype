import backend from "../../server.js";

const { handleAnalyze } = backend;

export default async (req) => {
  syncNetlifyEnv("OPENAI_API_KEY");
  syncNetlifyEnv("OPENAI_MODEL");

  if (req.method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const captured = await captureAnalyzeResponse(new URL(req.url));
  return new Response(captured.body, {
    status: captured.status,
    headers: captured.headers
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

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
