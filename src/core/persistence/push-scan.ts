/**
 * Wave C 1A (spec §4.5, review d4): the secret scan at the door and the pre-push backstop.
 *
 * Door scan. A strict source's door (git-door.ts) and `gbrain git commit-push` (commit-push.ts) scan each covered file
 * before its commit: a split part (`.<name>.gbparts/`) or a file over PAGE_MAX_BYTES (24 MiB). Only bytes new to Git are
 * scanned (§17 ceo-r3-native-1): a file whose path HEAD already holds is compared with that blob, and only the changed
 * range plus SCAN_SEAM_BYTES on each side, widened to whole lines, goes through the windowed scanner; the seam between two
 * consecutive parts of a split page is scanned too, for a value cut across them. The pass that scans
 * also hashes every byte, and the caller compares that blob id with the one Git stores: a clean filter that transforms the
 * bytes, or a file that changed after the scan, refuses (§17 eng-r3-outside-6), so the scanned bytes are the committed blob.
 *
 * Backstop. Before the Git effect or commit-push pushes, every covered blob the unpushed range adds (what the remote's
 * tracking refs do not reach, never only the tip) is scanned whole, unless the ledger already cleared it. A hit holds the
 * push `git_push_secret_found`: the commit may be the user's own, and gbrain rewrites no history.
 *
 * Both read `<root>/.gbrain-scan-allow` (fingerprint lines; path globs are honored too) and record each blob they clear in
 * the ledger `<git common dir>/gbrain-scan-cleared` under SCAN_RULESET_ID (§17 eng-r3-native-5), so the backstop scans only
 * blobs nothing cleared and a rule change scans again. The matched text is never printed or stored.
 *
 * Blobs are read from a spool file under the git common dir (a sync `cat-file` into a file descriptor, never a pipe the
 * runtime can lose), and each scan is a generator of steps: commit-push runs it straight through, the door and the effect
 * yield to the event loop between chunks.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from '../spawn.ts';
import { gitChildEnv, GIT_READ_ENV } from '../git-env.ts';
import { createStreamScanner } from '../secret-scan-stream.ts';
import { loadWorkspaceAllowlist, pathAllowlisted, SCAN_ALLOW_FILENAME, SCAN_RULESET_ID, type SecretFinding } from '../secret-scan.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { OperationError, opError } from '../ops/contract.ts';

/** Bytes each side of a changed range that are scanned again: over the longest claim (a private key, about 18 Ki characters). */
export const SCAN_SEAM_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const LEDGER_NAME = 'gbrain-scan-cleared';
const LEDGER_MAX_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 600_000;
const EMPTY = Buffer.alloc(0);

/** A part file of a split page (PR 5's layout: `<dir>/.<name>.gbparts/<part>`). */
export function isSplitPartPath(rel: string): boolean {
  return /(^|\/)\.[^/]+\.gbparts\//.test(rel);
}

/** The parts directory a split head at `rel` would have (`dir/name.md` -> `dir/.name.gbparts`), or null for a non-page path. */
export function partsDirOf(rel: string): string | null {
  const slash = rel.lastIndexOf('/');
  const name = rel.slice(slash + 1);
  return name.endsWith('.md') && name.length > 3 ? `${rel.slice(0, slash + 1)}.${name.slice(0, -3)}.gbparts` : null;
}

/** Whether a file the door or a push carries is scanned: a split head or part, or a file over PAGE_MAX_BYTES. */
export function coveredFile(rel: string, bytes: number, splitHead = false): boolean {
  return bytes > PAGE_MAX_BYTES || isSplitPartPath(rel) || splitHead;
}

/** A page file whose parts directory sits beside it in the working tree. */
export function splitHeadOnDisk(root: string, rel: string): boolean {
  const dir = partsDirOf(rel);
  return dir !== null && existsSync(join(root, dir));
}

/** Test seam: runs once a door or commit-push scan cleared its files, before Git hashes them. */
export const scanSeams: { afterDoorScan?: (root: string) => void } = {};

