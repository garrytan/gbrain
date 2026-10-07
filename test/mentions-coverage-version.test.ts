/**
 * Entity mention index, version-aware coverage and invalidation
 * (mentions/coverage.ts, mentions/pass.ts, mentions/upgrade-notice.ts) on
 * PGLite.
 *
 * Protects: a binary whose MENTION_EXTRACTOR_VERSION or
 * ALIAS_DERIVATION_VERSION is ahead of the stored page state reports every
 * version-behind page as pending on an unchanged brain (whatever its
 * updated_at), on the card, get_backlinks and post-upgrade, until the sweep
 * finishes; the recount happens once and later coverage reads stay O(1);
 * an interrupted (deadline) sweep leaves an exact remaining count and the
 * next sweep finishes it; one cycle-budget sweep on a brain built at the
 * previous versions derives the new grammar's aliases and links; alias
 * staleness counts only linkable entity pages; changing
 * mentions.alias_deny, mentions.multiword_aliases or mentions.sibling_merge
 * marks pages due on an indexed brain; a denied alias comes back when the
 * deny is removed. Regression: coverage that reads `complete` after an
 * upgrade because no page was written since the last count.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import {
  ALIAS_DERIVATION_VERSION, INDEX_VERSION_STAMP, MENTION_EXTRACTOR_VERSION, countMentionDuePages, runMentionPass,
} from '../src/core/mentions/pass.ts';
import { mentionCoverageNotice, readMentionCoverage } from '../src/core/mentions/coverage.ts';
import { mentionIndexUpgradeNotice } from '../src/core/mentions/upgrade-notice.ts';
import { deriveEntityAliases } from '../src/core/mentions/aliases.ts';
import { CYCLE_STALE_DRAIN_BUDGET_MS } from '../src/core/cycle.ts';
import { derivedAliases, mentionBrain, mentionLinks, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
const config = { engine: 'pglite' } as never;
const remote = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config };

beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });

async function call(op: string, args: Record<string, unknown>) {
  const r = await dispatchToolCall(engine, op, args, remote as never);
  return { json: r.isError ? null : JSON.parse(r.content[0].text), notices: r.content.slice(1).map(c => c.text) };
}

const ACCOUNT_BODY = 'Account code: QUCO\nInternal nickname: Copper Fox\nOwner: Dana Example';
const account = () => page(engine, 'crm/123', 'crm', 'CRM record: Quormiro Capital', ACCOUNT_BODY);

/**
 * The page state and status row the previous binary left: page versions one
 * behind, and a status row counted without this binary's version stamp
 * (`aliasOnly`: only the alias version behind, stamped with it).
 */
async function asPreviousRelease(opts: { aliasOnly?: boolean } = {}) {
  if (!opts.aliasOnly) await engine.executeRaw('UPDATE page_mention_state SET mention_version = $1', [MENTION_EXTRACTOR_VERSION - 1]);
  await engine.executeRaw('UPDATE page_mention_state SET alias_version = $1 WHERE alias_version IS NOT NULL', [ALIAS_DERIVATION_VERSION - 1]);
  await engine.executeRaw(
    `UPDATE mention_index_status SET policy_fingerprint = split_part(policy_fingerprint, ';', 1) || $1`,
    [opts.aliasOnly ? `;v${MENTION_EXTRACTOR_VERSION}.${ALIAS_DERIVATION_VERSION - 1}` : '']);
}

async function statusRow() {
  const [row] = await engine.executeRaw<{ state: string; pending: number; policy_fingerprint: string | null }>(
    "SELECT state, pending, policy_fingerprint FROM mention_index_status WHERE source_id = 'default'");
  return row!;
}

