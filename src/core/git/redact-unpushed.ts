/**
 * GST-2988 PR 2: a publish redacts the secrets in unpushed commits instead of refusing them (`secrets.on_push`, default
 * `redact`; `refuse` keeps the old refusal). docs/guides/secret-store.md#publishing and
 * docs/guides/shared-checkout-git.md#publish_secret_redacted describe it for users.
 *
 * The range scan (range-secret-scan.ts) runs as it always has, but with the remote's `.gbrain-scan-allow` (read from
 * the base tree, so an agent cannot allowlist its own way past it). Its findings feed this route, which runs under the
 * publish lock and then the commit lock (the order every publisher takes them), after checking HEAD:
 *
 *  1. every value is kept in the secret store (or, when the store cannot be written, its encrypted local spool, D9) and
 *     replaced by the store marker `<REDACTED:rule:ss_id>`; a value the owner restored (status `allowed`) stays;
 *  2. the old HEAD is kept under `refs/gbrain/backup/redact-<utc>` (maintenance deletes these after 7 days);
 *  3. the commits no `refs/remotes/*` ref reaches are rebuilt with plumbing: one `cat-file --batch` per round of
 *     reads, ids computed in-process, one `hash-object -w --no-filters --stdin-paths` per object type. Each changed
 *     blob is re-scanned whole and its bytes spliced; trees are rebuilt only along the paths that change (modes,
 *     symlinks and gitlinks unchanged); commit objects keep every header byte for byte except a signature, which a
 *     rebuilt commit cannot keep (`publish_secret_unsigned`), and a message holding a finding is redacted too;
 *  4. text the scan cannot vouch for (over the scan cap, not valid UTF-8) and changes to `.gbrain-scan-allow` or a
 *     `.gitattributes` are held back (D10): the rebuilt range keeps the remote's version of those paths, and one local
 *     commit on top (ledger `held`) keeps this checkout's version, so the working tree and sync see no change. The
 *     publish pushes the commit below it; a later run drops that commit and makes one new held commit;
 *  5. each rebuilt commit is ledgered as `redact_rebuild` superseding the old one (a page-write commit whose own diff
 *     is unchanged keeps its scan exemption; a foreign commit stays foreign), the rebuilt range is scanned again and
 *     must be clean and differ from the old one only at the redacted and held paths;
 *  6. the new index is built under `index.lock`, the branch moves with `update-ref` expecting the old HEAD, then the
 *     index is renamed in (and discarded on failure); a working-tree file is rewritten only where its bytes are the old
 *     blob's, and a file with local edits is redacted value by value;
 *  7. the old-to-new commit map is appended to `<git common dir>/gbrain/redactions.jsonl`, which redact-finish.ts
 *     applies to the database (`sources.last_commit`, the pages those files hold) once a database is at hand.
 *
 * It never rewrites a commit a remote-tracking ref reaches, never force-pushes and never moves a ref other than the
 * checked-out branch; other local refs that still hold an old commit are named (`publish_secret_side_refs`). A HEAD
 * that moves under the route is retried up to 3 times (`publish_secret_rebuild_race`); a run past its time budget
 * stops before anything moves (`publish_secret_rebuild_unbounded`). Repo-less brains have no publish and never get here.
 */
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { GIT_ENV } from '../git-transport.ts';
import { loadConfigFileOnly } from '../config.ts';
import { opError, OperationError } from '../ops/contract.ts';
import type { Action, Notice } from '../agent-output.ts';
import { NAMED_SECRET_RULES, SCAN_MAX_FILE_BYTES, scanTextSpans } from '../secret-scan.ts';
import { pathAllowlisted, ruleAllowEntry, SCAN_ALLOW_FILENAME } from '../secret-scan-allowlist.ts';
import { markerOf } from '../secret-store/store.ts';
import { addSpoolOccurrences, allowedLocally, spoolValue, type SpoolOccurrence } from '../secret-store/spool.ts';
import { acquireNativeLockSync } from '../persistence/native-lock.ts';
import { heldCommits, ledgerLocation, recordCommit } from './commit-ledger.ts';
import { acquireCommitLock, assertNoOperationInProgress, PUBLISH_LOCK_NAME } from './commit-push.ts';
import { MESSAGE_PATH, rangeSecretRefusal, scanRange, type RangeScan } from './range-secret-scan.ts';

export const ON_PUSH_KEY = 'secrets.on_push';
export type OnPush = 'redact' | 'refuse';
/** The environment twin of `secrets.on_push` (like GBRAIN_ALLOW_UNVERIFIED_REMOTE for push.allow_unverified_remote). It can only tighten: `refuse` is its one value. */
export const ON_PUSH_ENV = 'GBRAIN_SECRETS_ON_PUSH';
let ignoredEnvNoticed = false;
/**
 * `secrets.on_push` from the file plane (engine-free publishers read it), or GBRAIN_SECRETS_ON_PUSH=refuse: `refuse`
 * keeps the old refusal; anything else redacts. Any other value of the variable changes nothing (it never turns
 * redaction on where config says refuse) and prints one notice on stderr per process.
 */
export function onPushMode(): OnPush {
  const env = process.env[ON_PUSH_ENV];
  if (env === 'refuse') return 'refuse';
  if (env !== undefined && !ignoredEnvNoticed) {
    ignoredEnvNoticed = true;
    process.stderr.write(`[gbrain notice] ${ON_PUSH_ENV}=${JSON.stringify(env.slice(0, 40))} is ignored: its only value is refuse; secrets.on_push in the config decides.\n`);
  }
  return loadConfigFileOnly()?.secrets?.on_push === 'refuse' ? 'refuse' : 'redact';
}

export const BACKUP_REF_PREFIX = 'refs/gbrain/backup/';
export const BACKUP_KEEP_DAYS = 7;
export const HELD_TRAILER = 'Gbrain-Redact-Held';
export const REDACTIONS_FILE = 'redactions.jsonl';
export const DEFAULT_REBUILD_BUDGET_MS = 300_000;
/** A value right after this is a presigned link's key id (`X-Amz-Credential=`, also `=3D` in quoted-printable mail and `%3D` URL-encoded). */
export const SIGNED_LINK_CREDENTIAL = /X-Amz-Credential(?:=|=3D|%3D)$/i;
/** A history no remote-tracking ref bounds is rebuilt only up to this many commits. */
const UNBOUNDED_COMMITS = 20_000;
const MAX_ATTEMPTS = 3;
const DOCS = 'docs/guides/shared-checkout-git.md';

/** Where originals go: this machine's encrypted spool (spoolSealer), which the database half (redact-finish.ts) drains into the store. */
export interface Sealer {
  /** True when the owner restored this value (store status `allowed`): it is left as it is. */
  allowed(value: string): boolean;
  /** The store id the marker names. */
  seal(rule: string, value: string): string;
  /** Where each marker landed (rebuilt commit and path). */
  record(occurrences: Array<{ id: string; commit: string; path: string; line: number | null }>): void;
  spooled(): number;
}

