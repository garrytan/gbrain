import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import type { ParsedPage } from '../import-file.ts';
import { OperationError } from '../ops/contract.ts';
import { stableJson } from '../persistence/digest.ts';
import { assertPageRevision, type PageSnapshot } from './types.ts';

/** Imported bytes are prepared outside transactions; publication still needs CAS. */
export async function assertImportBase(tx: BrainEngine, slug: string, sourceId: string, existing: Page | null): Promise<void> {
  await tx.lockPageKeys([{ sourceId, slug }]);
  const current = await tx.getPage(slug, { sourceId, includeDeleted: true });
  if ((current?.id ?? null) !== (existing?.id ?? null)) {
    throw new OperationError('page_identity_changed', 'The imported page was deleted or recreated during preparation.');
  }
  assertPageRevision(current ? { revision: current.knowledge_revision! } : null, existing ? { expectedRevision: existing.knowledge_revision } : {});
}
/** Content hashes omit volatile metadata; a prepared no-op must compare all canonical fields. */
export function sameCanonicalImport(existing: PageSnapshot | null, parsed: ParsedPage): boolean {
  if (!existing) return false;
  const fields = (p: Page | ParsedPage) => ({ type: p.type, title: p.title, compiled_truth: p.compiled_truth,
    timeline: p.timeline ?? '', frontmatter: p.frontmatter });
  const tags = [...new Set([...existing.tags, ...parsed.tags])].sort();
  return stableJson(fields(existing.page)) === stableJson(fields(parsed)) && stableJson([...existing.tags].sort()) === stableJson(tags);
}
