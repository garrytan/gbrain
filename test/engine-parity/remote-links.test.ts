/**
 * Engine parity for the remote mention-links effect (persistence/effect-links.ts `runLinksEffect`) and a finished
 * batch's links re-arm (persistence/effect-journal.ts `reconcileFinishedBatch`, `queueLinksReconcile`), end to end
 * through the MCP dispatcher: a remote put_page, alone or as a put_pages batch, over stdio and over http, and a remote
 * capture over stdio. Also the facts backstop effect's two extraction reads (engine-sql/facts-backstop.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through harness.ts) a remote
 *    write is admitted, commits the page, and its links effect commits plain `mentions` edges (link_source
 *    `mcp-remote-mention`) to the existing, visible pages its body names, and to no missing page. The same edges and the
 *    same effect outcome on every arm, over both transports, for one page and for a batch.
 *  - Regression: the effect's reads (the stored request, the writer's live slug grant, the effect claim, the target
 *    pages and the edges it owns), its edge delete and the batch re-arm ran through executeRaw, and a remote write was
 *    refused at admission on the Rust engine (rust-engine/errors.ts `requireRawSqlPublication`). Fail-first: with that
 *    gate removed and the sites still raw, the Rust arm commits the stdio put_page with no mention edge (its links effect
 *    refuses raw_sql) and never publishes the stdio put_pages batch (the batch re-arm refuses raw_sql); 0 of 4 pass.
 *  - HTTP on Rust: the store keeps OAuth clients and serves the write grant, so an http write is admitted on every arm.
 *    The facts backstop effect the same writes queue (persistence/effect-facts.ts) also read through executeRaw; with
 *    the links sites typed and those still raw, the Rust stdio cases committed the right edges but caught 4 and 7
 *    raw_sql refusals (effect-facts.ts dispatchFactsBackstopEffect and the projection rebuild). A remote capture (which
 *    delegates to put_page) reached the same links effect: with effect-links.ts reading its request through executeRaw,
 *    its stdio case committed the page with no mention edge and caught the refusal at effect-links.ts:110.
 *  - Why existing coverage misses it: test/persistence-links-effect.test.ts and its Postgres twin drive the effect on
 *    one SQL engine with raw-SQL fixtures, and never through dispatchToolCall on the Rust engine.
 *  - Seam: none. Real engines, the real dispatcher and the in-process persistence consumer; each case runs under its own
 *    GBRAIN_HOME.
 *
 *  - Every arm, stdio cases included, now catches no raw_sql refusal on the way: the consumer's projection rebuild
 *    (persistence/projections.ts rebuildPendingPageProjections -> selectWindowJobs) reads through typed members, so the
 *    pages, the edges and an empty refusal list are compared on all three arms. Fail-first: with selectWindowJobs back on
 *    executeRaw, the Rust stdio cases catch its raw_sql refusal and fail on the empty refusal list.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { parityArms, restrictFolder } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';

const { parityTest } = parityArms(testBackends());

const CLIENT = 'parity-links-client';
const MENTION = 'mcp-remote-mention';
const BATCH = { stdio: 'd0000000-0000-4000-8000-0000000000f1', http: 'd0000000-0000-4000-8000-0000000000f2' } as const;
const body = (i: number) => `---\ntype: note\ntitle: Remote links ${i}\n---\n\nMet [[people/alice-example]] of [[companies/acme-example]], and [[people/ghost-example]].\n`;

/** Where each kept raw-SQL refusal came from: the first stack frame below the refusal, for a readable diff. */
function refusalSites(refusals: unknown[]): string[] {
  return refusals.map(error => String((error as Error).stack).split('\n').find(line => /\bat\b/.test(line) && !/rust-engine|errors\.ts/.test(line))?.trim() ?? String(error));
}

