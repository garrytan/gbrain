/**
 * E3 + C2 (cost wave): the model-visible size of a canonical remote `search`
 * and `query` result on a deterministic fixture brain, pinned beside the C3
 * schema ceiling (test/mcp-schema-budget.test.ts). Every result stays in an
 * agent's context and is re-sent on every later turn, so a change that grows
 * it (pretty-printing content[0] grew a search result by about a quarter)
 * must fail here rather than show up as a cost regression in an eval.
 *
 * The fixture has no embedding key; the first test proves the keyword
 * fallback ran, so the bytes are deterministic. The measured text is every
 * content block an agent sees: content[0] plus the notice blocks (saved
 * facts, other names); the keyless degraded_recall notice has its own bound.
 *
 * Re-pin procedure (when a change grows the result on purpose): run
 * `PRINT_RESULT_SIZES=1 bun test test/mcp-result-size-ceiling.test.ts`,
 * set the ceiling to ceil(measured x 1.05), and say why in the commit
 * message. Never raise a ceiling to absorb pretty-printing or a dropped lean
 * projection: those are the regressions this file exists to catch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { withEnv } from './helpers/with-env.ts';

/**
 * ceil(measured x 1.05) on the fixture below. search 2540 -> 2754 (2622
 * measured): Cat 40 Hard F2's keyword count line rides on every search call
 * (the rows are top-K; the line says how many pages match the keywords).
 * search 2754 -> 3129 (2980) and query 2540 -> 2916 (2777): Cat 40 Hard F4,
 * lean rows keep effective_date_source and a line labels each row's date by
 * its source (document, event or fallback date, never contractual validity).
 */
const CEILINGS = { search: 3129, query: 2916 };
/**
 * The keyless fixture also gets the operator contract's degraded_recall
 * notice (F3) on every HTTP call. It is bounded on its own so the ceilings
 * above keep pinning rows and evidence blocks at their cost-wave size; a
 * keyed brain (Cat 40) never sees it. 629 measured at v0.60.46.0, x 1.05.
 */
const DEGRADED_NOTICE_MAX_CHARS = 661;
const isDegradedNotice = (text: string) => text.startsWith('[gbrain notice degraded_recall ');

const PAGES: Array<[string, string, string]> = [
  ['crm/numbat-labs', 'CRM record: Numbat Labs', 'Account record. Account code: NULA. Segment: mid-market. Renewal owner: the platform team. Billing contact: Old Person.'],
  ['contracts/numbat-labs-msa', 'MSA: Numbat Labs', 'Master services agreement with Numbat Labs (account code NULA). Payment terms: Net 45. Renewal is annual with a 60 day notice window.'],
  ['contracts/amendment-one', 'Amendment No. 1: NULA', 'Executed amendment for NULA: payment terms change to Net 30 from the next invoice.'],
  ['notes/renewal-playbook', 'Renewal playbook', 'The renewal playbook: confirm the billing contact, check payment terms, and send the renewal quote 60 days before the term ends.'],
  ['notes/billing-faq', 'Billing FAQ', 'Billing contacts change often. Confirm the current billing contact before sending an invoice or a renewal quote.'],
];

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, title, body] of PAGES) {
    await importFromContent(engine, slug, serializeMarkdown({}, body, '', { type: 'note', title, tags: [] }), { noEmbed: true, forceRechunk: true });
  }
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from) VALUES
    ('default', 'numbat-labs', 'The billing contact for Numbat Labs is New Person.', 'fact', 'world', 'user update', '2026-09-01'),
    ('default', 'numbat-labs', 'Numbat Labs renewal quote goes to the billing contact.', 'fact', 'world', 'user update', '2026-09-02')`);
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

async function visible(name: 'search' | 'query'): Promise<{ res: ToolResult; text: string }> {
  const args = name === 'query' ? { query: 'Numbat Labs billing contact renewal', expand: false } : { query: 'Numbat Labs billing contact renewal' };
  const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, name, args, { remote: true, transport: 'http', sourceId: 'default' }));
  expect(res.isError).not.toBe(true);
  const degraded = res.content.filter(c => isDegradedNotice(c.text));
  expect(degraded.length).toBe(1);
  expect(degraded[0].text.length).toBeLessThanOrEqual(DEGRADED_NOTICE_MAX_CHARS);
  return { res, text: res.content.filter(c => !isDegradedNotice(c.text)).map(c => c.text).join('\n') };
}

describe('canonical remote result size', () => {
  for (const name of ['search', 'query'] as const) {
    test(`${name}: keyword fallback (deterministic), notices present`, async () => {
      const { res } = await visible(name);
      expect((res._meta?.retrieval as { vector_enabled?: boolean }).vector_enabled).toBe(false);
      expect(res.content.length).toBeGreaterThan(1);
    });

    test(`${name}: content[0] is compact JSON (C2)`, async () => {
      const { res } = await visible(name);
      const text = res.content[0].text;
      expect(text).toBe(JSON.stringify(JSON.parse(text)));
      expect(text).not.toContain('\n  ');
    });

    test(`${name}: model-visible text stays under its ceiling`, async () => {
      const { text } = await visible(name);
      if (process.env.PRINT_RESULT_SIZES === '1') process.stderr.write(`[result-size] ${name}: ${text.length} chars (ceiling ${Math.ceil(text.length * 1.05)})\n`);
      expect(text.length).toBeLessThanOrEqual(CEILINGS[name]);
    });

    test(`${name}: the ceiling catches pretty-printing or full rows coming back`, async () => {
      const { res, text } = await visible(name);
      const rest = text.length - res.content[0].text.length;
      const body = JSON.parse(res.content[0].text);
      expect(JSON.stringify(body, null, 2).length + rest).toBeGreaterThan(CEILINGS[name]);
      const full = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, name,
        { query: 'Numbat Labs billing contact renewal', ...(name === 'query' ? { expand: false } : {}), fields: 'full' },
        { remote: true, transport: 'http', sourceId: 'default' }));
      expect(full.content.filter(c => !isDegradedNotice(c.text)).map(c => c.text).join('\n').length).toBeGreaterThan(CEILINGS[name]);
    });
  }
});
