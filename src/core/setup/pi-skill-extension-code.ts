/**
 * pi-skill-extension-code.ts — the files of the generated Pi extension
 * `gbrain-skill-resolver` (written by pi-skill-extension.ts into
 * $PI_CODING_AGENT_DIR/extensions/gbrain-skill-resolver): index.js, the
 * extension Pi loads into its own Node process, and worker.js, the same
 * resolver worker thread the OpenClaw plugin runs (it rebuilds with harness
 * pi and acknowledges each commit, so a one-shot `pi -p` can wait for it
 * before it exits). Only paths and the gbrain bin are baked in, never pins
 * or a library path.
 */
import { openclawSkillWorkerJs } from './openclaw-skill-plugin-code.ts';

export const PI_SKILL_EXTENSION_CODE_VERSION = 1;

export interface PiLoaderConstants { home: string; libDir: string; statePath: string; logDir: string; workerPath: string; gbrainBin: string; gbrainHomeEnv: string | null }

const LOADER_JS = String.raw`// Managed by gbrain setup pi; a re-run rewrites this file. Remove: gbrain setup pi --skill-loading off
// gbrain-skill-resolver for Pi: before each user run, up to a few installed skills that fit the prompt go to the
// model as one hidden message, and the operator's pinned skills as a system prompt section. Settings come from a
// data-only state file gbrain writes, re-read when it changes. Every failure lets the run go ahead unchanged, and
// no handler waits longer than the deadline (longer on a run whose worker is still starting).
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const HOME = __HOME__;
const LIB_DIR = __LIB_DIR__;
const STATE_PATH = __STATE__;
const LOG_DIR = __LOG_DIR__;
const WORKER_PATH = __WORKER__;
const GBRAIN_BIN = __BIN__;
const GBRAIN_HOME_ENV = __GBRAIN_HOME_ENV__;
const FLAG = 'gbrain-skill-resolver';
const SECTION = 'gbrain_pinned_skills';
const MESSAGE_TYPE = 'gbrain-skill-suggestions';
const TEST_DEADLINE_MS = Number(process.env.GBRAIN_TEST_PI_SKILL_DEADLINE_MS) || 0;
const DEADLINE_MS = TEST_DEADLINE_MS || 50;
const COLD_DEADLINE_MS = TEST_DEADLINE_MS || 150;
const STUCK_AFTER = 3;

let state = null;
let stateMtime = -1;
let worker = null;
let workerSha = null;
let warm = false;
let timeouts = 0;
let seq = 0;
let skewChecked = false;
let logReady = false;
const waiters = new Map();
const commits = new Map();
const resetNext = new Set();

function readState() {
  let mtime;
  try { mtime = statSync(STATE_PATH).mtimeMs; } catch { state = null; stateMtime = -1; return null; }
  if (mtime !== stateMtime) {
    stateMtime = mtime;
    try {
      const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      if (s && s.v === 1 && typeof s.catalog === 'string') state = s;
    } catch { /* a damaged file keeps the last good state */ }
  }
  return state;
}

let logTail = Promise.resolve();

function log(line) {
  try {
    const at = new Date();
    if (!logReady) { mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 }); logReady = true; }
    const text = JSON.stringify({ at: at.toISOString(), ...line }) + '\n';
    logTail = logTail.then(() => appendFile(join(LOG_DIR, 'pi-' + at.toISOString().slice(0, 10) + '.jsonl'), text, { mode: 0o600 })).catch(() => {});
  } catch { /* logging never fails a run */ }
}

function dropWorker() {
  const w = worker;
  worker = null;
  workerSha = null;
  warm = false;
  for (const [, done] of waiters) done(null);
  waiters.clear();
  for (const [, c] of commits) c.done();
  commits.clear();
  if (w) w.terminate().catch(() => {});
}

function ensureWorker(s) {
  if (worker && workerSha === s.library_sha256) return worker;
  if (worker) dropWorker();
  let w;
  try {
    w = new Worker(WORKER_PATH, { execArgv: [], env: {}, workerData: { home: HOME, libDir: LIB_DIR, sha: s.library_sha256 } });
  } catch {
    log({ outcome: 'error', code: 'skill_resolver_worker_crash' });
    return null;
  }
  w.on('message', (m) => {
    if (m && m.type === 'warm') { warm = !m.code; if (m.code) log({ outcome: 'error', code: m.code }); return; }
    if (m && m.type === 'rebuilt') { log({ outcome: 'rebuilt', catalog: m.catalog, code: m.code || null }); return; }
    if (m && m.type === 'committed') { const c = commits.get(m.id); if (c) { commits.delete(m.id); c.done(); } return; }
    const done = m && waiters.get(m.id);
    if (done) { waiters.delete(m.id); done(m); } else if (m && m.id !== undefined) w.postMessage({ type: 'discard', id: m.id });
  });
  w.on('error', () => { if (worker === w) { log({ outcome: 'error', code: 'skill_resolver_worker_crash' }); dropWorker(); } });
  w.on('exit', () => { if (worker === w) { worker = null; workerSha = null; warm = false; } });
  w.unref();
  worker = w;
  workerSha = s.library_sha256;
  w.postMessage({ type: 'warm' });
  return w;
}

function ask(w, msg, ms) {
  const id = ++seq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { waiters.delete(id); resolve({ id, late: true }); }, ms);
    waiters.set(id, (m) => { clearTimeout(t); resolve(m ? { ...m, id } : { id, late: true }); });
    w.postMessage({ ...msg, id });
  });
}

function commit(w, id) {
  let done = () => {};
  const settled = new Promise((resolve) => { done = resolve; });
  commits.set(id, { done, settled });
  w.postMessage({ type: 'commit', id });
}

/** Wait, at most ms, for the session commits still in flight, so a one-shot run keeps its dedupe. */
function flush(ms) {
  if (commits.size === 0) return Promise.resolve();
  return Promise.race([Promise.all([...commits.values()].map((c) => c.settled)), new Promise((resolve) => setTimeout(resolve, ms))]);
}

function sessionOf(ctx) {
  try { const id = ctx && ctx.sessionManager && ctx.sessionManager.getSessionId(); if (typeof id === 'string' && id) return 'pi:' + id.slice(0, 200); } catch { /* no session manager */ }
  return 'pi:default';
}

/** Catalog skills Pi does not show the model this run: absent from its loaded skills, or loaded with model invocation off. None when Pi names none of them. */
function hiddenFrom(event, s) {
  const loaded = event && event.systemPromptOptions && Array.isArray(event.systemPromptOptions.skills) ? event.systemPromptOptions.skills.filter((k) => k && typeof k.name === 'string') : null;
  const ids = Array.isArray(s.catalog_ids) ? s.catalog_ids : [];
  if (!loaded || !ids.length) return [];
  const names = new Set(loaded.map((k) => k.name));
  if (!ids.some((n) => names.has(n))) return [];
  const visible = new Set(loaded.filter((k) => k.disableModelInvocation !== true).map((k) => k.name));
  return ids.filter((n) => !visible.has(n));
}

function checkSkew(s) {
  if (skewChecked) return;
  skewChecked = true;
  const env = { ...process.env, ...(GBRAIN_HOME_ENV ? { GBRAIN_HOME: GBRAIN_HOME_ENV } : {}) };
  delete env.GBRAIN_SKILL_LOADING;
  const probe = execFile(GBRAIN_BIN, ['--version'], { timeout: 10_000, env }, (err, stdout) => {
    const v = !err && /\d+\.\d+\.\d+(?:\.\d+)?/.exec(String(stdout));
    if (!v || v[0] === s.gbrain_version) return;
    const child = execFile(GBRAIN_BIN, ['setup', 'pi', '--skills-index-only'], { timeout: 300_000, env }, () => {
      const after = readState();
      if (!after || after.gbrain_version !== v[0]) log({ outcome: 'error', code: 'skill_resolver_library_skew', cli: v[0], library: after ? after.gbrain_version : null });
    });
    if (child.unref) child.unref();
  });
  unrefChild(probe);
}

/** A one-shot pi -p exits without waiting for a version check it no longer needs. */
function unrefChild(c) {
  try { c.unref(); for (const st of [c.stdin, c.stdout, c.stderr]) if (st && st.unref) st.unref(); } catch { /* best effort */ }
}

async function beforeAgentStart(event, ctx) {
  const s = readState();
  if (!s || s.mode !== 'live') return undefined;
  const t0 = Date.now();
  const pins = typeof s.pinned_block === 'string' && s.pinned_block !== '';
  const sections = event && event.systemPromptOptions && event.systemPromptOptions.sections;
  if (pins && sections && typeof sections === 'object') sections[SECTION] = s.pinned_block;
  const finish = (line, block) => {
    log({ ms: Date.now() - t0, pins: pins ? (s.pinned_ids || []).length : 0, ...line });
    return block ? { message: { customType: MESSAGE_TYPE, content: block, display: false } } : undefined;
  };
  if (event && event.messageType === 'custom') return finish({ outcome: 'skipped_custom' });
  const text = event && typeof event.prompt === 'string' ? event.prompt.trim() : '';
  if (!text) return finish({ outcome: 'skipped_empty' });
  const w = ensureWorker(s);
  if (!w) return finish({ outcome: 'error', code: 'skill_resolver_worker_unavailable' });
  const key = sessionOf(ctx);
  const reset = resetNext.delete(key);
  const hidden = hiddenFrom(event, s);
  const exclude = [...(Array.isArray(s.pinned_ids) ? s.pinned_ids : []), ...(Array.isArray(s.exclude_ids) ? s.exclude_ids : []), ...hidden].slice(0, 1024);
  const deadline = warm ? DEADLINE_MS : COLD_DEADLINE_MS;
  const input = { message: text, session_id: key, harness: 'pi', top_k: Number.isInteger(s.top_k) ? s.top_k : 3, exclude, ...(reset ? { reset_session: true } : {}) };
  const reply = await ask(w, { type: 'resolve', input, catalog: s.catalog, deadlineMs: deadline - 5, floor: s.min_match || null, dirs: s.skill_dirs || [] }, deadline);
  if (reply.late) {
    if (reset) resetNext.add(key);
    timeouts += 1;
    if (timeouts >= STUCK_AFTER) { log({ outcome: 'error', code: 'skill_resolver_worker_stuck' }); timeouts = 0; dropWorker(); }
    return finish({ outcome: 'timeout', code: 'skill_resolve_timeout', cold: deadline === COLD_DEADLINE_MS });
  }
  timeouts = 0;
  if (reply.code && !reply.block) return finish({ outcome: 'error', code: reply.code });
  const names = Array.isArray(reply.names) ? reply.names : [];
  commit(w, reply.id);
  const outcome = names.length ? 'suggested' : reply.no_skill_reason || (reply.budget_exhausted ? 'budget' : reply.deduped ? 'deduped' : 'no_match');
  return finish({ outcome, suggested: names, strengths: reply.strengths, hidden: hidden.length, code: reply.code || null }, names.length ? reply.block : '');
}

export default function gbrainSkillResolver(pi) {
  pi.registerFlag(FLAG, { description: 'gbrain skill resolver is loaded (managed by gbrain setup pi; this flag changes nothing)', type: 'boolean', default: false });
  try { const s = readState(); if (s && s.mode === 'live') ensureWorker(s); } catch { /* the first run starts it */ }
  pi.on('session_start', () => { try { const s = readState(); if (s && s.mode === 'live') { ensureWorker(s); checkSkew(s); } } catch { /* best effort */ } });
  pi.on('before_agent_start', async (event, ctx) => { try { return await beforeAgentStart(event, ctx); } catch { return undefined; } });
  pi.on('session_compact', (event, ctx) => { try { resetNext.add(sessionOf(ctx)); if (state) log({ outcome: 'compaction', reason: event && event.reason ? String(event.reason).slice(0, 20) : null }); } catch { /* best effort */ } });
  pi.on('session_shutdown', async () => { try { await flush(500); await logTail; } catch { /* best effort */ } dropWorker(); });
}

/** One shadow turn through the worker (gbrain setup pi's self-test, under Node); commits nothing. */
export async function selfTest(message) {
  const s = readState();
  if (!s) return { ok: false, code: 'skill_resolver_state_missing' };
  const w = ensureWorker(s);
  if (!w) return { ok: false, code: 'skill_resolver_worker_unavailable' };
  const warmed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: 'skill_resolve_timeout' }), 10_000);
    const onMsg = (m) => { if (m && m.type === 'warm') { clearTimeout(t); w.off('message', onMsg); resolve(m); } };
    w.on('message', onMsg);
    w.postMessage({ type: 'warm' });
  });
  if (warmed.code) { dropWorker(); return { ok: false, code: warmed.code }; }
  const t0 = Date.now();
  const reply = await ask(w, { type: 'resolve', input: { message, harness: 'pi', top_k: Number.isInteger(s.top_k) ? s.top_k : 3, shadow: true }, catalog: s.catalog, deadlineMs: 1000, floor: s.min_match || null, dirs: [] }, 2000);
  dropWorker();
  if (reply.late) return { ok: false, code: 'skill_resolve_timeout', ms: Date.now() - t0 };
  if (reply.code && !reply.block) return { ok: false, code: reply.code, ms: Date.now() - t0 };
  return { ok: true, ms: Date.now() - t0, version: warmed.version, suggested: reply.names || [] };
}
`;

