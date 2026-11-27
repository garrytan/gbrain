/**
 * Ideas: submission (slug, frontmatter, body), duplicate detection with Slack
 * support, status sync from initiatives, Slack intake triage and discussion
 * idempotency. PGLite in-memory; embeddings, search and chat are injected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import type { InitiativesConfig } from '../src/core/initiatives/model.ts';
import { localContext, readPage, updatePage, writePage } from '../src/core/initiatives/store.ts';
import { resolveIdea, submitIdea, type IdeasDeps, type SimilarSearchHit } from '../src/core/initiatives/ideas.ts';
import { loadOperation } from '../src/core/operation-load.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { appendIdeaDiscussion, formatSimilarReply, handleIntakeMessage } from '../src/core/initiatives/intake.ts';
import { runIdeasPhase, type IdeaStatusNotice } from '../src/core/initiatives/ideas-phase.ts';

const cfg: InitiativesConfig = {
  sourceId: 'default', ideasPrefix: 'ideas/', initiativesPrefix: 'initiatives/', newProjectPrefix: 'projects/',
  slackLeaveOnFinish: true, mergeAutoApply: false, similarThreshold: 0.85, duplicateThreshold: 0.92, maxPerCycle: 50,
};
const NOW = () => new Date('2026-11-20T10:00:00Z');

/** Search returns whatever `hits` holds (filtered by requested types); embed is a dummy vector. */
function fakeDeps(hits: SimilarSearchHit[], chat?: IdeasDeps['chat']): IdeasDeps {
  return {
    embed: async () => new Float32Array([1, 0, 0]),
    search: async (_v, o) => hits.filter(h => !o.types || o.types.includes(h.type)),
    now: NOW,
    ...(chat ? { chat } : {}),
  };
}
const noAi: IdeasDeps = { embed: async () => null, chat: async () => null, now: NOW };

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  _resetWriteThroughCacheForTest();
});

async function seed(slug: string, type: string, title: string, frontmatter: Record<string, unknown>, body = 'Body.\n'): Promise<void> {
  await writePage(localContext(engine, 'default'), { sourceId: 'default', slug, type, title, frontmatter, body });
}

