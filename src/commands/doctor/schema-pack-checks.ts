/**
 * Schema-pack doctor checks — verbatim peel from src/commands/doctor.ts
 * (containment sprint). No behavior change; doctor.ts re-exports
 * multiSourceDriftAdvice and doctorReportRemote consumes the three checks.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { Check } from '../doctor.ts';
import type { MisroutedResult } from '../../core/multi-source-drift.ts';
import { redactConnectionInfo } from '../../core/audit/redact-connection-info.ts';
import { loadActivePackForLocalEngine } from '../../core/schema-pack/best-effort.ts';
import { sanitizeTypeForDisplay, storedTypeMissesPack } from '../../core/schema-pack/type-usage.ts';

// =================================================================
// v0.39 T7 + T9 — schema-pack doctor checks
// =================================================================
// Three checks per v0.38 CEO plan that never shipped at v0.38 time:
//   schema_pack_active       — does the active pack resolve cleanly?
//   schema_pack_consistency  — do stored page types match the active pack?
//   schema_pack_source_drift — do per-source packs disagree?
// All three are warn-only; never fail-block.

export async function checkSchemaPackActive(engine: BrainEngine): Promise<Check> {
  try {
    const { loadActivePack } = await import('../../core/schema-pack/load-active.ts');
    const { loadConfigFileOnly } = await import('../../core/config.ts');
    // #3792: thread the DB-plane schema_pack (tier 4) so doctor resolves the
    // SAME pack as the engine/onboard checks on brains whose active pack was
    // flipped via `gbrain config set schema_pack` / unify-types — without it,
    // doctor reported the home-config pack while every query ran the DB one.
    // File-only config preserves tier-6 without merging transient env/db
    // state (matches onboard/checks.ts's checkPackUpgradeAvailable).
    let dbConfig: string | undefined;
    try {
      dbConfig = (await engine.getConfig('schema_pack')) ?? undefined;
    } catch { /* engine.config may not exist on very old brains */ }
    const pack = await loadActivePack({ cfg: loadConfigFileOnly(), remote: false, dbConfig });
    return {
      name: 'schema_pack_active',
      status: 'ok',
      message: `Active pack: ${pack.manifest.name} v${pack.manifest.version} (${pack.manifest.page_types.length} types, ${pack.manifest.link_types?.length ?? 0} link verbs)`,
    };
  } catch (e) {
    return {
      name: 'schema_pack_active',
      status: 'warn',
      message: `Active pack failed to resolve: ${(e as Error).message}. Run \`gbrain schema active\` to debug.`,
    };
  }
}

const SCHEMA_PACK_DOCS = 'docs/architecture/schema-packs.md#undeclared-page-types';

/**
 * #5432: a check that could not read its input says "not verified" (warn),
 * never ok. The redacted reason rides in `details.reason` for `--json`.
 */
function notVerified(err: unknown, fix: string, docs = SCHEMA_PACK_DOCS): Omit<Check, 'name'> {
  const reason = redactConnectionInfo(err instanceof Error ? err.message : String(err)).slice(0, 200);
  return {
    status: 'warn',
    message: `Not verified: the check could not run (${reason}). Fix the cause, then re-run \`${fix}\`.`,
    details: { code: 'not_verified', verified: false, reason, fix, docs },
  };
}

interface SourceConformance {
  source_id: string;
  total: number;
  untyped: number;
  undeclared: number;
  undeclared_types: Array<{ type: string; count: number }>;
  pack: string | null;
}

/**
 * #5879: pages match the active pack only when their stored type is a
 * declared page type or an alias of one (`storedTypeMissesPack`, the same
 * classification as `schema lint --with-db`). Each source is graded against
 * its own resolved pack. Any undeclared type warns; untyped pages warn at
 * >= 10% of a source.
 */
