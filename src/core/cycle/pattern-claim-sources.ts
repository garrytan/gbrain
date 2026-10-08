/**
 * #6236: lossless storage of the reflections a quarantined pattern claim was
 * checked against.
 *
 * A pattern claim is grounded against every reflection the run read (up to
 * 100), so writing that list onto every claim grew pattern pages to hundreds
 * of kilobytes, and the next patterns child read them back until its replayed
 * transcript overflowed the model's window. The list is now stored once per
 * page in frontmatter `unverified_claim_sources` (`{ "@<digest>": [slug, …] }`,
 * one entry per distinct reflection set) and each claim's `sources` holds the
 * reference. No path is dropped: `resolveClaimSources` returns the original
 * list. A claim with one source keeps it inline.
 *
 * `dedupePatternClaimSources` rewrites pages still carrying inline lists
 * (frontmatter only, zero LLM, body untouched) before the patterns child runs.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { publishOrHold } from '../persistence/accepted-pending.ts';
import { throwIfAborted } from '../abort-check.ts';

export const CLAIM_SOURCES_KEY = 'unverified_claim_sources';
const CLAIMS_KEY = 'unverified_claims';
/** Claim records a page keeps (oldest dropped first), as before. */
export const MAX_PATTERN_CLAIM_RECORDS = 100;

type SourceMap = Record<string, string[]>;
type ClaimRecord = Record<string, unknown> & { sources?: unknown };

function sourceSetRef(paths: string[]): string {
  return `@${createHash('sha256').update([...paths].sort().join('\n')).digest('hex').slice(0, 12)}`;
}

function readMap(frontmatter: Record<string, unknown>): SourceMap {
  const raw = frontmatter[CLAIM_SOURCES_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(path => typeof path === 'string')));
}

/** The reflection paths a claim was checked against, read through the page's source map. */
export function resolveClaimSources(frontmatter: Record<string, unknown>, claim: { sources?: unknown }): string[] {
  if (!Array.isArray(claim.sources)) return [];
  const map = readMap(frontmatter);
  return claim.sources.flatMap(source => typeof source === 'string' && map[source] ? map[source] : [source as string]);
}

/**
 * The page's claim records with every multi-path `sources` list moved into
 * the shared map, new records appended (sharing one reference for this run's
 * reflection set), the oldest dropped past MAX_PATTERN_CLAIM_RECORDS, and map
 * entries no kept record references removed. `changed` is false when nothing
 * would be rewritten.
 */
export function withClaimSources(frontmatter: Record<string, unknown>, added: Array<Record<string, unknown>> = [], addedSources: string[] = []):
  { frontmatter: Record<string, unknown>; changed: boolean } {
  const map = readMap(frontmatter);
  let changed = added.length > 0;
  const refFor = (paths: string[]): string[] => {
    if (paths.length <= 1) return paths;
    const ref = sourceSetRef(paths);
    map[ref] = [...paths];
    return [ref];
  };
  const prior = Array.isArray(frontmatter[CLAIMS_KEY]) ? frontmatter[CLAIMS_KEY] as unknown[] : [];
  const records: unknown[] = prior.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
    const sources = (record as ClaimRecord).sources;
    if (!Array.isArray(sources) || sources.length <= 1 || !sources.every(source => typeof source === 'string')) return record;
    changed = true;
    return { ...record, sources: refFor(sources as string[]) };
  });
  const addedRef = refFor(addedSources);
  for (const record of added) records.push({ ...record, sources: addedRef });
  const kept = records.slice(-MAX_PATTERN_CLAIM_RECORDS);
  if (kept.length !== records.length) changed = true;
  const referenced = new Set(kept.flatMap(record => record && typeof record === 'object' && Array.isArray((record as ClaimRecord).sources)
    ? (record as ClaimRecord).sources as unknown[] : []));
  const prunedMap = Object.fromEntries(Object.entries(map).filter(([ref]) => referenced.has(ref)));
  if (Object.keys(prunedMap).length !== Object.keys(readMap(frontmatter)).length) changed = true;
  const next: Record<string, unknown> = { ...frontmatter };
  if (kept.length) next[CLAIMS_KEY] = kept; else delete next[CLAIMS_KEY];
  if (Object.keys(prunedMap).length) next[CLAIM_SOURCES_KEY] = prunedMap; else delete next[CLAIM_SOURCES_KEY];
  return { frontmatter: next, changed };
}

/**
 * Rewrite every pattern page whose claim records still list their sources
 * inline, before the patterns child reads them. Returns the slugs rewritten
 * and the slugs whose managed publication is held (pending or contended);
 * the phase submits no paid child while any is held. A page that fails for
 * another reason is logged and left for the next run.
 */
export async function dedupePatternClaimSources(engine: BrainEngine, maintenance: MaintenanceAuthority | null, outputSlugPrefix: string,
  sourceId: string, signal?: AbortSignal): Promise<{ rewritten: string[]; held: string[] }> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
      WHERE source_id = $1 AND slug LIKE $2 AND deleted_at IS NULL AND jsonb_typeof(frontmatter->'${CLAIMS_KEY}') = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(frontmatter->'${CLAIMS_KEY}') AS c
                     WHERE jsonb_typeof(c.value->'sources') = 'array' AND jsonb_array_length(c.value->'sources') > 1)
      ORDER BY slug`,
    [sourceId, `${outputSlugPrefix}/%`]);
  const rewritten: string[] = [];
  const held: string[] = [];
  for (const { slug } of rows) {
    throwIfAborted(signal, '[dream] patterns claim de-duplication');
    try {
      const snapshot = await engine.readPageSnapshot(slug, { sourceId });
      if (!snapshot) continue;
      const { frontmatter, changed } = withClaimSources(snapshot.page.frontmatter as Record<string, unknown>);
      if (!changed) continue;
      const { serializePageToMarkdown } = await import('../markdown.ts');
      const content = serializePageToMarkdown({ ...snapshot.page, frontmatter }, snapshot.tags);
      if (maintenance) {
        const { publishMaintenancePage } = await import('../persistence/prepared-maintenance.ts');
        if (await publishOrHold(() => publishMaintenancePage(engine, maintenance, slug, content, { expectedRevision: snapshot.revision }))) {
          held.push(slug);
          continue;
        }
      } else {
        const [{ importFromContent }, { isAvailable }] = await Promise.all([import('../import-file.ts'), import('../ai/gateway.ts')]);
        await importFromContent(engine, slug, content, { noEmbed: !isAvailable('embedding'), sourceId });
      }
      rewritten.push(slug);
    } catch (error) {
      if (signal?.aborted) throw error;
      process.stderr.write(`[dream] patterns: could not de-duplicate the claim sources of ${slug}; the next run retries `
        + `(${error instanceof Error ? error.message : String(error)})\n`);
    }
  }
  if (rewritten.length) process.stderr.write(`[dream] patterns: de-duplicated the claim sources of ${rewritten.length} pattern page(s)\n`);
  return { rewritten, held };
}
