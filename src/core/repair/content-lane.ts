/**
 * The content-repair lane (#6377): the repair kinds that clear managed-sync
 * content holds, run as one bounded pass under one paid-model allowance.
 *
 * `CONTENT_REPAIR_KINDS` is the lane in dependency order; `gbrain repair
 * content`, the `content_repair` maintenance phase (src/core/cycle/
 * content-repair.ts) and `gbrain sync unblock --apply` all read it, so a new
 * kind plugs in with one entry here. Today it holds `fences`; the GBRA-72
 * integration appends `slug-conflicts` (Lane B, src/core/repair/
 * slug-conflicts.ts). `CONTENT_REPAIR_HOLD_KINDS` maps a hold code to the kind
 * that clears it (`null`: no kind yet, the surfaces keep today's refusal text).
 *
 * `runContentLane` has no rule logic of its own: it runs each kind through
 * the shared trusted `repairRunner`, so every kind keeps its own census, owner
 * checks, caps, ledger, memo and gates. What the lane adds is the contract
 * between kinds: the run's paid allowance (`maxLlmUsd`) flows from one kind to
 * the next minus what the earlier kinds spent (read from each result's
 * `cost.llm_usd`; the daily ledger is shared by every kind, `FENCE_REPAIR_LEDGER`),
 * and one absolute deadline bounds the whole pass. A preview builds every
 * component plan before any mutation and returns each kind's own preview
 * hash; `--apply --expect <h1>[,<h2>]` applies exactly those sets, one hash
 * per kind in lane order, so the operator's approval binds both concrete plans
 * (Codex #10). There is no combined hash. A bare apply (the cycle, `sync
 * unblock`, `--apply` alone) applies each kind's current plan the way
 * `gbrain repair <kind> --apply` does: the kind plans and applies in one run,
 * each item bound to the bytes its plan read (`changed_since_read`), and
 * records on every hold it leaves why (a preview records nothing).
 *
 * `contentHoldDisposition` is the one place that reads a hold's stored repair
 * state (a fence hold's `fenceHoldStatus`, a slug-conflict hold's
 * `meta.content_repair.action`) to say whether unattended surfaces may run the
 * kind on it or must list it for a person. Output is counts, codes, hashes
 * and paths only: never a claim, a cell or a frontmatter value.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { shellQuote } from '../agent-output.ts';
import { fenceHoldStatus, type FenceAutoRepair } from '../fence-repair/hold-fix.ts';
import type { GitHoldRecord } from '../persistence/sync-holds.ts';
import type { RepairKind, RepairResult, RepairScope } from './core.ts';
import { repairRunner, type RepairKindSpec } from './registry.ts';

/** The lane, in run order: fences first (a merged or closed fence can change what a slug conflict's page looks like), then slug conflicts. */
export const CONTENT_REPAIR_KINDS: readonly RepairKind[] = ['fences', 'slug-conflicts'];

/** Which lane kind clears a hold code; a code with `null` is refused by `sync unblock` with the fix it names. */
export const CONTENT_REPAIR_HOLD_KINDS: Readonly<Partial<Record<GitHoldRecord['code'], RepairKind | null>>> = {
  invalid_fence: 'fences',
  frontmatter_slug_conflict: 'slug-conflicts',
};

/** A hold's stored repair decision, when the lane recorded one (Lane B writes it; read loosely so either lane lands first). */
function storedContentAction(meta: GitHoldRecord['meta']): string | undefined {
  const action = (meta as { content_repair?: { action?: unknown } }).content_repair?.action;
  return typeof action === 'string' ? action : undefined;
}

export type ContentHoldDisposition =
  /** An unattended run may run `kind` on this hold now. */
  | { action: 'repair'; kind: RepairKind }
  /** The hold waits on a person (`needs_human`), the user's spend decision (`paid`) or the owner host (`owner`); list it, never retry it. */
  | { action: 'listed'; kind: RepairKind; state: 'needs_human' | 'paid' | 'owner'; reason: string }
  /** No lane kind clears this code yet. */
  | { action: 'unsupported' };

