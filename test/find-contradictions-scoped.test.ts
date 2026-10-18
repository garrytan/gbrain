/**
 * Wave 5 D9 — remote `find_contradictions` (src/core/eval-contradictions/scoped-read.ts):
 * scoped readers get stored findings only when both sides are visible to them
 * now and still read as judged, with live text, source identity and trust
 * labels. The fixture report copies every protected marker verbatim (text,
 * axis and resolution command), so any leak of stored text shows up.
 * Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { withTrustPromotion } from '../src/core/persistence/context.ts';
import { renderResolutionCommand } from '../src/core/eval-contradictions/auto-supersession.ts';
import { runContradictionProbe } from '../src/core/eval-contradictions/runner.ts';
import { writeRunRow } from '../src/core/eval-contradictions/trends.ts';
import type { ContradictionFinding, PairMember, ResolutionKind } from '../src/core/eval-contradictions/types.ts';
import type { TrustTier } from '../src/core/trust/tier.ts';

let engine: PGLiteEngine;
const noop = { info: () => {}, warn: () => {}, error: () => {} };

/** Markers a remote caller scoped to `default` must never read. */
const PROTECTED = {
  privatePage: 'PRIVPAGEMARK',
  otherSource: 'OTHERSRCMARK',
  quarantined: 'QUARANTINEMARK',
  deleted: 'DELETEDMARK',
  archived: 'ARCHIVEDMARK',
  changedOld: 'CHANGEDOLDMARK',
  unsafe: 'UNSAFECHUNKMARK',
  privateTake: 'PRIVTAKEMARK',
  inactiveTake: 'INACTIVETAKEMARK',
  derived: 'DERIVEDATOMMARK',
  staleProjection: 'STALEPROJMARK',
} as const;
const PUBLIC = { a: 'PUBLICAMARK', b: 'PUBLICBMARK', take: 'WORLDTAKEMARK', low: 'LOWTRUSTMARK', lowTake: 'LOWTAKEMARK' } as const;

interface Member { marker: string; member: PairMember; visibleRemote: boolean; source: string }
const members: Member[] = [];
let findings: ContradictionFinding[] = [];

async function importPage(slug: string, marker: string, opts: { source?: string; frontmatter?: string; type?: string } = {}) {
  const md = `---\ntype: ${opts.type ?? 'note'}\ntitle: ${slug}\n${opts.frontmatter ?? ''}---\n\nAcme reported revenue figure ${marker} for the quarter.\n`;
  const r = await importFromContent(engine, slug, md, { noEmbed: true, sourceId: opts.source ?? 'default' });
  expect(r.status).toBe('imported');
  const [row] = await engine.executeRaw<{ id: number; page_id: number; chunk_text: string }>(
    `SELECT cc.id, cc.page_id, cc.chunk_text FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = $1 AND p.source_id = $2 ORDER BY cc.chunk_index LIMIT 1`, [slug, opts.source ?? 'default']);
  expect(row!.chunk_text).toContain(marker);
  return { pageId: Number(row!.page_id), chunkId: Number(row!.id), text: row!.chunk_text };
}

const chunkMember = (slug: string, chunkId: number, text: string, date: string | null = null): PairMember => ({
  slug, chunk_id: chunkId, take_id: null, take_row_num: null, source_tier: 'curated', holder: null, text,
  effective_date: date, effective_date_source: date ? 'frontmatter' : null,
});

