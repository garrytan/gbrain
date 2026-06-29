#!/usr/bin/env node
/**
 * server.mjs — agent-voice reference server.
 *
 * WebRTC-first: the primary surface is browser-side via /call.
 *   GET  /                 → redirect to /call
 *   GET  /call             → serves public/call.html (browser client)
 *   POST /session          → SDP exchange with OpenAI Realtime; returns SDP answer
 *   POST /tool             → tool-call dispatch from WebRTC data channel
 *   GET  /health           → {ok:true} liveness
 *
 * Twilio inbound (optional adapter):
 *   POST /voice            → returns TwiML to open a Media Stream
 *   WSS  /ws               → Twilio↔OpenAI Realtime audio bridge
 *   POST /fallback         → fallback TwiML (forward to operator's cell)
 *
 * The Twilio path is OPTIONAL; recipe Option A (WebRTC-only) doesn't need
 * it. Operators wiring Twilio inbound implement the bridge themselves
 * against `lib/twilio-bridge.mjs` (port-ready stubs included).
 *
 * Configuration via env:
 *   PORT                      default 8765
 *   OPENAI_API_KEY            required for /session
 *   OPENAI_REALTIME_MODEL     default 'gpt-4o-realtime-preview'
 *   DEFAULT_PERSONA           default 'venus' (one of 'mars' | 'venus')
 *   BRAIN_ROOT                passed through to context-builder
 *   TIMEZONE                  passed through to context-builder
 *   AGENT_VOICE_CORS_ORIGIN   comma-separated allowlist of browser origins
 *                             permitted to read /tool and /session responses.
 *                             Unset (default) ⇒ no Access-Control-Allow-Origin
 *                             emitted — same-origin browser clients still work,
 *                             cross-origin reads are denied by the browser.
 *
 * Security posture: this is reference code. It does NOT ship hardening for
 * production deployment (no rate limiting, no Twilio signature validation).
 * Operators add those at install time per the recipe's "production checklist."
 * CORS, however, is default-deny here: /tool dispatches gbrain read ops and
 * /session spends the operator's OPENAI_API_KEY, so reflecting an arbitrary
 * Origin would let any web page read brain contents or consume the quota
 * from a visiting browser. Set AGENT_VOICE_CORS_ORIGIN explicitly to allow
 * known browser origins.
 */

import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { buildSystemPrompt } from './prompt.mjs';
import { dispatchTool, getEffectiveAllowlist } from './tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const PORT = parseInt(process.env.PORT || '8765', 10);
const DEFAULT_PERSONA = (process.env.DEFAULT_PERSONA || 'venus').toLowerCase();
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const OPENAI_REALTIME_URL = 'https://api.openai.com/v1/realtime/calls';

/**
 * Parse the CORS allowlist from AGENT_VOICE_CORS_ORIGIN (comma-separated).
 * Returns null when unset — meaning "do not emit Access-Control-Allow-Origin
 * at all" (default-deny; same-origin requests still work). Mirrors the
 * GBRAIN_HTTP_CORS_ORIGIN pattern used by the main gbrain HTTP transport.
 */
function parseCorsAllowlist() {
  const v = process.env.AGENT_VOICE_CORS_ORIGIN;
  if (!v) return null;
  const set = new Set(v.split(',').map((s) => s.trim()).filter(Boolean));
  return set.size > 0 ? set : null;
}