export interface ScanHit { path: string; line: number; rule: string; fingerprint: string; commit?: string }

const env = () => gitChildEnv({ ...GIT_READ_ENV, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_NO_LAZY_FETCH: '1' });

function git(root: string, args: string[], input = ''): { code: number; stdout: string } {
  const r = spawnSync('git', ['-C', root, ...args], { env: env(), input, maxBuffer: 1024 ** 3, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  return { code: typeof r.status === 'number' ? r.status : -1, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
}

const unscannable = (what: string) => opError('git_unavailable', `The secret scan could not read ${what}, so nothing was committed or pushed.`,
  'Git could not list or read the objects the scan needs. Check the checkout with git status and git fsck on the brain host, then retry.');

function commonDir(root: string): string {
  const r = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code !== 0) throw unscannable(`the Git directory of ${root}`);
  return r.stdout.trim();
}

/** Blob ids the door or an earlier backstop cleared under the current rule set. */
export function readCleared(gitDir: string): Set<string> {
  const path = join(gitDir, LEDGER_NAME);
  const cleared = new Set<string>();
  if (!existsSync(path)) return cleared;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const [ruleset, oid] = line.split(' ');
    if (ruleset === SCAN_RULESET_ID && oid) cleared.add(oid);
  }
  return cleared;
}

function recordCleared(gitDir: string, oids: Iterable<string>): void {
  const lines = [...new Set(oids)].map(oid => `${SCAN_RULESET_ID} ${oid}\n`).join('');
  if (!lines) return;
  const path = join(gitDir, LEDGER_NAME);
  try {
    if (existsSync(path) && statSync(path).size > LEDGER_MAX_BYTES) {
      const kept = readFileSync(path, 'utf8').split('\n').filter(line => line.startsWith(`${SCAN_RULESET_ID} `));
      writeFileSync(path, kept.slice(Math.floor(kept.length / 2)).map(line => `${line}\n`).join(''));
    }
    appendFileSync(path, lines);
  } catch { /* the ledger is a cache: a lost entry only means the blob is scanned again */ }
}

/** Writes blob `oid` to a spool file under the git common dir and returns its path; the caller removes it. */
function spoolBlob(root: string, gitDir: string, oid: string, size: number): string {
  const dir = join(gitDir, 'gbrain-scan');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${process.pid}-${oid}`);
  const fd = openSync(path, 'w', 0o600);
  let status: number | null;
  try { status = spawnSync('git', ['-C', root, 'cat-file', 'blob', oid], { env: env(), stdio: ['ignore', fd, 'ignore'], timeout: GIT_TIMEOUT_MS }).status; }
  finally { closeSync(fd); }
  if (status !== 0 || statSync(path).size !== size) { rmSync(path, { force: true }); throw unscannable(`blob ${oid.slice(0, 12)}`); }
  return path;
}

function reader(fd: number, size: number): (pos: number, len: number) => Buffer {
  return (pos, len) => {
    const n = Math.min(len, size - pos);
    if (pos < 0 || n <= 0) return EMPTY;
    const buf = Buffer.allocUnsafe(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, pos));
  };
}

/**
 * The bytes of a new version that its prior version (`base`) does not hold: the longest common prefix and, aligned at
 * the end, the longest common suffix are excluded. Fed the base in order; the new version is read at two offsets.
 */
class ChangedRange {
  private offset = 0;
  private prefix = -1;
  private lastMismatch = -1;
  constructor(private readonly size: number, private readonly baseSize: number, private readonly readAt: (pos: number, len: number) => Buffer) {}

  feed(old: Buffer): void {
    const delta = this.size - this.baseSize;
    if (this.prefix < 0) {
      const cur = this.readAt(this.offset, old.length);
      if (!(cur.length === old.length && cur.equals(old))) {
        let i = 0;
        while (i < cur.length && cur[i] === old[i]) i++;
        this.prefix = this.offset + i;
      }
    }
    const from = Math.min(old.length, Math.max(0, -(this.offset + delta)));
    if (from > 0) this.lastMismatch = this.offset + from - 1;
    if (from < old.length) {
      const cur = this.readAt(this.offset + delta + from, old.length - from);
      const tail = old.subarray(from);
      if (!(cur.length === tail.length && cur.equals(tail))) {
        for (let i = old.length - 1; i >= from; i--) if (cur[i - from] !== old[i]) { this.lastMismatch = this.offset + i; break; }
      }
    }
    this.offset += old.length;
  }

  range(): { lo: number; hi: number } {
    const lo = this.prefix < 0 ? Math.min(this.size, this.baseSize) : this.prefix;
    return { lo, hi: Math.min(this.size, Math.max(lo, this.lastMismatch + 1 + this.size - this.baseSize)) };
  }
}

/** [lo, hi) widened by SCAN_SEAM_BYTES on each side, then out to whole lines when a line break is within another seam. */
function scanWindow(lo: number, hi: number, size: number, readAt: (pos: number, len: number) => Buffer): { start: number; end: number } {
  let start = Math.max(0, lo - SCAN_SEAM_BYTES);
  let end = Math.min(size, hi + SCAN_SEAM_BYTES);
  if (start > 0) {
    const from = Math.max(0, start - SCAN_SEAM_BYTES);
    const back = readAt(from, start - from);
    const nl = back.lastIndexOf(10);
    start = nl >= 0 ? from + nl + 1 : from === 0 ? 0 : start;
  }
  if (end < size) {
    const fwd = readAt(end, SCAN_SEAM_BYTES);
    const nl = fwd.indexOf(10);
    end = nl >= 0 ? end + nl + 1 : end + fwd.length >= size ? size : end;
  }
  return { start, end };
}

function newlines(bytes: Buffer): number {
  let n = 0;
  for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) n++;
  return n;
}

/** Scans what the file at `fd` adds over `base` (a spooled blob) and hashes all of it as a Git blob. */
function* scanFileSteps(fd: number, size: number, base: { path: string; size: number } | null, algorithm: 'sha1' | 'sha256', allowlist: string[]): Generator<void, { oid: string; findings: SecretFinding[]; suppressed: number }> {
  const readAt = reader(fd, size);
  let lo = 0;
  let hi = size;
  if (base) {
    const changed = new ChangedRange(size, base.size, readAt);
    const bfd = openSync(base.path, 'r');
    try {
      const read = reader(bfd, base.size);
      for (let pos = 0; pos < base.size;) {
        const old = read(pos, CHUNK_BYTES);
        if (!old.length) break;
        changed.feed(old);
        pos += old.length;
        yield;
      }
    } finally { closeSync(bfd); }
    ({ lo, hi } = changed.range());
  }
  const { start, end } = scanWindow(lo, hi, size, readAt);
  const hash = createHash(algorithm).update(`blob ${size}\0`);
  const scanner = createStreamScanner({ allowlist });
  let before = 0;
  let pos = 0;
  while (pos < size) {
    const chunk = readAt(pos, CHUNK_BYTES);
    if (!chunk.length) break;
    hash.update(chunk);
    if (pos < start) before += newlines(chunk.subarray(0, Math.min(chunk.length, start - pos)));
    const a = Math.max(start, pos);
    const b = Math.min(end, pos + chunk.length);
    if (a < b) scanner.push(chunk.subarray(a - pos, b - pos));
    pos += chunk.length;
    yield;
  }
  if (pos !== size) throw opError('git_unavailable', 'A file changed while it was being scanned, so nothing was committed.', 'Another process is writing the file; retry once it is done.');
  const findings = scanner.finish().map(finding => ({ ...finding, line: finding.line + before }));
  return { oid: hash.digest('hex'), findings, suppressed: scanner.suppressed };
}

function* scanBlobSteps(path: string, size: number, allowlist: string[]): Generator<void, { findings: SecretFinding[]; suppressed: number }> {
  const scanner = createStreamScanner({ allowlist });
  const fd = openSync(path, 'r');
  try {
    const read = reader(fd, size);
    for (let pos = 0; pos < size;) {
      const chunk = read(pos, CHUNK_BYTES);
      if (!chunk.length) break;
      scanner.push(chunk);
      pos += chunk.length;
      yield;
    }
  } finally { closeSync(fd); }
  const findings = scanner.finish();
  return { findings, suppressed: scanner.suppressed };
}

function runSync<T>(steps: Generator<void, T>): T {
  for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
}

async function runAsync<T>(steps: Generator<void, T>): Promise<T> {
  for (let step = steps.next(), n = 1; ; step = steps.next(), n++) {
    if (step.done) return step.value;
    if (n % 4 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** HEAD's blob at `repoPath` (from the repository top), or null. */
function headBlob(root: string, repoPath: string): { oid: string; size: number } | null {
  const listed = git(root, ['ls-tree', '-z', '-l', '--full-tree', 'HEAD', '--', repoPath]).stdout.split('\0')[0] ?? '';
  const [mode, type, oid, size] = listed.slice(0, listed.indexOf('\t')).trim().split(/\s+/);
  return mode && type === 'blob' && oid && Number.isFinite(Number(size)) ? { oid, size: Number(size) } : null;
}

/** The head and tail SCAN_SEAM_BYTES of a file, and its line breaks before the tail (a seam finding's line in that file). */
function fileEdges(abs: string): { head: Buffer; tail: Buffer; linesBeforeTail: number } {
  const fd = openSync(abs, 'r');
  try {
    const size = statSync(abs).size;
    const read = reader(fd, size);
    const tailStart = Math.max(0, size - SCAN_SEAM_BYTES);
    let linesBeforeTail = 0;
    for (let pos = 0; pos < tailStart; pos += CHUNK_BYTES) linesBeforeTail += newlines(read(pos, Math.min(CHUNK_BYTES, tailStart - pos)));
    return { head: read(0, SCAN_SEAM_BYTES), tail: read(tailStart, SCAN_SEAM_BYTES), linesBeforeTail };
  } finally { closeSync(fd); }
}

function blobEdges(root: string, gitDir: string, oid: string, size: number): ReturnType<typeof fileEdges> {
  const spooled = spoolBlob(root, gitDir, oid, size);
  try { return fileEdges(spooled); } finally { rmSync(spooled, { force: true }); }
}

function memo<T>(make: () => T): () => T {
  let value: { v: T } | null = null;
  return () => (value ??= { v: make() }).v;
}

interface SeamPart { path: string; oid: string; edges: () => ReturnType<typeof fileEdges> }

const seamKey = (left: SeamPart, right: SeamPart) => `seam:${left.oid}:${right.oid}`;

function scanBytes(bytes: Buffer, allowlist: string[]): { findings: SecretFinding[]; suppressed: number } {
  const scanner = createStreamScanner({ allowlist });
  scanner.push(bytes);
  const findings = scanner.finish();
  return { findings, suppressed: scanner.suppressed };
}

/**
 * A value cut across two consecutive parts of a split page (`NNNN-<hash>.gbpart`, in name order): the last
 * SCAN_SEAM_BYTES of one part and the first of the next are scanned together. Only a finding neither side holds alone is the
 * seam's (each side's own bytes are its part scan's). A pair that scans clean with nothing suppressed is recorded in the
 * ledger by both blob ids, so it is not scanned again.
 */
function checkSeams(pairs: Array<{ left: SeamPart; right: SeamPart; commit?: string }>, allowlist: string[], cleared: Set<string>): { hits: ScanHit[]; clean: string[] } {
  const hits: ScanHit[] = [];
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const { left, right, commit } of pairs) {
    const key = seamKey(left, right);
    if (cleared.has(key) || seen.has(key)) continue;
    seen.add(key);
    const [l, r] = [left.edges(), right.edges()];
    const [tail, head, both] = [scanBytes(l.tail, allowlist), scanBytes(r.head, allowlist), scanBytes(Buffer.concat([l.tail, r.head]), allowlist)];
    const own = new Set([...tail.findings, ...head.findings].map(finding => finding.fingerprint));
    const found = both.findings.filter(finding => !own.has(finding.fingerprint));
    if (pathAllowlisted(left.path, allowlist)) continue;
    if (!found.length && both.suppressed <= tail.suppressed + head.suppressed) { clean.push(key); continue; }
    for (const finding of found) hits.push({ path: left.path, line: l.linesBeforeTail + finding.line, rule: finding.pattern, fingerprint: finding.fingerprint, commit });
  }
  return { hits, clean };
}

/** Parts of a split head's directory in a tree (`ls-tree -l` of `<commit>:<dir>`), sorted by name. */
function treeParts(root: string, commit: string, repoDir: string): Array<{ name: string; oid: string; size: number }> {
  return git(root, ['ls-tree', '-z', '-l', '--full-tree', commit, '--', repoDir]).stdout.split('\0').filter(Boolean).flatMap(line => {
    const [, type, oid, size] = line.slice(0, line.indexOf('\t')).trim().split(/\s+/);
    const name = line.slice(line.lastIndexOf('/') + 1);
    return type === 'blob' && oid && name.endsWith('.gbpart') ? [{ name, oid, size: Number(size) }] : [];
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * The seams a door or commit-push write touches, in the tree it commits: each written part with its neighbours, a
 * neighbour the write does not carry read from HEAD (the committed blob, never a dirty working-tree file).
 */
function doorSeamPairs(root: string, gitDir: string, parts: Array<ScanFile & { oid: string }>): Array<{ left: SeamPart; right: SeamPart }> {
  const pairs: Array<{ left: SeamPart; right: SeamPart }> = [];
  const byDir = new Map<string, Array<ScanFile & { oid: string }>>();
  for (const part of parts) {
    const dir = part.rel.slice(0, part.rel.lastIndexOf('/') + 1);
    byDir.set(dir, [...(byDir.get(dir) ?? []), part]);
  }
  for (const [dir, written] of byDir) {
    const first = written[0]!;
    const repoDir = first.repoPath.slice(0, first.repoPath.length - first.rel.length) + dir;
    const byName = new Map<string, SeamPart>(written.map(part => [part.rel.slice(dir.length), { path: part.rel, oid: part.oid, edges: memo(() => fileEdges(part.abs)) }]));
    const ours = new Set(byName.keys());
    for (const entry of treeParts(root, 'HEAD', repoDir)) {
      if (byName.has(entry.name) || !existsSync(join(root, dir, entry.name))) continue;
      byName.set(entry.name, { path: dir + entry.name, oid: entry.oid, edges: memo(() => blobEdges(root, gitDir, entry.oid, entry.size)) });
    }
    const names = [...byName.keys()].sort();
    for (let i = 1; i < names.length; i++) {
      if (ours.has(names[i - 1]!) || ours.has(names[i]!)) pairs.push({ left: byName.get(names[i - 1]!)!, right: byName.get(names[i]!)! });
    }
  }
  return pairs;
}

export interface ScanFile {
  /** Path relative to `root`, as reported. */
  rel: string;
  abs: string;
  /** Path from the repository top, for HEAD's prior version. */
  repoPath: string;
}

function* doorSteps(root: string, files: ScanFile[], algorithm: 'sha1' | 'sha256', local: boolean): Generator<void, Map<string, string>> {
  const scanned = new Map<string, string>();
  const covered = files.flatMap(file => {
    try { const stat = statSync(file.abs); return stat.isFile() && coveredFile(file.rel, stat.size, splitHeadOnDisk(root, file.rel)) ? [{ ...file, size: stat.size }] : []; }
    catch { return []; }
  });
  if (!covered.length) return scanned;
  const gitDir = commonDir(root);
  const allowlist = loadWorkspaceAllowlist(root);
  const hits: ScanHit[] = [];
  const clean: string[] = [];
  for (const file of covered) {
    const base = headBlob(root, file.repoPath);
    const spooled = base ? spoolBlob(root, gitDir, base.oid, base.size) : null;
    const fd = openSync(file.abs, 'r');
    try {
      const result = yield* scanFileSteps(fd, file.size, spooled ? { path: spooled, size: base!.size } : null, algorithm, allowlist);
      const allowed = pathAllowlisted(file.rel, allowlist);
      if (!allowed) for (const finding of result.findings) hits.push({ path: file.rel, line: finding.line, rule: finding.pattern, fingerprint: finding.fingerprint });
      if (!allowed && !result.findings.length && !result.suppressed) clean.push(result.oid);
      scanned.set(file.rel, result.oid);
    } finally {
      closeSync(fd);
      if (spooled) rmSync(spooled, { force: true });
    }
    yield;
  }
  const parts = covered.filter(file => isSplitPartPath(file.rel)).map(file => ({ ...file, oid: scanned.get(file.rel)! }));
  const seams = parts.length ? checkSeams(doorSeamPairs(root, gitDir, parts), allowlist, readCleared(gitDir)) : { hits: [], clean: [] };
  hits.push(...seams.hits);
  if (hits.length) throw secretFound(hits, local);
  recordCleared(gitDir, [...clean, ...seams.clean]);
  scanSeams.afterDoorScan?.(root);
  return scanned;
}

/**
 * The door's scan of a strict publication's files, before its commit: the Git blob id of each covered file's bytes as
 * scanned, keyed by `rel`. A finding refuses `secret_found` naming the rule and fingerprint only (the caller may be remote).
 */
export function scanDoorFiles(root: string, files: ScanFile[], algorithm: 'sha1' | 'sha256'): Promise<Map<string, string>> {
  return runAsync(doorSteps(root, files, algorithm, false));
}

/** The same scan for `gbrain git commit-push` (a trusted local caller: the refusal names the path and line too). */
export function scanCommitFilesSync(root: string, files: ScanFile[], algorithm: 'sha1' | 'sha256'): Map<string, string> {
  return runSync(doorSteps(root, files, algorithm, true));
}

function* backstopSteps(root: string, tip: string, remote: string): Generator<void, void> {
  const listed = git(root, ['rev-list', '--objects', tip, '--not', `--remotes=${remote}`, '--']);
  if (listed.code !== 0) throw unscannable(`the commits ${tip.slice(0, 12)} adds over ${remote}`);
  const named = listed.stdout.split('\n').filter(line => /^[0-9a-f]+ ./.test(line));
  if (!named.length) return;
  const info = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize) %(rest)'], `${named.join('\n')}\n`);
  if (info.code !== 0) throw unscannable(`the objects ${tip.slice(0, 12)} adds over ${remote}`);
  const blobs = info.stdout.split('\n').flatMap(line => {
    const match = /^([0-9a-f]+) blob (\d+) (.+)$/.exec(line);
    return match ? [{ oid: match[1]!, size: Number(match[2]), path: match[3]! }] : [];
  });
  const headsMaybe = blobs.some(blob => blob.size <= PAGE_MAX_BYTES && partsDirOf(blob.path) !== null);
  const partsDirs = headsMaybe ? new Set(git(root, ['ls-tree', '-r', '-d', '-z', '--name-only', '--full-tree', tip]).stdout.split('\0').filter(dir => /(^|\/)\.[^/]+\.gbparts$/.test(dir))) : new Set<string>();
  const candidates = blobs.filter(blob => coveredFile(blob.path, blob.size, partsDirs.has(partsDirOf(blob.path) ?? '')));
  if (!candidates.length) return;
  const gitDir = commonDir(root);
  const cleared = readCleared(gitDir);
  const allowlist = loadWorkspaceAllowlist(root);
  const clean: string[] = [];
  const hits: ScanHit[] = [];
  const range = (oid: string) => git(root, ['log', '-1', '--format=%H', `--find-object=${oid}`, tip, '--not', `--remotes=${remote}`, '--']).stdout.trim() || undefined;
  for (const blob of candidates) {
    if (cleared.has(blob.oid) || pathAllowlisted(blob.path, allowlist)) continue;
    const spooled = spoolBlob(root, gitDir, blob.oid, blob.size);
    let scan: { findings: SecretFinding[]; suppressed: number };
    try { scan = yield* scanBlobSteps(spooled, blob.size, allowlist); }
    finally { rmSync(spooled, { force: true }); }
    if (!scan.findings.length) { if (!scan.suppressed) clean.push(blob.oid); continue; }
    const commit = range(blob.oid);
    for (const finding of scan.findings) hits.push({ path: blob.path, line: finding.line, rule: finding.pattern, fingerprint: finding.fingerprint, commit });
  }
  const seams = checkSeams(rangeSeamPairs(root, gitDir, tip, remote, candidates.filter(blob => isSplitPartPath(blob.path))), allowlist, cleared);
  hits.push(...seams.hits);
  recordCleared(gitDir, [...clean, ...seams.clean]);
  if (hits.length) throw pushSecretHold(hits, root);
}

/**
 * The seams of every unpushed commit whose parts directory holds a part the range adds: adjacent parts in that commit's
 * tree where either is one of those blobs (read from Git, never the working tree).
 */
function rangeSeamPairs(root: string, gitDir: string, tip: string, remote: string, added: Array<{ oid: string; path: string }>): Array<{ left: SeamPart; right: SeamPart; commit: string }> {
  if (!added.length) return [];
  const addedOids = new Set(added.map(blob => blob.oid));
  const dirs = [...new Set(added.map(blob => blob.path.slice(0, blob.path.lastIndexOf('/') + 1)))];
  const commits = git(root, ['rev-list', tip, '--not', `--remotes=${remote}`, '--', ...dirs]);
  if (commits.code !== 0) throw unscannable(`the commits ${tip.slice(0, 12)} adds over ${remote}`);
  const parts = new Map<string, SeamPart>();
  const part = (dir: string, entry: { name: string; oid: string; size: number }) => {
    if (!parts.has(entry.oid)) parts.set(entry.oid, { path: dir + entry.name, oid: entry.oid, edges: memo(() => blobEdges(root, gitDir, entry.oid, entry.size)) });
    return parts.get(entry.oid)!;
  };
  const pairs: Array<{ left: SeamPart; right: SeamPart; commit: string }> = [];
  for (const commit of commits.stdout.split('\n').filter(Boolean)) {
    for (const dir of dirs) {
      const entries = treeParts(root, commit, dir);
      for (let i = 1; i < entries.length; i++) {
        const [l, r] = [entries[i - 1]!, entries[i]!];
        if (addedOids.has(l.oid) || addedOids.has(r.oid)) pairs.push({ left: part(dir, l), right: part(dir, r), commit });
      }
    }
  }
  return pairs;
}

/** The pre-push backstop of the Git effect: scans the covered blobs `tip` adds over `remote`'s tracking refs. */
export function backstopScan(root: string, tip: string, remote: string): Promise<void> {
  return runAsync(backstopSteps(root, tip, remote));
}

/** The same backstop for `gbrain git commit-push`. */
export function backstopScanSync(root: string, tip: string, remote: string): void {
  runSync(backstopSteps(root, tip, remote));
}

/**
 * §17 eng-r3-outside-6: a covered file whose clean filter (a .gitattributes filter, text or eol rule) changes its bytes on the
 * way into Git, so the blob Git stores would not be the bytes the scan read.
 */
export function cleanFilterRefused(rel: string): OperationError {
  return opError('git_clean_filter_refused', `A clean filter changes ${rel} on its way into Git, so the bytes the secret scan read would not be the committed blob; nothing was committed.`,
    `A split part or a file over 24 MiB is committed byte for byte, never through a .gitattributes filter, text or eol rule. Ask the user before adding the override line "${rel} -filter -text" to .gitattributes at the checkout root and committing it with gbrain git commit-push; then write again.`,
    { detail: rel, fix: { ask_user: true, actor: 'user', consent: [], requires_exclusive: false,
      why: 'Exempting a path from a filter changes how Git stores that file from now on, and the user owns .gitattributes.',
      user_message: `A large page file (${rel}) is matched by a Git filter or line-ending rule in .gitattributes, so gbrain refused to commit it: it commits exactly the bytes it scanned for secrets. Add the line "${rel} -filter -text" to .gitattributes, commit it with gbrain git commit-push, and write again?` } });
}

const more = (hits: ScanHit[]) => hits.length > 1 ? ` (and ${hits.length - 1} more)` : '';

/**
 * The door's refusal. `local` (a trusted CLI caller) adds the path and line; a remote caller gets the rule and the
 * fingerprint only (§17 dx-r3-native-2).
 */
export function secretFound(hits: ScanHit[], local: boolean): OperationError {
  const first = hits[0]!;
  const where = local ? ` in ${first.path} line ${first.line}` : '';
  return opError('secret_found', `A credential-shaped value (rule ${first.rule}, fingerprint ${first.fingerprint})${where}${more(hits)} is in the bytes this write adds, so nothing was committed.`,
    `Git keeps every commit and gbrain rewrites no history, so a secret is refused before its commit. Remove it from the input and write again. If it is not a secret, or it was rotated and may stay, add its fingerprint line to ${SCAN_ALLOW_FILENAME} at the root of the source's checkout and commit that file with gbrain git commit-push (ask the user first). The matched text is never printed.`,
    { detail: JSON.stringify({ findings: hits.slice(0, 20).map(hit => local ? hit : { rule: hit.rule, fingerprint: hit.fingerprint }) }), fix: {
      ask_user: true, actor: 'user', consent: [], requires_exclusive: false,
      why: 'A committed credential stays in Git history, which gbrain never rewrites; only the user can say whether the value may stay.',
      user_message: `A write was refused because it holds a credential-shaped value (rule ${first.rule}, fingerprint ${first.fingerprint}). Remove it and write again; or, if it is not a secret or you rotated it, add the line ${first.fingerprint} to ${SCAN_ALLOW_FILENAME} at the root of the source's checkout, commit that file with gbrain git commit-push, and write again.`,
      verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] } } });
}

