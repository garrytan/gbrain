/**
 * pages-02: an unsourced local put must not fork a page that lives in another source.
 *
 * A put where nothing named or implied a source (the CLI resolved the source
 * from the sole_non_default, brain_default or seed_default tier) goes to
 * whatever source that tier picks today. Tier sole_non_default stops picking
 * the only git source as soon as 'default' holds one page, so a later
 * `gbrain put people/erin-example --force` wrote a second copy into 'default'
 * that an unscoped get then preferred, while the user's file-backed page in
 * the git source kept the old text. This admission refuses that put when the
 * slug is live in exactly one other source and has no row in the target, and
 * names the source and the retry with --source-id. A put that names its source
 * (--source-id, --source, GBRAIN_SOURCE or a .gbrain-source pin) is never
 * refused here, nor is one run from inside a source's checkout (the local_path
 * tier counts as naming that source; not for an upload commit, which writes to the source fixed at its begin), and remote callers never reach it (it would be a cross-source
 * existence oracle outside their grant). A local writer registered for fewer
 * sources only hears about holders in sources its grant covers, and a real put
 * is checked after the write authority and after a stored request_id replay, so
 * a refused or replayed request keeps the answer it had. Reads go through typed
 * engine members only (listAllSources, readPageSnapshot, the local writer row). A batch put (put_pages)
 * and an upload that begins a new page (begin_page_upload) are checked per page the same way.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError, type OperationContext } from '../ops/contract.ts';
import type { LocalGrant } from '../engine-sql/persistence-state.ts';
import { readFix } from '../ops/op-fix.ts';
import { validateSlug } from '../utils.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { formatSoleNonDefaultFlip, resolveRegisteredLocalPathSource } from '../source-resolver.ts';
import { hasCapability } from '../engine-capabilities.ts';
import { currentVerifiedLocalWriter, readLocalWriter, verifyLocalWriter } from './identity.ts';

/**
 * True when `p` is a put from the trusted local CLI where nothing named or implied a source (no flag, env, dotfile or
 * cwd checkout). `uploadCommit`: a commit_page_upload writes to the source fixed at its begin, so the commit's checkout
 * names nothing and only a flag, env or dotfile on the commit counts.
 */
export function isUnsourcedLocalPut(ctx: Pick<OperationContext, 'remote' | 'localSourceImplicit' | 'localSourceFromCheckout'>, p: Record<string, unknown>,
  uploadCommit = false): boolean {
  // A put run from inside a source's checkout (the local_path tier) names that source, as a flag, env or dotfile does.
  return ctx.remote === false && ctx.localSourceImplicit === true && (uploadCommit || ctx.localSourceFromCheckout !== true) && p.source_id === undefined;
}

/** Operations whose put a run from inside a source's checkout names (commit_page_upload is not one: see isUnsourcedLocalPut). */
const FORK_CHECKED_OPERATIONS = new Set(['put_page', 'put_pages', 'begin_page_upload']);

/**
 * The live owner resolves the cwd tier for a CLI caller; true when `sourceId` is the source whose checkout contains
 * `cwd`. Read only for the operations the fork check covers.
 */
export async function sourceNamedByCheckout(engine: BrainEngine, operation: string, cwd: string, sourceId: string): Promise<boolean> {
  return FORK_CHECKED_OPERATIONS.has(operation) && await resolveRegisteredLocalPathSource(engine, cwd) === sourceId;
}

/** The one other source in `readable` holding a live page at `slug` while `target` holds no row for it; null otherwise. */
export async function forkedFromSource(engine: BrainEngine, target: string, slug: string,
  opts: { targetHasRow?: boolean; readable?: (sourceId: string) => boolean } = {}): Promise<string | null> {
  const hasRow = opts.targetHasRow ?? !!(await engine.readPageSnapshot(slug, { sourceId: target, includeDeleted: true }));
  if (hasRow) return null;
  const holders: string[] = [];
  for (const source of await engine.listAllSources()) {
    if (source.id === target || opts.readable?.(source.id) === false) continue;
    if (await engine.readPageSnapshot(slug, { sourceId: source.id })) holders.push(source.id);
  }
  return holders.length === 1 ? holders[0]! : null;
}

