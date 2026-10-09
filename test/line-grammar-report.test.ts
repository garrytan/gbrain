/**
 * Line-grammar findings in the agent operator contract's terms: the put_page
 * advisory (first five findings, a continuation route to the rest) and
 * `get_page grammar_diagnostics` (every finding, guard refusals included)
 * share core/line-grammar-report.ts. A failed settings read is reported, never
 * an ungated parse. Managed PGLite brain.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { lineGrammarReport } from '../src/core/line-grammar-report.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const put = (ctx: OperationContext, slug: string, body: string, type = 'person') =>
  submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
    content: `---\ntype: ${type}\ntitle: ${slug}\n---\n\n${body}\n` } }) as Promise<Record<string, any>>;
const getPage = (ctx: OperationContext, params: Record<string, unknown>) =>
  operations.find(op => op.name === 'get_page')!.handler(ctx, params) as Promise<Record<string, any>>;

const BODY = [
  'Alice builds things.',
  '',
  '- works_at [[companies/acme-example]]',
  '- **works_at** [[companies/acme-example]]',
  '- [preference] Prefers oat milk',
  '- [Time] - [Event]',
  '- board_member [[companies/acme-example]]',
  '- works_at [[companies/acme-example]] since 2024',
  '- [noun] a thing',
  '- [Item] TBD',
].join('\n');

test('advisory findings carry code, why, canonical form and a read-only verify; the rest are one call away', async () => {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('line_grammar.enabled', 'true');
    await put(ctx, 'companies/acme-example', 'Acme.', 'company');
    const written = await put(ctx, 'people/alice-example', BODY);
    const grammar = (written.outcome ?? written).line_grammar;
    expect(grammar).toMatchObject({ relations: 1, facts: 1, total: 6, details_truncated: true, relations_state: 'stored' });
    expect(grammar.findings).toHaveLength(5);
    const decorated = grammar.findings.find((f: any) => f.code === 'type_punctuation');
    expect(decorated).toMatchObject({ reason: 'type_punctuation', canonical: '- works_at [[companies/acme-example]]' });
    expect(decorated.message).toStartWith('Page saved; line');
    expect(decorated.why).toContain('bare');
    expect(decorated.verify).toMatchObject({ actor: 'agent', consent: [], mcp: { tool: 'get_page', arguments: { slug: 'people/alice-example', grammar_diagnostics: true } } });
    expect(grammar.more.mcp).toMatchObject({ tool: 'get_page', arguments: { grammar_diagnostics: true } });
    const undeclared = grammar.findings.find((f: any) => f.code === 'undeclared_type');
    expect(undeclared.message).not.toContain('Did you mean');

    const read = await getPage(ctx, { slug: 'people/alice-example', grammar_diagnostics: true });
    expect(read.line_grammar).toMatchObject({ state: 'ok', enabled: true, mode: 'effective', total: 6, details_truncated: false });
    expect(read.line_grammar.findings.map((f: any) => f.code).sort()).toEqual(
      ['placeholder_claim', 'prose_tail', 'template_slot', 'type_punctuation', 'undeclared_type', 'usage_label']);
    expect(read.line_grammar.findings.every((f: any) => !f.message.startsWith('Page saved'))).toBe(true);

    const plain = await getPage(ctx, { slug: 'people/alice-example' });
    expect(plain.line_grammar).toBeUndefined();
  });
}, 120_000);

test('with the grammar off, put_page reports nothing and get_page says the grammar is off', async () => {
  await managedBrain(async ({ ctx }) => {
    await put(ctx, 'companies/acme-example', 'Acme.', 'company');
    const written = await put(ctx, 'people/alice-example', BODY);
    expect((written.outcome ?? written).line_grammar).toBeUndefined();
    const read = await getPage(ctx, { slug: 'people/alice-example', grammar_diagnostics: true });
    expect(read.line_grammar).toMatchObject({ state: 'ok', enabled: false, relations: 1 });
  });
}, 120_000);

test('a failed settings read is reported as diagnostics_failed, never as an ungated parse', async () => {
  const broken = { getConfig: async () => { throw new Error('connection reset'); } } as unknown as BrainEngine;
  const report = await lineGrammarReport(broken, { slug: 'people/x', sourceId: 'default', body: BODY });
  expect(report).toMatchObject({ state: 'diagnostics_failed', fix: { argv: ['gbrain', 'doctor', '--json'] } });
  expect((report as { message: string }).message).toContain('connection reset');
});
