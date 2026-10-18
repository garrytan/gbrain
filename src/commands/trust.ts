/**
 * `gbrain trust` owner subcommands (#5575: CEO-2, CEO-9, DX-2, DX-3, DX-7,
 * DX-10, DX-13, DX-14, DX-15, ENG-15): review, confirm, release, drop,
 * revert, explain, allow, disable. `backfill` lives in the dispatch module
 * (src/cli/commands/trust.ts).
 *
 * Every action previews the target, asks the owner to type its token on an
 * interactive terminal when the action raises trust (trust/confirm.ts; piped
 * input, agents and --yes never confirm), then applies it bound to the
 * previewed state. The backend is the local engine, or, while a resident
 * `gbrain serve` holds a PGLite brain, that owner's 0600 administration
 * socket (trust/owner-ipc.ts): the prompt still happens here, in the
 * invoking terminal, and the owner re-validates the binding.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { jsonRequested, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { OperationError, opError, type OperationContext } from '../core/ops/contract.ts';
import type { Principal } from '../core/persistence/model.ts';
import { maintenanceAttribution } from '../core/persistence/attribution.ts';
import { requireOwnerConfirmation } from '../core/trust/confirm.ts';
import {
  applyOwnerAction, previewOwnerAction, type OwnerActionInput, type OwnerActionPreview, type OwnerActionResult,
} from '../core/trust/owner-actions.ts';
import {
  buildTrustReview, explainTrust, parseTrustReviewKind, parseTrustSince, renderTrustExplanation, renderTrustReview,
  type TrustExplanation, type TrustReview, type TrustReviewFilter,
} from '../core/trust/review.ts';
import { trustLabel } from '../core/trust/tier.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import { writeCliError } from '../cli/cli-error.ts';

export const TRUST_OWNER_USAGE = [
  'Usage: gbrain trust <review|confirm|release|drop|revert|explain|allow|disable|backfill|scan> [options]',
  '  review [--from <source>] [--kind <kind>] [--since <7d|date>] [--json]',
  '      Everything waiting for you: trust proposals (tp<id>), pages an agent edit lowered, unconfirmed standing',
  '      preferences (f<id>), held writes (h<id>) and your allow rules (a<id>), grouped by day and page, each with',
  '      its exact commands.',
  '  review --accept-all (--from <source> | --kind <kind> | --since <when>)...',
  '      Accept every listed item matching the filters (at least one filter) after one typed confirmation.',
  '  confirm <f<id>|t<id>|p:<source>/<slug>|tp<id>|h<id>> [--source <id>]',
  '      Mark it "confirmed by you" (accepts a proposal; releases a held write). Asks you to type its token.',
  '  release <h<id>>          Release a held write into memory as "confirmed by you" (asks for its token).',
  '  drop <tp<id>|h<id>>      Dismiss a proposal, or drop a held write. Nothing gains trust.',
  '  revert <tp<id>|p:<source>/<slug>> [--version <id>] [--source <id>]',
  '      Restore the page version before an agent edit (or the version you name) with its own tier.',
  '  explain <ref|phrase> [--source <id>]',
  '      Tier, origin (including what a derived row came from), write-gate receipts, pending decisions and where',
  '      the row is used.',
  '  allow --source <id> [--uri-prefix <prefix>] [--reason-family <family>] [--reason <text>]',
  '  allow --remove <a<id>>',
  '      Stop holding instruction-like content from a source (matches the server-stamped source URI, never',
  '      frontmatter). Listed in review; adding one asks for its token.',
  '  disable --all [--undo]',
  '      Kill switch: write_gate.external_mode=off, write_gate.agent_mode=off, trust.agent_activation=allow.',
  '      --undo restores what disable replaced. Local only; asks for its token.',
  '  Refs: f<id> fact, t<id> take, h<id> held write, tp<id> trust proposal, a<id> allow rule, p:<source>/<slug> page',
  '  (a bare slug works when it lives in one source, or with --source). --yes never confirms; these commands need',
  '  you at a terminal on the brain host.',
].join('\n');

/** Where the owner actions run: this process's engine, or the resident owner over its local socket. */
export interface TrustBackend {
  review(filter: TrustReviewFilter): Promise<TrustReview>;
  explain(query: string, source: string | null): Promise<TrustExplanation[]>;
  preview(input: OwnerActionInput): Promise<OwnerActionPreview>;
  apply(input: OwnerActionInput, binding: string, confirmed: boolean): Promise<OwnerActionResult>;
}

