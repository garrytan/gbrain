/**
 * `gbrain transcripts recover codex` — D15 recovery for #5163 (logic in
 * core/transcripts/recover.ts). Preview by default; `--apply` re-imports the
 * recoverable rollouts. Never extracts facts and never moves the
 * `--since last` watermark.
 */

import type { BrainEngine } from '../core/engine.ts';
import type { CliDispatchContext } from '../cli/command-table.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

export const TRANSCRIPTS_RECOVER_HELP = `Usage:
  gbrain transcripts recover codex [<rollout>...] [--apply] [--source-id S] [--json]

Restores the user turns of Codex sessions imported before gbrain read codex
0.153+ rollouts (#5163): finds codex conversation pages with no user turn,
re-reads their retained rollouts (~/.codex/sessions and the archived store,
or the rollouts given) and reports which can be restored and which cannot
(rollout gone). Preview by default; --apply re-imports the recoverable
rollouts in place (content-hash dedup; a rerun finds nothing to do). No
facts are extracted and the --since last watermark is untouched.

  --apply           Re-import the recoverable sessions (default: preview)
  --source-id S     Target source (default: the canonical 6-tier resolution)
  --json            Machine-readable plan (and ingest result with --apply)
`;

export async function runTranscriptsRecover(engine: BrainEngine, args: string[], dispatch: Pick<CliDispatchContext, 'makeContext'> = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(TRANSCRIPTS_RECOVER_HELP);
    return;
  }
  if (args[0] !== 'codex') {
    console.error('gbrain transcripts recover: name the harness to recover (only codex is supported): gbrain transcripts recover codex');
    setCliExitVerdict(2);
    return;
  }
  const apply = args.includes('--apply');
  const json = args.includes('--json');
  const paths: string[] = [];
  let source: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--source-id' || a === '--source') { source = args[++i] ?? null; continue; }
    if (a.startsWith('--')) continue;
    paths.push(a);
  }
  const { resolveSourceWithTier } = await import('../core/source-resolver.ts');
  const sourceId = (await resolveSourceWithTier(engine, source)).source_id;
  const { planCodexRecovery, applyCodexRecovery } = await import('../core/transcripts/recover.ts');
  const plan = await planCodexRecovery(engine, { sourceId, rolloutPaths: paths.length ? paths : undefined });
  const context = apply ? await dispatch.makeContext?.(engine, { source: sourceId }) : undefined;
  const result = apply ? await applyCodexRecovery(engine, plan, { context }) : null;
  if (json) {
    console.log(JSON.stringify({ plan, applied: apply, ...(result ? { ingest: { pages: result.pages, sessions_imported: result.sessionsImported, sessions_errored: result.sessionsErrored } } : {}) }, null, 2));
    if (result && (result.sessionsErrored > 0 || result.erroredFiles > 0)) setCliExitVerdict(1);
    return;
  }
  console.log(`codex recovery (source: ${sourceId}): ${plan.userless_sessions} codex session(s) have no user turn; ${plan.rollouts_scanned} rollout(s) scanned`);
  console.log(`  recoverable:   ${plan.recoverable.length} (the rollout now yields user turns)`);
  console.log(`  still no user: ${plan.still_userless.length} (the rollout has no user turn either)`);
  console.log(`  unrecoverable: ${plan.unrecoverable.length} (no retained rollout; their user turns are gone)`);
  for (const u of plan.unrecoverable) console.log(`    ${u.slug} (session ${u.session_id})`);
  if (!apply) {
    if (plan.recoverable.length) console.log('  apply: gbrain transcripts recover codex --apply');
    return;
  }
  if (!result) {
    console.log('  nothing to restore');
    return;
  }
  console.log(`  restored: ${result.pages.imported} page(s) re-imported, ${result.sessionsErrored} session error(s)`);
  console.log('  facts were not re-extracted; for a session you want them from, run: gbrain transcripts ingest <rollout> --facts --max-cost-usd <n>');
  if (result.sessionsErrored > 0 || result.erroredFiles > 0) setCliExitVerdict(1);
}
