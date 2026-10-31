/**
 * `gbrain sources canonical <source-id> --to git|mixed` (git-canonical memory, G8a, docs/designs/GIT_CANONICAL_MEMORY.md#conversion):
 * the one verb that makes a source strict (`config.canonical = "git"`) or returns it to mixed. The default `--dry-run`
 * prints the plan, by category with counts and a capped sample of paths, and its hash; `--apply --expect <hash>` runs it
 * (persistence/git-conversion.ts). Trusted local CLI on a managed brain only; not an MCP operation, since it prints paths.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { registerSignalOwner, triggerCleanupAndExit } from '../core/process-cleanup.ts';
import { startMemoryTrace } from '../core/memory-trace.ts';
import { applyGitConversion, applyMixedConversion, assertConversionCaller, CONVERSION_GROUP_MAX, conversionIncompleteFix, planGitConversion, planMixedConversion,
  type ConversionProgress, type GitConversionPreview, type GitConversionResult, type MixedConversionPreview } from '../core/persistence/git-conversion.ts';

const USAGE = 'Usage: gbrain sources canonical <source-id> --to git|mixed [--dry-run | --apply --expect <hash> [--no-embed] [--no-extract]] [--json]';
const DOCS = 'docs/designs/GIT_CANONICAL_MEMORY.md#conversion';
/** How often a running apply says where it stands (stderr), besides each change of phase. */
export const PROGRESS_EVERY_MS = 10_000;
const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export function parseCanonicalArgs(args: string[]): { sourceId: string; to: 'git' | 'mixed'; apply: boolean; expect: string | null; json: boolean; noEmbed: boolean; noExtract: boolean } {
  const positional: string[] = [];
  let to: string | null = null, expect: string | null = null, apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--to') { to = args[++i] ?? null; continue; }
    if (arg === '--expect') { expect = args[++i] ?? null; if (!expect) throw new OperationError('invalid_params', '--expect needs the preview hash.', USAGE); continue; }
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--dry-run' || arg === '--json' || arg === '--no-embed' || arg === '--no-extract') continue;
    if (arg.startsWith('-')) throw new OperationError('invalid_params', `Unknown sources canonical flag: ${arg}.`, USAGE);
    positional.push(arg);
  }
  if (positional.length !== 1) throw new OperationError('invalid_params', 'sources canonical needs exactly one source id.', USAGE);
  if (to !== 'git' && to !== 'mixed') throw new OperationError('invalid_params', `--to needs git or mixed; got ${to ?? 'nothing'}.`, USAGE);
  if (apply && args.includes('--dry-run')) throw new OperationError('invalid_params', '--apply and --dry-run exclude each other.', USAGE);
  if (apply && !expect) throw new OperationError('invalid_params', '--apply needs --expect <hash> from the --dry-run preview.', USAGE);
  return { sourceId: positional[0]!, to, apply, expect, json: args.includes('--json'), noEmbed: args.includes('--no-embed'), noExtract: args.includes('--no-extract') };
}

const counts = (record: Record<string, number>) => Object.entries(record).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
const sample = (paths: string[]) => paths.map(path => `    ${path}`);

export function describeGitPreview(p: GitConversionPreview): string {
  const { detail } = p.discard;
  const causes = [...Object.entries(detail.git_overwrites_database).flatMap(([cls, kinds]) => Object.entries(kinds).map(([kind, n]) => `git_overwrites_database ${cls} on ${kind} ${n}`)),
    ...(['uncommitted_edit', 'unparseable', 'export_mismatch', 'ignore_status_unknown'] as const).flatMap(category => Object.entries(detail[category]).map(([key, n]) => `${category} ${key} ${n}`))];
  const lines = [`Source ${p.source_id}${p.strict ? ' (already git-canonical)' : ''} at ${p.head?.slice(0, 12) ?? 'no commit'}: ${p.pages} live page(s), ${p.equal} equal to HEAD.`,
    `Adopt (write the database's page to its file and commit it through the door, ${p.adopt.groups} commit(s) of up to ${CONVERSION_GROUP_MAX}): ${p.adopt.count} (${counts(p.adopt.by)}).`, ...sample(p.adopt.sample),
    `Declared database-only (nothing written, nothing deleted): ${p.declared.count} (${counts(p.declared.by)}).`,
    `Withhold (a private page's committed file is removed through the door, ${p.withhold.groups} commit(s), and its row withholds its origin): ${p.withhold.count} (${counts(p.withhold.by)}).`, ...sample(p.withhold.sample),
    `Git wins (the strict pass indexes the committed file): ${p.git_wins.count} (${counts(p.git_wins.by)}).`, ...sample(p.git_wins.sample),
    `Holds cleared so Git's verdict runs: ${p.holds.count} (${counts(p.holds.by)})${p.holds.unplaced.count ? `; ${p.holds.unplaced.count} at a path nothing else placed (${counts(p.holds.unplaced.by)}), counted below by the strict pass's verdict` : ''}.`,
    `Parked effects: ${p.parked_effects.count} (retry ${p.parked_effects.retry}, reclassify as declared ${p.parked_effects.reclassify}; ${counts(p.parked_effects.by_code)}).`,
    `The strict pass also imports ${p.index.imports} and deletes ${p.index.deletes} page(s) where the database holds nothing Git lacks.`,
    `Database content that would be discarded: ${p.discard.count}${p.discard.count ? ` (${counts(p.discard.by)}); the apply refuses until it is 0` : ''}.`,
    ...(causes.length ? [`  By cause: ${causes.join(', ')}.`] : []), ...sample(p.discard.sample)];
  lines.push(p.remaining === 0 && p.strict ? 'Nothing is left to convert.' : `Nothing changed. To apply: ${p.apply.join(' ')}`);
  return lines.join('\n');
}