/** The hold of a push whose unpushed range adds a covered blob with a finding (§17 default 3: rotate and allowlist). */
export function pushSecretHold(hits: ScanHit[], root: string): OperationError {
  const first = hits[0]!;
  const commit = first.commit ? `Commit ${first.commit.slice(0, 12)}` : 'An unpushed commit';
  const allowFile = join(root, SCAN_ALLOW_FILENAME);
  return opError('git_push_secret_found', `${commit} adds ${first.path} with a credential-shaped value (rule ${first.rule}, line ${first.line}, fingerprint ${first.fingerprint})${more(hits)}, so nothing from this checkout is pushed while it stands.`,
    `A commit gbrain did not scan (a git commit made outside gbrain, or a pull) carries it. gbrain rewrites no history and never pushes the range while this holds; nothing is lost. Ask the user to rotate the credential, add ${first.fingerprint} on its own line to ${allowFile} and commit it with gbrain git commit-push, then retry the parked pushes.`,
    { detail: JSON.stringify({ commit: first.commit ?? null, path: first.path, line: first.line, rule: first.rule, fingerprint: first.fingerprint, findings: hits.length }), fix: {
      ask_user: true, actor: 'user', consent: [], requires_exclusive: false,
      argv: ['gbrain', 'git', 'commit-push', '--path', root, '-m', 'gbrain: allow a rotated credential fingerprint', '--', SCAN_ALLOW_FILENAME],
      why: 'The commit and its credential belong to the user: only they can rotate it and decide it may stay in history, and gbrain never rewrites history.',
      user_message: `${commit} in ${root} adds ${first.path} with a credential-shaped value (rule ${first.rule}, fingerprint ${first.fingerprint}), so Git backups from that checkout are held (nothing is lost). Please rotate that credential, then add the line ${first.fingerprint} to ${allowFile}; the command shown commits it. Afterwards run gbrain sources writer retry-effects <source> --parked-pushes.`,
      verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] } } });
}
