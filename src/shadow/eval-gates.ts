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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** Strict parse of the pin; the URL must be the commit-pinned raw path of the file the pin names, and nothing else. */
export function parsePin(raw: string): EvalGatesPin | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; } // silent-read-ok: unparseable text is the typed marker
  if (!isObject(v) || v.schema_version !== 1) return null;
  const { gbrain_tag: tag, gbrain_commit: commit, evals_commit: evals, evals_ref: ref, path, url, sha256: digest, target } = v;
  if (!text(tag) || !FINAL_TAG.test(tag) || !HEX40.test(String(commit)) || !text(evals) || !/^[A-Za-z0-9._-]+$/.test(evals) || !HEX40.test(String(ref))) return null;
  if (!HEX64.test(String(digest)) || !text(target) || path !== evalGatesPath(evals, tag) || url !== evalGatesUrl(String(ref), path)) return null;
  const m = PIN_URL.exec(url as string);
  return m && m[1] === ref && m[2] === tag && m[3] === evals ? v as unknown as EvalGatesPin : null;
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
  const pin = parsePin(i.pin);
  const file = parseEvalGatesFile(i.file);
  if (!pin || !file) return 'eval_gates_unreadable';
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

/**
 * Downloads the pin of the epoch's release and the file it names, checks the file's SHA-256 against the pin, and
 * replaces the cache (the file first, then the pin: an interrupted write leaves a pair that does not match, which the
 * verdict reads as `eval_gates_digest_mismatch`). A failure keeps the old cache and records the attempt.
 */
export async function fetchEvalGates(dir: string, epoch: EpochManifest | null, deps: FetchDeps): Promise<FetchResult> {
  const paths = cachePaths(dir);
  const now = deps.now ?? Date.now;
  mkdirSync(join(dir, 'drills'), { recursive: true, mode: 0o700 });
  const record = (reason: string | null): void => writeAtomic(paths.fetch, JSON.stringify({ at: new Date(now()).toISOString(), reason }) + '\n');
  try {
    const build = epoch?.build;
    if (!epoch || !build || !build.gbrain_commit) throw new FetchRefused('eval_gates_build_unknown');
    const tag = `v${build.gbrain_version}`;
    if (!FINAL_TAG.test(tag)) throw new FetchRefused('eval_gates_provisional');
    const pinText = await pinSource(tag, deps);
    const pin = parsePin(pinText);
    if (!pin) throw new FetchRefused('eval_gates_unreadable');
    if (pin.gbrain_tag !== tag || pin.gbrain_commit !== build.gbrain_commit) throw new FetchRefused('eval_gates_commit_mismatch');
    const fileText = await boundedGet(pin.url, MAX_FILE_BYTES, deps);
    if (sha256(fileText) !== pin.sha256) throw new FetchRefused('eval_gates_digest_mismatch');
    writeAtomic(paths.file, fileText);
    writeAtomic(paths.pin, pinText);
    record(null);
  } catch (error) {
    if (!(error instanceof FetchRefused)) throw error;
    record(error.message);
    return { cached: false, reason: error.message, passed: false };
  }
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
