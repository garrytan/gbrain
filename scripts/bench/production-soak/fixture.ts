#!/usr/bin/env bun
/**
 * Production-shaped scale soak, step 1: a deterministic "large personal brain"
 * fixture (GBRA-174). Opt-in bench code, never run in CI.
 *
 *   bun scripts/bench/production-soak/fixture.ts --out <dir> [--pages 600000] [--seed 7]
 *     [--years 5] [--backlog-days 14] [--huge-mb 6] [--oversized 2]
 *
 * Writes three git sources under <dir>/<source>/repo with git fast-import, the
 * database-side drift in <dir>/drift.jsonl and <dir>/manifest.json:
 *
 *   default   52% of the pages, years of daily history: bulk connector imports,
 *             edits, moves (inbox triage, renamed people), culls into
 *             archive/<year>/, plain deletes, and merge commits whose side branch
 *             carries moves and deletes (the shape a commit-push integration
 *             leaves, which hides those deletions from a plain
 *             git log --diff-filter=D). Private pages (visibility: private, and
 *             the access / confidentiality aliases) carry canary tokens, connector
 *             pages carry facts fences, meetings run long, timeline pages carry
 *             hundreds of dated entries, and a few chat-archive pages are
 *             megabytes, two of them over the 24 MB page limit. The last
 *             --backlog-days of history come after the import-base tag, with a
 *             few files gbrain must hold (unreadable frontmatter, a broken facts
 *             fence, a frontmatter slug naming another page) and paths that a
 *             commit recreates after an earlier delete.
 *   source-b  43%, mostly static (a few bulk imports and sparse edits); 10% of
 *             its pages share a slug with a default page (cross-source twins).
 *   source-c  5%, connector pages whose facts fences a daily commit rewrites.
 *
 * drift.jsonl lists the pages the loader writes into the database only
 * (load.ts): "db_only" pages no commit ever held, and "kept_deleted" pages whose
 * files history deleted (half of them inside merged side branches) while the
 * database kept them. These are the file-side/database-side disagreements
 * behind held-deletion backlogs.
 *
 * Same --seed and --pages give the same commits (same SHAs), files and drift.
 * Everything is generated words and placeholder names; nothing comes from a
 * real brain.
 */
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderFactsTable, type ParsedFact } from '../../../src/core/facts-fence.ts';
import { PAGE_MAX_BYTES } from '../../../src/core/page-size-policy.ts';
import { hash32, Rng } from '../hnsw-latent-corpus.ts';

export interface FixtureOptions { pages: number; seed: number; years: number; backlogDays: number; hugeMb: number; oversized: number }
export const DEFAULTS: FixtureOptions = { pages: 600_000, seed: 7, years: 5, backlogDays: 14, hugeMb: 6, oversized: 2 };
export const SOURCES = [
  { id: 'default', share: 0.52, history: 'daily' },
  { id: 'source-b', share: 0.43, history: 'static' },
  { id: 'source-c', share: 0.05, history: 'connector' },
] as const;
export type SourceId = typeof SOURCES[number]['id'];

export const KINDS = ['person', 'company', 'meeting', 'note', 'concept', 'transcript', 'original', 'connector', 'timeline', 'chat'] as const;
export type Kind = typeof KINDS[number];
const MIX: Record<SourceId, number[]> = {
  'default': [0.14, 0.07, 0.18, 0.22, 0.09, 0.10, 0.08, 0.07, 0.05, 0],
  'source-b': [0.15, 0.08, 0.20, 0.25, 0.10, 0.12, 0.10, 0, 0, 0],
  'source-c': [0.10, 0.05, 0, 0, 0, 0, 0, 0.85, 0, 0],
};
export const PRIVATE_CLASSES = ['', 'visibility', 'access', 'confidentiality'] as const;
export type PrivateClass = typeof PRIVATE_CLASSES[number];
const DELETE_SHARE = 0.08, MOVE_SHARE = 0.06, CULL_SHARE = 0.07, TWIN_SHARE = 0.10;
const T0 = Date.UTC(2021, 0, 4) / 1000;