const OPENCLAW_REBUILD = "harness: 'openclaw' }, { home })";
const OPENCLAW_COMMIT = "if (p && loaded.lib) loaded.lib.commitSessionAsync(home, p.key, p.delta).catch(() => {});\n    return;";

/** The OpenClaw worker with two changes: rebuilds use harness pi, and every commit is acknowledged once it settles. */
export function piSkillWorkerJs(): string {
  const base = openclawSkillWorkerJs();
  if (!base.includes(OPENCLAW_REBUILD) || !base.includes(OPENCLAW_COMMIT)) throw new Error('the OpenClaw resolver worker changed shape; update piSkillWorkerJs');
  return base
    .replace('// Managed by gbrain setup openclaw (gbrain-skill-resolver worker thread)', '// Managed by gbrain setup pi (gbrain-skill-resolver worker thread)')
    .replace(OPENCLAW_REBUILD, "harness: 'pi' }, { home })")
    .replace(OPENCLAW_COMMIT, "const ack = () => parentPort.postMessage({ type: 'committed', id: m.id });\n    if (p && loaded.lib) loaded.lib.commitSessionAsync(home, p.key, p.delta).then(ack, ack); else ack();\n    return;");
}

export function piSkillLoaderJs(c: PiLoaderConstants): string {
  const values: Record<string, string> = {
    __HOME__: JSON.stringify(c.home), __LIB_DIR__: JSON.stringify(c.libDir), __STATE__: JSON.stringify(c.statePath), __LOG_DIR__: JSON.stringify(c.logDir),
    __WORKER__: JSON.stringify(c.workerPath), __BIN__: JSON.stringify(c.gbrainBin), __GBRAIN_HOME_ENV__: JSON.stringify(c.gbrainHomeEnv),
  };
  return LOADER_JS.replace(/__(HOME|LIB_DIR|STATE|LOG_DIR|WORKER|BIN|GBRAIN_HOME_ENV)__/g, (m) => values[m]!);
}
