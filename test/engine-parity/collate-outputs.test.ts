/**
 * BrainEngine parity — samples, per-node link lists and grouped rows that a read builds inside one statement come back in
 * byte order on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the unpriced-model check's sample pages, the unknown-reader check's sample page, traverseGraph's per-node
 *    links, findAnomalies' page_slugs, schema-pack detect's sample types and the write-failure summary's recovery
 *    blockers return the same order on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1): byte order, as PGLite and the Rust store sort.
 *  - Regression: `array_agg(DISTINCT ...)` and `jsonb_agg(DISTINCT ...)` sort their input by the database collation, so
 *    an en_US Postgres listed (and cut to three or five) other samples than PGLite; `min(source_id)` and `min(slug)` took
 *    each key from a different row, so the unknown-reader sample could name a page that does not exist; and the
 *    write-failure summary ordered only by source id, so a source's blockers came in whatever order its groups did.
 *  - Why existing coverage misses it: the cases used keys that sort the same in every locale, checked list lengths or
 *    sorted the lists first, and CI's Postgres runs in C.UTF-8. Every case here mixes `a-z`, `ab`, `a.b` and `a_b`; run
 *    it against an en_US Postgres to see it fail.
 *  - Seam: none. Pages (an unknown reader included), tags, links, segment derivations and persistence rows go through
 *    the engine writers. putPage lowercases a slug, so the prefix case uses the lower-case MIXED_IDS.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { MIXED_IDS, MIXED_SLUGS, byteOrder } from '../helpers/byte-order.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import { derivationUnpricedModelEntry } from '../../src/commands/doctor/checks/derivation-pricing.ts';
import { memberAccessEntry } from '../../src/commands/doctor/checks/member-access.ts';
import { runDetect } from '../../src/core/schema-pack/detect.ts';
import { readTerminalFailureSummary } from '../../src/core/persistence/terminal-failures.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';

const { parityTest } = parityArms(testBackends());

/** Two source ids that sort differently by byte (`a-z` first) and under en_US (`ab` first). */
const SOURCES = ['ab', 'a-z'];

/** The MIXED_IDS that putPage stores as given (it lowercases `B`). */
const STORED_IDS = MIXED_IDS.filter(id => id === id.toLowerCase());

const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `body of ${title}`, timeline: '' });

async function insertPage(engine: BrainEngine, sourceId: string, slug: string, extra: { type?: string; frontmatter?: Record<string, unknown> } = {}): Promise<void> {
  await engine.putPage(slug, { type: (extra.type ?? 'note') as never, title: slug, compiled_truth: 'body', timeline: '', frontmatter: extra.frontmatter ?? {} }, { sourceId });
}

