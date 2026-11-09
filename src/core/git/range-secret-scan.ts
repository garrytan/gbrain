/**
 * Secret scan over the commits an automatic publish pushes. A commit gbrain did not write (a script's plain
 * `git commit`) never passed the write path's scan, so the publish scans, under its publish lock and for the exact
 * commit it pushes, what each commit in `base..head` adds: its message, the lines it adds file by file (a value a later
 * commit removed is still in the pushed history), and for a merge commit the lines it adds that no parent has
 * (a conflict resolution). The workspace allowlist (`.gbrain-scan-allow`: path globs and fingerprints) applies.
 * Findings carry the path, line, rule, fingerprint and commit, never the matched value.
 *
 * Only plumbing reads the commits (`rev-list`, `cat-file commit`, one `diff-tree --stdin --root --cc`), so no log, diff or
 * encoding setting changes what is read, and replace refs and the system attributes file are off. A message that declares
 * an encoding other than UTF-8 is also scanned as its raw bytes, and one the scan cannot decode makes the result unreadable. The diff streams to a private temporary file and is
 * read in chunks, so memory stays bounded. Binary detection is git's own (a NUL in a blob's first 8000 bytes), with
 * attributes read from the empty tree: a file git still calls binary is checked by its own bytes when its old side was
 * not empty or attributes could still apply, and a text file is then scanned whole. Added text over the scan cap is
 * reported as unscanned, and a commit that changes a file deciding what the scan sees (`.gbrain-scan-allow`, a
 * `.gitattributes`) as a gate change, so callers refuse. Output the parser does not recognise, a git failure or a run
 * past the time budget sets `unreadable` instead of returning a partial result.
 */
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { GIT_READ_ENV, gitChildEnv } from '../git-env.ts';
import { GIT_ENV } from '../git-transport.ts';
import { loadWorkspaceAllowlist, pathAllowlisted, SCAN_ALLOW_FILENAME } from '../secret-scan-allowlist.ts';
import { scanText, SCAN_MAX_FILE_BYTES } from '../secret-scan.ts';
import { spawnSync } from '../spawn.ts';

export interface RangeSecretFinding { path: string; commit: string; line: number; pattern: string; fingerprint: string }
export interface RangeScan {
  findings: RangeSecretFinding[]; unscanned: Array<{ path: string; commit: string }>; gate_changes: Array<{ path: string; commit: string }>;
  /** Set when the commits could not be read completely; the other lists are then partial. */
  unreadable?: string;
}

/** The commit message as `path` in a finding. */
export const MESSAGE_PATH = '(commit message)';

const SNIFF_BYTES = 8000;
const BIG_FILE_THRESHOLD = 512 * 1024 * 1024;
const CONFIG = ['-c', 'core.quotePath=false', '-c', 'core.attributesFile=/dev/null', '-c', `core.bigFileThreshold=${BIG_FILE_THRESHOLD}`];
const DIFF = ['diff-tree', '--stdin', '-r', '-p', '--root', '--cc', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
  '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0'];

class Unreadable extends Error {}