function describeResult(r: GitConversionResult): string {
  const lines = [`Source ${r.source_id} ${r.status === 'converted' ? 'is git-canonical' : 'is git-canonical, with work left'}: ${r.committed.pages} page(s) committed in ${r.committed.groups} door commit(s), ${r.withheld.pages} private page(s) withheld (${r.withheld.commits.length} removal commit(s)), ${r.holds_cleared} hold(s) cleared, ${r.parked.retried} parked effect(s) retried and ${r.parked.reclassified} reclassified.`];
  if (r.push.state === 'pending') lines.push(`Push pending (${r.push.code}): ${r.push.notice}`);
  if (r.status === 'incomplete') lines.push(describeGitPreview(r.after));
  return lines.join('\n');
}

function describeMixed(p: MixedConversionPreview): string {
  return p.strict ? `Source ${p.source_id} is git-canonical; --to mixed removes canonical: git and changes nothing else (Git keeps every door commit).\nNothing changed. To apply: ${p.apply.join(' ')}`
    : `Source ${p.source_id} is not git-canonical; there is nothing to change.`;
}

const roundText = (p: ConversionProgress) => p.round ? ` round ${p.round}${p.batches ? ` batch ${p.batch}/${p.batches}` : ''}${p.candidates !== undefined ? ` (${p.scanned}/${p.candidates} candidate(s) settled)` : ''}` : '';
const progressBody = (p: ConversionProgress) => p.phase.startsWith('strict_pass')
  ? `${p.phase}${roundText(p)}: ${p.total} planned path(s), ${p.groups_committed} group(s) committed`
  : `${p.phase}: ${p.scanned}/${p.total} scanned, ${p.groups_committed} group(s) committed`;
const progressText = (p: ConversionProgress) => `[sources canonical] ${progressBody(p)}`;
/** #7866: where an apply stood when it was refused, so the refusal carries its counts. */
const stoppedAt = new WeakMap<object, ConversionProgress>();

/** The source's canonical state as its row says now: `git` once the flag is set, else `mixed`; `unknown` when the read fails or takes over 2 s. */
async function canonicalState(engine: BrainEngine, sourceId: string): Promise<'git' | 'mixed' | 'unknown'> {
  const read = engine.executeRaw<{ canonical: string | null }>("SELECT config->>'canonical' AS canonical FROM sources WHERE id=$1", [sourceId])
    .then(([row]) => row ? (row.canonical === 'git' ? 'git' as const : 'mixed' as const) : 'unknown' as const, () => 'unknown' as const);
  return Promise.race([read, new Promise<'unknown'>(resolve => setTimeout(() => resolve('unknown'), 2_000).unref?.())]);
}

/**
 * #7644: runs an apply that reports where it stands: a stderr line (a JSON line with --json) at each phase and every
 * PROGRESS_EVERY_MS. SIGTERM, SIGINT or SIGHUP prints a partial report on stdout (its phase, groups committed, items
 * scanned of the phase's total and the source's canonical state) and exits 128 + the signal. The conversion is crash-safe
 * on its own; the report only tells the operator where it stopped. GBRAIN_MEMORY_TRACE adds the memory trace (memory-trace.ts).
 */
