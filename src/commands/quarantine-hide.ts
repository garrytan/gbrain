import type { BrainEngine } from '../core/engine.ts';
import { buildQuarantineMarker, isQuarantined } from '../core/quarantine.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { importFromContent } from '../core/import-file.ts';
import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { submitPageMutation } from '../core/persistence/page-mutations.ts';
import { loadConfig } from '../core/config.ts';
import { opError, type OperationContext } from '../core/ops/contract.ts';
import { resolveCliWriteWaitMs } from '../core/persistence/write-wait.ts';
import type { PageType } from '../core/types.ts';

/** Owner CLI only. Never an MCP operation or an untrusted marker setter. */
export async function runHide(engine: BrainEngine, args: string[]): Promise<void> {
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const slug = args[0];
  const sourceId = value('--source-id');
  const revision = value('--expected-revision');
  const requestId = value('--request-id');
  if (!slug || slug.startsWith('--') || !sourceId || !revision || !requestId || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(requestId)) {
    throw opError('invalid_params', 'hide requires slug, --source-id, --expected-revision and --request-id.', 'Read the exact page revision first. Retain the request id for reconciliation.');
  }
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot || snapshot.page.deleted_at) throw opError('not_found', 'The selected live page was not found.', 'Read the exact source and slug.');
  // A committed replay is idempotent without rewriting the preserved body.
  if (isQuarantined(snapshot.page.frontmatter as Record<string, unknown>)) {
    console.log(JSON.stringify({ slug, source_id: sourceId, hidden: true, unchanged: true, revision: snapshot.revision })); return;
  }
  if (snapshot.revision !== revision) throw opError('revision_conflict', 'The selected page changed.', 'Read it again and review the current body before hiding it.');
  const page = snapshot.page;
  const fm = { ...(page.frontmatter as Record<string, unknown> ?? {}), quarantine: buildQuarantineMarker('owner_excluded', 'Explicit owner relevance exclusion') };
  delete (fm as Record<string, unknown>).quarantine_override;
  const markdown = serializeMarkdown(fm, page.compiled_truth ?? '', page.timeline ?? '', { type: page.type as PageType, title: page.title ?? '', tags: snapshot.tags });
  let receipt: Record<string, unknown> | undefined;
  if (await managedPersistenceEnabled(engine)) {
    const config = loadConfig() ?? { engine: engine.kind };
    const ctx = { engine, config, remote: false, dryRun: false, sourceId, writeWaitMs: resolveCliWriteWaitMs({ config }),
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    receipt = await submitPageMutation(ctx, { operation: 'put_page', managedFileImport: true, params: { slug, source_id: sourceId,
      content: markdown, kind: 'managed_quarantine_hide', expected_revision: revision, request_id: requestId } });
  } else {
    await importFromContent(engine, slug, markdown, { sourceId, noEmbed: true, forceRechunk: true, preserveGateMarkers: true });
  }
  const after = await engine.readPageSnapshot(slug, { sourceId });
  console.log(JSON.stringify({ slug, source_id: sourceId, hidden: !!after && isQuarantined(after.page.frontmatter as Record<string, unknown>),
    revision: after?.revision, ...(receipt ? { write_request: receipt.write_request } : {}) }));
}