const SYL = ['ka', 'lo', 'mi', 'ten', 'ar', 'vis', 'no', 're', 'shu', 'pa', 'der', 'qui', 'lan', 'mo', 'zet', 'ri', 'bo', 'ex', 'ul', 'fen', 'tor', 'gal', 'sen', 'dra'];
const FIRST = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory', 'niaj', 'olivia', 'peggy', 'rupert', 'sybil', 'trent', 'victor', 'walter', 'yolanda'];
const TOPICS = ['product', 'hiring', 'research', 'travel', 'health', 'finance', 'family', 'reading', 'ops', 'ideas'];
const PROVIDERS = ['crm', 'calendar', 'email', 'notes-app'];
/** A Zipf-ish vocabulary: drawing index floor(V * u^2) makes the first words common, the way real brains have hot terms. */
const VOCAB = (() => { const rng = new Rng(0x5eed); const out: string[] = []; const seen = new Set<string>();
  while (out.length < 6000) { let w = ''; const n = 2 + Math.floor(rng.next() * 3); for (let i = 0; i < n; i++) w += SYL[Math.floor(rng.next() * SYL.length)]; if (!seen.has(w)) { seen.add(w); out.push(w); } }
  return out; })();
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const b36 = (n: number, w = 7) => (n >>> 0).toString(36).padStart(w, '0');

export interface SourcePlan { id: SourceId; lives: number; days: number; kind: Uint8Array; birth: Uint16Array; edits: Uint8Array; move: Uint16Array; cull: Uint16Array; del: Uint16Array; priv: Uint8Array; twinOf: Int32Array }
const NEVER = 0xffff;

/** Deterministic lifecycle of every page that ever lived in a source. */
export function planSource(o: FixtureOptions, s: number): SourcePlan {
  const src = SOURCES[s]!;
  const days = Math.round(o.years * 365.25);
  const target = Math.max(20, Math.round(o.pages * src.share));
  const lives = src.history === 'daily' ? Math.round(target / (1 - DELETE_SHARE)) : target;
  const p: SourcePlan = { id: src.id, lives, days, kind: new Uint8Array(lives), birth: new Uint16Array(lives), edits: new Uint8Array(lives), move: new Uint16Array(lives).fill(NEVER),
    cull: new Uint16Array(lives).fill(NEVER), del: new Uint16Array(lives).fill(NEVER), priv: new Uint8Array(lives), twinOf: new Int32Array(lives).fill(-1) };
  const mix = MIX[src.id];
  const chats = src.history === 'daily' ? Math.max(o.oversized + 2, Math.round(o.pages / 30_000)) : 0;
  const bulkDays = [0.05, 0.2, 0.35, 0.5, 0.7, 0.85].map(f => Math.floor(days * f));
  const lastHistoryDay = days - o.backlogDays - 1;
  for (let i = 0; i < lives; i++) {
    const rng = new Rng(hash32(o.seed, s, i, 0x11fe));
    let r = rng.next(), k = 0;
    while (k < mix.length - 1 && r > mix[k]!) { r -= mix[k]!; k++; }
    if (i < chats) k = KINDS.indexOf('chat');
    p.kind[i] = k;
    if (src.history === 'static') p.birth[i] = bulkDays[Math.floor(rng.next() * 3)]!;
    else if (src.history === 'connector') p.birth[i] = Math.floor(days * rng.next() * 0.9);
    else if (i >= chats && rng.next() < 0.24) p.birth[i] = bulkDays[Math.floor(rng.next() * bulkDays.length)]!;
    else p.birth[i] = Math.min(days - 2, Math.floor(days * Math.sqrt(rng.next())));
    if (p.birth[i]! >= lastHistoryDay && i % 4 !== 0) p.birth[i] = Math.floor(lastHistoryDay * rng.next());
    const span = (from: number, to: number) => to - from > 1 ? from + 1 + Math.floor(rng.next() * (to - from - 1)) : NEVER;
    let end = days;
    if (src.history === 'daily' && i >= chats && rng.next() < DELETE_SHARE) { const d = span(p.birth[i]!, days); if (d !== NEVER) { p.del[i] = d; end = d; } }
    let e = 0; for (let u = rng.next(); u < 0.5 && e < 6; u *= 2) e++;
    if (src.history === 'static') e = rng.next() < 0.05 ? 1 : 0;
    if (src.history === 'connector') e = 2 + Math.floor(rng.next() * 6);
    p.edits[i] = e;
    if (src.history === 'daily' && i >= chats) {
      if (rng.next() < MOVE_SHARE) p.move[i] = span(p.birth[i]!, end);
      if (rng.next() < CULL_SHARE) p.cull[i] = span(p.move[i] === NEVER ? p.birth[i]! : p.move[i]!, end);
    }
    const u = rng.next();
    p.priv[i] = u < 0.03 ? 1 : u < 0.05 ? 2 : u < 0.055 ? 3 : 0;
    if (src.history === 'static' && rng.next() < TWIN_SHARE) p.twinOf[i] = hash32(o.seed, i, 0x7717) % Math.round(target * 0.9);
  }
  return p;
}

