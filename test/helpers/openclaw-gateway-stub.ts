/**
 * A stub `openclaw` executable for the Gateway reader suites: it waits a configurable start-up delay (standing in for
 * the CLI's own process start), answers `gateway call sessions.list | chat.history` from a synthetic session store the
 * way OpenClaw 2026.11.3 pages them (chat.history: limit up to 1000, default 200; a byte budget of maxBytes, default
 * 512 KiB, hard ceiling 6 MiB; pages walk backward from the newest, each page oldest first), and appends one line per
 * invocation (method, params, start and end time) to a log. Every value is synthetic.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StubSession { key: string; sessionId: string; messages: number; updatedAt: number; chatType?: string }
export interface StubCall { method: string; params: Record<string, unknown>; start: number; end: number; pid: number }

export interface GatewayStubOpts {
  dir: string;
  sessions: StubSession[];
  /** Milliseconds the stub waits before it answers, per invocation. */
  delayMs: number;
  /** Extra Gateway time per chat.history page, drawn uniformly from [min, max] ms. */
  answerMs?: [number, number];
  /** Bytes each message counts against the page budget. */
  messageBytes?: number;
  /** A Gateway from before 2026.10, whose closed chat.history schema refuses maxBytes. */
  rejectMaxBytes?: boolean;
  /** chat.history on this session key answers with an auth error envelope. */
  failKey?: string;
  /** Name of the executable file (default openclaw). */
  name?: string;
}

export function gatewayStub(opts: GatewayStubOpts): { bin: string; calls: () => StubCall[] } {
  const store = join(opts.dir, (opts.name ?? 'openclaw') + '-store.json');
  const log = join(opts.dir, (opts.name ?? 'openclaw') + '-calls.jsonl');
  writeFileSync(store, JSON.stringify({ ...opts, dir: undefined }));
  writeFileSync(log, '');
  const bin = join(opts.dir, opts.name ?? 'openclaw');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const start = Date.now();
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, 'utf8'));
const argv = process.argv.slice(2);
const method = argv[2];
const params = JSON.parse(argv[argv.indexOf('--params') + 1] || '{}');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const done = (doc, code) => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, params, start, end: Date.now(), pid: process.pid }) + '\\n');
  process.stdout.write(JSON.stringify(doc) + '\\n', () => process.exit(code));
};
(async () => {
  await sleep(cfg.delayMs);
  if (method === 'sessions.list') {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const rows = cfg.sessions.slice(offset, offset + limit).map(s => ({ key: s.key, sessionId: s.sessionId, chatType: s.chatType ?? 'direct', updatedAt: s.updatedAt }));
    const next = offset + rows.length;
    return done({ sessions: rows, hasMore: next < cfg.sessions.length, ...(next < cfg.sessions.length ? { nextOffset: next } : {}) }, 0);
  }
  if (method !== 'chat.history') return done({ ok: false, error: { type: 'gateway_request_error', code: 'INVALID_REQUEST', message: 'unknown method ' + method } }, 1);
  if (cfg.rejectMaxBytes && params.maxBytes !== undefined) {
    return done({ ok: false, error: { type: 'gateway_request_error', code: 'INVALID_REQUEST', message: "invalid chat.history params: at root: unexpected property 'maxBytes'" } }, 1);
  }
  if (cfg.failKey && params.sessionKey === cfg.failKey) {
    return done({ ok: false, error: { type: 'gateway_request_error', code: 'UNAUTHORIZED', message: 'unauthorized', details: { code: 'AUTH_TOKEN_MISMATCH' } } }, 1);
  }
  const [lo, hi] = cfg.answerMs ?? [0, 0];
  if (hi > 0) await sleep(lo + Math.random() * (hi - lo));
  const s = cfg.sessions.find(x => x.key === params.sessionKey);
  const total = s ? s.messages : 0;
  const budget = Math.min(params.maxBytes ?? 512 * 1024, 6 * 1024 * 1024);
  const size = Math.max(1, Math.min(params.limit ?? 200, 1000, Math.floor(budget / (cfg.messageBytes ?? 2150))));
  const offset = params.offset ?? 0;
  const endIdx = Math.max(0, total - offset);
  const startIdx = Math.max(0, endIdx - size);
  const messages = [];
  for (let i = startIdx; i < endIdx; i++) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'synthetic message ' + i + ' in ' + s.key, timestamp: s.updatedAt - (total - i) * 1000, __openclaw: { id: s.sessionId + ':' + i, seq: i + 1 } });
  }
  const next = offset + messages.length;
  done({ sessionKey: params.sessionKey, sessionId: s ? s.sessionId : undefined, messages, hasMore: startIdx > 0, ...(startIdx > 0 ? { nextOffset: next } : {}) }, 0);
})();
`);
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as StubCall),
  };
}

/** The most stub invocations of one method that ran at the same time. */
export function maxOverlap(calls: StubCall[], method: string): number {
  const edges = calls.filter(c => c.method === method).flatMap(c => [[c.start, 1], [c.end, -1]] as Array<[number, number]>)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let max = 0;
  for (const [, d] of edges) { now += d; max = Math.max(max, now); }
  return max;
}

/** The large-install shape the reader is tuned for: 350 sessions, 40 active recently, 158 history pages at 200 a page. */
export function largeInstall(nowMs: number): StubSession[] {
  const sessions: StubSession[] = [];
  for (let i = 0; i < 350; i++) {
    const recent = i % 8 === 0 && sessions.filter(s => s.updatedAt >= nowMs - 86_400_000).length < 40;
    const n = sessions.filter(s => s.updatedAt >= nowMs - 86_400_000).length;
    sessions.push({
      key: 'agent:main:example-session-' + i,
      sessionId: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
      messages: recent ? (n < 2 ? 4300 : 500) : 20,
      updatedAt: recent ? nowMs - 60_000 * (i + 1) : nowMs - 30 * 86_400_000,
    });
  }
  return sessions;
}
