/**
 * BrainEngine parity — an unsourced local put does not fork a page that lives in another source (pages-02).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1), put_page from the trusted local CLI that named no source, for a slug that lives
 *    only in source `vault` while the put resolved to `default`, is refused with the same text (holding source
 *    and the exact retry with --source-id), with and without --force, and leaves no row in `default`. The same
 *    holds per page for put_pages and for begin_page_upload (mode create); an engine without the persistence
 *    journal (Rust) stops those two on the typed refusal.
 *  - Regression: an engine whose listAllSources or readPageSnapshot answers differently lets the put through,
 *    and the copy in `default` shadows the vault page on an unscoped get.
 *  - Why existing coverage misses it: no parity case puts a slug unsourced while another source holds it.
 *  - Seam: none. Real engines; put_page runs through the registry operation. The refusal is decided before any
 *    write, from listAllSources and readPageSnapshot (Rust sources and pages areas).
 */
import { describe, expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'people/erin-example';
const refusal = (retry: string) => `Page ${SLUG} lives in source vault. This put names no source, so it would write a second copy to source default. `
  + `To update the page in vault, run the same put with its source: ${retry}`;

function ctx(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind, embedding_disabled: true } as never, remote: false, sourceId: 'default',
    localSourceImplicit: true, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}

describe('engine parity: unsourced put keeps a page in its source', () => {
  parityTest('an unsourced put of a slug held by one other source is refused with the retry, and forks nothing',
    { methods: ['putPage', 'listAllSources', 'readPageSnapshot'] }, async (engine, backend) => {
      await createSource(engine, backend, 'vault');
      await engine.putPage(SLUG, { type: 'person', title: 'Erin Example', compiled_truth: 'Erin is at acme-example.', timeline: '' }, { sourceId: 'vault' });
      await engine.putPage('notes/scratch', { type: 'note', title: 'Scratch', compiled_truth: 'Scratch.', timeline: '' });
      const messages: Array<{ code: unknown; message: string }> = [];
      for (const force of [false, true]) {
        const content = '---\ntype: person\ntitle: Erin Example\n---\n# Erin Example\n\nErin moved.\n';
        try {
          await operationsByName.put_page!.handler(ctx(engine), { slug: SLUG, content, request_id: randomUUID(), ...(force ? { force } : {}) });
          messages.push({ code: null, message: 'written' });
        } catch (e) {
          messages.push({ code: (e as { code?: unknown }).code, message: (e as Error).message });
        }
      }
      const shadow = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
      const result = { messages, shadow: shadow === null ? null : 'present' };
      expect(result).toEqual({
        messages: [
          { code: 'invalid_params', message: refusal(`gbrain put ${SLUG} --source-id vault`) },
          { code: 'invalid_params', message: refusal(`gbrain put ${SLUG} --source-id vault --force`) },
        ],
        shadow: null,
      });
      return result;
    });

  parityTest('a batch put with no source refuses the page held by one other source, names the retry, and writes nothing there',
    { methods: ['putPage', 'listAllSources', 'readPageSnapshot'] }, async (engine, backend) => {
      await createSource(engine, backend, 'vault');
      await engine.putPage(SLUG, { type: 'person', title: 'Erin Example', compiled_truth: 'Erin is at acme-example.', timeline: '' }, { sourceId: 'vault' });
      await engine.putPage('notes/scratch', { type: 'note', title: 'Scratch', compiled_truth: 'Scratch.', timeline: '' });
      const content = '---\ntype: person\ntitle: Erin Example\n---\n# Erin Example\n\nErin moved.\n';
      const receipt = await operationsByName.put_pages!.handler(ctx(engine), { request_id: randomUUID(), pages: [{ slug: SLUG, content }] }) as
        { state: string; pages: Array<{ state: string; error?: { message: string; detail?: string } }> };
      const outcome = { state: receipt.state, pages: receipt.pages.map(entry => ({ state: entry.state, detail: entry.error?.detail, message: entry.error?.message })) };
      const shadow = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
      const result = { outcome, shadow: shadow === null ? null : 'present' };
      expect(result).toEqual({
        outcome: { state: 'failed', pages: [{ state: 'refused', detail: 'slug_in_other_source', message: refusal(`gbrain put ${SLUG} --source-id vault`) }] },
        shadow: null,
      });
      return result;
    });

  parityTest('an upload that begins a new page with no source refuses the page held by one other source, and stages nothing',
    { methods: ['putPage', 'listAllSources', 'readPageSnapshot'] }, async (engine, backend) => {
      await createSource(engine, backend, 'vault');
      await engine.putPage(SLUG, { type: 'person', title: 'Erin Example', compiled_truth: 'Erin is at acme-example.', timeline: '' }, { sourceId: 'vault' });
      await engine.putPage('notes/scratch', { type: 'note', title: 'Scratch', compiled_truth: 'Scratch.', timeline: '' });
      const text = '---\ntype: person\ntitle: Erin Example\n---\n# Erin Example\n\nErin moved.\n';
      let outcome: unknown;
      try {
        await operationsByName.begin_page_upload!.handler(ctx(engine), { slug: SLUG, mode: 'create', total_bytes: Buffer.byteLength(text),
          sha256: createHash('sha256').update(text, 'utf8').digest('hex'), request_id: randomUUID() });
        outcome = { code: null, message: 'begun' };
      } catch (e) {
        if ((e as { code?: unknown }).code === 'engine_capability_missing') throw e; // an engine without the persistence journal stops here
        outcome = { code: (e as { code?: unknown }).code, detail: (e as { detail?: unknown }).detail, message: (e as Error).message };
      }
      const shadow = await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true });
      const result = { outcome, shadow: shadow === null ? null : 'present' };
      expect(result).toEqual({
        outcome: { code: 'invalid_params', detail: 'slug_in_other_source', message: refusal(`gbrain put ${SLUG} --source-id vault`) },
        shadow: null,
      });
      return result;
    });
});
