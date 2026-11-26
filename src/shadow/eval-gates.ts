/**
 * The eval gates half of swap criterion 10 (docs/designs/RUST_ENGINE.md, "Eval gates"; plan c-ts). The release must carry
 * quality gates E1 to E3, measured by gbrain-evals on the exact build the shadow's evidence epoch started on.
 *
 * (No imports beyond node: the pin publisher script, scripts/eval-gates-pin.ts, runs it without installing dependencies.)
 *
 * Files, all under `<shadow dir>/drills/`: `eval-gates.json` (the published file, byte for byte), `eval-gates.pin.json`
 * (the pin that named it) and `eval-gates.fetch.json` (the last fetch attempt). Only `fetchEvalGates` (run by
 * `gbrain engine shadow drill --evals`) touches the network. `readEvalGatesVerdict` (status and the swap) reads the cache
 * and decides again every time, so a later epoch, a different addon or a cache that does not match fails closed, offline.
 *
 * The pin is the release's own asset `gbrain-eval-gates.pin.json`, attached by .github/workflows/eval-gates-pin.yml once
 * the FINAL file for that tag exists (`pinSource` below is the one function to replace if the pin moves to a committed
 * file). The pin names the exact file by commit-pinned URL and SHA-256, so the file is checked against what the release
 * says, not against whatever the evals repository holds today.
 *
 * A pass needs: status FINAL (a non-rc release tag; PROVISIONAL never passes), E1, E2 and E3 all PASS, the file's
 * `gbrain_commit` equal to the commit that STARTED the epoch (epoch `build`), `rust_addon_sha256` equal to the addon
 * file the epoch recorded, `engine_format_version` equal to the store's, and `target` equal to this host's addon target.
 * Anything missing, unreadable or different is a `false` whose reason names the cause.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { EpochManifest } from './evidence-epoch.ts';

export const GATE_NAMES = ['E1', 'E2', 'E3'] as const;
export type GateName = (typeof GATE_NAMES)[number];
export type GateVerdict = 'PASS' | 'FAIL' | 'NOT_RUN';

export interface EvalGate { verdict: GateVerdict; threshold: number | null; measured: number | null; rows: number | null; losses: number | unknown[] | null }

/** The published file (gbrain-evals `eval/results/engine-bench/eval-gates/<gbrain_tag>/<evals_commit>.json`). */
export interface EvalGatesFile {
  schema_version: 1;
  gbrain_commit: string;
  gbrain_tag: string | null;
  rust_addon_sha256: string;
  engine_format_version: number;
  evals_commit: string;
  generated_at: string;
  target: string;
  status: 'FINAL' | 'PROVISIONAL';
  gates: Record<GateName, EvalGate>;
  receipt_links: string[];
}