export function localTrustBackend(engine: BrainEngine, config?: GBrainConfig): TrustBackend {
  let principal: Promise<Principal> | undefined;
  const by = () => (principal ??= maintenanceAttribution(engine).then(a => a.principal));
  return {
    review: filter => buildTrustReview(engine, filter),
    explain: (query, source) => explainTrust(engine, query, { source }),
    preview: input => previewOwnerAction(engine, input),
    apply: async (input, binding, confirmed) => applyOwnerAction(engine, input, {
      binding, confirmation: confirmed ? { via: 'tty' } : null, by: await by(), ...(config ? { config } : {}),
    }),
  };
}

const OWNER_SUBCOMMANDS = ['review', 'confirm', 'release', 'drop', 'revert', 'explain', 'allow', 'disable'] as const;
export const isTrustOwnerSubcommand = (sub: string | undefined): boolean => (OWNER_SUBCOMMANDS as readonly string[]).includes(sub ?? '');

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw opError('invalid_params', `${name} needs a value.`, `Pass ${name} <value>; gbrain trust --help shows the forms.`);
  return value;
}
const VALUE_FLAGS = ['--from', '--kind', '--since', '--source', '--version', '--uri-prefix', '--reason-family', '--reason', '--remove'];
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i]!)) { i++; continue; }
    if (!args[i]!.startsWith('--')) out.push(args[i]!);
  }
  return out;
}

function reviewFilter(args: string[]): TrustReviewFilter {
  const from = flag(args, '--from');
  const kind = flag(args, '--kind');
  const since = flag(args, '--since');
  return { ...(from ? { sourceId: from } : {}), ...(kind ? { kind: parseTrustReviewKind(kind) } : {}), ...(since ? { since: parseTrustSince(since) } : {}) };
}

function actionInput(sub: string, args: string[]): OwnerActionInput {
  const [ref] = positionals(args);
  const source = flag(args, '--source') ?? null;
  if (sub === 'allow') {
    const remove = flag(args, '--remove');
    if (remove) return { action: 'allow_remove', ref: remove };
    return { action: 'allow', source, uri_prefix: flag(args, '--uri-prefix') ?? null, reason_family: flag(args, '--reason-family') ?? null, reason: flag(args, '--reason') ?? null };
  }
  if (sub === 'disable') {
    if (!args.includes('--all')) throw opError('invalid_params', 'trust disable needs --all.', 'Run gbrain trust disable --all (or --all --undo to turn the protections back on).');
    return { action: args.includes('--undo') ? 'enable' : 'disable' };
  }
  if (!ref) throw opError('invalid_params', `trust ${sub} needs a ref.`, 'Pass a ref such as f12, h4, tp7 or p:default/notes/alice-example; gbrain trust review lists them.');
  const version = flag(args, '--version');
  if (version !== undefined && !/^\d{1,18}$/.test(version)) throw opError('invalid_params', '--version takes a version id.', 'gbrain history with the page slug lists its version ids.');
  return { action: sub as OwnerActionInput['action'], ref, source, ...(version ? { version: Number(version) } : {}) };
}

const LOCAL_CTX = { remote: false } as OperationContext;

/** One owner action: preview, typed confirmation when it raises trust, then apply bound to the preview. */
export async function runOwnerAction(backend: TrustBackend, input: OwnerActionInput): Promise<{ preview: OwnerActionPreview; result: OwnerActionResult }> {
  const preview = await backend.preview(input);
  if (preview.raises) await requireOwnerConfirmation(LOCAL_CTX, { ref: preview.ref, token: preview.token, summary: preview.summary, command: preview.command });
  return { preview, result: await backend.apply(input, preview.binding, preview.raises) };
}

function resultLine(r: OwnerActionResult): string {
  const tier = r.tier ? ` (now "${trustLabel(r.tier)}"${r.prior_tier && r.prior_tier !== r.tier ? `, was "${trustLabel(r.prior_tier)}"` : ''})` : '';
  return `${r.ref}: ${r.status}${tier}`;
}

