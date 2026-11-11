/**
 * GBRA-399 PR 2: the skill resolver library's runtime for long-lived hosts.
 *
 * 1. Protects: a warm handle (openCatalog) answers byte-identically to
 *    resolveSkills across turns, a rebuild and a removal, and keeps its
 *    receipt and index in memory between rebuilds; buildSkillIndexOffThread
 *    returns the in-thread receipt and its ResolverError; a committed turn
 *    collects expired session files at most once per interval; a stale
 *    turn never stamps an adapter-owned stdin catalog and never rewrites a
 *    stamp that is already there.
 * 2. Fails when: the warm path forks from the cold one, a rebuild or a
 *    removal goes unseen, the worker loses an error's code or fix, session
 *    files pile up past the cap, or a skewed stdin catalog writes (and
 *    fsyncs) a stamp every turn.
 * 3. Every test runs on a scratch GBRAIN_HOME with no brain and no database.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSkillIndex, buildSkillIndexOffThread, catalogStatus, gcSkillSessions, openCatalog, removeSkillIndex, resolveSkills, RESOLVER_FEATURES, ResolverError,
  type ResolveResult, type TurnInput,
} from '../src/core/skills/resolver/index.ts';
import { catalogFile } from '../src/core/skills/resolver/paths.ts';
import { GC_INTERVAL_MS, SESSION_TTL_MS, sessionGcSettled } from '../src/core/skills/resolver/session.ts';

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix = 'skres-rt-'): string { const d = mkdtempSync(join(tmpdir(), prefix)); scratch.push(d); return d; }

interface J { id: string; name: string; description?: string; triggers?: string[] }
const BASIC: J[] = [
  { id: 'gbrain:briefing', name: 'briefing', description: 'Prepare a daily briefing from calendar meetings and open notes' },
  { id: 'gbrain:reports', name: 'reports', description: 'Write weekly status reports for a team' },
  { id: 'gbrain:email-triage', name: 'email-triage', description: 'Sort an inbox and draft replies to urgent email' },
  { id: 'gbrain:meeting-notes', name: 'meeting-notes', description: 'Summarize a meeting transcript into decisions and action items' },
  { id: 'gbrain:deploy', name: 'deploy', description: 'Ship a service to production after the tests pass' },
];
const MORE: J[] = [
  ...BASIC,
  { id: 'gbrain:invoices', name: 'invoices', description: 'Draft invoices for acme-example and track payments', triggers: ['send an invoice'] },
  { id: 'gbrain:standup', name: 'standup', description: 'Collect standup updates from the team channel', triggers: ['daily standup'] },
];
function skillDir(root: string, rel: string, name: string, description: string): string {
  const d = join(root, rel);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nSteps.\n`);
  return join(d, 'SKILL.md');
}
function skewVersion(home: string, catalog: string): void {
  const p = catalogFile(home, catalog, 'receipt.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), gbrain_version: '0.0.1' }));
}
const comparable = (r: ResolveResult) => JSON.stringify({
  output: { ...r.output, meta: { ...r.output.meta, timing_ms: 0 } },
  shadow: r.shadowOutput ? { ...r.shadowOutput, meta: { ...r.shadowOutput.meta, timing_ms: 0 } } : null,
  explain: r.explain ?? null, failOpen: r.failOpen ?? false, pending: r.pending ?? null,
});

describe('warm handle', () => {
  test('openCatalog answers byte-identically to resolveSkills over many turns, a rebuild, a source edit and a removal', async () => {
    const src = tmp('skres-rt-src-');
    const json = join(src, 'a.json');
    const root = join(src, 'skills');
    skillDir(root, 'deploy', 'deploy', 'Ship a service to production');
    skillDir(root, 'notes', 'notes', 'Keep meeting notes tidy');
    const T0 = Date.parse('2026-11-01T00:00:00Z');
    const homes = [tmp(), tmp()];
    const buildAll = async (skills: J[]) => {
      writeFileSync(json, JSON.stringify(skills));
      for (const home of homes) await buildSkillIndex({ catalog: 'a', fromJson: json }, { home, now: () => T0 });
    };
    await buildAll(BASIC);
    for (const home of homes) await buildSkillIndex({ catalog: 'b', dirs: [root] }, { home, now: () => T0 });
    const [coldHome, warmHome] = homes as [string, string];
    const handle = openCatalog(['a', 'b'], { home: warmHome, failOpen: true });
    const messages = ['deploy the service', 'summarize the meeting notes', 'thanks', 'write weekly reports', 'qqq zzz', 'use $deploy please', 'send an invoice to acme-example', 'daily standup', 'triage my urgent email', 'prepare the daily briefing'];
    let clock = Date.now();
    let answered = 0;
    let failed = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 48; i++) {
      if (i === 14) await buildAll(MORE);
      if (i === 22) skillDir(root, 'standup', 'standup', 'Run the daily standup');
      if (i === 30) for (const home of homes) await removeSkillIndex('a', { home });
      if (i === 36) await buildAll(BASIC);
      if (i % 4 === 0) clock += 120_000;
      const input: TurnInput = {
        message: messages[i % messages.length]!,
        session_id: i % 3 === 0 ? 'alice-example' : 'acme-example',
        ...(i % 5 === 0 ? { harness: 'codex' } : {}),
        ...(i % 7 === 3 ? { shadow: true } : {}),
        ...(i === 20 ? { reset_session: true } : {}),
        ...(i % 6 === 1 ? { top_k: 2 } : {}),
        ...(i % 9 === 4 ? { previous_user_message: 'deploy the service' } : {}),
      };
      const turn = { now: () => clock, ...(i % 8 === 2 ? { explainTarget: 'gbrain:deploy' } : {}) };
      const cold = await resolveSkills(input, { home: coldHome, catalogs: ['a', 'b'], failOpen: true, ...turn });
      const warm = await handle.resolve(input, turn);
      expect({ turn: i, warm: comparable(warm) }).toEqual({ turn: i, warm: comparable(cold) });
      expect(await warm.commit()).toBe(await cold.commit());
      if (warm.output.error) failed++; else answered++;
      if (warm.output.meta.index_stale) seen.add('stale');
      for (const s of [...warm.output.suggestions, ...(warm.shadowOutput?.suggestions ?? [])]) seen.add(s.id);
    }
    expect(answered).toBeGreaterThan(30);
    expect(failed).toBe(6);
    expect([...seen].filter(x => x === 'stale' || x === 'gbrain:invoices').sort()).toEqual(['gbrain:invoices', 'stale']);
    handle.close();
  });

  test('the handle keeps its receipt in memory until the catalog is rebuilt, then reloads it', async () => {
    const home = tmp();
    writeFileSync(join(home, 'cat.json'), JSON.stringify(BASIC));
    await buildSkillIndex({ catalog: 'c', fromJson: join(home, 'cat.json') }, { home });
    const rp = catalogFile(home, 'c', 'receipt.json');
    const second = Math.floor(Date.now() / 1000) - 60;
    utimesSync(rp, second, second);
    const handle = openCatalog(['c'], { home });
    expect((await handle.resolve({ message: 'deploy' })).output.suggestions[0]?.id).toBe('gbrain:deploy');
    const before = statSync(rp);
    writeFileSync(rp, readFileSync(rp, 'utf8').replace('"schema_version": 1', '"schema_version": 2'));
    utimesSync(rp, second, second);
    expect([statSync(rp).ino, statSync(rp).size, statSync(rp).mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);
    try { await resolveSkills({ message: 'deploy' }, { home }); throw new Error('expected a refusal'); } catch (e) { expect((e as ResolverError).code).toBe('skill_index_incompatible'); }
    expect((await handle.resolve({ message: 'deploy' })).output.suggestions[0]?.id).toBe('gbrain:deploy');
    writeFileSync(join(home, 'cat.json'), JSON.stringify(MORE));
    await buildSkillIndex({ catalog: 'c', fromJson: join(home, 'cat.json') }, { home });
    expect((await handle.resolve({ message: 'send an invoice' })).output.suggestions[0]?.id).toBe('gbrain:invoices');
    await removeSkillIndex('c', { home });
    try { await handle.resolve({ message: 'deploy' }); throw new Error('expected a refusal'); } catch (e) { expect((e as ResolverError).code).toBe('skill_index_missing'); }
    handle.close();
    expect(RESOLVER_FEATURES).toContain('open_catalog');
  });
});

describe('off-thread build', () => {
  test('buildSkillIndexOffThread publishes the receipt buildSkillIndex would, and a ResolverError keeps its code, message and fix', async () => {
    const [h1, h2] = [tmp(), tmp()];
    const input = { catalog: 'c', fromJson: JSON.stringify(MORE), fromJsonStdin: true };
    const off = await buildSkillIndexOffThread(input, { home: h1 });
    const on = await buildSkillIndex(input, { home: h2 });
    const strip = (r: typeof on) => ({ ...r, build: { ...r.build, ms: 0, built_at: '' } });
    expect(strip(off)).toEqual(strip(on));
    expect(JSON.parse(readFileSync(catalogFile(h1, 'c', 'receipt.json'), 'utf8'))).toEqual(off);
    expect((await resolveSkills({ message: 'send an invoice' }, { home: h1 })).output.suggestions[0]?.id).toBe('gbrain:invoices');
    for (const bad of [{ catalog: '../escape', fromJson: '[]', fromJsonStdin: true }, { catalog: 'c', fromJson: '{not json', fromJsonStdin: true }]) {
      const inThread = await buildSkillIndex(bad, { home: h2 }).then(() => null, (e: unknown) => e);
      const offThread = await buildSkillIndexOffThread(bad, { home: h1 }).then(() => null, (e: unknown) => e);
      expect(inThread).toBeInstanceOf(ResolverError);
      expect(offThread).toBeInstanceOf(ResolverError);
      const view = (e: ResolverError) => ({ code: e.code, message: e.message, fix: e.fix, context: e.context });
      expect(view(offThread as ResolverError)).toEqual(view(inThread as ResolverError));
    }
    expect(RESOLVER_FEATURES).toContain('build_off_thread');
  }, 60_000);
});

describe('session GC on the resolve path', () => {
  test('a committed turn deletes expired session files at most once per interval and keeps fresh ones', async () => {
    const home = tmp();
    await buildSkillIndex({ catalog: 'c', fromJson: JSON.stringify(BASIC), fromJsonStdin: true }, { home });
    const dir = join(home, 'skill-index', 'sessions');
    mkdirSync(dir, { recursive: true });
    const old = (Date.now() - SESSION_TTL_MS - 3_600_000) / 1000;
    const plant = (name: string, expired: boolean) => { const p = join(dir, name); writeFileSync(p, '{}'); if (expired) utimesSync(p, old, old); return p; };
    const expired = plant(`${'a'.repeat(64)}.json`, true);
    const fresh = plant(`${'b'.repeat(64)}.json`, false);
    const turn = async (id: string) => { const r = await resolveSkills({ message: 'deploy', session_id: id }, { home }); expect(await r.commit()).toBe(true); await sessionGcSettled(); };
    await turn('alice-example');
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    const later = plant(`${'c'.repeat(64)}.json`, true);
    await turn('alice-example');
    expect(existsSync(later)).toBe(true);
    const past = (Date.now() - GC_INTERVAL_MS - 1000) / 1000;
    utimesSync(join(home, 'skill-index', 'logs', 'session-gc.stamp'), past, past);
    await turn('acme-example');
    expect(existsSync(later)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test('gcSkillSessions runs one bounded pass for an adapter', async () => {
    const home = tmp();
    const dir = join(home, 'skill-index', 'sessions');
    mkdirSync(dir, { recursive: true });
    const old = (Date.now() - SESSION_TTL_MS - 3_600_000) / 1000;
    for (let i = 0; i < 3; i++) { const p = join(dir, `${String(i).repeat(64)}.json`); writeFileSync(p, '{}'); utimesSync(p, old, old); }
    writeFileSync(join(dir, `${'f'.repeat(64)}.json`), '{}');
    expect(await gcSkillSessions({ home })).toBe(3);
    expect(await gcSkillSessions({ home: join(home, 'none') })).toBe(0);
    expect(RESOLVER_FEATURES).toContain('gc_sessions');
  });
});

describe('stale.stamp', () => {
  test('a version skew never stamps an adapter-owned stdin catalog; a dir catalog is stamped once and not rewritten', async () => {
    const home = tmp();
    await buildSkillIndex({ catalog: 'j', fromJson: JSON.stringify(BASIC), fromJsonStdin: true }, { home });
    skewVersion(home, 'j');
    for (let i = 0; i < 2; i++) expect((await resolveSkills({ message: 'deploy' }, { home, catalogs: ['j'] })).output.meta.index_stale).toBe(true);
    expect(existsSync(catalogFile(home, 'j', 'stale.stamp'))).toBe(false);
    expect((await catalogStatus('j', { home })).stale_reason).toBe('gbrain_version_changed');
    const root = tmp('skres-rt-dir-');
    skillDir(root, 'deploy', 'deploy', 'Ship it');
    await buildSkillIndex({ catalog: 'd', dirs: [root] }, { home });
    skewVersion(home, 'd');
    expect((await resolveSkills({ message: 'deploy' }, { home, catalogs: ['d'] })).output.meta.index_stale).toBe(true);
    const stamp = catalogFile(home, 'd', 'stale.stamp');
    expect(JSON.parse(readFileSync(stamp, 'utf8'))).toEqual({ reason: 'gbrain_version_changed' });
    const hourAgo = (Date.now() - 3_600_000) / 1000;
    utimesSync(stamp, hourAgo, hourAgo);
    const pinned = statSync(stamp).mtimeMs;
    expect((await resolveSkills({ message: 'deploy' }, { home, catalogs: ['d'] })).output.meta.index_stale).toBe(true);
    expect(statSync(stamp).mtimeMs).toBe(pinned);
    expect((await catalogStatus('d', { home })).rebuild.stale_stamp).toBe(true);
  });
});
