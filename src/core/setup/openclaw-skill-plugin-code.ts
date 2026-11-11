/**
 * openclaw-skill-plugin-code.ts — the two files of the generated OpenClaw
 * plugin `gbrain-skill-resolver` (written by openclaw-skill-plugin.ts):
 * index.js, the loader the gateway imports, and worker.js, the worker thread
 * that runs the resolver library. Plain ES modules with no dependencies: the
 * gateway runs them under its own Node. Only paths and the gbrain bin are
 * baked in, never mode, pins or a library path, so they change only when gbrain
 * changes the plugin code itself.
 */

export const OPENCLAW_SKILL_PLUGIN_CODE_VERSION = 1;

export interface LoaderConstants { home: string; libDir: string; statePath: string; logDir: string; gbrainBin: string; gbrainHomeEnv: string | null }

const WORKER_JS = String.raw`// Managed by gbrain setup openclaw (gbrain-skill-resolver worker thread); a re-run rewrites this file.
// Runs every synchronous resolver step off the gateway's event loop. It loads the gbrain library only
// by content address: the file must sit in the baked library directory, belong to this user, be
// writable by nobody else and hash to the sha256 the state names; the checked bytes are what run.
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const { home, libDir, sha } = workerData;
const pending = new Map();
const lastBuild = new Map();
let building = null;

function refuse(code) { const e = new Error(code); e.code = code; return e; }

async function loadLibrary() {
  if (!/^[0-9a-f]{64}$/.test(String(sha))) throw refuse('skill_resolver_library_missing');
  let real;
  try { real = realpathSync(join(libDir, sha + '.mjs')); } catch { throw refuse('skill_resolver_library_missing'); }
  if (!real.startsWith(realpathSync(libDir) + sep)) throw refuse('skill_resolver_library_mismatch');
  const st = statSync(real);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw refuse('skill_resolver_library_mismatch');
  if (st.mode & 0o022) throw refuse('skill_resolver_library_mismatch');
  const bytes = readFileSync(real);
  if (createHash('sha256').update(bytes).digest('hex') !== sha) throw refuse('skill_resolver_library_mismatch');
  return import('data:text/javascript;base64,' + bytes.toString('base64'));
}

const ready = loadLibrary().then((lib) => ({ lib }), (e) => ({ code: e && e.code ? e.code : 'skill_resolver_library_mismatch' }));

function rebuild(lib, catalog, dirs) {
  if (building || !Array.isArray(dirs) || dirs.length === 0) return;
  if (Date.now() - (lastBuild.get(catalog) || 0) < 60_000) return;
  lastBuild.set(catalog, Date.now());
  building = Promise.resolve().then(() => lib.buildSkillIndex({ catalog, dirs, harness: 'openclaw' }, { home }))
    .then(() => parentPort.postMessage({ type: 'rebuilt', catalog }), (e) => parentPort.postMessage({ type: 'rebuilt', catalog, code: (e && e.code) || 'skill_resolver_internal' }))
    .finally(() => { building = null; });
}

parentPort.on('message', async (m) => {
  const loaded = await ready;
  if (m.type === 'warm') { parentPort.postMessage({ type: 'warm', version: loaded.lib ? loaded.lib.GBRAIN_VERSION : null, code: loaded.code || null }); return; }
  if (m.type === 'discard') { pending.delete(m.id); return; }
  if (m.type === 'commit') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p && loaded.lib) loaded.lib.commitSessionAsync(home, p.key, p.delta).catch(() => {});
    return;
  }
  if (m.type === 'rebuild') { if (loaded.lib) rebuild(loaded.lib, m.catalog, m.dirs); return; }
  if (m.type !== 'resolve') return;
  if (!loaded.lib) { parentPort.postMessage({ id: m.id, code: loaded.code }); return; }
  const lib = loaded.lib;
  const now = Date.now();
  for (const [id, p] of pending) if (now - p.at > 30_000) pending.delete(id);
  const input = m.floor ? { ...m.input, min_match_strength: m.floor } : m.input;
  try {
    const opts = { home, catalogs: [m.catalog], failOpen: true, deadlineMs: m.deadlineMs, env: {} };
    const r = await lib.resolveSkills(input, opts);
    const out = input.shadow ? (r.shadowOutput || r.output) : r.output;
    if (r.pending) pending.set(m.id, { key: r.pending.key, delta: r.pending.delta, at: now });
    const code = out.error ? out.error.code : null;
    parentPort.postMessage({ id: m.id, block: out.block, names: out.suggestions.map((s) => s.name), strengths: out.suggestions.map((s) => s.match_strength),
      no_skill_reason: out.no_skill_reason, budget_exhausted: out.budget_exhausted, deduped: out.deduped.length, code, version: out.gbrain_version });
    if (out.meta && out.meta.index_stale || code === 'skill_index_missing' || code === 'skill_index_incompatible') rebuild(lib, m.catalog, m.dirs);
  } catch (e) {
    parentPort.postMessage({ id: m.id, code: (e && e.code) || 'skill_resolver_internal' });
  }
});
`;

