/**
 * Agent-platform C3: precedence labels and allowed claims.
 *
 * Every search, query, recall and get_page row says which kind of source it came from (record, approved, curated,
 * doc, chat or external); a label only, never a trust raise and never a re-rank. Lean MCP rows show it only when it is
 * not curated. check_claims checks a draft's numbers against the allowed-claims pages (type: facts, claims: allowed)
 * the caller can read, deterministically.
 *
 * Keyless PGLite brain, no repository, no model calls. All names are placeholders.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { projectRows } from '../src/core/search/lean-rows.ts';
import { runSetPrecedence } from '../src/commands/sources-precedence.ts';
import { runClaims } from '../src/commands/claims.ts';
import { checkClaim, extractClaims, allowedLines } from '../src/core/claims/check.ts';
import { COMPANY_PAGES, PERSONAL_PAGES, renderLayoutBlock, renderStarterPage } from '../src/commands/setup-brain-layout.ts';
import { searchCtx, seedPage } from './helpers/keyword-paging-fixture.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';

let engine: PGLiteEngine;
const TERM = 'zebrafinch';

async function seedIn(sourceId: string, slug: string, body: string, fm: Record<string, unknown> = {}, type = 'note') {
  await importFromContent(engine, slug, serializeMarkdown(fm, body, '', { type, title: slug, tags: [] }), { noEmbed: true, forceRechunk: true, sourceId });
}

const op = (name: string) => operations.find(o => o.name === name)!;
function ctxFor(remote: boolean, sourceId = 'default') {
  return { ...searchCtx(engine, remote), sourceId };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [id, config] of [['ledger-src', { precedence: 'record' }], ['meet', { kind: 'meetings' }], ['conversations', {}]] as const) {
    await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::text::jsonb) ON CONFLICT (id) DO NOTHING', [id, JSON.stringify(config)]);
  }
  await seedPage(engine, 'notes/plain', `A plain note about the ${TERM} project.`);
  await seedPage(engine, 'rules/no-weekend-calls', `Rule: no ${TERM} calls on weekends.`, { type: 'rule' });
  await seedPage(engine, 'company/facts', [
    `Company facts about the ${TERM} business.`,
    '- 2026-01-01: 12 paying customers. Source: billing export.',
    '- 2026-06-01: 20 paying customers. Source: billing export.',
    '- 2026-02-01: ARR $1.2M. Source: invoices.',
    '- Example (delete me): 2026-01-01: 99 seats.',
  ].join('\n'), { type: 'facts', frontmatter: { claims: 'allowed' } });
  await seedPage(engine, 'notes/facts-draft', `Unapproved ${TERM} facts.\n\n- 2026-03-01: 40 employees.`, { type: 'facts' });
  await seedPage(engine, 'me/private-facts', `Private ${TERM} facts.\n\n- 2026-04-01: 7 board seats.`, { type: 'facts', frontmatter: { claims: 'allowed', visibility: 'private' } });
  await seedIn('ledger-src', 'ledgers/q1', `The ${TERM} ledger for Q1.`);
  await seedIn('meet', 'meetings/standup', `Standup notes on the ${TERM} launch.`);
  await seedIn('conversations', 'chats/2026-01-01', `A chat about ${TERM} pricing.`);
  await engine.insertFact({ fact: `The ${TERM} launch slipped a week.`, kind: 'fact', entity_slug: 'companies/acme-example', source: 'test', visibility: 'world' }, { source_id: 'meet' });
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

async function getPage(slug: string, sourceId: string) {
  return await op('get_page').handler(ctxFor(false), { slug, source_id: sourceId }) as Record<string, unknown>;
}

describe('precedence labels', () => {
  test('get_page carries the class: curated by default, chat for archive and meeting sources, record when set, approved for rule and allowed-claims pages', async () => {
    expect((await getPage('notes/plain', 'default')).precedence).toBe('curated');
    expect((await getPage('notes/facts-draft', 'default')).precedence).toBe('curated');
    expect((await getPage('company/facts', 'default')).precedence).toBe('approved');
    expect((await getPage('rules/no-weekend-calls', 'default')).precedence).toBe('approved');
    expect((await getPage('ledgers/q1', 'ledger-src')).precedence).toBe('record');
    expect((await getPage('meetings/standup', 'meet')).precedence).toBe('chat');
    expect((await getPage('chats/2026-01-01', 'conversations')).precedence).toBe('chat');
  });

  test('precedence never raises trust: a record source page keeps the trust tier a curated page has', async () => {
    expect((await getPage('ledgers/q1', 'ledger-src')).trust_tier).toBe((await getPage('notes/plain', 'default')).trust_tier);
  });

  test('search rows carry it, and lean rows show it only when it is not curated', async () => {
    const rows = await op('search').handler(ctxFor(false), { query: TERM, source_id: '__all__', limit: 20 }) as Array<Record<string, unknown>>;
    const by = new Map(rows.map(r => [r.slug as string, r]));
    expect(by.get('notes/plain')?.precedence).toBe('curated');
    expect(by.get('ledgers/q1')?.precedence).toBe('record');
    expect(by.get('meetings/standup')?.precedence).toBe('chat');
    const lean = new Map(projectRows(rows, 'lean').map(r => [r.slug as string, r]));
    expect('precedence' in lean.get('notes/plain')!).toBe(false);
    expect(lean.get('ledgers/q1')?.precedence).toBe('record');
    expect(lean.get('company/facts')?.precedence).toBe('approved');
  });

  test('recall facts carry their source class', async () => {
    const out = await op('recall').handler(ctxFor(false, 'meet'), { entity: 'companies/acme-example' }) as { facts: Array<Record<string, unknown>> };
    expect(out.facts.length).toBeGreaterThan(0);
    expect(out.facts[0]!.precedence).toBe('chat');
  });

  test('gbrain sources set-precedence sets and clears the class', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runSetPrecedence(engine, ['meet', 'doc']);
      expect((await getPage('meetings/standup', 'meet')).precedence).toBe('doc');
      await runSetPrecedence(engine, ['meet', '--clear']);
      expect((await getPage('meetings/standup', 'meet')).precedence).toBe('chat');
    } finally { log.mockRestore(); }
  });
});

describe('check_claims', () => {
  const check = async (text: string, remote = false) =>
    await op('check_claims').handler(ctxFor(remote), { text, source_id: '__all__' }) as { claims: Array<Record<string, any>>; allowed_pages: number; summary: Record<string, number> };

  test('supported cites the dated line; an older number conflicts with the newer line; an uncovered number is not_found', async () => {
    const out = await check('We have 20 paying customers. ARR is $1.2M. We had 12 paying customers. We employ 40 people.');
    expect(out.claims.map(c => c.status)).toEqual(['supported', 'supported', 'conflicts', 'not_found']);
    expect(out.claims[0]!.cited).toMatchObject({ slug: 'company/facts', date: '2026-06-01' });
    expect(out.claims[2]!.conflicting[0]).toMatchObject({ slug: 'company/facts', date: '2026-06-01' });
    expect(out.summary).toEqual({ supported: 2, conflicts: 1, not_found: 1 });
  });

  test('a facts page without claims: allowed and an example line never support anything', async () => {
    const out = await check('We employ 40 people and sell 99 seats.');
    expect(out.claims[0]!.status).toBe('not_found');
  });

  test('a private allowed-claims page supports a trusted local caller but reads not_found for a remote one', async () => {
    expect((await check('There are 7 board seats.')).claims[0]!.status).toBe('supported');
    const remote = await check('There are 7 board seats.', true);
    expect(remote.claims[0]!.status).toBe('not_found');
    expect(remote.claims[0]!.cited).toBeUndefined();
  });

  test('gbrain claims check prints one line per claim and the summary', async () => {
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    try { await runClaims(engine, ['check', 'We have 20 paying customers.', '--source', '__all__']); } finally { log.mockRestore(); }
    expect(lines[0]).toBe('supported  "We have 20 paying customers."  company/facts:3 (2026-06-01)');
    expect(lines.at(-1)).toContain('1 supported, 0 conflicts, 0 not found');
  });

  test('extraction skips sentences whose only number is an ISO date, and dated lines are the only allowed lines', () => {
    expect(extractClaims('Met on 2026-01-01. We have 3 offices.')).toEqual(['We have 3 offices.']);
    const lines = allowedLines({ slug: 'me/facts', source_id: 'default', body: 'intro\n- 2026-01-01: 3 offices.\n- 4 desks' });
    expect(lines.map(l => l.line)).toEqual([2]);
    expect(checkClaim('We have 3 offices.', lines).status).toBe('supported');
  });
});

describe('setup layout', () => {
  test('the facts starter pages are allowed-claims pages and the block names check_claims', () => {
    for (const page of [PERSONAL_PAGES, COMPANY_PAGES].flat().filter(p => p.type === 'facts')) {
      expect(renderStarterPage(page)).toContain('\nclaims: allowed\n');
    }
    expect(renderLayoutBlock('claude-code')).toContain('check_claims (gbrain claims check)');
  });
});