/** What the release's pin asset says about the file. `evals_ref` is the gbrain-evals commit the file was read at. */
export interface EvalGatesPin {
  schema_version: 1;
  gbrain_tag: string;
  gbrain_commit: string;
  evals_commit: string;
  evals_ref: string;
  path: string;
  url: string;
  sha256: string;
  target: string;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVALS_ROOT = 'eval/results/engine-bench/eval-gates';
export const PIN_ASSET = 'gbrain-eval-gates.pin.json';
/** A final release tag: `v` and dotted numbers, no suffix (an `-rc` or any other suffix is a prerelease). */
export const FINAL_TAG = /^v\d+(\.\d+){1,4}$/;
export const MAX_PIN_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;

export const evalGatesPath = (evalsCommitOfFile: string, tag: string): string => `${EVALS_ROOT}/${tag}/${evalsCommitOfFile}.json`;
export const evalGatesUrl = (ref: string, path: string): string => `https://raw.githubusercontent.com/garrytan/gbrain-evals/${ref}/${path}`;
export const pinAssetUrl = (tag: string): string => `https://github.com/garrytan/gbrain/releases/download/${tag}/${PIN_ASSET}`;
const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finiteOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Strict parse: every field the verdict reads must be present and of its kind, or the file is unreadable. */
export function parseEvalGatesFile(raw: string): EvalGatesFile | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; } // silent-read-ok: unparseable text is the typed marker (`eval_gates_unreadable`)
  if (!isObject(v) || v.schema_version !== 1 || !isObject(v.gates)) return null;
  const gates = v.gates as Record<string, unknown>;
  const out: Partial<Record<GateName, EvalGate>> = {};
  for (const name of GATE_NAMES) {
    const g = gates[name];
    if (!isObject(g) || (g.verdict !== 'PASS' && g.verdict !== 'FAIL' && g.verdict !== 'NOT_RUN')) return null;
    if (!finiteOrNull(g.threshold) || !finiteOrNull(g.measured) || !finiteOrNull(g.rows)) return null;
    if (!(g.losses === null || (typeof g.losses === 'number' && Number.isFinite(g.losses)) || Array.isArray(g.losses))) return null;
    out[name] = { verdict: g.verdict, threshold: g.threshold, measured: g.measured, rows: g.rows, losses: g.losses as EvalGate['losses'] };
  }
  const ok = HEX40.test(String(v.gbrain_commit)) && (v.gbrain_tag === null || text(v.gbrain_tag)) && HEX64.test(String(v.rust_addon_sha256))
    && typeof v.engine_format_version === 'number' && Number.isInteger(v.engine_format_version) && text(v.evals_commit)
    && text(v.generated_at) && text(v.target) && (v.status === 'FINAL' || v.status === 'PROVISIONAL')
    && Array.isArray(v.receipt_links) && v.receipt_links.every(l => typeof l === 'string');
  return ok ? { ...(v as unknown as EvalGatesFile), gates: out as Record<GateName, EvalGate> } : null;
}

const PIN_URL = /^https:\/\/raw\.githubusercontent\.com\/garrytan\/gbrain-evals\/([0-9a-f]{40})\/eval\/results\/engine-bench\/eval-gates\/([^/]+)\/([^/]+)\.json$/;

/**
 * Strict parse of the pin: the pin, or the reason it is invalid. `evals_ref` is required (a 40-character lowercase hex
 * commit of gbrain-evals): the URL is the raw path of the file at that commit, and nothing else. A bad field is named:
 * `eval_gates_pin_invalid: evals_ref`. Text that is not a JSON object of this schema is `eval_gates_unreadable`.
 */
export function pinProblem(raw: string): { pin: EvalGatesPin } | { reason: string } {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { reason: 'eval_gates_unreadable' }; } // silent-read-ok: unparseable text is the typed marker
  if (!isObject(v) || v.schema_version !== 1) return { reason: 'eval_gates_unreadable' };
  const evals = v.evals_commit;
  const checks: Array<[string, boolean]> = [
    ['gbrain_tag', text(v.gbrain_tag) && FINAL_TAG.test(v.gbrain_tag)],
    ['gbrain_commit', HEX40.test(String(v.gbrain_commit))],
    ['evals_commit', text(evals) && /^[A-Za-z0-9._-]+$/.test(evals)],
    ['evals_ref', typeof v.evals_ref === 'string' && HEX40.test(v.evals_ref)],
    ['sha256', typeof v.sha256 === 'string' && HEX64.test(v.sha256)],
    ['target', text(v.target)],
    ['path', text(evals) && text(v.gbrain_tag) && v.path === evalGatesPath(evals, v.gbrain_tag)],
    ['url', typeof v.path === 'string' && typeof v.evals_ref === 'string' && v.url === evalGatesUrl(v.evals_ref, v.path)],
  ];
  for (const [field, ok] of checks) if (!ok) return { reason: `eval_gates_pin_invalid: ${field}` };
  const m = PIN_URL.exec(v.url as string);
  return m && m[1] === v.evals_ref && m[2] === v.gbrain_tag && m[3] === evals ? { pin: v as unknown as EvalGatesPin } : { reason: 'eval_gates_pin_invalid: url' };
}