async function addTake(pageId: number, slug: string, rowNum: number, claim: string, holder: string, active = true): Promise<PairMember> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active) VALUES ($1, $2, $3, 'take', $4, 0.8, $5) RETURNING id`,
    [pageId, rowNum, claim, holder, active]);
  return { slug, chunk_id: null, take_id: Number(row!.id), take_row_num: rowNum, source_tier: 'curated', holder, text: claim, effective_date: '2026-01-01', effective_date_source: 'frontmatter' };
}

/** Each protected state is isolated: a frontmatter or deletion update advances the page revision, which alone would hide its chunks. */
const currentProjection = (pageId: number) =>
  engine.executeRaw(`UPDATE pages SET text_projection_revision = knowledge_revision WHERE id = $1`, [pageId]);

const setTier = (table: string, id: number, tier: TrustTier) => engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed',
  () => tx.executeRaw(`UPDATE ${table} SET trust_tier = $1 WHERE id = $2`, [tier, id])));

function finding(a: Member, b: Member, kind: ResolutionKind = 'temporal_supersede', severity: 'low' | 'medium' | 'high' = 'high'): ContradictionFinding {
  const pair = { kind: a.member.take_id !== null || b.member.take_id !== null ? 'intra_page_chunk_take' as const : 'cross_slug_chunks' as const, a: a.member, b: b.member, combined_score: 1 };
  return {
    ...pair, verdict: 'contradiction', severity, axis: `${a.marker} disagrees with ${b.marker}`, confidence: 0.9,
    resolution_kind: kind, resolution_command: renderResolutionCommand(pair, kind),
  };
}

async function writeReport(list: ContradictionFinding[], runId = 'd9-run') {
  await engine.writeContradictionsRun({
    run_id: runId, judge_model: 'fixture', prompt_version: 'fixture', queries_evaluated: 1,
    queries_with_contradiction: 1, total_contradictions_flagged: list.length, wilson_ci_lower: 0, wilson_ci_upper: 1,
    judge_errors_total: 0, cost_usd_total: 0, duration_ms: 1, source_tier_breakdown: {},
    report_json: { per_query: [{ query: 'PRIVATEQUERYMARK', contradictions: list }] },
  } as never);
}

async function remoteCall(params: Record<string, unknown>, opts: DispatchOpts = {}) {
  const res = await dispatchToolCall(engine as never, 'find_contradictions', params, { remote: true, transport: 'stdio', sourceId: 'default', ...opts });
  const text = res.content.map(c => (c as { text?: string }).text ?? '').join('\n');
  return { text, body: JSON.parse((res.content[0] as { text: string }).text) as {
    contradictions: Array<{ a: { slug: string; source_id: string; text: string; trust_tier: string }; b: { slug: string; source_id: string; text: string; trust_tier: string }; resolution_kind: string; resolution_command: string; supersede_withheld?: string; axis: string }>;
    total_visible?: number; total_in_run?: number; note?: string;
  }, isError: res.isError === true };
}

const localCtx = (o: Partial<OperationContext> = {}): OperationContext =>
  ({ engine, config: { engine: 'pglite' }, logger: noop, dryRun: false, remote: false, sourceId: '__all__', ...o }) as OperationContext;

/** Seeded PRNG (mulberry32) so a failing fuzz case replays exactly. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('aa-other', 'aa-other', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('aa-archived', 'aa-archived', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);

  const a = await importPage('companies/acme', PUBLIC.a);
  const b = await importPage('companies/acme-two', PUBLIC.b);
  const low = await importPage('notes/low-trust', PUBLIC.low);
  await setTier('pages', low.pageId, 'external_untrusted');
  const priv = await importPage('notes/private', PROTECTED.privatePage, { frontmatter: 'visibility: private\n' });
  // Same slug as the public page, in a source the caller cannot read: the stored report has no source column.
  const other = await importPage('companies/acme', PROTECTED.otherSource, { source: 'aa-other' });
  const quar = await importPage('notes/quarantined', PROTECTED.quarantined);
  await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"quarantine":{"reason":"junk_pattern","detail":"test","assessed_at":"2026-10-07T00:00:00Z"}}'::jsonb WHERE id = $1`, [quar.pageId]);
  await currentProjection(quar.pageId);
  const del = await importPage('notes/deleted', PROTECTED.deleted);
  const arch = await importPage('notes/archived', PROTECTED.archived, { source: 'aa-archived' });
  const changed = await importPage('notes/changed', PROTECTED.changedOld);
  const unsafe = await importPage('notes/unsafe', PROTECTED.unsafe);
  const derived = await importPage('atoms/derived', PROTECTED.derived, { type: 'atom' });
  const stale = await importPage('notes/stale', PROTECTED.staleProjection);

  const worldTake = await addTake(a.pageId, 'companies/acme', 1, `Acme revenue ${PUBLIC.take}`, 'world');
  const privTake = await addTake(a.pageId, 'companies/acme', 2, `Acme revenue ${PROTECTED.privateTake}`, 'garry');
  const inactiveTake = await addTake(a.pageId, 'companies/acme', 3, `Acme revenue ${PROTECTED.inactiveTake}`, 'world', false);
  const lowTake = await addTake(b.pageId, 'companies/acme-two', 1, `Acme revenue ${PUBLIC.lowTake}`, 'world');
  await setTier('takes', lowTake.take_id!, 'external_untrusted');

  members.push(
    { marker: PUBLIC.a, member: chunkMember('companies/acme', a.chunkId, a.text, '2026-03-01'), visibleRemote: true, source: 'default' },
    { marker: PUBLIC.b, member: chunkMember('companies/acme-two', b.chunkId, b.text, '2026-02-01'), visibleRemote: true, source: 'default' },
    { marker: PUBLIC.take, member: worldTake, visibleRemote: true, source: 'default' },
    { marker: PUBLIC.low, member: chunkMember('notes/low-trust', low.chunkId, low.text, '2026-04-01'), visibleRemote: true, source: 'default' },
    { marker: PUBLIC.lowTake, member: lowTake, visibleRemote: true, source: 'default' },
    { marker: PROTECTED.privatePage, member: chunkMember('notes/private', priv.chunkId, priv.text), visibleRemote: false, source: 'default' },
    { marker: PROTECTED.otherSource, member: chunkMember('companies/acme', other.chunkId, other.text), visibleRemote: false, source: 'aa-other' },
    { marker: PROTECTED.quarantined, member: chunkMember('notes/quarantined', quar.chunkId, quar.text), visibleRemote: false, source: 'default' },
    { marker: PROTECTED.deleted, member: chunkMember('notes/deleted', del.chunkId, del.text), visibleRemote: false, source: 'default' },
    { marker: PROTECTED.archived, member: chunkMember('notes/archived', arch.chunkId, arch.text), visibleRemote: false, source: 'aa-archived' },
    { marker: PROTECTED.changedOld, member: chunkMember('notes/changed', changed.chunkId, changed.text), visibleRemote: false, source: 'default' },
    { marker: PROTECTED.unsafe, member: chunkMember('notes/unsafe', unsafe.chunkId, unsafe.text), visibleRemote: false, source: 'default' },
    { marker: PROTECTED.derived, member: chunkMember('atoms/derived', derived.chunkId, derived.text), visibleRemote: false, source: 'default' },
    { marker: PROTECTED.staleProjection, member: chunkMember('notes/stale', stale.chunkId, stale.text), visibleRemote: false, source: 'default' },
    { marker: PROTECTED.privateTake, member: privTake, visibleRemote: false, source: 'default' },
    { marker: PROTECTED.inactiveTake, member: inactiveTake, visibleRemote: false, source: 'default' },
  );
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) findings.push(finding(members[i]!, members[j]!));
  await writeReport(findings);

  // State changes after the probe ran: the report still holds the old text.
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE id = $1`, [del.pageId]);
  await currentProjection(del.pageId);
  await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'aa-archived'`);
  await engine.executeRaw(`UPDATE content_chunks SET chunk_text = 'Acme revenue was restated.' WHERE id = $1`, [changed.chunkId]);
  await engine.executeRaw(`UPDATE pages SET chunker_version = 0 WHERE id = $1`, [unsafe.pageId]);
  // An edited page whose chunks still hold the previous revision's text.
  await engine.executeRaw(`UPDATE pages SET text_projection_revision = NULL WHERE id = $1`, [stale.pageId]);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