/** The refusal for an unsourced put that would fork `slug` out of `holder` into `target`. */
export function unsourcedForkRefusal(slug: string, holder: string, target: string, force: boolean) {
  const retry = ['gbrain', 'put', slug, '--source-id', holder, ...(force ? ['--force'] : [])];
  return opError('invalid_params',
    `Page ${slug} lives in source ${holder}. This put names no source, so it would write a second copy to source ${target}. `
      + `To update the page in ${holder}, run the same put with its source: ${retry.join(' ')}`,
    `To create a separate page in ${target} instead, pass --source-id ${target}.`, {
      detail: 'slug_in_other_source',
      why: `A put without --source-id writes to the source gbrain picks for this brain (source ${target} now), not to the source that already holds the page. `
        + 'A copy in another source would shadow the original on an unscoped get, while the original (and its file) kept the old text.',
      fix: {
        ...readFix(`Reads the existing page in source ${holder} before writing it there.`,
          { argv: ['gbrain', 'get', '--source', holder, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: holder } } }),
        verify: { argv: ['gbrain', 'get', '--source', holder, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: holder } } },
      },
    });
}

/** The CLI writer's grant; null when this installation has no registration yet (a first-use dry run: nothing to restrict it). */
async function localGrant(engine: BrainEngine): Promise<LocalGrant | null> {
  try {
    return (currentVerifiedLocalWriter() ?? await verifyLocalWriter(engine, await readLocalWriter(engine, 'cli'))).grant;
  } catch (error) {
    if (error instanceof OperationError && error.code === 'writer_registration_required') return null;
    throw error;
  }
}

/**
 * Refuses an unsourced local put that would fork a page living in exactly one other source.
 * `admitted` comes from the durable write path, after the write authority and the replay check, with whether the
 * target already has a row; without it (a dry run, which has no admission) a slug-restricted writer is left alone.
 */
export async function assertUnsourcedPutKeepsSource(ctx: OperationContext, target: string, p: Record<string, unknown>,
  admitted?: { targetHasRow: boolean; uploadCommit?: true }): Promise<void> {
  if (!isUnsourcedLocalPut(ctx, p, admitted?.uploadCommit === true) || typeof p.slug !== 'string') return;
  let slug: string;
  try { slug = validateSlug(p.slug); } catch { return; } // the write path refuses a bad slug with its own message
  // An engine without persistence_journal (Rust) has no local-writer grants and no stored requests to consult.
  const grant = hasCapability(ctx.engine, 'persistence_journal') ? await localGrant(ctx.engine) : null;
  const covers = (sourceId: string) => grant === null || grant.sourceIds.includes('*') || grant.sourceIds.includes(sourceId);
  if (!covers(target) || (admitted === undefined && grant?.slugPrefixes?.length)) return; // the write authority answers these
  const holder = await forkedFromSource(ctx.engine, target, slug, { targetHasRow: admitted?.targetHasRow, readable: covers });
  if (holder !== null) throw unsourcedForkRefusal(slug, holder, target, p.force === true);
}

/**
 * The check a put makes before admission: a dry run and an engine with no persistence journal have no admission to
 * hold it, so they refuse here (and a dry run previews the routing-flip notice, which a real put prints once it landed).
 */
export async function guardUnsourcedPutEarly(ctx: OperationContext, target: string, p: Record<string, unknown>): Promise<void> {
  if (!ctx.dryRun && hasCapability(ctx.engine, 'persistence_journal')) return;
  await assertUnsourcedPutKeepsSource(ctx, target, p);
  if (ctx.dryRun) await noteSuppressedSourceFlip(ctx, target, p);
}

/**
 * Prints the documented routing-flip notice for an unsourced local put that
 * goes to 'default' while one other git-backed source exists. The resolver
 * prints it already unless that source is federated (GST-2732 keeps reads
 * quiet there, since default search spans it), so only that case prints here:
 * a write still lands in 'default', not in the source.
 */
export async function noteSuppressedSourceFlip(ctx: OperationContext, target: string, p: Record<string, unknown>): Promise<void> {
  if (!isUnsourcedLocalPut(ctx, p) || target !== 'default' || ctx.cliOpts?.quiet === true) return; // --quiet silences the notice
  try {
    if (await ctx.engine.getConfig('sources.default')) return; // config picked 'default', not the #3070 flip
    const others = (await ctx.engine.listAllSources({ localPathOnly: true }))
      .filter(s => s.id !== 'default' && parseSourceConfig(s.config).role !== 'storage_manifest');
    if (others.length !== 1 || (parseSourceConfig(others[0]!.config) as { federated?: unknown }).federated !== true) return;
    const flip = formatSoleNonDefaultFlip(others[0]!.id);
    if (flip !== null) console.error(flip);
  } catch {
    // Advisory only: a failed read never blocks the put.
  }
}
