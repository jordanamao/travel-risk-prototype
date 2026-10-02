import { EventEmitter } from "events";
import backend from "../../server.js";

const { handleTrips } = backend;

export default async (req) => {
  syncNetlifyEnv("DATABASE_URL");
  syncNetlifyEnv("DEFAULT_USER_EMAIL");

  const url = new URL(req.url);
  const captured = await captureTripsResponse(req, url);
  return new Response(captured.body, {
    status: captured.status,
    headers: captured.headers
  });
};

export const config = {
  path: "/api/trips/:id",
  method: ["DELETE"]
};

function syncNetlifyEnv(name) {
  if (process.env[name]) return;
  const value = globalThis.Netlify && globalThis.Netlify.env
    ? globalThis.Netlify.env.get(name)
    : "";
  if (value) process.env[name] = value;
}

async function captureTripsResponse(req, url) {
  let status = 200;
  let headers = { "Content-Type": "application/json; charset=utf-8" };
  let body = "";

  const requestShim = new EventEmitter();
  requestShim.method = req.method;
  requestShim.headers = Object.fromEntries(req.headers.entries());

  const responseShim = {
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = { ...headers, ...nextHeaders };
    },
    end(content = "") {
      body = content;
    }
  };

  const pending = handleTrips(requestShim, responseShim, url);
  const text = await req.text();
  if (text) requestShim.emit("data", Buffer.from(text));
  requestShim.emit("end");
  await pending;
  return { status, headers, body };
}
