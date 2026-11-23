import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 1_000_000;
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function manualReview() {
  return { status: "manual_review", topic: null, draft: null };
}

async function callModel(text) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("model_timeout"));
    }, MODEL_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      classify(text, { signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseModelResponse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const { topic, draft } = parsed;
  if (!ALLOWED_TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;

  return { status: "ready", topic, draft };
}

async function handleTriage(request, response) {
  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return json(response, 400, { status: "invalid_input" });
  }

  const { text } = payload;
  if (typeof text !== "string" || text.trim() === "") {
    return json(response, 400, { status: "invalid_input" });
  }

  let raw;
  try {
    raw = await callModel(text);
  } catch {
    return json(response, 200, manualReview());
  }

  return json(response, 200, parseModelResponse(raw) ?? manualReview());
}

export function createTriageServer() {
  return createServer(async (request, response) => {
    const url = request.url ?? "/";

    if (request.method === "GET" && url === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(html);
      return;
    }

    if (request.method !== "POST" || url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }

    try {
      await handleTriage(request, response);
    } catch {
      if (response.headersSent) response.end();
      else json(response, 500, { status: "server_error" });
    }
  });
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const server = createTriageServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Входящие заявки: http://127.0.0.1:${server.address().port}`);
  });
}