const CORS_ALLOWLIST = parseCorsAllowlist();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function readBody(req, max = 1 << 20) {
  const chunks = [];
  let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > max) {
      const err = new Error('payload too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function serveStatic(res, relPath) {
  const full = join(PUBLIC_DIR, relPath);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  if (!existsSync(full)) return send(res, 404, 'not found');
  try {
    const stat = statSync(full);
    if (!stat.isFile()) return send(res, 404, 'not found');
    const body = readFileSync(full);
    const mime = MIME[extname(full)] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': mime,
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    send(res, 500, `read error: ${err.message}`);
  }
}

// ── /session: WebRTC SDP exchange with OpenAI Realtime ────────────────
async function handleSession(req, res) {
  if (req.method !== 'POST') return send(res, 405, 'method not allowed');
  if (!process.env.OPENAI_API_KEY) {
    return sendJson(res, 500, { error: 'OPENAI_API_KEY not set' });
  }

  let sdpOffer;
  try {
    sdpOffer = (await readBody(req)).toString('utf8');
  } catch (err) {
    return send(res, err.status || 400, err.message);
  }

  if (!sdpOffer || !sdpOffer.startsWith('v=')) {
    return sendJson(res, 400, { error: 'missing or malformed SDP offer' });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const persona = (url.searchParams.get('persona') || DEFAULT_PERSONA).toLowerCase();
  // #1851: a call link minted from a Telegram topic carries topicId (+ an
  // optional display topicName). The id is the ONLY topic data we accept over
  // the wire — buildSystemPrompt resolves the recent-conversation context from
  // the brain server-side. We never accept topic CONTENT as a param (that would
  // be prompt injection + a leak into URLs/referrers/access logs).
  const topicId = url.searchParams.get('topicId') || undefined;
  const topicName = url.searchParams.get('topicName') || undefined;

  // Build the persona-aware system prompt at session start.
  const systemPrompt = await buildSystemPrompt({
    persona,
    brainRoot: process.env.BRAIN_ROOT,
    timezone: process.env.TIMEZONE,
    topicId,
    topicName,
  });

  // Session config for OpenAI Realtime /v1/realtime/calls.
  // Important gotchas (from production):
  //   - `voice` goes under `audio.output.voice`, NOT top-level
  //   - Do NOT send `turn_detection` (rejected by /v1/realtime/calls)
  //   - All `session.update` calls must include `type: 'realtime'`
  const personaVoice = persona === 'mars' ? 'Orus' : 'Aoede';
  const sessionConfig = {
    type: 'realtime',
    model: OPENAI_REALTIME_MODEL,
    audio: { output: { voice: personaVoice } },
    instructions: systemPrompt,
    // Tools advertised to the model; the actual dispatch happens via /tool.
    tools: getEffectiveAllowlist().map((name) => ({
      type: 'function',
      name,
      description: `gbrain operation: ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    })),
  };

  // OpenAI Realtime expects multipart/form-data with two parts:
  //   sdp:     the WebRTC SDP offer
  //   session: JSON.stringify(sessionConfig)
  const form = new FormData();
  form.set('sdp', sdpOffer);
  form.set('session', JSON.stringify(sessionConfig));

  try {
    const upstream = await fetch(OPENAI_REALTIME_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      console.error(`[session] OpenAI Realtime returned ${upstream.status}: ${text.slice(0, 400)}`);
      return send(res, upstream.status, text);
    }
    const sdpAnswer = await upstream.text();
    res.writeHead(200, { 'content-type': 'application/sdp; charset=utf-8' });
    res.end(sdpAnswer);
  } catch (err) {
    console.error(`[session] upstream error: ${err.message}`);
    sendJson(res, 502, { error: 'upstream_unreachable', detail: err.message });
  }
}

// ── /tool: tool-call dispatch from the WebRTC data channel ────────────
async function handleTool(req, res) {
  if (req.method !== 'POST') return send(res, 405, 'method not allowed');
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (err) {
    return sendJson(res, 400, { error: 'invalid_json', detail: err.message });
  }
  const { name, arguments: params } = body || {};
  if (typeof name !== 'string') {
    return sendJson(res, 400, { error: 'missing tool name' });
  }
  const result = await dispatchTool(name, params || {});
  // dispatchTool always returns either {data} or {error}; never throws.
  sendJson(res, 200, result);
}

// ── /voice: Twilio TwiML stub (optional Twilio inbound) ───────────────
function handleVoiceTwiml(req, res) {
  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/ws" />
  </Connect>
</Response>`;
  res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
  res.end(twiml);
}

/**
 * Apply CORS headers to the response, gated on the configured allowlist.
 *
 * Default-deny: when AGENT_VOICE_CORS_ORIGIN is unset OR the request Origin
 * is not in the allowlist, NO Access-Control-Allow-Origin header is emitted.
 * Browsers will then block any cross-origin attempt to read the response
 * body (which would otherwise leak brain contents from /tool or burn through
 * the operator's OpenAI quota via /session).
 *
 * Same-origin requests are unaffected (the browser doesn't enforce CORS on
 * them), so the bundled public/call.html keeps working out of the box.
 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!CORS_ALLOWLIST || !origin || !CORS_ALLOWLIST.has(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── HTTP router ──────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS: default-deny. Allowlist via AGENT_VOICE_CORS_ORIGIN (comma-separated).
  applyCors(req, res);
  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/' || url.pathname === '/call') {
      return serveStatic(res, 'call.html');
    }
    if (url.pathname === '/directory') {
      return serveStatic(res, 'directory.html');
    }
    if (url.pathname === '/session') {
      return handleSession(req, res);
    }
    if (url.pathname === '/tool') {
      return handleTool(req, res);
    }
    if (url.pathname === '/voice') {
      return handleVoiceTwiml(req, res);
    }
    if (url.pathname.startsWith('/public/')) {
      return serveStatic(res, url.pathname.slice('/public/'.length));
    }
    // Static fallback for files in public/ at root path (e.g., /rnnoise-processor.js).
    const candidate = url.pathname.slice(1);
    if (candidate && !candidate.includes('..')) {
      const candPath = join(PUBLIC_DIR, candidate);
      if (existsSync(candPath) && statSync(candPath).isFile()) {
        return serveStatic(res, candidate);
      }
    }
    send(res, 404, 'not found');
  } catch (err) {
    console.error(`[server] ${err.message}\n${err.stack}`);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[agent-voice] listening on http://localhost:${PORT}`);
  console.log(`[agent-voice] default persona: ${DEFAULT_PERSONA}`);
  console.log(`[agent-voice] read-only tools: ${getEffectiveAllowlist().join(', ')}`);
  if (!CORS_ALLOWLIST) {
    console.log('[agent-voice] CORS: default-deny. Set AGENT_VOICE_CORS_ORIGIN=https://your.app to allow browser clients on other origins.');
  } else {
    console.log(`[agent-voice] CORS allowlist: ${[...CORS_ALLOWLIST].join(', ')}`);
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