const protectedMarkers = Object.values(PROTECTED);

describe('find_contradictions for scoped readers (D9)', () => {
  test('control: the trusted unscoped local read returns the stored report, every protected marker included', async () => {
    const res = await operationsByName.find_contradictions.handler(localCtx(), { limit: 100 }) as { contradictions: unknown[]; total_in_run: number };
    const text = JSON.stringify(res);
    for (const m of protectedMarkers) expect(text).toContain(m);
    expect(res.total_in_run).toBe(findings.length);
  });

  test('a remote caller sees only fully visible findings, re-read live and labeled', async () => {
    const { text, body } = await remoteCall({ limit: 100 });
    for (const m of protectedMarkers) expect(text).not.toContain(m);
    expect(text).not.toContain('PRIVATEQUERYMARK');
    const visible = members.filter(m => m.visibleRemote);
    expect(body.contradictions).toHaveLength(visible.length * (visible.length - 1) / 2);
    expect(body.total_visible).toBe(body.contradictions.length);
    expect(body.total_in_run).toBeUndefined();
    for (const f of body.contradictions) {
      for (const side of [f.a, f.b]) {
        expect(side.source_id).toBe('default');
        expect(typeof side.trust_tier).toBe('string');
      }
    }
    expect(text).toContain(PUBLIC.take);
  });

  test('the same slug in another source never stands in for the caller\'s page', async () => {
    const { body } = await remoteCall({ slug: 'companies/acme', limit: 100 });
    expect(body.contradictions.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(PROTECTED.otherSource);
  });

  test('a grant on the other source reads that source, never the caller\'s private page', async () => {
    const { text } = await remoteCall({ limit: 100 }, { auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default', 'aa-other', 'aa-archived'] } as never });
    expect(text).toContain(PROTECTED.otherSource);
    for (const m of protectedMarkers.filter(m => m !== PROTECTED.otherSource)) expect(text).not.toContain(m);
  });

  test('min_trust and a token floor hide lower-tier sides instead of refusing', async () => {
    const open = (await remoteCall({ limit: 100 })).text;
    expect(open).toContain(PUBLIC.low);
    expect(open).toContain(PUBLIC.lowTake);
    const param = await remoteCall({ limit: 100, min_trust: 'unknown' });
    expect(param.text).not.toContain(PUBLIC.low);
    expect(param.text).not.toContain(PUBLIC.lowTake);
    expect(param.body.contradictions.length).toBeGreaterThan(0);
    const token = await remoteCall({ limit: 100 }, { auth: { token: 't', clientId: 'c', scopes: ['read'], sourceId: 'default', minTrust: 'unknown' } as never });
    expect(token.isError).toBe(false);
    expect(token.text).not.toContain(PUBLIC.low);
    expect(token.text).not.toContain(PUBLIC.lowTake);
    expect(token.body.contradictions.length).toBeGreaterThan(0);
  });

  test('a supersede proposal against a higher-trust take is withheld for manual review', async () => {
    const take = members.find(m => m.marker === PUBLIC.take)!;
    await setTier('takes', take.member.take_id!, 'user_confirmed');
    try {
      const { body } = await remoteCall({ limit: 100 });
      const pair = (x: string, y: string) => body.contradictions.find(f =>
        [f.a.text, f.b.text].some(t => t.includes(x)) && [f.a.text, f.b.text].some(t => t.includes(y)))!;
      // The newer low-trust chunk would replace the confirmed take.
      const withheld = pair(PUBLIC.take, PUBLIC.low);
      expect(withheld.resolution_kind).toBe('manual_review');
      expect(withheld.supersede_withheld).toBe('higher_trust_target');
      expect(withheld.resolution_command).not.toContain('takes supersede');
    } finally {
      await setTier('takes', take.member.take_id!, 'unknown');
    }
    const { body } = await remoteCall({ limit: 100 });
    const kept = body.contradictions.find(f => [f.a.text, f.b.text].some(t => t.includes(PUBLIC.take)) && [f.a.text, f.b.text].some(t => t.includes(PUBLIC.a)))!;
    expect(kept.resolution_kind).toBe('temporal_supersede');
    expect(kept.resolution_command).toContain('gbrain takes supersede');
  });

  test('a source-filtered local caller gets the same scoped view', async () => {
    const res = await operationsByName.find_contradictions.handler(localCtx({ sourceId: 'default' }), { limit: 100 });
    const text = JSON.stringify(res);
    for (const m of [PROTECTED.otherSource, PROTECTED.archived, PROTECTED.deleted, PROTECTED.changedOld, PROTECTED.quarantined]) expect(text).not.toContain(m);
    expect(text).toContain(PUBLIC.a);
    // The trusted local owner sees private pages and every holder's takes.
    expect(text).toContain(PROTECTED.privatePage);
    expect(text).toContain(PROTECTED.privateTake);
  });

  test('fuzz: random reports, callers and params never return a protected marker (seeded)', async () => {
    const callers: Array<{ name: string; opts: DispatchOpts; extra?: string[] }> = [
      { name: 'stdio default', opts: {} },
      { name: 'grant default', opts: { auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default'] } as never } },
      { name: 'holders world+garry', opts: { takesHoldersAllowList: ['world', 'garry'] }, extra: [PROTECTED.privateTake] },
      { name: 'unknown source', opts: { sourceId: 'aa-missing' } },
      { name: 'grant incl. archived', opts: { auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: ['default', 'aa-archived'] } as never } },
    ];
    const slugs = [...new Set(members.map(m => m.member.slug)), 'acme', 'notes/', ''];
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const pick = findings.filter(() => r() < 0.5).sort(() => r() - 0.5)
        .map(f => ({ ...f, severity: (['low', 'medium', 'high'] as const)[Math.floor(r() * 3)]! }));
      await writeReport(pick, `fuzz-${seed}`);
      const caller = callers[Math.floor(r() * callers.length)]!;
      const params: Record<string, unknown> = { limit: 1 + Math.floor(r() * 120) };
      if (r() < 0.5) params.slug = slugs[Math.floor(r() * slugs.length)];
      if (r() < 0.3) params.severity = (['low', 'medium', 'high'] as const)[Math.floor(r() * 3)];
      if (r() < 0.3) params.min_trust = 'unknown';
      const { text, body } = await remoteCall(params, caller.opts);
      const allowed = new Set(caller.extra ?? []);
      for (const m of protectedMarkers) if (!allowed.has(m)) expect({ seed, caller: caller.name, leaked: text.includes(m) ? m : null }).toEqual({ seed, caller: caller.name, leaked: null });
      expect(text).not.toContain('PRIVATEQUERYMARK');
      if (caller.name === 'unknown source') expect(body.contradictions ?? []).toHaveLength(0);
    }
    await writeReport(findings, 'd9-run-restored');
  });
});

describe('the real probe path', () => {
  test('findings stored by runContradictionProbe resolve for a remote caller, private sides still hidden', async () => {
    const result = await runContradictionProbe({
      engine, queries: ['Acme reported revenue figure'], noCache: true, yesOverride: true, topK: 8,
      judgeFn: async () => ({ verdict: { verdict: 'contradiction', severity: 'high', axis: 'revenue figure', confidence: 0.9, resolution_kind: 'manual_review' }, usage: { inputTokens: 0, outputTokens: 0 } }),
    });
    expect(result.report.per_query[0]!.contradictions.length).toBeGreaterThan(0);
    await writeRunRow(engine, result.report, result.report.duration_ms);
    const local = JSON.stringify(await operationsByName.find_contradictions.handler(localCtx(), { limit: 100 }));
    expect(local).toContain(PROTECTED.privatePage);
    const { text, body } = await remoteCall({ limit: 100 });
    expect(body.contradictions.length).toBeGreaterThan(0);
    for (const m of protectedMarkers) expect(text).not.toContain(m);
  });
});