export function parsePin(raw: string): EvalGatesPin | null {
  const parsed = pinProblem(raw);
  return 'pin' in parsed ? parsed.pin : null;
}

/** Why the eval half is not a pass, or null for a pass. Pure: every input is passed in. */
export interface VerdictInput {
  file: string | null;
  pin: string | null;
  epoch: EpochManifest | null;
  storeFormat: number | null;
  hostTarget: string | null;
}

export function evalGatesReason(i: VerdictInput): string | null {
  if (i.file === null || i.pin === null) return 'eval_gates_missing';
  const pinned = pinProblem(i.pin);
  if ('reason' in pinned) return pinned.reason;
  const pin = pinned.pin;
  const file = parseEvalGatesFile(i.file);
  if (!file) return 'eval_gates_unreadable';
  if (sha256(i.file) !== pin.sha256) return 'eval_gates_digest_mismatch';
  if (file.status !== 'FINAL' || file.gbrain_tag === null || !FINAL_TAG.test(file.gbrain_tag)) return 'eval_gates_provisional';
  if (file.gbrain_tag !== pin.gbrain_tag || file.gbrain_commit !== pin.gbrain_commit || file.evals_commit !== pin.evals_commit || file.target !== pin.target) return 'eval_gates_pin_mismatch';
  const build = i.epoch?.build;
  if (!i.epoch || !build || !build.gbrain_commit) return 'eval_gates_build_unknown';
  if (file.target !== i.hostTarget) return `eval_gates_target_mismatch: the file is for ${file.target}, this host is ${i.hostTarget ?? 'unknown'}`;
  if (file.gbrain_commit !== build.gbrain_commit) return 'eval_gates_commit_mismatch';
  if (file.rust_addon_sha256 !== i.epoch.inputs.rust_addon_sha256) return 'eval_gates_addon_mismatch';
  if (i.storeFormat === null || file.engine_format_version !== i.storeFormat) return 'eval_gates_format_mismatch';
  for (const gate of GATE_NAMES) {
    const verdict = file.gates[gate].verdict;
    if (verdict === 'NOT_RUN') return `eval_gates_not_run:${gate}`;
    if (verdict === 'FAIL') return `eval_gates_failed:${gate}`;
  }
  return null;
}

export const cachePaths = (dir: string): { file: string; pin: string; fetch: string } => ({
  file: join(dir, 'drills', 'eval-gates.json'), pin: join(dir, 'drills', 'eval-gates.pin.json'), fetch: join(dir, 'drills', 'eval-gates.fetch.json'),
});

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; } // silent-read-ok: an absent or unreadable cache is `eval_gates_missing`, which fails closed
}

/** The store's format version from `<shadow dir>/store/FORMAT`, or null (a plain file read; the store is never opened). */
export function storeFormatVersion(dir: string): number | null {
  const raw = readText(join(dir, 'store', 'FORMAT'));
  if (raw === null) return null;
  try {
    const v = (JSON.parse(raw) as { format_version?: unknown }).format_version;
    return typeof v === 'number' && Number.isInteger(v) ? v : null;
  } catch { return null; } // silent-read-ok: no readable FORMAT is an unknown format, which fails closed
}

/** Status and the swap: the cached files against the epoch. No network, no store open. */
export function readEvalGatesVerdict(dir: string, epoch: EpochManifest | null, hostTarget: string | null): { passed: boolean; reason: string | null } {
  const paths = cachePaths(dir);
  const reason = evalGatesReason({ file: readText(paths.file), pin: readText(paths.pin), epoch, storeFormat: storeFormatVersion(dir), hostTarget });
  return { passed: reason === null, reason };
}

// ---- the fetch (drill --evals only) ----

export interface FetchDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** This host's addon target (`detectAddonTarget()`); the caller passes it so this module has no dependency to install. */
  hostTarget: string | null;
}