/** `engine`, keeping every raw-SQL refusal a call on it (or on a transaction handle it opens) raised, caught or not. */
function keepingRefusals(engine: BrainEngine, refusals: unknown[]): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if ((prop === 'transaction' || prop === 'transactionDirect') && typeof args[0] === 'function') {
          const fn = args[0] as (tx: BrainEngine) => unknown;
          args = [(tx: BrainEngine) => fn(keepingRefusals(tx, refusals)), ...args.slice(1)];
        }
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!(result instanceof Promise)) return result;
        return result.catch((error: unknown) => {
          if (isCapabilityRefusal(error, 'raw_sql')) refusals.push(error);
          throw error;
        });
      };
    },
  });
}

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-links-'));
  try { return await withEnv({ GBRAIN_HOME: home }, run); } finally { rmSync(home, { recursive: true, force: true }); }
}

/** The remote mention edges from `slug`, once its links effect has settled (or the wait ran out). */
async function settledMentions(engine: BrainEngine, slug: string): Promise<string[]> {
  for (let i = 0; i < 300; i++) {
    const mentions = (await engine.getLinks(slug, { sourceId: 'default' })).filter(link => link.link_source === MENTION);
    if (mentions.length >= 2) return mentions.map(link => `${link.link_type}:${link.to_slug}`).sort();
    await Bun.sleep(100);
  }
  return (await engine.getLinks(slug, { sourceId: 'default' })).filter(link => link.link_source === MENTION).map(link => `${link.link_type}:${link.to_slug}`).sort();
}

