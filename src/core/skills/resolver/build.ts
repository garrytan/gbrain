/**
 * `gbrain skills index build|status|remove`: the only writer of a catalog's
 * index. A build reads the source, picks the ranker variant, encodes the
 * index and publishes it under the catalog's build lease: index.bin first,
 * receipt.json last, each a durable rename. A remove renames the catalog
 * directory away and deletes it, so a remove during a build wins (the
 * build's publication then fails with skill_index_removed).
 *
 * Variant choice: T (triggers and routing rows weigh most) when at least a
 * quarter of the skills carry triggers or routing rows, else D. A rebuild
 * keeps T until the share falls below a fifth, so adding or removing one
 * triggered skill near the line does not reorder a live session.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { VERSION } from '../../../version.ts';
import { ResolverError } from './errors.ts';
import { ensureDir, readBounded, writeFileDurable } from './fsutil.ts';
import { CALIBRATION_SPLIT_SHA256, encodeIndex, HINT_CHARS, RANKER_ID, RANKER_VERSION, VARIANT_PARAMS, type Variant } from './index-format.ts';
import { listCatalogs, readReceipt } from './catalog-files.ts';
import { acquireLease, holdsLease, releaseLease, tryAcquireLease } from './lock.ts';
import { catalogDir, catalogFile, resolverHome, skillIndexRoot, validCatalogName, assertCatalogName } from './paths.ts';
import { gcSessions, loadSession, sessionKey } from './session.ts';
import { applyRouting, readBundledSource, readDirSources, readJsonSource, type DirFingerprint, type SkillRecord, type SkippedSkill, type SourceRead } from './sources.ts';
import { TOKENIZER_ID } from './tokenize.ts';
import { BLOCK_TOKEN_CAP, BLOCK_TOKENIZER, HARNESSES } from './block.ts';
import { readResolverSettings } from './config.ts';

export const RECEIPT_SCHEMA_VERSION = 1;
export const T_SHARE_ON = 0.25;
export const T_SHARE_KEEP = 0.2;
const BUILD_LEASE_MS = 120_000;

export interface BuildInput {
  catalog: string;
  dirs?: string[];
  bundled?: boolean;
  /** A file path, or the JSON text itself when read from stdin (fromJsonStdin). */
  fromJson?: string;
  fromJsonStdin?: boolean;
  routing?: string;
  harness?: string;
  /** project: a cloned repository's skills; its hints are never shown. */
  scope?: 'user' | 'project';
}

export interface BuildReceipt {
  schema_version: 1;
  gbrain_version: string;
  gbrain_commit: string | null;
  catalog: {
    name: string;
    catalog_hash: string;
    source: { kind: 'dir' | 'bundled' | 'json'; dirs?: string[]; stdin?: boolean; file?: string; snapshot?: 'source.json'; bundled_skills?: number };
    fingerprint_sha256: string | null;
    skill_count: number;
    skipped: SkippedSkill[];
    scope: 'user' | 'project';
    hints: 'shown' | 'names_only';
    harness: string | null;
    routing: { file: string; rows: number; unmatched: number; stat: [string, number, number] } | null;
  };
  ranker: { id: string; version: number; variant: Variant; params: (typeof VARIANT_PARAMS)[Variant]; calibration_split_sha256: string; tokenizer: string; k: number; hint_chars: number; trigger_share: number };
  index: { file: 'index.bin'; index_hash: string; size: number; n_terms: number; n_postings: number; truncated_skills: number };
  block: { token_cap: number; tokenizer: string };
  build: { args: string[]; rebuild_argv: string[] | null; ms: number; built_at: string; generation: number };
}

function gbrainCommit(): string | null {
  try {
    let d = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 6; i++, d = dirname(d)) {
      const git = join(d, '.git');
      if (!existsSync(git) || !statSync(git).isDirectory()) continue;
      const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(head)) return head;
      const ref = /^ref: (.+)$/.exec(head)?.[1];
      if (!ref) return null;
      if (existsSync(join(git, ref))) return readFileSync(join(git, ref), 'utf8').trim();
      const packed = existsSync(join(git, 'packed-refs')) ? readFileSync(join(git, 'packed-refs'), 'utf8') : '';
      return packed.split('\n').find(l => l.endsWith(` ${ref}`))?.split(' ')[0] ?? null;
    }
  } catch { /* compiled binary or unreadable */ }
  return null;
}

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const bodyHash = (s: SkillRecord) => sha(s.body);

/** sha256 over every effective input that affects ranking, eligibility or loading. */
export function catalogHash(skills: readonly SkillRecord[], skipped: readonly SkippedSkill[], routingRows: number, scope: string): string {
  const rows = skills.map(s => [s.id, s.name, s.description, s.whenToUse ?? '', s.triggers, s.routing, bodyHash(s), s.path ?? '', s.namespace ?? '']);
  const skips = skipped.map(k => [k.reason, k.id ?? '', k.path ?? '', k.kept ?? '']).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return sha(JSON.stringify({ v: 1, skills: rows, skipped: skips, routing_rows: routingRows, scope }));
}