/**
 * What an unattended surface (`sync unblock --apply`, the cycle) may do with
 * one hold. `auto` is what the caller read about the maintenance run
 * (`fenceAutoRepairFor`); it decides a fence hold's state exactly as the
 * hold's own fix does.
 */
export function contentHoldDisposition(record: Pick<GitHoldRecord, 'code' | 'meta'>, auto?: FenceAutoRepair): ContentHoldDisposition {
  const kind = CONTENT_REPAIR_HOLD_KINDS[record.code];
  if (!kind) return { action: 'unsupported' };
  if (record.code === 'invalid_fence') {
    const status = fenceHoldStatus(record.meta, auto);
    if (status.state === 'manual' || status.state === 'approval') return { action: 'listed', kind, state: 'needs_human', reason: status.reason };
    if (status.state === 'paid' || status.state === 'owner') return { action: 'listed', kind, state: status.state, reason: status.reason };
    return { action: 'repair', kind };
  }
  const stored = storedContentAction(record.meta);
  if (stored === 'merge_into') return { action: 'listed', kind, state: 'needs_human', reason: 'merge_recommended' };
  if (stored === 'needs_human') return { action: 'listed', kind, state: 'needs_human', reason: 'content_repair_needs_human' };
  return { action: 'repair', kind };
}

export interface ContentLaneOptions {
  apply: boolean;
  /** The kinds to run, in order (default: the whole lane). */
  kinds?: readonly RepairKind[];
  /** Source-relative file selection, handed to every kind (its hash covers it). */
  only?: string[];
  skip?: string[];
  /** One preview hash per kind in `kinds` order; the apply binds each kind to exactly that set. */
  expect?: readonly string[];
  /** Free tiers only, for every kind. */
  noLlm?: boolean;
  /** The run's paid-model allowance in USD for the whole lane; what one kind spends is gone for the next. */
  maxLlmUsd?: number;
  /** Absolute deadline (epoch ms) for the whole lane; a kind stopped `time_budget` ends the pass. */
  deadline?: number;
  limit?: number;
  noEmbed?: boolean;
  /** `--source <id>` as the operator wrote it, for the printed commands. */
  sourceFlag?: string;
  /** Replaces the registered kinds (tests pass stub specs). */
  registry?: readonly RepairKindSpec[];
  logger?: OperationContext['logger'];
}

export interface ContentLaneResult {
  mode: 'dry_run' | 'apply';
  scope: RepairScope;
  /** The kinds the lane ran, in order; one `results` entry each. */
  kinds: RepairKind[];
  results: RepairResult[];
  /** Each kind's own preview hash on a dry run, the hash each apply was bound to with `expect` (null: the kind printed none, or a bare apply). */
  preview_hashes: Partial<Record<RepairKind, string | null>>;
  /** Paid-model spend across the lane: the estimate on a dry run, the actual spend on an apply; the allowance left under `maxLlmUsd` (null: no run cap). */
  cost: { llm_usd: number; llm_allowance_remaining_usd: number | null };
  /** Every kind that stopped, with its reason (`time_budget` ends the lane; the rest let the next kind run). */
  stopped: Array<{ kind: RepairKind } & NonNullable<RepairResult['stopped']>>;
  /** The command that applies exactly these plans (dry run), or reruns the lane (apply). */
  apply_command: string;
}