/** DX-15: accept every matching item after one typed confirmation. */
async function acceptAll(backend: TrustBackend, args: string[], json: boolean): Promise<void> {
  const filter = reviewFilter(args);
  if (!filter.sourceId && !filter.kind && !filter.since) {
    throw opError('invalid_params', 'review --accept-all needs at least one filter: --from <source>, --kind <kind> or --since <when>.',
      'Narrow it first, e.g. gbrain trust review --accept-all --from default --since 7d; run gbrain trust review to see what would match.');
  }
  const review = await backend.review(filter);
  const inputs = review.items.map(item => ({ action: item.kind === 'hold' ? 'release' : 'confirm', ref: item.ref, source: item.source_id } as OwnerActionInput));
  if (inputs.length === 0) {
    if (json) await writeStdoutFinal(`${JSON.stringify({ accepted: [], skipped: [] }, null, 2)}\n`); else console.log('Nothing matches those filters.');
    return;
  }
  const previews = await Promise.all(inputs.map(input => backend.preview(input)));
  const command = ['gbrain', 'trust', 'review', '--accept-all', ...args.filter(a => a !== '--accept-all' && a !== '--json')];
  const token = `all-${createHash('sha256').update(previews.map(p => `${p.ref}:${p.binding}`).join('\n')).digest('hex').slice(0, 8)}`;
  const summary = [`Accept ${previews.length} item(s):`, ...previews.map(p => `  ${p.ref.padEnd(6)} ${p.summary}`)].join('\n');
  await requireOwnerConfirmation(LOCAL_CTX, { ref: `${previews.length} items`, token, summary, command });
  const accepted: OwnerActionResult[] = [];
  const failed: Array<{ ref: string; error: unknown }> = [];
  for (let i = 0; i < inputs.length; i++) {
    try { accepted.push(await backend.apply(inputs[i]!, previews[i]!.binding, previews[i]!.raises)); }
    catch (error) { failed.push({ ref: previews[i]!.ref, error: error instanceof OperationError ? error.toJSON() : String(error) }); }
  }
  if (json) await writeStdoutFinal(`${JSON.stringify({ accepted, failed }, null, 2)}\n`);
  else {
    for (const r of accepted) console.log(resultLine(r));
    for (const f of failed) console.log(`${f.ref}: not applied (${(f.error as { message?: string }).message ?? String(f.error)})`);
  }
  if (failed.length) setCliExitVerdict(1);
}

/** Renders a refusal through the shared CLI envelope with its contract exit code (3 for consent refusals). */
export async function reportTrustCliError(error: unknown, json: boolean): Promise<boolean> {
  if (error instanceof OperationError && !error.writeRequest) {
    setCliExitVerdict(writeCliError(error, 'trust', { json }));
    return true;
  }
  return reportPersistenceCliError(error, json);
}

/** Runs one owner subcommand against `backend`. Errors render through the shared CLI error envelope. */
export async function runTrustOwnerCommand(backend: TrustBackend, sub: string, args: string[]): Promise<void> {
  const json = jsonRequested(args);
  try {
    if (sub === 'review') {
      if (args.includes('--accept-all')) return await acceptAll(backend, args, json);
      const review = await backend.review(reviewFilter(args));
      if (json) await writeStdoutFinal(`${JSON.stringify(review, null, 2)}\n`); else console.log(renderTrustReview(review));
      return;
    }
    if (sub === 'explain') {
      const query = positionals(args).join(' ');
      if (!query) throw opError('invalid_params', 'trust explain needs a ref or a phrase.', 'Pass a ref such as f12, t3, h4, tp7 or p:default/notes/alice-example, or words from a page title or fact.');
      const items = await backend.explain(query, flag(args, '--source') ?? null);
      if (json) await writeStdoutFinal(`${JSON.stringify({ items }, null, 2)}\n`); else console.log(renderTrustExplanation(items));
      return;
    }
    const { preview, result } = await runOwnerAction(backend, actionInput(sub, args));
    if (json) await writeStdoutFinal(`${JSON.stringify({ preview: { ...preview, binding: undefined }, result }, null, 2)}\n`);
    else console.log(resultLine(result));
  } catch (error) {
    if (await reportTrustCliError(error, json)) return;
    throw error;
  }
}

