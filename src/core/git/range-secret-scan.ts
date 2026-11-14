/**
 * Secret scan over the commits an automatic publish pushes. A commit gbrain did not write (a script's plain
 * `git commit`) never passed the write path's scan, so the publish scans, under its publish lock and for the exact
 * commit it pushes, what each commit in `base..head` adds: its message, the lines it adds file by file (a value a later
 * commit removed is still in the pushed history), and for a merge commit the lines it adds that no parent has
 * (a conflict resolution). The workspace allowlist (`.gbrain-scan-allow` at the scanned root, below the repository's top
 * level for a managed root in a subfolder: path globs relative to that root, and fingerprints) applies.
 * Findings carry the path, line, rule, fingerprint and commit, never the matched value.
 *
 * Only plumbing reads the commits (`rev-list`, `cat-file commit`, one `diff-tree --stdin --root --cc`), so no log, diff or
 * encoding setting changes what is read, and replace refs and the system attributes file are off. A message that declares
 * an encoding other than UTF-8 is also scanned as its raw bytes, and one the scan cannot decode makes the result unreadable. The diff streams to a private temporary file and is
 * read in chunks, so memory stays bounded. Binary detection is git's own (a NUL in a blob's first 8000 bytes), with
 * attributes read from the empty tree: a file git still calls binary is checked by its own bytes when its old side was
 * not empty or attributes could still apply, and a text file is then scanned whole. Added text over the scan cap is
 * reported as unscanned, and a commit that changes a file deciding what the scan sees (the loaded `.gbrain-scan-allow` or the top-level one, a
 * `.gitattributes`) as a gate change, so callers refuse. Output the parser does not recognise, a git failure or a run
 * past the time budget sets `unreadable` instead of returning a partial result. The time budget is checked between git
 * calls and while the diff is parsed, so a caller with a short budget (the owner's event loop) is never held much past it.
 * Commits gbrain's commit ledger records as page writes (`PAGE_WRITERS`) are not scanned: page bodies are stored raw by
 * design (docs/guides/write-refusals.md#what-stays-raw-by-design) and their Git backups have always been pushed, so the
 * gate covers what gbrain did not write; `gbrain git commit-push` commits, which carry a script's files, are scanned.
 */
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { GIT_READ_ENV, gitChildEnv } from '../git-env.ts';
import { readLedger } from './commit-ledger.ts';
import { GIT_ENV } from '../git-transport.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { shellQuote } from '../agent-output.ts';
import { loadWorkspaceAllowlist, pathAllowlisted, SCAN_ALLOW_FILENAME } from '../secret-scan-allowlist.ts';
import { scanText, SCAN_MAX_FILE_BYTES } from '../secret-scan.ts';
import { spawnSync } from '../spawn.ts';

export interface RangeSecretFinding { path: string; commit: string; line: number; pattern: string; fingerprint: string }
export interface RangeScan {
  findings: RangeSecretFinding[]; unscanned: Array<{ path: string; commit: string }>; gate_changes: Array<{ path: string; commit: string }>;
  /** Set when the commits could not be read completely; the other lists are then partial. */
  unreadable?: string;
  /** Set with `unreadable` when the reason is the time budget, so a caller with a short budget can scan again elsewhere. */
  timed_out?: true;
}

/** The commit message as `path` in a finding. */
export const MESSAGE_PATH = '(commit message)';

const SNIFF_BYTES = 8000;
/** The default time budget of a range scan; a foreground publish takes a longer one with --scan-timeout. */
export const DEFAULT_SCAN_TIMEOUT_MS = 300_000;
const PROGRESS_EVERY_MS = 10_000;
/** Commits per diff-tree run, so the temporary patch file stays the size of one batch, not of the whole history. */
const DIFF_BATCH = 256;
const BIG_FILE_THRESHOLD = 512 * 1024 * 1024;
const CONFIG = ['-c', 'core.quotePath=false', '-c', 'core.attributesFile=/dev/null', '-c', `core.bigFileThreshold=${BIG_FILE_THRESHOLD}`];
const DIFF = ['diff-tree', '--stdin', '-r', '-p', '--root', '--cc', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
  '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0'];

