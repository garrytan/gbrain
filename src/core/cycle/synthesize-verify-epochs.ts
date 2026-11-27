/**
 * The scope side of dream-page verification, peeled from synthesize-verify.ts
 * (module-size ratchet): the run's write epochs and the pre-run revision a
 * pre-existing page is diffed against. Pure database reads; the claim checks
 * stay in synthesize-verify.ts, which re-exports these for its callers.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import type { VerifiablePage } from './synthesize-verify.ts';

/** Database clock reading taken before a run's writes; pages created at or
 * after it are the run's own, earlier pages are verified by diff. */
export async function readVerifyEpoch(engine: BrainEngine): Promise<Date> {
  return new Date(await engine.readDreamVerifyEpoch() as string);
}

/**
 * Per-transcript write epochs: the earliest creation time of the child jobs
 * that synthesized each transcript. A resumed or coalesced child created in
 * an earlier run keeps its original epoch, so the pages it wrote then still
 * count as its own. Transcripts without a job row fall back to `fallback`.
 */
export async function loadChildWriteEpochs(
  engine: BrainEngine,
  childIds: number[],
  jobRawSource: Map<number, string>,
  fallback: Date,
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  for (const path of jobRawSource.values()) out.set(path, fallback);
  if (!childIds.length) return out;
  const rows = await engine.listDreamJobCreatedAt(childIds);
  for (const row of rows) {
    const path = jobRawSource.get(Number(row.id));
    const at = new Date(row.created_at as string);
    if (!path || Number.isNaN(at.getTime())) continue;
    if (at < (out.get(path) ?? fallback)) out.set(path, at);
  }
  return out;
}

/**
 * The revision of a page as it stood before `since`: the first version
 * snapshot taken at or after `since` (writes snapshot the prior state before
 * overwriting). Null when nothing overwrote the page since then.
 */
export async function loadPreRunRevision(engine: BrainEngine, slug: string, sourceId: string, since: Date): Promise<VerifiablePage | null> {
  const row = await engine.readDreamPreRunRevision(slug, sourceId, since.toISOString());
  if (!row) return null;
  const fm = typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter;
  return { compiled_truth: row.compiled_truth ?? '', timeline: row.timeline ?? '', frontmatter: (fm ?? {}) as Record<string, unknown> };
}

/**
 * C-8: dream output is a page a child created (or one already stamped). A page
 * that existed before the child's first write keeps its own identity. Refs
 * without a first-write time (legacy callers) count as dream output.
 */
export function isDreamOwnedPage(page: Pick<Page, 'created_at' | 'frontmatter'>, firstWriteAt?: Date): boolean {
  if (!firstWriteAt || page.frontmatter?.dream_generated === true) return true;
  return new Date(page.created_at).getTime() >= firstWriteAt.getTime();
}

/**
 * The verification scope of one written page: null prior for a page created
 * at or after `since`, the pre-run revision for an older page, or 'unchanged'
 * when an older page has no revision since then.
 */
export async function resolveVerifyPrior(engine: BrainEngine, page: Pick<Page, 'slug' | 'created_at'>, sourceId: string, since: Date): Promise<VerifiablePage | null | 'unchanged'> {
  if (new Date(page.created_at).getTime() >= since.getTime()) return null;
  return (await loadPreRunRevision(engine, page.slug, sourceId, since)) ?? 'unchanged';
}