export function chooseVariant(skills: readonly SkillRecord[], previous: Variant | undefined): { variant: Variant; share: number } {
  const share = skills.length ? skills.filter(s => s.triggers.length || s.routing.length).length / skills.length : 0;
  return { variant: share >= T_SHARE_ON || (previous === 'T' && share >= T_SHARE_KEEP) ? 'T' : 'D', share: Math.round(share * 1e4) / 1e4 };
}

/** The argv that rebuilds a catalog from what the receipt recorded (null for a stdin source: the adapter owns it). */
export function buildArgs(input: BuildInput): { args: string[]; fix: string[] | null } {
  const args = ['gbrain', 'skills', 'index', 'build', '--catalog', input.catalog];
  for (const d of input.dirs ?? []) args.push('--dir', resolve(d));
  if (input.bundled) args.push('--bundled');
  if (input.fromJson !== undefined) args.push('--from-json', input.fromJsonStdin ? '-' : resolve(input.fromJson));
  if (input.routing) args.push('--routing', resolve(input.routing));
  if (input.harness) args.push('--harness', input.harness);
  if (input.scope === 'project') args.push('--scope', 'project');
  return { args, fix: input.fromJsonStdin ? null : args };
}

function validateBuild(input: BuildInput): void {
  assertCatalogName(input.catalog);
  const kinds = [input.dirs?.length ? 1 : 0, input.bundled ? 1 : 0, input.fromJson !== undefined ? 1 : 0].reduce((a, b) => a + b, 0);
  if (kinds !== 1) throw new ResolverError('skill_resolve_invalid_input', 'Pass exactly one source: --dir <d> (repeatable), --bundled or --from-json <file|->.', { suggestion: 'Example: gbrain skills index build --catalog claude-user --dir ~/.claude/skills' });
  if (input.harness !== undefined && !(HARNESSES as readonly string[]).includes(input.harness)) {
    throw new ResolverError('skill_resolve_invalid_input', `Unknown harness "${input.harness}".`, { suggestion: `Use one of: ${HARNESSES.join(', ')}.` });
  }
  if (input.scope !== undefined && input.scope !== 'user' && input.scope !== 'project') throw new ResolverError('skill_resolve_invalid_input', 'The scope is user or project.', { suggestion: 'Pass --scope user (the default) or --scope project.' });
}

async function readSource(input: BuildInput): Promise<SourceRead> {
  if (input.dirs?.length) return readDirSources(input.dirs);
  if (input.bundled) return readBundledSource();
  const text = input.fromJsonStdin ? input.fromJson! : (() => {
    const b = readBounded(input.fromJson!, 8 * 1024 * 1024);
    if (b === 'too_large') throw new ResolverError('skill_source_invalid', 'The JSON catalog is over 8 MB.', { suggestion: 'Pass at most 10,000 skills in at most 8 MB.' });
    return b.toString('utf8');
  })();
  return readJsonSource(text);
}

interface Prepared { records: SkillRecord[]; skipped: SkippedSkill[]; source: SourceRead; routing: BuildReceipt['catalog']['routing']; catalog_hash: string }

/**
 * File mtimes come from a coarse clock (one kernel tick, 4 ms on most Linux
 * hosts), so an edit in the tick a build stats an entry keeps that entry's
 * mtime and the stat tier never sees it. A build whose newest stat is under
 * this old waits it out and reads the source again, so every published stat
 * predates the tick any later edit lands in.
 */
export const RACY_MTIME_MS = 25;
const RACY_REREADS = 2;

function newestStat(source: SourceRead, routing: [string, number, number] | undefined): number {
  let newest = routing?.[2] ?? -Infinity;
  for (const [, m] of source.fingerprint?.dirs ?? []) if (m > newest) newest = m;
  for (const [, , m] of source.fingerprint?.files ?? []) if (m > newest) newest = m;
  return newest;
}

async function prepare(input: BuildInput): Promise<Prepared> {
  let source = await readSource(input);
  let routingInfo = input.routing ? applyRouting(source.skills, input.routing) : null;
  for (let reread = 0; source.fingerprint && reread < RACY_REREADS; reread++) {
    const wait = newestStat(source, routingInfo?.stat) + RACY_MTIME_MS - Date.now();
    if (wait <= 0) break;
    await new Promise(r => setTimeout(r, wait));
    source = await readSource(input);
    routingInfo = input.routing ? applyRouting(source.skills, input.routing) : null;
  }
  const records = [...source.skills].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const scope = input.scope ?? 'user';
  return {
    records, skipped: source.skipped, source,
    routing: routingInfo ? { file: routingInfo.stat[0], rows: routingInfo.rows, unmatched: routingInfo.unmatched, stat: routingInfo.stat } : null,
    catalog_hash: catalogHash(records, source.skipped, routingInfo?.rows ?? 0, scope),
  };
}