/** Page header shared by every version: kind, names, birth date, privacy class, the unique search token and (private pages) a canary. */
export function pageHead(o: FixtureOptions, p: SourcePlan, i: number) {
  const s = SOURCES.findIndex(x => x.id === p.id);
  const rng = new Rng(hash32(o.seed, s, i, 0xbead));
  const kind = KINDS[p.kind[i]!]!;
  const w = () => VOCAB[Math.floor(rng.next() * VOCAB.length)]!;
  const first = FIRST[Math.floor(rng.next() * FIRST.length)]!, surname = w(), w1 = w(), w2 = w();
  const date = new Date((T0 + p.birth[i]! * 86_400) * 1000).toISOString().slice(0, 10);
  const id = b36(hash32(o.seed, s, i, 0x1d));
  const priv = PRIVATE_CLASSES[p.priv[i]!]!;
  const title = kind === 'person' ? cap(first) + ' ' + cap(surname) + '-example'
    : kind === 'company' ? cap(w1) + cap(w2) + ' Example'
    : kind === 'meeting' ? 'Meeting with ' + cap(first) + ' ' + cap(surname) + ' on ' + w1
    : kind === 'transcript' ? 'Transcript ' + date + ' ' + w1 + ' ' + w2
    : kind === 'chat' ? 'Chat archive ' + date + ' ' + w1
    : kind === 'timeline' ? 'Timeline of ' + w1 + ' ' + w2
    : cap(w1) + ' ' + w2 + ' ' + surname;
  return { s, kind, first, surname, w1, w2, date, id, priv, title, token: 'zqpg' + id, canary: priv ? 'zqpv' + b36(hash32(o.seed, s, i, 0xca9a)) : '',
    topic: TOPICS[hash32(o.seed, s, i, 0x70) % TOPICS.length]!, provider: PROVIDERS[hash32(o.seed, s, i, 0x9) % PROVIDERS.length]! };
}

/** Path of page i at a lifecycle stage: 0 born, 1 moved, 2 culled into archive/<year of the cull>/. */
export function pagePath(o: FixtureOptions, p: SourcePlan, i: number, stage: 0 | 1 | 2, twinPlan?: SourcePlan): string {
  if (p.twinOf[i]! >= 0 && twinPlan) { const t = p.twinOf[i]! % twinPlan.lives; return pagePath(o, twinPlan, t, 0); }
  const h = pageHead(o, p, i);
  const y = h.date.slice(0, 4), m = h.date.slice(5, 7);
  const moved = stage >= 1 && p.move[i] !== NEVER;
  let path: string;
  switch (h.kind) {
    case 'person': path = 'people/' + h.first + (moved ? '-' + h.w2[0] : '') + '-' + h.surname + '-' + h.id + '.md'; break;
    case 'company': path = 'companies/' + (moved ? h.topic + '/' : '') + h.w1 + h.w2 + '-' + h.id + '.md'; break;
    case 'meeting': path = 'meetings/' + y + '/' + m + '/' + h.date + '-' + h.w1 + '-' + h.id + '.md'; break;
    case 'note': path = 'notes/' + (moved || p.move[i] === NEVER ? h.topic : 'inbox') + '/' + h.w1 + '-' + h.w2 + '-' + h.id + '.md'; break;
    case 'concept': path = 'concepts/' + (moved ? h.topic + '/' : '') + h.w1 + '-' + h.w2 + '-' + h.id + '.md'; break;
    case 'transcript': path = 'transcripts/' + y + '/' + h.date + '-' + h.w1 + '-' + h.id + '.md'; break;
    case 'original': path = 'originals/' + (moved ? y + '/' : '') + h.w1 + '-' + h.id + '.md'; break;
    case 'connector': path = 'connectors/' + h.provider + '/' + h.w1 + '-' + h.id + '.md'; break;
    case 'timeline': path = 'timelines/' + h.w1 + '-' + h.w2 + '-' + h.id + '.md'; break;
    case 'chat': path = 'archive/chats/' + y + '/' + h.w1 + '-' + h.id + '.md'; break;
  }
  if (stage === 2 && p.cull[i] !== NEVER) path = 'archive/' + new Date((T0 + p.cull[i]! * 86_400) * 1000).getUTCFullYear() + '/' + path;
  return path;
}

