/**
 * #8522: a `remember` onto a page whose segment rows no longer tile its body ends with a receipt coded
 * `page_body_rows_unreadable`. Its caller gets that code, the page in the message and the operator's next step,
 * not the generic `storage_error`. Managed PGLite brain, a real segmented page, a real gap in its manifest.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { runMemoryWrite, writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { operations } from '../src/core/operations.ts';
import { cliRenderContext, toAgentError } from '../src/core/agent-output.ts';
import { codeEntry } from '../src/core/error-catalogue.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { segmentedTilingRepair } from '../src/core/repair/segmented-tiling.ts';
import { segmentedTilingCheck } from '../src/commands/doctor/checks/segmented-tiling.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';
import { durableGitRepo } from './helpers/git-publication.ts';

const slug = 'people/owner-example';
const setup = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n');
  durableGitRepo(root, ['.gitignore']);
  await engine.setConfig('pages.segmented_storage', 'on');
};
const section = (i: number) => `## Section ${i}\n\n${`Public notes on planning for week ${i}. `.repeat(40)}\n\n`;
const body = Array.from({ length: 1000 }, (_, i) => section(i)).join('');

async function segmentedPageWithGap(ctx: OperationContext, engine: BrainEngine) {
  await submitPageMutation(ctx, { operation: 'put_page', waitMs: 120_000, params: { slug, request_id: randomUUID(),
    content: `---\ntype: person\ntitle: Owner\n---\n\n${body}` } });
  const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  await withManagedFixtureWrite(engine, ['default'], tx => tx.executeRaw(`DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_to IS NULL
    AND seq=(SELECT max(seq) / 2 FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_to IS NULL)`, [page!.id]));
}
const refused = (ctx: OperationContext) => runMemoryWrite(() => submitRememberMutation(ctx,
  { fact: 'Owner prefers async updates', entity: slug, provenance: 'test', visibility: 'world' }, 120_000)).then(
  value => { throw new Error(`the write was expected to be refused: ${JSON.stringify(value)}`); },
  error => error as Record<string, any>);

describe('#8522 remember onto a page whose segment rows are unreadable', () => {
  test('the caller gets the receipt code, the page and the next step, and learns retrying cannot help', () => managedBrain(async ({ engine, ctx }) => {
    await segmentedPageWithGap(ctx, engine);
    const error = await refused(ctx);
    const [receipt] = await engine.executeRaw<{ state: string; error_code: string; request_id: string }>(
      "SELECT state,error_code,request_id FROM persistence_requests WHERE operation='remember' ORDER BY sequence DESC LIMIT 1");
    expect(receipt).toMatchObject({ state: 'failed', error_code: 'page_body_rows_unreadable' });
    // The frozen v1 code stays; the additive fields carry the cause.
    expect(error.code).toBe('unavailable');
    expect(error.writeError).toBe('page_body_rows_unreadable');
    expect(error.detail).toBe('page_body_rows_unreadable');
    expect(error.message).toContain(slug);
    expect(error.message).not.toContain('storage_error');
    expect(error.suggestion).toContain('segmented_tiling');
    const envelope = toAgentError(error, { transport: 'cli', command: 'remember', render: cliRenderContext() });
    expect(envelope).toMatchObject({ code: 'page_body_rows_unreadable', class: 'server', retryable: false });
    expect(envelope.docs).toEndWith('docs/guides/windowed-reads.md#page_body_rows_unreadable');

    const read = await operations.find(op => op.name === 'get_write_request')!.handler(ctx, { request_id: receipt!.request_id }) as Record<string, any>;
    expect(read).toMatchObject({ write_error: 'page_body_rows_unreadable', write_error_reason: 'page_body_rows_unreadable' });
    expect(read.write_error_message).toContain(slug);
    expect(read.suggestion).toContain('segmented_tiling');

    // The next step the message gives finds this page: doctor lists it and the repair previews it. The file was never committed, so the preview holds it.
    const check = await segmentedTilingCheck(engine);
    expect(check).toMatchObject({ status: 'fail', details: { pages: [expect.objectContaining({ source_id: 'default', slug })] } });
    expect(check.fix?.argv).toEqual(['gbrain', 'repair', 'segmented-tiling', '--source', 'default']);
    const preview = await runRepair(ctx, segmentedTilingRepair, await resolveRepairScope(engine, 'default'), { apply: false, explicit: true, sourceFlag: 'default' });
    expect(preview.listing).toEqual([expect.objectContaining({ item: expect.stringContaining(`default:${slug}`), class: 'held' })]);
  }, { setup }), 240_000);

  test('a receipt that lost its message still names the code and the next step', () => {
    const diagnostic = writeFailureDiagnostic('page_body_rows_unreadable', null);
    expect(diagnostic.reason).toBe('page_body_rows_unreadable');
    expect(diagnostic.message).toBe(codeEntry('page_body_rows_unreadable')!.summary);
    expect(diagnostic.suggestion).toBe(codeEntry('page_body_rows_unreadable')!.suggestion);
  });
});
