/**
 * gbrain transcripts — session transcripts: recent corpus reads and the
 * cathedral-4 import lane.
 *
 *   gbrain transcripts recent   — dream-corpus .txt reader (v0.29 surface).
 *   gbrain transcripts ingest   — import dead session logs (Claude Code,
 *                                 Codex, OpenClaw, Hermes) and consumer chat
 *                                 exports (ChatGPT, Claude.ai) into
 *                                 conversation pages. Local-only, explicit
 *                                 paths are trusted CLI input; embedding is
 *                                 OFF by default (bulk imports defer to the
 *                                 embed backfill lane).
 *
 * PGLite note: like every engine-opening command, ingest cannot run while
 * `gbrain serve` holds the single-writer lock — the lock error names the PID.
 */

import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import type { TranscriptFormat } from '../core/transcripts/types.ts';
import { runTranscriptsIngest, type TranscriptsIngestResult } from '../core/transcripts/ingest.ts';
import { isOpenclawCheckpointFile } from '../core/transcripts/openclaw.ts';

interface RecentOpts {
  days?: number;
  full?: boolean;
  limit?: number;
  json?: boolean;
}

function parseRecentArgs(args: string[]): RecentOpts | { help: true } {
  const opts: RecentOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--full') { opts.full = true; continue; }
    if (a === '--days') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n >= 0) opts.days = n;
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
      continue;
    }
  }
  return opts;
}

const FORMATS: readonly TranscriptFormat[] = [
  'claude-code',
  'codex',
  'openclaw',
  'hermes',
  'chatgpt',
  'claude-export',
];

interface IngestCliOpts {
  paths: string[];
  format?: TranscriptFormat;
  dryRun?: boolean;
  limit?: number;
  since?: string;
  source?: string;
  facts?: boolean;
  maxCostUsd?: number;
  /** gbrain#4149: explicit per-format byte-cap override; undefined = adapter-native defaults. */
  maxBytes?: number;
  embed?: boolean;
  all?: boolean;
  json?: boolean;
  quiet?: boolean;
  /** #4472: include gbrain's own claude-cli subprocess sessions in discovery. */
  includeSelf?: boolean;
}

/**
 * gbrain#4149: the checkpoint fingerprint input, extracted so the cap
 * dimension is unit-testable — a `--since last` watermark written under one
 * cap must never be reused under another (or the auto defaults).
 */
export function ingestCheckpointFingerprintInput(args: {
  sourceId: string;
  pathspec: string | string[];
  format: string;
  version: string | number;
  maxBytes?: number;
}): Record<string, string | number | string[]> {
  return {
    sourceId: args.sourceId,
    pathspec: args.pathspec,
    format: args.format,
    version: args.version,
    // Key present ONLY for an explicit cap (review finding, multi-specialist
    // confirmed): an unconditional `maxBytes: 'auto'` would re-hash EVERY
    // pre-existing watermark at upgrade and silently force a one-time full
    // rescan. Omitting the key keeps the default path on the legacy
    // fingerprint; every explicit cap still gets its own scope.
    ...(args.maxBytes != null ? { maxBytes: args.maxBytes } : {}),
  };
}

