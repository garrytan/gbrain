/**
 * A8 — chronicle timeline ops under scope + remote.
 *
 * Three contracts pinned here:
 *  1. Source isolation: chronicle_day / chronicle_on_this_day / chronicle_since /
 *     chronicle_last_seen / volunteer_chronicle under a remote scalar 'srcalpha'
 *     ctx AND a federated ['srcalpha'] grant never surface srcbeta identity.
 *     Anti-vacuity: a trusted local control sees the beta marker first.
 *  2. Far-endpoint (#2200 class): a timeline row's event_page_id can point at an
 *     out-of-scope source's page (crafted via executeRaw). The event-derived
 *     fields from the `ep` LEFT JOIN (event_slug / effective_date / kind, and
 *     last_seen's who-arm + last_event_slug) must NOT carry beta identity for a
 *     scoped caller — the ep join is scoped like getLinks' origin join, so
 *     out-of-scope event fields null out while the alpha row itself survives.
 *  3. Diary redaction (fail-closed, mirrors ontology_get's mechanism): rows
 *     whose depth page or event page lives under life/diary/ (or whose source
 *     references it) are redacted for `remote: true` AND remote UNDEFINED (the
 *     `ctx.remote !== false` shape); `remote: false` sees them. last_seen
 *     fail-closes to the never-seen shape when its evidence is diary.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const chronicle_day = operations.find(o => o.name === 'chronicle_day')!;
const chronicle_on_this_day = operations.find(o => o.name === 'chronicle_on_this_day')!;
const chronicle_since = operations.find(o => o.name === 'chronicle_since')!;
const chronicle_last_seen = operations.find(o => o.name === 'chronicle_last_seen')!;
const volunteer_chronicle = operations.find(o => o.name === 'volunteer_chronicle')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    dryRun: false,
    remote: true,
    transport: 'stdio',
    ...overrides,
  } as OperationContext;
}
const localWide = () => ctxOf({ remote: false, sourceId: undefined });
const localAlpha = () => ctxOf({ remote: false, sourceId: 'srcalpha' });
const remoteScalar = () => ctxOf({ sourceId: 'srcalpha' });
const remoteFederated = () => ctxOf({ auth: { allowedSources: ['srcalpha'] } as any });
// remote UNDEFINED — the fail-closed `ctx.remote !== false` shape (type bypassed via cast).
const remoteUndef = () => ctxOf({ remote: undefined as unknown as boolean, sourceId: 'srcalpha' });

const LEAK_TOKENS = ['srcbeta', 'BETAMARKER', 'beta-secret', 'betakind'];
function leakToken(payload: unknown): string | null {
  const text = JSON.stringify(payload) ?? '';
  for (const t of LEAK_TOKENS) if (text.includes(t)) return t;
  return null;
}
const DIARY_TOKENS = ['DIARYMARK', 'life/diary/'];
function diaryToken(payload: unknown): string | null {
  const text = JSON.stringify(payload) ?? '';
  for (const t of DIARY_TOKENS) if (text.includes(t)) return t;
  return null;
}

// Fixed past dates → deterministic (no TODAY()-relative fixtures).
const ANCHOR = '2026-06-18';
const CROSS_DATE = '2026-06-19';
const PRIOR = '2025-06-18';

const ids: Record<string, number> = {};

async function insertPage(opts: {
  slug: string; type: string; sourceId: string;
  effectiveDate?: string | null; frontmatter?: string;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id, slug, type, title, effective_date, frontmatter)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::text::jsonb)
     RETURNING id`,
    [opts.sourceId, opts.slug, opts.type, opts.slug,
      opts.effectiveDate ?? null, opts.frontmatter ?? '{}'],
  );
  return rows[0].id;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  for (const src of ['srcalpha', 'srcbeta']) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING`,
      [src, `/tmp/${src}`],
    );
  }
  // ── srcalpha pages ──
  await insertPage({ slug: 'meetings/alpha-sync', type: 'meeting', sourceId: 'srcalpha' });
  await insertPage({ slug: 'people/alpha-person', type: 'person', sourceId: 'srcalpha' });
  await insertPage({
    slug: 'life/events/2026-06-18-alpha', type: 'event', sourceId: 'srcalpha',
    effectiveDate: '2026-06-18T10:00:00Z',
    frontmatter: '{"event":{"who":["people/alpha-person"],"kind":"alphakind"}}',
  });
  ids.alphaEvent2 = await insertPage({
    slug: 'life/events/2026-06-19-alpha2', type: 'event', sourceId: 'srcalpha',
    effectiveDate: '2026-06-19T10:00:00Z',
    frontmatter: '{"event":{"who":["people/alpha-person"],"kind":"alphakind"}}',
  });
  await insertPage({
    slug: 'life/events/2025-06-18-alpha', type: 'event', sourceId: 'srcalpha',
    effectiveDate: '2025-06-18T10:00:00Z',
    frontmatter: '{"event":{"who":["people/alpha-person"],"kind":"alphakind"}}',
  });
  // Diary fixtures: a diary DEPTH page (page_slug arm), a diary EVENT page
  // (event_slug arm), and a prior-year diary pair (on_this_day arm).
  await insertPage({ slug: 'life/diary/2026-06-18', type: 'note', sourceId: 'srcalpha' });
  await insertPage({
    slug: 'life/events/2026-06-18-dref', type: 'event', sourceId: 'srcalpha',
    effectiveDate: '2026-06-18T20:00:00Z',
    frontmatter: '{"event":{"who":["people/alpha-person"],"kind":"reflection"}}',
  });
  await insertPage({
    slug: 'life/diary/2026-06-18-entry', type: 'event', sourceId: 'srcalpha',
    effectiveDate: '2026-06-18T21:00:00Z',
    frontmatter: '{"event":{"who":["people/diary-only-person"],"kind":"reflection"}}',
  });
  await insertPage({ slug: 'life/diary/2025-06-18', type: 'note', sourceId: 'srcalpha' });
  await insertPage({
    slug: 'life/events/2025-06-18-dref2', type: 'event', sourceId: 'srcalpha',
    effectiveDate: '2025-06-18T09:00:00Z',
    frontmatter: '{"event":{"who":["people/alpha-person"],"kind":"reflection"}}',
  });
  // ── srcbeta pages ──
  await insertPage({ slug: 'meetings/srcbeta-sync', type: 'meeting', sourceId: 'srcbeta' });
  ids.betaEvent = await insertPage({
    slug: 'life/events/2026-06-18-beta-secret', type: 'event', sourceId: 'srcbeta',
    effectiveDate: '2026-06-18T11:00:00Z',
    frontmatter: '{"event":{"who":["people/beta-secret-person"],"kind":"betakind"}}',
  });
  await insertPage({
    slug: 'life/events/2025-06-18-beta-secret', type: 'event', sourceId: 'srcbeta',
    effectiveDate: '2025-06-18T11:00:00Z',
    frontmatter: '{"event":{"who":["people/beta-secret-person"],"kind":"betakind"}}',
  });

  // ── timeline projections (engine.upsertEventProjection, per source) ──
  await engine.upsertEventProjection({
    depthSlug: 'meetings/alpha-sync', eventSlug: 'life/events/2026-06-18-alpha',
    date: ANCHOR, summary: 'alpha sync event', sourceId: 'srcalpha',
  });
  await engine.upsertEventProjection({
    depthSlug: 'meetings/srcbeta-sync', eventSlug: 'life/events/2026-06-18-beta-secret',
    date: ANCHOR, summary: 'BETAMARKER beta sync event', sourceId: 'srcbeta',
  });
  await engine.upsertEventProjection({
    depthSlug: 'meetings/alpha-sync', eventSlug: 'life/events/2025-06-18-alpha',
    date: PRIOR, summary: 'alpha anniversary event', sourceId: 'srcalpha',
  });
  await engine.upsertEventProjection({
    depthSlug: 'meetings/srcbeta-sync', eventSlug: 'life/events/2025-06-18-beta-secret',
    date: PRIOR, summary: 'BETAMARKER anniversary', sourceId: 'srcbeta',
  });
  // Diary projections (all srcalpha).
  await engine.upsertEventProjection({
    depthSlug: 'life/diary/2026-06-18', eventSlug: 'life/events/2026-06-18-dref',
    date: ANCHOR, summary: 'DIARYMARK private reflection', sourceId: 'srcalpha',
  });
  await engine.upsertEventProjection({
    depthSlug: 'meetings/alpha-sync', eventSlug: 'life/diary/2026-06-18-entry',
    date: ANCHOR, summary: 'DIARYMARK diary event row', sourceId: 'srcalpha',
  });
  await engine.upsertEventProjection({
    depthSlug: 'life/diary/2025-06-18', eventSlug: 'life/events/2025-06-18-dref2',
    date: PRIOR, summary: 'DIARYMARK anniversary reflection', sourceId: 'srcalpha',
  });

  // ── the CROSS row (#2200 class): an alpha row whose event_page_id points at
  // a BETA page. Crafted by repointing an alpha projection (dates differ from
  // the beta event's own row, dodging the (event_page_id, date) unique index).
  await engine.upsertEventProjection({
    depthSlug: 'meetings/alpha-sync', eventSlug: 'life/events/2026-06-19-alpha2',
    date: CROSS_DATE, summary: 'alpha cross row summary', sourceId: 'srcalpha',
  });
  const updated = await engine.executeRaw<{ id: number }>(
    `UPDATE timeline_entries SET event_page_id = $1 WHERE event_page_id = $2 RETURNING id`,
    [ids.betaEvent, ids.alphaEvent2],
  );
  if (updated.length !== 1) throw new Error(`CROSS fixture: expected 1 repointed row, got ${updated.length}`);

  // ── ontology (volunteer_chronicle arm): one diary-sourced, one public. ──
  await engine.mergeOntologyFact({
    entitySlug: 'people/alpha-person', dimension: 'affect', value: 'DIARYONLYVALUE',
    source: 'life/diary/2026-06-18', sourceId: 'srcalpha',
  });
  await engine.mergeOntologyFact({
    entitySlug: 'people/alpha-person', dimension: 'role', value: 'publicrole',
    source: 'meetings/alpha-sync', sourceId: 'srcalpha',
  });
}, 60_000);

const VOL_ARGS = { days: 3650, limit: 50, entities: 'people/alpha-person' };

// ─── 1. Source isolation ────────────────────────────────────────────────────
describe('chronicle ops: srcalpha scope never surfaces srcbeta identity', () => {
  const scopes = [
    ['scalar', remoteScalar] as const,
    ['federated', remoteFederated] as const,
  ];

  test('chronicle_day — control sees beta, scoped does not', async () => {
    const control = await chronicle_day.handler(localWide(), { date: ANCHOR });
    expect(leakToken(control)).not.toBeNull(); // anti-vacuity
    for (const [label, mk] of scopes) {
      const rows = await chronicle_day.handler(mk(), { date: ANCHOR });
      expect(JSON.stringify(rows)).toContain('alpha sync event'); // scoped result non-vacuous
      expect(`${label}:${leakToken(rows)}`).toBe(`${label}:null`);
    }
  });

  test('chronicle_since — control sees beta, scoped does not (incl. the CROSS row)', async () => {
    const control = await chronicle_since.handler(localWide(), { date: '2026-06-01' });
    expect(leakToken(control)).not.toBeNull();
    for (const [label, mk] of scopes) {
      const rows = await chronicle_since.handler(mk(), { date: '2026-06-01' });
      expect(JSON.stringify(rows)).toContain('alpha sync event');
      // Pre-fix red: the CROSS row's ep join leaked 'beta-secret' + 'betakind' here.
      expect(`${label}:${leakToken(rows)}`).toBe(`${label}:null`);
    }
  });

  test('chronicle_on_this_day — control sees beta, scoped does not', async () => {
    const control = await chronicle_on_this_day.handler(localWide(), { date: ANCHOR });
    expect(leakToken(control)).not.toBeNull();
    for (const [label, mk] of scopes) {
      const rows = await chronicle_on_this_day.handler(mk(), { date: ANCHOR });
      expect(JSON.stringify(rows)).toContain('alpha anniversary event');
      expect(`${label}:${leakToken(rows)}`).toBe(`${label}:null`);
    }
  });

  test('chronicle_last_seen — beta entity invisible under alpha scope (field probe: input echo is not a leak)', async () => {
    // Control: brain-wide local sees the beta sighting — the latest is the
    // CROSS row (its who-arm matches through the unscoped ep join), which
    // brain-wide callers legitimately keep post-fix.
    const control = await chronicle_last_seen.handler(localWide(), { entity: 'people/beta-secret-person', asof: '2026-07-01' }) as any;
    expect(control.last_date).toBe(CROSS_DATE);
    expect(control.last_event_slug).toBe('life/events/2026-06-18-beta-secret');
    for (const [label, mk] of scopes) {
      // Pre-fix red: the CROSS row's unscoped ep who-arm matched the beta
      // event's who under an ALPHA scope, leaking last_date + beta event slug.
      const res = await chronicle_last_seen.handler(mk(), { entity: 'people/beta-secret-person', asof: '2026-07-01' }) as any;
      expect(`${label}:${res.last_date}`).toBe(`${label}:null`);
      expect(`${label}:${res.last_event_slug}`).toBe(`${label}:null`);
      expect(`${label}:${res.days_ago}`).toBe(`${label}:null`);
    }
  });

  test('volunteer_chronicle — control sees beta, scoped does not', async () => {
    const control = await volunteer_chronicle.handler(localWide(), VOL_ARGS);
    expect(leakToken(control)).not.toBeNull();
    for (const [label, mk] of scopes) {
      const res = await volunteer_chronicle.handler(mk(), VOL_ARGS);
      expect(JSON.stringify(res)).toContain('alpha sync event');
      expect(`${label}:${leakToken(res)}`).toBe(`${label}:null`);
    }
  });
});

// ─── 2. Far-endpoint (#2200 class) ─────────────────────────────────────────
describe('far-endpoint: alpha row whose event_page_id points at a beta page', () => {
  test('fixture proof: brain-wide local DOES see the beta event fields on the alpha row', async () => {
    const rows = await chronicle_day.handler(localWide(), { date: CROSS_DATE }) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe('alpha cross row summary');
    expect(rows[0].event_slug).toBe('life/events/2026-06-18-beta-secret');
    expect(rows[0].kind).toBe('betakind');
  });

  test('scoped callers keep the alpha row but its ep-derived fields null out', async () => {
    for (const [label, mk] of [['scalar', remoteScalar], ['federated', remoteFederated]] as const) {
      const rows = await chronicle_day.handler(mk(), { date: CROSS_DATE }) as any[];
      expect(`${label}:${rows.length}`).toBe(`${label}:1`);
      expect(rows[0].summary).toBe('alpha cross row summary'); // alpha's own data survives
      expect(rows[0].page_slug).toBe('meetings/alpha-sync');
      expect(`${label}:${rows[0].event_slug}`).toBe(`${label}:null`);
      expect(`${label}:${rows[0].effective_date}`).toBe(`${label}:null`);
      expect(`${label}:${rows[0].kind}`).toBe(`${label}:null`);
      expect(`${label}:${leakToken(rows)}`).toBe(`${label}:null`);
    }
  });

  test("chronicle_since kind filter can't match an out-of-scope event's kind", async () => {
    const control = await chronicle_since.handler(localWide(), { date: '2026-06-01', kind: 'betakind' }) as any[];
    expect(control.length).toBeGreaterThan(0); // anti-vacuity: betakind rows exist brain-wide
    for (const [label, mk] of [['scalar', remoteScalar], ['federated', remoteFederated]] as const) {
      const rows = await chronicle_since.handler(mk(), { date: '2026-06-01', kind: 'betakind' }) as any[];
      expect(`${label}:${rows.length}`).toBe(`${label}:0`);
    }
  });
});

// ─── 3. Diary redaction (fail-closed on remote) ────────────────────────────
describe('diary redaction: remote (and remote-undefined) never see life/diary rows', () => {
  const remotes = [
    ['remote:true', remoteScalar] as const,
    ['remote:undefined', remoteUndef] as const,
  ];

  test('chronicle_day — local sees diary, remote + undefined do not', async () => {
    const local = await chronicle_day.handler(localAlpha(), { date: ANCHOR });
    expect(diaryToken(local)).toBe('DIARYMARK'); // both diary rows visible locally
    expect(JSON.stringify(local)).toContain('life/diary/2026-06-18-entry'); // event_slug arm seeded
    for (const [label, mk] of remotes) {
      const rows = await chronicle_day.handler(mk(), { date: ANCHOR });
      expect(JSON.stringify(rows)).toContain('alpha sync event'); // non-diary row survives
      expect(`${label}:${diaryToken(rows)}`).toBe(`${label}:null`);
    }
  });

  test('chronicle_since — local sees diary, remote + undefined do not', async () => {
    const local = await chronicle_since.handler(localAlpha(), { date: '2026-06-01' });
    expect(diaryToken(local)).toBe('DIARYMARK');
    for (const [label, mk] of remotes) {
      const rows = await chronicle_since.handler(mk(), { date: '2026-06-01' });
      expect(JSON.stringify(rows)).toContain('alpha sync event');
      expect(`${label}:${diaryToken(rows)}`).toBe(`${label}:null`);
    }
  });

  test('chronicle_on_this_day — local sees diary, remote + undefined do not', async () => {
    const local = await chronicle_on_this_day.handler(localAlpha(), { date: ANCHOR });
    expect(diaryToken(local)).toBe('DIARYMARK');
    for (const [label, mk] of remotes) {
      const rows = await chronicle_on_this_day.handler(mk(), { date: ANCHOR });
      expect(JSON.stringify(rows)).toContain('alpha anniversary event');
      expect(`${label}:${diaryToken(rows)}`).toBe(`${label}:null`);
    }
  });

  test('chronicle_last_seen — diary-only evidence fail-closes to the never-seen shape', async () => {
    const local = await chronicle_last_seen.handler(localAlpha(), { entity: 'people/diary-only-person', asof: '2026-07-01' }) as any;
    expect(local.last_date).toBe(ANCHOR);
    expect(local.last_event_slug).toBe('life/diary/2026-06-18-entry');
    for (const [label, mk] of remotes) {
      const res = await chronicle_last_seen.handler(mk(), { entity: 'people/diary-only-person', asof: '2026-07-01' }) as any;
      expect(`${label}:${res.last_date}`).toBe(`${label}:null`);
      expect(`${label}:${res.last_event_slug}`).toBe(`${label}:null`);
      expect(`${label}:${res.days_ago}`).toBe(`${label}:null`);
    }
  });

  test('chronicle_last_seen — a diary page queried AS the entity fail-closes remotely', async () => {
    const local = await chronicle_last_seen.handler(localAlpha(), { entity: 'life/diary/2026-06-18', asof: '2026-07-01' }) as any;
    expect(local.last_date).toBe(ANCHOR); // p.slug arm: the diary page's own timeline row
    for (const [label, mk] of remotes) {
      const res = await chronicle_last_seen.handler(mk(), { entity: 'life/diary/2026-06-18', asof: '2026-07-01' }) as any;
      expect(`${label}:${res.last_date}`).toBe(`${label}:null`);
      expect(`${label}:${res.last_event_slug}`).toBe(`${label}:null`);
    }
  });
});

// ─── 4. volunteer_chronicle fail-closed expression pin ─────────────────────
describe('volunteer_chronicle: remote UNDEFINED redacts exactly like remote:true', () => {
  test('recent_timeline + ontology diary redaction under remote:true / undefined; local sees all', async () => {
    const local = await volunteer_chronicle.handler(localAlpha(), VOL_ARGS) as any;
    expect(diaryToken(local.recent_timeline)).toBe('DIARYMARK');
    expect(JSON.stringify(local.ontologies)).toContain('DIARYONLYVALUE');

    const asTrue = await volunteer_chronicle.handler(remoteScalar(), VOL_ARGS) as any;
    const asUndef = await volunteer_chronicle.handler(remoteUndef(), VOL_ARGS) as any;
    for (const [label, res] of [['remote:true', asTrue], ['remote:undefined', asUndef]] as const) {
      expect(`${label}:${diaryToken(res.recent_timeline)}`).toBe(`${label}:null`);
      expect(JSON.stringify(res.recent_timeline)).toContain('alpha sync event');
      expect(JSON.stringify(res.ontologies)).not.toContain('DIARYONLYVALUE'); // diary-sourced ontology redacted
      expect(JSON.stringify(res.ontologies)).toContain('publicrole');         // public ontology survives
    }
    // The fail-closed pin: undefined behaves EXACTLY like true.
    expect(JSON.stringify(asUndef.recent_timeline)).toBe(JSON.stringify(asTrue.recent_timeline));
    expect(JSON.stringify(asUndef.ontologies)).toBe(JSON.stringify(asTrue.ontologies));
  });
});
