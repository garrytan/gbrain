/**
 * #6259 follow-up (quarantine leaks, items 4 and 6): what readers and writers
 * are told about a page the content-quality gate quarantined.
 *   - get_page: a trusted local read keeps the body and carries `quarantined`
 *     plus a `page_quarantined` safety notice; an untrusted read gets no body
 *     (compiled_truth, timeline and `content` withheld) unless an admin-scoped
 *     caller passes include_quarantined: true.
 *   - put_page / put_pages: the result says `quarantined: { reason, detail }`
 *     and carries one `page_quarantined` notice, not only chunk_skip_reason.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { operations } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

const JUNK = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\nScraper notes: the page said "Cloudflare Ray ID: 8f2a" before any article.\n`;
const CLEAN = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\nOrdinary prose about the project and its plans.\n`;
let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-q-surface-'));
const env = { GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home };
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const op = (name: string) => operations.find(o => o.name === name)!;
function ctx(o: { remote?: boolean; scopes?: string[]; notices?: Notice[] } = {}): OperationContext {
  return { engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: o.remote ?? false,
    sourceId: 'default', deferEmbeds: true, ...(o.scopes ? { auth: { scopes: o.scopes, sourceId: 'default' } } : {}),
    ...(o.notices ? { emitNotice: (n: Notice) => o.notices!.push(n) } : {}) } as unknown as OperationContext;
}

describe('put_page and put_pages say the gate hid the page (#6259 item 6)', () => {
  test('put_page reports quarantined and one safety notice; a clean page reports neither', () => withEnv(env, async () => {
    const notices: Notice[] = [];
    const junk = await op('put_page').handler(ctx({ notices }), { slug: 'notes/junk-write', content: JUNK('Junk write') }) as Record<string, unknown>;
    expect(junk.quarantined).toEqual({ reason: 'junk_pattern', detail: 'cloudflare_ray_id' });
    expect(junk.chunk_skip_reason).toBe('embed_skip');
    expect(notices.map(n => [n.code, n.kind])).toEqual([['page_quarantined', 'safety']]);
    expect(notices[0]!.why).toContain('gbrain quarantine clear notes/junk-write --force');
    const clean: Notice[] = [];
    const ok = await op('put_page').handler(ctx({ notices: clean }), { slug: 'notes/clean-write', content: CLEAN('Clean write') }) as Record<string, unknown>;
    expect(ok.quarantined).toBeUndefined();
    expect(clean).toEqual([]);
  }));

  test('put_pages marks each quarantined page and emits one notice for the batch', () => withEnv(env, async () => {
    const notices: Notice[] = [];
    const batch = await op('put_pages').handler(ctx({ notices }), { request_id: randomUUID(), pages: [
      { slug: 'notes/batch-junk', content: JUNK('Batch junk') }, { slug: 'notes/batch-clean', content: CLEAN('Batch clean') }] }) as { pages: Array<Record<string, unknown>> };
    expect(batch.pages.map(p => [p.slug, p.quarantined ?? null])).toEqual([
      ['notes/batch-junk', { reason: 'junk_pattern', detail: 'cloudflare_ray_id' }], ['notes/batch-clean', null]]);
    expect(notices.filter(n => n.code === 'page_quarantined')).toHaveLength(1);
  }));
});

describe('get_page of a quarantined page (#6259 item 4)', () => {
  const read = (c: OperationContext, extra: Record<string, unknown> = {}) =>
    op('get_page').handler(c, { slug: 'notes/junk-write', include_content: true, ...extra }) as Promise<Record<string, unknown>>;

  test('a trusted local read keeps the body, with quarantined and a notice', () => withEnv(env, async () => {
    const notices: Notice[] = [];
    const page = await read(ctx({ notices }));
    expect(String(page.compiled_truth)).toContain('Cloudflare Ray ID');
    expect(String(page.content)).toContain('Cloudflare Ray ID');
    expect(page.quarantined).toMatchObject({ reason: 'junk_pattern', detail: 'cloudflare_ray_id', body_omitted: false });
    expect(notices.map(n => n.code)).toEqual(['page_quarantined']);
  }));

  test('an untrusted read gets no body (content_only included), and the notice says it was withheld', () => withEnv(env, async () => {
    for (const extra of [{}, { content_only: true }, { include_quarantined: true }]) {
      const notices: Notice[] = [];
      const page = await read(ctx({ remote: true, scopes: ['read'], notices }), extra);
      expect(page.quarantined).toMatchObject({ reason: 'junk_pattern', body_omitted: true });
      expect(page.content).toBeUndefined();
      expect(page.compiled_truth ?? '').toBe('');
      expect(page.timeline ?? '').toBe('');
      expect(JSON.stringify(page)).not.toContain('Cloudflare Ray ID: 8f2a');
      expect(notices[0]!.why).toContain('include_quarantined: true');
    }
  }));

  test('an admin-scoped untrusted caller sees the body only when it asks', () => withEnv(env, async () => {
    expect((await read(ctx({ remote: true, scopes: ['admin'] }))).quarantined).toMatchObject({ body_omitted: true });
    const page = await read(ctx({ remote: true, scopes: ['admin'] }), { include_quarantined: true });
    expect(page.quarantined).toMatchObject({ body_omitted: false });
    expect(String(page.content)).toContain('Cloudflare Ray ID');
  }));

  test('a clean page reads as before', () => withEnv(env, async () => {
    const page = await op('get_page').handler(ctx({ remote: true, scopes: ['read'] }), { slug: 'notes/clean-write' }) as Record<string, unknown>;
    expect(page.quarantined).toBeUndefined();
    expect(String(page.compiled_truth)).toContain('Ordinary prose');
  }));
});

describe('fetch of a quarantined page (#6259, same policy as get_page)', () => {
  const fetchPage = (c: OperationContext, extra: Record<string, unknown> = {}) =>
    op('fetch').handler(c, { id: 'notes/junk-write', ...extra }) as Promise<{ text: string; metadata: Record<string, unknown> }>;

  test('a trusted local fetch keeps the text, with metadata.quarantined and a notice', () => withEnv(env, async () => {
    const notices: Notice[] = [];
    const result = await fetchPage(ctx({ notices }));
    expect(result.text).toContain('Cloudflare Ray ID');
    expect(result.metadata.quarantined).toMatchObject({ reason: 'junk_pattern', body_omitted: false });
    expect(notices.map(n => n.code)).toEqual(['page_quarantined']);
  }));

  test('an untrusted fetch gets no text, even when a non-admin asks', () => withEnv(env, async () => {
    for (const extra of [{}, { include_quarantined: true }]) {
      const notices: Notice[] = [];
      const result = await fetchPage(ctx({ remote: true, scopes: ['read'], notices }), extra);
      expect(result.text).toBe('');
      expect(result.metadata.quarantined).toMatchObject({ body_omitted: true });
      expect(JSON.stringify(result)).not.toContain('Cloudflare Ray ID: 8f2a');
      expect(notices[0]!.why).toContain('include_quarantined: true');
    }
  }));

  test('an admin-scoped untrusted caller gets the text only when it asks; a clean page is unchanged', () => withEnv(env, async () => {
    expect((await fetchPage(ctx({ remote: true, scopes: ['admin'] }))).text).toBe('');
    expect((await fetchPage(ctx({ remote: true, scopes: ['admin'] }), { include_quarantined: true })).text).toContain('Cloudflare Ray ID');
    const clean = await op('fetch').handler(ctx({ remote: true, scopes: ['read'] }), { id: 'notes/clean-write' }) as { text: string; metadata: Record<string, unknown> };
    expect(clean.text).toContain('Ordinary prose');
    expect(clean.metadata.quarantined).toBeUndefined();
  }));
});
