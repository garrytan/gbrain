/**
 * put_page reports what the line grammar read: typed relation lines (stored
 * with the page's links), fact lines (page text only) and near-misses with
 * their fix. The grammar is off by default (`line_grammar.enabled`). Managed PGLite brain.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const put = (ctx: OperationContext, slug: string, body: string, type = 'person') =>
  submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
    content: `---\ntype: ${type}\ntitle: ${slug}\n---\n\n${body}\n` } }) as Promise<Record<string, any>>;

test('the grammar is off by default (held-out verdict H3): put_page reads no typed lines', async () => {
  await managedBrain(async ({ ctx }) => {
    await put(ctx, 'companies/acme-example', 'Acme.', 'company');
    const written = await put(ctx, 'people/alice-example', '- works_at [[companies/acme-example]] (since 2024)\n- [preference] Prefers oat milk');
    expect((written.outcome ?? written).line_grammar).toBeUndefined();
  });
}, 120_000);

test('put_page types the stated relation, reports fact lines and explains near-misses', async () => {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('line_grammar.enabled', 'true');
    await put(ctx, 'companies/acme-example', 'Acme.', 'company');
    const written = await put(ctx, 'people/alice-example', [
      'Alice builds things.',
      '',
      '- works_at [[companies/acme-example]] (since 2024)',
      '- [preference] Prefers oat milk #coffee',
      '- works_at [[companies/acme-example]] since 2024',
    ].join('\n'));
    const grammar = (written.outcome ?? written).line_grammar;
    expect(grammar).toMatchObject({ relations: 1, relations_state: 'stored', facts: 1, facts_state: 'page_text_only', total: 1,
      details_truncated: false, findings: [{ severity: 'warning', validator: 'line-grammar', line: 5, reason: 'prose_tail' }] });
    expect(grammar.facts_message).toContain('remember');
    const edges = await engine.executeRaw<{ link_type: string }>(`SELECT l.link_type FROM links l JOIN pages f ON f.id=l.from_page_id
      WHERE f.slug='people/alice-example' ORDER BY l.link_type`);
    expect(edges.map(e => e.link_type)).toContain('works_at');
  });
}, 120_000);

test('a page without grammar lines carries no line_grammar block', async () => {
  await managedBrain(async ({ ctx }) => {
    const written = await put(ctx, 'notes/plain', 'Just prose with [[people/someone]].', 'note');
    expect((written.outcome ?? written).line_grammar).toBeUndefined();
  });
}, 120_000);