describe('engine parity: remote mention links', () => {
  const seed = async (engine: BrainEngine) => {
    const page = (slug: string, type: string) => engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `${slug} fixture.`, timeline: '', frontmatter: {} }, { sourceId: 'default' });
    const origin = await page('notes/links-origin', 'note');
    await page('people/alice-example', 'person');
    await page('companies/acme-example', 'company');
    await engine.addLinksBatch([
      ...['people/alice-example', 'companies/acme-example'].map(to => ({ from_slug: 'notes/links-origin', to_slug: to, link_type: 'mentions', context: '',
        link_source: MENTION, link_kind: 'plain', origin_slug: 'notes/links-origin', origin_source_id: 'default' })),
      { from_slug: 'notes/links-origin', to_slug: 'people/alice-example', link_type: 'mentions', context: '', link_source: 'markdown' },
    ]);
    return origin;
  };

  parityTest('the links effect members read, remove and re-arm only the producer\'s own edges', {
    methods: ['addLinksBatch', 'readOwnedLinks', 'deleteOwnedLinks', 'readLinkTargetPages', 'rearmLinksEffects', 'setEffectTransactionLimits', 'transaction'],
  }, async (engine) => {
    const origin = await seed(engine);
    const owned = (await engine.readOwnedLinks(MENTION, origin.id)).sort((a, b) => a.slug.localeCompare(b.slug));
    const targets = (await engine.readLinkTargetPages('default', ['people/ghost-example', 'people/alice-example', 'companies/acme-example'], null))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const alice = owned.find(link => link.slug === 'people/alice-example')!;
    const removed = await engine.transaction(async tx => {
      await tx.setEffectTransactionLimits();
      return { none: await tx.deleteOwnedLinks(origin.id, MENTION, []), wrongSource: await tx.deleteOwnedLinks(origin.id, 'markdown', [alice.id]),
        one: await tx.deleteOwnedLinks(origin.id, MENTION, [alice.id]) };
    });
    return {
      owned: owned.map(link => link.slug), targets, removed,
      left: (await engine.readOwnedLinks(MENTION, origin.id)).map(link => link.slug),
      markdownKept: (await engine.getLinks('notes/links-origin', { sourceId: 'default' })).filter(link => link.link_source === 'markdown').length,
      rearmed: await engine.rearmLinksEffects({ sourceId: 'default', requestIds: ['d0000000-0000-4000-8000-0000000000f9'] }),
      rearmedNone: await engine.rearmLinksEffects({ sourceId: 'default', requestIds: [] }),
    };
  });

  parityTest('readLinkTargetPages judges an empty writer policy like the SQL engines', {
    methods: ['addLinksBatch', 'readLinkTargetPages'],
  }, async (engine) => {
    await seed(engine);
    const policy = { identities: [], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false };
    return (await engine.readLinkTargetPages('default', ['people/alice-example', 'companies/acme-example', 'people/ghost-example'], policy))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  });

  // A writer with no identity reads in a record of its own folder coverage: a page under a prefix the record names is
  // not readable, and a prefix pending only in the store's state does not hide a page from it (the record's coverage is
  // the whole pending test, as coverageSql reads it inside a record). The Rust arm once refused this writer.
  parityTest('readLinkTargetPages judges an empty writer whose record names folder coverage like the SQL engines', {
    methods: ['addLinksBatch', 'readLinkTargetPages'],
  }, async (engine, backend) => {
    await seed(engine);
    await restrictFolder(engine, backend, 'default', 'companies/', 'pending');
    const policy = { identities: [], satisfiedRuleIds: [], folderCoverage: [{ source_id: 'default', prefix: 'people/' }], owner: false, labelledOnly: false };
    const rows = (await engine.readLinkTargetPages('default', ['people/alice-example', 'companies/acme-example', 'notes/links-origin'], policy))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    expect(rows.map(r => `${r.slug}:${r.readable}`)).toEqual(['companies/acme-example:true', 'notes/links-origin:true', 'people/alice-example:false']);
    return rows;
  });

  // readPageHiddenFromWriter: whether some row of a slug, live or soft-deleted, fails the writer's read policy (member access, then the
  // privacy part when `hide`); false when the slug has no row. A write over a slug with no live row is judged on it (page-visibility.ts
  // hiddenUnder), so a soft-deleted page answers the same on every arm: a row that names nobody the writer is hides it, a private tombstone
  // hides only under `hide`.
  parityTest('readPageHiddenFromWriter judges a live, a soft-deleted and an absent page like the SQL engines', {
    methods: ['putPage', 'softDeletePage', 'readPageHiddenFromWriter'],
  }, async (engine) => {
    const put = (slug: string, frontmatter: Record<string, unknown>) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} fixture.`, timeline: '', frontmatter }, { sourceId: 'default' });
    const rows = { 'notes/open': {}, 'notes/names-bob': { readable_by: ['bob-example'] }, 'notes/names-alice': { readable_by: ['alice-example'] }, 'notes/names-carol': { readable_by: ['carol-example'] },
      'notes/private': { visibility: 'private' }, 'notes/private-names-bob': { visibility: 'private', readable_by: ['bob-example'] } } as const;
    for (const [slug, frontmatter] of Object.entries(rows)) { await put(slug, frontmatter); await put(`gone/${slug}`, frontmatter); await engine.softDeletePage(`gone/${slug}`, { sourceId: 'default' }); }
    const policies = {
      bob: { identities: [['member:bob-example']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false },
      carol: { identities: [['member:carol-example']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: true },
      nobody: { identities: [], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false },
      // One identity holding an entry that is not a valid identity: the SQL text empties the whole set, so the writer reads as one with no
      // identity and a row that names readers is hidden from it, though the valid entry beside the bad one names it (mixed-set forwarding).
      mixed: { identities: [['member:bob-example', 'not a valid entry!']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: false },
      'mixed labelled-only': { identities: [['member:carol-example', 'not a valid entry!']], satisfiedRuleIds: [], folderCoverage: [], owner: false, labelledOnly: true },
      // The writer's folder coverage (a pending prefix in its record) hides every row under the prefix from it, labelled-only or not.
      covered: { identities: [['member:bob-example']], satisfiedRuleIds: [], folderCoverage: [{ source_id: 'default', prefix: 'gone/' }], owner: false, labelledOnly: false },
      'covered labelled-only': { identities: [['member:carol-example']], satisfiedRuleIds: [], folderCoverage: [{ source_id: 'default', prefix: 'gone/' }], owner: false, labelledOnly: true },
    };
    const ask = engine;
    const answers: Record<string, boolean> = {};
    for (const [name, policy] of Object.entries(policies)) for (const hide of [true, false]) {
      for (const slug of [...Object.keys(rows), ...Object.keys(rows).map(s => `gone/${s}`), 'notes/absent']) answers[`${name}/${hide ? 'hide' : 'show'}/${slug}`] = await ask.readPageHiddenFromWriter('default', slug, policy, hide);
    }
    // A soft-deleted row that names readers other than the writer hides the slug, an absent slug hides nothing, and a private tombstone hides only under `hide`.
    expect({ goneNamesAlice: answers['bob/hide/gone/notes/names-alice'], goneNamesBob: answers['bob/hide/gone/notes/names-bob'], absent: answers['bob/hide/notes/absent'],
      privateHidden: answers['bob/hide/gone/notes/private'], privateShown: answers['bob/show/gone/notes/private'], goneNamesCarol: answers['carol/hide/gone/notes/names-carol'], goneOpenForCarol: answers['carol/hide/gone/notes/open'],
      coveredGone: answers['covered/hide/gone/notes/names-bob'], coveredLive: answers['covered/hide/notes/names-bob'], coveredLabelled: answers['covered labelled-only/hide/gone/notes/names-carol'],
      mixedNamesBob: answers['mixed/hide/gone/notes/names-bob'], mixedLiveNamesBob: answers['mixed/hide/notes/names-bob'], mixedOpen: answers['mixed/hide/notes/open'], mixedLabelled: answers['mixed labelled-only/hide/gone/notes/names-carol'] })
      .toEqual({ goneNamesAlice: true, goneNamesBob: false, absent: false, privateHidden: true, privateShown: false, goneNamesCarol: false, goneOpenForCarol: true, coveredGone: true, coveredLive: false, coveredLabelled: true, mixedNamesBob: true, mixedLiveNamesBob: true, mixedOpen: false, mixedLabelled: true });
    return answers;
  });

  parityTest('the facts backstop extraction reads see a page\'s waiting and finished facts-absorb jobs', {
    methods: ['hasPendingFactsExtraction', 'hasCompletedFactsExtraction', 'admitJob', 'claimNextJob', 'completeJob'],
  }, async (engine) => {
    const queue = new MinionQueue(engine);
    const STARTABLE = ['waiting', 'delayed', 'paused', 'waiting-children', 'active'];
    const read = async (pageId: number | string) => ({ pending: await engine.hasPendingFactsExtraction(pageId, STARTABLE),
      activeOnly: await engine.hasPendingFactsExtraction(pageId, ['active']), done: await engine.hasCompletedFactsExtraction(pageId) });
    // data.page_id is a JSON number; the reads match its ->> text, so 7 and '7' are the same page.
    await queue.add('facts-absorb', { page_id: 7 }, { queue: 'default' });
    await queue.add('facts-absorb', { page_id: 8 }, { queue: 'default' });
    await queue.add('other-job', { page_id: 9 }, { queue: 'default' });
    const waiting = { seven: await read(7), sevenText: await read('7'), nine: await read(9) };
    const finish = async (result: Record<string, unknown> | undefined) => {
      const job = await queue.claim('parity-token', 30_000, 'default', ['facts-absorb']);
      if (!job) throw new Error('no facts-absorb job to claim');
      await queue.completeJob(job.id, 'parity-token', result);
      return Number((job.data as { page_id?: unknown }).page_id);
    };
    const first = await finish({ skipped: 'superseded' });
    const second = await finish({ facts: 2, skipped: null });
    return { waiting, skippedPage: { id: first, ...(await read(first)) }, donePage: { id: second, ...(await read(second)) } };
  });

  parityTest('a remote capture over stdio commits its mention links', {
    methods: ['getLinks', 'readWriteRequestById'],
    timeout: 90_000,
  }, async (recorded) => withHome(async () => {
    const refusals: unknown[] = [];
    const engine = keepingRefusals(recorded, refusals);
    await engine.putPage('people/alice-example', { type: 'person', title: 'people/alice-example', compiled_truth: 'Fixture.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    await engine.putPage('companies/acme-example', { type: 'company', title: 'companies/acme-example', compiled_truth: 'Fixture.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    await registerLocalWriter(engine, 'cli');
    await registerLocalWriter(engine, 'stdio');
    const slug = 'notes/remote-links-capture';
    let answers: { page: string | null; mentions: string[] };
    try {
      const result = await dispatchToolCall(engine, 'capture', { slug, content: body(0) }, { remote: true, transport: 'stdio', sourceId: 'default' } as never);
      const text = result.content.map(part => (part as { text?: string }).text ?? '').join('');
      expect({ error: result.isError ? text.slice(0, 400) : null }).toEqual({ error: null });
      answers = { page: (await engine.getPage(slug, { sourceId: 'default' }))?.title ?? null, mentions: await settledMentions(engine, slug) };
      expect(answers).toEqual({ page: 'Remote links 0', mentions: ['mentions:companies/acme-example', 'mentions:people/alice-example'] });
    } finally {
      await disposePersistenceConsumer(engine);
    }
    expect(refusalSites(refusals)).toEqual([]);
    return answers;
  }));

  for (const transport of ['stdio', 'http'] as const) {
    for (const grouped of [false, true]) {
      parityTest(`a remote ${grouped ? 'put_pages batch' : 'put_page'} over ${transport} commits its mention links`, {
        methods: ['getLinks', 'addLinksBatch', 'insertOauthClient'],
        timeout: 90_000,
      }, async (recorded) => withHome(async () => {
        const refusals: unknown[] = [];
        const engine = keepingRefusals(recorded, refusals);
        const page = (slug: string, type: string) => engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `${slug} fixture.`, timeline: '', frontmatter: {} }, { sourceId: 'default' });
        await page('people/alice-example', 'person');
        await page('companies/acme-example', 'company');
        await registerLocalWriter(engine, 'cli');
        await registerLocalWriter(engine, 'stdio');
        await engine.insertOauthClient({ client_id: CLIENT, client_name: 'parity links', scope: 'read write', source_id: 'default' });
        const opts = { remote: true, transport, sourceId: 'default',
          ...(transport === 'http' ? { auth: { token: 'parity', clientId: CLIENT, principal: { kind: 'oauth_client', id: CLIENT }, scopes: ['read', 'write'], sourceId: 'default' } } : {}) } as never;
        const slugs = grouped ? [0, 1].map(i => `notes/remote-links-${transport}-batch-${i}`) : [`notes/remote-links-${transport}`];
        let answers: { pages: (string | null)[]; mentions: string[][] };
        try {
          const result = grouped
            ? await dispatchToolCall(engine, 'put_pages', { request_id: BATCH[transport], pages: slugs.map((slug, i) => ({ slug, content: body(i) })), wait_ms: 30_000 }, opts)
            : await dispatchToolCall(engine, 'put_page', { slug: slugs[0], content: body(0) }, opts);
          const text = result.content.map(part => (part as { text?: string }).text ?? '').join('');
          expect({ error: result.isError ? text.slice(0, 400) : null }).toEqual({ error: null });
          const pages = await Promise.all(slugs.map(async slug => (await engine.getPage(slug, { sourceId: 'default' }))?.title ?? null));
          const mentions = await Promise.all(slugs.map(slug => settledMentions(engine, slug)));
          answers = { pages, mentions };
          expect(answers).toEqual({ pages: slugs.map((_, i) => `Remote links ${i}`),
            mentions: slugs.map(() => ['mentions:companies/acme-example', 'mentions:people/alice-example']) });
        } finally {
          await disposePersistenceConsumer(engine);
        }
        expect(refusalSites(refusals)).toEqual([]);
        return answers;
      }));
    }
  }
});