export function parseIngestArgs(args: string[]): IngestCliOpts | { help: true } | { error: string } {
  const opts: IngestCliOpts = { paths: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--quiet') { opts.quiet = true; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--embed') { opts.embed = true; continue; }
    if (a === '--facts') { opts.facts = true; continue; }
    if (a === '--all') { opts.all = true; continue; }
    if (a === '--include-self') { opts.includeSelf = true; continue; }
    if (a === '--format') {
      const v = args[++i] as TranscriptFormat | undefined;
      if (!v || !FORMATS.includes(v)) {
        return { error: `unknown format '${v ?? ''}' (expected one of: ${FORMATS.join(', ')})` };
      }
      opts.format = v;
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(args[++i] ?? '', 10);
      if (!Number.isFinite(n) || n <= 0) return { error: 'limit must be a positive integer' };
      opts.limit = n;
      continue;
    }
    if (a === '--since') {
      const v = args[++i];
      if (!v) return { error: 'since needs an ISO timestamp or the word last' };
      if (v !== 'last') {
        // Validate + Z-normalize: the filter compares lexicographically
        // against Z-form ISO, so an offset-form or garbage value would
        // silently mis-filter (and a filtered-everything run would still
        // look clean).
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) {
          return { error: `since needs a parseable ISO timestamp or the word last (got '${v}')` };
        }
        opts.since = d.toISOString();
        continue;
      }
      opts.since = v;
      continue;
    }
    if (a === '--source-id' || a === '--source') {
      const v = args[++i];
      if (!v) return { error: 'source-id needs a value' };
      opts.source = v;
      continue;
    }
    if (a === '--max-cost-usd') {
      const n = parseFloat(args[++i] ?? '');
      if (!Number.isFinite(n) || n <= 0) return { error: 'max-cost-usd must be a positive number' };
      opts.maxCostUsd = n;
      continue;
    }
    if (a === '--max-bytes') {
      // gbrain#4149: optional VALIDATED override for the per-format byte
      // caps (e.g. the Hermes store guard). Omission preserves each
      // adapter's native default — one global cap must not replace
      // format-specific safety limits. Accepts plain bytes or kb/mb/gb.
      const raw = (args[++i] ?? '').toLowerCase();
      const m = raw.match(/^(\d+(?:\.\d+)?)(kb|mb|gb)?$/);
      if (!m) return { error: `max-bytes must be a positive size like 800000000, 512mb, or 4gb (got '${raw || ''}')` };
      const mult = m[2] === 'kb' ? 1024 : m[2] === 'mb' ? 1024 ** 2 : m[2] === 'gb' ? 1024 ** 3 : 1;
      const n = Math.floor(parseFloat(m[1]) * mult);
      if (!Number.isFinite(n) || n <= 0) return { error: 'max-bytes must resolve to a positive byte count' };
      opts.maxBytes = n;
      continue;
    }
    if (a.startsWith('-')) return { error: `unknown flag ${a}` };
    opts.paths.push(a);
  }
  return opts;
}

const HELP = `Usage:
  gbrain transcripts ingest <path-or-glob>... [options]
  gbrain transcripts ingest              # discovery: show found session logs
  gbrain transcripts ingest --all        # import everything discovered
  gbrain transcripts status              # found vs imported gap table
  gbrain transcripts recent [options]

ingest — import dead session logs and chat exports as conversation pages
(readable text-turn archive: user/assistant text only, secrets redacted,
long sessions split into searchable parts). Re-runs are free (content-hash
skip). Embedding is OFF by default; run the embed backfill later or opt in.

  --all             Import every session log discovered under the harness
                    roots (claude/codex/openclaw projects + the hermes store)
  --include-self    Also discover gbrain's OWN claude-cli subprocess sessions
                    (recorded by Claude Code for the provider's scratch cwds;
                    excluded by default to avoid a self-ingestion loop)
  --format F        claude-code | codex | openclaw | hermes | chatgpt |
                    claude-export (auto-detected when omitted)
  --dry-run         Parse + redact + report; writes nothing
  --limit N         Max sessions this run
  --since T         Only sessions newer than ISO time T; the word "last"
                    resumes from the previous clean run
  --source-id S     Target source (default: the canonical 6-tier resolution)
  --embed           Embed pages at import (default: defer to embed backfill)
  --facts           Extract facts from imported pages (budget-capped)
  --max-cost-usd F  Facts budget cap (default 5)
  --max-bytes N     Override the per-format file/store byte caps (e.g. 4gb
                    for a multi-GB hermes store). Omit to keep each
                    format's native safety default. Changing it starts a
                    fresh --since last scope (caps are part of the
                    checkpoint fingerprint). Adapters differ over budget:
                    codex degrades to a bounded head+tail read, while
                    claude-code, openclaw and hermes reject the file
                    outright — so LOWERING this can drop those formats
  --json            Machine-readable result
  --quiet           Suppress the human summary

recent — read recent raw dream-corpus transcripts (.txt), newest first:
  --days N          Window in days (default 7)
  --limit N         Max transcripts (default 50)
  --full            Full content, capped 100KB/file (default: short summary)
  --json            JSON output for agents
  Dream-generated outputs (frontmatter dream_generated: true) are skipped.

Notes: consumer exports must be unzipped first (pass conversations.json).
On PGLite, stop gbrain serve first (single-writer lock).
`;

/** Extensions the importer understands; directory expansion filters to these. */
const IMPORTABLE_EXTENSIONS = ['.jsonl', '.db', '.json'];

/**
 * Expand path-or-glob args. Directory specs filter to importable extensions —
 * without the filter, every stray file in a real directory (macOS Finder
 * metadata, editor backups, READMEs) becomes a permanent per-file error that
 * breaks cleanScan on every run, silently killing the since-last resume for
 * directory scopes. Checkpoint snapshots are never imported.
 */