/** Seals into this machine's spool (D9); a value the owner restored is left alone. */
export function spoolSealer(root: string, sourceId: string | null): Sealer {
  const ids = new Set<string>();
  return {
    allowed: allowedLocally,
    seal: (rule, value) => { const id = spoolValue({ root, sourceId, rule, value }); ids.add(id); return id; },
    record: occurrences => {
      const byId = new Map<string, SpoolOccurrence[]>();
      for (const o of occurrences) {
        const list = byId.get(o.id) ?? [];
        list.push({ commit: o.commit, path: o.path, line: o.line, field: `git:${o.path}` });
        byId.set(o.id, list);
      }
      for (const [id, list] of byId) addSpoolOccurrences(id, list);
    },
    spooled: () => ids.size,
  };
}

export interface RedactPreview {
  root: string; branch: string; head: string; base: string; commits: number; hash: string;
  findings: Array<{ commit: string; path: string; line: number; pattern: string; fingerprint: string }>;
  paths: Array<{ path: string; spans: number }>; messages: string[]; held: Array<{ path: string; reason: HeldReason }>; signed: string[];
  /** Per rule: distinct values, replaced spans, and how many of those sat right after a signed link's credential parameter. */
  rules: Record<string, { values: number; hits: number; signed_link: number; bare: number }>;
}
export interface RedactOutcome extends RedactPreview {
  redacted: true; old_head: string; new_head: string; push_target: string; backup_ref: string; held_commit: string | null;
  rebuilt: number; values: number; spooled: number; side_refs: string[]; unsigned: string[]; map: Record<string, string>; notices: Notice[];
}
export type HeldReason = 'gate_change' | 'too_large' | 'not_utf8' | 'held_before';

class OverBudget extends Error {}
/** Once the branch has moved, the remaining local steps finish past the budget so the move is always journaled. */
const AFTER_MOVE_MS = 30_000;
class GitFailed extends Error {}
class Race extends Error {}

interface Entry { mode: string; name: Buffer; id: string }
interface Commit { sha: string; parents: string[]; tree: string; raw: Buffer; signed: boolean }
interface Span { start: number; end: number; value: string; rule: string }

