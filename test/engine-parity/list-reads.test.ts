/**
 * BrainEngine parity: the page-list, slug-source, access and journal reads that callers ran through executeRaw, each
 * called directly as its typed member (engine-sql/list-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    each member answers the same rows for the same seeded brain: the slug, path, card, schema-pack, attendance, chat,
 *    who-can-read, journal and connector-cursor reads.
 *  - Regression: these reads ran as raw SQL in their callers, so a Rust brain refused them (or, where the caller caught
 *    the refusal, answered nothing); the collate-* files pin their byte order through the callers.
 *  - Why existing coverage misses it: the collate-* and access cases drive the callers, not each member, so a member
 *    path a caller does not take (an empty filter, a missing row, a second source) is not compared there.
 *  - Seam: none. Real engines, typed writes only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const page = (title: string, type = 'note', frontmatter: Record<string, unknown> = {}) =>
  ({ type, title, compiled_truth: `${title} body text`, timeline: '', frontmatter }) as never;

async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, 'work');
  await engine.putPage('notes/a', page('Alpha note', 'note', { storage: { status: 'stored', locations: [{ store: 'b2' }] } }));
  await engine.putPage('notes/a', page('Alpha in work'), { sourceId: 'work' });
  await engine.putPage('notes/b', page('Beta note', 'legacy-type'));
  await engine.putPage('chat/day', page('#General day', 'dm'));
  await engine.setPageAliases('notes/a', 'default', ['alpha@example.com']);
  await engine.refreshPageOrigin('notes/a', { sourceId: 'default', sourcePath: 'notes/a.md' });
  await engine.refreshPageOrigin('notes/b', { sourceId: 'default', sourcePath: 'notes/b.md' });
}

describe('engine parity: list reads as typed members', () => {
  parityTest('the slug, path, card and schema-pack list reads answer the same rows', {
    methods: ['putPage', 'setPageAliases', 'refreshPageOrigin', 'listLiveSlugSourceIds', 'resolveChainAnchorRows', 'probeTargetRows',
      'readCompanyBrainEvidenceRows', 'listCardRows', 'readShelfPageRows', 'findCardRows', 'readFirstLiveSlugAtPath', 'listPathTwinSlugs',
      'listLiveSlugOrigins', 'probeRetypeRows', 'listAliasCandidatePages', 'listLinkCandidatePages', 'countLivePagesByType', 'listTypeOrphanRows',
      'readStaleMentionScan', 'listEmailAliasPages'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const noTimes = <T extends { updated_at?: unknown }>(rows: T[]) => rows.map(({ updated_at: _u, ...r }) => r);
    const out = {
      slugSources: await engine.listLiveSlugSourceIds('notes/a'),
      anchors: (await engine.resolveChainAnchorRows('notes/a', {})).map(r => r.source_id),
      anchorsScoped: (await engine.resolveChainAnchorRows('notes/a', { sourceId: 'work' })).map(r => r.source_id),
      probe: await engine.probeTargetRows('notes/a', {}),
      evidence: await engine.readCompanyBrainEvidenceRows('default'),
      cards: { ...(await engine.listCardRows({ sourceId: 'default', type: 'note', filters: {}, limit: 5, offset: 0 })),
        cards: noTimes((await engine.listCardRows({ sourceId: 'default', type: 'note', filters: { store: 'b2' }, limit: 5, offset: 0 })).cards) },
      shelf: (await engine.readShelfPageRows('default')).map(r => r.slug),
      found: noTimes(await engine.findCardRows({ sourceId: 'default', type: 'note', query: 'alpha note', aliasNorm: 'alpha note', terms: ['alpha', 'body'], filters: {} })),
      firstAtPath: await engine.readFirstLiveSlugAtPath('notes/a.md'),
      twins: await engine.listPathTwinSlugs('default', ['notes/a.md', 'none.md']),
      origins: await engine.listLiveSlugOrigins(['notes/a', 'notes/b'], 'default'),
      originsAll: await engine.listLiveSlugOrigins(['notes/a']),
      retype: await engine.probeRetypeRows({ fromType: 'legacy-type' }),
      retypeNone: await engine.probeRetypeRows({ fromType: 'note', slugFilter: 'chat/%' }),
      aliasCandidates: (await engine.listAliasCandidatePages('note', 'default', 10)).map(r => r.slug),
      linkCandidates: (await engine.listLinkCandidatePages('note', undefined, 10)).map(r => r.slug),
      types: (await engine.countLivePagesByType({ sourceId: 'default' })).sort((a, b) => String(a.type).localeCompare(String(b.type))),
      orphans: await engine.listTypeOrphanRows({}, ['legacy-type'], 10),
      mentions: await engine.readStaleMentionScan(5),
      emailElsewhere: await engine.listEmailAliasPages('alpha@example.com', 'work'),
      emailSame: await engine.listEmailAliasPages('alpha@example.com', 'default'),
    };
    expect(out.slugSources).toEqual(['default', 'work']);
    expect(out.emailElsewhere).toEqual([{ slug: 'notes/a', source_id: 'default' }]);
    return out;
  });

  parityTest('the attendance, chat, access, upload, journal and cursor reads answer the same rows', {
    methods: ['putPage', 'readClockMillisText', 'listLiveSourceIncarnations', 'readAttendanceWindow', 'readChatCensusRows', 'readWhoCanReadRows',
      'readPageAccessAllowed', 'readPageFolderRulesAllowed', 'countLineageClosingRules', 'readUploadSessionByRequest', 'readSourceIncarnationArchived',
      'listEnabledLabelledOnlyMemberIds', 'readOpCheckpointCompletedKeys', 'readForecastPredictions', 'readTakeHorizonRows', 'readLatestTakeGrades',
      'readPredictionLedgerEvents', 'readBeliefCoverageEvents', 'getPage', 'addTakesBatch'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    await engine.putPage('notes/c', page('Gamma', 'note', { readable_by: ['member:alice-example'] }));
    const notes = await engine.getPage('notes/a');
    await engine.addTakesBatch([{ page_id: notes!.id, row_num: 1, claim: 'it ships', kind: 'bet', holder: 'alice-example', weight: 0.75, since_date: '2026-01-02' }] as never);
    const uuidShaped = (rows: Array<Record<string, unknown>>, key: string) => rows.map(r => ({ ...r, [key]: UUID.test(String(r[key])) }));
    const out = {
      clock: /^\d+$/.test(await engine.readClockMillisText()),
      incarnations: uuidShaped(await engine.listLiveSourceIncarnations(['default', 'work', 'none']), 'incarnation'),
      window: (await engine.readAttendanceWindow('default', 'chat/day', 5)).map(({ id: _id, revision, ...r }) => ({ ...r, revision: UUID.test(revision) })),
      chat: (await engine.readChatCensusRows(['default', 'work'], ['dm'], ['dm'], false)).map(r => ({ ...r, chat_pages: Number(r.chat_pages), channels: Number(r.channels) })),
      chatPrivate: (await engine.readChatCensusRows(['default'], ['dm'], [], true)).map(r => ({ ...r, chat_pages: Number(r.chat_pages), channels: Number(r.channels) })),
      who: await engine.readWhoCanReadRows('notes/a', undefined, 'closed'),
      whoScoped: (await engine.readWhoCanReadRows('notes/c', 'default', 'fn')).map(r => r.slug),
      access: await withCallerAccess({ identity: ['member:alice-example'], restricted: true } as never, async () => ({
        readers: await engine.readPageAccessAllowed('default', 'notes/c', ['member:alice-example']),
        stranger: await engine.readPageAccessAllowed('default', 'notes/c', ['member:bob-example']),
        missing: await engine.readPageAccessAllowed('default', 'none', ['member:alice-example']),
        folders: await engine.readPageFolderRulesAllowed('default', 'notes/c', []),
      })),
      closing: await engine.countLineageClosingRules(['default:raw', 'default:other'], 'default'),
      upload: await engine.readUploadSessionByRequest('local_cli', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'),
      source: (s => s && { archived: s.archived, incarnation: UUID.test(s.incarnation) })(await engine.readSourceIncarnationArchived('work')),
      noSource: await engine.readSourceIncarnationArchived('none'),
      labelled: await engine.listEnabledLabelledOnlyMemberIds(),
      cursor: await engine.readOpCheckpointCompletedKeys('connector-db-cursor', 'none'),
      predictions: (await engine.readForecastPredictions({ sourceIds: null, holder: 'alice-example', about: 'notes/', since: '2026-01-01', until: null }))
        .map(({ id: _id, ...r }) => ({ ...r, weight: Number(r.weight) })),
      noPredictions: await engine.readForecastPredictions({ sourceIds: ['work'], holder: null, about: null, since: null, until: null }),
      horizons: await engine.readTakeHorizonRows(null),
      grades: await engine.readLatestTakeGrades([1]),
      events: await engine.readPredictionLedgerEvents(['default'], ['notes/a']),
      coverage: await engine.readBeliefCoverageEvents('default'),
    };
    expect(out.who.map(r => r.source_id)).toEqual(['default', 'work']);
    expect(out.access).toEqual({ readers: true, stranger: false, missing: false, folders: true });
    return out;
  });
});