function prose(rng: Rng, bytes: number, extra: string[] = []): string {
  const out: string[] = [];
  let n = 0, sentence = 0;
  while (n < bytes) {
    const len = 8 + Math.floor(rng.next() * 10);
    const words: string[] = [];
    for (let k = 0; k < len; k++) { const u = rng.next(); words.push(VOCAB[Math.floor(VOCAB.length * u * u)]!); }
    if (extra.length && sentence % 7 === 3) words.splice(2, 0, extra[sentence % extra.length]!);
    const line = cap(words.join(' ')) + '.';
    out.push(line); n += line.length + 1; sentence++;
    if (sentence % 5 === 0) { out.push(''); n++; }
  }
  return out.join(sentence % 5 === 0 ? '\n' : ' ').replace(/\. \n/g, '.\n');
}

/** Approximate body size per kind; meetings occasionally run long, chats are megabytes. */
function bodyBytes(o: FixtureOptions, h: ReturnType<typeof pageHead>, rng: Rng, i: number): number {
  const r = rng.next();
  switch (h.kind) {
    case 'person': return 1200 + r * 2500;
    case 'company': return 800 + r * 2000;
    case 'meeting': return rng.next() < 0.05 ? 40_000 + r * 40_000 : 2500 + r * 6000;
    case 'transcript': return 6000 + r * 14_000;
    case 'original': return 1500 + r * 5000;
    case 'timeline': return 600;
    case 'chat': return i < o.oversized ? PAGE_MAX_BYTES + 2 * 1024 ** 2 : (0.5 + r) * o.hugeMb * 1024 ** 2;
    default: return 700 + r * 2500;
  }
}

/** Markdown of page i at edit version v. Private pages repeat their canary in the body and, where fenced, in fact claims. */
export function pageContent(o: FixtureOptions, p: SourcePlan, i: number, v: number): string {
  const h = pageHead(o, p, i);
  const rng = new Rng(hash32(o.seed, h.s, i, v, 0xc0de));
  const fm: string[] = ['---', 'title: ' + JSON.stringify(h.title), 'type: ' + h.kind, 'date: ' + h.date, 'tags: [' + h.topic + ']'];
  if (h.priv === 'visibility') fm.push('visibility: private');
  if (h.priv === 'access') fm.push('access: ' + ['private', 'restricted', 'confidential'][i % 3]);
  if (h.priv === 'confidentiality') fm.push('confidentiality: secret');
  if (h.kind === 'connector') fm.push('source: ' + h.provider + '-connector');
  if (h.kind === 'person' && i % 9 === 0) fm.push('aliases: [' + JSON.stringify(cap(h.first[0]!) + '. ' + cap(h.surname)) + ']');
  fm.push('---', '');
  const tokens = [h.token, ...(h.canary ? [h.canary] : [])];
  const parts = [fm.join('\n'), '# ' + h.title, '', prose(rng, bodyBytes(o, h, rng, i), tokens), ''];
  if (v > 0) parts.push('Update ' + v + ': ' + prose(rng, 200), '');
  const links = 1 + (i % 3);
  for (let k = 0; k < links; k++) parts.push('See [[' + pagePath(o, p, hash32(o.seed, i, k, 0x11) % p.lives, 0).replace(/\.md$/, '') + ']].');
  parts.push('');
  const fenced = h.kind === 'connector' || (h.kind === 'person' && i % 3 === 0) || (h.priv && i % 2 === 0);
  if (fenced) {
    const rows = 3 + (i % 6);
    parts.push('## Facts', '', renderFactsTable(Array.from({ length: rows }, (_, r) => ({
      rowNum: r + 1, claim: (h.canary && r === 0 ? h.canary + ' ' : '') + cap(VOCAB[hash32(i, r, v) % 400]!) + ' ' + VOCAB[hash32(i, r, 3) % 900]! + ' for ' + h.title.toLowerCase() + ' (' + h.token + ')',
      kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', validFrom: h.date, source: h.kind === 'connector' ? h.provider + '-connector' : 'fixture', active: true,
    } satisfies ParsedFact))), '');
  }
  const entries = h.kind === 'timeline' ? 200 + (i % 600) : h.kind === 'person' || h.kind === 'meeting' ? 2 + (i % 4) : 0;
  if (entries) {
    parts.push('## Timeline', '');
    for (let k = 0; k < entries; k++) {
      const d = new Date((T0 + ((hash32(i, k, 0xd8) % (p.birth[i]! + 30)) * 86_400)) * 1000).toISOString().slice(0, 10);
      parts.push('- **' + d + '** | ' + cap(VOCAB[hash32(i, k) % 700]!) + ' ' + VOCAB[hash32(k, i) % 1500]! + ' with ' + h.title.toLowerCase());
    }
    parts.push('');
  }
  return parts.join('\n');
}