/**
 * Ledger writers whose commits hold only page writes: a Git effect's commit, a strict source's door commit and a hosted
 * repository's commits. A Git effect's or a door's record counts only when `verified` (VERIFIED_WRITERS: each committed
 * blob is the bytes the writer wrote, with no clean filter in between; records from releases before that check carry none). A record that adopted a file edited outside gbrain
 * (`adopted`) carries bytes gbrain did not write, so it is scanned, and so is a page-write commit older than the retained
 * ledger or made before it existed.
 */
const PAGE_WRITERS: ReadonlySet<string> = new Set(['effect', 'door', 'hosted_repo']);
const VERIFIED_WRITERS: ReadonlySet<string> = new Set(['effect', 'door']);

class Unreadable extends Error { constructor(message: string, readonly timedOut = false) { super(message); } }

type Run = ReturnType<typeof spawnSync>;
function run(root: string, args: string[], deadline: number, opts: { input?: string; out?: number; maxBuffer?: number } = {}): Run {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Unreadable('the scan ran past its time budget', true);
  return spawnSync('git', ['-C', root, ...args], { input: opts.input ?? '', stdio: ['pipe', opts.out ?? 'pipe', 'pipe'], timeout,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, env: gitChildEnv({ ...GIT_ENV, ...GIT_READ_ENV, LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1' }) });
}
/** The commits the ledger records as page writes; an unreadable ledger reads as none, so everything is scanned. */
function pageWriteCommits(root: string, deadline: number): Set<string> {
  const common = must(run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], deadline), 'rev-parse').toString().trim();
  try {
    return new Set(readLedger(common).flatMap(record => record.e === 'commit' && PAGE_WRITERS.has(record.writer) && !record.adopted?.length
      && (!VERIFIED_WRITERS.has(record.writer) || record.verified) ? [record.sha] : []));
  }
  catch { return new Set(); }
}
function must(r: Run, what: string): Buffer {
  if (r.error || r.status !== 0) {
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    const why = timedOut ? 'timed out' : String(r.stderr ?? '').trim() || r.error?.message || `exit ${r.status}`;
    throw new Unreadable(`git ${what} failed: ${why.slice(0, 300)}`, timedOut);
  }
  return r.stdout as Buffer;
}

/** Lines of an open file read in 1 MiB chunks; a line longer than `limit` bytes keeps its first `limit` bytes and is marked long. */
function* fileLines(fd: number, limit: number): Generator<{ text: string; long: boolean }> {
  const chunk = Buffer.alloc(1 << 20);
  let pending: Buffer[] = [], size = 0, position = 0;
  const take = (piece: Buffer) => { if (size < limit) pending.push(Buffer.from(piece.subarray(0, limit - size))); size += piece.length; };
  const line = () => { const out = { text: Buffer.concat(pending).toString('utf8'), long: size > limit }; pending = []; size = 0; return out; };
  for (let n; (n = readSync(fd, chunk, 0, chunk.length, position)) > 0; position += n) {
    const view = chunk.subarray(0, n);
    let start = 0;
    for (let nl; (nl = view.indexOf(10, start)) !== -1; start = nl + 1) { take(view.subarray(start, nl)); yield line(); }
    if (start < n) take(view.subarray(start));
  }
  if (size) yield line();
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
/** A path as git prints it: bare, or C-quoted when it holds a special character. Null when the quoting is malformed. */
function unquote(text: string): string | null {
  if (!text.startsWith('"')) return text;
  if (text.length < 2 || !text.endsWith('"')) return null;
  const bytes: number[] = [];
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] !== '\\') { bytes.push(...Buffer.from(text[i]!)); continue; }
    const octal = /^[0-7]{3}/.exec(text.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue; }
    const escaped = C_ESCAPES[text[++i] ?? ''];
    if (escaped === undefined) return null;
    bytes.push(escaped);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** True when git's attribute lookup, pointed at the empty tree, cannot apply any attribute (git 2.42+, no info/attributes rule). */
function attributesNeutral(root: string, deadline: number): boolean {
  const version = /git version (\d+)\.(\d+)/.exec(must(run(root, ['version'], deadline), 'version').toString());
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 42)) return false;
  const rel = must(run(root, ['rev-parse', '--git-path', 'info/attributes'], deadline), 'rev-parse').toString().trim();
  const file = isAbsolute(rel) ? rel : join(root, rel);
  return !existsSync(file) || readFileSync(file, 'utf8').split('\n').every(line => !line.trim() || line.trim().startsWith('#'));
}

