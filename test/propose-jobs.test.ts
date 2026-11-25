/**
 * Onboarding job proposals (lane 5, O2: src/core/onboard/propose.ts, `gbrain propose`, MCP propose_jobs and
 * propose_decide), on a repo-less in-memory PGLite brain with invented data only.
 *
 * 1. Protects: the five keyless detectors (people waiting on you, threads you owe a reply, recurring meetings with no
 *    prep page, bulk senders you never wrote to, the same question asked in two harnesses) each give a count, cited
 *    pages and a sentence that carries no page text; the skill is named through the resolver's word match with a fixed
 *    label per signal and no provider call, even with the model picker on and skill vectors built (d14), with a core
 *    command always kept as the fallback; no dollar figure appears; only the owner reads or decides; accept and
 *    decline live in the first-session record; and the top undecided job reaches the first-session section only after
 *    a Google source has synced.
 * 2. Fails when: a detector misses its planted case or counts a decoy, a job sentence leaks a name, subject or
 *    question, the resolver reaches the embedding provider or the model picker, a member-bound caller reads or
 *    decides, a decision does not persist in onboarding.first_session, or the job line shows before a Google sync or
 *    after it was declined.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { upsertOpenLoop } from '../src/core/loops/loops-store.ts';
import { INSTALL_RECEIPT_KEY, type InstallReceipt } from '../src/core/onboard/setup-history.ts';
import { FIRST_SESSION_KEY, firstSessionSectionFor } from '../src/core/onboard/first-session.ts';
import { PROPOSAL_CACHE_MAX_AGE_MS, PROPOSE_SIGNALS, SIGNAL_LABEL, proposeJobs, refreshProposalCache, setProposalDecision, type ProposeResult } from '../src/core/onboard/propose.ts';
import { proposeOperations } from '../src/core/ops/propose.ts';
import { __setEmbedTransportForTests } from '../src/core/skills/resolver/embed-http.ts';
import { __setPickerTransportForTests } from '../src/core/skills/resolver/router-http.ts';
import { buildSkillIndex } from '../src/core/skills/resolver/index.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';

const NOW = new Date();
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString();
const scratch: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d; };

const SKILLS = [
  { id: 'reply-drafter', name: 'reply-drafter', description: 'Reply to email threads I owe an answer, drafted in my voice' },
  { id: 'unsubscriber', name: 'unsubscriber', description: 'Unsubscribe or filter bulk email senders I never read' },
];

let providerCalls = 0;
async function resolverHome(): Promise<string> {
  const home = tmp('propose-home-');
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    embedding_model: 'voyage:voyage-4', embedding_dimensions: 4, voyage_api_key: 'test-key-not-real',
    skills: { resolver: { router: true } },
  }));
  const f = join(tmp('propose-cat-'), 'catalog.json');
  writeFileSync(f, JSON.stringify(SKILLS));
  __setEmbedTransportForTests(async req => req.texts.map(() => [1, 0, 0, 0.05]));
  await buildSkillIndex({ catalog: 'claude-code-user', fromJson: f }, { home });
  return home;
}

async function page(engine: BrainEngine, slug: string, fm: Record<string, unknown>, body: string, sourceId = 'default') {
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  await importFromContent(engine, slug, `---\n${yaml}\n---\n${body}\n`, { sourceId, noEmbed: true });
}

async function seed(engine: BrainEngine) {
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('mail', 'mail', '{"kind":"google"}'::jsonb) ON CONFLICT (id) DO NOTHING`, []);
  // 1. People waiting on you: two promises and a pending decision, two of them to the same person; one stale decoy.
  const loop = (key: string, type: 'commitment_owed_by_me' | 'decision_pending' | 'unanswered_inbound' | 'commitment_owed_to_me', who: string, at: string, thread?: string) =>
    upsertOpenLoop(engine, { sourceId: 'mail', dedupKey: key, loopType: type, counterpartyEmail: who, summary: `Secret summary ${key}`, evidence: [], threadId: thread ?? key, pageSlug: `email/${key}`, detector: 'manual', lastActivityAt: at, openedAt: at });
  await loop('w1', 'commitment_owed_by_me', 'alice@acme-example.com', day(-1));
  await loop('w2', 'decision_pending', 'alice@acme-example.com', day(-2));
  await loop('w3', 'commitment_owed_by_me', 'bob@acme-example.com', day(-3));
  await loop('w-old', 'commitment_owed_by_me', 'carol@acme-example.com', day(-40));
  await loop('w-theirs', 'commitment_owed_to_me', 'dave@acme-example.com', day(-1));
  // 2. Threads you owe a reply.
  await loop('r1', 'unanswered_inbound', 'erin@acme-example.com', day(-1), 't-r1');
  await loop('r2', 'unanswered_inbound', 'frank@acme-example.com', day(-2), 't-r2');
  // 3. Recurring meetings: a weekly sync with no prep page, a standup that has one, and a one-off.
  for (const [i, d] of [-6, -13, 1].entries()) await page(engine, `calendar/sync-${i}`, { type: 'meeting', title: 'Weekly sync with Acme Example', start: day(d), end: day(d) }, '# Weekly sync', 'mail');
  for (const [i, d] of [-2, -9].entries()) await page(engine, `calendar/standup-${i}`, { type: 'meeting', title: 'Team standup', start: day(d), end: day(d) }, '# Standup', 'mail');
  await page(engine, 'notes/team-standup-prep', { type: 'note', title: 'Team standup prep' }, '# Prep\n\nAgenda.');
  await page(engine, 'calendar/offsite', { type: 'meeting', title: 'Offsite planning', start: day(-1), end: day(-1) }, '# Offsite', 'mail');
  // 4. Bulk senders: news@ mailed three threads and was never written to; deals@ once under a promotions label;
  //    alice@ mailed three threads but the owner wrote to her.
  const mail = (slug: string, sender: string, labels: string[], d: number, participants?: string[]) =>
    page(engine, slug, { type: 'email', title: `Subject ${slug}`, account: 'me@example.com', date: day(d), senders: [sender], participants: participants ?? [sender, 'me@example.com'], labels }, '# Mail', 'mail');
  for (const d of [-1, -2, -3]) await mail(`email/news-${-d}`, 'news@acme-example.com', ['INBOX'], d);
  await mail('email/deals-1', 'deals@acme-example.com', ['INBOX', 'CATEGORY_PROMOTIONS'], -2);
  for (const d of [-1, -2, -3]) await mail(`email/alice-${-d}`, 'alice@acme-example.com', ['INBOX'], d);
  await mail('email/to-alice', 'me@example.com', ['SENT'], -20, ['me@example.com', 'alice@acme-example.com']);
  await mail('email/old-news', 'old@acme-example.com', ['INBOX', 'CATEGORY_PROMOTIONS'], -60);
  // 5. The same question in Claude Code and Codex; a decoy asked in one harness only.
  const convo = (slug: string, harness: string, d: string, lines: string[]) =>
    page(engine, slug, { type: 'conversation', title: `${harness} chat ${d}`, date: d, transcript_archive: { layout: 'day', harness, day: d }, speaker_owner: { label: 'User', basis: 'harness_role', turns: lines.length } },
      lines.map(l => `**User** (${d} 10:00): ${l}`).join('\n\n'));
  await convo('conversations/cc-1', 'claude-code', day(-2).slice(0, 10), ['How do I rotate the staging database password?', 'Thanks.']);
  await convo('conversations/cx-1', 'codex', day(-1).slice(0, 10), ['Quick one: how do I rotate the staging database password?']);
  await convo('conversations/cc-2', 'claude-code', day(-1).slice(0, 10), ['Where does the deploy log for acme live?']);
}

const sentenceLeaks = ['alice', 'acme', 'Secret summary', 'Weekly sync', 'rotate', 'staging', 'news@', 'Subject'];

describe('gbrain propose (repo-less PGLite)', () => {
  let engine: BrainEngine;
  let home: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    await seed(engine);
  }, 120_000);
  beforeEach(async () => {
    providerCalls = 0;
    home = await resolverHome();
    __setEmbedTransportForTests(async () => { providerCalls++; throw new Error('propose reached the embedding provider'); });
    __setPickerTransportForTests(async () => { providerCalls++; throw new Error('propose reached the model picker'); });
  });
  afterEach(() => { __setEmbedTransportForTests(null); __setPickerTransportForTests(null); });
  afterAll(async () => { await engine.disconnect(); for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

  test('each detector counts its planted case, cites pages, and words its sentence without page text or dollars', async () => {
    const r = await proposeJobs(engine, { days: 7, now: NOW, resolver: { home } });
    const by = Object.fromEntries(r.jobs.map(j => [j.signal, j]));
    expect(by.waiting_on_you.count).toBe(2);
    expect(by.waiting_on_you.cites.map(c => c.slug).sort()).toEqual(['email/w1', 'email/w2', 'email/w3']);
    expect(by.owe_reply.count).toBe(2);
    expect(by.meeting_prep.count).toBe(1);
    expect(by.meeting_prep.cites[0]!.slug).toStartWith('calendar/sync-');
    expect(by.bulk_senders.count).toBe(2);
    expect(by.bulk_senders.cites.map(c => c.slug)).not.toContain('email/alice-1');
    expect(by.repeat_question.count).toBe(1);
    expect(by.repeat_question.cites.map(c => c.slug).sort()).toEqual(['conversations/cc-1', 'conversations/cx-1']);
    for (const j of r.jobs) {
      expect(j.sentence.length).toBeGreaterThan(10);
      for (const leak of sentenceLeaks) expect(j.sentence).not.toContain(leak);
      expect(j.fallback_command).toStartWith('gbrain ');
    }
    expect(JSON.stringify(r)).not.toMatch(/\$\d/);
    expect(r.jobs.map(j => j.signal)).toEqual([...PROPOSE_SIGNALS]);
  });

  test('d14: skills are named through the word match with a fixed label and zero provider calls, picker on', async () => {
    const r = await proposeJobs(engine, { days: 7, now: NOW, resolver: { home } });
    expect(providerCalls).toBe(0);
    expect(r.resolver).toMatchObject({ providers: 'off', label: 'fixed' });
    const by = Object.fromEntries(r.jobs.map(j => [j.signal, j]));
    expect(by.owe_reply.handled_by).toMatchObject({ kind: 'skill', id: 'reply-drafter', catalog: 'claude-code-user' });
    expect(by.bulk_senders.handled_by).toMatchObject({ kind: 'skill', id: 'unsubscriber' });
    expect(by.waiting_on_you.handled_by).toEqual({ kind: 'command', command: by.waiting_on_you.fallback_command });
    for (const s of PROPOSE_SIGNALS) expect(SIGNAL_LABEL[s]).not.toMatch(/\d/);
  });

  test('d14: with no skill index at all, every job falls back to its core command', async () => {
    const r = await proposeJobs(engine, { days: 7, now: NOW, resolver: { home: tmp('propose-empty-') } });
    expect(providerCalls).toBe(0);
    for (const j of r.jobs) expect(j.handled_by).toEqual({ kind: 'command', command: j.fallback_command });
  });

  test('--days narrows the window: one day keeps only the newest activity', async () => {
    const r = await proposeJobs(engine, { days: 1, now: NOW, resolver: { home } });
    const by = Object.fromEntries(r.jobs.map(j => [j.signal, j]));
    expect(by.waiting_on_you.count).toBe(1);
    expect(by.repeat_question?.count ?? 0).toBe(0);
  });

  test('only the owner reads or decides; a member-bound connection is refused', async () => {
    const [jobs, decide] = [proposeOperations.find(o => o.name === 'propose_jobs')!, proposeOperations.find(o => o.name === 'propose_decide')!];
    expect(jobs.scope).toBe('read');
    expect(jobs.mutating).toBe(false);
    expect(decide.scope).toBe('write');
    const member = { engine, remote: true, transport: 'http', auth: { member: 'bob-example', principal: { kind: 'oauth_client', id: 'c1' } } } as never;
    await expect(jobs.handler(member, { days: 7 })).rejects.toMatchObject({ code: 'propose_owner_only' });
    await expect(decide.handler(member, { signal: 'owe_reply', decision: 'declined' })).rejects.toMatchObject({ code: 'propose_owner_only' });
    const owner = { engine, remote: false } as never;
    const out = await jobs.handler(owner, { days: 7 }) as { jobs: unknown[] };
    expect(out.jobs.length).toBeGreaterThan(0);
  });

  test('an owner connection narrowed to an audience is refused like a member', async () => {
    const jobs = proposeOperations.find(o => o.name === 'propose_jobs')!;
    const stdioOwner = { engine, remote: true, transport: 'stdio' } as never;
    expect(((await jobs.handler(stdioOwner, { days: 7 })) as { jobs: unknown[] }).jobs.length).toBeGreaterThan(0);
    await withCallerAccess({ audience: ['group:team-a'] } as never, async () => {
      await expect(jobs.handler(stdioOwner, { days: 7 })).rejects.toMatchObject({ code: 'propose_owner_only' });
    });
  });

  test('a remote owner call counts and cites only pages the caller can read; the local CLI reads them all', async () => {
    const jobs = proposeOperations.find(o => o.name === 'propose_jobs')!;
    await page(engine, 'email/restricted-1', { type: 'email', title: 'Subject restricted', account: 'me@example.com', date: day(-1), senders: ['hidden@acme-example.com'],
      participants: ['hidden@acme-example.com', 'me@example.com'], labels: ['INBOX', 'CATEGORY_PROMOTIONS'], readable_by: ['member:carol-example'] }, '# Mail', 'mail');
    try {
      const local = (await proposeJobs(engine, { days: 7, now: NOW, resolver: { home } })).jobs.find(j => j.signal === 'bulk_senders')!;
      expect(local.count).toBe(3);
      expect(local.cites.map(c => c.slug)).toContain('email/restricted-1');
      const remote = (await jobs.handler({ engine, remote: true, transport: 'stdio' } as never, { days: 7 }) as ProposeResult).jobs.find(j => j.signal === 'bulk_senders')!;
      expect(remote.count).toBe(2);
      expect(remote.cites.map(c => c.slug)).not.toContain('email/restricted-1');
    } finally {
      await engine.executeRaw(`DELETE FROM pages WHERE slug = 'email/restricted-1'`, []);
    }
  });

  test('pages the remote caller cannot read never suppress a job: a hidden prep note or a hidden sent thread', async () => {
    const jobs = proposeOperations.find(o => o.name === 'propose_jobs')!;
    const remote = async () => Object.fromEntries((await jobs.handler({ engine, remote: true, transport: 'stdio' } as never, { days: 7 }) as ProposeResult).jobs.map(j => [j.signal, j.count]));
    const before = await remote();
    await page(engine, 'notes/weekly-sync-with-acme-example-prep', { type: 'note', title: 'Weekly sync with Acme Example prep', readable_by: ['member:carol-example'] }, '# Prep');
    await page(engine, 'email/to-news', { type: 'email', title: 'Subject to-news', account: 'me@example.com', date: day(-20), senders: ['me@example.com'],
      participants: ['me@example.com', 'news@acme-example.com'], labels: ['SENT'], readable_by: ['member:carol-example'] }, '# Mail', 'mail');
    try {
      const local = Object.fromEntries((await proposeJobs(engine, { days: 7, now: NOW, resolver: { home } })).jobs.map(j => [j.signal, j.count]));
      expect(local.meeting_prep ?? 0).toBe(0);
      expect(local.bulk_senders).toBe(before.bulk_senders! - 1);
      const after = await remote();
      expect(after.meeting_prep).toBe(before.meeting_prep);
      expect(after.bulk_senders).toBe(before.bulk_senders);
    } finally {
      for (const s of ['notes/weekly-sync-with-acme-example-prep', 'email/to-news']) await engine.executeRaw('DELETE FROM pages WHERE slug = $1', [s]);
    }
  });

  test('an archived source feeds no job', async () => {
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'mail'`, []);
    try {
      expect((await proposeJobs(engine, { days: 7, now: NOW, resolver: { home } })).jobs.map(j => j.signal)).toEqual(['repeat_question']);
    } finally {
      await engine.executeRaw(`UPDATE sources SET archived = false WHERE id = 'mail'`, []);
    }
  });

  test('every signal takes accept and decline, stored in the first-session record and shown by propose', async () => {
    const decide = proposeOperations.find(o => o.name === 'propose_decide')!;
    for (const signal of PROPOSE_SIGNALS) for (const decision of ['accepted', 'declined'] as const) {
      const r = await decide.handler({ engine, remote: false } as never, { signal, decision }) as { verified: boolean };
      expect(r.verified).toBe(true);
      expect(JSON.parse((await engine.getConfig(FIRST_SESSION_KEY))!).proposals[signal].decision).toBe(decision);
      expect((await proposeJobs(engine, { days: 7, now: NOW, resolver: { home } })).jobs.find(j => j.signal === signal)!.decision).toBe(decision);
    }
    const top = await refreshProposalCache(engine, { now: NOW });
    expect(top === null || top === 'not_armed').toBe(true);
    await expect(decide.handler({ engine, remote: false } as never, { signal: 'nope', decision: 'declined' })).rejects.toMatchObject({ code: 'invalid_params' });
    await engine.executeRaw('DELETE FROM config WHERE key = $1', [FIRST_SESSION_KEY]);
  });

  test('a sender the owner wrote to long ago is never a bulk sender', async () => {
    const r = await proposeJobs(engine, { days: 7, now: NOW, resolver: { home } });
    expect(r.jobs.find(j => j.signal === 'bulk_senders')!.cites.some(c => c.slug.startsWith('email/alice'))).toBe(false);
  });

  describe('first-session section', () => {
    async function freshInstall() {
      await engine.executeRaw('DELETE FROM config WHERE key IN ($1, $2)', [INSTALL_RECEIPT_KEY, FIRST_SESSION_KEY]);
      const receipt: InstallReceipt = { version: 1, install_id: randomUUID(), created_at: NOW.toISOString(), created_by: 'setup', harness: 'claude-code', eligible: true, stages: {} };
      await engine.setConfig(INSTALL_RECEIPT_KEY, JSON.stringify(receipt));
    }
    const section = async (session: string) => {
      const out = await firstSessionSectionFor(engine, { sourceId: 'default', sessionId: session, harness: 'claude-code', lane: 'owner', now: NOW });
      if (!('text' in out)) throw new Error(out.reason);
      return out.text;
    };

    test('no job line before a Google source has synced', async () => {
      await freshInstall();
      await engine.executeRaw(`UPDATE sources SET last_sync_at = NULL WHERE id = 'mail'`, []);
      expect(await refreshProposalCache(engine, { now: NOW })).toMatchObject({ signal: 'waiting_on_you' });
      expect(await section('s-nosync')).not.toContain('propose');
    });

    test('session start runs no detector: the section reads only the cached job', async () => {
      await freshInstall();
      await engine.executeRaw(`UPDATE sources SET last_sync_at = now() WHERE id = 'mail'`, []);
      await refreshProposalCache(engine, { now: NOW });
      const seen: string[] = [];
      const raw = engine.executeRaw.bind(engine);
      (engine as { executeRaw: unknown }).executeRaw = (sql: string, params?: unknown[]) => { seen.push(sql); return raw(sql, params as never); };
      try {
        expect(await section('s-cache')).toContain('people are waiting on you');
      } finally {
        delete (engine as { executeRaw?: unknown }).executeRaw;
      }
      expect(seen.some(s => /open_loops|type = 'email'|type = 'meeting'|type = 'conversation'/.test(s))).toBe(false);
    });

    test('a cached job older than its freshness window is not offered, and nothing is cached unless armed', async () => {
      await freshInstall();
      await engine.executeRaw(`UPDATE sources SET last_sync_at = now() WHERE id = 'mail'`, []);
      await refreshProposalCache(engine, { now: new Date(NOW.getTime() - PROPOSAL_CACHE_MAX_AGE_MS - 60_000) });
      expect(await section('s-stale')).not.toContain('propose_decide');
      await engine.executeRaw('DELETE FROM config WHERE key = $1', [INSTALL_RECEIPT_KEY]);
      expect(await refreshProposalCache(engine, { now: NOW })).toBe('not_armed');
    });

    test('after the first Google sync the top job rides the section as data-free text, and a decline moves to the next', async () => {
      await freshInstall();
      await engine.executeRaw(`UPDATE sources SET last_sync_at = now() WHERE id = 'mail'`, []);
      await refreshProposalCache(engine, { now: NOW });
      const first = await section('s-1');
      expect(first).toContain('people are waiting on you');
      expect(first).toContain('propose_decide');
      expect(first).toContain('gbrain propose decline waiting_on_you');
      for (const leak of sentenceLeaks) expect(first).not.toContain(leak);
      expect(Buffer.byteLength(first, 'utf8')).toBeLessThan(2048);

      const d = await setProposalDecision(engine, { signal: 'waiting_on_you', decision: 'declined', by: 'cli', now: NOW });
      expect(d).toMatchObject({ verified: true, decision: 'declined' });
      const stored = JSON.parse((await engine.getConfig(FIRST_SESSION_KEY))!);
      expect(stored.proposals.waiting_on_you).toMatchObject({ decision: 'declined', by: 'cli' });
      const second = await section('s-2');
      expect(second).not.toContain('waiting on you');
      expect(second).toContain('gbrain propose decline owe_reply');

      const r = await proposeJobs(engine, { days: 7, now: NOW, resolver: { home } });
      expect(r.jobs.find(j => j.signal === 'waiting_on_you')!.decision).toBe('declined');
    });

    test('a job line that would push the section past its byte budget is left out, and the section still shows', async () => {
      await freshInstall();
      await engine.executeRaw(`UPDATE sources SET last_sync_at = now() WHERE id = 'mail'`, []);
      await refreshProposalCache(engine, { now: NOW });
      const slugs = [0, 1, 2].map(i => `notes/${'x'.repeat(52)}-${i}`);
      for (const [i, s] of slugs.entries()) await page(engine, s, { type: 'note', title: '漢字'.repeat(40) + i }, '# Note');
      try {
        const text = await section('s-multibyte');
        expect(text).toContain('Recent pages in the brain');
        expect(text).not.toContain('propose_decide');
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);
      } finally {
        for (const s of slugs) await engine.executeRaw('DELETE FROM pages WHERE slug = $1', [s]);
      }
    });

    test('the off switch stops the job line with the section', async () => {
      await freshInstall();
      const { stopFirstSession } = await import('../src/core/onboard/first-session.ts');
      await stopFirstSession(engine, { by: 'cli', now: NOW });
      const out = await firstSessionSectionFor(engine, { sourceId: 'default', sessionId: 's-off', harness: 'claude-code', lane: 'owner', now: NOW });
      expect(out).toEqual({ reason: 'stopped' });
    });
  });
});
