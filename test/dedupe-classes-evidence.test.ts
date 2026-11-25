/**
 * Dedupe v2 evidence (GST-3609): `gbrain dedupe classes` and `gbrain dedupe sample` on a repo-less PGLite brain with
 * placeholder people. Every class (C1 to C7, M1, X1, X2 and the two-signal combinations), the contradictions (C6, Mx),
 * zero email and chat pages, Exa off by default, the privacy filter (a private, family or minor page never reaches the
 * HTTP client, asserted on a fake fetch), the cache, both caps and the dry run. Nothing is written but the Exa cache.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { classifyPairs, samplePairs, type ClassifiedPair } from '../src/core/entities/evidence/classes.ts';
import { classesOf, combine, type Signal } from '../src/core/entities/evidence/combine.ts';
import { sensitivityOf, type PersonPage } from '../src/core/entities/evidence/people.ts';
import { emailSignals, parseAddress, type EmailIndex } from '../src/core/entities/evidence/email.ts';
import { EXA_CACHE_PREFIX, EXA_SEARCH_URL, EXA_SPENT_KEY, EXA_SWITCH_KEY, exaQueryFor, exaSettings, profileUrl, resultMatches, type ExaSettings } from '../src/core/entities/evidence/exa.ts';

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-dedupe-classes-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('people-b','people-b') ON CONFLICT DO NOTHING");
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('gc','gc','{"kind":"google"}'::jsonb) ON CONFLICT DO NOTHING`);
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const put = (slug: string, type: string, title: string, frontmatter: Record<string, unknown>, sourceId = 'default', body = `${title} notes.`) =>
  engine.putPage(slug, { type, title, compiled_truth: body, timeline: '', frontmatter } as never, { sourceId } as never);
const person = (slug: string, title: string, frontmatter: Record<string, unknown> = {}, sourceId = 'default') => put(slug, 'person', title, frontmatter, sourceId);
const link = (from: string, to: string, toSourceId: string) =>
  engine.addLink(from, to, 'fixture', 'mentions', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId }); // gbrain-allow-direct-insert: test fixture edges
const imessage = (chat: string, day: string, group: boolean, title: string, speakers: string[]) =>
  put(`imessage/${chat}/${day}`, 'imessage', `${title} ${day}`, { type: 'imessage', title: `${title} ${day}`, date: day, imessage_chat: chat, group, visibility: 'private' }, 'default',
    [`# ${title} ${day}`, '', ...speakers.map(s => `**${s}** (${day} 9:00 AM): hello`), '**Me** (' + day + ' 9:05 AM): hi'].join('\n'));
const snapshot = async () => JSON.stringify(await engine.executeRaw(
  "SELECT (SELECT count(*)::int FROM pages) AS pages, (SELECT count(*)::int FROM links) AS links, (SELECT count(*)::int FROM entity_identities) AS ids, (SELECT string_agg(slug || ':' || md5(compiled_truth), ',' ORDER BY source_id, slug) FROM pages) AS bodies"));
async function dedupe(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runDedupe(engine, args); } finally { spy.mockRestore(); }
  return lines.join('\n');
}
const byName = (pairs: ClassifiedPair[], title: string) => pairs.filter(p => p.members.some(m => m.title === title));
const one = (pairs: ClassifiedPair[], title: string) => { const found = byName(pairs, title); expect(found.length).toBe(1); return found[0]!; };
const settings = (over: Partial<ExaSettings> = {}): ExaSettings => ({ enabled: true, hasKey: true, runCap: 2000, totalCapUsd: 25, spentUsd: 0, ...over });

describe('gbrain dedupe classes: local evidence', () => {
  test('person pages only: every base class, no email or chat signal, nothing written', async () => {
    await person('people/alice-example', 'Alice Example', { email: 'alice@example.invalid' });
    await person('contacts/alice-example', 'Alice Example', { emails: ['Alice@Example.invalid'] }, 'people-b');
    await person('people/bob-example', 'Bob Example', { phone: '+1 555-555-0101' });
    await person('people/c-bob', 'Robert Sample', { google_contact_id: 'people/c-bob', emails: [], phones: ['(555) 555-0101'] }, 'gc');
    await person('people/carol-example', 'Carol Example', { linkedin: 'in/carol-example' });
    await person('contacts/carol-example', 'Carol Example', { linkedin: 'https://www.linkedin.com/in/carol-example/' }, 'people-b');
    await person('people/dana-example', 'Dana Example', { linkedin: 'in/dana-one' });
    await person('people/dana-example', 'Dana Example', { linkedin: 'in/dana-two' }, 'people-b');
    await person('people/erin-example', 'Erin Example', { email: 'team@acme.invalid' });
    await person('people/erin-example', 'Erin Example', { email: 'team@acme.invalid' }, 'people-b');
    await person('people/frank-example', 'Frank Example', { github: 'frank-ex' });
    await person('people/frank-example-2', 'Frank Example', { github: 'https://github.com/frank-ex' });
    await person('people/gina-example', 'Gina Example');
    await person('contacts/gina-example', 'Gina Example', {}, 'people-b');
    await person('people/hank-example', 'Hank Example', { company: 'Acme Example', email: 'hank@a.invalid' });
    await person('people/hank-example', 'Hank Example', { company: 'Acme Example', email: 'hank@b.invalid' }, 'people-b');
    for (const m of ['meetings/m1', 'meetings/m2']) {
      await put(m, 'meeting', `Meeting ${m}`, {});
      await link(m, 'people/hank-example', 'default');
      await link(m, 'people/hank-example', 'people-b');
    }
    await person('people/ivy-example', 'Ivy Example', { email: 'ivy@work.invalid' });
    await person('people/ivy-example', 'Ivy Example', { email: 'ivy@home.invalid', phones: ['+1 555-555-0102'] }, 'people-b');
    await person('people/jack-example', 'Jack Example', { phone: '+1 555-555-0103' });
    await person('contacts/jack-example', 'Jack Example', {}, 'people-b');
    await person('people/kim-example', 'Kim Example', { phone: '+1 555-555-0104' });
    await person('contacts/kim-example', 'Kim Example', { phone: '555.555.0104' }, 'people-b');
    await person('people/lena-example', 'Lena Example', { email: 'lena@example.invalid', relationship: 'sister' });
    await person('contacts/lena-example', 'Lena Example', { email: 'lena@example.invalid' }, 'people-b');
    await person('people/zara-one', 'Zara One');
    await person('people/zara-one', 'Yusuf Two', {}, 'people-b');

    const before = await snapshot();
    const { report, pairs } = await classifyPairs(engine);
    expect(one(pairs, 'Alice Example')).toMatchObject({ base: 'C1', verdict: 'link', classes: ['C1'] });
    expect(one(pairs, 'Bob Example')).toMatchObject({ base: 'C2', verdict: 'wait', reason: 'names disagree' });
    expect(one(pairs, 'Carol Example')).toMatchObject({ base: 'C3', verdict: 'link' });
    expect(one(pairs, 'Dana Example')).toMatchObject({ base: 'C6', verdict: 'wait' });
    expect(one(pairs, 'Erin Example')).toMatchObject({ base: 'C6', verdict: 'wait', email_off: 'role address' });
    expect(one(pairs, 'Frank Example')).toMatchObject({ base: 'C7', verdict: 'collapse' });
    expect(one(pairs, 'Gina Example')).toMatchObject({ base: 'C5', verdict: 'wait', classes: ['C5'], signals: [] });
    expect(one(pairs, 'Hank Example')).toMatchObject({ base: 'C5', signals: ['C4'], classes: ['C4'], verdict: 'wait', reason: 'one strong signal' });
    expect(one(pairs, 'Kim Example')).toMatchObject({ base: 'C1', verdict: 'link' });
    expect(one(pairs, 'Lena Example')).toMatchObject({ base: 'C1', verdict: 'wait', reason: 'family or minor page' });
    expect(byName(pairs, 'Zara One')).toEqual([]);
    for (const p of pairs) expect(p.signals.filter(s => /^[EM]/.test(s))).toEqual([]);
    expect(report.email.pages).toBe(0);
    expect(report.messaging).toMatchObject({ pages: 0, chats: 0, signal: 'no reader' });
    expect(report.exa).toEqual({ mode: 'off' });
    expect(report.classes).toMatchObject({ C1: 3, C2: 1, C3: 1, C4: 1, C6: 2, C7: 1 });
    expect(await snapshot()).toBe(before);
  });

  test('email and chat pages add E1, E4, M1, M3 and Mx; base classes stay as they were', async () => {
    await put('email/t-ivy', 'email', 'Lunch', { type: 'email', from: 'Ivy Example <ivy@work.invalid>', to: ['Ivy Example <ivy@home.invalid>'], participants: ['ivy@home.invalid', 'ivy@work.invalid'] });
    await put('email/t-hank', 'email', 'Notes', { type: 'email', from: '"Hank Example" <hank@b.invalid>', to: ['owner@example.invalid'], participants: ['hank@b.invalid', 'owner@example.invalid'] });
    await link('email/t-hank', 'people/hank-example', 'default');
    for (const g of ['g1', 'g2']) {
      await imessage(g, '2026-01-01', true, 'Friends', ['+15555550102', 'Other Person']);
      await imessage(g, '2026-01-02', true, 'Friends', ['Ivy Example', 'Other Person']);
    }
    await imessage('j1', '2026-01-01', false, '+15555550103', ['+15555550103']);
    await imessage('j1', '2026-01-02', false, 'Jack Example', ['Jack Example']);
    await imessage('k1', '2026-01-01', false, '+15555550104', ['+15555550104']);
    await imessage('k1', '2026-01-02', false, 'Kim Example', ['Kim Example']);
    await imessage('k2', '2026-01-01', false, '+15555550104', ['+15555550104']);
    await imessage('k2', '2026-01-02', false, 'Zed Other', ['Zed Other']);
    await put('conversations/whatsapp-big', 'note', 'Group export', {}, 'default',
      ['# Group', ...Array.from({ length: 12 }, (_, i) => `1/2/26, 9:0${i % 10} AM - Member ${i}: hello`)].join('\n'));

    const before = await snapshot();
    const { report, pairs } = await classifyPairs(engine);
    expect(one(pairs, 'Ivy Example')).toMatchObject({ base: 'C5', signals: ['E1', 'M2', 'M3'], verdict: 'link', classes: ['C5', 'C5+email+messaging'] });
    expect(one(pairs, 'Hank Example')).toMatchObject({ signals: ['C4', 'E4'], verdict: 'link', classes: ['C4', 'C5+email+C4'] });
    expect(one(pairs, 'Jack Example')).toMatchObject({ base: 'C5', signals: ['M1', 'M2'], verdict: 'link', classes: ['C5', 'M1'] });
    expect(one(pairs, 'Kim Example')).toMatchObject({ base: 'C1', verdict: 'wait', reason: 'one handle under different names' });
    expect(one(pairs, 'Kim Example').signals).toContain('Mx');
    expect(one(pairs, 'Gina Example')).toMatchObject({ base: 'C5', verdict: 'wait' });
    expect(report.email.pages).toBe(2);
    expect(report.messaging).toMatchObject({ pages: 11, chats: 6, one_to_one: 3, too_large: 0 });
    expect(report.classes).toMatchObject({ C1: 3, C2: 1, C3: 1, C4: 1, C6: 2, C7: 1, M1: 1, 'C5+email+messaging': 1, 'C5+email+C4': 1, 'C5+messaging+C4': 0 });
    expect(await snapshot()).toBe(before);

    const text = await dedupe(['classes']);
    expect(text).toContain('nothing was written');
    expect(text).toContain('Signal has no reader');
    const json = JSON.parse(await dedupe(['classes', '--json']));
    expect(json.classes).toEqual(report.classes);
  });

  test('a pair the owner recorded as different is left out', async () => {
    const { pairs } = await classifyPairs(engine);
    const gina = one(pairs, 'Gina Example');
    const groups = JSON.parse(await dedupe(['--preview', '--json'])).groups as Array<{ id: string; members: Array<{ slug: string }> }>;
    const ginaGroup = groups.find(g => g.members.every(m => m.slug.endsWith('/gina-example')))!;
    await dedupe(['reject', ginaGroup.id, '--json']);
    const after = await classifyPairs(engine);
    expect(after.pairs.some(p => p.id === gina.id)).toBe(false);
  });

  test('sample: one class, seeded, a smaller class whole', async () => {
    const a = JSON.parse(await dedupe(['sample', '--class', 'c1', '--n', '2', '--seed', '7', '--json']));
    const b = JSON.parse(await dedupe(['sample', '--class', 'C1', '--n', '2', '--seed', '7', '--json']));
    expect(a.class).toBe('C1');
    expect(a.total).toBe(3);
    expect(a.pairs).toHaveLength(2);
    expect(a.pairs).toEqual(b.pairs);
    for (const p of a.pairs) expect(p.classes).toContain('C1');
    expect(JSON.parse(await dedupe(['sample', '--class', 'M1', '--json'])).pairs).toHaveLength(1);
    const { pairs } = await classifyPairs(engine);
    expect(samplePairs(pairs, 'C1', 100, 3)).toHaveLength(3);
  });
});

describe('gbrain dedupe classes --exa', () => {
  test('off by default: --exa refuses and sends nothing; --dry-run counts with no call', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch');
    try {
      expect(await engine.getConfig(EXA_SWITCH_KEY)).toBeNull();
      const err = await dedupe(['classes', '--exa']).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(OperationError);
      expect((err as OperationError).code).toBe('dedupe_exa_off');
      await person('people/omar-example', 'Omar Example', { company: 'Acme Example' });
      await person('contacts/omar-example', 'Omar Example', { role: 'Engineer' }, 'people-b');
      await person('people/pia-example', 'Pia Example', { company: 'Acme Example' });
      await person('people/pia-example', 'Pia Example', { company: 'Beta Example' }, 'people-b');
      await person('people/quinn-example', 'Quinn Example', { company: 'Acme Example' });
      await person('contacts/quinn-example', 'Quinn Example', { company: 'Acme Example' }, 'people-b');
      await person('people/mia-example', 'Mia Example', { company: 'Acme Example', birth_year: 2015 });
      await person('contacts/mia-example', 'Mia Example', { role: 'Student' }, 'people-b');
      await person('people/nora-example', 'Nora Example', { company: 'Acme Example', visibility: 'private' });
      await person('people/nora-example', 'Nora Example', { company: 'Beta Example' }, 'people-b');
      await person('people/uma-example', 'Uma Example', { company: 'Acme Example', tags: ['Family'] });
      await person('people/uma-example', 'Uma Example', { company: 'Beta Example' }, 'people-b');
      const dry = JSON.parse(await dedupe(['classes', '--exa', '--dry-run', '--json']));
      expect(dry.exa).toMatchObject({ mode: 'dry_run', queries: 4, cached: 0, sent: 4, unsent: 0, cost_usd: 0.016, spent_total_usd: 0 });
      expect(dry.exa.blocked).toMatchObject({ minor: 1, private: 1, family: 1 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  test('live: only name plus clue leaves, never for a private, family or minor page; cache; run and total caps', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fake = (async (url: string, init: RequestInit) => {
      expect(url).toBe(EXA_SEARCH_URL);
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
      const body = JSON.parse(String(init.body)) as { query: string };
      bodies.push(body);
      const results: Record<string, { title: string; url: string }> = {
        'Omar Example Acme Example': { title: 'Omar Example - Engineer at Acme Example', url: 'https://www.linkedin.com/in/omar-example/' },
        'Omar Example Engineer': { title: 'Omar Example | Engineer, Acme Example', url: 'https://linkedin.com/in/omar-example?trk=x' },
        'Pia Example Acme Example': { title: 'Pia Example at Acme Example', url: 'https://linkedin.com/in/pia-one' },
        'Pia Example Beta Example': { title: 'Pia Example at Beta Example', url: 'https://linkedin.com/in/pia-two' },
      };
      return new Response(JSON.stringify({ results: [results[body.query]], costDollars: { total: 0.004 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const run = (s: ExaSettings) => classifyPairs(engine, { exa: { mode: 'live', settings: s, apiKey: 'test-key', fetch: fake } });

    const capped = await run(settings({ runCap: 1 }));
    expect(capped.report.exa).toMatchObject({ mode: 'live', sent: 1, unsent: 3, stopped: 'run_cap' });
    const spent = Number(await engine.getConfig(EXA_SPENT_KEY));
    expect(spent).toBeCloseTo(0.004, 6);
    const total = await run(settings({ totalCapUsd: 0.008, spentUsd: spent }));
    expect(total.report.exa).toMatchObject({ sent: 1, cached: 1, stopped: 'total_cap' });
    const full = await run(await exaSettings({ getConfig: k => engine.getConfig(k) }, { EXA_API_KEY: 'test-key' }).then(s => ({ ...s, enabled: true })));
    expect(full.report.exa).toMatchObject({ sent: 2, cached: 2, unsent: 0 });
    expect(bodies.map(b => b.query).sort()).toEqual(['Omar Example Acme Example', 'Omar Example Engineer', 'Pia Example Acme Example', 'Pia Example Beta Example']);
    for (const b of bodies) {
      expect(Object.keys(b).sort()).toEqual(['category', 'numResults', 'query', 'type']);
      expect(b).toMatchObject({ type: 'lite', category: 'people', numResults: 1 });
      expect(String(b.query)).not.toMatch(/[@\d]|Mia|Nora|Uma|Quinn/);
    }
    expect(one(full.pairs, 'Omar Example')).toMatchObject({ signals: ['X1'], verdict: 'link', classes: ['C5', 'X1'] });
    expect(one(full.pairs, 'Pia Example')).toMatchObject({ signals: ['X2'], verdict: 'different', classes: ['C5', 'X2'] });
    expect(one(full.pairs, 'Quinn Example').signals).toEqual(['X0']);
    expect(one(full.pairs, 'Mia Example').signals).toEqual([]);

    const sent = bodies.length;
    const cached = await run(settings());
    expect(cached.report.exa).toMatchObject({ sent: 0, cached: 4 });
    expect(bodies.length).toBe(sent);
    expect(one(cached.pairs, 'Omar Example').signals).toEqual(['X1']);
    expect((await engine.listConfigKeys(EXA_CACHE_PREFIX)).length).toBe(4);
  });

  test('a page private only by a privacy label, a folder rule or an owner-only source is never searched', async () => {
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('owner-src','owner-src','{"owner_only":true}'::jsonb) ON CONFLICT DO NOTHING`);
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('people-c','people-c') ON CONFLICT DO NOTHING");
    await person('people/vera-example', 'Vera Example', { company: 'Acme Example', confidentiality: 'secret' });
    await person('people/vera-example', 'Vera Example', { company: 'Beta Example' }, 'people-b');
    await person('people/wes-example', 'Wes Example', { company: 'Acme Example' }, 'owner-src');
    await person('people/wes-example', 'Wes Example', { company: 'Beta Example' }, 'people-b');
    await person('people/xena-example', 'Xena Example', { company: 'Acme Example' }, 'people-c');
    await person('people/xena-example', 'Xena Example', { company: 'Beta Example' }, 'people-b');
    await proposeRevision(engine, 'people-c', [{ id: 'staff', prefix: 'people/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
    const fetchSpy = spyOn(globalThis, 'fetch');
    try {
      const dry = await classifyPairs(engine, { exa: { mode: 'dry_run', settings: settings() } });
      expect((dry.report.exa as { blocked: Record<string, number> }).blocked.private).toBe(4);
      expect(dry.report.exa).toMatchObject({ queries: 4, cached: 4, sent: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  test('a family or minor tag added with gbrain tag (the tags table, not frontmatter) keeps the page out of search and its pair waiting', async () => {
    await person('people/ada-example', 'Ada Example', { company: 'Acme Example' });
    await person('people/ada-example', 'Ada Example', { company: 'Beta Example' }, 'people-b');
    await person('people/ben-example', 'Ben Example', { company: 'Acme Example' });
    await person('people/ben-example', 'Ben Example', { company: 'Beta Example' }, 'people-b');
    await engine.addTag('people/ada-example', 'family', { sourceId: 'people-b' } as never);
    await engine.addTag('people/ben-example', 'minor', { sourceId: 'default' } as never);
    expect(await engine.getTags('people/ada-example', { sourceId: 'people-b' })).toContain('family');
    const fetchSpy = spyOn(globalThis, 'fetch');
    try {
      const dry = await classifyPairs(engine, { exa: { mode: 'dry_run', settings: settings() } });
      expect((dry.report.exa as { blocked: Record<string, number> }).blocked).toMatchObject({ family: 2, minor: 2 });
      expect(one(dry.pairs, 'Ada Example')).toMatchObject({ verdict: 'wait', reason: 'family or minor page' });
      expect(one(dry.pairs, 'Ben Example')).toMatchObject({ verdict: 'wait', reason: 'family or minor page' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  test('live: an HTTP error, a failed request or a held lock stops the run cleanly; a failed request counts as spent; reported cost tightens the cap and never lowers the total', async () => {
    await person('people/yara-example', 'Yara Example', { company: 'Acme Example' });
    await person('people/yara-example', 'Yara Example', { company: 'Beta Example' }, 'people-b');
    const live = (f: typeof fetch, s: ExaSettings = settings()) => classifyPairs(engine, { exa: { mode: 'live', settings: s, apiKey: 'test-key', fetch: f } });
    const failed = await live((async () => new Response('busy', { status: 503 })) as unknown as typeof fetch);
    expect(failed.report.exa).toMatchObject({ sent: 0, unsent: 2, stopped: 'http_503' });
    const thrown = await live((async () => { throw new Error('socket hang up'); }) as unknown as typeof fetch);
    expect(thrown.report.exa).toMatchObject({ sent: 1, unsent: 1, stopped: 'network', cost_usd: 0.004 });
    const held = await tryAcquireDbLock(engine, 'dedupe-exa', 5);
    try {
      const busy = await live((async () => { throw new Error('no request while another run holds the lock'); }) as unknown as typeof fetch);
      expect(busy.report.exa).toMatchObject({ sent: 0, unsent: 2, stopped: 'busy' });
    } finally { await held!.release(); }
    expect((await engine.listConfigKeys(EXA_CACHE_PREFIX)).length).toBe(4);
    const before = Number(await engine.getConfig(EXA_SPENT_KEY));
    const dear = (async (_url: string, init: RequestInit) => new Response(JSON.stringify({
      results: [{ title: `${(JSON.parse(String(init.body)) as { query: string }).query}`, url: 'https://linkedin.com/in/yara' }], costDollars: { total: 0.01 } }), { status: 200 })) as unknown as typeof fetch;
    const capped = await live(dear, settings({ spentUsd: before, totalCapUsd: before + 0.015 }));
    expect(capped.report.exa).toMatchObject({ sent: 1, unsent: 1, stopped: 'total_cap' });
    expect(Number(await engine.getConfig(EXA_SPENT_KEY))).toBeCloseTo(before + 0.01, 6);
    const negative = (async (_url: string, init: RequestInit) => new Response(JSON.stringify({
      results: [{ title: (JSON.parse(String(init.body)) as { query: string }).query, url: 'https://linkedin.com/in/yara-2' }], costDollars: { total: -5 } }), { status: 200 })) as unknown as typeof fetch;
    const after = Number(await engine.getConfig(EXA_SPENT_KEY));
    expect((await live(negative)).report.exa).toMatchObject({ sent: 1, cost_usd: 0.004 });
    expect(Number(await engine.getConfig(EXA_SPENT_KEY))).toBeCloseTo(after + 0.004, 6);

    await person('people/zoe-example', 'Zoe Example', { company: 'Acme Example' });
    await person('people/zoe-example', 'Zoe Example', { company: 'Beta Example' }, 'people-b');
    const sentQueries: string[] = [];
    const flips = (async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      sentQueries.push(query);
      await person('people/zoe-example', 'Zoe Example', { company: 'Beta Example', confidentiality: 'secret' }, 'people-b');
      return new Response(JSON.stringify({ results: [{ title: query, url: 'https://linkedin.com/in/zoe' }], costDollars: { total: 0.004 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const changed = await live(flips);
    expect(sentQueries).toEqual(['Zoe Example Acme Example']);
    expect(changed.report.exa).toMatchObject({ sent: 1, withdrawn: 1, unsent: 0 });
  });
});

describe('evidence rules', () => {
  const page = (over: Partial<PersonPage>): PersonPage => ({ source_id: 'default', slug: 'people/x', page_id: 1, title: 'Alice Example', strict: 'alice example',
    handles: new Set(), company: 'Acme Example', role: null, sensitive: null, hold: null, nonPerson: false, restricted: false, entity_id: null, ...over });
  const ev = (base: 'C1' | 'C2' | 'C5' | 'C6', signals: Signal[], sensitive = false) => ({ base, names: base === 'C2' ? false : true, signals: new Set(signals), sensitive });

  test('combine', () => {
    expect(combine(ev('C5', ['E1', 'E4'])).verdict).toBe('wait');
    expect(combine(ev('C5', ['E3', 'M2'])).verdict).toBe('wait');
    expect(combine(ev('C5', ['E3', 'M2'])).score).toBe(2);
    expect(combine(ev('C5', ['M3', 'C4'])).verdict).toBe('link');
    expect(classesOf(ev('C5', ['M3', 'C4']))).toEqual(['C4', 'C5+messaging+C4']);
    expect(combine(ev('C2', ['X1'])).verdict).toBe('link');
    expect(combine(ev('C2', ['E1', 'M3'])).verdict).toBe('link');
    expect(combine(ev('C2', ['M1'])).verdict).toBe('wait');
    expect(combine(ev('C5', ['X2'])).verdict).toBe('different');
    expect(combine(ev('C1', ['X2'])).verdict).toBe('wait');
    expect(combine(ev('C1', [], true)).verdict).toBe('wait');
    expect(combine(ev('C5', ['X1'], true)).verdict).toBe('wait');
    expect(combine(ev('C6', ['X1'])).verdict).toBe('wait');
  });

  test('sensitivity and the Exa query filter', () => {
    expect(sensitivityOf({ tags: ['Close Family'] })).toBe('family');
    expect(sensitivityOf({ relationship: 'my son' })).toBe('family');
    expect(sensitivityOf({ family_name: 'Example' })).toBeNull();
    expect(sensitivityOf({ relationship: 'business partner' })).toBeNull();
    expect(sensitivityOf({ minor: true })).toBe('minor');
    expect(sensitivityOf({ birthday: '2012-04-01' }, new Date('2026-11-23'))).toBe('minor');
    expect(sensitivityOf({ born: 1980 })).toBeNull();
    expect(exaQueryFor(page({}))).toEqual({ query: 'Alice Example Acme Example', name: 'Alice Example', clue: 'Acme Example' });
    expect(exaQueryFor(page({ restricted: true }))).toEqual({ blocked: 'private' });
    expect(exaQueryFor(page({ sensitive: 'minor' }))).toEqual({ blocked: 'minor' });
    expect(exaQueryFor(page({ title: 'alice@example.invalid' }))).toEqual({ blocked: 'no_name' });
    expect(exaQueryFor(page({ title: 'Alice' }))).toEqual({ blocked: 'no_name' });
    expect(exaQueryFor(page({ company: null, role: null }))).toEqual({ blocked: 'no_clue' });
    expect(exaQueryFor(page({ company: '+1 555 555 0100' }))).toEqual({ blocked: 'no_clue' });
    expect(resultMatches({ query: '', name: 'Alice Example', clue: 'Acme Example' }, 'Alice Example - Acme')).toBe(true);
    expect(resultMatches({ query: '', name: 'Alice Example', clue: 'Acme Example' }, 'Alice Other - Acme')).toBe(false);
    expect(profileUrl('https://www.LinkedIn.com/in/a/?x=1')).toBe('linkedin.com/in/a');
  });

  test('E3 co-recipient overlap is supporting; a role address turns email off', () => {
    const a = page({ handles: new Set(['e:a1@example.invalid']) });
    const b = page({ slug: 'people/y', handles: new Set(['e:a2@example.invalid']) });
    const threads = new Map([['a1@example.invalid', new Set([0, 1, 2, 3, 4])], ['a2@example.invalid', new Set([5, 6, 7, 8, 9])]]);
    const co = new Map([['a1@example.invalid', new Set(['p@x.invalid', 'q@x.invalid', 'r@x.invalid'])], ['a2@example.invalid', new Set(['p@x.invalid', 'q@x.invalid'])]]);
    const index: EmailIndex = { pages: 10, threads, names: new Map(), coRecipients: co, linkedSenders: new Map() };
    expect(emailSignals(index, new Map(), a, b)).toEqual({ signals: ['E3'] });
    expect(emailSignals(index, new Map(), a, page({ handles: new Set(['e:info@example.invalid']) }))).toEqual({ signals: [], disabled: 'role address' });
    expect(parseAddress('"Alice Example" <Alice@Example.invalid>')).toEqual({ address: 'alice@example.invalid', name: 'Alice Example' });
    expect(parseAddress('bob@example.invalid')).toEqual({ address: 'bob@example.invalid', name: null });
  });
});