describe('submitIdea', () => {
  test('creates an idea page with slug, frontmatter and body sections', async () => {
    const ctx = localContext(engine, 'default');
    const r = await submitIdea(ctx, cfg, { title: 'Dark mode for the dashboard', text: 'We should add dark mode.\nEyes hurt at night.',
      problem: 'Bright UI at night', proposal: 'A dark theme toggle', author: 'alice-example', related: ['projects/dashboard'] }, noAi);
    expect(r.status).toBe('created');
    expect(r.slug).toBe('ideas/dark-mode-for-the-dashboard');
    const page = (await readPage(engine, 'default', r.slug!))!;
    expect(page.type).toBe('idea');
    expect(page.title).toBe('Dark mode for the dashboard');
    expect(page.frontmatter.status).toBe('open');
    expect(page.frontmatter.author).toBe('alice-example');
    expect(page.frontmatter.created).toBe('2026-11-20');
    expect(page.frontmatter.related).toEqual(['projects/dashboard']);
    expect(page.frontmatter.similar).toEqual([]);
    expect(page.body).toContain('## Problem\n\nBright UI at night');
    expect(page.body).toContain('## Proposal\n\nA dark theme toggle');
    expect(page.body).toContain('## Original\n\n> We should add dark mode.\n> Eyes hurt at night.');

    const again = await submitIdea(ctx, cfg, { title: 'Dark mode for the dashboard', text: 'Another one' }, noAi);
    expect(again.slug).toBe('ideas/dark-mode-for-the-dashboard-2');

    const dry = await submitIdea(ctx, cfg, { title: 'Something new', text: 'x', dryRun: true }, noAi);
    expect(dry.status).toBe('dry_run');
    expect(await readPage(engine, 'default', 'ideas/something-new')).toBeNull();
  });

  test('similar ideas link both ways; a near-identical idea is a duplicate and Slack support bumps votes', async () => {
    const ctx = localContext(engine, 'default');
    await seed('ideas/faster-search', 'idea', 'Faster search', { status: 'open', similar: [] });
    await seed('initiatives/search-v2', 'initiative', 'Search v2', { status: 'active' });

    const similar = fakeDeps([
      { slug: 'ideas/faster-search', title: 'Faster search', type: 'idea', score: 0.88 },
      { slug: 'initiatives/search-v2', title: 'Search v2', type: 'initiative', score: 0.86 },
      { slug: 'projects/search', title: 'Search', type: 'project', score: 0.8 },
    ]);
    const r = await submitIdea(ctx, cfg, { title: 'Search cache', text: 'Cache search results' }, similar);
    expect(r.status).toBe('created');
    expect((await readPage(engine, 'default', r.slug!))!.frontmatter.similar).toEqual(['ideas/faster-search', 'initiatives/search-v2']);
    expect((await readPage(engine, 'default', 'ideas/faster-search'))!.frontmatter.similar).toEqual([r.slug]);
    expect(r.similar.initiatives[0]!.status).toBe('active');
    const reply = formatSimilarReply(r);
    expect(reply).toContain('Recorded as idea `ideas/search-cache`');
    expect(reply).toContain('*Similar ideas*');
    expect(reply).toContain('*Initiatives in progress*');
    expect(reply).toContain('*Existing pages*');

    const dup = fakeDeps([{ slug: 'ideas/faster-search', title: 'Faster search', type: 'idea', score: 0.95 }]);
    const slack = { channel: 'C0123456', ts: '1763632800.000100', permalink: 'https://example.slack.com/p1' };
    const d = await submitIdea(ctx, cfg, { text: 'make search faster please', author: 'bob-example', slack }, dup);
    expect(d.status).toBe('duplicate');
    expect(d.duplicateOf?.slug).toBe('ideas/faster-search');
    let target = (await readPage(engine, 'default', 'ideas/faster-search'))!;
    expect(target.frontmatter.votes).toBe(1);
    expect(target.body).toContain('## Support');
    expect(target.body).toContain('**bob-example**');
    // The same Slack message again: no second vote.
    await submitIdea(ctx, cfg, { text: 'make search faster please', author: 'bob-example', slack }, dup);
    target = (await readPage(engine, 'default', 'ideas/faster-search'))!;
    expect(target.frontmatter.votes).toBe(1);
    // allowDuplicate creates anyway.
    const forced = await submitIdea(ctx, cfg, { title: 'Faster search again', text: 'x', allowDuplicate: true }, dup);
    expect(forced.status).toBe('created');
  });
});

describe('runIdeasPhase status sync', () => {
  test('active → planned, done → implemented, cancelled → open; human rejection stands until done; Slack notices once', async () => {
    await seed('ideas/a', 'idea', 'Idea A', { status: 'open', slack_channel: 'C0123456', slack_ts: '1.1' });
    await seed('ideas/b', 'idea', 'Idea B', { status: 'open' });
    await seed('ideas/c', 'idea', 'Idea C', { status: 'planned' });
    await seed('ideas/d', 'idea', 'Idea D', { status: 'rejected' });
    await seed('ideas/e', 'idea', 'Idea E', { status: 'rejected' });
    await seed('initiatives/one', 'initiative', 'One', { status: 'active', implements: ['ideas/a', 'd'] });
    await seed('initiatives/two', 'initiative', 'Two', { status: 'done', implements: ['[[b]]', 'e'] });
    await seed('initiatives/three', 'initiative', 'Three', { status: 'cancelled', implements: ['ideas/c'] });

    const notices: IdeaStatusNotice[] = [];
    const notify = async (n: IdeaStatusNotice) => { notices.push(n); };
    const dry = await runIdeasPhase(engine, { dryRun: true, notify, config: cfg, deps: noAi });
    expect(dry.details.status_changed).toBe(4);
    expect(notices).toHaveLength(0);
    expect((await readPage(engine, 'default', 'ideas/a'))!.frontmatter.status).toBe('open');

    const res = await runIdeasPhase(engine, { notify, config: cfg, deps: noAi });
    expect(res.phase).toBe('ideas');
    expect(res.details.status_changed).toBe(4);
    const fm = async (s: string) => (await readPage(engine, 'default', s))!.frontmatter;
    expect((await fm('ideas/a')).status).toBe('planned');
    expect((await fm('ideas/a')).status_notified).toBe('planned');
    expect((await fm('ideas/b')).status).toBe('implemented');
    expect((await fm('ideas/b')).implemented_by).toBe('initiatives/two');
    expect((await fm('ideas/c')).status).toBe('open');
    expect((await fm('ideas/d')).status).toBe('rejected');
    expect((await fm('ideas/e')).status).toBe('implemented');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ ideaSlug: 'ideas/a', channel: 'C0123456', ts: '1.1', status: 'planned', initiativeSlug: 'initiatives/one' });

    const again = await runIdeasPhase(engine, { notify, config: cfg, deps: noAi });
    expect(again.details.status_changed).toBe(0);
    expect(notices).toHaveLength(1);
  });

  test('clustering merges similar hits once per substance change', async () => {
    await seed('ideas/x', 'idea', 'Idea X', { status: 'open' });
    await seed('ideas/y', 'idea', 'Idea Y', { status: 'open', similar_checked_hash: 'stale' });
    const deps = fakeDeps([
      { slug: 'ideas/x', title: 'Idea X', type: 'idea', score: 0.9 },
      { slug: 'ideas/y', title: 'Idea Y', type: 'idea', score: 0.9 },
    ]);
    const r1 = await runIdeasPhase(engine, { config: cfg, deps });
    expect(r1.details.clustered).toBe(2);
    expect((await readPage(engine, 'default', 'ideas/x'))!.frontmatter.similar).toEqual(['ideas/y']);
    expect((await readPage(engine, 'default', 'ideas/y'))!.frontmatter.similar).toEqual(['ideas/x']);
    const r2 = await runIdeasPhase(engine, { config: cfg, deps });
    expect(r2.details.clustered).toBe(0);
  });
});