class FetchRefused extends Error {}
const GITHUB_HOST = /(^|\.)(github\.com|githubusercontent\.com)$/;

/** One GET with a time limit, a size cap and redirects only to https GitHub hosts. The reason is a code, never a body. */
async function boundedGet(url: string, maxBytes: number, deps: FetchDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    let res: Response;
    try { res = await doFetch(current, { redirect: 'manual', signal }); } catch { throw new FetchRefused('eval_gates_fetch_failed'); }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      let next: URL | null = null;
      try { next = location ? new URL(location, current) : null; } catch { next = null; } // silent-read-ok: a bad Location is refused below
      if (!next || next.protocol !== 'https:' || !GITHUB_HOST.test(next.hostname)) throw new FetchRefused('eval_gates_fetch_redirect_refused');
      current = next.toString();
      continue;
    }
    if (res.status !== 200) throw new FetchRefused(`eval_gates_fetch_http_${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) throw new FetchRefused('eval_gates_fetch_failed');
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new FetchRefused('eval_gates_fetch_too_large'); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof FetchRefused) throw error;
      throw new FetchRefused('eval_gates_fetch_failed');
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new FetchRefused('eval_gates_fetch_redirect_refused');
}

/** The pin source: the release's own asset. Replace this one function to read pins from a committed file instead. */
export async function pinSource(tag: string, deps: FetchDeps): Promise<string> {
  return boundedGet(pinAssetUrl(tag), MAX_PIN_BYTES, deps);
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

export interface FetchResult { cached: boolean; reason: string | null; passed: boolean }

/** A directory this command started in, held open so that the same path can be told from a directory that took its place. */
export interface DirPin {
  /** True while the path still names the directory that was pinned: false once it was deleted, moved away or replaced. */
  live(): boolean;
  /** Releases the hold. Call it on every exit; a closed pin is never live. */
  close(): void;
}

/**
 * Pins a directory, or returns null when it is not there. A path stays the same directory only while it names the inode the
 * pin holds, and the pin is an open descriptor: the system cannot give a directory's inode number to a new directory while
 * any descriptor is open on it, so a directory deleted and recreated at the same path always reads as a different one.
 * (Comparing `dev:ino[:birth]` alone does not: ext4 hands the freed inode straight back after rmdir and mkdir, and a
 * filesystem without a stored creation time reports the same birth time for both.) No file is written into the directory, so
 * nothing of the pin shows in the directory or in anything published from it. Where a directory cannot be opened (Windows),
 * the pin falls back to `dev:ino:birth` at the time it was taken.
 */
export function pinDir(path: string): DirPin | null {
  let fd: number | null = null;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; } // silent-read-ok: a directory that cannot be opened falls back to the stat identity below
  // With a descriptor held the inode is the identity; without one the birth time joins it.
  const key = (st: Stats): string => (fd !== null ? `${st.dev}:${st.ino}` : `${st.dev}:${st.ino}:${st.birthtimeMs}`);
  let held: string;
  try {
    const st = fd !== null ? fstatSync(fd) : statSync(path);
    if (!st.isDirectory()) throw new Error('not a directory');
    held = key(st);
  } catch {
    if (fd !== null) { try { closeSync(fd); } catch { /* the descriptor is already unusable */ } }
    return null; // silent-read-ok: a directory that cannot be read has no identity to hold
  }
  let open = true;
  return {
    live: () => {
      if (!open) return false;
      try { return key(statSync(path)) === held; } catch { return false; } // silent-read-ok: a missing directory is the answer
    },
    close: () => {
      if (open && fd !== null) { try { closeSync(fd); } catch { /* released either way */ } }
      open = false;
    },
  };
}

/**
 * Downloads the pin of the epoch's release and the file it names, checks the file's SHA-256 against the pin, and
 * replaces the cache (the file first, then the pin: an interrupted write leaves a pair that does not match, which the
 * verdict reads as `eval_gates_digest_mismatch`). A failure keeps the old cache and records the attempt.
 *
 * It needs the shadow directory and its epoch to exist already and never creates the shadow root: `drills/` is made
 * without recursion, and every write checks that the shadow directory and `drills/` are still the ones it started in (held open, see `pinDir`).
 * A shadow deleted or replaced during the fetch (`stop --delete`) gets nothing written and the reason `shadow_gone`.
 */
export async function fetchEvalGates(dir: string, epoch: EpochManifest | null, deps: FetchDeps): Promise<FetchResult> {
  const held: DirPin[] = [];
  const pin = (path: string): DirPin | null => { const pinned = pinDir(path); if (pinned) held.push(pinned); return pinned; };
  try { return await fetchPinned(dir, epoch, deps, pin); } finally { for (const pinned of held) pinned.close(); }
}

async function fetchPinned(dir: string, epoch: EpochManifest | null, deps: FetchDeps, pin: (path: string) => DirPin | null): Promise<FetchResult> {
  const paths = cachePaths(dir);
  const now = deps.now ?? Date.now;
  const gone: FetchResult = { cached: false, reason: 'shadow_gone', passed: false };
  const rootPin = pin(dir);
  if (rootPin === null) return gone;
  if (!epoch) return { cached: false, reason: 'eval_gates_build_unknown', passed: false };
  const drills = join(dir, 'drills');
  try { mkdirSync(drills, { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return gone;
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const drillsPin = pin(drills);
  const live = (): boolean => drillsPin !== null && rootPin.live() && drillsPin.live();
  const write = (path: string, body: string): void => { if (!live()) throw new FetchRefused('shadow_gone'); writeAtomic(path, body); };
  const record = (reason: string | null): void => write(paths.fetch, JSON.stringify({ at: new Date(now()).toISOString(), reason }) + '\n');
  try {
    try {
      const build = epoch.build;
      if (!build || !build.gbrain_commit) throw new FetchRefused('eval_gates_build_unknown');
      const tag = `v${build.gbrain_version}`;
      if (!FINAL_TAG.test(tag)) throw new FetchRefused('eval_gates_provisional');
      const pinText = await pinSource(tag, deps);
      const pinned = pinProblem(pinText);
      if ('reason' in pinned) throw new FetchRefused(pinned.reason);
      const pin = pinned.pin;
      if (pin.gbrain_tag !== tag || pin.gbrain_commit !== build.gbrain_commit) throw new FetchRefused('eval_gates_commit_mismatch');
      const fileText = await boundedGet(pin.url, MAX_FILE_BYTES, deps);
      if (sha256(fileText) !== pin.sha256) throw new FetchRefused('eval_gates_digest_mismatch');
      write(paths.file, fileText);
      write(paths.pin, pinText);
      record(null);
    } catch (error) {
      if (!(error instanceof FetchRefused) || error.message === 'shadow_gone') throw error;
      record(error.message);
      return { cached: false, reason: error.message, passed: false };
    }
  } catch (error) {
    // A write that failed because the shadow went away is `shadow_gone`; any other failure is not hidden.
    if ((error instanceof FetchRefused && error.message === 'shadow_gone') || !live()) return gone;
    throw error;
  }
  if (!live()) return gone;
  const verdict = readEvalGatesVerdict(dir, epoch, deps.hostTarget);
  return { cached: true, reason: verdict.reason, passed: verdict.passed };
}

/** The last fetch attempt (`drill --evals`), for the status detail; null when none ran. */
export function readLastFetch(dir: string): { at: string; reason: string | null } | null {
  const raw = readText(cachePaths(dir).fetch);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { at?: unknown; reason?: unknown };
    return typeof v.at === 'string' && (v.reason === null || typeof v.reason === 'string') ? { at: v.at, reason: v.reason as string | null } : null;
  } catch { return null; } // silent-read-ok: the attempt record is diagnostic only
}