/** Files the importer must hold rather than import, committed in the backlog. */
export function problemFiles(o: FixtureOptions, n: number): Array<{ path: string; content: string; expect: string }> {
  const out: Array<{ path: string; content: string; expect: string }> = [];
  for (let k = 0; k < n; k++) {
    const id = b36(hash32(o.seed, k, 0xbad));
    const kind = k % 3;
    if (kind === 0) out.push({ path: 'notes/inbox/broken-frontmatter-' + id + '.md', expect: 'invalid_frontmatter', content: '---\ntitle: "unterminated ' + id + '\ntype: note\ntags: [a, b\n---\n# Broken ' + id + '\n\nBody zqpb' + id + '.\n' });
    else if (kind === 1) out.push({ path: 'connectors/crm/broken-fence-' + id + '.md', expect: 'invalid_fence', content: '---\ntitle: Broken fence ' + id + '\ntype: connector\n---\n# Broken fence ' + id + '\n\nzqpb' + id + '\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n\n| # | claim | kind |\n|---|---|\n| 1 | half a row\n<!--- gbrain:facts:end -->\n' });
    else out.push({ path: 'notes/inbox/slug-conflict-' + id + '.md', expect: 'frontmatter_slug_conflict', content: '---\ntitle: Slug conflict ' + id + '\ntype: note\nslug: notes/inbox/broken-frontmatter-' + b36(hash32(o.seed, k - 2, 0xbad)) + '\n---\n# Slug conflict ' + id + '\n\nzqpb' + id + '\n' });
  }
  return out;
}

interface Ev { life: number; type: number }
const ADD = 0, MOVE = 1, CULL = 2, EDIT = 3, DEL = 4;

class FastImport {
  private fd: number; private mark = 0; private buf: Buffer[] = []; private size = 0;
  constructor(file: string) { this.fd = openSync(file, 'w'); }
  private out(b: string | Buffer) { const x = typeof b === 'string' ? Buffer.from(b) : b; this.buf.push(x); this.size += x.length; if (this.size > 8 << 20) this.flush(); }
  flush() { if (this.size) { writeSync(this.fd, Buffer.concat(this.buf)); this.buf = []; this.size = 0; } }
  blob(content: string): number { const data = Buffer.from(content); const m = ++this.mark; this.out('blob\nmark :' + m + '\ndata ' + data.length + '\n'); this.out(data); this.out('\n'); return m; }
  commit(ref: string, day: number, seq: number, msg: string, ops: string[], from?: number, merge?: number): number {
    const m = ++this.mark, t = T0 + day * 86_400 + 9 * 3600 + seq * 97;
    this.out('commit ' + ref + '\nmark :' + m + '\nauthor Brain Writer <writer@example.invalid> ' + t + ' +0000\ncommitter Brain Writer <writer@example.invalid> ' + t + ' +0000\ndata ' + Buffer.byteLength(msg) + '\n' + msg + '\n'
      + (from ? 'from :' + from + '\n' : '') + (merge ? 'merge :' + merge + '\n' : '') + ops.join('\n') + (ops.length ? '\n' : '') + '\n');
    return m;
  }
  close() { this.flush(); writeSync(this.fd, 'done\n'); closeSync(this.fd); }
}

