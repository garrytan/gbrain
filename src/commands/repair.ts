/**
 * `gbrain repair [<kind>] [--apply] [--source <id>] [--limit <n>] [--no-embed] [--json]`
 *
 * Host-side repairs for residual damage the doctor reports. Every kind is a
 * dry run unless `--apply` is passed; applying publishes each item through a
 * coordinated page write (or, for `safe-chunks`, a projection-only rebuild
 * that takes no admission), resumes after an interruption, and stops before
 * crossing 90% of a cumulative journal cap. Thin clients refuse (cli.ts).
 * Explicit-only kinds run only when named; `--all` and the no-kind preview
 * list them with their preview command instead. Explicit-only and
 * preview-bound kinds accept `--expect <hash>` (their preview-bound apply);
 * only explicit-only kinds accept `--include-ambiguous`. `--max-usd <n>` is
 * accepted only for kinds that may call a paid chat model, and only lowers
 * their cap for this run. `gbrain repair content` is the content-repair
 * lane (#6377, repair-content.ts): not a kind, but it takes the same
 * `--only`/`--skip`, `--no-llm`, `--max-usd`, `--expect` and `--apply` flags,
 * so it is parsed here and dispatched before the kind check.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { clearHealthMemo } from '../core/health-memo.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { shellQuote } from '../core/agent-output.ts';
import { OLDER_THAN_RE } from '../cli/strict-args.ts';
import { parseSince } from '../core/since.ts';
import { REPAIR_KINDS, resolveRepairScope, type RepairKind, type RepairResult, type RepairScope } from '../core/repair/core.ts';
import { consentGate, engineConsentEnv } from '../core/consent-cli.ts';
import { AUTO_REPAIR_REGISTRY, EXPLICIT_REPAIR_REGISTRY, LLM_REPAIR_REGISTRY, PREVIEW_BOUND_REPAIR_REGISTRY, REPAIR_REGISTRY, explicitRepairNotices, repairMayEmbed, repairMaySpend,
  repairPreviewCommand, repairRunner, repairSpec, type RepairKindSpec } from '../core/repair/registry.ts';
import { CONTENT_REPAIR_KINDS } from '../core/repair/content-lane.ts';
import { kindErrorResult } from '../core/remediation/repairs.ts';
import { ItemRun } from '../core/item-failure.ts';

/** The content-repair lane's command word (#6377): parsed like a kind, dispatched to repair-content.ts, never a RepairKind. */
export const CONTENT_LANE = 'content';
const REPAIR_CONTENT_HELP = `       gbrain repair content [--source <id>] [--only <path>]... [--skip <path>]... [--no-llm] [--max-usd <n>] [--diff]
                             [--apply [--expect <hash>[,<hash>]]] [--json]`;
const REPAIR_CONTENT_SUMMARY = `  content      The content-repair lane (#6377), not a kind: runs ${CONTENT_REPAIR_KINDS.join(', then ')} over the same
               --source/--only selection, so the holds managed sync records for a file's content (invalid_fence,
               frontmatter_slug_conflict) clear in one pass. The preview plans every kind before anything is written and
               prints each kind's own hash; --apply --expect <h1>[,<h2>] applies exactly those sets (one hash per kind,
               in that order); --apply alone applies each kind's current plan as gbrain repair <kind> --apply does.
               --max-usd is the lane's allowance for the run: what the first kind spends is gone for the next. The
               maintenance run's content_repair phase runs the same lane by itself; sync unblock --apply runs it for
               the paths it holds.`;

function wrap(text: string, indent: number, width = 80): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && indent + line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join(`\n${' '.repeat(indent)}`);
}

const explicitKinds = EXPLICIT_REPAIR_REGISTRY.map(spec => spec.kind).join(', ');
const previewBoundKinds = PREVIEW_BOUND_REPAIR_REGISTRY.map(spec => spec.kind).join(', ');
const llmKinds = LLM_REPAIR_REGISTRY.map(spec => spec.kind).join(', ');

