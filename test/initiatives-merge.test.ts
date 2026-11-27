/**
 * Finishing an initiative and merging it into its targets: plan validation,
 * plan storage on the page, apply (facts, new project page, timeline), the
 * finish preconditions and dry runs, and the finish job's Slack release.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadOperation } from '../src/core/operation-load.ts';
import type { InitiativesConfig } from '../src/core/initiatives/model.ts';
import { localContext, readPage, writePage } from '../src/core/initiatives/store.ts';
import { applyMerge, planMerge, readMergePlan, writeMergePlan, type ChatFn } from '../src/core/initiatives/merge.ts';
import { finishInitiative } from '../src/core/initiatives/finish.ts';
import { makeInitiativeFinishHandler } from '../src/core/minions/handlers/initiative-finish.ts';

const SRC = 'default';
const cfg: InitiativesConfig = {
  sourceId: SRC, ideasPrefix: 'ideas/', initiativesPrefix: 'initiatives/', newProjectPrefix: 'projects/',
  slackLeaveOnFinish: true, mergeAutoApply: false, similarThreshold: 0.85, duplicateThreshold: 0.92, maxPerCycle: 200,
};

let engine: PGLiteEngine;
const ctx = () => localContext(engine, SRC);

async function page(slug: string, type: string, title: string, frontmatter: Record<string, unknown>, body: string) {
  await writePage(ctx(), { sourceId: SRC, slug, type, title, frontmatter, body });
}

async function remember(entity: string, fact: string) {
  const op = await loadOperation('remember');
  await op!.handler(ctx(), { fact, entity, provenance: 'test seed', source_id: SRC, infer_entity: false });
}

async function liveFacts(slug: string) {
  return engine.executeRaw<{ id: number; fact: string }>(
    `SELECT id, fact FROM facts WHERE source_id = $1 AND entity_slug = $2 AND expired_at IS NULL ORDER BY id`, [SRC, slug]);
}

let alphaFacts: Array<{ id: number; fact: string }> = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await page('projects/alpha', 'project', 'Alpha', {}, 'Alpha is the export service.');
  await page('initiatives/beta-launch', 'initiative', 'Beta launch', {
    status: 'active', targets: ['projects/alpha', 'gamma'], tracker: 'ENG-1', slack_channels: ['C0123ABCD'],
  }, 'Requirements: Alpha exports CSV and PDF. A new Gamma dashboard shows exports.');
  await page('initiatives/old-thing', 'initiative', 'Old thing', { status: 'done', targets: [] }, 'Done already.');
  await remember('projects/alpha', 'Alpha exports CSV files only.');
  await remember('projects/alpha', 'Alpha runs nightly at 02:00.');
  await remember('initiatives/beta-launch', 'The team shipped PDF export in Alpha.');
  alphaFacts = await liveFacts('projects/alpha');
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

function fakeChat(reply: unknown): ChatFn {
  return async () => ({ text: JSON.stringify(reply), stopReason: 'end', model: 'test:model' });
}

function goodReply() {
  return {
    items: [
      { action: 'replace', target: 'projects/alpha', fact: 'Alpha exports CSV and PDF files.', replaces_fact_id: alphaFacts[0].id, reason: 'PDF shipped' },
      { action: 'add', target: 'projects/gamma', fact: 'Gamma is a dashboard of Alpha exports.', reason: 'new project' },
      { action: 'replace', target: 'projects/alpha', fact: 'bogus', replaces_fact_id: 999999, reason: 'bad id' },
      { action: 'add', target: 'projects/nope', fact: 'Nope', reason: 'unknown target' },
      { action: 'skip', target: 'initiatives/beta-launch', fact: 'Standup moved to 10am', reason: 'chatter' },
    ],
    new_projects: [{ slug: 'projects/gamma', title: 'Gamma', body: '## Overview\n\nGamma shows Alpha exports.' }],
  };
}

describe('planMerge', () => {
  test('validates the model answer: unknown targets and fact ids are dropped with a reason', async () => {
    const plan = await planMerge(engine, cfg, 'initiatives/beta-launch', { chat: fakeChat(goodReply()) });
    expect(plan.items.map(i => i.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(plan.items[0]).toMatchObject({ action: 'replace', target: 'projects/alpha', replaces_fact_id: alphaFacts[0].id });
    expect(plan.items[1]).toMatchObject({ action: 'add', target: 'projects/gamma', new_target: true });
    expect(plan.items[2].action).toBe('skip');
    expect(plan.items[2].reason).toContain('unknown fact id 999999');
    expect(plan.items[3].action).toBe('skip');
    expect(plan.items[3].reason).toContain('unknown target');
    expect(plan.items[4]).toMatchObject({ action: 'skip', reason: 'chatter' });
    expect(plan.new_projects).toEqual([{ slug: 'projects/gamma', title: 'Gamma', body: '## Overview\n\nGamma shows Alpha exports.' }]);
    expect(plan.model).toBe('test:model');
  });

  test('an unreadable answer is refused', async () => {
    await expect(planMerge(engine, cfg, 'initiatives/beta-launch', { chat: async () => ({ text: 'no json here', stopReason: 'end' }) }))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  test('no targets: the initiative itself becomes a new project', async () => {
    const plan = await planMerge(engine, cfg, 'initiatives/old-thing', { chat: fakeChat({ items: [], new_projects: [] }) });
    expect(plan.new_projects.map(p => p.slug)).toEqual(['projects/old-thing']);
  });
});

describe('finishInitiative', () => {
  test('refuses a missing or non-active initiative', async () => {
    await expect(finishInitiative(ctx(), cfg, 'initiatives/missing', { outcome: 'done' })).rejects.toMatchObject({ code: 'initiative_not_found' });
    await expect(finishInitiative(ctx(), cfg, 'initiatives/old-thing', { outcome: 'done' })).rejects.toMatchObject({ code: 'initiative_not_active' });
  });

  test('dry run lists the steps and writes nothing', async () => {
    const before = await readPage(engine, SRC, 'initiatives/beta-launch');
    const r = await finishInitiative(ctx(), cfg, 'initiatives/beta-launch', { outcome: 'done', dryRun: true });
    expect(r.status).toBe('dry_run');
    expect(r.channels).toEqual(['C0123ABCD']);
    expect(r.steps.length).toBeGreaterThan(2);
    const after = await readPage(engine, SRC, 'initiatives/beta-launch');
    expect(after!.revision).toBe(before!.revision);
    const jobs = await engine.executeRaw(`SELECT id FROM minion_jobs WHERE name = 'initiative_finish'`);
    expect(jobs.length).toBe(0);
  });

  test('applyMerge refuses an initiative that is not done', async () => {
    await expect(applyMerge(ctx(), cfg, 'initiatives/beta-launch')).rejects.toMatchObject({ code: 'initiative_not_done' });
  });

  test('finishing sets the status and queues the finish job', async () => {
    const r = await finishInitiative(ctx(), cfg, 'initiatives/beta-launch', { outcome: 'done', note: 'shipped' });
    expect(r.status).toBe('queued');
    expect(typeof r.job_id).toBe('number');
    const p = await readPage(engine, SRC, 'initiatives/beta-launch');
    expect(p!.frontmatter).toMatchObject({ status: 'done', finish_note: 'shipped' });
    expect(typeof p!.frontmatter.finished_at).toBe('string');
    const [job] = await engine.executeRaw<{ name: string; idempotency_key: string; max_attempts: number }>(
      `SELECT name, idempotency_key, max_attempts FROM minion_jobs WHERE id = $1`, [r.job_id]);
    expect(job).toMatchObject({ name: 'initiative_finish', idempotency_key: 'initiative_finish:default:initiatives/beta-launch', max_attempts: 3 });
  });
});

describe('merge plan on the page + apply', () => {
  test('writeMergePlan stores a readable plan that reads back', async () => {
    const plan = await planMerge(engine, cfg, 'initiatives/beta-launch', { chat: fakeChat(goodReply()) });
    await writeMergePlan(ctx(), cfg, 'initiatives/beta-launch', plan);
    const p = await readPage(engine, SRC, 'initiatives/beta-launch');
    expect(p!.frontmatter.merge_status).toBe('proposed');
    expect(p!.body).toContain('## Merge plan');
    expect(p!.body).toContain('Requirements: Alpha exports CSV and PDF.');
    const back = readMergePlan(p!.body);
    expect(back!.items).toEqual(plan.items);
    expect(back!.new_projects).toEqual(plan.new_projects);
    // A second write replaces the section rather than appending a second one.
    await writeMergePlan(ctx(), cfg, 'initiatives/beta-launch', plan);
    const again = await readPage(engine, SRC, 'initiatives/beta-launch');
    expect(again!.body.split('## Merge plan').length).toBe(2);
  });

  test('dry run computes the result and writes nothing', async () => {
    const r = await applyMerge(ctx(), cfg, 'initiatives/beta-launch', { dryRun: true });
    expect(r).toMatchObject({ dry_run: true, applied: 2, skipped: 3, created_pages: ['projects/gamma'] });
    expect(r.touched.sort()).toEqual(['projects/alpha', 'projects/gamma']);
    expect(await readPage(engine, SRC, 'projects/gamma')).toBeNull();
    expect((await liveFacts('projects/alpha')).map(f => f.fact)).toEqual(alphaFacts.map(f => f.fact));
  });

  test('apply creates the new project, replaces and adds facts, writes timeline entries', async () => {
    const r = await applyMerge(ctx(), cfg, 'initiatives/beta-launch');
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ dry_run: false, applied: 2, created_pages: ['projects/gamma'] });
    const gamma = await readPage(engine, SRC, 'projects/gamma');
    expect(gamma!.type).toBe('project');
    expect(gamma!.frontmatter.created_by).toEqual(['initiatives/beta-launch']);
    const alpha = (await liveFacts('projects/alpha')).map(f => f.fact);
    expect(alpha).toContain('Alpha exports CSV and PDF files.');
    expect(alpha).not.toContain('Alpha exports CSV files only.');
    expect(alpha).toContain('Alpha runs nightly at 02:00.');
    expect((await liveFacts('projects/gamma')).map(f => f.fact)).toEqual(['Gamma is a dashboard of Alpha exports.']);
    const tl = await engine.executeRaw<{ summary: string; detail: string }>(
      `SELECT t.summary, t.detail FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1 AND p.slug = $2`, [SRC, 'projects/alpha']);
    expect(tl.some(t => t.summary === 'Changed by initiative Beta launch' && t.detail.includes('[[initiatives/beta-launch]]'))).toBe(true);
    const init = await readPage(engine, SRC, 'initiatives/beta-launch');
    expect(init!.frontmatter.merge_status).toBe('applied');
    expect(typeof init!.frontmatter.merged_at).toBe('string');
  });
});

describe('initiative_finish job', () => {
  test('posts, leaves (ignoring not_in_channel) and releases the channels; cancelled merges nothing', async () => {
    await page('initiatives/delta', 'initiative', 'Delta', { status: 'cancelled', slack_channels: ['C0999ZZZZ', 'C0888YYYY'] }, 'Delta.');
    const posted: string[] = [];
    const left: string[] = [];
    const handler = makeInitiativeFinishHandler(engine, {
      slack: () => ({
        postMessage: async (m) => { posted.push(m.channel); return { channel: m.channel, ts: '1' }; },
        leaveChannel: async (c) => { if (c === 'C0888YYYY') throw Object.assign(new Error('not_in_channel'), { code: 'not_in_channel' }); left.push(c); },
      }),
      chat: async () => { throw new Error('chat must not run for a cancelled initiative'); },
    });
    const ac = new AbortController();
    const result = await handler({
      id: 1, name: 'initiative_finish', data: { sourceId: SRC, slug: 'initiatives/delta', outcome: 'cancelled' }, attempts_made: 0,
      idempotency_key: null, signal: ac.signal, shutdownSignal: ac.signal, deadlineAtMs: null, updateProgress: async () => {},
    } as never) as { steps: Array<{ step: string; ok: boolean }> };
    expect(posted).toEqual(['C0999ZZZZ', 'C0888YYYY']);
    expect(left).toEqual(['C0999ZZZZ']);
    expect(result.steps.every(s => s.ok)).toBe(true);
    const p = await readPage(engine, SRC, 'initiatives/delta');
    expect(typeof p!.frontmatter.slack_released_at).toBe('string');
    expect(p!.frontmatter.merge_status).toBeUndefined();
  });
});