const removedError = () => new ResolverError('skill_index_removed', 'The catalog was removed while this build ran, so nothing was published.', { suggestion: 'Run the build again if the catalog should exist.' });

export async function buildSkillIndex(input: BuildInput, opts: { home?: string; now?: () => number } = {}): Promise<BuildReceipt> {
  const started = performance.now();
  validateBuild(input);
  const home = opts.home ?? resolverHome();
  const dir = catalogDir(home, input.catalog);
  ensureDir(dir);
  const previous = readReceipt(home, input.catalog);
  const lease = await acquireLease(join(dir, 'lock'), { purpose: 'build', leaseMs: BUILD_LEASE_MS, generation: (previous?.build.generation ?? 0) + 1, retries: 3, waitMs: 250, now: opts.now });
  const { args, fix } = buildArgs(input);
  try {
    const p = await prepare(input);
    const { variant, share } = chooseVariant(p.records, previous?.ranker.variant);
    const { bytes, truncatedSkills } = encodeIndex(p.records, variant);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(44, 44 + new DataView(bytes.buffer).getUint32(8, true))));
    const scope = input.scope ?? 'user';
    const receipt: BuildReceipt = {
      schema_version: RECEIPT_SCHEMA_VERSION, gbrain_version: VERSION, gbrain_commit: gbrainCommit(),
      catalog: {
        name: input.catalog, catalog_hash: p.catalog_hash,
        source: p.source.kind === 'dir' ? { kind: 'dir', dirs: input.dirs!.map(d => resolve(d)) }
          : p.source.kind === 'bundled' ? { kind: 'bundled', bundled_skills: p.records.length }
          : { kind: 'json', snapshot: 'source.json', ...(input.fromJsonStdin ? { stdin: true } : { file: resolve(input.fromJson!) }) },
        fingerprint_sha256: p.source.fingerprint ? sha(JSON.stringify(p.source.fingerprint)) : null,
        skill_count: p.records.length, skipped: p.skipped, scope, hints: scope === 'project' ? 'names_only' : 'shown', harness: input.harness ?? null, routing: p.routing,
      },
      ranker: { id: RANKER_ID, version: RANKER_VERSION, variant, params: VARIANT_PARAMS[variant], calibration_split_sha256: CALIBRATION_SPLIT_SHA256, tokenizer: TOKENIZER_ID, k: 5, hint_chars: HINT_CHARS, trigger_share: share },
      index: { file: 'index.bin', index_hash: sha(bytes), size: bytes.length, n_terms: header.n_terms, n_postings: header.n_postings, truncated_skills: truncatedSkills },
      block: { token_cap: BLOCK_TOKEN_CAP, tokenizer: BLOCK_TOKENIZER },
      build: { args, rebuild_argv: fix, ms: 0, built_at: new Date((opts.now ?? Date.now)()).toISOString(), generation: lease.record.generation },
    };
    if (!holdsLease(lease) || !existsSync(dir)) throw removedError();
    try {
      if (p.source.kind === 'json') writeFileDurable(join(dir, 'source.json'), p.source.snapshot!);
      if (p.source.fingerprint) writeFileDurable(join(dir, 'fingerprint.json'), JSON.stringify({ fingerprint: p.source.fingerprint, routing: p.routing?.stat ?? null }));
      writeFileDurable(join(dir, 'index.bin'), bytes);
      receipt.build.ms = Math.round(performance.now() - started);
      writeFileDurable(join(dir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw removedError();
      throw e;
    }
    for (const f of ['stale.stamp', 'stat-check', 'build.log']) { try { rmSync(join(dir, f), { force: true }); } catch { /* none */ } }
    gcSessions(home, (opts.now ?? Date.now)());
    return receipt;
  } catch (e) {
    try {
      if (existsSync(dir)) writeFileDurable(join(dir, 'build.log'), `${JSON.stringify({ at: new Date().toISOString(), code: e instanceof ResolverError ? e.code : 'skill_resolver_internal', message: e instanceof ResolverError ? e.message : (e as Error).name })}\n`);
    } catch { /* best effort */ }
    throw e;
  } finally {
    releaseLease(lease);
  }
}


export async function removeSkillIndex(name: string, opts: { home?: string } = {}): Promise<{ catalog: string; removed: boolean }> {
  const home = opts.home ?? resolverHome();
  const dir = catalogDir(home, name);
  if (!existsSync(dir)) return { catalog: name, removed: false };
  const trash = join(skillIndexRoot(home), `.removed-${name}-${randomBytes(6).toString('hex')}`);
  renameSync(dir, trash);
  rmSync(trash, { recursive: true, force: true });
  return { catalog: name, removed: true };
}