/**
 * DX-2: while a resident serve holds a PGLite brain, run the owner
 * subcommand through its administration socket. False when no resident owner
 * holds the brain (the caller connects normally).
 */
export async function maybeDelegateTrust(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  const [sub, ...rest] = args;
  if (!isTrustOwnerSubcommand(sub) || args.includes('--help') || args.includes('-h')) return false;
  const { resolveBrainId } = await import('../core/brain-resolver.ts');
  const { getCliOptions } = await import('../core/cli-options.ts');
  const { loadMounts } = await import('../core/brain-registry.ts');
  const { maybeDelegateLocalAdministration, persistenceConfigForBrain } = await import('../core/persistence/local-client.ts');
  const { inspectLockHolder } = await import('../core/pglite-lock.ts');
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url || !inspectLockHolder(config.database_path).held) return false;
  const call = async (operation: 'trust_read' | 'trust_preview' | 'trust_apply', params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const delegated = await maybeDelegateLocalAdministration(operation, params, config);
    if (!delegated.handled) throw opError('owner_unavailable', 'The running serve stopped before the trust action; nothing was changed.', 'Run the same command again.');
    return delegated.result as Record<string, unknown>;
  };
  const backend: TrustBackend = {
    review: async filter => await call('trust_read', { view: 'review', filter: { source: filter.sourceId, kind: filter.kind, since: filter.since?.toISOString() } }) as unknown as TrustReview,
    explain: async (query, source) => (await call('trust_read', { view: 'explain', query, source })).items as TrustExplanation[],
    preview: async input => await call('trust_preview', { input }) as unknown as OwnerActionPreview,
    apply: async (input, binding, confirmed) => await call('trust_apply', { input, binding, ...(confirmed ? { confirmed: 'tty' } : {}) }) as unknown as OwnerActionResult,
  };
  await runTrustOwnerCommand(backend, sub!, rest);
  return true;
}

/**
 * DX-7 / CEO-9 for `gbrain decide proposals accept`: an S9 proposal whose new
 * fact is less trusted than the fact it supersedes raises trust over the old
 * row, so accepting it needs the owner's typed confirmation (one prompt for a
 * batch). Proposals that cross no tier return without a prompt and keep
 * today's path. Throws `confirmation_required` (non-TTY) or `insufficient_scope`.
 */
export async function confirmTierCrossingAccepts(engine: BrainEngine, ids: readonly number[], command: string[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const { compareTrust, storedTrustTier } = await import('../core/trust/tier.ts');
  const rows = await engine.executeRaw<{ id: number; new_tier: string; old_tier: string }>(
    `SELECT p.id, nf.trust_tier AS new_tier, xf.trust_tier AS old_tier FROM decide_proposals p
       JOIN facts nf ON nf.id = p.new_fact_id JOIN facts xf ON xf.id = p.old_fact_id
      WHERE p.id = ANY($1::bigint[]) AND p.status = 'pending' ORDER BY p.id`, [[...ids]]);
  const crossing = rows.filter(r => compareTrust(storedTrustTier(r.new_tier), storedTrustTier(r.old_tier)) < 0);
  if (crossing.length === 0) return [];
  const refs = crossing.map(r => `#${Number(r.id)}`);
  console.error(`[decide] accepting ${refs.join(', ')} lets a less trusted fact supersede a more trusted one; the same check as gbrain trust confirm applies (gbrain trust review lists every trust decision).`);
  const token = crossing.length === 1 ? `s9-${Number(crossing[0]!.id)}` : `s9-${createHash('sha256').update(refs.join(',')).digest('hex').slice(0, 8)}`;
  await requireOwnerConfirmation(LOCAL_CTX, {
    ref: refs.join(', '), token, command: command.filter(a => a !== '--yes' && a !== '--json'),
    summary: crossing.map(r => `Accept ${`#${Number(r.id)}`}: a "${trustLabel(storedTrustTier(r.new_tier))}" fact supersedes a "${trustLabel(storedTrustTier(r.old_tier))}" one`).join('\n'),
  });
  return crossing.map(r => Number(r.id));
}
