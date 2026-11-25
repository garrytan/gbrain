/**
 * household_due / household_add / household_mark (agent platform plan, lane 2, H1) on a repo-less keyless PGLite
 * brain, trusted local callers. The synthetic household seeds 40 records; the ranking and counts were computed by
 * hand (test/fixtures/synthetic-household/household.ts). Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { HOUSEHOLD_SCAN_CAP } from '../src/core/ops/household.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';
import { importStreamedMarkdownFile } from '../src/core/page-body/streamed-import.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { installTripwire, type Tripwire } from './helpers/ai-tripwire.ts';
import { AS_OF, EXPECTED_COUNTS, EXPECTED_DUE, TIMEZONE, seedSyntheticHousehold } from './fixtures/synthetic-household/household.ts';

let engine: PGLiteEngine;
let tripwire: Tripwire;
let slugs: Map<string, string>;
const call = (op: string, params: Record<string, unknown>) => handleToolCall(engine, op, params) as Promise<any>;

beforeAll(async () => {
  tripwire = installTripwire();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('brain.timezone', TIMEZONE);
  slugs = await seedSyntheticHousehold(call);
}, 120_000);

afterAll(async () => {
  tripwire.dispose();
  await engine.disconnect();
});

describe('household_due on the synthetic household', () => {
  test('ranks what is due by the hand-computed order, with the hand-computed counts', async () => {
    const due = await call('household_due', { as_of: AS_OF });
    expect(due.state).toBe('complete');
    expect(due.timezone).toBe(TIMEZONE);
    expect(due.counts).toEqual(EXPECTED_COUNTS);
    expect(due.items.map((i: any) => i.title)).toEqual(EXPECTED_DUE);
    expect(due.truncated).toBe(false);
    expect(due.text).toContain('2 overdue, 12 at risk, 2 coming up');
  });

  test('every proposed action needs the user\'s yes', async () => {
    const all = await call('household_due', { as_of: AS_OF, include: 'all', limit: 100, window_days: 366 });
    const actions = all.items.map((i: any) => i.proposed_action).filter(Boolean);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(a.requires_approval).toBe(true);
  });

  test('kinds and include narrow the read', async () => {
    const bills = await call('household_due', { as_of: AS_OF, kinds: ['bill'] });
    expect(bills.items.map((i: any) => i.title)).toEqual(['Water bill', 'Electric bill', 'Internet bill']);
    const risky = await call('household_due', { as_of: AS_OF, include: 'at_risk' });
    expect(risky.items.map((i: any) => i.state)).not.toContain('upcoming');
  });

  test('a mark restarts the cadence: milk bought today is next due in 7 days, so it moves from at risk to coming up', async () => {
    await call('household_mark', { slug: slugs.get('Milk')!, event: 'bought', on: AS_OF });
    const due = await call('household_due', { as_of: AS_OF });
    const milk = due.items.find((i: any) => i.title === 'Milk');
    expect(milk).toMatchObject({ state: 'upcoming', next_due: '2026-12-08' });
    expect(due.counts).toMatchObject({ at_risk: EXPECTED_COUNTS.at_risk - 1, upcoming: EXPECTED_COUNTS.upcoming + 1 });
  });

  test('no generative model call and no network besides page embedding, when a key is configured, on any household path', () => {
    expect(tripwire.generative()).toEqual([]);
    expect(tripwire.egress.filter(url => !url.endsWith('/embeddings'))).toEqual([]);
  });
});

describe('household_add refusals', () => {
  test('an account number in a field refuses with account_number_key and writes nothing', async () => {
    const err = await call('household_add', { kind: 'bill', title: 'Card 4111 1111 1111 1111', due: '2026-12-09' }).catch(e => e);
    expect(err.code).toBe('account_number_key');
    const err2 = await call('household_add', { kind: 'bill', title: 'Utility', note: 'acct 000123456789', due: '2026-12-09' }).catch(e => e);
    expect(err2.code).toBe('account_number_key');
  });

  test('a second record with the same slug refuses with household_exists', async () => {
    const err = await call('household_add', { kind: 'bill', title: 'Water bill', due: '2026-12-28' }).catch(e => e);
    expect(err.code).toBe('household_exists');
  });

  test('a new request_id does not let household_add overwrite an existing record', async () => {
    const slug = slugs.get('Water bill')!;
    await call('household_mark', { slug, event: 'paid', on: AS_OF });
    const err = await call('household_add', { kind: 'bill', title: 'Water bill', due: '2027-01-01', request_id: 'water-bill-fresh-1' }).catch(e => e);
    expect(err.code).toBe('household_exists');
    const page = await engine.getPage(slug);
    expect(page!.timeline).toContain('household — paid');
    expect(page!.frontmatter.last_paid).toBe(AS_OF);
  });

  test('a retry with the same request_id replays the first add instead of refusing', async () => {
    const params = { kind: 'supply', title: 'Light bulbs', cadence: '90d', last_done: '2026-11-01', request_id: 'light-bulbs-add-1' };
    const first = await call('household_add', params);
    const again = await call('household_add', params);
    expect(again.slug).toBe(first.slug);
    expect((await engine.getPage(first.slug))!.frontmatter.cadence).toBe('90d');
  });
});

describe('status transitions are enforced in write admission, not only in household_mark', () => {
  async function rewriteStatus(title: string, status: string): Promise<any> {
    const slug = slugs.get(title)!;
    const page = await call('get_page', { slug, include_content: true });
    const content = String(page.content).replace(/^status: .*$/m, 'status: ' + status);
    expect(content).toContain('status: ' + status);
    return call('put_page', { slug, expected_revision: page.revision, content }).catch(e => e);
  }

  test('put_page cannot revive an archived record', async () => {
    const err = await rewriteStatus('Old supply', 'active');
    expect(err.code).toBe('household_transition');
    expect((await engine.getPage(slugs.get('Old supply')!))!.frontmatter.status).toBe('archived');
  });

  test('put_page cannot take a paused record straight to done', async () => {
    const err = await rewriteStatus('Gym membership', 'done');
    expect(err.code).toBe('household_transition');
    expect((await engine.getPage(slugs.get('Gym membership')!))!.frontmatter.status).toBe('paused');
  });

  test('edit_page cannot revive an archived record either', async () => {
    const slug = slugs.get('Old birthday')!;
    const page = await call('get_page', { slug, include_content: true });
    const err = await call('edit_page', { slug, expected_revision: page.revision, edits: [{ old_text: 'status: archived', new_text: 'status: active' }] }).catch(e => e);
    expect(err.code).toBe('household_transition');
    expect((await engine.getPage(slug))!.frontmatter.status).toBe('archived');
  });

  test('an allowed move (active to paused) still goes through put_page', async () => {
    const out = await rewriteStatus('Olive oil', 'paused');
    expect(out.code).toBeUndefined();
    expect((await engine.getPage(slugs.get('Olive oil')!))!.frontmatter.status).toBe('paused');
  });
});

describe('one write admission on every path, and writes that keep their state (H1 fix round)', () => {
  const caught = (e: any) => e;

  test('a household_mark retry with the same request_id replays the first mark instead of applying it twice (outside#4)', async () => {
    const add = await call('household_add', { kind: 'bill', title: 'Trash pickup', due: '2026-12-10', recurs: 'monthly' });
    const params = { slug: add.slug, event: 'paid', on: AS_OF, request_id: 'trash-pickup-paid-1' };
    await call('household_mark', params);
    const again = await call('household_mark', params);
    expect(again.replayed).toBe(true);
    const page = await engine.getPage(add.slug);
    expect(page!.timeline.match(/household — paid/g)?.length).toBe(1);
    expect(page!.frontmatter.done_through).toBe('2026-12-10');
  });

  test('a one-off appointment marked done is done, not left active without a date (outside#5)', async () => {
    const add = await call('household_add', { kind: 'appointment', title: 'Piano tuning', due: '2026-12-05' });
    const done = await call('household_mark', { slug: add.slug, event: 'done', on: '2026-12-05' });
    expect(done.status).toBe('done');
    expect((await engine.getPage(add.slug))!.frontmatter).toMatchObject({ status: 'done', due: '2026-12-05' });
    const all = await call('household_due', { as_of: AS_OF, include: 'all', limit: 100, window_days: 366 });
    expect(all.invalid.map((i: any) => i.slug)).not.toContain(add.slug);
    expect((await call('household_mark', { slug: add.slug, event: 'archive', on: '2026-12-06' })).status).toBe('archived');
  });

  test('an empty kinds list reads nothing instead of failing (final review B2)', async () => {
    const due = await call('household_due', { as_of: AS_OF, kinds: [] });
    expect(due.state).toBe('complete');
    expect(due.items).toEqual([]);
  });

  test('a request_id reused for a different mark is not reported as replayed (final review B3)', async () => {
    const add = await call('household_add', { kind: 'bill', title: 'Recycling pickup', due: '2026-12-11', recurs: 'monthly' });
    await call('household_mark', { slug: add.slug, event: 'paid', on: AS_OF, request_id: 'recycling-mark-1' });
    const other = await call('household_mark', { slug: add.slug, event: 'skip', on: AS_OF, request_id: 'recycling-mark-1' }).catch(caught);
    expect(other.replayed).toBeUndefined();
    expect(other.code).toBe('idempotency_conflict');
    const page = await engine.getPage(add.slug);
    expect(page!.timeline).not.toContain('household — skip');
  });

  test('a household_add whose record write fails leaves its subjects as they were (outside#6)', async () => {
    await call('household_add', { kind: 'supply', title: 'Tissues', cadence: '30d', request_id: 'shared-request-1' });
    const err = await call('household_add', { kind: 'supply', title: 'Crayons', cadence: '30d', about: ['people/sky-example'], child: true, request_id: 'shared-request-1' }).catch(caught);
    expect(err.code).toBeDefined();
    expect(await engine.getPage('people/sky-example')).toBeNull();
  });

  test('household_add with a gift state records which year the gift is for (outside#9)', async () => {
    const add = await call('household_add', { kind: 'birthday', title: 'Quinn birthday', on: '12-31', gift: 'ideas' });
    const year = new Date().getUTCFullYear();
    expect([year, year + 1]).toContain((await engine.getPage(add.slug))!.frontmatter.gift_for as number);
  });

  test('a deleted record can be added again', async () => {
    const add = await call('household_add', { kind: 'supply', title: 'Sponges', cadence: '30d' });
    const { revision } = await call('get_page', { slug: add.slug });
    await call('delete_page', { slug: add.slug, expected_revision: revision });
    const again = await call('household_add', { kind: 'supply', title: 'Sponges', cadence: '14d' });
    expect(again.slug).toBe(add.slug);
    expect((await engine.getPage(add.slug))!.frontmatter.cadence).toBe('14d');
  });

  test('an author\'s own readable_by on a record is kept on a brain that serves one person (adversarial-native#1)', async () => {
    const add = await call('household_add', { kind: 'supply', title: 'Coffee filters', cadence: '30d' });
    const page = await call('get_page', { slug: add.slug, include_content: true });
    const content = String(page.content).replace(/^status: active$/m, 'status: active\nreadable_by: [alice-example]');
    expect(content).toContain('readable_by');
    await call('put_page', { slug: add.slug, expected_revision: page.revision, content });
    expect((await engine.getPage(add.slug))!.frontmatter.readable_by).toEqual(['alice-example']);
  });

  test('a page under household/ is not made a household record by its folder alone (adversarial-native#1)', async () => {
    const { loadActivePackForEngine } = await import('../src/core/schema-pack/engine-resolution.ts');
    const resolved = await loadActivePackForEngine(engine, { remote: false, sourceId: 'default' });
    await importFromContent(engine, 'household/plan', '---\ntitle: Plan\n---\n\nJust a note about the house.', { sourceId: 'default', sourcePath: 'household/plan.md', activePack: { page_types: resolved.manifest.page_types }, remote: false });
    expect((await engine.getPage('household/plan'))!.type).not.toBe('household');
  });

  test('a full account number in a record\'s body is refused on a plain put_page (outside#3)', async () => {
    const add = await call('household_add', { kind: 'bill', title: 'Gas bill', due: '2026-12-15' });
    const page = await call('get_page', { slug: add.slug, include_content: true });
    const err = await call('put_page', { slug: add.slug, expected_revision: page.revision, content: String(page.content) + '\n\nPay from acct 000123456789.\n' }).catch(caught);
    expect(err.code).toBe('account_number_key');
    expect((await engine.getPage(add.slug))!.compiled_truth).not.toContain('000123456789');
  });

  test('a large household file through the streamed import is held, never stored without admission (outside#1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-household-stream-'));
    const path = join(dir, 'big.md');
    const policy = { ...(await readPageBodyPolicy(engine)), segmented: true };
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      for (const [slug, head] of [['household/big-bill', '---\ntype: household\nkind: bill\ntitle: Big bill\ndue: 2026-12-01\n---\n'],
        ['people/big-subject', '---\ntype: person\ntitle: Big subject\nhousehold_role: adult\n---\n']] as const) {
        writeFileSync(path, head + 'A line about the house.\n'.repeat(4000));
        const result = await importStreamedMarkdownFile(engine, path, slug + '.md', { noEmbed: true }, statSync(path), policy);
        expect({ slug, status: result.status }).toEqual({ slug, status: 'skipped' });
        expect(await engine.getPage(slug)).toBeNull();
      }
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('household_due at scale', () => {
  const bulk = async (prefix: string, fm: string) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      await engine.executeRaw(
    "INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter) SELECT 'default', 'household/bulk/" + prefix + "-' || g, 'household', '" + prefix + " ' || g, '', '', '" + fm + "'::jsonb FROM generate_series(1, " + (HOUSEHOLD_SCAN_CAP + 1) + ") g");
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  };

  test('archived records and records the filters leave out do not count toward the scan cap (outside#7)', async () => {
    try {
      await bulk('old', '{"kind":"supply","status":"archived","cadence":"30d","household_schema":1}');
      expect((await call('household_due', { as_of: AS_OF })).state).toBe('complete');
      await bulk('fee', '{"kind":"bill","status":"active","due":"2027-06-01","household_schema":1}');
      expect((await call('household_due', { as_of: AS_OF })).state).toBe('partial');
      const supplies = await call('household_due', { as_of: AS_OF, kinds: ['supply'] });
      expect(supplies.state).toBe('complete');
      expect(supplies.items.map((i: any) => i.title)).toContain('Coffee beans');
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("DELETE FROM pages WHERE slug LIKE 'household/bulk/%'");
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }, 120_000);

  test('household replace re-places every record, archived ones included, past the scan cap (follow-up outside#9)', async () => {
    try {
      await bulk('kept', '{"kind":"supply","status":"archived","cadence":"30d","household_schema":1,"household_audience":"shared"}');
      const out = await call('household_replace', {});
      expect(out.checked).toBeGreaterThan(HOUSEHOLD_SCAN_CAP);
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("DELETE FROM pages WHERE slug LIKE 'household/bulk/%'");
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }, 240_000);

  test('household replace sees every record when an earlier one is deleted during the walk (follow-up final review)', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      await engine.executeRaw("INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter) SELECT 'default', 'household/walk/w-' || lpad(g::text, 4, '0'), 'household', 'walk ' || g, '', '', '{\"kind\":\"bill\",\"status\":\"archived\",\"due\":\"2026-12-01\",\"household_schema\":1,\"household_audience\":\"shared\"}'::jsonb FROM generate_series(1, 501) g");
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
    const original = engine.listPages.bind(engine);
    let calls = 0;
    engine.listPages = (async (filters?: any) => {
      if (filters?.type === 'household' && filters?.limit === 500 && calls++ === 1) {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'household/walk/w-0001'");
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
      return original(filters);
    }) as typeof engine.listPages;
    try {
      const out = await call('household_replace', {});
      expect(out.replaced.filter((s: string) => s.startsWith('household/walk/')).length).toBe(501);
    } finally {
      engine.listPages = original;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("DELETE FROM pages WHERE slug LIKE 'household/walk/%'");
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }, 240_000);

  test('a reused request_id is refused before household_add changes any subject (follow-up final review)', async () => {
    await call('household_add', { kind: 'supply', title: 'Napkins', cadence: '30d', request_id: 'shared-request-2' });
    const err = await call('household_add', { kind: 'supply', title: 'Terry glue', cadence: '30d', about: ['people/terry-example'], about_role: 'adult', request_id: 'shared-request-2' }).catch((e: any) => e);
    expect(err.code).toBe('idempotency_conflict');
    expect(await engine.getPage('people/terry-example')).toBeNull();
  });

  test('the user\'s own stdio agent can make a subject a child on a brain that serves one person (merged-head review)', async () => {
    const out = await dispatchToolCall(engine, 'household_add', { kind: 'supply', title: 'Probe crayons', cadence: '30d', about: ['people/probe-example'], child: true }, { remote: true, transport: 'stdio', sourceId: 'default' });
    expect(out.isError).toBeFalsy();
    expect((await engine.getPage('people/probe-example'))!.frontmatter.household_role).toBe('child');
    expect((await engine.getPage('household/kids/supply/probe-crayons'))!.frontmatter.readable_by).toBeUndefined();
  });

  test('a request_id reused with another role is refused, and an exact retry leaves the subject as written (merged-head review #4)', async () => {
    const params = { kind: 'supply', title: 'Dog treats', cadence: '30d', about: ['people/fido-example'], about_role: 'pet', request_id: 'role-request-1' };
    const first = await call('household_add', params);
    const again = await call('household_add', params);
    expect(again.slug).toBe(first.slug);
    const err = await call('household_add', { ...params, about_role: 'other' }).catch((e: any) => e);
    expect(err.code).toBe('idempotency_conflict');
    expect((await engine.getPage('people/fido-example'))!.frontmatter.household_role).toBe('pet');
  });

  test('a request_id reused for the same record with different content changes no subject (final-head review #2)', async () => {
    await call('household_add', { kind: 'supply', title: 'Wood glue', cadence: '30d', request_id: 'same-slug-request' });
    const err = await call('household_add', { kind: 'supply', title: 'Wood glue', cadence: '30d', about: ['people/zed-example'], about_role: 'adult', request_id: 'same-slug-request' }).catch((e: any) => e);
    expect(err.code).toBe('idempotency_conflict');
    expect(await engine.getPage('people/zed-example')).toBeNull();
  });

  test('household_due reads frontmatter only, never page bodies (outside#8)', async () => {
    const seen: any[] = [];
    const original = engine.listPages.bind(engine);
    engine.listPages = (async (filters?: any) => { seen.push(filters); return original(filters); }) as typeof engine.listPages;
    try {
      await call('household_due', { as_of: AS_OF });
    } finally {
      engine.listPages = original;
    }
    const household = seen.filter(f => f?.type === 'household');
    expect(household.length).toBeGreaterThan(0);
    for (const f of household) expect(f.omitBodies).toBe(true);
  });
});

describe('household_add on a brain with no writer registered yet', () => {
  let fresh: PGLiteEngine;
  beforeAll(async () => {
    fresh = new PGLiteEngine();
    await fresh.connect({});
    await fresh.initSchema();
  }, 60_000);
  afterAll(async () => { await fresh.disconnect(); });

  test('a first household_add with a request_id registers the writer and writes the record (merged-head review #6)', async () => {
    const out = await handleToolCall(fresh, 'household_add', { kind: 'supply', title: 'Fresh soap', cadence: '30d', request_id: 'fresh-request-1' }) as any;
    expect(out.slug).toBe('household/supplies/fresh-soap');
  });
});