const LOADER_JS = String.raw`// Managed by gbrain setup openclaw; a re-run rewrites this file. Remove: gbrain setup openclaw --skill-loading off
// gbrain-skill-resolver: after each user message, up to a few installed skills that fit it (appendContext),
// plus the operator's pinned skills (appendSystemContext). Mode, pins and agents come from a data-only
// state file gbrain writes, re-read when it changes, so a mode or pin change never reloads this plugin.
// Every failure path lets the turn proceed unchanged; no handler waits more than DEADLINE_MS.
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const HOME = __HOME__;
const LIB_DIR = __LIB_DIR__;
const STATE_PATH = __STATE__;
const LOG_DIR = __LOG_DIR__;
const GBRAIN_BIN = __BIN__;
const GBRAIN_HOME_ENV = __GBRAIN_HOME_ENV__;
const PLUGIN_VERSION = __PLUGIN_VERSION__;
const ID = 'gbrain-skill-resolver';
const DEADLINE_MS = Number(process.env.GBRAIN_TEST_OPENCLAW_SKILL_DEADLINE_MS) || 50;
const STUCK_AFTER = 3;
const KEEP_DAYS = 14;
const MEMO_MAX = 1000;
const SESSIONS_MAX = 5000;
const WORKER_URL = new URL('./worker.js', import.meta.url);

let state = null;
let stateMtime = -1;
let worker = null;
let workerSha = null;
let timeouts = 0;
let backoffMs = 1000;
let backoffUntil = 0;
let seq = 0;
let skewCheckedAt = 0;
let skewOpenUntil = 0;
let refreshing = false;
const waiters = new Map();
const memo = new Map();
const recent = new Map();
const resetNext = new Set();
const seenSessions = new Map();

function readState() {
  let mtime;
  try { mtime = statSync(STATE_PATH).mtimeMs; } catch { state = null; stateMtime = -1; return null; }
  if (mtime !== stateMtime) {
    stateMtime = mtime;
    try {
      const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      if (s && s.v === 1 && s.agents && typeof s.agents === 'object') state = s;
    } catch { /* a damaged file keeps the last good state */ }
  }
  return state;
}

function day(t) { return new Date(t).toISOString().slice(0, 10); }

let logTail = Promise.resolve();

function log(line) {
  try {
    const at = Date.now();
    const file = join(LOG_DIR, 'openclaw-' + day(at) + '.jsonl');
    const text = JSON.stringify({ at: new Date(at).toISOString(), ...line }) + '\n';
    logTail = logTail.then(() => appendFile(file, text, { mode: 0o600 })).catch(() => {});
  } catch { /* logging never fails a turn */ }
}

function pruneLogs() {
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const cutoff = day(Date.now() - KEEP_DAYS * 86_400_000);
    for (const f of readdirSync(LOG_DIR)) {
      const m = /^openclaw-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && m[1] < cutoff) unlinkSync(join(LOG_DIR, f));
    }
  } catch { /* best effort */ }
}

function backoff() {
  backoffUntil = Date.now() + backoffMs;
  backoffMs = Math.min(backoffMs * 2, 60_000);
}

function dropWorker() {
  const w = worker;
  worker = null;
  workerSha = null;
  for (const [, done] of waiters) done(null);
  waiters.clear();
  if (w) w.terminate().catch(() => {});
}

function ensureWorker(s) {
  if (worker && workerSha === s.library_sha256) return worker;
  if (Date.now() < backoffUntil) return null;
  if (worker) dropWorker();
  let w;
  try {
    w = new Worker(WORKER_URL, { execArgv: [], env: {}, workerData: { home: HOME, libDir: LIB_DIR, sha: s.library_sha256 } });
  } catch {
    log({ outcome: 'error', code: 'skill_resolver_worker_crash' });
    backoff();
    return null;
  }
  w.unref();
  w.on('message', (m) => {
    if (m && m.type === 'warm') { if (m.code) log({ outcome: 'error', code: m.code }); return; }
    if (m && m.type === 'rebuilt') { log({ outcome: 'rebuilt', catalog: m.catalog, code: m.code || null }); return; }
    const done = m && waiters.get(m.id);
    if (done) { waiters.delete(m.id); done(m); } else if (m && m.id !== undefined) w.postMessage({ type: 'discard', id: m.id });
  });
  w.on('error', () => { if (worker === w) { log({ outcome: 'error', code: 'skill_resolver_worker_crash' }); dropWorker(); backoff(); } });
  w.on('exit', () => { if (worker === w) { worker = null; workerSha = null; } });
  worker = w;
  workerSha = s.library_sha256;
  w.postMessage({ type: 'warm' });
  return w;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('\n').trim();
  return '';
}

function turnText(event) {
  if (event && typeof event.currentUserMessage === 'string') return event.currentUserMessage.trim();
  const msgs = event && Array.isArray(event.messages) ? event.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') return textOf(msgs[i].content).trim();
  return '';
}

function sessionOf(event, ctx, agentId) {
  const k = (ctx && (ctx.sessionKey || ctx.sessionId)) || (event && (event.sessionKey || event.sessionId));
  return typeof k === 'string' && k ? k.slice(0, 256) : 'agent:' + agentId;
}

function senderOf(event, ctx) {
  const v = (ctx && (ctx.senderId || (ctx.sender && ctx.sender.id))) || (event && (event.senderId || (event.sender && event.sender.id)));
  return v === undefined || v === null ? null : String(v);
}

function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

function bucket(sessionKey) {
  return parseInt(createHash('sha256').update(sessionKey).digest('hex').slice(0, 8), 16) / 0x100000000;
}

function armFor(a, sessionKey) {
  if (a.mode === 'shadow') return 'shadow';
  const f = typeof a.live_fraction === 'number' ? a.live_fraction : 1;
  return bucket(sessionKey) < f ? 'live' : 'control';
}

function ask(w, msg) {
  const id = ++seq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { waiters.delete(id); resolve({ id, late: true }); }, DEADLINE_MS);
    waiters.set(id, (m) => { clearTimeout(t); resolve(m ? { ...m, id } : { id, late: true }); });
    w.postMessage({ ...msg, id });
  });
}

function checkSkew(s) {
  const now = Date.now();
  if (refreshing || now < skewOpenUntil || now - skewCheckedAt < 3_600_000) return;
  skewCheckedAt = now;
  const env = { ...process.env, ...(GBRAIN_HOME_ENV ? { GBRAIN_HOME: GBRAIN_HOME_ENV } : {}) };
  delete env.GBRAIN_SKILL_LOADING;
  execFile(GBRAIN_BIN, ['--version'], { timeout: 10_000, env }, (err, stdout) => {
    const v = !err && /\d+\.\d+\.\d+(?:\.\d+)?/.exec(String(stdout));
    if (!v || v[0] === s.gbrain_version) return;
    refreshing = true;
    execFile(GBRAIN_BIN, ['setup', 'openclaw', '--skills-index-only'], { timeout: 300_000, env }, () => {
      refreshing = false;
      const after = readState();
      if (!after || after.gbrain_version !== v[0]) { skewOpenUntil = Date.now() + 86_400_000; log({ outcome: 'error', code: 'skill_resolver_library_skew', cli: v[0], library: after ? after.gbrain_version : null }); }
    });
  });
}

async function resolveTurn(event, ctx, opts) {
  const s = readState();
  if (!s) return undefined;
  const agentId = String((ctx && ctx.agentId) || (event && event.agentId) || 'main');
  const a = s.agents[agentId];
  if (!a || a.mode === 'off' || (a.mode !== 'live' && a.mode !== 'shadow')) return undefined;
  checkSkew(s);
  const t0 = Date.now();
  const sessionKey = sessionOf(event, ctx, agentId);
  const arm = armFor(a, sessionKey);
  const result = {};
  const pinsOn = a.mode === 'live' && typeof a.pinned_block === 'string' && a.pinned_block !== '';
  if (pinsOn && a.pins_route !== 'first_turn') result.appendSystemContext = a.pinned_block;
  const firstTurn = !seenSessions.has(sessionKey) || resetNext.has(sessionKey);
  remember(seenSessions, sessionKey, 1, SESSIONS_MAX);
  const pinsFirst = pinsOn && a.pins_route === 'first_turn' && firstTurn ? a.pinned_block : '';
  const finish = (line, block) => {
    const ctxText = [pinsFirst, block || ''].filter(Boolean).join('\n\n');
    if (ctxText) result.appendContext = ctxText;
    log({ agent: agentId, arm, ms: Date.now() - t0, pins: pinsOn ? (a.pinned_ids || []).length : 0, ...line });
    return Object.keys(result).length ? result : undefined;
  };
  const text = turnText(event);
  if (!text) return finish({ outcome: 'skipped_empty' });
  const prov = (ctx && ctx.inputProvenance && ctx.inputProvenance.kind) || (event && event.inputProvenance && event.inputProvenance.kind);
  if (prov && prov !== 'external_user') return finish({ outcome: 'skipped_provenance', provenance: String(prov).slice(0, 40) });
  const trigger = (ctx && ctx.trigger) || (event && event.trigger);
  if (trigger === 'heartbeat' || trigger === 'cron') return finish({ outcome: 'skipped_provenance', provenance: trigger });
  if (Array.isArray(a.owner_sender_ids) && a.owner_sender_ids.length) {
    const sender = senderOf(event, ctx);
    if (sender === null || !a.owner_sender_ids.includes(sender)) return finish({ outcome: 'skipped_sender' });
  }
  const turnId = (event && (event.currentUserMessageId || event.messageId)) || createHash('sha256').update(text).digest('hex').slice(0, 16);
  const memoKey = agentId + '\0' + sessionKey + '\0' + turnId;
  if (memo.has(memoKey)) return finish({ outcome: 'retry' }, arm === 'live' ? memo.get(memoKey) : '');
  const w = ensureWorker(s);
  if (!w) return finish({ outcome: 'error', code: 'skill_resolver_worker_unavailable' });
  const reset = resetNext.delete(sessionKey);
  const input = { message: text, session_id: sessionKey, harness: 'openclaw', top_k: Number.isInteger(a.top_k) ? a.top_k : 3, exclude: [...(Array.isArray(a.pinned_ids) ? a.pinned_ids : []), ...(Array.isArray(a.exclude_ids) ? a.exclude_ids : [])].slice(0, 1024), shadow: arm !== 'live', ...(reset ? { reset_session: true } : {}) };
  const reply = await ask(w, { type: 'resolve', input, catalog: a.catalog, deadlineMs: DEADLINE_MS - 5, floor: a.min_match || null, dirs: a.skill_dirs || [] });
  if (reply.late) {
    if (reset) resetNext.add(sessionKey);
    timeouts += 1;
    if (timeouts >= STUCK_AFTER) { log({ outcome: 'error', code: 'skill_resolver_worker_stuck' }); timeouts = 0; dropWorker(); backoff(); }
    return finish({ outcome: 'timeout', code: 'skill_resolve_timeout' });
  }
  timeouts = 0;
  backoffMs = 1000;
  if (reply.code && !reply.block) return finish({ outcome: 'error', code: reply.code });
  const names = Array.isArray(reply.names) ? reply.names : [];
  remember(recent, agentId + '\0' + sessionKey, { names: new Set(names), arm }, SESSIONS_MAX);
  const outcome = names.length ? 'suggested' : reply.no_skill_reason || (reply.budget_exhausted ? 'budget' : reply.deduped ? 'deduped' : 'no_match');
  const deliver = arm === 'live' && reply.block ? reply.block : '';
  let active = true;
  try { if (ctx && typeof ctx.assertActive === 'function') ctx.assertActive(); } catch { active = false; }
  if (active && !opts.selfTest) w.postMessage({ type: 'commit', id: reply.id }); else w.postMessage({ type: 'discard', id: reply.id });
  if (deliver) remember(memo, memoKey, deliver, MEMO_MAX);
  return finish({ outcome: arm === 'live' || !names.length ? outcome : 'would_suggest', suggested: names, strengths: reply.strengths, code: reply.code || null }, deliver);
}

function onToolCall(event, ctx) {
  try {
    const name = String((event && (event.toolName || event.name || (event.tool && event.tool.name))) || '');
    if (name !== 'skills_read' && name !== 'skill_view') return;
    const params = (event && (event.params || event.input || event.args || event.arguments)) || {};
    const skill = typeof params.name === 'string' ? params.name.slice(0, 256) : null;
    if (!skill) return;
    const s = state;
    const agentId = String((ctx && ctx.agentId) || (event && event.agentId) || 'main');
    const a = s && s.agents[agentId];
    if (!a || a.mode === 'off') return;
    const sessionKey = sessionOf(event, ctx, agentId);
    const r = recent.get(agentId + '\0' + sessionKey);
    log({ agent: agentId, outcome: 'read', skill, suggested: !!(r && r.names.has(skill)), pinned: Array.isArray(a.pinned_ids) && a.pinned_ids.includes(skill), arm: r ? r.arm : armFor(a, sessionKey) });
  } catch { /* observing never fails a turn */ }
}

function onCompaction(event, ctx) {
  try {
    const s = state;
    const agentId = String((ctx && ctx.agentId) || (event && event.agentId) || 'main');
    resetNext.add(sessionOf(event, ctx, agentId));
    if (s && s.agents[agentId]) log({ agent: agentId, outcome: 'compaction' });
  } catch { /* best effort */ }
}

function onSkillChanged() {
  try {
    const s = readState();
    if (!s) return;
    const w = ensureWorker(s);
    if (!w) return;
    for (const a of Object.values(s.agents)) if (a && a.mode !== 'off' && a.catalog) w.postMessage({ type: 'rebuild', catalog: a.catalog, dirs: a.skill_dirs || [] });
  } catch { /* best effort */ }
}

export default {
  id: ID,
  name: 'GBrain skill resolver',
  description: 'Suggests the installed skills that fit each user message, plus the operator\'s pinned skills (managed by gbrain setup openclaw).',
  version: PLUGIN_VERSION,
  register(api) {
    pruneLogs();
    const daily = setInterval(pruneLogs, 86_400_000);
    if (daily.unref) daily.unref();
    const on = (event, fn) => { try { api.on(event, fn); } catch { /* an older host without this event */ } };
    on('before_prompt_build', async (event, ctx) => { try { return await resolveTurn(event, ctx, {}); } catch { return undefined; } });
    on('after_tool_call', onToolCall);
    on('after_compaction', onCompaction);
    on('skill_changed', onSkillChanged);
    const s = readState();
    if (s) ensureWorker(s);
  },
  async selfTest(agentId, message) {
    const s = readState();
    if (!s || !s.agents[agentId]) return { ok: false, code: 'skill_resolver_state_missing' };
    const w = ensureWorker(s);
    if (!w) return { ok: false, code: 'skill_resolver_worker_unavailable' };
    const warm = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ code: 'skill_resolve_timeout' }), 10_000);
      const onMsg = (m) => { if (m && m.type === 'warm') { clearTimeout(t); w.off('message', onMsg); resolve(m); } };
      w.on('message', onMsg);
      w.postMessage({ type: 'warm' });
    });
    if (warm.code) { dropWorker(); return { ok: false, code: warm.code }; }
    const a = s.agents[agentId];
    const t0 = Date.now();
    const reply = await ask(w, { type: 'resolve', input: { message, harness: 'openclaw', top_k: Number.isInteger(a.top_k) ? a.top_k : 3, shadow: true }, catalog: a.catalog, deadlineMs: DEADLINE_MS - 5, floor: a.min_match || null, dirs: [] });
    dropWorker();
    if (reply.late) return { ok: false, code: 'skill_resolve_timeout', ms: Date.now() - t0 };
    if (reply.code && !reply.block) return { ok: false, code: reply.code, ms: Date.now() - t0 };
    return { ok: true, ms: Date.now() - t0, version: warm.version, suggested: reply.names || [] };
  },
};
`;

export function openclawSkillWorkerJs(): string {
  return WORKER_JS;
}

export function openclawSkillLoaderJs(c: LoaderConstants): string {
  const values: Record<string, string> = {
    __HOME__: JSON.stringify(c.home), __LIB_DIR__: JSON.stringify(c.libDir), __STATE__: JSON.stringify(c.statePath), __LOG_DIR__: JSON.stringify(c.logDir),
    __BIN__: JSON.stringify(c.gbrainBin), __GBRAIN_HOME_ENV__: JSON.stringify(c.gbrainHomeEnv), __PLUGIN_VERSION__: JSON.stringify(String(OPENCLAW_SKILL_PLUGIN_CODE_VERSION)),
  };
  return LOADER_JS.replace(/__(HOME|LIB_DIR|STATE|LOG_DIR|BIN|GBRAIN_HOME_ENV|PLUGIN_VERSION)__/g, (m) => values[m]!);
}