export const REPAIR_HELP = `Usage: gbrain repair [<kind>] [--apply] [--source <id>] [--limit <n>] [--no-embed] [--json]
       gbrain repair --all [--apply] [--source <id>] [--json]
       gbrain repair <explicit-only kind> [--include-ambiguous] [--apply --expect <preview-hash>] [--source <id>] [--json]
       gbrain repair frontmatter [--source <id>] [--include-ambiguous] [--only <path>]... [--skip <path>]... [--diff]
                                 [--apply --expect <preview-hash> --yes] [--json]
       gbrain repair fences [--source <id>] [--only <path>]... [--skip <path>]... [--slug <slug>]... [--diff]
                            [--no-llm] [--max-usd <n>] [--apply [--expect <preview-hash>]] [--limit <n>] [--json]
       gbrain repair receipt-compaction [--older-than <72h|30d>] [--include-failures] [--force]
                                        [--apply --expect <preview-hash> --yes] [--limit <n>] [--json]
       gbrain repair file-drift --source <id> (--slug <slug>... | --request <id>... | --all-drifted [--class <name>] [--since <ISO-8601|7d>])
                                [--only <glob>]... [--skip <glob>]... --prefer file|database [--apply --expect <preview-hash>] [--json]
       gbrain repair stuck-recovery [--source <id>] [--request-id <uuid>]
                                    [--keep prior|disk|withdrawn --apply --expect <preview-hash> --yes] [--json]
       gbrain repair ghost-pages --source <id> [--apply --expect <preview-hash> --yes] [--json]
       gbrain repair url-clone-fences [--source <id>] [--apply --expect <preview-hash> --yes] [--json]
       gbrain repair rename-identity --source <id> [--slug <new-slug> [--from <old-slug>] [--close]
                                     [--apply --expect <preview-hash> --yes]] [--json]
${REPAIR_CONTENT_HELP}

Repair residual damage that \`gbrain doctor\` reports. Dry run unless --apply.

Kinds:
${REPAIR_REGISTRY.map(spec => `  ${spec.kind.length < 13 ? spec.kind.padEnd(12) : `${spec.kind}\n${' '.repeat(14)}`} ${wrap(`${spec.explicit_only
    ? `[explicit-only; preview: ${repairPreviewCommand(spec.kind)}] ` : ''}${spec.summary}`, 15)}`).join('\n')}

Lanes:
${REPAIR_CONTENT_SUMMARY}

Options:
  --apply        Write the repair (no prompt). Without it, only preview.
  --source <id>  Limit to one source (default: every active source).
  --limit <n>    Repair at most n items; rerun the same command to continue.
  --no-embed     safe-chunks, contextual-mode: no provider call; embed later with gbrain embed --stale.
  --all          Run every kind in order (${AUTO_REPAIR_REGISTRY.map(spec => spec.kind).join(', ')}).
                 Explicit-only kinds (${explicitKinds}) never run here; name each one.
  --expect <hash>
                 Explicit-only and preview-bound kinds (${previewBoundKinds}): apply exactly the set the
                 preview printed under this hash. content: one hash per lane kind, comma-separated, in lane order.
  --include-ambiguous
                 Explicit-only kinds: widen the preview to ambiguous items (its hash covers them).
  --only <path>, --skip <path>
                 frontmatter, fences, slug-conflicts, content: select source-relative files (repeatable); the hash covers the selection.
                 file-drift: narrow the selected pages by canonical file path (repeatable; an exact path, or, on file-drift
                 only, a glob with * within a segment and ** across segments, e.g. --only 'concepts/**'); the hash and the apply command cover them.
  --slug <slug>  fences, file-drift: select a database page by slug (repeatable); the hash covers the selection.
                 rename-identity: the new page of the one open pair to preview (--from <old-slug> when two pairs share it).
  --close        rename-identity: release the pair's purge hold instead of carrying its identity; nothing moves.
  --prefer file|database, --request <id>, --all-drifted, --class <name>
                 file-drift: the side that wins; select conflict receipts by request id (repeatable), or every page
                 still drifted (refused across mixed drift classes unless --class keeps one). --keep is refused here:
                 --prefer database keeps the database copy, --prefer file keeps the file.
  --since <ISO-8601|7d>
                 file-drift: keep only pages whose newest drift conflict is at or after the instant (with --all-drifted, or
                 the bare survey). An age (7d, 12h) is resolved once to a concrete instant; the preview, its hash and the
                 printed apply command carry that instant, so the apply selects exactly what the preview did.
  --diff         frontmatter, fences, slug-conflicts, content: print every per-file diff, not one sample per class or tier.
  --no-llm       Kinds that may call a paid model (${llmKinds}) and the content lane: use only the free tiers;
                 model-tier items stay held with llm_disabled.
  --max-usd <n>  Kinds that may call a paid model (${llmKinds}) and the content lane: spend at most n USD on the
                 model in this run. It only lowers the cap (the daily fences.repair cap still applies); never raises it.
  --keep prior|disk|withdrawn
                 stuck-recovery --apply: the version of each blocked file to keep (the user's choice from the preview;
                 withdrawn is a withdrawal-mirror effect's only choice).
  --request-id <uuid>
                 stuck-recovery: resolve only this request's recovery (default: every blocked record of the source).
  --yes          frontmatter, conversation-labels, stuck-recovery, ghost-pages, rename-identity, url-clone-fences --apply: the user agreed to the previewed changes (destructive
                 consent; without it a terminal asks, and a non-interactive run exits 3 with the consent payload).
  --json         Machine-readable output with a stable shape (frontmatter: every per-file diff).

Any other option is refused. --max-usd caps only a paid-model kind's model spend; to cap
paid embedding work, preview gbrain doctor --remediation-plan --json and, after the user agrees,
run gbrain doctor --remediate --yes --include-repairs --max-usd <n> --expect <plan_hash>.
With no kind, previews every kind. Run it on the brain host.
Held files (the content lane, then the two-pass frontmatter repair): docs/guides/repair.md#held-files.
Malformed facts/takes fences (preview, apply, undo): docs/guides/repair.md#fences.
A write recovery blocked on unexpected_file_bytes: docs/guides/repair.md#stuck-recovery.
Live pages whose canonical file is missing (ghost pages): docs/guides/repair.md#ghost-pages.
A sources add --url clone whose pull stops at pull_blocked_local_changes: docs/guides/repair.md#url-clone-fences.
Renames whose identity sync did not keep (rename-identity): docs/guides/live-sync.md#renaming-a-page.`;

