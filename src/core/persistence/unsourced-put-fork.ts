/**
 * pages-02: an unsourced local put must not fork a page that lives in another source.
 *
 * A put with no source named (the CLI resolved the source from a non-explicit
 * tier: local_path, sole_non_default, brain_default or seed_default) goes to
 * whatever source that tier picks today. Tier sole_non_default stops picking
 * the only git source as soon as 'default' holds one page, so a later
 * `gbrain put people/erin-example --force` wrote a second copy into 'default'
 * that an unscoped get then preferred, while the user's file-backed page in
 * the git source kept the old text. This admission refuses that put when the
 * slug is live in exactly one other source and has no row in the target, and
 * names the source and the retry with --source-id. A put that names its source
 * (--source-id, --source, GBRAIN_SOURCE or a .gbrain-source pin) is never
 * refused here, and remote callers never reach it (it would be a cross-source
 * existence oracle outside their grant). Reads go through typed engine members
 * only (listAllSources, readPageSnapshot).
 */
import type { BrainEngine } from '../engine.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { validateSlug } from '../utils.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { formatSoleNonDefaultFlip } from '../source-resolver.ts';

/** True when `p` is a put from the trusted local CLI whose source was not named by the caller. */
export function isUnsourcedLocalPut(ctx: Pick<OperationContext, 'remote' | 'localSourceImplicit'>, p: Record<string, unknown>): boolean {
  return ctx.remote === false && ctx.localSourceImplicit === true && p.source_id === undefined;
}

/** The one other source holding a live page at `slug` while `target` holds no row for it; null otherwise. */
export async function forkedFromSource(engine: BrainEngine, target: string, slug: string): Promise<string | null> {
  if (await engine.readPageSnapshot(slug, { sourceId: target, includeDeleted: true })) return null;
  const holders: string[] = [];
  for (const source of await engine.listAllSources()) {
    if (source.id === target) continue;
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

/** Refuses an unsourced local put that would fork a page living in exactly one other source. */
export async function assertUnsourcedPutKeepsSource(ctx: OperationContext, target: string, p: Record<string, unknown>): Promise<void> {
  if (!isUnsourcedLocalPut(ctx, p) || typeof p.slug !== 'string') return;
  let slug: string;
  try { slug = validateSlug(p.slug); } catch { return; } // the write path refuses a bad slug with its own message
  const holder = await forkedFromSource(ctx.engine, target, slug);
  if (holder !== null) throw unsourcedForkRefusal(slug, holder, target, p.force === true);
}

/**
 * Prints the documented routing-flip notice for an unsourced local put that
 * goes to 'default' while one other git-backed source exists. The resolver
 * prints it already unless that source is federated (GST-2732 keeps reads
 * quiet there, since default search spans it), so only that case prints here:
 * a write still lands in 'default', not in the source.
 */
export async function noteSuppressedSourceFlip(ctx: OperationContext, target: string, p: Record<string, unknown>): Promise<void> {
  if (!isUnsourcedLocalPut(ctx, p) || target !== 'default') return;
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

/** put_page's admission for a put that named no source: refuse a fork, then print the routing-flip notice. */
export async function guardUnsourcedPut(ctx: OperationContext, target: string, p: Record<string, unknown>): Promise<void> {
  await assertUnsourcedPutKeepsSource(ctx, target, p);
  await noteSuppressedSourceFlip(ctx, target, p);
}