describe('in-statement samples and lists keep byte order', () => {
  parityTest('the unpriced-model check samples the byte-first three pages', {
    methods: ['putPage', 'upsertSegmentDerivations', 'listUnpricedDerivationModels'],
  }, async (engine, backend) => {
    const keys: string[] = [];
    const pageIds: number[] = [];
    for (const source of SOURCES) {
      await createSource(engine, backend, source);
      for (const slug of MIXED_SLUGS) {
        pageIds.push(Number((await engine.putPage(`notes/${slug}`, note(slug), { sourceId: source })).id));
        keys.push(`${source}:notes/${slug}`);
      }
    }
    await engine.upsertSegmentDerivations(pageIds.map(pageId => ({
      pageId, kind: 'synopsis' as const, occurrenceId: 1, version: 1, segmentSha256: new Uint8Array(32).fill(0xaa), contextHash: new Uint8Array(32).fill(0xbb),
      state: 'skipped' as const, output: null, receipt: { kind: 'unpriced_model', model: 'acme:unpriced-sample' },
    })));
    const [check] = await derivationUnpricedModelEntry.run({ engine } as unknown as DoctorContext) as Array<{ status: string; message: string; details: any }>;
    const samples = check!.details.models[0].samples as string[];
    expect(check!.status).toBe('warn');
    expect(samples).toEqual(byteOrder(keys).slice(0, 3));
    expect(check!.message).toContain(`e.g. ${byteOrder(keys).slice(0, 3).join(', ')}`);
    return samples;
  });

  parityTest('the unknown-reader check names one real page, the byte-first one', {
    methods: ['putPage', 'setConfig', 'executeRaw'],
  }, async (engine, backend) => {
    // The byte-first source holds the byte-last slug, so a sample built from two separate minimums names no page.
    await createSource(engine, backend, 'ab');
    await createSource(engine, backend, 'a-z');
    await insertPage(engine, 'ab', 'notes/a-z', { frontmatter: { readable_by: ['member:ghost'] } });
    await insertPage(engine, 'a-z', 'notes/ab', { frontmatter: { readable_by: ['member:ghost'] } });
    await engine.setConfig('access.restrictions_present', '1');
    // The check reads with raw SQL and reports a refused read as a check error, so the case keeps the read's own error.
    const refused: unknown[] = [];
    const watched = new Proxy(engine, { get: (target, prop) => {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'executeRaw' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
      return (...args: unknown[]) => value.apply(target, args).catch((error: unknown) => { refused.push(error); throw error; });
    } });
    const checks = await memberAccessEntry.run({ engine: watched, progress: { heartbeat() {} } } as unknown as DoctorContext) as Array<{ name: string; message: string; details: any }>;
    const unknown = checks.find(c => c.name === 'access_unknown_readers')!;
    if (backend === 'rust' && refused.length > 0) {
      // Named stop: the check's own read (member-access.ts unknownReaders) is raw SQL, which a Rust brain refuses
      // (raw_sql). Its typed read, listUnknownReaders, is on rust-engine/rust-members-tail; the seed above is typed, so
      // the case turns equal when that read merges. A capability refusal takes the in-test pin: rethrow it.
      expect(unknown.message).toContain('Could not run access_unknown_readers');
      throw refused[0];
    }
    const sample = unknown.details.unknown[0].sample as string;
    expect(sample).toBe('a-z:notes/ab');
    expect(unknown.message).toContain('member:ghost (unknown, 2 page(s), e.g. a-z:notes/ab)');
    return sample;
  });

  parityTest('traverseGraph lists each node\'s links by byte target slug', {
    methods: ['putPage', 'addLink', 'traverseGraph'],
  }, async (engine) => {
    const targets = MIXED_SLUGS.map(slug => `g/${slug}`);
    await engine.putPage('g/root', note('root'));
    for (const slug of targets) {
      await engine.putPage(slug, note(slug));
      await engine.addLink('g/root', slug, `to ${slug}`, 'mentions', 'manual');
    }
    const [root] = await engine.traverseGraph('g/root', 1);
    const links = root!.links.map(l => l.to_slug);
    expect(root!.slug).toBe('g/root');
    expect(links).toEqual(byteOrder(targets));
    return links;
  });

  parityTest('findAnomalies lists a cohort\'s page_slugs by byte slug', {
    methods: ['putPage', 'addTag', 'getPage', 'findAnomalies'],
  }, async (engine) => {
    const slugs = [...MIXED_SLUGS, 'ac'].map(slug => `notes/${slug}`);
    for (const slug of slugs) {
      await engine.putPage(slug, note(slug));
      await engine.addTag(slug, 'launch');
    }
    // The day the database stamped the pages, not the JS clock, so a run across UTC midnight still matches.
    const today = new Date((await engine.getPage(slugs[slugs.length - 1]!))!.updated_at).toISOString().slice(0, 10);
    const rows = await engine.findAnomalies({ since: today, lookback_days: 7 });
    const tag = rows.find(r => r.cohort_kind === 'tag' && r.cohort_value === 'launch');
    const type = rows.find(r => r.cohort_kind === 'type' && r.cohort_value === 'note');
    expect(tag?.page_slugs).toEqual(byteOrder(slugs));
    expect(type?.page_slugs).toEqual(byteOrder(slugs));
    return { tag: tag?.page_slugs, type: type?.page_slugs };
  });

  parityTest('schema-pack detect samples a prefix\'s page types by byte type', {
    methods: ['putPage', 'pagePrefixSamples'],
  }, async (engine) => {
    for (const [i, type] of MIXED_IDS.entries()) await insertPage(engine, 'default', `docs/p-${i}`, { type });
    const result = await runDetect(engine, { minPagesPerPrefix: 2 });
    const docs = result.prefixes.find(p => p.prefix === 'docs/');
    expect(docs?.sample_types).toEqual(byteOrder(MIXED_IDS));
    return docs?.sample_types;
  });

  parityTest('schema-pack detect cuts prefixes with tied counts by byte prefix', {
    methods: ['putPage'],
  }, async (engine) => {
    // `top/` leads on count; the STORED_IDS prefixes tie at 2 pages, and the LIMIT keeps only two of them. putPage
    // lowercases a slug, so the ids are the MIXED_IDS a writer stores as given: byte order puts `a-z` and `a.b` first,
    // en_US (which skips the punctuation) puts them after `ab`.
    for (let i = 0; i < 3; i++) await insertPage(engine, 'default', `top/p-${i}`);
    for (const id of STORED_IDS) for (let i = 0; i < 2; i++) await insertPage(engine, 'default', `${id}/p-${i}`);
    const result = await runDetect(engine, { minPagesPerPrefix: 2, maxTypes: 3 });
    const prefixes = result.prefixes.map(p => p.prefix);
    expect(prefixes).toEqual(['top/', 'a-z/', 'a.b/']);
    expect(byteOrder(STORED_IDS).slice(0, 2)).toEqual(['a-z', 'a.b']);
    return prefixes;
  });

  parityTest('the write-failure summary lists a source\'s recovery blockers by byte group key', {
    methods: ['readSourceMembership', 'insertWriteRequest', 'stampWriteClaim', 'publicationJournalStore', 'completeWriteRow', 'readTerminalFailureGroups'],
  }, async (engine) => {
    // One recovery record per build, so each sits in its own group; the summary lists the groups in byte order. Each
    // request is admitted by its build, claimed, records a publication recovery and commits with it still set, the way
    // a write whose file publication was interrupted ends; every step is a typed journal member.
    const { incarnation } = (await engine.readSourceMembership('default'))!;
    for (const build of MIXED_IDS) {
      const row = await engine.insertWriteRequest({
        principalKind: 'local_cli', principalId: 'collate', requestId: randomUUID(), operation: 'put_page', sourceId: 'default',
        sourceIncarnation: incarnation, pageId: null, slug: `notes/held-${build}`, worktreeId: null, topologyGeneration: null,
        digest: randomUUID(), intent: { content: 'x' }, authority: {}, intentBytes: 0, terminalReservation: 0, targetKind: 'page',
        protocolVersion: 1, admitterVersion: build, admitterHostId: null, counterKeys: [], clientRequestId: null,
        state: 'queued', deferredRefreshId: null,
      });
      const token = randomUUID();
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.stampWriteClaim(row.id, token, 60_000, JSON.stringify({ phase: 'publishing' }));
        const recorded = await (await tx.publicationJournalStore()).recordRecovery({ id: row.id, executionToken: token,
          // The same record the raw seed stored: the summary reads only that one is present.
          recovery: { version: 1, path: '/nonexistent/x.md', root: '/nonexistent', beforeHash: null, afterHash: 'a' } as never, bytes: 0, keys: [] }, true);
        expect(recorded).toBe(true);
        await tx.completeWriteRow({
          id: row.id, state: 'committed', outcome: null, errorCode: null, errorMessage: null, consumerVersion: build, consumerHostId: null,
          errorDetail: null, resultBytes: 0, counterKeys: [], intentBytes: 0, retainedBytes: 0, terminalReservation: 0, probePurges: false,
        });
      });
    }
    const summary = await readTerminalFailureSummary(engine);
    if (summary.status !== 'ok') throw new Error(`summary did not finish: ${summary.reason}`);
    const held = summary.sources.find(s => s.source_id === 'default')!.active_blockers.map(b => b.slug);
    expect(held).toEqual(byteOrder(MIXED_IDS).map(build => `notes/held-${build}`));
    return held;
  });
});