const BOOLEAN_FLAGS = new Set(['--apply', '--all', '--json', '--no-embed', '--include-ambiguous', '--diff', '--yes', '--no-llm', '--all-drifted', '--include-failures', '--force', '--close']);
const VALUE_FLAGS = new Set(['--source', '--limit', '--expect', '--only', '--skip', '--slug', '--max-usd', '--prefer', '--request', '--class', '--since', '--keep', '--request-id', '--older-than', '--from']);
/** Flags only some kinds accept, with the kinds that do. */
const KIND_FLAGS: Record<string, readonly string[]> = {
  '--only': ['frontmatter', 'fences', 'slug-conflicts', 'file-drift', CONTENT_LANE], '--skip': ['frontmatter', 'fences', 'slug-conflicts', 'file-drift', CONTENT_LANE], '--diff': ['frontmatter', 'fences', 'slug-conflicts', CONTENT_LANE], '--yes': ['frontmatter', 'conversation-labels', 'stuck-recovery', 'ghost-pages', 'rename-identity', 'url-clone-fences'],
  '--slug': ['fences', 'file-drift', 'rename-identity', 'overwritten-edits', 'origin-twins'], '--from': ['rename-identity'], '--close': ['rename-identity'], '--prefer': ['file-drift'], '--request': ['file-drift'], '--all-drifted': ['file-drift'], '--class': ['file-drift'], '--since': ['file-drift'],
  '--keep': ['stuck-recovery'], '--request-id': ['stuck-recovery'],
  '--older-than': ['receipt-compaction'], '--include-failures': ['receipt-compaction'], '--force': ['receipt-compaction'],
};
const VALUE_EXAMPLES: Record<string, string> = { '--source': 'default', '--limit': '50', '--expect': 'PLAN_HASH', '--only': 'notes/a.md', '--skip': 'notes/a.md',
  '--slug': 'notes/a', '--max-usd': '0.50', '--prefer': 'file', '--request': 'REQUEST_UUID', '--class': 'review_required', '--since': '7d', '--keep': 'prior',
  '--request-id': '123e4567-e89b-42d3-a456-426614174000', '--older-than': '30d', '--from': 'notes/old' };
/** A usage refusal whose fix is the read-only preview (gbrain repair without --apply writes nothing). */
const invalid = (message: string, suggestion: string, preview: string[] = ['gbrain', 'repair', '--json']) => opError('invalid_params', message, suggestion,
  { fix: readFix('Previews the repair; without --apply it writes nothing.', { argv: preview }) });

interface RepairArgs { kind?: string; apply: boolean; all: boolean; json: boolean; noEmbed: boolean; includeAmbiguous: boolean; diff: boolean; yes: boolean;
  noLlm: boolean; source?: string; limit?: string; expect?: string; maxUsd?: number; only: string[]; skip: string[]; slugs: string[];
  allDrifted: boolean; prefer?: 'file' | 'database'; requests: string[]; driftClass?: string; since?: string;
  keep?: 'prior' | 'disk' | 'withdrawn'; requestId?: string; olderThan?: string; includeFailures: boolean; force: boolean; from?: string; close: boolean }

/** `--max-usd` on a kind that never calls a paid model: the cap belongs to the doctor remediation run. */
function maxUsdRefusal(flag: string, cap: string | undefined, kind: string | undefined): OperationError {
  const value = cap && !cap.startsWith('-') ? cap : '<n>';
  return new OperationError('invalid_params', `${flag} applies only to a kind that may call a paid model (${llmKinds}); `
    + `${kind ? `gbrain repair ${kind} never does` : 'name that kind'}, so the repair did not run.`,
  `To cap paid repair work, preview gbrain doctor --remediation-plan --json, then after the user agrees run: gbrain doctor --remediate --yes --include-repairs --max-usd ${value} --expect <plan_hash> (plan_hash from the preview)`);
}