async function withConversionReport<T>(engine: BrainEngine, sourceId: string, json: boolean, apply: (onProgress: (progress: ConversionProgress) => void) => Promise<T>): Promise<T> {
  let progress: ConversionProgress | null = null, stopping = false;
  const say = () => { if (progress) process.stderr.write(`${json ? JSON.stringify({ event: 'conversion_progress', source_id: sourceId, ...progress }) : progressText(progress)}\n`); };
  const onProgress = (next: ConversionProgress) => { const moved = next.phase !== progress?.phase; progress = next; if (moved) say(); };
  const timer = setInterval(say, PROGRESS_EVERY_MS);
  timer.unref?.();
  const stopTrace = startMemoryTrace('sources canonical --apply', () => progress ? { ...progress } : undefined);
  const interrupted = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    void (async () => {
      const canonical = await canonicalState(engine, sourceId);
      const at = progress ?? { phase: 'adopt', groups_committed: 0, scanned: 0, total: 0 };
      const error = opError('git_conversion_incomplete', `The conversion of source ${sourceId} was interrupted by ${signal} during ${at.phase}; the source is ${canonical === 'git' ? 'git-canonical' : canonical === 'mixed' ? 'still mixed' : 'in an unknown state'}.`,
        `Preview again with gbrain sources canonical ${sourceId} --to git --dry-run once gbrain sync status --source ${sourceId} --json shows the source idle, then apply the new hash; the groups already committed read equal.`,
        { docs: DOCS, detail: 'interrupted', fix: conversionIncompleteFix(sourceId) });
      const report = { status: 'interrupted', signal, source_id: sourceId, ...at, canonical };
      process.stdout.write(`${json ? JSON.stringify({ ...report, ...toAgentError(error, { transport: 'cli', command: 'sources canonical', render: cliRenderContext() }) })
        : `Conversion interrupted (${signal}) during ${progressBody(at)}; source canonical state: ${canonical}.${at.push?.state === 'pending' ? `\nPush pending (${at.push.code}): ${at.push.notice}` : ''}\nNext: ${error.suggestion}`}\n`);
      await triggerCleanupAndExit(SIGNAL_EXIT[signal] ?? 1);
    })();
  };
  const onSigint = () => interrupted('SIGINT');
  const release = registerSignalOwner('sources canonical --apply', interrupted);
  process.on('SIGINT', onSigint);
  try { return await apply(onProgress); }
  catch (error) { if (error instanceof OperationError && progress) stoppedAt.set(error, progress); throw error; }
  finally { clearInterval(timer); stopTrace(); release(); process.off('SIGINT', onSigint); }
}

export async function runSourcesCanonical(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) { console.log(`${USAGE}\nPreview first: lists, by category, what converting the source to git-canonical (or back) does (${DOCS}).`); return; }
  const print = (value: unknown, text: string) => console.log(json ? JSON.stringify(value) : text);
  try {
    const parsed = parseCanonicalArgs(args);
    await assertConversionCaller(engine, parsed.sourceId);
    if (parsed.to === 'mixed') {
      if (!parsed.apply) { const { incarnation: _, ...preview } = await planMixedConversion(engine, parsed.sourceId); print(preview, describeMixed(preview)); return; }
      const done = await applyMixedConversion(engine, parsed.sourceId, parsed.expect!);
      print(done, done.status === 'mixed' ? `Source ${parsed.sourceId} is mixed: canonical: git removed.` : `Source ${parsed.sourceId} was not git-canonical; nothing changed.`);
      return;
    }
    if (!parsed.apply) { const { preview } = await planGitConversion(engine, parsed.sourceId); print(preview, describeGitPreview(preview)); return; }
    const result = await withConversionReport(engine, parsed.sourceId, json,
      onProgress => applyGitConversion(engine, parsed.sourceId, parsed.expect!, { noEmbed: parsed.noEmbed, noExtract: parsed.noExtract, onProgress }));
    if (result.status === 'incomplete') {
      const closing = result.closing_passes ? ` and ${result.closing_passes} closing pass(es), with Git still ahead at ${result.after.git_wins.count} path(s)` : '';
      const error = opError('git_conversion_incomplete', `Source ${parsed.sourceId} is git-canonical, and ${result.after.remaining} item(s) were still open after its strict passes${closing}.`,
        `Writes landed during the conversion. Git wins on the source now; preview again with gbrain sources canonical ${parsed.sourceId} --to git --dry-run and apply the new hash.`,
        { docs: DOCS, detail: 'work_left', fix: conversionIncompleteFix(parsed.sourceId) });
      print({ status: 'incomplete', result, ...toAgentError(error, { transport: 'cli', command: 'sources canonical', render: cliRenderContext() }) }, describeResult(result));
      setCliExitVerdict(1);
      return;
    }
    print(result, describeResult(result));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources canonical', render: cliRenderContext() });
    const at = stoppedAt.get(error);
    console.log(json ? JSON.stringify({ status: 'refused', ...env, ...(at ? { progress: at } : {}) })
      : `Conversion refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}${env.fix?.command ? `\nNext: ${env.fix.command}` : ''}`);
    setCliExitVerdict(1);
  }
}