export interface SourceResult { id: SourceId; repo: string; head: string; import_base: string; commits: number; merges: number; live_pages: number; lives: number;
  deleted: number; moved: number; culled: number; private: Record<string, number>; kinds: Record<string, number>; bytes: number; side_deleted: number }

/** Builds one source's repository; returns its summary plus the lives the drift draws from. */
export function buildSource(o: FixtureOptions, s: number, dir: string, plans: SourcePlan[], drift: (row: object) => void, canaries: object[], privateTokens: string[]): SourceResult {
  const p = plans[s]!, src = SOURCES[s]!;
  const repo = join(dir, src.id, 'repo');
  rmSync(join(dir, src.id), { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  const streamFile = join(dir, src.id, 'fast-import.stream');
  const fi = new FastImport(streamFile);
  const twin = src.history === 'static' ? plans[0] : undefined;
  const byDay: Ev[][] = Array.from({ length: p.days }, () => []);
  for (let i = 0; i < p.lives; i++) {
    byDay[p.birth[i]!]!.push({ life: i, type: ADD });
    if (p.move[i] !== NEVER) byDay[p.move[i]!]!.push({ life: i, type: MOVE });
    if (p.cull[i] !== NEVER) byDay[p.cull[i]!]!.push({ life: i, type: CULL });
    if (p.del[i] !== NEVER) byDay[p.del[i]!]!.push({ life: i, type: DEL });
    const end = p.del[i] !== NEVER ? p.del[i]! : p.days;
    for (let e = 0; e < p.edits[i]!; e++) { const d = p.birth[i]! + 1 + (hash32(o.seed, s, i, e, 0xed) % Math.max(1, end - p.birth[i]! - 1)); if (d < end) byDay[d]!.push({ life: i, type: EDIT }); }
  }
  const ver = new Uint8Array(p.lives), stage = new Uint8Array(p.lives), blob = new Int32Array(p.lives), sideDel = new Uint8Array(p.lives);
  const path = (i: number) => pagePath(o, p, i, stage[i] as 0 | 1 | 2, twin);
  const live = new Map<string, number>();
  let tip = 0, commits = 0, merges = 0, importBase = 0, bytes = 0;
  const baseDay = p.days - o.backlogDays;
  const apply = (ev: Ev, ops: string[]) => {
    const i = ev.life;
    if (ev.type === ADD || ev.type === EDIT) {
      if (ev.type === EDIT) ver[i]++;
      const c = pageContent(o, p, i, ver[i]!); bytes += c.length;
      blob[i] = fi.blob(c);
      ops.push('M 100644 :' + blob[i] + ' ' + path(i)); live.set(path(i), i);
    } else if (ev.type === MOVE || ev.type === CULL) {
      const from = path(i); stage[i] = ev.type === MOVE ? 1 : 2; const to = path(i);
      if (from !== to) { ops.push('D ' + from, 'M 100644 :' + blob[i] + ' ' + to); live.delete(from); live.set(to, i); }
    } else { ops.push('D ' + path(i)); live.delete(path(i)); }
  };
  const recreated: number[] = [];
  for (let day = 0; day < p.days; day++) {
    if (day === baseDay) importBase = tip;
    const evs = byDay[day]!.sort((a, b) => a.type - b.type || a.life - b.life);
    if (src.history === 'daily' && day >= baseDay && day === baseDay + 1) {
      const ops: string[] = [];
      for (const f of problemFiles(o, 6 + Math.round(o.pages / 100_000) * 3)) ops.push('M 100644 :' + fi.blob(f.content) + ' ' + f.path);
      for (let i = 0; i < p.lives && recreated.length < Math.max(3, Math.round(o.pages / 20_000)); i++) if (p.del[i]! < baseDay - 30 && hash32(o.seed, i, 0x4ec) % 50 === 0) {
        recreated.push(i); const pth = path(i); ops.push('M 100644 :' + fi.blob(pageContent(o, p, i, ver[i]! + 1)) + ' ' + pth); live.set(pth, i);
      }
      tip = fi.commit('refs/heads/master', day, 0, 'agent writes (backlog)', ops, tip || undefined); commits++;
    }
    if (!evs.length) continue;
    const side = src.history === 'daily' && day % 9 === 4 && evs.length >= 4;
    if (side) {
      const mainLives = new Set(evs.filter(e => e.type === EDIT && e.life % 2 === 0).map(e => e.life));
      for (const e of evs) if (e.type !== EDIT) mainLives.delete(e.life);
      const mainOps: string[] = [], sideOps: string[] = [];
      for (const e of evs) { if (mainLives.has(e.life)) apply(e, mainOps); else { apply(e, sideOps); if (e.type === DEL) sideDel[e.life] = 1; } }
      const sideMark = fi.commit('refs/heads/side', day, 1, 'integrate remote writes', sideOps, tip || undefined);
      if (mainOps.length) tip = fi.commit('refs/heads/master', day, 2, 'librarian: commit edits', mainOps, tip || undefined);
      tip = fi.commit('refs/heads/master', day, 3, 'Merge remote-tracking branch', sideOps, tip, sideMark);
      commits += mainOps.length ? 3 : 2; merges++;
      continue;
    }
    const perCommit = evs.length > 3000 ? 5000 : Math.ceil(evs.length / (1 + (hash32(o.seed, s, day) % 3)));
    for (let c = 0, seq = 0; c < evs.length; c += perCommit, seq++) {
      const ops: string[] = [];
      for (const e of evs.slice(c, c + perCommit)) apply(e, ops);
      const msg = src.history === 'connector' ? 'connector sync' : evs.length > 3000 ? 'bulk import' : 'brain update';
      tip = fi.commit('refs/heads/master', day, seq, msg, ops);
      commits++;
    }
  }
  if (!importBase) importBase = tip;
  fi.close();
  const marksFile = join(dir, src.id, 'marks');
  execFileSync('sh', ['-c', 'git -C "$1" fast-import --quiet --export-marks="$2" < "$3"', 'sh', repo, marksFile, streamFile], { stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 1 << 30 });
  rmSync(streamFile);
  const sha = (mark: number) => execFileSync('sh', ['-c', 'grep "^:$1 " "$2" | cut -d" " -f2', 'sh', String(mark), marksFile], { encoding: 'utf8' }).trim();
  const head = sha(tip), base = sha(importBase);
  execFileSync('git', ['-C', repo, 'tag', 'import-base', base]);
  execFileSync('git', ['-C', repo, 'branch', '-f', 'final', head]);
  if (merges) execFileSync('git', ['-C', repo, 'branch', '-D', 'side'], { stdio: 'ignore' });
  rmSync(marksFile);
  const kinds: Record<string, number> = {}, priv: Record<string, number> = { visibility: 0, access: 0, confidentiality: 0 };
  for (const [pth, i] of live) {
    const h = pageHead(o, p, i);
    kinds[h.kind] = (kinds[h.kind] ?? 0) + 1;
    if (h.priv) { priv[h.priv]!++; if (canaries.length < 600 && hash32(o.seed, s, i, 0x5a) % 16 === 0) canaries.push({ source: src.id, slug: pth.replace(/\.md$/, ''), class: h.priv, token: h.canary, page_token: h.token }); }
  }
  for (let i = 0; i < p.lives; i++) if (p.priv[i]) { const h = pageHead(o, p, i); privateTokens.push(h.canary, h.token); }
  let sideDeleted = 0;
  if (src.history === 'daily') {
    const dbOnly = Math.max(10, Math.round(o.pages * 0.0024)), kept = Math.max(10, Math.round(o.pages * 0.0016));
    for (let k = 0; k < dbOnly; k++) {
      const i = hash32(o.seed, k, 0xdb0) % p.lives, h = pageHead(o, p, i);
      const slugPath = 'notes/agent/' + h.w1 + '-' + h.w2 + '-db' + b36(hash32(o.seed, k, 0xdb1)) + '.md';
      const token = 'zqpd' + b36(hash32(o.seed, k, 0xdb2));
      if (h.priv) privateTokens.push(token);
      drift({ kind: 'db_only', source: src.id, path: slugPath, private: h.priv || undefined, content: pageContent(o, p, i, 0).replaceAll(h.token, token) });
    }
    const deletedBeforeBase = [...Array(p.lives).keys()].filter(i => p.del[i]! < baseDay && !recreated.includes(i));
    sideDeleted = deletedBeforeBase.filter(i => sideDel[i]).length;
    const side = deletedBeforeBase.filter(i => sideDel[i]), plain = deletedBeforeBase.filter(i => !sideDel[i]);
    const pick = [...side.slice(0, Math.ceil(kept / 2)), ...plain.slice(0, kept)].slice(0, kept);
    for (const i of pick) { const st = (p.cull[i]! < p.del[i]! ? 2 : p.move[i]! < p.del[i]! ? 1 : 0) as 0 | 1 | 2; stage[i] = st;
      drift({ kind: 'kept_deleted', source: src.id, path: pagePath(o, p, i, st), side_branch: !!sideDel[i], content: pageContent(o, p, i, ver[i]!) }); }
  }
  let deleted = 0, moved = 0, culled = 0;
  for (let i = 0; i < p.lives; i++) { if (p.del[i] !== NEVER) deleted++; if (p.move[i] !== NEVER) moved++; if (p.cull[i] !== NEVER) culled++; }
  return { id: src.id, repo, head, import_base: base, commits, merges, live_pages: live.size, lives: p.lives, deleted, moved, culled, private: priv, kinds, bytes, side_deleted: sideDeleted };
}

export function buildFixture(o: FixtureOptions, dir: string): Record<string, unknown> {
  mkdirSync(dir, { recursive: true });
  const t0 = performance.now();
  const plans = SOURCES.map((_, s) => planSource(o, s));
  const driftFd = openSync(join(dir, 'drift.jsonl'), 'w');
  const counts: Record<string, number> = {};
  const drift = (row: object) => { const k = (row as { kind: string }).kind; counts[k] = (counts[k] ?? 0) + 1; writeSync(driftFd, JSON.stringify(row) + '\n'); };
  const canaries: object[] = [], privateTokens: string[] = [];
  const sources = SOURCES.map((_, s) => { const r = buildSource(o, s, dir, plans, drift, canaries, privateTokens); console.error('[soak-fixture] ' + r.id + ': ' + r.live_pages + ' pages, ' + r.commits + ' commits, ' + r.merges + ' merges (' + Math.round((performance.now() - t0) / 1000) + ' s)'); return r; });
  closeSync(driftFd);
  writeFileSync(join(dir, 'private-tokens.json'), JSON.stringify(privateTokens));
  const manifest = { schema: 'gbrain-production-soak-fixture/1', options: o, sources, drift: counts, privacy: { canaries, private_tokens: privateTokens.length }, problem_files: problemFiles(o, 6 + Math.round(o.pages / 100_000) * 3).map(f => ({ path: f.path, expect: f.expect })),
    pages: sources.reduce((a, r) => a + r.live_pages, 0), build_s: Math.round((performance.now() - t0) / 1000) };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
  const out = flag('out');
  if (!out) { console.error('usage: fixture.ts --out <dir> [--pages N] [--seed N] [--years N] [--backlog-days N] [--huge-mb N] [--oversized N]'); process.exit(2); }
  const o: FixtureOptions = { pages: Number(flag('pages') ?? DEFAULTS.pages), seed: Number(flag('seed') ?? DEFAULTS.seed), years: Number(flag('years') ?? DEFAULTS.years),
    backlogDays: Number(flag('backlog-days') ?? DEFAULTS.backlogDays), hugeMb: Number(flag('huge-mb') ?? DEFAULTS.hugeMb), oversized: Number(flag('oversized') ?? DEFAULTS.oversized) };
  const m = buildFixture(o, out);
  console.log(JSON.stringify({ pages: m.pages, drift: m.drift, build_s: m.build_s }));
}