/** `gbrain repair content [--source <id>] [--only <p>]... [--skip <p>]... [--no-llm] [--max-usd <n>] [--apply [--expect <h1>,<h2>]]`. */
export function contentLaneArgv(opts: { source?: string; only?: readonly string[]; skip?: readonly string[]; noLlm?: boolean; maxLlmUsd?: number; apply?: boolean; expect?: readonly string[] }): string[] {
  return ['gbrain', 'repair', 'content', ...(opts.source ? ['--source', opts.source] : []), ...(opts.only ?? []).flatMap(path => ['--only', path]),
    ...(opts.skip ?? []).flatMap(path => ['--skip', path]), ...(opts.noLlm ? ['--no-llm'] : []), ...(opts.maxLlmUsd !== undefined ? ['--max-usd', String(opts.maxLlmUsd)] : []),
    ...(opts.apply ? ['--apply'] : []), ...(opts.expect?.length ? ['--expect', opts.expect.join(',')] : [])];
}

/**
 * `--expect <h1>[,<h2>]` → one hash per kind, in order. Refuses a count that
 * does not match the kinds the lane runs: the operator previewed a different
 * lane, so no hash can be matched to a kind.
 */
export function parseContentLaneExpect(text: string, kinds: readonly RepairKind[], previewArgv: string[]): string[] {
  const hashes = text.split(',').map(hash => hash.trim()).filter(Boolean);
  if (hashes.length === kinds.length) return hashes;
  throw opError('invalid_params', `--expect takes one preview hash per kind of the content lane, comma-separated in lane order (${kinds.join(', ')}); got ${hashes.length} hash(es) for ${kinds.length} kind(s), so nothing ran.`,
    `Preview the lane again and pass the hashes it prints: ${shellQuote(previewArgv)} prints each kind's own hash and the exact apply command.`,
    { fix: readFix('Previews every lane kind; it writes nothing and calls no model.', { argv: previewArgv }) });
}

export async function runContentLane(engine: BrainEngine, scope: RepairScope, opts: ContentLaneOptions): Promise<ContentLaneResult> {
  const kinds = [...(opts.kinds ?? CONTENT_REPAIR_KINDS)];
  const previewArgv = contentLaneArgv({ source: opts.sourceFlag, only: opts.only, skip: opts.skip, noLlm: opts.noLlm, maxLlmUsd: opts.maxLlmUsd });
  if (opts.expect && opts.expect.length !== kinds.length) parseContentLaneExpect(opts.expect.join(','), kinds, previewArgv);
  const runner = await repairRunner(engine, { apply: opts.apply, noEmbed: opts.noEmbed, ...(opts.logger ? { logger: opts.logger } : {}), ...(opts.registry ? { registry: opts.registry } : {}) });
  const hashes: ContentLaneResult['preview_hashes'] = {};
  const stopped: ContentLaneResult['stopped'] = [];
  const results: RepairResult[] = [];
  let spent = 0;
  const allowance = () => opts.maxLlmUsd === undefined ? undefined : Math.max(0, opts.maxLlmUsd - spent);
  for (const [index, kind] of kinds.entries()) {
    const expect = opts.expect?.[index];
    const result = await runner.run(kind, scope, { explicit: true, limit: opts.limit, sourceFlag: opts.sourceFlag, only: opts.only, skip: opts.skip, noLlm: opts.noLlm,
      maxLlmUsd: allowance(), deadline: opts.deadline, ...(expect ? { expect } : {}) });
    hashes[kind] = expect ?? result.preview_hash ?? null;
    spent += result.cost.llm_usd ?? 0;
    results.push(result);
    if (result.stopped) stopped.push({ kind, ...result.stopped });
    if (result.stopped?.reason === 'time_budget') break;
  }
  const expect = kinds.map(kind => hashes[kind] ?? null);
  return { mode: opts.apply ? 'apply' : 'dry_run', scope, kinds, results, preview_hashes: hashes, cost: { llm_usd: spent, llm_allowance_remaining_usd: allowance() ?? null }, stopped,
    apply_command: shellQuote(contentLaneArgv({ source: opts.sourceFlag, only: opts.only, skip: opts.skip, noLlm: opts.noLlm, maxLlmUsd: opts.maxLlmUsd, apply: true,
      expect: expect.every((hash): hash is string => hash !== null) ? expect : undefined })) };
}