/** Wraps `engine` so every SQL statement it runs is recorded. */
function recording(target: BrainEngine, sqls: string[]): BrainEngine {
  return new Proxy(target, {
    get(t, key) {
      if (key === 'executeRaw') return (sql: string, params?: unknown[]) => { sqls.push(sql); return t.executeRaw(sql, params as never); };
      const value = Reflect.get(t, key, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}

describe('coverage after a version bump on an unchanged brain', () => {
  test('every version-behind page is pending at once; card, get_backlinks and post-upgrade carry it until the sweep finishes', async () => {
    await account();
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    for (let i = 0; i < 4; i++) await page(engine, `tickets/t${i}`, 'ticket', `Ticket ${i}`, 'Customer: QUCO');
    await sweep(engine);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'complete', pending_pages: 0 });
    const linksBefore = await mentionLinks(engine);

    await asPreviousRelease();
    const [written] = await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM pages p, mention_index_status m WHERE m.source_id = 'default' AND p.updated_at >= m.counted_at");
    expect(written!.n).toBe(0);

    const coverage = await readMentionCoverage(engine, ['default']);
    expect(coverage).toMatchObject({ state: 'pending', pending_pages: 6, degraded: true });
    expect(mentionCoverageNotice(coverage)?.fix?.argv).toEqual(['gbrain', 'extract', '--stale', '--catch-up']);
    // The recount is saved once on the status row with this binary's stamp.
    expect(await statusRow()).toMatchObject({ state: 'pending', pending: 6 });
    expect((await statusRow()).policy_fingerprint).toEndWith(`;${INDEX_VERSION_STAMP}`);
    const sqls: string[] = [];
    expect(await readMentionCoverage(recording(engine, sqls), ['default'])).toMatchObject({ state: 'pending', pending_pages: 6 });
    expect(sqls.some(s => s.includes('alias_version'))).toBe(false);

    const card = await call('entity', { name: 'QUCO' });
    expect(card.json.card.coverage).toMatchObject({ state: 'pending', pending_pages: 6, degraded: true });
    expect(card.notices.join('\n')).toContain('[gbrain notice mention_index');
    const backlinks = await call('get_backlinks', { slug: 'crm/123', group: 'page' });
    expect(backlinks.json.coverage).toMatchObject({ state: 'pending', pending_pages: 6 });
    expect(backlinks.notices.join('\n')).toContain('[gbrain notice mention_index');
    const notice = (await mentionIndexUpgradeNotice(engine))?.join('\n') ?? '';
    expect(notice).toContain('[AGENT]');
    expect(notice).toContain('gbrain extract --stale --catch-up');
    expect(notice).toContain('6 page(s)');

    await sweep(engine);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'complete', pending_pages: 0 });
    expect(await statusRow()).toMatchObject({ state: 'complete', pending: 0 });
    expect(await mentionLinks(engine)).toEqual(linksBefore);
    expect(await mentionIndexUpgradeNotice(engine)).toBeNull();
    expect((await call('entity', { name: 'QUCO' })).notices.join('\n')).not.toContain('mention_index');
  });

  test('an interrupted sweep (deadline) leaves the exact remaining count; the next sweep finishes it', async () => {
    await account();
    for (let i = 0; i < 450; i++) await page(engine, `mail/m${i}`, 'email', `Mail ${i}`, i % 50 === 0 ? 'Re: QUCO renewal' : 'Weekly digest');
    await sweep(engine);
    const linksBefore = await mentionLinks(engine);
    expect(linksBefore.length).toBe(9);
    await asPreviousRelease();

    const realNow = Date.now;
    let during: Awaited<ReturnType<typeof readMentionCoverage>> | null = null;
    let interrupted;
    try {
      interrupted = await runMentionPass(engine, {
        deadline: realNow() + 60_000,
        beforePublish: async () => {
          if (during) return;
          during = await readMentionCoverage(engine, ['default']);
          // The deadline passes while the first batch publishes.
          Date.now = () => realNow() + 3_600_000;
        },
      });
    } finally {
      Date.now = realNow;
    }
    expect(during).toMatchObject({ state: 'pending', pending_pages: 451, degraded: true });
    expect(interrupted).toMatchObject({ state: 'pending', pages: 200, remaining: 251 });
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'pending', pending_pages: 251, degraded: true });
    expect((await call('entity', { name: 'QUCO' })).notices.join('\n')).toContain('[gbrain notice mention_index');
    expect((await mentionIndexUpgradeNotice(engine))?.join('\n')).toContain('251 page(s)');

    const resumed = await sweep(engine);
    expect(resumed.mentions).toMatchObject({ state: 'complete', pages: 251, remaining: 0 });
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'complete', pending_pages: 0 });
    expect(await mentionLinks(engine)).toEqual(linksBefore);
  }, 180_000);

  test('alias staleness counts only linkable entity pages', async () => {
    await account();
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    for (let i = 0; i < 3; i++) await page(engine, `tickets/t${i}`, 'ticket', `Ticket ${i}`, 'Customer: QUCO');
    await page(engine, 'notes/n1', 'note', 'n1', 'Nothing relevant.');
    await sweep(engine);
    await asPreviousRelease({ aliasOnly: true });
    expect(await countMentionDuePages(engine)).toBe(0);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'pending', pending_pages: 2 });
    expect((await mentionIndexUpgradeNotice(engine))?.join('\n')).toContain('2 page(s)');
    await sweep(engine);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'complete', pending_pages: 0 });
  });
});