describe('intake', () => {
  test('chit-chat, acks, non-ideas and secrets are skipped; an idea is created once', async () => {
    let calls = 0;
    const chat: IdeasDeps['chat'] = async (req) => {
      calls++;
      return req.user.includes('lunch')
        ? '{"is_idea":false,"title":null,"problem":null,"proposal":null}'
        : '{"is_idea":true,"title":"Weekly demo day","problem":"Nobody sees finished work","proposal":"Demo every Friday"}';
    };
    const deps = fakeDeps([], chat);
    const base = { channel: 'C0123456', user: 'U1', userName: 'carol-example' };
    expect(await handleIntakeMessage(engine, cfg, { ...base, ts: '1.0', text: 'thanks!' }, deps)).toEqual({ kind: 'skipped', reason: 'trivial' });
    expect(await handleIntakeMessage(engine, cfg, { ...base, ts: '1.1', text: 'anyone up for lunch at noon today?' }, deps)).toEqual({ kind: 'skipped', reason: 'not_idea' });
    expect(await handleIntakeMessage(engine, cfg, { ...base, ts: '1.2', text: 'here is the key ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the demo' }, deps))
      .toEqual({ kind: 'skipped', reason: 'secret_like' });
    expect(calls).toBe(1);

    const out = await handleIntakeMessage(engine, cfg, { ...base, ts: '1763632800.000200', text: 'We could hold a demo day every Friday so people see finished work' }, deps);
    expect(out.kind).toBe('idea');
    if (out.kind !== 'idea') throw new Error('unreachable');
    expect(out.slug).toBe('ideas/weekly-demo-day');
    expect(out.reply).toContain('ideas/weekly-demo-day');
    const page = (await readPage(engine, 'default', out.slug))!;
    expect(page.frontmatter).toMatchObject({ author: 'carol-example', slack_channel: 'C0123456', slack_ts: '1763632800.000200' });
    expect(page.body).toContain('## Proposal\n\nDemo every Friday');
    expect(await handleIntakeMessage(engine, cfg, { ...base, ts: '1763632800.000200', text: 'We could hold a demo day every Friday so people see finished work' }, deps))
      .toEqual({ kind: 'skipped', reason: 'already_recorded' });
  });

  test('without a chat provider every non-trivial message is an idea titled by its first line', async () => {
    const out = await handleIntakeMessage(engine, cfg, { channel: 'C0123456', ts: '2.0', text: 'Automate the release notes\nfrom merged PR titles' }, noAi);
    expect(out).toMatchObject({ kind: 'idea', status: 'created', slug: 'ideas/automate-the-release-notes' });
  });

  test('discussion rewrite is idempotent', async () => {
    await seed('ideas/z', 'idea', 'Idea Z', { status: 'open' }, '## Original\n\n> z\n');
    const replies = [
      { userName: 'dave-example', text: 'second', ts: '1763632900.000000' },
      { userName: 'erin-example', text: 'first', ts: '1763632800.000000' },
    ];
    await appendIdeaDiscussion(engine, cfg, 'ideas/z', replies);
    const p1 = (await readPage(engine, 'default', 'ideas/z'))!;
    expect(p1.body).toContain('## Discussion');
    expect(p1.body.indexOf('first')).toBeLessThan(p1.body.indexOf('second'));
    await appendIdeaDiscussion(engine, cfg, 'ideas/z', replies);
    const p2 = (await readPage(engine, 'default', 'ideas/z'))!;
    expect(p2.revision).toBe(p1.revision);
    expect(p2.body).toBe(p1.body);
    await appendIdeaDiscussion(engine, cfg, 'ideas/z', [...replies, { userName: 'frank-example', text: 'third', ts: '1763633000.000000' }]);
    const p3 = (await readPage(engine, 'default', 'ideas/z'))!;
    expect(p3.body).toContain('third');
    expect(p3.body.match(/## Discussion/g)).toHaveLength(1);
  });
});

describe('idea resolution (idea_resolve)', () => {
  const at = () => new Date('2026-11-27T09:00:00Z');

  test('records who, when and why; keeps a history; refuses implemented ideas and unknown statuses', async () => {
    const ctx = localContext(engine, 'default');
    await seed('ideas/csv', 'idea', 'CSV export', { status: 'open' }, '## Proposal\n\nExport CSV.\n');
    const r = await resolveIdea(ctx, cfg, 'ideas/csv', { status: 'rejected', by: 'alice-example', reason: 'Covered by the PDF report' }, { now: at });
    expect(r).toMatchObject({ slug: 'ideas/csv', status: 'rejected', previous_status: 'open', dry_run: false });
    let page = (await readPage(engine, 'default', 'ideas/csv'))!;
    expect(page.frontmatter.status).toBe('rejected');
    expect(page.frontmatter.resolution).toEqual({ status: 'rejected', by: 'alice-example', at: '2026-11-27T09:00:00.000Z', reason: 'Covered by the PDF report' });
    expect(page.body).toContain('## Resolution');
    expect(page.body).toContain('- 2026-11-27 **rejected** by alice-example: Covered by the PDF report');

    await resolveIdea(ctx, cfg, 'ideas/csv', { status: 'open', by: 'bob-example' }, { now: at });
    page = (await readPage(engine, 'default', 'ideas/csv'))!;
    expect(page.frontmatter.status).toBe('open');
    expect((page.frontmatter.resolutions as unknown[]).length).toBe(2);
    expect(page.body).toContain('**reopened** by bob-example');

    const dry = await resolveIdea(ctx, cfg, 'ideas/csv', { status: 'accepted', by: 'x', dryRun: true }, { now: at });
    expect(dry.dry_run).toBe(true);
    expect((await readPage(engine, 'default', 'ideas/csv'))!.frontmatter.status).toBe('open');

    await seed('ideas/shipped', 'idea', 'Shipped', { status: 'implemented', implemented_by: 'initiatives/x' });
    await expect(resolveIdea(ctx, cfg, 'ideas/shipped', { status: 'rejected', by: 'x' })).rejects.toMatchObject({ code: 'idea_implemented' });
    await expect(resolveIdea(ctx, cfg, 'ideas/csv', { status: 'planned' as never, by: 'x' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(resolveIdea(ctx, cfg, 'ideas/nope', { status: 'rejected', by: 'x' })).rejects.toMatchObject({ code: 'idea_not_found' });

    // accepted while an initiative works on it: stays planned, the resolution is kept.
    await seed('ideas/busy', 'idea', 'Busy', { status: 'planned' });
    const busy = await resolveIdea(ctx, cfg, 'ideas/busy', { status: 'accepted', by: 'x' }, { now: at });
    expect(busy.status).toBe('planned');
    expect((await readPage(engine, 'default', 'ideas/busy'))!.frontmatter.resolution).toMatchObject({ status: 'accepted' });
  });

  test('the op records the caller (agent label) as resolver', async () => {
    await seed('ideas/op-idea', 'idea', 'Op idea', { status: 'open' });
    const op = await loadOperation('idea_resolve');
    const ctx = { ...localContext(engine, 'default'), agentLabel: 'carol-example' } as OperationContext;
    const r = await op!.handler(ctx, { slug: 'op-idea', status: 'accepted', reason: 'Fits the Q1 roadmap' }) as Record<string, any>;
    expect(r.resolution).toMatchObject({ status: 'accepted', by: 'carol-example', reason: 'Fits the Q1 roadmap' });
    const list = await (await loadOperation('initiatives_list'))!.handler(localContext(engine, 'default'), { kind: 'idea' }) as Record<string, any>;
    expect(list.items[0]).toMatchObject({ slug: 'ideas/op-idea', status: 'accepted', resolution: { by: 'carol-example' } });
  });

  test('a duplicate is recorded as support (also without Slack) and the reply tells its resolution; similar ideas show theirs', async () => {
    const ctx = localContext(engine, 'default');
    await seed('ideas/dark-mode', 'idea', 'Dark mode', { status: 'open' });
    await resolveIdea(ctx, cfg, 'ideas/dark-mode', { status: 'rejected', by: 'alice-example', reason: 'Not for this year' }, { now: at });

    const dup = fakeDeps([{ slug: 'ideas/dark-mode', title: 'Dark mode', type: 'idea', score: 0.96 }]);
    const d = await submitIdea(ctx, cfg, { text: 'please add a dark theme', author: 'dave-example' }, dup);
    expect(d).toMatchObject({ status: 'duplicate', support_added: true });
    expect(d.duplicateOf?.resolution).toMatchObject({ status: 'rejected', by: 'alice-example', reason: 'Not for this year' });
    expect((await readPage(engine, 'default', 'ideas/dark-mode'))!.frontmatter.votes).toBe(1);
    const again = await submitIdea(ctx, cfg, { text: 'please add a dark theme', author: 'dave-example' }, dup);
    expect(again.support_added).toBe(false);
    expect((await readPage(engine, 'default', 'ideas/dark-mode'))!.frontmatter.votes).toBe(1);
    const reply = formatSimilarReply(d);
    expect(reply).toContain('This looks like an existing idea: *Dark mode* (`ideas/dark-mode`, rejected). It was rejected by alice-example (2026-11-27). Reason: Not for this year. I added your message as support.');

    const near = fakeDeps([{ slug: 'ideas/dark-mode', title: 'Dark mode', type: 'idea', score: 0.88 }]);
    const n = await submitIdea(ctx, cfg, { title: 'Night theme', text: 'night theme for the viewer', author: 'erin-example' }, near);
    expect(n.status).toBe('created');
    expect(formatSimilarReply(n)).toContain('• Dark mode (`ideas/dark-mode`, rejected) — rejected by alice-example (2026-11-27). Reason: Not for this year');
  });

  test('the ideas phase keeps manual resolutions, returns cancelled work to accepted, and tells Slack once', async () => {
    const ctx = localContext(engine, 'default');
    await seed('ideas/r', 'idea', 'Rejected one', { status: 'open', slack_channel: 'C0123456', slack_ts: '2.1' });
    await seed('ideas/acc', 'idea', 'Accepted one', { status: 'open' });
    await resolveIdea(ctx, cfg, 'ideas/r', { status: 'rejected', by: 'alice-example', reason: 'Duplicate of billing work' }, { now: at });
    await resolveIdea(ctx, cfg, 'ideas/acc', { status: 'accepted', by: 'bob-example' }, { now: at });
    await seed('initiatives/live', 'initiative', 'Live', { status: 'active', implements: ['ideas/r', 'ideas/acc'] });

    const notices: IdeaStatusNotice[] = [];
    const notify = async (n: IdeaStatusNotice) => { notices.push(n); };
    await runIdeasPhase(engine, { notify, config: cfg, deps: noAi });
    const fm = async (s: string) => (await readPage(engine, 'default', s))!.frontmatter;
    expect((await fm('ideas/r')).status).toBe('rejected');
    expect((await fm('ideas/acc')).status).toBe('planned');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ ideaSlug: 'ideas/r', status: 'rejected' });
    expect(notices[0]!.text).toBe('The idea *Rejected one* was rejected by alice-example (2026-11-27). Reason: Duplicate of billing work');

    await runIdeasPhase(engine, { notify, config: cfg, deps: noAi });
    expect(notices).toHaveLength(1);

    await updatePage(ctx, 'default', 'initiatives/live', p => ({ frontmatter: { ...p.frontmatter, status: 'cancelled' } }));
    await runIdeasPhase(engine, { notify, config: cfg, deps: noAi });
    expect((await fm('ideas/acc')).status).toBe('accepted');
  });
});
