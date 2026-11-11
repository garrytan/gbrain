/**
 * gbrain transcripts — session transcripts: recent corpus reads and the
 * cathedral-4 import lane.
 *
 *   gbrain transcripts recent   — dream-corpus .txt reader (v0.29 surface).
 *   gbrain transcripts ingest   — import dead session logs (Claude Code,
 *                                 Codex, OpenClaw, Hermes, Grok) and consumer
 *                                 chat exports (ChatGPT, Claude.ai) into
 *                                 conversation pages. Local-only, explicit
 *                                 paths are trusted CLI input; embedding is
 *                                 OFF by default (bulk imports defer to the
 *                                 embed backfill lane).
 *
 * PGLite note: like every engine-opening command, ingest cannot run while
 * `gbrain serve` holds the single-writer lock — the lock error names the PID.
 */

import { homedir } from 'node:os';
import type { BrainEngine } from '../core/engine.ts';
import { helpFlagRequested } from '../cli/subcommands.ts';
import type { CliDispatchContext } from '../cli/command-table.ts';
import type { RecentTranscript } from '../core/transcripts.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import type { TranscriptFormat } from '../core/transcripts/types.ts';
import { runTranscriptsIngest, type TranscriptsIngestResult } from '../core/transcripts/ingest.ts';
import { isOpenclawCheckpointFile } from '../core/transcripts/openclaw.ts';
import {
  DEFAULT_HERMES_EXCLUDE_SOURCES,
  HERMES_EXCLUDE_NONE,
  normalizeExcludeSources,
  resolveHermesExcludePolicy,
  HERMES_SUBAGENT_SOURCE,
} from '../core/transcripts/hermes.ts';
import { splitSourceList } from '../core/config-list.ts';
import { isGrokSessionSidecarStrict } from '../core/transcripts/grok.ts';
import {
  isClaudeCodeSubagentFile,
  isClaudeCodeWorkflowArtifactFile,
  isClaudeCodeRemoteControlStateFile,
} from '../core/transcripts/claude-code.ts';

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
  'grok',
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
  /**
   * #8901: `--exclude-source` as given (normalized; `none` → []). undefined =
   * the flag was not passed, so the config key or the default decides.
   */
  excludeSources?: string[];
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
  /**
   * #8901: the EXPLICIT exclude set (flag or config key), sorted; undefined
   * when the default applies. Excluding FEWER sources (re-admitting some)
   * under an old watermark would skip the re-admitted sessions forever, so a
   * changed explicit set is a new scope. The default is not keyed: excluding
   * more never needs a rescan, and keying the default would re-scope every
   * existing watermark at upgrade. Keyed
   * only for `format` hermes or auto (a path that may be a Hermes store): an
   * explicit codex/claude-code/grok/openclaw run ignores the set, so setting
   * the config key must not re-scope those watermarks.
   */
  excludeSources?: readonly string[];
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
    ...(args.excludeSources != null && (args.format === 'hermes' || args.format === 'auto') ? { excludeSources: [...args.excludeSources].sort() } : {}),
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
    if (a === '--exclude-source') {
      // #8901: a comma list of Hermes session sources, or `none` to turn every
      // exclusion off for this run. A missing value or a flag-shaped one is an
      // error, never swallowed as the list.
      const raw = args[++i];
      if (raw === undefined || raw === '' || raw.startsWith('-')) {
        return { error: `exclude-source needs a comma list of session sources (e.g. cron,subagent) or the word ${HERMES_EXCLUDE_NONE}` };
      }
      const items = splitSourceList(raw);
      if (items.length === 0) {
        // `,` or spaces: not the off switch (that is the word `none`), so a
        // value that lists nothing is refused rather than read as "exclude
        // nothing" (fail closed).
        return { error: `exclude-source lists no session sources (got '${raw}'); use a comma list or the word ${HERMES_EXCLUDE_NONE}` };
      }
      if (items.includes(HERMES_EXCLUDE_NONE) && items.length > 1) {
        return { error: `exclude-source: ${HERMES_EXCLUDE_NONE} cannot be combined with other sources (got '${raw}')` };
      }
      opts.excludeSources = normalizeExcludeSources(items);
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
  gbrain transcripts recover codex       # restore user turns lost to #5163 (preview; --apply)
  gbrain transcripts audit-secrets       # list imported pages that still carry a credential (read-only)
  gbrain transcripts recent [options]

ingest — import dead session logs and chat exports as conversation pages
(readable text-turn archive: user/assistant text only, secrets redacted,
long sessions split into searchable parts). Re-runs are free (content-hash
skip). Embedding is OFF by default; run the embed backfill later or opt in.

  --all             Import every session log discovered under the harness
                    roots (claude/codex/openclaw/grok projects + the hermes store)
  --include-self    Also discover gbrain's OWN claude-cli subprocess sessions
                    (recorded by Claude Code for the provider's scratch cwds;
                    excluded by default to avoid a self-ingestion loop)
  --format F        claude-code | codex | openclaw | hermes | grok |
                    chatgpt | claude-export (auto-detected when omitted)
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
                    claude-code, openclaw, hermes and grok reject the file
                    outright — so LOWERING this can drop those formats
  --exclude-source L
                    Hermes stores: skip sessions whose source is in the comma
                    list L before anything is read (they never become pages
                    and never reach --facts); "subagent" also skips delegate
                    children spawned under another source (Hermes marks them
                    in model_config). Default: ${DEFAULT_HERMES_EXCLUDE_SOURCES.join(',')}
                    (what Hermes hides from its own session history; cron,
                    oneshot and a hook's custom source are kept until named).
                    A session matches by its source or by its creation label
                    (Hermes stores the owner's own chats as source "local"; a
                    session created by cron and continued by hand keeps its
                    cron creation label). "none" imports everything; an
                    explicit list REPLACES the default, so name
                    subagent,kanban,tool again to keep them out. Config
                    key transcripts.hermes.exclude_sources
                    (JSON array or comma list) sets a default for scheduled
                    runs; the flag wins. Excluded sessions are counted on an
                    "excluded:" line, are not errors, and do not hold the
                    --since last watermark; an explicitly set list is part
                    of the checkpoint scope for Hermes stores and
                    auto-detected paths (changing it starts a fresh
                    --since last scope, like --max-bytes). A config value
                    that is not a list refuses the run. Other formats
                    ignore this flag.
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
 * directory scopes. Checkpoint snapshots and Grok session sidecars
 * (updates.jsonl, summary.json, prompt_history.jsonl, …) are never imported —
 * via the STRICT (evidence-checked) grok predicate: these are user-supplied
 * paths with no format scope, and the broad bare-UUID heuristic silently
 * dropped explicit sessions that merely lived under a UUID-named directory.
 * Claude Code Remote Control state files (`<uuid>.ccr-tip.json`,
 * `bridge-pointer.json`) are excluded the same way (#5597): they match the
 * `.json` importable extension, are not transcripts, and would otherwise
 * fail every run with `unknown format`. Exported for tests.
 */
/**
 * Shell-style tilde expansion for a user path spec: a bare `~` or a leading
 * `~/` (or `~\\`) resolves against the home dir. `~user` forms and a `~`
 * anywhere else in the string are left untouched (they are literal path
 * characters). Exported for tests.
 */
export function expandTilde(raw: string): string {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return homedir() + raw.slice(1);
  return raw;
}

export async function expandPaths(specs: string[]): Promise<string[]> {
  const { statSync } = await import('node:fs');
  const out: string[] = [];
  for (const raw of specs) {
    const spec = expandTilde(raw);
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
  return [...new Set(out)].filter(
    (p) =>
      !isOpenclawCheckpointFile(p) &&
      !isGrokSessionSidecarStrict(p) &&
      !isClaudeCodeSubagentFile(p) &&
      !isClaudeCodeWorkflowArtifactFile(p) &&
      !isClaudeCodeRemoteControlStateFile(p),
  );
}

export function fmtSummary(r: TranscriptsIngestResult): string {
  const byHarness = new Map<string, number>();
  for (const f of r.files) {
    for (const s of f.sessions) {
      if (!s.error && !s.skipped && !s.pending) byHarness.set(s.harness, (byHarness.get(s.harness) ?? 0) + 1);
    }
  }
  const lines: string[] = [];
  const counts = [...byHarness.entries()].map(([h, n]) => `${h}: ${n}`).join(', ');
  lines.push(
    `sessions: ${r.sessionsImported} imported (${counts || 'none'}), ` +
      `${r.sessionsFiltered} filtered, ${r.sessionsErrored} errored, ` +
      (r.sessionsPending ? `${r.sessionsPending} pending, ` : '') +
      (r.sessionsSkippedNoTimestamp ? `${r.sessionsSkippedNoTimestamp} skipped (no timestamps), ` : '') +
      `${r.sessionsSeen} seen`,
  );
  lines.push(
    `pages: ${r.pages.imported} imported, ${r.pages.skipped} unchanged` +
      (r.pages.errored ? `, ${r.pages.errored} ERRORED` : '') +
      (r.pages.planned ? `, ${r.pages.planned} planned (dry run)` : '') +
      (r.pages.pending ? `, ${r.pages.pending} accepted and still publishing (the next run finishes them without a second write)` : '') +
      (r.partsDeleted ? `, ${r.partsDeleted} stale parts deleted` : ''),
  );
  if (r.redactions > 0) lines.push(`redactions: ${r.redactions} secrets/patterns redacted before write`);
  if (r.imperatives > 0) lines.push(`flagged: ${r.imperatives} agent-directed imperative(s) noted in frontmatter`);
  if (r.subagentRollouts > 0) lines.push(`${r.subagentRollouts} sub-agent rollouts (no user turns by design)`);
  if (r.sessionsExcluded > 0) lines.push(fmtExcludedLine(r));
  if (r.sessionMetadataUnparsed > 0) {
    lines.push(`note: ${r.sessionMetadataUnparsed} scanned session(s) had host metadata that did not parse; a delegate marker there could not be read`);
  }
  if (r.driftFiles > 0) {
    const userless = r.files.filter((f) => f.userTurnsMissing).length;
    const zero = r.driftFiles - userless;
    const shapes = [
      zero > 0 ? `${zero} parsed to zero sessions` : '',
      userless > 0 ? `${userless} parsed to assistant turns with no user turns` : '',
    ].filter(Boolean).join(', ');
    lines.push(
      `DRIFT WARNING: ${r.driftFiles} file(s) drifted (${shapes}) — the host ` +
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

/** #8901: `excluded: 4 automated session(s) by source (cron 1, subagent 3 incl. 2 delegate child(ren) under another source) — not imported, not errors` (labels sorted). */
export function fmtExcludedLine(r: Pick<TranscriptsIngestResult, 'sessionsExcluded' | 'excludedBySource' | 'delegatesExcluded'>): string {
  const parts = Object.entries(r.excludedBySource)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, n]) => label === HERMES_SUBAGENT_SOURCE && r.delegatesExcluded > 0
      ? `${label} ${n} incl. ${r.delegatesExcluded} delegate child(ren) under another source`
      : `${label} ${n}`);
  return `excluded: ${r.sessionsExcluded} automated session(s) by source (${parts.join(', ')}) — not imported, not errors`;
}

/** #8901: the config key scheduled runs set instead of the flag. */
export const HERMES_EXCLUDE_SOURCES_CONFIG_KEY = 'transcripts.hermes.exclude_sources';

async function runIngest(engine: BrainEngine, args: string[], dispatch: Pick<CliDispatchContext, 'makeContext'>): Promise<void> {
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
  // and stop (a safe default for a command that can touch five harness
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

  // #8901: the Hermes session-kind exclude set — flag > config key > default.
  // Resolved BEFORE the fingerprint, which keys on an explicit set. The key
  // is read only when a Hermes store can be scanned (format hermes or auto):
  // an explicit codex/claude-code/grok/openclaw run ignores the set, so a
  // malformed key must not refuse it.
  const hermesPossible = parsed.format === undefined || parsed.format === 'hermes';
  if (parsed.excludeSources !== undefined && !hermesPossible) {
    console.error(`note: --exclude-source applies to Hermes stores only; ignored for --format ${parsed.format}`);
  }
  let excludeConfigRaw: string | null = null;
  if (parsed.excludeSources === undefined && hermesPossible) {
    try {
      excludeConfigRaw = await engine.getConfig(HERMES_EXCLUDE_SOURCES_CONFIG_KEY);
    } catch (e) {
      console.error(`gbrain transcripts ingest: could not read config ${HERMES_EXCLUDE_SOURCES_CONFIG_KEY}: ${e instanceof Error ? e.message : String(e)}`);
      setCliExitVerdict(1);
      return;
    }
  }
  const excludePolicy = resolveHermesExcludePolicy({ flag: parsed.excludeSources ?? null, configRaw: excludeConfigRaw });
  if (excludePolicy.error) {
    // Fail closed: a malformed value must not read as "exclude nothing".
    console.error(
      `gbrain transcripts ingest: config ${HERMES_EXCLUDE_SOURCES_CONFIG_KEY} ${excludePolicy.error}; ` +
        `set a JSON array or comma list (e.g. gbrain config set ${HERMES_EXCLUDE_SOURCES_CONFIG_KEY} '["cron","subagent"]'), ` +
        `unset it, or pass --exclude-source for this run`,
    );
    setCliExitVerdict(2);
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
      ...(excludePolicy.explicit ? { excludeSources: excludePolicy.sources } : {}),
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
  const context = await dispatch.makeContext?.(engine, { source: sourceId, dry_run: parsed.dryRun === true });
  try {
    result = await runTranscriptsIngest(engine, {
      paths,
      format: parsed.format,
      dryRun: parsed.dryRun,
      limit: parsed.limit,
      sinceIso,
      sourceId,
      maxBytes: parsed.maxBytes,
      excludeSessionSources: excludePolicy.sources,
      embed: parsed.embed,
      activePack,
      context,
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
  let factsSummary: { pages: number; pagesFailed: number; spentUsd?: number } | undefined;
  if (parsed.facts && !parsed.dryRun && result.slugsTouched.length > 0) {
    const { runIngestFacts } = await import('../core/transcripts/ingest-facts.ts');
    factsSummary = await runIngestFacts(engine, {
      sourceId,
      slugs: [...new Set(result.slugsTouched)],
      maxCostUsd: parsed.maxCostUsd,
      quiet: parsed.quiet,
    });
  }

  // #8901: an explicit label that matched nothing is most likely a typo or a
  // case mismatch (labels are exact); report it when a Hermes store was
  // scanned, in --json too, so a scheduled run can see it.
  // Only on a complete scan: every requested path visited (a `--limit` stop
  // leaves later files unvisited), every Hermes file's end-of-scan
  // diagnostics applied (absent after a limit stop inside it or a thrown
  // parse), and no Hermes file errored or read as drift (a caught schema
  // error returns diagnostics without enumerating sessions). A label must
  // never be called a typo on partial evidence.
  const hermesFiles = result.files.filter((f) => f.format === 'hermes');
  const scanComplete = result.files.length === paths.length
    && hermesFiles.length > 0
    && hermesFiles.every((f) => f.diagnosticsApplied && !f.error && !f.drift);
  const unmatchedExcludeSources = excludePolicy.explicit && scanComplete
    ? excludePolicy.sources.filter((label) => !result.excludeLabelsMatched.includes(label))
    : [];
  const excludeOrigin = parsed.excludeSources !== undefined ? '--exclude-source' : HERMES_EXCLUDE_SOURCES_CONFIG_KEY;
  // An explicit list REPLACES the default; name the default members it
  // re-admits (in --json always, so a scheduled run can see it; in the human
  // summary unless the list is the deliberate off switch).
  const readmittedDefaultSources = excludePolicy.explicit && hermesFiles.length > 0
    ? DEFAULT_HERMES_EXCLUDE_SOURCES.filter((label) => !excludePolicy.sources.includes(label))
    : [];
  const defaultsDropped = excludePolicy.sources.length > 0 ? readmittedDefaultSources : [];
  if (parsed.json) {
    console.log(JSON.stringify({ ...result, facts: factsSummary ?? null, source_id: sourceId, unmatched_exclude_sources: unmatchedExcludeSources, readmitted_default_sources: readmittedDefaultSources }, null, 2));
  } else if (!parsed.quiet) {
    console.log(fmtSummary(result));
    if (unmatchedExcludeSources.length > 0) {
      console.log(`note: no session matched ${excludeOrigin} label(s) ${unmatchedExcludeSources.join(', ')} (labels are exact and case-sensitive)`);
    }
    if (defaultsDropped.length > 0) {
      console.log(`note: ${excludeOrigin} replaces the default list; ${defaultsDropped.join(', ')} session(s) import on this run (name them to keep them out)`);
    }
    if (factsSummary) {
      console.log(
        `facts: attempted ${factsSummary.pages} page(s), ${factsSummary.pagesFailed} failed` +
          (factsSummary.spentUsd !== undefined ? `, ~$${factsSummary.spentUsd.toFixed(2)} spent` : '') +
          (factsSummary.pagesFailed > 0 ? ' (failed pages stay unfinished; stderr names each retry command)' : ''),
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
  if (allFailed || (factsSummary?.pagesFailed ?? 0) > 0) setCliExitVerdict(1);
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

export async function runTranscripts(engine: BrainEngine, args: string[], dispatch: Pick<CliDispatchContext, 'makeContext'> = {}): Promise<void> {
  const sub = args[0];
  if (sub === 'ingest') {
    await runIngest(engine, args.slice(1), dispatch);
    return;
  }
  if (sub === 'status') {
    // #6521: `status` has no parser of its own, so its help flag reached runStatus and the (null) engine.
    if (helpFlagRequested(args.slice(1))) { console.log(HELP); return; }
    await runStatus(engine, args.slice(1));
    return;
  }
  if (sub === 'audit-secrets') {
    const { runTranscriptsAuditSecrets } = await import('./transcripts-audit.ts');
    await runTranscriptsAuditSecrets(engine, args.slice(1));
    return;
  }
  if (sub === 'recover') {
    const { runTranscriptsRecover } = await import('./transcripts-recover.ts');
    await runTranscriptsRecover(engine, args.slice(1), dispatch);
    return;
  }
  if (sub !== 'recent') {
    if (sub !== '--help' && sub !== '-h' && args.includes('--json')) {
      const { exitCliError, usageError } = await import('../cli/cli-error.ts');
      exitCliError(usageError(sub && !sub.startsWith('-') ? `Unknown transcripts subcommand: ${sub}` : 'gbrain transcripts needs a subcommand: ingest, status, recover, audit-secrets or recent.',
        'Run `gbrain transcripts recent --json` to list recent transcripts, or `gbrain transcripts --help`.'), 'transcripts', { json: true });
    }
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
  console.log(renderRecentTranscripts(rows, parsed.json === true));
}

function renderRecentTranscripts(rows: RecentTranscript[], json: boolean): string {
  if (json) return JSON.stringify(rows, null, 2);
  if (rows.length === 0) return '(no recent transcripts in the corpus dir)';
  return rows.map(r => `\n--- ${r.date ?? r.mtime.slice(0, 10)} | ${r.path} | ${r.length} bytes ---\n${r.summary}`).join('\n');
}

/**
 * `gbrain transcripts recent` while a live `gbrain serve` owns the PGLite
 * brain: read through the owner's local socket as the trusted CLI (the
 * stdio agent's own connection still cannot call get_recent_transcripts).
 * False when no live owner serves the brain (the caller connects normally).
 */
export async function runDelegatedTranscriptsRecent(args: string[]): Promise<boolean> {
  const parsed = parseRecentArgs(args);
  if ('help' in parsed) return false;
  const { loadConfig } = await import('../core/config.ts');
  const { getCliOptions } = await import('../core/cli-options.ts');
  const { runDelegatedCliOperation } = await import('./persistence-delegate.ts');
  const params: Record<string, unknown> = {
    ...(parsed.days !== undefined ? { days: parsed.days } : {}),
    ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    summary: !parsed.full,
    ...(parsed.json ? { json: true } : {}),
  };
  return runDelegatedCliOperation('get_recent_transcripts', params, loadConfig(), { brain: getCliOptions().brain },
    (_op, result) => `${renderRecentTranscripts(Array.isArray(result) ? result as RecentTranscript[] : [], parsed.json === true)}\n`);
}