/**
 * An empty `base` scans `head` and its whole history (a first push that creates the remote branch). `progress` receives a
 * line at once for a whole-history scan, and every 10 s while any scan runs.
 */
export function scanRange(root: string, base: string, head: string, timeoutMs = DEFAULT_SCAN_TIMEOUT_MS, progress?: (line: string) => void): RangeScan {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let reported = base ? started : 0, spoke = false;
  const report = (line: () => string) => {
    if (!progress || Date.now() - reported < PROGRESS_EVERY_MS) return;
    reported = Date.now(); spoke = true;
    progress(`secret scan: ${line()} (${Math.round((reported - started) / 1000)} s of a ${Math.round(timeoutMs / 1000)} s budget)`);
  };
  const scan: RangeScan = { findings: [], unscanned: [], gate_changes: [] };
  const allowlist = loadWorkspaceAllowlist(root);
  let allowFile = SCAN_ALLOW_FILENAME, prefix = '';
  const allowed = (path: string) => path.startsWith(prefix) && pathAllowlisted(path.slice(prefix.length), allowlist);
  const scanned = (path: string, commit: string, text: string, lineAt: (line: number) => number = line => line) => {
    if (Date.now() > deadline) throw new Unreadable('the scan ran past its time budget', true);
    if (Buffer.byteLength(text) > SCAN_MAX_FILE_BYTES) { scan.unscanned.push({ path, commit }); return; }
    for (const f of scanText(text, { allowlist })) scan.findings.push({ path, commit, line: lineAt(f.line), pattern: f.pattern, fingerprint: f.fingerprint });
  };
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-range-scan-'));
  try {
    prefix = must(run(root, ['rev-parse', '--show-prefix'], deadline), 'rev-parse').toString().replace(/\n$/, '');
    allowFile = `${prefix}${SCAN_ALLOW_FILENAME}`;
    const pageWrites = pageWriteCommits(root, deadline);
    const commits = must(run(root, ['rev-list', base ? `${base}..${head}` : head, '--'], deadline), 'rev-list').toString().split('\n')
      .filter(commit => commit && !pageWrites.has(commit));
    if (!commits.length) return scan;
    report(() => `reading ${commits.length} commit(s)${base ? '' : ', the whole history'}`);

    const scanMessage = (commit: string, object: Buffer): void => {
      const split = object.indexOf('\n\n');
      const encoding = /^encoding (.+)$/m.exec(object.subarray(0, split < 0 ? object.length : split).toString('latin1'))?.[1]?.trim() ?? 'utf-8';
      const bytes = split < 0 ? Buffer.alloc(0) : object.subarray(split + 2);
      let message: string;
      try { message = new TextDecoder(encoding).decode(bytes); } catch {
        throw new Unreadable(`commit ${commit.slice(0, 12)} declares message encoding ${JSON.stringify(encoding.slice(0, 40))}, which the scan cannot decode`);
      }
      const before = scan.findings.length;
      scanned(MESSAGE_PATH, commit, message);
      if (/^utf-?8$/i.test(encoding)) return;
      const seen = new Set(scan.findings.slice(before).map(f => `${f.line}:${f.fingerprint}`));
      for (const f of scanText(bytes.toString('latin1'), { allowlist })) {
        if (!seen.has(`${f.line}:${f.fingerprint}`)) scan.findings.push({ path: MESSAGE_PATH, commit, line: f.line, pattern: f.pattern, fingerprint: f.fingerprint });
      }
    };
    for (let batch = 0; batch < commits.length; batch += DIFF_BATCH) {
      report(() => `read ${batch} of ${commits.length} commit message(s)`);
      const slice = commits.slice(batch, batch + DIFF_BATCH);
      const fd = openSync(join(dir, 'commits'), 'w+', 0o600);
      try {
        must(run(root, ['cat-file', '--batch'], deadline, { input: slice.join('\n') + '\n', out: fd }), 'cat-file --batch');
        let position = 0;
        const readAt = (length: number) => {
          const buf = Buffer.alloc(length);
          for (let got = 0, n; got < length; got += n) {
            n = readSync(fd, buf, got, length - got, position + got);
            if (!n) throw new Unreadable(`git cat-file --batch ended early in the commits after ${slice[0]!.slice(0, 12)}`);
          }
          return buf;
        };
        for (const commit of slice) {
          const peek = Buffer.alloc(200);
          const header = peek.subarray(0, readSync(fd, peek, 0, peek.length, position));
          const nl = header.indexOf(10);
          const m = nl < 0 ? null : /^([0-9a-f]+) commit (\d+)$/.exec(header.subarray(0, nl).toString('latin1'));
          if (!m || m[1] !== commit) throw new Unreadable(`git cat-file --batch could not read commit ${commit.slice(0, 12)} (it printed no header for it)`);
          const size = Number(m[2]);
          position += nl + 1;
          if (size > SCAN_MAX_FILE_BYTES + 1024 * 1024) { scan.unscanned.push({ path: MESSAGE_PATH, commit }); position += size + 1; continue; }
          const object = readAt(size);
          position += size + 1;
          scanMessage(commit, object);
        }
      } finally {
        closeSync(fd);
      }
    }

    const neutral = attributesNeutral(root, deadline);
    const attrSource = neutral ? [`--attr-source=${must(run(root, ['hash-object', '-t', 'tree', '--stdin'], deadline), 'hash-object').toString().trim()}`] : [];
    const out = join(dir, 'diff');
    const binaries: Array<{ commit: string; path: string; blob: string; added: boolean }> = [];
    let patchBytes = 0;
    for (let batch = 0; batch < commits.length; batch += DIFF_BATCH) {
      report(() => `read the patches of ${batch} of ${commits.length} commit(s), ${(patchBytes / 1048576).toFixed(0)} MiB`);
      const fd = openSync(out, 'w+', 0o600);
      try {
        must(run(root, [...attrSource, ...CONFIG, ...DIFF], deadline, { input: commits.slice(batch, batch + DIFF_BATCH).join('\n') + '\n', out: fd }), 'diff-tree');
        patchBytes += fstatSync(fd).size;
        let commit = '', path: string | null = null, header = false, parents = 1, next = 0, bytes = 0, oversized = false;
        let olds: string[] = [], blob = '', added: string[] = [], at: number[] = [];
        const flush = () => {
          if (path && (oversized || added.length) && !allowed(path)) {
            if (oversized) scan.unscanned.push({ path, commit });
            else scanned(path, commit, added.join('\n'), line => at[line - 1] ?? line);
          }
          added = []; at = []; bytes = 0; oversized = false;
        };
        const unexpected = (line: string) => new Unreadable(`git diff-tree printed a line the scan does not recognise in ${commit.slice(0, 12) || 'the range'}, starting ${JSON.stringify(line.split(' ')[0]!.slice(0, 16))}`);
        let read = 0;
        for (const { text: line, long } of fileLines(fd, SCAN_MAX_FILE_BYTES + 1)) {
          if (++read % 4096 === 0) {
            if (Date.now() > deadline) throw new Unreadable('the scan ran past its time budget', true);
            report(() => `read the patches of ${batch} of ${commits.length} commit(s), ${(patchBytes / 1048576).toFixed(0)} MiB`);
          }
          if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line)) { flush(); commit = line; path = null; header = false; continue; }
          if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
            flush();
            if (!commit || long) throw unexpected(line);
            if (line.startsWith('diff --git ')) {
              const pair = line.slice('diff --git '.length), half = (pair.length - 1) / 2;
              const left = Number.isInteger(half) && pair[half] === ' ' ? unquote(pair.slice(0, half)) : null;
              const right = left === null ? null : unquote(pair.slice(half + 1));
              path = left?.startsWith('a/') && right?.startsWith('b/') && left.slice(2) === right.slice(2) ? right.slice(2) : null;
            } else path = unquote(line.replace(/^diff --(?:cc|combined) /, ''));
            if (path === null) throw unexpected(line);
            if (path === allowFile || path === SCAN_ALLOW_FILENAME || path === '.gitattributes' || path.endsWith('/.gitattributes')) scan.gate_changes.push({ path, commit });
            header = true; olds = []; blob = '';
            continue;
          }
          const hunk = /^(@{2,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,\d+)? \1(?: |$)/.exec(line);
          if (hunk && path && !long) {
            parents = hunk[1]!.length - 1;
            if (hunk[2]!.trim().split(' ').length !== parents) throw unexpected(line);
            header = false; next = Number(hunk[3]);
            continue;
          }
          if (header && path && !long) {
            const index = /^index ((?:[0-9a-f]+,)*[0-9a-f]+)\.\.([0-9a-f]+)(?: [0-7]+)?$/.exec(line);
            if (index) { olds = index[1]!.split(','); blob = index[2]!; continue; }
            if (/^(?:old mode|new mode|deleted file mode|new file mode|mode) [0-7,.]+$/.test(line) || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
            if (line === 'Binary files differ' || /^Binary files .+ differ$/.test(line)) {
              if (blob && !/^0+$/.test(blob)) binaries.push({ commit, path, blob, added: olds.every(old => /^0+$/.test(old)) });
              path = null;
              continue;
            }
            throw unexpected(line);
          }
          if (!path || header) throw unexpected(line);
          if (line.startsWith('\\')) continue;
          const prefix = line.slice(0, parents);
          if (prefix.length < parents || /[^ +-]/.test(prefix)) throw unexpected(line);
          if (prefix.includes('-')) continue;
          if (prefix === '+'.repeat(parents)) {
            bytes += Buffer.byteLength(line) - parents + 1;
            if (long || bytes > SCAN_MAX_FILE_BYTES) { oversized = true; added = []; at = []; }
            else { added.push(line.slice(parents)); at.push(next); }
          }
          next++;
        }
        flush();
      } finally {
        closeSync(fd);
      }
    }

    const sizes = new Map<string, number>();
    const fresh = binaries.filter(b => neutral && b.added);
    if (fresh.length) {
      const check = must(run(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], deadline, { input: fresh.map(b => b.blob).join('\n') + '\n' }), 'cat-file --batch-check');
      for (const row of check.toString().split('\n')) { const [name, size] = row.split(' '); if (name && size) sizes.set(name, Number(size)); }
    }
    for (const b of binaries) {
      if (allowed(b.path)) continue;
      if (neutral && b.added && (sizes.get(b.blob) ?? Infinity) <= BIG_FILE_THRESHOLD) continue;
      const sniff = run(root, ['cat-file', 'blob', b.blob], deadline, { maxBuffer: SNIFF_BYTES });
      if ((sniff.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOBUFS') must(sniff, 'cat-file blob');
      if ((sniff.stdout as Buffer).subarray(0, SNIFF_BYTES).includes(0)) continue;
      const whole = run(root, ['cat-file', 'blob', b.blob], deadline, { maxBuffer: SCAN_MAX_FILE_BYTES });
      if ((whole.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') { scan.unscanned.push({ path: b.path, commit: b.commit }); continue; }
      scanned(b.path, b.commit, must(whole, 'cat-file blob').toString('utf8'));
    }
    if (spoke) progress!(`secret scan: read ${commits.length} commit(s) in ${Math.round((Date.now() - started) / 1000)} s`);
    return scan;
  } catch (e) {
    if (e instanceof Unreadable) return { ...scan, unreadable: e.message, ...(e.timedOut ? { timed_out: true as const } : {}) };
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Writers that commit only blobs they scanned, staged, with the workspace allowlist the range scan also applies
 * (`gbrain sources push`, `gbrain bootstrap repo`): the allowlist edit such a commit carries is the user's answer to that
 * scan, so it is not refused as a gate change. Its content is still scanned. `gbrain sources push` also streams staged
 * files past the range scan's cap (up to its own 512 MiB ceiling), so a file in its commit the range scan calls too large
 * was scanned; bootstrap's file scan skips files over the cap, so its large files stay refused.
 */
const STAGED_SCAN_WRITERS: ReadonlySet<string> = new Set(['workspace_push', 'bootstrap']);
const STREAMED_SCAN_WRITERS: ReadonlySet<string> = new Set(['workspace_push']);

/**
 * The refusal for a push by `gbrain sources push` or `gbrain bootstrap repo` of `base..target` (an empty `base` covers
 * the whole history): the same scan and refusals as an automatic publish, except for what those writers' own commits
 * already passed (see STAGED_SCAN_WRITERS).
 */
export function stagedScanPublishRefusal(root: string, base: string, target: string, opts: PublishScanOptions = {}): OperationError | null {
  const scan = scanRange(root, base, target, opts.timeoutMs, opts.progress);
  if (!scan.gate_changes.length && !scan.unscanned.length) return rangeSecretRefusal(root, base, target, scan, opts);
  const own = new Map<string, string>();
  try {
    const common = must(run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], Date.now() + 60_000), 'rev-parse').toString().trim();
    for (const record of readLedger(common)) if (record.e === 'commit' && STAGED_SCAN_WRITERS.has(record.writer)) own.set(record.sha, record.writer);
  } catch { /* an unreadable ledger exempts nothing */ }
  return rangeSecretRefusal(root, base, target, { ...scan,
    gate_changes: scan.gate_changes.filter(change => !own.has(change.commit)),
    unscanned: scan.unscanned.filter(item => item.path === MESSAGE_PATH || !STREAMED_SCAN_WRITERS.has(own.get(item.commit) ?? '')) }, opts);
}

/**
 * How a foreground publish runs its range scan: `timeoutMs` is its budget (default 300 s), `progress` gets its progress
 * lines, and `retryArgv` is the command that publishes again, so a scan that ran out of time refuses naming that command
 * with a longer `--scan-timeout`.
 */
export interface PublishScanOptions { timeoutMs?: number; progress?: (line: string) => void; retryArgv?: string[] }

/**
 * The automatic-publish refusal for the commits in `base..target` of `root`, shared by every publish that scans: null
 * when the scan read the whole range and found nothing; `publish_scan_unreadable` when it could not read it all;
 * otherwise `publish_secret_found` naming each finding, unscanned file and gate change (never a value).
 */
export function rangeSecretRefusal(root: string, base: string, target: string, scan: RangeScan, opts: PublishScanOptions = {}): OperationError | null {
  const range = base ? `${base}..${target.slice(0, 12)}` : `${target.slice(0, 12)} and its whole history`;
  if (scan.timed_out && opts.retryArgv) {
    const seconds = Math.round((opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS) / 1000);
    const argv = [...opts.retryArgv, '--scan-timeout', String(Math.max(seconds * 4, 1200))];
    return opError('publish_scan_unreadable', `The secret scan of the local commits ${range} ran past its ${seconds} s time budget before it read them all. No secret was reported. Nothing was pushed.`,
      `A long history takes longer to scan than the budget; the scan still reads every commit before anything is pushed. Rerun with a longer budget: ${shellQuote(argv)}. Never publish with a command that skips this scan.`,
      { detail: JSON.stringify({ unreadable: scan.unreadable, timed_out: true, budget_seconds: seconds }), fix: { consent: [], actor: 'agent', requires_exclusive: false, argv,
        why: 'The same publish with a longer scan budget: it still scans every commit and pushes only when the scan finds nothing.',
        docs: 'docs/guides/shared-checkout-git.md#publish_scan_unreadable' } });
  }
  if (scan.unreadable !== undefined) {
    return opError('publish_scan_unreadable', `The secret scan could not read the local commits ${range} (${scan.unreadable}). No secret was reported. Nothing was pushed.`,
      `The publish pushes only commits it has read in full. Check the checkout with git fsck in ${root} (a missing or corrupt object, a full disk, or a git too slow for the 300 s budget), fix what it reports, then retry. Never publish with a command that skips this scan.`,
      { detail: JSON.stringify({ unreadable: scan.unreadable }), fix: { ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
        argv: ['git', '-C', root, 'fsck'],
        why: 'Read-only: names missing or corrupt objects in the unpublished commits, the usual reason the scan cannot read them.',
        user_message: `The secret scan could not read the unpublished commits in ${root}, so nothing was pushed. Check the checkout with git fsck and fix what it reports?`,
        docs: 'docs/guides/shared-checkout-git.md#publish_scan_unreadable' } });
  }
  if (!scan.findings.length && !scan.unscanned.length && !scan.gate_changes.length) return null;
  const named = [...scan.findings.map(f => `${f.path}:${f.line} (${f.pattern}, ${f.commit.slice(0, 7)})`), ...scan.unscanned.map(u => `${u.path} (too large to scan, ${u.commit.slice(0, 7)})`),
    ...scan.gate_changes.map(g => `${g.path} (changes what the scan sees, ${g.commit.slice(0, 7)})`)];
  return opError('publish_secret_found',
    `${named.length} item(s) in the local commits ${range} look like secrets or could not be scanned: ${named.slice(0, 10).join(', ')}${named.length > 10 ? ', ...' : ''}. Nothing was pushed.`,
    `Remove the value from those commits (rewriting unpushed local commits is the user's call), or add a false positive's fingerprint to .gbrain-scan-allow, then retry. Never publish them with a command that skips this scan.${base ? '' : ' The remote has no such branch, so this covered the branch\'s whole history, which may include commits published elsewhere before: review it, and push the branch yourself once it is safe.'}${scan.gate_changes.length ? ` A commit that changes .gbrain-scan-allow or a .gitattributes is never published automatically, because it changes what the scan sees: review it and push it yourself (git -C ${root} push), then retry.` : ''}`,
    { detail: JSON.stringify(scan),
      fix: { ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
        argv: ['git', '-C', root, 'log', '--stat', base ? `${base}..${target}` : target],
        why: 'Lists the unpublished commits the scan refused; read-only. A secret pushed to the remote stays in its history.',
        user_message: `Unpublished commits in ${root} hold ${named.length || 'some'} item(s) that look like secrets or could not be scanned (${named.slice(0, 3).join(', ')}). Nothing was pushed. Remove them from those commits, or confirm a false positive so it can be allowlisted by fingerprint?`,
        docs: 'docs/guides/shared-checkout-git.md#publish_secret_found' } });
}
