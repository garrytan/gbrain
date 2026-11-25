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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { QUARANTINE_KEY } from '../src/core/quarantine.ts';

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
  for (const [id, config] of [['ledger-src', { precedence: 'record' }], ['meet', { kind: 'meetings' }], ['conversations', {}], ['guest-src', { guest: true }], ['ext-src', { precedence: 'external' }]] as const) {
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
  await seedIn('ledger-src', 'ledgers/facts', `Ledger ${TERM} facts.\n\n- 2026-01-01: 8 vaults.`, { claims: 'allowed' }, 'facts');
  await seedIn('ext-src', 'ext/facts', `Outside ${TERM} facts.\n\n- 2026-01-01: 11 kiosks.`, { claims: 'allowed' }, 'facts');
  await seedIn('guest-src', 'guest/facts', `Guest ${TERM} facts.\n\n- 2026-01-01: 5 offices.`, { claims: 'allowed' }, 'facts');
  await seedPage(engine, 'held/facts', `Held ${TERM} facts.\n\n- 2026-01-01: 3 data centers.`, { type: 'facts', frontmatter: { claims: 'allowed' } });
  await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('${QUARANTINE_KEY}', jsonb_build_object('reason', 'instruction_like')) WHERE slug = 'held/facts'`);
  await op('put_page').handler(ctxFor(true), { slug: 'agent/facts', content: `---\ntype: facts\nclaims: allowed\n---\nAgent ${TERM} facts.\n\n- 2026-01-01: 9 warehouses.\n` });
  const starter = PERSONAL_PAGES.find(p => p.slug === 'me/facts')!;
  await op('put_page').handler(ctxFor(false), { slug: 'me/facts', content: `${renderStarterPage(starter)}\n- 2026-02-01: I have 3 kids.\n` });
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

  test('a guest source is external, and a page an agent wrote over MCP cannot approve itself with claims: allowed', async () => {
    expect((await getPage('guest/facts', 'guest-src')).precedence).toBe('external');
    const agent = await getPage('agent/facts', 'default');
    expect([agent.trust_tier, agent.origin]).toEqual(['agent_written', 'mcp:put_page']);
    expect(agent.precedence).toBe('curated');
  });

  test('the me/facts starter page written by a local gbrain put stays approved', async () => {
    const page = await getPage('me/facts', 'default');
    expect([page.trust_tier, page.origin, page.precedence]).toEqual(['agent_written', 'cli:put_page', 'approved']);
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
    const patch = spyOn(engine, 'updateSourceConfig');
    try {
      await runSetPrecedence(engine, ['meet', 'doc']);
      expect(patch).toHaveBeenCalledWith('meet', { precedence: 'doc' });
      expect((await getPage('meetings/standup', 'meet')).precedence).toBe('doc');
      await runSetPrecedence(engine, ['meet', '--clear']);
      expect((await getPage('meetings/standup', 'meet')).precedence).toBe('chat');
      const [row] = await engine.executeRaw<{ config: Record<string, unknown> }>(`SELECT config FROM sources WHERE id = 'meet'`);
      expect(row!.config).toEqual({ kind: 'meetings' });
    } finally { log.mockRestore(); patch.mockRestore(); }
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

  test('a sentence with several numbers is supported only when every number is, and conflicts when any is contradicted', async () => {
    const out = await check('We have 20 paying customers and ARR of $5M. We have 20 paying customers and ARR of $1.2M. We have 20 paying customers and 400 parking spaces.');
    expect(out.claims.map(c => c.status)).toEqual(['conflicts', 'supported', 'not_found']);
    expect(out.claims[0]!.conflicting[0]).toMatchObject({ slug: 'company/facts', date: '2026-02-01' });
  });

  test('every number counts, even inside one clause; a percent never matches a plain number; Q3 is not a number', () => {
    const lines = allowedLines({ slug: 'company/facts', source_id: 'default', body: '- 2026-01-01: 10 paying customers.\n- 2026-03-01: 12 employees.' });
    expect(checkClaim('We grew from 10 to 500 paying customers.', lines).status).not.toBe('supported');
    expect(checkClaim('We have 10 paying customers with 99 employees.', lines).status).toBe('conflicts');
    expect(checkClaim('Churn was 10% among paying customers.', lines).status).not.toBe('supported');
    expect(checkClaim('In Q3 we had 10 paying customers.', lines).status).toBe('supported');
  });

  test('a dated line on the locally written me/facts starter page supports a claim', async () => {
    expect((await check('I have 3 kids.')).claims[0]).toMatchObject({ status: 'supported', cited: { slug: 'me/facts' } });
  });

  test('allowed-claims pages in a guest source, written by an agent over MCP or quarantined never support a claim', async () => {
    const out = await check('We have 5 offices. We run 9 warehouses. We run 3 data centers.');
    expect(out.claims.map(c => c.status)).toEqual(['not_found', 'not_found', 'not_found']);
  });

  test('check_claims refuses empty and over-long text; set-precedence refuses a bad class and an unknown source', async () => {
    await expect(check('   ')).rejects.toThrow();
    await expect(check('9'.repeat(20_001))).rejects.toThrow();
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runSetPrecedence(engine, ['meet', 'gospel'])).rejects.toThrow('exit 2');
      await expect(runSetPrecedence(engine, ['no-such-source', 'doc'])).rejects.toThrow('exit 4');
    } finally { exit.mockRestore(); err.mockRestore(); }
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

describe('check_claims matcher follow-ups (C3.1)', () => {
  const linesOf = (body: string) => allowedLines({ slug: 'company/facts', source_id: 'default', body });
  const check = async (text: string) =>
    await op('check_claims').handler(ctxFor(false), { text, source_id: '__all__' }) as { claims: Array<Record<string, any>>; skipped?: Array<Record<string, string>>; pages_truncated?: boolean };

  test('a comma between digits is a thousands separator, not a clause break', () => {
    const lines = linesOf('- 2026-01-01: ARR $2,100,000. Source: invoices.\n- 2026-01-01: 12 paying customers.');
    expect(checkClaim('ARR is $2,100,000 and we have 12 paying customers.', lines).status).toBe('supported');
    expect(checkClaim('We have 12 paying customers, and ARR is $2,100,000.', lines).status).toBe('supported');
    expect(checkClaim('We have 12 paying customers, and ARR is $2,400,000.', lines).status).toBe('conflicts');
  });

  test('every number is checked, a year or a count in the year range included, so none can read as supported unchecked', () => {
    expect(checkClaim('We cut headcount by 2000 and opened 12 offices.', linesOf('- 2026-01-01: We cut headcount by 1500.\n- 2026-01-01: opened 12 offices.')).status).toBe('conflicts');
    expect(checkClaim('Users grew from 2000 to 2500.', linesOf('- 2026-01-01: Users grew from 1800 to 2500.')).status).toBe('conflicts');
    expect(checkClaim('We have 2000 employees and 12 offices.', linesOf('- 2026-01-01: 1500 employees.\n- 2026-01-01: 12 offices.')).status).toBe('conflicts');
    expect(checkClaim('We had 12 customers and 2019 signups.', linesOf('- 2026-01-01: 12 customers.')).status).toBe('not_found');
    expect(checkClaim('In 2025 we had 12 paying customers.', linesOf('- 2026-01-01: 12 paying customers.')).status).not.toBe('supported');
  });

  test('a word shared by two clauses never hides a contradiction or loses exact support', () => {
    expect(checkClaim('We have 50 paying customers and 40 paying employees.', linesOf('- 2026-01-01: 40 paying customers.')).status).toBe('conflicts');
    expect(checkClaim('Acme has 50 employees, Acme has 40 offices.', linesOf('- 2026-01-01: Acme has 40 employees.\n- 2026-01-01: Acme has 40 offices.')).status).toBe('conflicts');
    expect(checkClaim('Revenue was $5M and revenue grew 40%.', linesOf('- 2026-01-01: revenue $5M.\n- 2026-01-01: revenue grew 40%.')).status).toBe('supported');
    expect(checkClaim('We have 12 paying customers and 3 employees.', linesOf('- 2026-01-01: 12 paying customers and 5 employees.')).status).toBe('conflicts');
    expect(checkClaim('Our 2 cofounders have 12 paying customers.', linesOf('- 2026-01-01: 12 paying customers.\n- 2026-01-01: 2 cofounders.')).status).toBe('supported');
  });

  test('a scaled decimal equals the same amount written out', () => {
    const lines = linesOf('- 2026-01-01: ARR $2,010,000. Source: invoices.');
    expect(checkClaim('ARR is $2.01M.', lines)).toMatchObject({ status: 'supported', cited: { line: 1 } });
  });

  test('a record source supports a claim, a source labeled external never does, and the result names each skipped page and why', async () => {
    const out = await check('We hold 8 vaults. We run 11 kiosks.');
    expect(out.claims.map(c => c.status)).toEqual(['supported', 'not_found']);
    expect(out.claims[0]!.cited).toMatchObject({ slug: 'ledgers/facts', source_id: 'ledger-src' });
    const skipped = new Map((out.skipped ?? []).map(s => [s.slug, s.reason]));
    expect(Object.fromEntries(['ext/facts', 'guest/facts', 'agent/facts', 'held/facts', 'notes/facts-draft'].map(s => [s, skipped.get(s)]))).toEqual({
      'ext/facts': 'external', 'guest/facts': 'external', 'agent/facts': 'written_by_agent', 'held/facts': 'quarantined', 'notes/facts-draft': undefined,
    });
  });

  test('gbrain claims check --file reads the draft from a file and names the skipped pages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-file-'));
    const path = join(dir, 'draft.md');
    writeFileSync(path, 'We have 20 paying customers.\n');
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    try { await runClaims(engine, ['check', '--file', path, '--source', '__all__']); } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
    expect(lines[0]).toBe('supported  "We have 20 paying customers."  company/facts:3 (2026-06-01)');
    expect(lines.find(l => l.startsWith('Skipped'))).toContain('agent/facts (written by an agent)');
  });

  test('the 200-page cap counts only allowed-claims pages, so newer facts pages without claims: allowed never crowd them out', async () => {
    for (let i = 0; i < 201; i++) await seedPage(engine, `notes/facts-${String(i).padStart(3, '0')}`, `Draft facts ${i}.\n\n- 2026-07-01: ${i} widgets.`, { type: 'facts' });
    const out = await check('We have 20 paying customers.');
    expect(out.claims[0]!.status).toBe('supported');
    expect(out.pages_truncated).toBeUndefined();
  }, 120_000);
});