/**
 * #6696 C7: `--keep` belongs to stuck-recovery; on file-drift the side that wins is `--prefer`. The fix is the same
 * command with `--keep <v>` replaced by `--prefer database` (an existing --prefer kept), as a read-only preview.
 */
function fileDriftKeepRefusal(args: string[], keep: string): OperationError {
  const preview: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const flag = token.split('=')[0]!;
    if (flag === '--apply' || flag === '--yes' || flag === '--json') continue;
    if (flag === '--keep' || flag === '--expect') { if (!token.includes('=')) i++; continue; }
    preview.push(token);
  }
  const prefer = preview.includes('--prefer') || preview.some(token => token.startsWith('--prefer=')) ? [] : ['--prefer', 'database'];
  const argv = ['gbrain', 'repair', ...preview, ...prefer, '--json'];
  return opError('invalid_params', `--keep ${keep} does not apply to gbrain repair file-drift; it chooses the winning side with --prefer.`,
    `Use --prefer database to keep the database copy (or --prefer file to keep the file), then preview again: ${shellQuote(argv.slice(0, -1))}`,
    { fix: readFix('Previews the file-drift resolution with the database copy winning; without --apply it writes nothing.', { argv }) });
}

/** Strict parse: every flag is known, value flags carry a value, at most one kind. */
export function parseRepairArgs(args: string[]): RepairArgs {
  const parsed: RepairArgs = { apply: false, all: false, json: false, noEmbed: false, includeAmbiguous: false, diff: false, yes: false, noLlm: false, only: [], skip: [], slugs: [],
    allDrifted: false, requests: [], includeFailures: false, force: false, close: false };
  const used = new Set<string>();
  const positional: string[] = [];
  let maxUsdText: string | undefined;
  let maxUsdFlag: string | undefined;
  let keepText: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const equal = token.indexOf('=');
    const flag = equal < 0 ? token : token.slice(0, equal);
    if (KIND_FLAGS[flag]) used.add(flag);
    if (flag === '--max-cost') {
      const cap = equal < 0 ? args[i + 1] : token.slice(equal + 1);
      throw new OperationError('invalid_params', `${flag} is not a gbrain repair option; the repair did not run.`,
        `A paid-model kind takes --max-usd <n>. To cap paid repair work across kinds, preview gbrain doctor --remediation-plan --json, then after the user agrees run: gbrain doctor --remediate --yes --include-repairs --max-usd ${cap && !cap.startsWith('-') ? cap : '<n>'} --expect <plan_hash> (plan_hash from the preview)`);
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      if (equal >= 0) throw invalid(`${flag} does not accept a value.`, `Write ${flag} on its own, without =value; leave it out to keep it off.`);
      if (flag === '--apply') parsed.apply = true;
      else if (flag === '--all') parsed.all = true;
      else if (flag === '--json') parsed.json = true;
      else if (flag === '--include-ambiguous') parsed.includeAmbiguous = true;
      else if (flag === '--diff') parsed.diff = true;
      else if (flag === '--yes') parsed.yes = true;
      else if (flag === '--no-llm') parsed.noLlm = true;
      else if (flag === '--all-drifted') parsed.allDrifted = true;
      else if (flag === '--include-failures') parsed.includeFailures = true;
      else if (flag === '--force') parsed.force = true;
      else if (flag === '--close') parsed.close = true;
      else parsed.noEmbed = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw invalid(`Unknown option ${flag} for gbrain repair.`, `Remove ${flag}; gbrain repair accepts ${[...BOOLEAN_FLAGS, ...VALUE_FLAGS].join(', ')}.`);
    const value = equal >= 0 ? token.slice(equal + 1) : args[++i];
    if (!value || value.startsWith('--')) throw invalid(`${flag} requires a value.`, `Give ${flag} its value right after it, e.g. ${flag} ${VALUE_EXAMPLES[flag]}${flag === '--expect' ? ' (the plan_hash the preview printed)' : ''}.`);
    if (flag === '--source') parsed.source = value;
    else if (flag === '--expect') parsed.expect = value;
    else if (flag === '--only') parsed.only.push(value);
    else if (flag === '--skip') parsed.skip.push(value);
    else if (flag === '--slug') parsed.slugs.push(value);
    else if (flag === '--max-usd') { maxUsdText = value; maxUsdFlag = flag; }
    else if (flag === '--prefer') {
      if (value !== 'file' && value !== 'database') throw invalid('--prefer takes file or database.', 'Pass --prefer file (the canonical file wins) or --prefer database (the database copy wins).',
        ['gbrain', 'repair', 'file-drift', ...(parsed.source ? ['--source', parsed.source] : []), '--json']);
      parsed.prefer = value;
    }
    else if (flag === '--request') parsed.requests.push(value);
    else if (flag === '--from') parsed.from = value;
    else if (flag === '--class') parsed.driftClass = value;
    else if (flag === '--since') {
      try { parsed.since = parseSince(value, '--since'); } catch (error) {
        throw invalid((error as Error).message, 'Pass an ISO-8601 instant (2026-10-01T00:00:00Z) or an age (7d, 12h); the preview prints the concrete instant it selected.', ['gbrain', 'repair', 'file-drift', ...(parsed.source ? ['--source', parsed.source] : []), '--json']);
      }
    }
    else if (flag === '--older-than') {
      if (!OLDER_THAN_RE.test(value)) throw invalid(`--older-than takes hours (72 or 72h) or days (30d) (got "${value}").`, 'Pass the age, e.g. --older-than 30d.',
        ['gbrain', 'repair', 'receipt-compaction', '--json']);
      parsed.olderThan = value;
    }
    else if (flag === '--keep') keepText = value;
    else if (flag === '--request-id') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalid(`--request-id must be a request UUID (got "${value}").`,
        'Pass the request_id the stuck-recovery preview (or gbrain sources writer status --json) lists, e.g. --request-id 123e4567-e89b-42d3-a456-426614174000.', ['gbrain', 'repair', 'stuck-recovery', '--json']);
      parsed.requestId = value.toLowerCase();
    }
    else parsed.limit = value;
  }
  if (positional.length > 1) throw new OperationError('invalid_params', `Unexpected argument '${positional[1]}'; gbrain repair takes at most one kind.`,
    `Kinds: ${REPAIR_KINDS.join(', ')}.`);
  parsed.kind = positional[0];
  if (keepText !== undefined && parsed.kind === 'file-drift') throw fileDriftKeepRefusal(args, keepText);
  if (used.has('--yes') && REPAIR_REGISTRY.find(spec => spec.kind === parsed.kind)?.consent !== 'destructive') throw invalid('`--yes` is not accepted by gbrain repair; pass --apply to write.',
    `Preview first with gbrain repair${parsed.kind ? ` ${parsed.kind}` : ''}, then run the same command with --apply instead of --yes.`,
    ['gbrain', 'repair', ...(parsed.kind ? [parsed.kind] : []), ...(parsed.source ? ['--source', parsed.source] : []), '--json']);
  const kindOnly = [...used].find(flag => flag !== '--yes' && !KIND_FLAGS[flag]!.includes(parsed.kind ?? ''));
  if (kindOnly) {
    const kinds = KIND_FLAGS[kindOnly]!;
    throw new OperationError('invalid_params', `${kindOnly} applies only to gbrain repair ${kinds.join(' or ')}.`,
      `Preview it by name: gbrain repair ${kinds[kinds.length - 1]}${parsed.source ? ` --source ${parsed.source}` : ''}`);
  }
  if (keepText !== undefined) {
    if (keepText !== 'prior' && keepText !== 'disk' && keepText !== 'withdrawn') throw invalid(`--keep must be prior, disk or withdrawn (got "${keepText}").`,
      'Pass --keep prior to write the recorded prior bytes back, --keep disk to keep the bytes on disk, or --keep withdrawn to write a withdrawal mirror\'s withdrawn bytes; the preview lists which are available.', ['gbrain', 'repair', 'stuck-recovery', '--json']);
    parsed.keep = keepText;
  }
  const llmKind = LLM_REPAIR_REGISTRY.some(spec => spec.kind === parsed.kind) || parsed.kind === CONTENT_LANE;
  if (maxUsdFlag) {
    if (!llmKind) throw maxUsdRefusal(maxUsdFlag, maxUsdText, parsed.kind);
    const cap = Number(maxUsdText);
    if (!/^\d+(\.\d+)?$/.test(maxUsdText!.trim()) || !Number.isFinite(cap)) {
      throw invalid(`--max-usd must be a non-negative USD amount such as 0.50 (got "${maxUsdText}").`, 'Pass --max-usd as a decimal number of US dollars; 0 keeps the run to the free tiers.',
        ['gbrain', 'repair', parsed.kind!, ...(parsed.source ? ['--source', parsed.source] : []), '--json']);
    }
    parsed.maxUsd = cap;
  }
  if (parsed.noLlm && !llmKind) throw new OperationError('invalid_params', `--no-llm applies only to a kind that may call a paid model (${llmKinds}).`,
    `Preview it by name: gbrain repair ${LLM_REPAIR_REGISTRY[0]?.kind ?? 'fences'}${parsed.source ? ` --source ${parsed.source}` : ''}`);
  if (parsed.expect !== undefined && parsed.kind !== CONTENT_LANE && !PREVIEW_BOUND_REPAIR_REGISTRY.some(spec => spec.kind === parsed.kind)) {
    throw new OperationError('invalid_params', `--expect applies only to an explicit-only or preview-bound kind named on the command line (${previewBoundKinds}).`,
      `Preview one by name: ${repairPreviewCommand(PREVIEW_BOUND_REPAIR_REGISTRY[0]!.kind)}`);
  }
  if (parsed.includeAmbiguous && !EXPLICIT_REPAIR_REGISTRY.some(spec => spec.kind === parsed.kind)) {
    throw new OperationError('invalid_params', `--include-ambiguous applies only to an explicit-only kind named on the command line (${explicitKinds}).`,
      `Preview one by name: ${repairPreviewCommand(EXPLICIT_REPAIR_REGISTRY[0]!.kind)}`);
  }
  return parsed;
}

