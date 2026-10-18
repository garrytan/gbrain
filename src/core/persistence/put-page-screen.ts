/**
 * #6741 B: the request-free no-op screen for a trusted local `put_page`
 * (the managed transcript import). It builds the admission the write would
 * take, without admitting it, runs the page publication preparer on that
 * unadmitted request and asks the #5470 no-op kernel (noop-kernel.ts), as the
 * managed file import does (import-mutations.ts unchangedManagedImport). The
 * write skips admission, and so takes no permanent request id, only when the
 * preparer finds a genuine no-op and the kernel finds no work the publication
 * would still do: no safe-chunk re-seal or text projection behind the
 * revision, the page still at the screened revision, its recorded source path
 * the one the publication would record, and its canonical file present. The
 * file may differ in bytes from the serialized page only as the preparer
 * already accepted it (it parses to this page; key order from the stored
 * frontmatter differs), which a no-op publication never rewrites, so that one
 * kernel waiver applies; a missing file always admits. The preparer's own
 * `validate` must hold. Anything else is submitted as before:
 *   - a page with a request still pending or recovering (the stored page is
 *     not yet what that request will publish);
 *   - a segmented (large) page: its publication decides the no-op;
 *   - a missing, deleted or changed page, or any failure of the screen.
 */
import type { OperationContext } from '../ops/contract.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { loadConfig } from '../config.ts';
import { scannerSlugRootMode, scannerSourcePath } from '../write-through.ts';
import { inspectUnchanged, screeningRequest } from './noop-kernel.ts';
import { preparePageAdmission } from './page-mutations.ts';
import { preparePageMutation } from './page-prepare.ts';

export async function unchangedPutPage(ctx: OperationContext, params: Record<string, unknown> & { slug: string; source_id: string },
  snapshot: PageSnapshot | null): Promise<boolean> {
  if (!snapshot || snapshot.page.deleted_at || isSegmentedPage(snapshot.page)) return false;
  try {
    const [pending] = await ctx.engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent IS NOT NULL AND NOT compacted
      AND (state NOT IN ('committed','conflict','failed','cancelled') OR recovery IS NOT NULL) LIMIT 1`, [params.source_id, params.slug.toLowerCase()]);
    if (pending) return false;
    const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params });
    if (prepared.prior) return false;
    const { admission } = prepared;
    const row = screeningRequest({ source_id: admission.sourceId, source_incarnation: admission.sourceIncarnation, slug: admission.slug,
      page_id: admission.pageId ?? null, worktree_id: admission.worktreeId ?? null, authority: admission.authority, intent: admission.intent, operation: 'put_page' });
    const mutation = await preparePageMutation(ctx.engine, row, ctx.config ?? loadConfig() ?? { engine: ctx.engine.kind });
    if (mutation.noop !== true) return false;
    const file = row.worktree_id ? mutation.file : undefined;
    const sourcePath = file ? scannerSourcePath(file.root, file.path, await scannerSlugRootMode(ctx.engine, admission.sourceId, file.root)) : null;
    const verdict = await inspectUnchanged(ctx.engine, { prepared: mutation, snapshot, sourcePath, databaseOnly: !file, waive: ['canonical_file_differs'] });
    if (verdict.admitReason) return false;
    await mutation.validate?.(ctx.engine);
    return true;
  } catch {
    return false;
  }
}
