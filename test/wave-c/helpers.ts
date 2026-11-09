/** Wave C test helpers: large page bodies and a put or upload that returns the request's journal row. */
import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { testWaitMs } from '../helpers/wait-for.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const MiB = 1024 ** 2;
export { MiB };
export const pageBody = (bytes: number, marker: string) => {
  const head = `---\ntype: note\ntitle: Large ${marker.slice(0, 12)}\n---\n\n# ${marker}\n\n`;
  const line = `Line about ${marker} and the launch plan for this week.\n`;
  return head + line.repeat(Math.ceil((bytes - head.length) / line.length));
};

/** Puts or uploads `text`; returns the request's journal row once the publication settled (indexing or terminal). */
export async function write(engine: BrainEngine, ctx: OperationContext, slug: string, text: string, how: 'put' | 'upload', opts: { expectedRevision?: string } = {}): Promise<{ state: string; outcome: Record<string, any> | null; id: string; error?: unknown }> {
  let error: unknown;
  let requestId = randomUUID();
  try {
    if (how === 'put') await op('put_page').handler(ctx, { slug, content: text, request_id: requestId, wait_ms: 3_000, ...(opts.expectedRevision ? { expected_revision: opts.expectedRevision } : {}) });
    else {
      const begun = await op('begin_page_upload').handler(ctx, { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: requestId }) as { upload_id: string };
      for (let part = 0, at = 0; at < text.length; part++, at += 3_000_000) {
        const slice = text.slice(at, at + 3_000_000);
        await op('upload_page_part').handler(ctx, { upload_id: begun.upload_id, part, text: slice, part_sha256: hex(slice) });
      }
      const [session] = await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM page_body_stagings WHERE id = $1::uuid', [begun.upload_id]);
      expect(session).toBeDefined();
      await op('commit_page_upload').handler(ctx, { upload_id: begun.upload_id, wait_ms: 3_000 });
    }
  } catch (caught) { error = caught; }
  const deadline = performance.now() + testWaitMs(60_000);
  for (;;) {
    const [row] = await engine.executeRaw<{ state: string; outcome: Record<string, any> | null; id: string }>(
      `SELECT state, outcome, id::text AS id FROM persistence_requests WHERE slug = $1 AND operation IN ('put_page') ORDER BY created_at DESC LIMIT 1`, [slug]);
    if (!['queued', 'running'].includes(row!.state) || performance.now() > deadline) return { ...row!, error };
    await Bun.sleep(100);
  }
}