describe('upgrade from a brain built at the previous versions', () => {
  test('one cycle-budget sweep (no manual catch-up) derives the new grammar\'s multi-word alias and links it', async () => {
    await account();
    await page(engine, 'notes/n1', 'note', 'n1', 'Copper Fox renewal call next week.');
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO');
    expect(deriveEntityAliases({ title: 'CRM record: Quormiro Capital', compiled_truth: ACCOUNT_BODY }).aliases.map(a => a.alias_norm))
      .toContain('copper fox');
    await sweep(engine);
    // What the previous grammar left: no multi-word declared alias, so no saved entry and no link from the note.
    await engine.executeRaw("DELETE FROM page_aliases WHERE alias_norm = 'copper fox'");
    await engine.executeRaw("DELETE FROM mention_gazetteer_entries WHERE name_norm = 'copper fox'");
    await engine.executeRaw(
      "DELETE FROM links l USING pages f WHERE f.id = l.from_page_id AND f.slug = 'notes/n1' AND l.link_source = 'mentions'");
    await asPreviousRelease();
    expect(await derivedAliases(engine, 'crm/123')).not.toContain('declared:copper fox');
    expect(await mentionLinks(engine)).toEqual(['tickets/t1 -> crm/123']);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'pending', pending_pages: 3 });

    await sweep(engine, { timeBudgetMs: CYCLE_STALE_DRAIN_BUDGET_MS });
    expect(await derivedAliases(engine, 'crm/123')).toContain('declared:copper fox');
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> crm/123', 'tickets/t1 -> crm/123']);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'complete', pending_pages: 0 });
    expect(await mentionIndexUpgradeNotice(engine)).toBeNull();
  });
});

describe('derivation settings on an indexed brain', () => {
  const indexed = async () => {
    await account();
    await page(engine, 'notes/n1', 'note', 'n1', 'Copper Fox renewal call next week.');
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO');
    await sweep(engine);
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> crm/123', 'tickets/t1 -> crm/123']);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'complete' });
  };

  test.each([
    ['mentions.multiword_aliases', 'false', false],
    ['mentions.alias_deny', 'Copper Fox', false],
    ['mentions.sibling_merge', 'false', true],
  ])('changing %s marks the pages due; the next pass applies it', async (key, value, keepsAlias) => {
    await indexed();
    await engine.setConfig(key, value);
    // A pass stopped before any batch: the fingerprint change alone marks every page due.
    expect(await runMentionPass(engine, { deadline: Date.now() - 1 })).toMatchObject({ state: 'pending', remaining: 3 });
    expect(await countMentionDuePages(engine)).toBe(3);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'pending', pending_pages: 3, degraded: true });
    expect(await runMentionPass(engine)).toMatchObject({ state: 'complete', remaining: 0 });
    expect((await derivedAliases(engine, 'crm/123')).includes('declared:copper fox')).toBe(keepsAlias);
    expect(await mentionLinks(engine)).toEqual(keepsAlias ? ['notes/n1 -> crm/123', 'tickets/t1 -> crm/123'] : ['tickets/t1 -> crm/123']);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'complete', pending_pages: 0 });
  });

  test('a denied alias comes back when mentions.alias_deny no longer names it', async () => {
    await indexed();
    await engine.setConfig('mentions.alias_deny', 'Copper Fox');
    await runMentionPass(engine);
    expect(await derivedAliases(engine, 'crm/123')).not.toContain('declared:copper fox');
    expect(await mentionLinks(engine)).toEqual(['tickets/t1 -> crm/123']);
    await engine.unsetConfig('mentions.alias_deny');
    expect(await runMentionPass(engine)).toMatchObject({ state: 'complete', remaining: 0 });
    expect(await derivedAliases(engine, 'crm/123')).toContain('declared:copper fox');
    expect(await mentionLinks(engine)).toEqual(['notes/n1 -> crm/123', 'tickets/t1 -> crm/123']);
    expect(await readMentionCoverage(engine, ['default'])).toMatchObject({ state: 'complete', pending_pages: 0 });
  });
});