async function expandPaths(specs: string[]): Promise<string[]> {
  const { statSync } = await import('node:fs');
  const out: string[] = [];
  for (const spec of specs) {
    let matched = false;
    try {
      if (statSync(spec).isFile()) {
        out.push(spec);
        continue;
      }
      if (statSync(spec).isDirectory()) {
        const glob = new Bun.Glob('**/*');
        for (const p of glob.scanSync({ cwd: spec, absolute: true, onlyFiles: true })) {
          if (IMPORTABLE_EXTENSIONS.some((ext) => p.endsWith(ext))) out.push(p);
        }
        continue;
      }
    } catch {
      // Not a literal path — try as a glob below.
    }
    const glob = new Bun.Glob(spec);
    for (const p of glob.scanSync({ cwd: process.cwd(), absolute: true, onlyFiles: true })) {
      out.push(p);
      matched = true;
    }
    if (!matched && !out.includes(spec)) {
      // Keep the unmatched spec so the per-file error names it.
      out.push(spec);
    }
  }
  return [...new Set(out)].filter((p) => !isOpenclawCheckpointFile(p));
}

export function fmtSummary(r: TranscriptsIngestResult): string {
  const byHarness = new Map<string, number>();
  for (const f of r.files) {
    for (const s of f.sessions) {
      if (!s.error) byHarness.set(s.harness, (byHarness.get(s.harness) ?? 0) + 1);
    }
  }
  const lines: string[] = [];
  const counts = [...byHarness.entries()].map(([h, n]) => `${h}: ${n}`).join(', ');
  lines.push(
    `sessions: ${r.sessionsImported} imported (${counts || 'none'}), ` +
      `${r.sessionsFiltered} filtered, ${r.sessionsErrored} errored, ${r.sessionsSeen} seen`,
  );
  lines.push(
    `pages: ${r.pages.imported} imported, ${r.pages.skipped} unchanged` +
      (r.pages.errored ? `, ${r.pages.errored} ERRORED` : '') +
      (r.pages.planned ? `, ${r.pages.planned} planned (dry run)` : '') +
      (r.partsDeleted ? `, ${r.partsDeleted} stale parts deleted` : ''),
  );
  if (r.redactions > 0) lines.push(`redactions: ${r.redactions} secrets/patterns redacted before write`);
  if (r.imperatives > 0) lines.push(`flagged: ${r.imperatives} agent-directed imperative(s) noted in frontmatter`);
  if (r.driftFiles > 0) {
    lines.push(
      `DRIFT WARNING: ${r.driftFiles} file(s) parsed to zero sessions — the host ` +
        `format may have changed; see the adapter SPEC_TARGET runbook`,
    );
  }
  if (r.truncatedFiles > 0) {
    lines.push(
      `TRUNCATED: ${r.truncatedFiles} file(s) only partially scanned (byte cap) — ` +
        `watermark frozen; re-run with a larger --max-bytes to cover the skipped window`,
    );
  }
  for (const f of r.files) {
    if (f.error) lines.push(`error: ${f.path}: ${f.error}`);
    for (const s of f.sessions) {
      if (s.error) lines.push(`error: ${f.path} session ${s.sessionId}: ${s.error}`);
    }
  }
  return lines.join('\n');
}