export function renderRepairResult(result: RepairResult, opts: { diff: boolean } = { diff: false }): string {
  const lines = [`${result.kind}: ${result.affected} item(s) ${result.mode === 'apply' ? 'pending before this run' : 'to repair'}`];
  for (const warning of result.warnings ?? []) lines.push(`  WARNING: ${warning}`);
  if (result.sample.length) lines.push(`  e.g. ${result.sample.join(', ')}`);
  const residuals = Object.entries(result.residuals).map(([k, v]) => `${k}=${v}`).join(', ');
  if (residuals) lines.push(`  ${residuals}`);
  const { llm_usd: llmUsd, llm_cap_remaining_usd: llmLeft } = result.cost;
  lines.push(`  cost: ${result.cost.lifetime_ids} request ID(s), ${result.cost.receipt_bytes} receipt bytes, `
    + `${result.cost.embedding_pages} page(s) to re-embed${result.cost.embedding_usd === null ? '' : ` (~$${result.cost.embedding_usd.toFixed(4)})`}`
    + `${llmUsd === undefined ? '' : `, paid model ${llmUsd === null ? 'unpriced' : result.mode === 'apply' ? `$${llmUsd.toFixed(4)} spent` : `~$${llmUsd.toFixed(4)}`}`
      + `${typeof llmLeft === 'number' ? ` ($${llmLeft.toFixed(4)} left under today's cap)` : ''}`}`);
  for (const c of result.capacity) lines.push(`  capacity ${c.scope} ${c.resource}: ${c.used} of ${c.limit} (stops at ${c.stop_at})`);
  if (result.resumed_from) lines.push(`  resuming after item ${result.resumed_from.phase}:${result.resumed_from.id}`);
  if (result.mode === 'apply') lines.push(`  applied ${result.applied}, skipped ${result.skipped}, failed ${result.failed.length}${result.complete ? ', complete' : ''}`);
  for (const failed of result.mode === 'apply' ? result.failed : []) lines.push(`  FAILED ${failed.item} (${failed.reason}): ${failed.message}`);
  if (result.mode === 'apply' && result.failed.length) {
    lines.push(`  ${result.failed.length} item(s) left unchanged; a resumed run skips past them, the next full scan retries them: ${result.apply_command}`);
  }
  if (result.mode === 'apply' && result.repaired !== undefined) {
    const left = Object.entries(result.remaining ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
    lines.push(`  repaired ${result.repaired}; ${left ? `still waiting: ${left}` : 'nothing left in this selection'}`);
  }
  if (result.scan?.partial) lines.push('  scan: partial (the census did not finish within its bound; more candidates may exist, rerun to resume it)');
  if (result.stopped) lines.push(`  STOPPED: ${result.stopped.message}`);
  if (result.stopped?.fix?.argv) lines.push(`  fix: ${shellQuote(result.stopped.fix.argv)}${result.stopped.fix.consent.length ? ` (asks the user first: ${result.stopped.fix.consent.join(', ')})` : ''}`);
  for (const entry of result.listing ?? []) lines.push(`  ${entry.class}: ${entry.item}${entry.detail ? ` (${entry.detail})` : ''}`);
  const render = repairSpec(result.kind).handler.render;
  if (result.details && render) lines.push(...render(result.details, opts));
  if (result.mode === 'apply' && result.outcomes) lines.push(`  outcomes: ${Object.entries(result.outcomes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  for (const outcome of result.mode === 'apply' ? result.outcome_items ?? [] : []) {
    if (!outcome.detail) continue;
    lines.push(`  ${outcome.outcome}: ${outcome.item} ${Object.entries(outcome.detail).filter(([key]) => key !== 'commit_step').map(([k, v]) => `${k}=${v}`).join(', ')}${outcome.reason ? ` (${outcome.reason})` : ''}`);
    if (typeof outcome.detail.commit_step === 'string') lines.push(`    commit: ${outcome.detail.commit_step}`);
  }
  if (result.mode === 'dry_run' && result.affected) lines.push(`  apply: ${result.apply_command}`);
  return lines.join('\n');
}

export async function runRepairCommand(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(REPAIR_HELP); return; }
  const { kind, apply, all, json, noEmbed, includeAmbiguous, source, expect, only, skip, slugs, diff, noLlm, maxUsd, limit: limitText,
    prefer, requests, allDrifted, driftClass, since, keep, requestId, olderThan, includeFailures, force, from, close } = parseRepairArgs(args);
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw invalid('--limit must be a positive integer.', 'Pass --limit as a positive whole number, e.g. --limit 50, or omit it to repair every item.');
  // #6712 PR 2: a repair apply is a soak intervention; a file-drift apply is a content decision (soak-counters.ts).
  if (apply && (kind === CONTENT_LANE || REPAIR_KINDS.includes(kind as RepairKind) || (!kind && all))) await (await import('../core/persistence/soak-counters.ts')).recordSoakEvent(engine, kind === 'file-drift' ? 'file_drift_apply' : 'repair_apply');
  if (kind === CONTENT_LANE) {
    if (all) throw invalid('Pass either content or --all, not both.', 'Drop --all to run the content lane, or drop content to run every automatic kind.', ['gbrain', 'repair', CONTENT_LANE, ...(source ? ['--source', source] : []), '--json']);
    const { runRepairContentCommand } = await import('./repair-content.ts');
    return runRepairContentCommand(engine, { apply, json, diff, noLlm, noEmbed, source, expect, maxUsd, only, skip, limit });
  }
  if (kind && !REPAIR_KINDS.includes(kind as RepairKind)) {
    throw new OperationError('invalid_params', `Unknown repair kind '${kind}'.`, `Kinds: ${REPAIR_KINDS.join(', ')}; lanes: ${CONTENT_LANE}.`);
  }
  if (kind && all) throw invalid('Pass either a kind or --all, not both.', `Drop --all to repair only ${kind}, or drop ${kind} to run every automatic kind.`,
    ['gbrain', 'repair', kind, ...(source ? ['--source', source] : []), '--json']);
  if (!kind && apply && !all) throw invalid('Name a kind or pass --all with --apply.',
    'Review the preview of every automatic kind, then apply one by name (gbrain repair KIND --apply) or all of them with --all --apply.',
    ['gbrain', 'repair', ...(source ? ['--source', source] : []), '--json']);
  const kinds: RepairKind[] = kind ? [kind as RepairKind] : AUTO_REPAIR_REGISTRY.map(spec => spec.kind);
  const explicitKindsNotRun = kind ? [] : explicitRepairNotices({ source });
  const scope = await resolveRepairScope(engine, source);
  if (apply && kind && expect && repairSpec(kind as RepairKind).consent === 'destructive') {
    const preview = ['gbrain', 'repair', kind, ...(source ? ['--source', source] : []), ...only.flatMap(path => ['--only', path]), ...skip.flatMap(path => ['--skip', path]),
      ...(includeAmbiguous ? ['--include-ambiguous'] : []), ...(requestId ? ['--request-id', requestId] : []),
      ...(olderThan ? ['--older-than', olderThan] : []), ...(includeFailures ? ['--include-failures'] : []), ...(force ? ['--force'] : []),
      ...(kind === 'rename-identity' ? [...slugs.flatMap(slug => ['--slug', slug]), ...(from ? ['--from', from] : []), ...(close ? ['--close'] : [])] : []),
      ...(kind === 'origin-twins' ? slugs.flatMap(slug => ['--slug', slug]) : [])];
    const custom = repairSpec(kind as RepairKind).consentText;
    const text = custom ? { ...custom, why: `Preview ${expect}: ${custom.why}`, user_message: `${custom.user_message} (preview ${expect.slice(0, 12)}${keep ? `, keep ${keep}` : ''})` } : {
      what: `Rewrite the previewed ${kind} changes on disk and import them`,
      why: `The preview ${expect} listed each file change; applying it rewrites those files in place and publishes them.`,
      risk: 'Only the previewed lines change; a file that changed since the preview is skipped. Managed sources commit through the Git effect (undo with git revert); legacy sources keep a backup under ~/.gbrain/backups/frontmatter/.',
      user_message: `Apply the previewed ${kind} repair (preview ${expect.slice(0, 12)})? Each listed file is rewritten on disk exactly as the preview showed and imported again.` };
    const auth = await consentGate({ command: `repair ${kind}`, effects: ['destructive'], actor: 'agent', ...text,
      argv: [...preview, ...(keep ? ['--keep', keep] : []), '--apply', '--expect', expect, ...(json ? ['--json'] : [])], preview_argv: [...preview, '--json'], plan_hash: expect, args }, { json, env: engineConsentEnv(engine) });
    if (!auth) return;
  }
  const runner = await repairRunner(engine, { apply, noEmbed });
  const results = await runRepairKinds(kinds, scope, { apply, source, noEmbed, named: kind !== undefined }, k => runner.run(k, scope, { limit, sourceFlag: source, explicit: k === kind, expect, includeAmbiguous,
    ...(k === kind && KIND_FLAGS['--only']!.includes(k) ? { only, skip } : {}), ...(k === kind && slugs.length ? { slugs } : {}),
    ...(k === kind && noLlm ? { noLlm } : {}), ...(k === kind && maxUsd !== undefined ? { maxLlmUsd: maxUsd } : {}),
    ...(k === kind && k === 'file-drift' ? { prefer, requests, allDrifted, driftClass, since } : {}),
    ...(k === kind && keep ? { keep } : {}), ...(k === kind && requestId ? { requestId } : {}),
    ...(k === kind && k === 'receipt-compaction' ? { olderThan, includeFailures, force } : {}),
    ...(k === kind && k === 'rename-identity' ? { from, close } : {}) }));
  if (apply) clearHealthMemo(engine);
  const paidKinds = results.filter(r => r.paid).map(r => r.kind);
  if (json) {
    console.log(JSON.stringify({ scope, mode: apply ? 'apply' : 'dry_run', results, paid_kinds: paidKinds,
      ...(explicitKindsNotRun.length ? { explicit_kinds: explicitKindsNotRun } : {}) }, null, 2));
  } else {
    console.log(`Scope: brain ${scope.brain_id}; sources ${scope.source_ids.join(', ') || '(none)'}`);
    for (const result of results) console.log(renderRepairResult(result, { diff }));
    const embedKinds = results.filter(r => repairMayEmbed(repairSpec(r.kind), noEmbed)).map(r => r.kind);
    if (!apply && embedKinds.length) console.log(`Kinds that may queue paid embeddings: ${embedKinds.join(', ')} (pass --no-embed to skip; `
      + 'page-write kinds are re-embedded by their publication either way; cap spend with gbrain doctor --remediate --yes --include-repairs --max-usd <n> --expect <plan_hash> from gbrain doctor --remediation-plan --json).');
    const llmResults = results.filter(r => r.cost.llm_usd !== undefined);
    if (!apply && llmResults.length) {
      const usd = llmResults.some(r => r.cost.llm_usd === null) ? null : llmResults.reduce((sum, r) => sum + (r.cost.llm_usd ?? 0), 0);
      const left = llmResults.map(r => r.cost.llm_cap_remaining_usd).filter((cap): cap is number => typeof cap === 'number');
      console.log(`Kinds that may call a paid model: ${llmResults.map(r => r.kind).join(', ')} (${usd === null ? 'estimate unavailable: the model is unpriced' : `estimated $${usd.toFixed(4)}`}`
        + `${left.length ? `; $${Math.min(...left).toFixed(4)} left under today's cap` : ''}).`);
    }
    if (explicitKindsNotRun.length) console.log(`Explicit-only kinds (not run without their name; preview each): ${explicitKindsNotRun.map(n => n.preview_command).join('; ')}`);
  }
  if (repairExitVerdict(results) !== 0) setCliExitVerdict(1);
}

/**
 * Runs each kind in order; a kind that stops (capacity, a held writer, a pending write) ends the loop. A kind whose plan
 * or apply throws item-scoped (GBRA-130 A-45) is reported as a result stopped with reason `error` and the loop goes on;
 * a run-scoped error, or most kinds failing (`item_failures_systemic`), stops the command. `named`: the operator named
 * one kind, whose error is the command's error. `registry`: the kinds' specs (tests pass stubs).
 */
export async function runRepairKinds(kinds: readonly RepairKind[], scope: RepairScope, opts: { apply: boolean; source?: string; noEmbed: boolean; named: boolean; registry?: readonly RepairKindSpec[] },
  run: (kind: RepairKind) => Promise<RepairResult>): Promise<Array<RepairResult & { paid: boolean }>> {
  const results: Array<RepairResult & { paid: boolean }> = [];
  const kindRun = new ItemRun('repair.all_kinds');
  for (const k of kinds) {
    let result: RepairResult;
    try {
      result = await run(k);
      kindRun.succeed();
    } catch (error) {
      if (opts.named) throw error;
      kindRun.fail(k, error);
      results.push({ ...kindErrorResult(k, scope, { apply: opts.apply, error, source: opts.source }), paid: false });
      continue;
    }
    results.push({ ...result, paid: repairMaySpend(repairSpec(k, opts.registry), opts.noEmbed) });
    if (result.stopped) break;
  }
  return results;
}

/** Exit 1 when any kind stopped early or refused an item; 0 only when every pending item was attempted and applied or skipped. */
export function repairExitVerdict(results: ReadonlyArray<Pick<RepairResult, 'stopped' | 'failed'>>): 0 | 1 {
  return results.some(r => r.stopped || r.failed.length > 0) ? 1 : 0;
}
