#!/usr/bin/env bun
/**
 * gemini-embed-shim — pretend to be OpenAI /v1/embeddings, actually call
 * Google Gemini's embedding endpoint. Lets gbrain's embedding.ts (hardcoded
 * to `new OpenAI()`) work against Gemini without touching upstream src/.
 *
 * Wiring:
 *   export NANO_BANANA_API_KEY=<google genai key>
 *   bun run server.ts --port 7222
 *   # in v2 .env:
 *   OPENAI_BASE_URL=http://127.0.0.1:7222/v1
 *   OPENAI_API_KEY=stub   # ignored by shim but SDK refuses empty string
 *
 *   gbrain embed --all
 *
 * Endpoint contract (OpenAI side):
 *   POST /v1/embeddings
 *     { model: "text-embedding-3-large", input: string | string[], dimensions?: 1536 }
 *   →
 *     { object:"list", data:[{object:"embedding", index, embedding:number[]}],
 *       model, usage:{prompt_tokens, total_tokens} }
 *
 * Upstream (Gemini):
 *   POST https://generativelanguage.googleapis.com/v1beta/models/<model>:batchEmbedContents
 *     x-goog-api-key: <NANO_BANANA_API_KEY>
 *     { requests:[{ model:"models/<m>", content:{parts:[{text}]}, outputDimensionality, taskType }] }
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT = Number(process.env.OPENAI_SHIM_PORT ?? readFlag("--port") ?? 7222);
const GEMINI_MODEL = process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-2-preview";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const KEY = process.env.NANO_BANANA_API_KEY ?? "";

function readFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!KEY) {
  console.error("NANO_BANANA_API_KEY env var is required");
  process.exit(1);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

type GeminiSingleResp = { embedding: { values: number[] } };
type GeminiBatchResp = { embeddings: { values: number[] }[] };

async function geminiEmbed(texts: string[], dims: number): Promise<number[][]> {
  // Use batchEmbedContents for efficiency
  const url = `${GEMINI_BASE}/models/${GEMINI_MODEL}:batchEmbedContents`;
  const body = {
    requests: texts.map((text) => ({
      model: `models/${GEMINI_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: dims,
      taskType: "RETRIEVAL_DOCUMENT",
    })),
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`gemini batchEmbedContents ${r.status}: ${text}`);
  }
  const data = (await r.json()) as GeminiBatchResp;
  return data.embeddings.map((e) => e.values);
}

function float32ToBase64(floats: number[]): string {
  const buf = new ArrayBuffer(floats.length * 4);
  const view = new Float32Array(buf);
  for (let i = 0; i < floats.length; i++) view[i] = floats[i];
  return Buffer.from(buf).toString("base64");
}

async function geminiEmbedFallbackSingle(texts: string[], dims: number): Promise<number[][]> {
  // Fallback if batch not supported on this model
  const out: number[][] = [];
  for (const text of texts) {
    const url = `${GEMINI_BASE}/models/${GEMINI_MODEL}:embedContent`;
    const body = {
      model: `models/${GEMINI_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: dims,
      taskType: "RETRIEVAL_DOCUMENT",
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`gemini embedContent ${r.status}: ${await r.text()}`);
    const data = (await r.json()) as GeminiSingleResp;
    out.push(data.embedding.values);
  }
  return out;
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url?.startsWith("/v1/embeddings")) {
    try {
      const body = JSON.parse(await readBody(req));
      const rawInput = body.input;
      const texts: string[] = Array.isArray(rawInput) ? rawInput : [rawInput];
      const dims = Number(body.dimensions ?? 1536);
      const model = body.model ?? "text-embedding-3-large";
      console.log(
        `[shim] req: model=${model} dims=${dims} input_kind=${Array.isArray(rawInput) ? `array(${texts.length})` : "string"} encoding_format=${body.encoding_format ?? "(default)"} keys=${Object.keys(body).join(",")}`
      );

      let vectors: number[][];
      try {
        vectors = await geminiEmbed(texts, dims);
      } catch (e) {
        console.warn(`batch failed, falling back to single: ${e}`);
        vectors = await geminiEmbedFallbackSingle(texts, dims);
      }

      // OpenAI SDK v4 defaults encoding_format="base64" for performance.
      // If request has no encoding_format, return base64 (SDK decodes via Core.toFloat32Array).
      // If "float", return number[] (SDK returns response as-is).
      const wantBase64 = (body.encoding_format ?? "base64") === "base64";

      const resp = {
        object: "list",
        data: vectors.map((embedding, index) => ({
          object: "embedding",
          index,
          embedding: wantBase64 ? float32ToBase64(embedding) : embedding,
        })),
        model,
        usage: {
          prompt_tokens: texts.reduce((a, t) => a + Math.ceil(t.length / 4), 0),
          total_tokens: texts.reduce((a, t) => a + Math.ceil(t.length / 4), 0),
        },
      };
      send(res, 200, resp);
    } catch (e) {
      console.error(e);
      send(res, 500, { error: { message: String(e), type: "shim_error" } });
    }
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { status: "ok", upstream: "gemini", model: GEMINI_MODEL });
  }
  send(res, 404, { error: { message: "not found", type: "not_found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`gemini-embed-shim listening on http://127.0.0.1:${PORT}/v1`);
  console.log(`upstream: ${GEMINI_BASE}`);
  console.log(`model:    ${GEMINI_MODEL}`);
  console.log(`Wire gbrain:  export OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1`);
});
