/**
 * #8522: a memory-verb write whose receipt failed `page_body_rows_unreadable` (a page stored in segments whose rows
 * readable on the writer's connection do not cover its body) reached its caller as `storage_error` with the generic
 * "resolve the reported write failure" hint. The code was missing from WRITE_ERROR_CODES, so the receipt's code was
 * replaced before the diagnostic saw it. The caller now gets the code, the receipt's message (naming the page), the
 * catalogue's next step, and an envelope that says retrying cannot help. Managed PGLite brain, a real segmented page
 * and a real gap in its manifest.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { OperationError } from '../src/core/ops/contract.ts';
import { isWriteErrorCode } from '../src/core/persistence/types.ts';
import { runMemoryWrite, writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { codeEntry } from '../src/core/error-catalogue.ts';
import { cliRenderContext, toAgentError } from '../src/core/agent-output.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const SLUG = 'people/alice-example';
const MESSAGE = `Page ${SLUG} (source default): the segment rows readable here do not cover its 1500000-byte body, so nothing was read.`;
/** Over the inline bound, so the page is stored in segments. */
const PAGE = `---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\n${
  Array.from({ length: 16_000 }, (_, i) => `- ${String(i).padStart(9, '0')} acme-example journal line with enough text to fill a segment\n`).join('')}`;

test('the diagnostic of a page_body_rows_unreadable receipt keeps its code, message and catalogue next step', () => {
  expect(isWriteErrorCode('page_body_rows_unreadable')).toBe(true);
  expect(writeFailureDiagnostic('page_body_rows_unreadable', MESSAGE)).toEqual({ reason: 'page_body_rows_unreadable', message: MESSAGE,
    suggestion: codeEntry('page_body_rows_unreadable')!.suggestion });
});

test('a remember refused by unreadable segment rows tells its caller which page and that retrying cannot help', async () => {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('pages.segmented_storage', 'on');
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, request_id: randomUUID(), content: PAGE } });
    await settleManagedGitEffects(engine);
    const [page] = await engine.executeRaw<{ id: number; body_storage: string; body_generation: number }>(
      'SELECT id, body_storage, body_generation FROM pages WHERE source_id=$1 AND slug=$2', ['default', SLUG]);
    expect(page!.body_storage).toBe('segmented');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(`DELETE FROM page_body_manifest
      WHERE page_id=$1 AND seq=1 AND staging_id IS NULL AND gen_from <= $2 AND (gen_to IS NULL OR gen_to > $2)`, [page!.id, page!.body_generation]), TEST_WRITE_ATTRIBUTION));

    const error = await runMemoryWrite(() => submitRememberMutation(ctx,
      { fact: 'Alice Example prefers async updates', entity: SLUG, provenance: 'test', visibility: 'world' })).then(() => null, e => e);
    expect(error).toBeInstanceOf(OperationError);
    expect({ code: error.code, writeError: error.writeError, detail: error.detail, state: error.writeRequest?.state }).toEqual({ code: 'unavailable',
      writeError: 'page_body_rows_unreadable', detail: 'page_body_rows_unreadable', state: 'failed' });
    expect(error.message).toContain(SLUG);
    expect(error.suggestion).toContain('gbrain repair segmented-tiling');
    expect(toAgentError(error, { transport: 'cli', op: 'remember', render: cliRenderContext() })).toMatchObject({ code: 'page_body_rows_unreadable', class: 'server', retryable: false });
  });
}, 120_000);