export interface CatalogStatus {
  catalog: string;
  present: boolean;
  fresh: boolean | null;
  stale_reason: string | null;
  index_verified: boolean;
  receipt: Pick<BuildReceipt, 'gbrain_version'> & { catalog_hash: string; index_hash: string; skill_count: number; skipped: number; variant: Variant; source: BuildReceipt['catalog']['source']; built_at: string; generation: number; rebuild_argv: string[] | null } | null;
  rebuild: { running: boolean; holder: string | null; stale_stamp: boolean; last_error: { code: string; message: string; at: string } | null; log_path: string | null };
}

/** Full (content-tier) status of one catalog: re-reads the source and re-hashes the index. */
export async function catalogStatus(name: string, opts: { home?: string } = {}): Promise<CatalogStatus> {
  const home = opts.home ?? resolverHome();
  const dir = catalogDir(home, name);
  const r = readReceipt(home, name);
  const logPath = join(dir, 'build.log');
  let lastError: CatalogStatus['rebuild']['last_error'] = null;
  try { lastError = JSON.parse(readFileSync(logPath, 'utf8')); } catch { /* none */ }
  const probe = existsSync(dir) ? tryAcquireLease(join(dir, 'lock'), { purpose: 'status-probe', leaseMs: 1 }) : null;
  let running = false;
  let holder: string | null = null;
  if (probe && 'token' in probe) releaseLease(probe);
  else if (probe && 'held' in probe) { running = true; holder = probe.held === 'unparsable' ? 'unknown' : `${probe.held.purpose} on ${probe.held.host} (pid ${probe.held.pid})`; }
  const rebuild = { running, holder, stale_stamp: existsSync(join(dir, 'stale.stamp')), last_error: lastError, log_path: lastError ? logPath : null };
  if (!r) return { catalog: name, present: false, fresh: null, stale_reason: existsSync(join(dir, 'index.bin')) ? 'receipt_missing' : 'index_missing', index_verified: false, receipt: null, rebuild };
  let indexVerified = false;
  try { indexVerified = sha(readFileSync(join(dir, 'index.bin'))) === r.index.index_hash; } catch { /* missing */ }
  let staleReason: string | null = indexVerified ? null : 'index_hash_mismatch';
  if (!staleReason && r.gbrain_version !== VERSION) staleReason = 'gbrain_version_changed';
  if (!staleReason) {
    try {
      const src = r.catalog.source;
      const input: BuildInput = { catalog: name, ...(src.kind === 'dir' ? { dirs: src.dirs } : src.kind === 'bundled' ? { bundled: true } : { fromJson: join(dir, 'source.json') }), ...(r.catalog.routing ? { routing: r.catalog.routing.file } : {}), scope: r.catalog.scope };
      const p = await prepare(input);
      if (p.catalog_hash !== r.catalog.catalog_hash) staleReason = src.kind === 'json' ? 'snapshot_changed' : 'source_changed';
    } catch (e) {
      staleReason = e instanceof ResolverError ? e.code : 'source_unreadable';
    }
  }
  gcSessions(home);
  return {
    catalog: name, present: true, fresh: staleReason === null, stale_reason: staleReason, index_verified: indexVerified,
    receipt: { gbrain_version: r.gbrain_version, catalog_hash: r.catalog.catalog_hash, index_hash: r.index.index_hash, skill_count: r.catalog.skill_count, skipped: r.catalog.skipped.length, variant: r.ranker.variant, source: r.catalog.source, built_at: r.build.built_at, generation: r.build.generation, rebuild_argv: r.build.rebuild_argv },
    rebuild,
  };
}

/** A session's budget and turn counters (for status --session). */
export function sessionStatus(sessionId: string, opts: { home?: string; harness?: string; shadow?: boolean } = {}) {
  const home = opts.home ?? resolverHome();
  const s = loadSession(home, sessionKey(opts.shadow ? 'shadow' : 'on', opts.harness, sessionId));
  const budget = readResolverSettings(home).sessionTokenBudget;
  return { session_id: sessionId, harness: opts.harness ?? null, shadow: Boolean(opts.shadow), turn: s.turn, spent: s.spent, budget, remaining: Math.max(0, budget - s.spent), suggested: Object.keys(s.last).length, reset: 'Only a compaction (or reset_session / --reset-session on the next turn) resets a session.' };
}

/**
 * The stat-tier check a turn runs: up to `limit` of the fingerprint's
 * directory and file entries from `cursor` (the routing file every time).
 * `next` is 0 once the sweep has covered every entry.
 */

export { listCatalogs, readReceipt };