type Run = ReturnType<typeof spawnSync>;
function run(root: string, args: string[], deadline: number, opts: { input?: string; out?: number; maxBuffer?: number } = {}): Run {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Unreadable('the scan ran past its time budget');
  return spawnSync('git', ['-C', root, ...args], { input: opts.input ?? '', stdio: ['pipe', opts.out ?? 'pipe', 'pipe'], timeout,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, env: gitChildEnv({ ...GIT_ENV, ...GIT_READ_ENV, LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1' }) });
}
function must(r: Run, what: string): Buffer {
  if (r.error || r.status !== 0) {
    const why = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'timed out' : String(r.stderr ?? '').trim() || r.error?.message || `exit ${r.status}`;
    throw new Unreadable(`git ${what} failed: ${why.slice(0, 300)}`);
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

export function scanRange(root: string, base: string, head: string, timeoutMs = 300_000): RangeScan {
  const deadline = Date.now() + timeoutMs;
  const scan: RangeScan = { findings: [], unscanned: [], gate_changes: [] };
  const allowlist = loadWorkspaceAllowlist(root);
  const scanned = (path: string, commit: string, text: string, lineAt: (line: number) => number = line => line) => {
    if (Buffer.byteLength(text) > SCAN_MAX_FILE_BYTES) { scan.unscanned.push({ path, commit }); return; }
    for (const f of scanText(text, { allowlist })) scan.findings.push({ path, commit, line: lineAt(f.line), pattern: f.pattern, fingerprint: f.fingerprint });
  };
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-range-scan-'));
  try {
    const commits = must(run(root, ['rev-list', `${base}..${head}`, '--'], deadline), 'rev-list').toString().split('\n').filter(Boolean);
    if (!commits.length) return scan;

    for (const commit of commits) {
      const raw = run(root, ['cat-file', 'commit', commit], deadline, { maxBuffer: SCAN_MAX_FILE_BYTES + 1024 * 1024 });
      if ((raw.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') { scan.unscanned.push({ path: MESSAGE_PATH, commit }); continue; }
      const object = must(raw, 'cat-file commit');
      const split = object.indexOf('\n\n');
      const encoding = /^encoding (.+)$/m.exec(object.subarray(0, split < 0 ? object.length : split).toString('latin1'))?.[1]?.trim() ?? 'utf-8';
      const bytes = split < 0 ? Buffer.alloc(0) : object.subarray(split + 2);
      let message: string;
      try { message = new TextDecoder(encoding).decode(bytes); } catch {
        throw new Unreadable(`commit ${commit.slice(0, 12)} declares message encoding ${JSON.stringify(encoding.slice(0, 40))}, which the scan cannot decode`);
      }
      const before = scan.findings.length;
      scanned(MESSAGE_PATH, commit, message);
      if (/^utf-?8$/i.test(encoding)) continue;
      const seen = new Set(scan.findings.slice(before).map(f => `${f.line}:${f.fingerprint}`));
      for (const f of scanText(bytes.toString('latin1'), { allowlist })) {
        if (!seen.has(`${f.line}:${f.fingerprint}`)) scan.findings.push({ path: MESSAGE_PATH, commit, line: f.line, pattern: f.pattern, fingerprint: f.fingerprint });
      }
    }

    const neutral = attributesNeutral(root, deadline);
    const attrSource = neutral ? [`--attr-source=${must(run(root, ['hash-object', '-t', 'tree', '--stdin'], deadline), 'hash-object').toString().trim()}`] : [];
    const out = join(dir, 'diff');
    const fd = openSync(out, 'w+', 0o600);
    const binaries: Array<{ commit: string; path: string; blob: string; added: boolean }> = [];
    try {
      must(run(root, [...attrSource, ...CONFIG, ...DIFF], deadline, { input: commits.join('\n') + '\n', out: fd }), 'diff-tree');
      let commit = '', path: string | null = null, header = false, parents = 1, next = 0, bytes = 0, oversized = false;
      let olds: string[] = [], blob = '', added: string[] = [], at: number[] = [];
      const flush = () => {
        if (path && (oversized || added.length) && !pathAllowlisted(path, allowlist)) {
          if (oversized) scan.unscanned.push({ path, commit });
          else scanned(path, commit, added.join('\n'), line => at[line - 1] ?? line);
        }
        added = []; at = []; bytes = 0; oversized = false;
      };
      const unexpected = (line: string) => new Unreadable(`git diff-tree printed a line the scan does not recognise in ${commit.slice(0, 12) || 'the range'}: ${JSON.stringify(line.slice(0, 80))}`);
      for (const { text: line, long } of fileLines(fd, SCAN_MAX_FILE_BYTES + 1)) {
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
          if (path === SCAN_ALLOW_FILENAME || path === '.gitattributes' || path.endsWith('/.gitattributes')) scan.gate_changes.push({ path, commit });
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

    const sizes = new Map<string, number>();
    const fresh = binaries.filter(b => neutral && b.added);
    if (fresh.length) {
      const check = must(run(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], deadline, { input: fresh.map(b => b.blob).join('\n') + '\n' }), 'cat-file --batch-check');
      for (const row of check.toString().split('\n')) { const [name, size] = row.split(' '); if (name && size) sizes.set(name, Number(size)); }
    }
    for (const b of binaries) {
      if (pathAllowlisted(b.path, allowlist)) continue;
      if (neutral && b.added && (sizes.get(b.blob) ?? Infinity) <= BIG_FILE_THRESHOLD) continue;
      const sniff = run(root, ['cat-file', 'blob', b.blob], deadline, { maxBuffer: SNIFF_BYTES });
      if ((sniff.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOBUFS') must(sniff, 'cat-file blob');
      if ((sniff.stdout as Buffer).subarray(0, SNIFF_BYTES).includes(0)) continue;
      const whole = run(root, ['cat-file', 'blob', b.blob], deadline, { maxBuffer: SCAN_MAX_FILE_BYTES });
      if ((whole.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') { scan.unscanned.push({ path: b.path, commit: b.commit }); continue; }
      scanned(b.path, b.commit, must(whole, 'cat-file blob').toString('utf8'));
    }
    return scan;
  } catch (e) {
    if (e instanceof Unreadable) return { ...scan, unreadable: e.message };
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