export async function checkSchemaPackConsistency(
  engine: BrainEngine,
  opts: { sourceIds?: string[] } = {},
): Promise<Check> {
  const scoped = opts.sourceIds !== undefined;
  let rows: Array<{ src: string; type: string | null; n: string }>;
  try {
    rows = await engine.executeRaw(
      `SELECT COALESCE(source_id, 'default') AS src, type, COUNT(*)::text AS n
         FROM pages
        WHERE deleted_at IS NULL${scoped ? ' AND source_id = ANY($1::text[])' : ''}
        GROUP BY source_id, type
        ORDER BY source_id`,
      scoped ? [opts.sourceIds] : [],
    );
  } catch (e) {
    return { name: 'schema_pack_consistency', ...notVerified(e, 'gbrain schema review-orphans') };
  }
  if (rows.length === 0) {
    return { name: 'schema_pack_consistency', status: 'ok', message: 'No pages in any source — schema consistency N/A.' };
  }
  const bySource = new Map<string, Array<{ type: string | null; n: number }>>();
  for (const r of rows) {
    const list = bySource.get(r.src) ?? [];
    list.push({ type: r.type, n: Number(r.n) });
    bySource.set(r.src, list);
  }
  const graded: SourceConformance[] = [];
  const unresolved: string[] = [];
  for (const [src, types] of bySource) {
    const pack = await loadActivePackForLocalEngine(engine, { sourceId: src });
    if (!pack) { unresolved.push(src); continue; }
    const undeclaredTypes = types
      .filter((t): t is { type: string; n: number } => !!t.type && storedTypeMissesPack(t.type, pack.manifest))
      .map((t) => ({ type: t.type, count: t.n }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    graded.push({
      source_id: src,
      total: types.reduce((sum, t) => sum + t.n, 0),
      untyped: types.filter((t) => !t.type).reduce((sum, t) => sum + t.n, 0),
      undeclared: undeclaredTypes.reduce((sum, t) => sum + t.count, 0),
      undeclared_types: undeclaredTypes,
      pack: pack.manifest.name,
    });
  }
  const details: Record<string, unknown> = { per_source: graded, unresolved_sources: unresolved, docs: SCHEMA_PACK_DOCS };
  const problems: string[] = [];
  for (const g of graded.filter((x) => x.undeclared > 0)) {
    const sample = g.undeclared_types.slice(0, 5).map((t) => `'${sanitizeTypeForDisplay(t.type)}' (${t.count})`).join(', ');
    problems.push(`Source \`${g.source_id}\`: ${g.undeclared} page(s) use ${g.undeclared_types.length} type(s) pack \`${g.pack}\` neither declares nor aliases: ${sample}. List them with \`gbrain schema review-orphans --source ${g.source_id}\`, then declare the type (\`gbrain schema add-type <type>\`, which takes its primitive and prefix) or retype the pages to a declared type.`);
  }
  const worst = graded.reduce<SourceConformance | null>((w, g) =>
    g.total > 0 && (!w || g.untyped / g.total > w.untyped / w.total) ? g : w, null);
  const worstPct = worst ? worst.untyped / worst.total : 0;
  if (worst && worstPct >= 0.1) {
    problems.push(`Source \`${worst.source_id}\`: ${worst.untyped} of ${worst.total} pages (${(worstPct * 100).toFixed(1)}%) have no type matching the active pack. Run \`gbrain schema detect --source ${worst.source_id}\` to propose a pack matching your content shape.`);
  }
  if (unresolved.length > 0) {
    problems.push(`Not verified for ${unresolved.length} source(s) (${unresolved.join(', ')}): the active pack did not resolve. Run \`gbrain schema active\` to debug.`);
  }
  if (problems.length > 0) {
    const code = graded.some((x) => x.undeclared > 0) ? 'page_type_undeclared' : unresolved.length > 0 ? 'not_verified' : 'pages_untyped';
    return { name: 'schema_pack_consistency', status: 'warn', message: problems.join(' '), details: { ...details, code } };
  }
  if (!worst || worst.untyped === 0) {
    return { name: 'schema_pack_consistency', status: 'ok', message: 'All pages match the active schema pack across every source.', details };
  }
  return {
    name: 'schema_pack_consistency',
    status: 'ok',
    message: `${(worstPct * 100).toFixed(1)}% untyped at worst (source \`${worst.source_id}\`) — under the 10% warn threshold.`,
    details,
  };
}

export async function checkSchemaPackSourceDrift(engine: BrainEngine): Promise<Check> {
  try {
    // Compare per-source schema_pack overrides (tier 3 DB config) to detect
    // multi-source brains where different sources point at conflicting packs.
    const rows = await engine.executeRaw<{ key: string; value: string }>(
      `SELECT key, value FROM config WHERE key LIKE 'schema_pack.source.%'`,
    );
    if (rows.length === 0) {
      return { name: 'schema_pack_source_drift', status: 'ok', message: 'No per-source pack overrides — drift N/A.' };
    }
    const distinctPacks = new Set(rows.map((r) => r.value).filter(Boolean));
    if (distinctPacks.size <= 1) {
      return { name: 'schema_pack_source_drift', status: 'ok', message: `${rows.length} per-source overrides; all point at the same pack.` };
    }
    return {
      name: 'schema_pack_source_drift',
      status: 'warn',
      message: `Per-source pack divergence detected: ${distinctPacks.size} distinct packs across ${rows.length} sources. Run \`gbrain sources list\` then \`gbrain schema active --source <id>\` per source to audit.`,
    };
  } catch (e) {
    return { name: 'schema_pack_source_drift', ...notVerified(e, 'gbrain doctor') };
  }
}

/**
 * #1123 — multi_source_drift remediation advice. Exported so the regression
 * test can pin that it only references CLI surfaces that actually exist
 * (the pre-fix text pointed at 'gbrain sources rehome', which was never
 * built, and at 'gbrain delete <slug>' without explaining that delete
 * targets the ACTIVE source — following it literally on a multi-source
 * brain deletes the correctly-routed row).
 */
export function multiSourceDriftAdvice(count: number, sampleStr: string, managed = false): string {
  // #4490: cause (3) + the --include-gitignored pointer must precede the
  // delete step — an operator whose file is simply not git-tracked would
  // otherwise re-sync (which imports nothing for that file) and then delete
  // a row nothing will recreate. A managed brain's sync refuses a git pull
  // and --include-gitignored, so its advice names `--no-pull` and drops the
  // ignored-file walk.
  return (
    `${count} page slug(s) appear at 'default' but NOT at the intended source ` +
    `(e.g., ${sampleStr}). Three possible causes: (1) pre-v0.30.3 putPage misroutes; ` +
    `(2) the intended source never completed initial sync and the default page is unrelated; ` +
    `(3) the file behind the slug is not git-tracked in the source repo — the sync walker ` +
    `reads through git objects, so a re-sync imports nothing for it. ` +
    `Verify with 'gbrain sources status', then re-sync with ` +
    `'gbrain sync --source <id>${managed ? ' --no-pull' : ''} --full' (reconciles drift without deleting data); ` +
    (managed
      ? `for cause (3), commit the file (managed sync imports only committed files). `
      : `for cause (3), commit the file or use 'gbrain sync --source <id> --include-gitignored' ` +
        `(full filesystem walk that also picks up ignored/untracked syncable files). `) +
    `Only if a misrouted default-source row remains after that, remove it with ` +
    `'GBRAIN_SOURCE=default gbrain delete <slug> --force' — delete targets the active source, ` +
    `so pin it to 'default' explicitly (--force: page writes are revisioned, and a delete ` +
    `naming neither --force nor --expected-revision is refused with revision_conflict).`
  );
}

/**
 * Disclosure appended to multi_source_drift when sources pinned to
 * slug_root_mode='git-root' (#4342) were left out because git could not
 * place their local_path in a work tree, so the prefix their slugs carry is
 * unknown. They are unverified, not drifted: checking them against
 * local_path-relative slugs would invent drift and delete advice.
 */
export function multiSourceDriftGitRootSkipNote(skippedIds: string[]): string {
  return (
    ` ${skippedIds.length} source(s) not checked (pinned to git-root slugs, but git could not locate ` +
    `local_path inside a work tree, so the slug prefix sync used is unknown): ${skippedIds.join(', ')}.`
  );
}

const DRIFT_DOCS = 'docs/guides/troubleshooting.md#not-verified-doctor-checks';

/**
 * #5432: one multi_source_drift verdict for the local and remote doctor.
 * Anything that leaves a source uncompared (a truncated walk, an unreadable
 * root or subdirectory, a git-root source git cannot place) is "not
 * verified" (warn), never "no drift"; details carry the walk bounds and the
 * unreadable and skipped sources.
 */
export function multiSourceDriftCheck(
  result: MisroutedResult,
  candidateSources: number,
  host: 'local' | 'remote',
  managed = false,
): Check {
  const details = {
    walk_truncated: result.walk_truncated,
    unreadable_sources: result.unreadable_sources,
    git_root_skipped: result.git_root_skipped,
    limit: result.limit,
    timeout_ms: result.timeout_ms,
    docs: DRIFT_DOCS,
  };
  const skipNote = result.git_root_skipped.length > 0 ? multiSourceDriftGitRootSkipNote(result.git_root_skipped) : '';
  const unreadable = result.unreadable_sources;
  const unreadableNote = unreadable.length > 0
    ? ` Not verified for ${unreadable.length} source(s) whose local_path could not be read: ` +
      unreadable.map((u) => `${u.source_id} (${u.reason === 'root_unreadable' ? 'root unreadable' : `${u.dirs} unreadable dir(s)`})`).join(', ') +
      `. Fix the path or permissions (\`gbrain sources status\`), then re-run \`gbrain doctor\`.`
    : '';
  if (result.walk_truncated) {
    return {
      name: 'multi_source_drift',
      status: 'warn',
      message:
        `Multi-source drift not verified — the FS walk hit its bound (${result.limit} files / ${result.timeout_ms} ms)` +
        (host === 'remote' ? ' on the brain server' : '') +
        `. Re-run with a larger bound: \`GBRAIN_DRIFT_LIMIT=<files> GBRAIN_DRIFT_TIMEOUT_MS=<ms> gbrain doctor\`.` +
        unreadableNote,
      details: { ...details, code: 'not_verified', verified: false },
    };
  }
  if (result.count > 0) {
    const sampleStr = result.sample.map((s) => `${s.slug} (intended=${s.intended_source})`).join(', ');
    const advice = host === 'local'
      ? multiSourceDriftAdvice(result.count, sampleStr, managed)
      : `${result.count} page slug(s) appear at 'default' but NOT at the intended source ` +
        `(e.g., ${sampleStr}). Likely pre-v0.30.3 misroutes OR an incomplete initial sync. ` +
        `Verify on the brain host: \`gbrain sources status\` then \`gbrain sync --source <id>${managed ? ' --no-pull' : ''} --full\`.`;
    return { name: 'multi_source_drift', status: 'warn', message: advice + skipNote + unreadableNote, details: { ...details, code: 'drift_detected' } };
  }
  if (unreadable.length > 0) {
    return {
      name: 'multi_source_drift',
      status: 'warn',
      message: `No cross-source slug drift among readable sources.${unreadableNote}${skipNote}`,
      details: { ...details, code: 'not_verified', verified: false },
    };
  }
  if (result.git_root_skipped.length === 0) {
    return { name: 'multi_source_drift', status: 'ok', message: 'No cross-source slug drift detected.', details };
  }
  // Skipped sources were never compared, so this cannot be "no drift" even
  // when every checked sibling was clean.
  const lead = result.git_root_skipped.length >= candidateSources
    ? 'Multi-source drift check performed no verification'
    : 'No cross-source slug drift among checked sources.';
  return { name: 'multi_source_drift', status: 'warn', message: lead + skipNote, details: { ...details, code: 'not_verified', verified: false } };
}

/** #5432: the drift check itself failed (e.g. the sources query); report it instead of dropping the check. */
export function multiSourceDriftNotVerified(err: unknown): Check {
  return { name: 'multi_source_drift', ...notVerified(err, 'gbrain doctor', DRIFT_DOCS) };
}