function run(root: string, args: string[], deadline: number, opts: { input?: string | Buffer; env?: NodeJS.ProcessEnv; allowFail?: boolean } = {}): { status: number; stdout: Buffer } {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new OverBudget();
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { input: opts.input ?? '', timeout, maxBuffer: 1 << 30,
    env: gitChildEnv({ ...GIT_ENV, LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1', ...opts.env }) });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new OverBudget();
  if (!opts.allowFail && (r.error || r.status !== 0)) throw new GitFailed(`git ${args[0]} failed: ${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 300) || `exit ${r.status}`}`);
  return { status: r.status ?? -1, stdout: (r.stdout as Buffer) ?? Buffer.alloc(0) };
}
const text = (r: { stdout: Buffer }) => r.stdout.toString('utf8').trim();
const isTree = (mode: string) => mode === '40000';
const isFile = (mode: string) => mode === '100644' || mode === '100755';
const ancestors = (path: string) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/') + '/');

/** Objects by id from one `cat-file --batch` run. */
function readObjects(root: string, ids: string[], deadline: number): Map<string, { type: string; data: Buffer }> {
  const unique = [...new Set(ids)];
  const out = new Map<string, { type: string; data: Buffer }>();
  if (!unique.length) return out;
  const raw = run(root, ['cat-file', '--batch'], deadline, { input: unique.join('\n') + '\n' }).stdout;
  let pos = 0;
  for (const id of unique) {
    const nl = raw.indexOf(10, pos);
    const m = nl < 0 ? null : /^([0-9a-f]+) (\S+) (\d+)$/.exec(raw.subarray(pos, nl).toString('latin1'));
    if (!m || m[1] !== id) throw new GitFailed(`object ${id.slice(0, 12)} could not be read`);
    const size = Number(m[3]);
    out.set(id, { type: m[2]!, data: raw.subarray(nl + 1, nl + 1 + size) });
    pos = nl + 1 + size + 1;
  }
  return out;
}

function parseTree(data: Buffer, idBytes: number): Entry[] {
  const out: Entry[] = [];
  for (let pos = 0; pos < data.length;) {
    const sp = data.indexOf(32, pos), nul = data.indexOf(0, sp);
    out.push({ mode: data.subarray(pos, sp).toString('latin1'), name: Buffer.from(data.subarray(sp + 1, nul)), id: data.subarray(nul + 1, nul + 1 + idBytes).toString('hex') });
    pos = nul + 1 + idBytes;
  }
  return out;
}
/** Git's tree order: names compared as bytes, a directory as if it ended in '/'. */
function treeBody(entries: Entry[]): Buffer {
  const key = (e: Entry) => isTree(e.mode) ? Buffer.concat([e.name, Buffer.from('/')]) : e.name;
  return Buffer.concat([...entries].sort((a, b) => Buffer.compare(key(a), key(b))).flatMap(e => [Buffer.from(`${e.mode} `), e.name, Buffer.from([0]), Buffer.from(e.id, 'hex')]));
}

/** The splice of `spans` (sorted, disjoint) with each value's marker. */
function splice(source: string, spans: Span[], ids: ReadonlyMap<string, string>): string {
  let out = '', at = 0;
  for (const span of spans) { out += source.slice(at, span.start) + markerOf(span.rule, ids.get(span.value)!); at = span.end; }
  return out + source.slice(at);
}

/** The scanner's named-rule claims in `source` that the allowlist leaves (`rel`: the path below the scanned root, null for a message). */
function claims(source: string, allowlist: string[], rel: string | null): Span[] {
  const named = new Set(NAMED_SECRET_RULES);
  return scanTextSpans(source, { allowlist }).flatMap(hit => !hit.finding || !named.has(hit.finding.pattern) || (rel !== null && ruleAllowEntry(rel, hit.finding.pattern, allowlist) !== null)
    ? [] : [{ start: hit.start, end: hit.end, value: source.slice(hit.start, hit.end), rule: hit.finding.pattern }]);
}

/** Every claim plus, between them, each known value (longest first) wherever it appears bare. */
function spansIn(source: string, own: Span[], values: ReadonlyMap<string, string>): Span[] {
  const known = [...values].sort((a, b) => b[0].length - a[0].length);
  const head = known.length ? Math.min(16, ...known.map(([value]) => value.length)) : 0;
  const byHead = new Map<string, Array<[string, string]>>();
  for (const entry of known) {
    const list = byHead.get(entry[0].slice(0, head));
    if (list) list.push(entry); else byHead.set(entry[0].slice(0, head), [entry]);
  }
  const firsts = new Set(known.map(([value]) => value.charCodeAt(0)));
  const out: Span[] = [];
  const gap = (from: number, to: number) => {
    if (!head) return;
    for (let at = from; at + head <= to;) {
      const hit = firsts.has(source.charCodeAt(at))
        ? byHead.get(source.slice(at, at + head))?.find(([value]) => at + value.length <= to && source.startsWith(value, at)) : undefined;
      if (!hit) { at++; continue; }
      out.push({ start: at, end: at + hit[0].length, value: hit[0], rule: hit[1] });
      at += hit[0].length;
    }
  };
  let cur = 0;
  for (const span of [...own].sort((a, b) => a.start - b.start)) {
    if (span.start < cur) continue;
    gap(cur, span.start);
    out.push(span);
    cur = span.end;
  }
  gap(cur, source.length);
  return out;
}

const utf8 = (data: Buffer): string | null => { try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; } };

interface Plan {
  root: string; top: string; prefix: string; branch: string; head: string; base: string; format: 'sha1' | 'sha256'; idBytes: number;
  commits: Commit[]; scan: RangeScan; allowlist: string[]; trees: Map<string, Entry[]>; baseTree: string | null; parentTrees: Map<string, string>;
  /** Fingerprints of values the owner restored: left in place, so the scan of the rebuilt range accepts them. */
  allowedFingerprints: string[];
  touched: Set<string>; held: Map<string, HeldReason>; dropped: Set<string>;
  blobs: Map<string, { path: string; blob: string; data: Buffer; text: string; spans: Span[]; first: string }>;
  messages: Map<string, { split: number; text: string; spans: Span[] }>; values: Map<string, string>; hash: string;
}

/** Reads the range, scans it with the remote's allowlist and plans every splice; writes nothing. */
function plan(root: string, base: string, deadline: number, allowed: (value: string) => boolean): Plan | null {
  const top = text(run(root, ['rev-parse', '--show-toplevel'], deadline));
  const prefix = run(root, ['rev-parse', '--show-prefix'], deadline).stdout.toString('utf8').replace(/\n$/, '');
  const branch = run(root, ['symbolic-ref', '--quiet', 'HEAD'], deadline, { allowFail: true });
  if (branch.status !== 0) throw opError('git_detached_head', `${root} is on a detached HEAD, so there is no branch to redact and publish.`, 'Check out the branch the remote tracks (git switch <branch>), then rerun.');
  assertNoOperationInProgress(root);
  const head = text(run(root, ['rev-parse', '--verify', 'HEAD^{commit}'], deadline));
  const format = text(run(root, ['rev-parse', '--show-object-format'], deadline, { allowFail: true })) === 'sha256' ? 'sha256' : 'sha1';
  const idBytes = format === 'sha256' ? 32 : 20;
  const remotes = run(root, ['for-each-ref', '--format', '%(objectname)', 'refs/remotes'], deadline).stdout.toString('utf8').split('\n').filter(Boolean);
  const listed = run(root, ['rev-list', '--topo-order', '--reverse', '--parents', '--stdin'], deadline,
    { input: [head, ...[...remotes, ...(base ? [base] : [])].map(sha => `^${sha}`)].join('\n') + '\n' }).stdout.toString('utf8').split('\n').filter(Boolean);
  if (!remotes.length && !base && listed.length > UNBOUNDED_COMMITS) throw new OverBudget();
  const allowPath = `${prefix}${SCAN_ALLOW_FILENAME}`;
  const allowText = base ? run(root, ['cat-file', 'blob', `${base}:${allowPath}`], deadline, { allowFail: true }) : null;
  const allowlist = allowText?.status === 0 ? allowText.stdout.toString('utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) : [];
  const scan = scanRange(root, base, head, deadline - Date.now(), undefined, { allowlist });
  if (scan.timed_out) throw new OverBudget();
  if (scan.unreadable !== undefined) throw rangeSecretRefusal(root, base, head, scan)!;
  if (!scan.findings.length && !scan.unscanned.length && !scan.gate_changes.length) return null;

  const order = listed.map(line => line.split(' '));
  const inRange = new Set(order.map(([sha]) => sha!));
  const outside = { findings: scan.findings.filter(f => !inRange.has(f.commit)), unscanned: scan.unscanned.filter(u => !inRange.has(u.commit)), gate_changes: scan.gate_changes.filter(g => !inRange.has(g.commit)) };
  if (outside.findings.length + outside.unscanned.length + outside.gate_changes.length) {
    const refusal = rangeSecretRefusal(root, base, head, { ...scan, ...outside })!;
    throw opError('publish_secret_found', `${refusal.message} These commits are already on a remote-tracking branch, so they are never rewritten.`, refusal.suggestion ?? '', { detail: refusal.detail ?? undefined, fix: refusal.fix as Action });
  }
  const boundary = [...new Set(order.flatMap(([, ...parents]) => parents.filter(p => !inRange.has(p))))];
  const objects = readObjects(root, [...inRange, ...boundary, ...(base ? [base] : [])], deadline);
  const treeOf = (raw: Buffer) => /^tree ([0-9a-f]+)$/m.exec(raw.subarray(0, raw.indexOf('\n\n')).toString('latin1'))![1]!;
  const commits: Commit[] = order.map(([sha, ...parents]) => {
    const raw = objects.get(sha!)!.data;
    const headers = raw.subarray(0, raw.indexOf('\n\n')).toString('latin1');
    return { sha: sha!, parents, tree: treeOf(raw), raw, signed: /^gpgsig(?:-sha256)? /m.test(headers) };
  });
  const parentTrees = new Map(boundary.map(sha => [sha, treeOf(objects.get(sha)!.data)]));
  const baseTree = base ? treeOf(objects.get(base)!.data) : null;

  const held = new Map<string, HeldReason>();
  for (const g of scan.gate_changes) held.set(g.path, 'gate_change');
  for (const u of scan.unscanned) if (u.path !== MESSAGE_PATH) held.set(u.path, 'too_large');
  const dropped = new Set([...heldCommits(root)].filter(sha => inRange.has(sha)));
  for (const sha of dropped) {
    const c = commits.find(x => x.sha === sha)!;
    for (const path of run(root, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--no-commit-id', c.parents[0] ?? '--root', sha], deadline).stdout.toString('utf8').split('\0').filter(Boolean)) {
      if (!held.has(path)) held.set(path, 'held_before');
    }
  }
  const touched = new Set(scan.findings.filter(f => f.path !== MESSAGE_PATH && !held.has(f.path)).map(f => f.path));

  // Read trees round by round, only along the paths that may change.
  const trees = new Map<string, Entry[]>();
  const dirs = new Set([...touched, ...held.keys()].flatMap(ancestors));
  let frontier: Array<[string, string]> = [...new Set([...commits.map(c => c.tree), ...parentTrees.values(), ...(baseTree ? [baseTree] : [])])].map(id => [id, '']);
  const seen = new Set<string>();
  while (frontier.length) {
    const read = readObjects(root, frontier.map(([id]) => id).filter(id => !trees.has(id)), deadline);
    for (const [id, obj] of read) trees.set(id, parseTree(obj.data, idBytes));
    const next: Array<[string, string]> = [];
    for (const [id, dir] of frontier) {
      if (seen.has(`${id}\0${dir}`)) continue;
      seen.add(`${id}\0${dir}`);
      for (const e of trees.get(id)!) if (isTree(e.mode) && dirs.has(`${dir}${e.name.toString('utf8')}/`)) next.push([e.id, `${dir}${e.name.toString('utf8')}/`]);
    }
    frontier = next;
  }

  const blobs = new Map<string, { path: string; blob: string; data: Buffer; text: string; spans: Span[]; first: string }>();
  const at = new Map<string, { path: string; blob: string; first: string }>();
  for (const c of commits) for (const path of touched) {
    const e = entryAt(trees, c.tree, path);
    if (e && isFile(e.mode) && !at.has(`${path}\0${e.id}`)) at.set(`${path}\0${e.id}`, { path, blob: e.id, first: c.sha });
  }
  const data = readObjects(root, [...at.values()].map(b => b.blob), deadline);
  const rel = (path: string) => path.startsWith(prefix) ? path.slice(prefix.length) : null;
  const own = new Map<string, Span[]>();
  for (const [key, b] of at) {
    const bytes = data.get(b.blob)!.data;
    const decoded = bytes.length > SCAN_MAX_FILE_BYTES ? null : utf8(bytes);
    if (decoded === null) { held.set(b.path, bytes.length > SCAN_MAX_FILE_BYTES ? 'too_large' : 'not_utf8'); touched.delete(b.path); continue; }
    const r = rel(b.path);
    own.set(key, r !== null && pathAllowlisted(r, allowlist) ? [] : claims(decoded, allowlist, r));
    blobs.set(key, { ...b, data: bytes, text: decoded, spans: [], first: b.first });
  }
  for (const key of [...blobs.keys()]) if (!touched.has(blobs.get(key)!.path)) blobs.delete(key);
  const messages = new Map<string, { split: number; text: string; spans: Span[] }>();
  const ownMessage = new Map<string, Span[]>();
  for (const sha of new Set(scan.findings.filter(f => f.path === MESSAGE_PATH).map(f => f.commit))) {
    const c = commits.find(x => x.sha === sha)!;
    const split = c.raw.indexOf('\n\n');
    const encoding = /^encoding (.+)$/m.exec(c.raw.subarray(0, split).toString('latin1'))?.[1]?.trim() ?? 'utf-8';
    const decoded = /^utf-?8$/i.test(encoding) ? utf8(c.raw.subarray(split + 2)) : null;
    if (decoded === null) throw opError('publish_secret_found', `The message of local commit ${sha.slice(0, 12)} holds a value that looks like a secret, and its encoding (${encoding.slice(0, 40)}) cannot be rewritten byte for byte. Nothing was pushed.`,
      `Reword that commit yourself (it is not on any remote), then retry. See ${DOCS}#publish_secret_found.`);
    ownMessage.set(sha, claims(decoded, allowlist, null));
    messages.set(sha, { split, text: decoded, spans: [] });
  }
  const values = new Map<string, string>();
  for (const spans of [...own.values(), ...ownMessage.values()]) for (const s of spans) if (!values.has(s.value)) values.set(s.value, s.rule);
  const allowedFingerprints: string[] = [];
  for (const value of [...values.keys()]) {
    if (!allowed(value)) continue;
    values.delete(value);
    allowedFingerprints.push(`sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`);
  }
  const keep = (spans: Span[]) => spans.filter(s => values.has(s.value));
  for (const [key, b] of blobs) b.spans = spansIn(b.text, keep(own.get(key) ?? []), values);
  for (const [sha, m] of messages) m.spans = spansIn(m.text, keep(ownMessage.get(sha) ?? []), values);
  const hash = createHash('sha256').update(JSON.stringify(['redact-unpushed-v1', head, base, commits.length,
    scan.findings.map(f => [f.commit, f.path, f.line, f.pattern, f.fingerprint]).sort(), [...held].sort()])).digest('hex').slice(0, 16);
  return { root, top, prefix, branch: text(branch), head, base, format, idBytes, commits, scan, allowlist, trees, baseTree, parentTrees, allowedFingerprints, touched, held, dropped, blobs, messages, values, hash };
}

function entryAt(trees: Map<string, Entry[]>, tree: string | null, path: string): Entry | null {
  let id = tree;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const e = id ? trees.get(id)?.find(x => x.name.toString('utf8') === parts[i]) : undefined;
    if (!e) return null;
    if (i === parts.length - 1) return e;
    if (!isTree(e.mode)) return null;
    id = e.id;
  }
  return null;
}

function previewOf(p: Plan): RedactPreview {
  const spans = new Map<string, number>();
  for (const b of p.blobs.values()) spans.set(b.path, (spans.get(b.path) ?? 0) + b.spans.length);
  const rules: RedactPreview['rules'] = {};
  const counts = (rule: string) => rules[rule] ??= { values: 0, hits: 0, signed_link: 0, bare: 0 };
  for (const rule of p.values.values()) counts(rule).values++;
  for (const { text, spans: own } of [...p.blobs.values(), ...p.messages.values()]) {
    for (const s of own) {
      const c = counts(s.rule);
      c.hits++;
      if (SIGNED_LINK_CREDENTIAL.test(text.slice(Math.max(0, s.start - 24), s.start))) c.signed_link++; else c.bare++;
    }
  }
  return { root: p.root, branch: p.branch.replace(/^refs\/heads\//, ''), head: p.head, base: p.base, commits: p.commits.length, hash: p.hash,
    findings: p.scan.findings.map(f => ({ commit: f.commit, path: f.path, line: f.line, pattern: f.pattern, fingerprint: f.fingerprint })),
    paths: [...spans].map(([path, n]) => ({ path, spans: n })).sort((a, b) => a.path.localeCompare(b.path)),
    messages: [...p.messages.keys()], held: [...p.held].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path)),
    signed: p.commits.filter(c => c.signed).map(c => c.sha), rules };
}

export interface RedactOptions {
  /** The remote branch tip the push leases on ('' when the remote has no such branch). */
  base: string;
  /** Without one the route only previews. */
  sealer?: Sealer;
  /** For a preview: whether the owner restored a value (store status allowed). */
  allowed?: (value: string) => boolean;
  /** The preview hash the operator approved (gbrain git redact-unpushed --apply --expect). */
  expect?: string;
  budgetMs?: number;
  /** The caller's own wall-clock deadline (a publish's one bound across its scans, this redaction and its pushes); budgetMs then only names it. */
  deadline?: number;
  lockWaitMs?: number;
  /** The source the fix lines name. */
  sourceId?: string | null;
  /** The caller (commitAndPush's publish) already holds the publish lock. */
  publishLockHeld?: boolean;
}

/**
 * Previews (no sealer) or runs the route. Returns null when the range holds nothing to redact. Throws the refusal for
 * what it cannot redact (publish_secret_found for commits a remote-tracking ref reaches, publish_scan_unreadable),
 * publish_secret_rebuild_unbounded past the budget, publish_secret_rebuild_race after 3 moved HEADs.
 */
export function redactUnpushed(root: string, opts: RedactOptions): RedactPreview | RedactOutcome | null {
  const budget = opts.budgetMs ?? DEFAULT_REBUILD_BUDGET_MS;
  const deadline = opts.deadline ?? Date.now() + budget;
  const noRemote = () => run(root, ['for-each-ref', '--count', '1', 'refs/remotes'], Date.now() + 10_000, { allowFail: true }).stdout.length === 0;
  try {
    if (!opts.sealer) {
      const p = plan(root, opts.base, deadline, opts.allowed ?? (() => false));
      return p && previewOf(p);
    }
    const sealer = opts.sealer;
    for (let attempt = 1; ; attempt++) {
      const publishLock = opts.publishLockHeld ? { release: () => undefined } : acquireNativeLockSync(gitPath(root, PUBLISH_LOCK_NAME), { timeoutMs: opts.lockWaitMs ?? lockWaitMs() });
      if (!publishLock) throw opError('push_unconfirmed', 'Another publish held this checkout\'s push lock, so the unpushed commits were not redacted yet.', 'The push retries on its own; nothing was changed.', { retryable: true });
      try {
        const wait = opts.lockWaitMs ?? lockWaitMs(), left = deadline - Date.now();
        if (left <= 0) throw new OverBudget();
        let commitLock: ReturnType<typeof acquireCommitLock>;
        try { commitLock = acquireCommitLock(root, Math.min(wait, left)); } catch (error) { if (left < wait) throw new OverBudget(); throw error; }
        try {
          const p = plan(root, opts.base, deadline, value => sealer.allowed(value));
          if (!p) return null;
          if (opts.expect && opts.expect !== p.hash) {
            throw opError('preview_changed', `The unpushed commits changed since the preview (hash ${p.hash}, expected ${opts.expect}); nothing was rewritten.`,
              `Preview again: gbrain git redact-unpushed --source ${opts.sourceId ?? '<id>'}, then apply with the hash it prints.`);
          }
          return rebuild(p, sealer, deadline);
        } finally { commitLock.release(); }
      } catch (error) {
        if (!(error instanceof Race)) throw error;
        if (attempt >= MAX_ATTEMPTS) throw raceError(root, opts.sourceId);
      } finally { publishLock.release(); }
    }
  } catch (error) {
    if (error instanceof OverBudget) throw unboundedError(root, budget, noRemote(), opts.sourceId);
    if (error instanceof GitFailed) throw opError('publish_scan_unreadable', `The unpushed commits in ${root} could not be read or rebuilt for redaction (${error.message}). Nothing was rewritten or pushed.`,
      `Check the checkout with git -C ${root} fsck and fix what it reports, then retry.`, { fix: { ask_user: true, consent: [], actor: 'user', requires_exclusive: false, argv: ['git', '-C', root, 'fsck'],
        why: 'Read-only: names missing or corrupt objects.', user_message: `The unpushed commits in ${root} could not be read for redaction, so nothing was pushed. Check the checkout with git fsck?`, docs: `${DOCS}#publish_scan_unreadable` } });
    throw error;
  }
}

const lockWaitMs = () => { const s = Number(process.env.GBRAIN_PUBLISH_LOCK_WAIT_SECONDS ?? 60); return Number.isFinite(s) && s >= 0 ? s * 1000 : 60_000; };
function gitPath(root: string, name: string): string {
  const p = text(run(root, ['rev-parse', '--git-path', name], Date.now() + 10_000));
  return isAbsolute(p) ? p : resolve(root, p);
}

function raceError(root: string, sourceId?: string | null): OperationError {
  return opError('publish_secret_rebuild_race', `HEAD in ${root} moved ${MAX_ATTEMPTS} times while the unpushed commits were being redacted (a writer that does not take the commit lock), so nothing was rewritten or pushed.`,
    'The next publish redacts and pushes them; nothing is lost. If it keeps happening, find the writer that commits without gbrain git commit-push.',
    { retryable: true, fix: { argv: ['gbrain', 'git', 'redact-unpushed', ...(sourceId ? ['--source', sourceId] : ['--path', root])], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Read-only preview of the same redaction; the publish retries it on its own.', docs: `${DOCS}#publish_secret_rebuild_race` } });
}
function unboundedError(root: string, budget: number, noRemote: boolean, sourceId?: string | null): OperationError {
  return opError('publish_secret_rebuild_unbounded', `Redacting the unpushed commits in ${root} ran past its ${Math.round(budget / 1000)} s budget${noRemote ? ' (no remote-tracking ref bounds the history, so all of it is unpushed)' : ''}. Nothing was rewritten or pushed.`,
    'The publish retries in the background with a longer budget; nothing is lost locally. Run the preview to see how much it covers.',
    { retryable: true, fix: { argv: ['gbrain', 'git', 'redact-unpushed', ...(sourceId ? ['--source', sourceId] : ['--path', root])], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Read-only: lists the commits, values and held files the redaction covers.', docs: `${DOCS}#publish_secret_rebuild_unbounded` } });
}

/** Steps 1 to 7 under both locks. Throws Race when HEAD moved; writes nothing a later attempt cannot redo. */
function rebuild(p: Plan, sealer: Sealer, deadline: number): RedactOutcome {
  if (text(run(p.root, ['rev-parse', 'HEAD'], deadline)) !== p.head) throw new Race();
  const objectId = (type: string, body: Buffer) => createHash(p.format).update(`${type} ${body.length}\0`).update(body).digest('hex');
  const ids = new Map<string, string>();
  for (const [value, rule] of p.values) ids.set(value, sealer.seal(rule, value));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backupRef = `${BACKUP_REF_PREFIX}redact-${stamp}-${p.head.slice(0, 12)}`;

  const written = { blob: new Map<string, Buffer>(), tree: new Map<string, Buffer>(), commit: new Map<string, Buffer>() };
  const blobMap = new Map<string, string>();
  for (const [key, b] of p.blobs) {
    if (!b.spans.length) continue;
    const body = Buffer.from(splice(b.text, b.spans, ids), 'utf8');
    const id = objectId('blob', body);
    blobMap.set(key, id);
    written.blob.set(id, body);
  }
  const base = new Map([...p.held.keys()].map(path => [path, p.baseTree ? entryAt(p.trees, p.baseTree, path) : null]));
  const headEntries = new Map([...p.held.keys()].map(path => [path, entryAt(p.trees, p.commits.find(c => c.sha === p.head)?.tree ?? null, path)]));
  const edit = (at: (path: string, e: Entry | null) => Entry | null, files: Iterable<string>) => {
    const fileSet = new Set(files);
    const dirs = new Set([...fileSet].flatMap(ancestors));
    const memo = new Map<string, string | null>();
    const walk = (tree: string | null, dir: string): string | null => {
      const key = `${tree}\0${dir}`;
      if (memo.has(key)) return memo.get(key)!;
      const entries = tree ? p.trees.get(tree)! : [];
      const out: Entry[] = [];
      const present = new Set<string>();
      for (const e of entries) {
        const full = `${dir}${e.name.toString('utf8')}`;
        present.add(full);
        if (fileSet.has(full)) { const next = at(full, e); if (next) out.push({ ...next, name: e.name }); continue; }
        if (isTree(e.mode) && dirs.has(`${full}/`)) { const id = walk(e.id, `${full}/`); if (id) out.push({ ...e, id }); continue; }
        out.push(e);
      }
      for (const full of fileSet) {
        if (dirname(full) + '/' !== (dir || './') || present.has(full)) continue;
        const next = at(full, null);
        if (next) out.push({ ...next, name: Buffer.from(full.slice(dir.length)) });
      }
      for (const sub of dirs) {
        if (!sub.startsWith(dir) || sub === dir || sub.slice(dir.length, -1).includes('/') || present.has(sub.slice(0, -1))) continue;
        const id = walk(null, sub);
        if (id) out.push({ mode: '40000', name: Buffer.from(sub.slice(dir.length, -1)), id });
      }
      let id: string | null = null;
      if (out.length || !dir) {
        const body = treeBody(out);
        id = objectId('tree', body);
        if (id !== tree) { written.tree.set(id, body); p.trees.set(id, out); }
      }
      memo.set(key, id);
      return id;
    };
    return (tree: string) => walk(tree, '')!;
  };
  const rewrite = edit((path, e) => p.held.has(path) ? base.get(path) ?? null : e && isFile(e.mode) ? { ...e, id: blobMap.get(`${path}\0${e.id}`) ?? e.id } : e, [...p.touched, ...p.held.keys()]);

  const map = new Map<string, string>();
  const verified = new Set<string>();
  const unsigned: string[] = [];
  for (const c of p.commits) {
    if (p.dropped.has(c.sha)) { map.set(c.sha, map.get(c.parents[0]!) ?? c.parents[0]!); continue; }
    const tree = rewrite(c.tree);
    const parents = c.parents.map(sha => map.get(sha) ?? sha);
    const message = p.messages.get(c.sha);
    if (tree === c.tree && parents.every((sha, i) => sha === c.parents[i]) && !message?.spans.length) { map.set(c.sha, c.sha); continue; }
    const split = c.raw.indexOf('\n\n');
    const lines = c.raw.subarray(0, split).toString('latin1').split('\n');
    const kept: string[] = [];
    let parent = 0, dropping = false;
    for (const line of lines) {
      if (line.startsWith(' ')) { if (!dropping) kept.push(line); continue; }
      dropping = /^gpgsig(?:-sha256)? /.test(line);
      if (dropping) continue;
      if (line.startsWith('tree ')) kept.push(`tree ${tree}`);
      else if (line.startsWith('parent ')) kept.push(`parent ${parents[parent++]}`);
      else kept.push(line);
    }
    if (c.signed) unsigned.push(c.sha);
    const body = Buffer.concat([Buffer.from(kept.join('\n'), 'latin1'), Buffer.from('\n\n'),
      message?.spans.length ? Buffer.from(splice(message.text, message.spans, ids), 'utf8') : c.raw.subarray(split + 2)]);
    const id = objectId('commit', body);
    written.commit.set(id, body);
    map.set(c.sha, id);
    const parentTree = c.parents.length === 1 ? (p.commits.find(x => x.sha === c.parents[0])?.tree ?? p.parentTrees.get(c.parents[0]!) ?? null) : null;
    if (c.parents.length <= 1 && !message?.spans.length && [...p.touched, ...p.held.keys()].every(path => {
      const mine = entryAt(p.trees, c.tree, path), theirs = c.parents.length ? (parentTree ? entryAt(p.trees, parentTree, path) : undefined) : null;
      return theirs !== undefined && (mine?.id ?? null) === (theirs?.id ?? null) && (mine?.mode ?? null) === (theirs?.mode ?? null);
    })) verified.add(id);
  }
  const tip = map.get(p.head)!;
  let newHead = tip, heldCommit: string | null = null;
  if (p.held.size) {
    const tipTree = rewrite(p.commits.find(c => c.sha === p.head)!.tree);
    const heldTree = edit(path => headEntries.get(path) ?? null, p.held.keys())(tipTree);
    const headRaw = p.commits.find(c => c.sha === p.head)!.raw;
    const headLines = headRaw.subarray(0, headRaw.indexOf('\n\n')).toString('latin1').split('\n');
    const people = ['author ', 'committer '].map(field => headLines.find(line => line.startsWith(field))!).join('\n');
    const list = [...p.held].map(([path, reason]) => `  ${path} (${reason})`).join('\n');
    const body = Buffer.concat([Buffer.from(`tree ${heldTree}\nparent ${tip}\n`, 'utf8'), Buffer.from(`${people}\n`, 'latin1'),
      Buffer.from(`\ngbrain: files held back from publish\n\nThese files stay on this machine; the published commits keep the remote's version:\n${list}\nSee ${DOCS}#publish_secret_held_back\n\n${HELD_TRAILER}: ${backupRef}\n`, 'utf8')]);
    heldCommit = objectId('commit', body);
    written.commit.set(heldCommit, body);
    newHead = heldCommit;
  }
  const changedMap = Object.fromEntries([...map].filter(([old, next]) => old !== next));
  if (newHead === p.head) {
    // Every value is one the owner restored: nothing to rewrite, and the scan below accepts them.
    const check = scanRange(p.root, p.base, p.head, Math.max(deadline - Date.now(), 1), undefined, { allowlist: [...p.allowlist, ...p.allowedFingerprints] });
    if (check.timed_out) throw new OverBudget();
    const refusal = rangeSecretRefusal(p.root, p.base, p.head, check);
    if (refusal) throw refusal;
    return { ...previewOf(p), redacted: true, old_head: p.head, new_head: p.head, push_target: p.head, backup_ref: '', held_commit: null, rebuilt: 0, values: 0, spooled: sealer.spooled(),
      side_refs: [], unsigned: [], map: {}, notices: [] };
  }
  run(p.root, ['update-ref', '-m', 'gbrain redact-unpushed: backup of the commits before redaction', backupRef, p.head], deadline);
  writeObjects(p, written, deadline);
  const branchRef = p.branch;
  for (const c of p.commits) {
    const next = map.get(c.sha)!;
    if (next !== c.sha && !p.dropped.has(c.sha)) recordCommit(p.root, { sha: next, writer: 'redact_rebuild', ref: branchRef, supersedes: [c.sha], ...(verified.has(next) ? { verified: true as const } : {}) });
  }
  if (heldCommit) recordCommit(p.root, { sha: heldCommit, writer: 'redact_rebuild', ref: branchRef, held: true });

  const check = scanRange(p.root, p.base, tip, Math.max(deadline - Date.now(), 1), undefined, { allowlist: [...p.allowlist, ...p.allowedFingerprints] });
  if (check.timed_out) throw new OverBudget();
  if (check.unreadable !== undefined || check.findings.length || check.unscanned.length || check.gate_changes.length) {
    const refusal = rangeSecretRefusal(p.root, p.base, tip, check);
    throw opError(refusal?.code === 'publish_scan_unreadable' ? 'publish_scan_unreadable' : 'publish_secret_found', `The redacted commits still did not scan clean, so nothing was moved or pushed: ${refusal?.message ?? 'the scan of the rebuilt range failed'}`,
      `The old commits are unchanged under ${backupRef}. Remove the values from the unpushed commits yourself, then retry. See ${DOCS}#publish_secret_found.`, { detail: refusal?.detail ?? undefined });
  }
  const allowedDiff = new Set([...p.touched, ...p.held.keys()]);
  const changed = (a: string, b: string) => run(p.root, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', a, b], deadline).stdout.toString('utf8').split('\0').filter(Boolean);
  const stray = [...changed(p.head, tip), ...changed(p.head, newHead)].filter(path => !allowedDiff.has(path));
  if (stray.length) throw new GitFailed(`the rebuilt commits differ from the old ones outside the redacted files (${stray.slice(0, 3).join(', ')})`);

  moveBranch(p, newHead, blobMap, ids, deadline);
  // The branch has moved: journal it before anything else can stop this run, so the database half always reconciles.
  const preview = previewOf(p);
  const entry = { t: new Date().toISOString(), root: p.root, top: p.top, branch: branchRef, backup_ref: backupRef, old_head: p.head, new_head: newHead, push_target: tip,
    map: changedMap, paths: [...p.touched], held: [...p.held.keys()], spooled: sealer.spooled(), rules: preview.rules, finished: false };
  const loc = ledgerLocation(p.root);
  if (loc) { mkdirSync(join(loc.common, 'gbrain'), { recursive: true }); appendFileSync(join(loc.common, 'gbrain', REDACTIONS_FILE), `${JSON.stringify(entry)}\n`); }
  const occurrences: Array<{ id: string; commit: string; path: string; line: number | null }> = [];
  for (const b of p.blobs.values()) {
    let line = 1, at = 0;
    for (const s of [...b.spans].sort((x, y) => x.start - y.start)) {
      for (let nl = b.text.indexOf('\n', at); nl !== -1 && nl < s.start; nl = b.text.indexOf('\n', nl + 1)) line++;
      at = s.start;
      occurrences.push({ id: ids.get(s.value)!, commit: map.get(b.first)!, path: b.path, line });
    }
  }
  for (const [sha, m] of p.messages) for (const s of m.spans) occurrences.push({ id: ids.get(s.value)!, commit: map.get(sha)!, path: MESSAGE_PATH, line: null });
  sealer.record(occurrences);
  const sideRefs = sideRefsHolding(p, Math.max(deadline, Date.now() + AFTER_MOVE_MS));
  const outcome: RedactOutcome = { ...preview, redacted: true, old_head: p.head, new_head: newHead, push_target: tip, backup_ref: backupRef, held_commit: heldCommit,
    rebuilt: Object.keys(changedMap).length, values: ids.size, spooled: sealer.spooled(), side_refs: sideRefs, unsigned, map: changedMap, notices: [] };
  outcome.notices = redactionNotices(outcome);
  return outcome;
}

function writeObjects(p: Plan, written: Record<'blob' | 'tree' | 'commit', Map<string, Buffer>>, deadline: number): void {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-redact-'));
  try {
    for (const type of ['blob', 'tree', 'commit'] as const) {
      const objects = [...written[type]];
      if (!objects.length) continue;
      const paths = objects.map(([id, body]) => { const file = join(dir, `${type}-${id}`); writeFileSync(file, body, { mode: 0o600 }); return file; });
      const got = run(p.root, ['hash-object', '-w', '--no-filters', '-t', type, '--stdin-paths'], deadline, { input: paths.join('\n') + '\n' }).stdout.toString('utf8').split('\n').filter(Boolean);
      if (got.join() !== objects.map(([id]) => id).join()) throw new GitFailed(`git hash-object wrote different ${type} ids than were computed`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Step 6: index under index.lock, the branch by update-ref expecting the old HEAD, then the working-tree files. */
function moveBranch(p: Plan, newHead: string, blobMap: ReadonlyMap<string, string>, ids: ReadonlyMap<string, string>, deadline: number): void {
  const headTree = p.commits.find(c => c.sha === p.head)!.tree;
  const changes: Array<{ path: string; oldId: string; newId: string; mode: string }> = [];
  for (const path of p.touched) {
    const e = entryAt(p.trees, headTree, path);
    const next = e && blobMap.get(`${path}\0${e.id}`);
    if (e && next) changes.push({ path, oldId: e.id, newId: next, mode: e.mode });
  }
  const index = gitPath(p.root, 'index'), lock = `${index}.lock`;
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o644); } catch { throw new Race(); }
  const scratch = `${index}.gbrain-redact-${process.pid}`;
  let moved = false;
  try {
    if (existsSync(index)) copyFileSync(index, scratch);
    const env = { GIT_INDEX_FILE: scratch };
    if (changes.length && existsSync(scratch)) {
      const staged = run(p.root, ['ls-files', '-s', '-z', '--', ...changes.map(c => `:(literal)${c.path}`)], deadline, { env }).stdout.toString('utf8').split('\0').filter(Boolean);
      const stage0 = new Map(staged.flatMap(line => { const m = /^(\d+) ([0-9a-f]+) 0\t(.*)$/s.exec(line); return m ? [[m[3]!, m[2]!]] : []; }));
      const info = changes.filter(c => stage0.get(c.path) === c.oldId).map(c => `${c.mode} ${c.newId}\t${c.path}\0`).join('');
      if (info) run(p.root, ['update-index', '-z', '--index-info'], deadline, { env, input: info });
    }
    if (existsSync(scratch)) writeSync(fd, readFileSync(scratch));
    closeSync(fd);
    const update = run(p.root, ['update-ref', '-m', 'gbrain redact-unpushed: secrets replaced by store markers before publish', p.branch, newHead, p.head], deadline, { allowFail: true });
    if (update.status !== 0) throw new Race();
    if (existsSync(scratch)) renameSync(lock, index); else unlinkSync(lock);
    moved = true;
  } finally {
    if (!moved) { try { closeSync(fd); } catch { /* closed */ } try { unlinkSync(lock); } catch { /* gone */ } }
    try { unlinkSync(scratch); } catch { /* none */ }
  }
  const known = [...ids].sort((a, b) => b[0].length - a[0].length);
  const blobData = new Map([...p.blobs.values()].map(b => [b.blob, b.data]));
  const written = new Map(changes.map(c => [c.path, Buffer.from(splice(p.blobs.get(`${c.path}\0${c.oldId}`)!.text, p.blobs.get(`${c.path}\0${c.oldId}`)!.spans, ids), 'utf8')]));
  for (const c of changes) {
    const file = join(p.top, c.path);
    let mode: number;
    try { const st = lstatSync(file); if (!st.isFile()) continue; mode = st.mode & 0o7777; } catch { continue; }
    const bytes = readFileSync(file);
    let next: Buffer | null = null;
    if (bytes.equals(blobData.get(c.oldId)!)) next = written.get(c.path)!;
    else {
      const local = utf8(bytes);
      if (local === null) continue;
      const redacted = known.reduce((out, [value, id]) => out.split(value).join(markerOf(p.values.get(value)!, id)), local);
      if (redacted !== local) next = Buffer.from(redacted, 'utf8');
    }
    if (!next) continue;
    const tmp = `${file}.gbrain-redact-${process.pid}`;
    writeFileSync(tmp, next, { mode });
    renameSync(tmp, file);
  }
  run(p.root, ['update-index', '-q', '--refresh'], Math.max(deadline, Date.now() + AFTER_MOVE_MS), { allowFail: true });
}

/** Local branches, tags and other worktrees that still reach a commit that held a value (D2b): named, never moved. */
function sideRefsHolding(p: Plan, deadline: number): string[] {
  const carriers = [...new Set(p.scan.findings.map(f => f.commit))];
  if (!carriers.length) return [];
  const refs = run(p.root, ['for-each-ref', '--format', '%(refname)', ...carriers.flatMap(sha => ['--contains', sha]), 'refs/heads', 'refs/tags', 'refs/stash', 'refs/gbrain/quarantine'], deadline, { allowFail: true })
    .stdout.toString('utf8').split('\n').filter(ref => ref && ref !== p.branch);
  const worktrees = run(p.root, ['worktree', 'list', '--porcelain'], deadline, { allowFail: true }).stdout.toString('utf8').split('\n\n').flatMap(block => {
    const path = /^worktree (.+)$/m.exec(block)?.[1], head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1], detached = /^detached$/m.test(block);
    if (!path || !head || !detached || resolve(path) === resolve(p.top)) return [];
    return carriers.some(sha => run(p.root, ['merge-base', '--is-ancestor', sha, head], deadline, { allowFail: true }).status === 0) ? [`worktree ${path} (detached at ${head.slice(0, 12)})`] : [];
  });
  return [...refs, ...worktrees];
}

function redactionNotices(o: RedactOutcome): Notice[] {
  const notices: Notice[] = [];
  const readOnly = (argv: string[], why: string, docs: string): Action => ({ argv, consent: [], actor: 'agent', requires_exclusive: false, why, docs });
  if (o.values) notices.push({ code: 'publish_secret_redacted', kind: 'info', why: `${o.values} value(s) that look like secrets in ${o.paths.length} file(s)${o.messages.length ? ` and ${o.messages.length} commit message(s)` : ''} of ${o.rebuilt} unpushed commit(s) were replaced by secret store markers before the push (${Object.entries(o.rules).map(([rule, c]) => `${rule}: ${c.hits} hit(s) of ${c.values} value(s), ${c.signed_link} in a signed-link credential parameter (X-Amz-Credential=), ${c.bare} bare`).join('; ')}). The originals are in the secret store; ${o.backup_ref} keeps the old commits on this machine for ${BACKUP_KEEP_DAYS} days. A real credential still needs rotating by its owner.`,
    fix: readOnly(['gbrain', 'secrets', 'list', '--json'], 'Lists the store entries and where their markers are, never a value.', `${DOCS}#publish_secret_redacted`) });
  if (o.held.length) notices.push({ code: 'publish_secret_held_back', kind: 'degraded', why: `${o.held.length} file(s) were held back from the push and stay only on this machine: ${o.held.map(h => `${h.path} (${h.reason})`).join(', ')}. The pushed commits keep the remote's version of them; local commit ${o.held_commit?.slice(0, 12)} on top of the branch keeps yours.`,
    user_message: `Some files were not pushed because the secret scan cannot vouch for them (${o.held.map(h => h.path).slice(0, 3).join(', ')}). Review them and push them yourself if they are safe?`,
    fix: { ask_user: true, argv: ['git', '-C', o.root, 'show', '--stat', o.held_commit ?? 'HEAD'], consent: [], actor: 'user', requires_exclusive: false, why: 'Read-only: shows what the held commit keeps back.', docs: `${DOCS}#publish_secret_held_back` } });
  if (o.side_refs.length) notices.push({ code: 'publish_secret_side_refs', kind: 'safety', why: `${o.side_refs.length} other local ref(s) still hold the old commits with the original values (gbrain never moves them): ${o.side_refs.slice(0, 10).join(', ')}. Pushing one of them by hand would publish the values.`,
    user_message: `Other local branches, tags or worktrees still hold the unredacted commits (${o.side_refs.slice(0, 3).join(', ')}). Delete or rebuild them?`,
    fix: { ask_user: true, argv: ['git', '-C', o.root, 'for-each-ref', '--contains', o.old_head], consent: [], actor: 'user', requires_exclusive: false, why: 'Read-only: lists the refs that still reach the old commits.', docs: `${DOCS}#publish_secret_side_refs` } });
  if (o.unsigned.length) notices.push({ code: 'publish_secret_unsigned', kind: 'info', why: `${o.unsigned.length} signed commit(s) were rebuilt without their signature (a rebuilt commit cannot keep one): ${o.unsigned.map(sha => sha.slice(0, 12)).join(', ')}.`,
    fix: readOnly(['git', '-C', o.root, 'log', '--show-signature', '-n', String(Math.min(o.commits, 20))], 'Read-only: shows which published commits are signed.', `${DOCS}#publish_secret_unsigned`) });
  if (o.spooled) notices.push({ code: 'secret_store_spooled', kind: 'info', why: `${o.spooled} original(s) were sealed in this machine's encrypted spool (a publish runs without the database, so it always seals there first). They move into the secret store at the next push a brain owner makes (a page write's Git effect) or at the next maintenance pass (bookkeeping_gc); gbrain git redact-unpushed --apply moves them right away. gbrain git commit-push does not move them itself, so on a host where no owner push and no maintenance run, they stay in the spool; gbrain secrets reveal reads them there meanwhile.`,
    fix: readOnly(['gbrain', 'secrets', 'list', '--json'], 'Read-only: the store entries and how many originals still wait in the spool (spooled).', 'docs/guides/secret-store.md#secret_store_spooled') });
  return notices;
}