async function runIngest(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parseIngestArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  if ('error' in parsed) {
    console.error(`gbrain transcripts ingest: ${parsed.error}`);
    setCliExitVerdict(2);
    return;
  }
  // The watermark fingerprint binds the USER-STATED spec, captured BEFORE
  // discovery expands it — binding expanded file lists would mint a new
  // fingerprint every time a harness writes a new session, so the all-lane
  // since-last would never resume. Specs are RESOLVED first: the same
  // relative spec from two different cwds names different scopes (must not
  // share a watermark), and equivalent spellings of one dir must not
  // fragment into separate watermarks.
  const { resolve } = await import('node:path');
  const { hostname } = await import('node:os');
  // The all-lane scope is THIS machine's harness roots, so the fingerprint
  // carries host + roots: checkpoints are DB-backed and shared across every
  // machine on the brain — a bare literal would let machine B inherit
  // machine A's watermark and silently skip local sessions it never scanned.
  const { harnessRoots } = await import('../core/transcripts/detect.ts');
  const checkpointSpec =
    parsed.paths.length === 0
      ? ['--all-discovery', hostname(), ...harnessRoots().map((r) => r.root).sort()]
      : [...parsed.paths].map((p) => resolve(p)).sort();

  // No paths: discovery. Without the all flag, show what WOULD be imported
  // and stop (a safe default for a command that can touch four harness
  // histories); with it, import the discovered set.
  if (parsed.paths.length === 0) {
    const { discoverTranscriptFiles } = await import('../core/transcripts/discover.ts');
    // #4472: discovery excludes gbrain's own claude-cli subprocess sessions
    // (self-ingestion loop) unless --include-self is passed.
    const discovered = discoverTranscriptFiles(undefined, { includeSelf: parsed.includeSelf });
    if (discovered.length === 0) {
      console.log('discovery: no session logs found under the harness roots');
      return;
    }
    if (!parsed.all) {
      const byFormat = new Map<string, { n: number; bytes: number }>();
      for (const d of discovered) {
        const cur = byFormat.get(d.format) ?? { n: 0, bytes: 0 };
        cur.n++;
        cur.bytes += d.bytes;
        byFormat.set(d.format, cur);
      }
      console.log('discovery (nothing imported yet — add the all flag to import):');
      for (const [format, { n, bytes }] of byFormat) {
        console.log(`  ${format.padEnd(12)} ${String(n).padStart(5)} file(s)  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
      }
      console.log('  tip: `gbrain transcripts status` shows found vs imported per harness');
      return;
    }
    parsed.paths = discovered.map((d) => d.path);
  }

  // Source: the canonical 6-tier chain (capture.ts pattern) — one resolved
  // id threads import + raw-data + reconciliation + checkpoint fingerprint.
  let sourceId = 'default';
  try {
    const { resolveSourceWithTier } = await import('../core/source-resolver.ts');
    const r = await resolveSourceWithTier(engine, parsed.source ?? null);
    sourceId = r.source_id;
  } catch (e) {
    console.error(`gbrain transcripts ingest: ${e instanceof Error ? e.message : String(e)}`);
    setCliExitVerdict(1);
    return;
  }

  // Active pack ONCE per command (never per file).
  let activePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;
  try {
    const { loadActivePack } = await import('../core/schema-pack/load-active.ts');
    const { loadConfig } = await import('../core/config.ts');
    const resolved = await loadActivePack({ cfg: loadConfig(), remote: false, sourceId });
    activePack = { page_types: resolved.manifest.page_types };
  } catch {
    activePack = undefined;
  }

  const paths = await expandPaths(parsed.paths);
  if (paths.length === 0) {
    console.error('gbrain transcripts ingest: 0 files matched');
    return;
  }

  // --since last → op-checkpoint watermark (speed convenience only; the
  // status gap table is the correctness surface). Fingerprint binds
  // source + pathspec + format + adapter version so a second source or a
  // different root never inherits this watermark.
  const { fingerprint, loadOpCheckpoint, recordCompleted } = await import('../core/op-checkpoint.ts');
  const { TRANSCRIPT_IMPORT_VERSION } = await import('../core/transcripts/render.ts');
  const checkpointKey = {
    op: 'transcripts-ingest',
    // gbrain#4149: the effective cap is part of scan coverage — a checkpoint
    // written under a different cap (or the auto defaults) must not be
    // silently reused, or a capped run's skipped tail reads as
    // already-imported. The input builder distinguishes 'auto' from every
    // explicit value.
    fingerprint: fingerprint(ingestCheckpointFingerprintInput({
      sourceId,
      pathspec: checkpointSpec,
      format: parsed.format ?? 'auto',
      version: TRANSCRIPT_IMPORT_VERSION,
      maxBytes: parsed.maxBytes,
    })),
  };
  let sinceIso = parsed.since;
  if (parsed.since === 'last') {
    sinceIso = undefined;
    const keys = await loadOpCheckpoint(engine, checkpointKey);
    for (const k of keys) {
      if (k.startsWith('since:')) {
        const v = k.slice('since:'.length);
        if (!sinceIso || v > sinceIso) sinceIso = v;
      }
    }
    if (!sinceIso && !parsed.quiet) {
      console.error('transcripts ingest: no previous clean run for this scope — full scan');
    }
  }

  const { createProgress } = await import('../core/progress.ts');
  const { cliOptsToProgressOptions, getCliOptions } = await import('../core/cli-options.ts');
  const reporter = createProgress(cliOptsToProgressOptions(getCliOptions()));
  reporter.start('transcripts.ingest', paths.length);

  let result: TranscriptsIngestResult;
  try {
    result = await runTranscriptsIngest(engine, {
      paths,
      format: parsed.format,
      dryRun: parsed.dryRun,
      limit: parsed.limit,
      sinceIso,
      sourceId,
      maxBytes: parsed.maxBytes,
      embed: parsed.embed,
      activePack,
      onFileDone: () => reporter.tick(),
      // Multi-session stores (one hermes state.db = thousands of sessions)
      // need liveness BETWEEN file ticks.
      onSession: (sessionId) => reporter.heartbeat(`session ${sessionId.slice(0, 12)}`),
    });
  } finally {
    reporter.finish();
  }

  if (!parsed.embed && !parsed.dryRun && result.pages.imported > 0 && !parsed.quiet) {
    console.error(
      'note: pages imported without embeddings (default) — run the embed backfill ' +
        'or re-run with the embed flag to make them vector-searchable now',
    );
  }

  // Watermark: advance ONLY on a clean, untruncated, non-dry scan — and only
  // when the run ATTESTED full coverage (no since bound, or since=last). An
  // explicit since run never scanned below its cutoff and must not vouch for
  // sessions there.
  const attestsCoverage = parsed.since === undefined || parsed.since === 'last';
  if (result.cleanScan && result.maxSessionTs && attestsCoverage) {
    await recordCompleted(engine, checkpointKey, [`since:${result.maxSessionTs}`]);
  }

  // --facts: ONE extractor invocation over every touched slug (including
  // hash-skipped pages — the extractor's version-token gate dedupes work).
  let factsSummary: { pages: number; spentUsd?: number } | undefined;
  if (parsed.facts && !parsed.dryRun && result.slugsTouched.length > 0) {
    const { runIngestFacts } = await import('../core/transcripts/ingest-facts.ts');
    factsSummary = await runIngestFacts(engine, {
      sourceId,
      slugs: [...new Set(result.slugsTouched)],
      maxCostUsd: parsed.maxCostUsd,
      quiet: parsed.quiet,
    });
  }

  if (parsed.json) {
    console.log(JSON.stringify({ ...result, facts: factsSummary ?? null, source_id: sourceId }, null, 2));
  } else if (!parsed.quiet) {
    console.log(fmtSummary(result));
    if (factsSummary) {
      console.log(
        `facts: extracted over ${factsSummary.pages} page(s)` +
          (factsSummary.spentUsd !== undefined ? `, ~$${factsSummary.spentUsd.toFixed(2)} spent` : ''),
      );
    }
    const firstImported = result.files.flatMap((f) => f.sessions).find((s) => !s.error && s.baseSlug);
    if (firstImported && !parsed.dryRun) {
      console.log(`try it: gbrain query "${firstImported.baseSlug.split('/').pop()}"`);
    }
  }

  const allFailed =
    result.files.length > 0 &&
    result.files.every((f) => f.error !== undefined || (f.drift && f.sessions.length === 0));
  if (allFailed) setCliExitVerdict(1);
}

async function runStatus(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  let sourceId = 'default';
  try {
    const { resolveSourceWithTier } = await import('../core/source-resolver.ts');
    sourceId = (await resolveSourceWithTier(engine, null)).source_id;
  } catch {
    // Fall through with default — status is read-only.
  }
  const { buildStatusRows, discoverTranscriptFiles, indexImportedSessions } = await import(
    '../core/transcripts/discover.ts'
  );
  const rows = buildStatusRows(discoverTranscriptFiles(), await indexImportedSessions(engine, sourceId));
  if (json) {
    console.log(JSON.stringify({ source_id: sourceId, rows }, null, 2));
    return;
  }
  console.log(`transcripts status (source: ${sourceId})`);
  console.log('  harness       found   imported-sessions   not-yet-imported');
  for (const r of rows) {
    const gap = r.gapFiles === null ? '(store-level; run ingest to see)' : String(r.gapFiles);
    console.log(
      `  ${r.format.padEnd(12)} ${String(r.found).padStart(6)} ${String(r.importedSessions).padStart(12)}        ${gap}`,
    );
  }
  const totalGap = rows.reduce((n, r) => n + (r.gapFiles ?? 0), 0);
  if (totalGap > 0) {
    console.log(`  backfill: gbrain transcripts ingest --all   (${totalGap} file(s) waiting)`);
  }
}

export async function runTranscripts(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'ingest') {
    await runIngest(engine, args.slice(1));
    return;
  }
  if (sub === 'status') {
    await runStatus(engine, args.slice(1));
    return;
  }
  if (sub !== 'recent') {
    console.log(HELP);
    if (sub && sub !== '--help' && sub !== '-h') setCliExitVerdict(2);
    return;
  }

  const parsed = parseRecentArgs(args.slice(1));
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  const { listRecentTranscripts } = await import('../core/transcripts.ts');
  const rows = await listRecentTranscripts(engine, {
    days: parsed.days,
    summary: !parsed.full,
    limit: parsed.limit,
  });
  if (parsed.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('(no recent transcripts in the corpus dir)');
    return;
  }
  rows.forEach(r => {
    const date = r.date ?? r.mtime.slice(0, 10);
    console.log(`\n--- ${date} | ${r.path} | ${r.length} bytes ---`);
    console.log(r.summary);
  });
}
