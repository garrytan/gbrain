/**
 * GBRA-217 PR B: get_page {as_of} reads a page by valid time, from the frontmatter valid_from / valid_until of the
 * current page and its retained versions.
 *
 * 1. Protects: the selection rule (greatest valid_from on or before the date, latest recorded on a tie, half-open
 *    valid_until), the ambiguity flag, the honest statuses when history is missing (before_recorded_history, a prune
 *    gap, an unmarked upgraded page), privacy (a private chosen edition reads as a missing page, never an older world
 *    one; a private-time reason never leaks), the refusals, the shared date normaliser, the pinned windows, the plain
 *    read's additive status, get_versions' parsed dates and the write advisories.
 * 2. Fails when: any of those picks another edition, drops the uncertain flag, puts expired or future text at the top
 *    level, shows a hidden reason, or a window cursor follows the page instead of its edition.
 * 3. Real handlers (put_page, get_page, get_versions) on a keyless repo-less brain: PGLite always, Postgres when
 *    DATABASE_URL is set (test/postgres-unit-arms.txt). Seeding writes SQL only where the case is history gbrain no
 *    longer writes (an unmarked pre-upgrade page) or volume (500 versions).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { createPageVersion } from '../src/core/page-state/versions.ts';
import { assertValidTimeEcho, currentValidTime, validDate, validDateSql, validTimeVerdict, validTimeWriteAdvisory, VALID_TIME_MIN_HOST_VERSION } from '../src/core/valid-time.ts';
import { exitCodeForCode } from '../src/core/error-catalogue.ts';
import { asOfExitCode, formatGetPage, validTimeLine } from '../src/cli/page-render.ts';
import { utcToday } from '../src/core/link-validity.ts';
import { testBackends, requirePostgresTestDatabase } from './helpers/test-backends.ts';
import { importSegmented } from './helpers/segmented-privacy-fixture.ts';

type R = Record<string, any>;
const outcomeOf = (r: R) => (r.outcome ?? r) as R;
const page = (body: string, fm: string[] = []) => ['---', 'title: Policy', 'type: note', ...fm, '---', '', body, ''].join('\n');
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as OperationError);
let n = 0;
const fresh = (name: string) => 'policies/' + name + '-' + (++n) + '-' + Math.random().toString(36).slice(2, 8);

describe('valid-time normaliser and verdict (pure)', () => {
  test('accepted forms and undated forms', () => {
    expect(validDate('2026-01-01')).toBe('2026-01-01');
    expect(validDate('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    expect(validDate('2026-01-01T00:00:00Z')).toBe('2026-01-01');
    expect(validDate('2026-01-01T00:00:00+00:00')).toBe('2026-01-01');
    expect(validDate(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01');
    for (const bad of ['2026-01', '2026', '2026-02-30', '2026-13-01', '2026-01-01T10:00:00Z', '2026-01-01T00:00:00-05:00', ' 2026-01-01', '0999-01-01', 2026, null, new Date(Date.UTC(2026, 0, 1, 5))]) {
      expect(validDate(bad)).toBeNull();
    }
  });

  test('a gap marks the answer only inside the chosen edition span, or before every retained edition', () => {
    const base = { asOf: '2026-08-01', undatedVersions: 0, gbrainWritten: true, couldHaveBeenPruned: false, ambiguous: false };
    const edition = { chosen: true, isCurrent: false, validFrom: '2026-07-01', validUntil: null, successorPruned: false, recordedSince: '2026-01-01T00:00:00Z', replacedAt: '2026-03-01T00:00:00Z' };
    expect(validTimeVerdict({ ...base, gapAt: '2026-02-01T00:00:00Z', edition })).toMatchObject({ status: 'in_force', history: 'incomplete', why: 'history_gap', uncertain: true });
    expect(validTimeVerdict({ ...base, gapAt: '2026-05-01T00:00:00Z', edition })).toMatchObject({ history: 'retained', uncertain: false, why: null });
    expect(validTimeVerdict({ ...base, gapAt: null, edition: { ...edition, successorPruned: true } })).toMatchObject({ history: 'incomplete', why: 'history_pruned' });
    expect(validTimeVerdict({ ...base, gapAt: '2026-05-01T00:00:00Z', edition: { ...edition, chosen: false } }))
      .toMatchObject({ status: 'before_recorded_history', history: 'incomplete', why: 'history_gap' });
    expect(validTimeVerdict({ ...base, gapAt: null, edition: { ...edition, chosen: false } })).toMatchObject({ status: 'not_yet_in_force', history: 'retained', uncertain: false });
    expect(validTimeVerdict({ ...base, gapAt: null, couldHaveBeenPruned: true, edition })).toMatchObject({ history: 'unknown', why: 'history_unknown', uncertain: true });
  });

  test('write advisories: correction, date-only question, unparsed date, nothing for an undated page', () => {
    const fm = (d?: string) => (d ? { valid_from: d } : {});
    expect(validTimeWriteAdvisory({ frontmatter: fm('2026-01-01'), body: 'a' }, { frontmatter: fm('2026-01-01'), body: 'b' })?.code).toBe('valid_time_correction');
    const q = validTimeWriteAdvisory({ frontmatter: fm('2026-01-01'), body: 'a' }, { frontmatter: fm('2026-03-01'), body: 'a' });
    expect(q?.code).toBe('valid_time_date_only');
    expect(q?.message).toContain('correction of the earlier date, or a renewal');
    expect(validTimeWriteAdvisory(null, { frontmatter: { valid_from: '2026-01' }, body: 'a' })?.code).toBe('valid_from_unparsed');
    expect(validTimeWriteAdvisory({ frontmatter: {}, body: 'a' }, { frontmatter: {}, body: 'b' })).toBeNull();
  });

  test('B4: a reply without the valid_time echo fails closed with host_upgrade_required (exit 16)', () => {
    const plain = { slug: 'policies/policy-4a-example', compiled_truth: 'Current text.' };
    const e = (() => { try { assertValidTimeEcho({ as_of: '2026-07-01' }, plain, { client: '9.9.9.9', host: '0.60.400.0' }); return null; } catch (x) { return x as OperationError; } })();
    expect(e).toBeInstanceOf(OperationError);
    expect(e!.code).toBe('host_upgrade_required');
    expect(JSON.parse(String(e!.detail))).toEqual({ client_version: '9.9.9.9', host_version: '0.60.400.0', min_host_version: VALID_TIME_MIN_HOST_VERSION });
    expect(e!.fix?.argv).toEqual(['gbrain', 'upgrade']);
    expect(exitCodeForCode('host_upgrade_required')).toBe(16);
    expect(() => assertValidTimeEcho({ as_of: '2026-07-01' }, { valid_time: { as_of: '2026-07-01' } }, { client: 'x', host: null })).not.toThrow();
    expect(() => assertValidTimeEcho({}, plain, { client: 'x', host: null })).not.toThrow();
  });

  test('B2b: CLI rendering puts the header on stderr, no document under another status, exit 15', () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => { writes.push(String(s)); return true; };
    try {
      const expired = { slug: 's', valid_time: { as_of: '2027-02-01', status: 'not_in_force', chosen_version_id: null, chosen_is_current: true, valid_from: '2026-07-01', valid_until: '2027-01-01', history: 'retained', uncertain: false, why: null },
        last_in_force: { compiled_truth: 'Expired text.' } };
      expect(formatGetPage(expired)).toBe('status: not_in_force\nwhy: none\n');
      expect(asOfExitCode(expired)).toBe(15);
      const inForce = { slug: 's', title: 'Policy', type: 'note', frontmatter: {}, compiled_truth: 'Text in force.', timeline: '', valid_time: { ...expired.valid_time, as_of: '2026-08-01', status: 'in_force' } };
      expect(formatGetPage(inForce)).toContain('Text in force.');
      expect(asOfExitCode(inForce)).toBe(0);
      const plain = { slug: 's', title: 'Policy', type: 'note', frontmatter: {}, compiled_truth: 'Future text.', timeline: '', valid_time: { status: 'not_yet_in_force', as_of: '2026-10-27', valid_from: '2027-01-01', valid_until: null } };
      expect(formatGetPage(plain)).toContain('Future text.');
      expect(asOfExitCode(plain)).toBe(0);
    } finally { (process.stderr as { write: unknown }).write = orig; }
    expect(writes.join('')).toContain('[gbrain] valid_time as_of 2027-02-01: not_in_force; edition current page (valid_from 2026-07-01, valid_until 2027-01-01); history retained.');
    expect(writes.join('')).toContain('[gbrain] valid_time: not_yet_in_force as of 2026-10-27 (valid_from 2027-01-01, valid_until -).');
    expect(validTimeLine({ as_of: 'd', status: 'in_force', chosen_version_id: 7, history: 'incomplete', uncertain: true, why: 'history_gap', valid_from: '2026-01-01' })).toContain('uncertain: history_gap');
  });
});

for (const backend of testBackends()) {
  describe(backend + ': get_page as_of (repo-less brain)', () => {
    let engine: BrainEngine;
    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = new PostgresEngine();
        await pg.connect({ database_url: requirePostgresTestDatabase() });
        engine = pg;
      } else {
        const lite = new PGLiteEngine();
        await lite.connect({});
        engine = lite;
      }
      await engine.initSchema();
      await engine.executeRaw("DELETE FROM config WHERE key = 'mcp.inline_body_bytes'");
    }, 180_000);
    afterAll(async () => { await engine.disconnect(); resetGateway(); });

    const ctx = (remote = false): OperationContext => ({ engine, config: { engine: backend } as never, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default' } as OperationContext);
    const call = (name: string, params: R, remote = false) => operationsByName[name]!.handler(ctx(remote), params) as Promise<R>;
    const read = (slug: string, as_of: string, remote = false, extra: R = {}) => call('get_page', { slug, as_of, ...extra }, remote);
    async function put(slug: string, body: string, fm: string[] = [], reason?: string): Promise<R> {
      const cur = await call('get_page', { slug, body: 'none' }).catch(() => null);
      return outcomeOf(await call('put_page', { slug, content: page(body, fm), ...(cur ? { expected_revision: cur.revision } : {}), ...(reason ? { reason } : {}), wait_ms: 30_000 }));
    }
    const versionIds = async (slug: string) => ((await call('get_versions', { slug })) as unknown as R[]).map(v => Number(v.id)).reverse();

    test('B-T1: editions, a same-date fix and the half-open boundary', async () => {
      const slug = fresh('sel');
      await put(slug, 'Refunds within 14 days.', ["valid_from: '2026-01-01'"]);
      await put(slug, 'Refunds within 30 days.', ["valid_from: '2026-07-01'", "valid_until: '2027-01-01'"]);
      await put(slug, 'Refunds within 30 days, receipts required.', ["valid_from: '2026-07-01'", "valid_until: '2027-01-01'"]);
      const [v1] = await versionIds(slug);

      const before = await read(slug, '2025-12-31');
      expect(before.valid_time).toMatchObject({ as_of: '2025-12-31', status: 'not_yet_in_force', history: 'retained', uncertain: false, chosen_version_id: null, earliest_known_valid_from: '2026-01-01' });
      expect(before.compiled_truth).toBeUndefined();
      expect(before.earliest_known.compiled_truth).toContain('14 days');

      for (const d of ['2026-01-01', '2026-06-30']) {
        const r = await read(slug, d);
        expect(r.valid_time).toMatchObject({ status: 'in_force', chosen_version_id: v1, chosen_is_current: false, valid_from: '2026-01-01', uncertain: false, history: 'retained' });
        expect(r.compiled_truth).toContain('14 days');
      }
      for (const d of ['2026-07-01', '2026-12-31']) {
        const r = await read(slug, d);
        expect(r.valid_time).toMatchObject({ status: 'in_force', chosen_is_current: true, valid_from: '2026-07-01', valid_until: '2027-01-01', uncertain: false, why: null });
        expect(r.compiled_truth).toContain('receipts required');
      }
      const after = await read(slug, '2027-01-01');
      expect(after.valid_time).toMatchObject({ status: 'not_in_force', chosen_is_current: true, valid_until: '2027-01-01' });
      expect(after.compiled_truth).toBeUndefined();
      expect(after.last_in_force.compiled_truth).toContain('receipts required');
    });

    test('B-T1: a date-only change and a same-body renewal are flagged ambiguous_edition_dates', async () => {
      const slug = fresh('dateonly');
      await put(slug, 'Same text.', ["valid_from: '2026-01-01'"]);
      const advisory = await put(slug, 'Same text.', ["valid_from: '2026-03-01'"]);
      expect(advisory.valid_time).toMatchObject({ code: 'valid_time_date_only', valid_from: '2026-03-01', previous_valid_from: '2026-01-01' });
      const early = await read(slug, '2026-02-01');
      expect(early.valid_time).toMatchObject({ status: 'in_force', chosen_is_current: false, uncertain: true, why: 'ambiguous_edition_dates', competing_version_ids: [null] });
      expect(early.fix).toMatchObject({ next: 'ask_user' });
      expect(early.fix.user_message).toContain('Which date did this edition');
      expect(early.fix.then.mcp.tool).toBe('edit_page');
      expect(JSON.stringify(early.fix.then.mcp.arguments.edits)).toContain("valid_from: '<DATE>'");
      const late = await read(slug, '2026-04-01');
      expect(late.valid_time).toMatchObject({ chosen_is_current: true, uncertain: true, why: 'ambiguous_edition_dates' });

      const renewal = fresh('renewal');
      await put(renewal, 'Annual terms.', ["valid_from: '2025-01-01'", "valid_until: '2026-01-01'"]);
      await put(renewal, 'Annual terms.', ["valid_from: '2026-01-01'", "valid_until: '2027-01-01'"]);
      expect((await read(renewal, '2026-06-01')).valid_time).toMatchObject({ status: 'in_force', chosen_is_current: true, why: 'ambiguous_edition_dates' });
    });

    test('B-T1: a withdrawn scheduled edition and a backfill recorded last stay the rule pick, flagged', async () => {
      const withdrawn = fresh('withdrawn');
      await put(withdrawn, 'Edition A.', ["valid_from: '2026-01-01'"]);
      await put(withdrawn, 'Edition B, scheduled.', ["valid_from: '2026-09-01'"]);
      await put(withdrawn, 'Edition A.', ["valid_from: '2026-01-01'"]);
      const [, vB] = await versionIds(withdrawn);
      const oct = await read(withdrawn, '2026-10-01');
      expect(oct.valid_time).toMatchObject({ status: 'in_force', chosen_version_id: vB, uncertain: true, why: 'ambiguous_edition_dates', competing_version_ids: [null] });
      expect(oct.compiled_truth).toContain('scheduled');
      const may = await read(withdrawn, '2026-05-01');
      expect(may.valid_time).toMatchObject({ chosen_is_current: true, uncertain: false });

      const backfill = fresh('backfill');
      await put(backfill, 'Edition 2026a.', ["valid_from: '2026-01-01'"]);
      await put(backfill, 'Edition 2026b.', ["valid_from: '2026-07-01'"]);
      await put(backfill, 'Edition 2025.', ["valid_from: '2025-01-01'"]);
      const [, v2026b] = await versionIds(backfill);
      expect((await read(backfill, '2025-06-01')).valid_time).toMatchObject({ chosen_is_current: true, uncertain: false });
      expect((await read(backfill, '2026-08-01')).valid_time).toMatchObject({ chosen_version_id: v2026b, why: 'ambiguous_edition_dates' });
    });

    test('B-T1 privacy: a private chosen edition reads as a missing page; a private-time reason never shows', async () => {
      const slug = fresh('privacy');
      await put(slug, 'World edition one.', ["valid_from: '2026-01-01'"]);
      await put(slug, 'Private edition.', ["valid_from: '2026-06-01'", 'visibility: private'], 'reason-r2-private-time');
      await put(slug, 'World edition two.', ["valid_from: '2026-09-01'"], 'reason-r3-back-to-world');
      const hidden = await refusal(read(slug, '2026-07-01', true));
      expect(hidden?.code).toBe('page_not_found');
      const local = await read(slug, '2026-07-01');
      expect(local.compiled_truth).toContain('Private edition.');
      const early = await read(slug, '2026-03-01', true);
      expect(early.compiled_truth).toContain('World edition one.');
      expect(early.valid_time.replaced_because).toBeNull();
      expect((await read(slug, '2026-03-01')).valid_time.replaced_because).toBe('reason-r2-private-time');
      const late = await read(slug, '2026-10-01', true);
      expect(late.valid_time.introduced_because).toBe('reason-r3-back-to-world');
      for (const d of ['2025-01-01', '2026-03-01', '2026-10-01']) expect(JSON.stringify(await read(slug, d, true))).not.toContain('reason-r2');
    });

    test('B-T2: an imported page with no gbrain-written first version reads before_recorded_history with a recovery', async () => {
      const slug = fresh('imported');
      await importFromContent(engine, slug, page('Imported edition.', ["valid_from: '2026-03-01'"]), { sourcePath: slug + '.md', noEmbed: true });
      const r = await read(slug, '2026-01-01');
      expect(r.valid_time).toMatchObject({ status: 'before_recorded_history', history: 'incomplete', uncertain: true, why: 'before_recorded_history', earliest_known_valid_from: '2026-03-01' });
      expect(r.compiled_truth).toBeUndefined();
      expect(r.fix).toMatchObject({ next: 'ask_user' });
      await engine.executeRaw("UPDATE sources SET local_path = '/srv/brain-example' WHERE id = 'default'");
      try {
        expect((await read(slug, '2026-01-01')).fix.argv).toEqual(['git', '-C', '/srv/brain-example', 'log', '--follow', '-p', '--', slug + '.md']);
        const remote = await read(slug, '2026-01-01', true);
        expect(remote.fix).toMatchObject({ next: 'tell_user_to_run', argv: ['git', 'log', '--follow', '-p', '--', slug + '.md'] });
        expect(JSON.stringify(remote)).not.toContain('/srv/brain-example');
      } finally { await engine.executeRaw("UPDATE sources SET local_path = NULL WHERE id = 'default'"); }
    });

    test('B-T2/B-T7b: a pruned page and an unmarked upgraded page are uncertain; the recovery asks for a backup, never git', async () => {
      const pruned = fresh('pruned');
      await put(pruned, 'Small edition.', ["valid_from: '2026-01-01'"]);
      const big = 'x'.repeat(1024 * 1024 + 10);
      for (let i = 0; i < 7; i++) {
        await engine.executeRaw("UPDATE pages SET compiled_truth = $2, frontmatter = jsonb_set(frontmatter, '{valid_from}', to_jsonb($3::text)) WHERE slug = $1", [pruned, big + i, '2026-0' + (i + 2) + '-01']);
        await createPageVersion(engine, pruned, 'default');
      }
      const [{ gap }] = await engine.executeRaw<{ gap: unknown }>('SELECT version_history_gap_at AS gap FROM pages WHERE slug = $1', [pruned]);
      expect(gap).not.toBeNull();
      const r = await read(pruned, '2026-01-15');
      expect(r.valid_time).toMatchObject({ status: 'before_recorded_history', history: 'incomplete', uncertain: true, why: 'history_gap' });
      expect(r.fix).toMatchObject({ next: 'ask_user' });
      expect(r.fix.user_message).toContain('retained copy or a backup');
      expect(r.fix.argv).toBeUndefined();
      expect(r.compiled_truth).toBeUndefined();

      const unmarked = fresh('unmarked');
      await put(unmarked, 'Edition.', ["valid_from: '2026-01-01'"]);
      const [{ id }] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [unmarked]);
      for (let i = 0; i < 5; i++) {
        await engine.executeRaw("INSERT INTO page_versions (page_id, compiled_truth, frontmatter, timeline, title, type, tags) VALUES ($1, $2, '{}'::jsonb, '', 'Policy', 'note', '[]'::jsonb)", [id, big + i]);
      }
      const u = await read(unmarked, '2026-05-01');
      expect(u.valid_time).toMatchObject({ status: 'in_force', history: 'unknown', uncertain: true, why: 'history_unknown', undated_versions: 5 });
      expect(u.fix).toMatchObject({ next: 'ask_user' });
    }, 120_000);

    test('B-T3: refusals', async () => {
      const slug = fresh('refuse');
      await put(slug, 'Text.', ["valid_from: '2026-01-01'"]);
      const instant = await refusal(read(slug, '2026-07-01T00:00:00Z'));
      expect(instant?.toJSON()).toMatchObject({ code: 'clock_mismatch', reason: 'instant_for_date' });
      expect((await refusal(read(slug, '2026-07')))?.code).toBe('invalid_params');
      const both = await refusal(read(slug, '2026-07-01', false, { known_as_of: '2026-07-01T00:00:00Z' }));
      expect(both?.toJSON()).toMatchObject({ error: 'invalid_params' });
      expect(both?.fix?.mcp?.arguments).toEqual({ slug, as_of: '2026-07-01' });
      const content = await refusal(read(slug, '2026-07-01', false, { include_content: true }));
      expect(content?.code).toBe('invalid_params');
      expect(content?.suggestion).toContain('silently revert');
      expect((await refusal(read(slug, '2026-07-01', false, { content_only: true })))?.code).toBe('invalid_params');

      const shared = fresh('shared');
      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('vt-second', 'vt-second', '{\"federated\": true}'::jsonb) ON CONFLICT (id) DO NOTHING");
      await put(shared, 'Default copy.', ["valid_from: '2026-01-01'"]);
      await importFromContent(engine, shared, page('Second copy.', ["valid_from: '2026-01-01'"]), { sourceId: 'vt-second', noEmbed: true });
      const ambiguous = await refusal(call('get_page', { slug: shared, as_of: '2026-07-01', source_id: '__all__' }));
      expect(ambiguous?.code).toBe('invalid_params');
      expect(ambiguous?.message).toContain('several sources');
      expect(ambiguous?.fix?.mcp?.arguments).toMatchObject({ slug: shared, as_of: '2026-07-01' });
      expect((await call('get_page', { slug: shared, as_of: '2026-07-01', source_id: 'vt-second' })).compiled_truth).toContain('Second copy.');

      const undated = fresh('undated');
      await put(undated, 'No dates here.');
      const u = await refusal(read(undated, '2026-07-01'));
      expect(u?.code).toBe('valid_time_undeclared');
      expect(u?.fix).toMatchObject({ ask_user: true });
      expect(u?.fix?.user_message).toContain('When did');
      expect(u?.fix?.then?.mcp?.tool).toBe('edit_page');
      expect(u?.suggestion).toContain('known_as_of');
    });

    test('B-T4: unquoted, quoted and partial dates through real imports; the SQL normaliser matches TypeScript', async () => {
      const slug = fresh('forms');
      await put(slug, 'Unquoted.', ['valid_from: 2026-01-01']);
      await put(slug, 'Quoted.', ["valid_from: '2026-02-01'"]);
      const partial = await put(slug, 'Partial.', ['valid_from: 2026-03']);
      expect(partial.valid_time).toMatchObject({ code: 'valid_from_unparsed' });
      const rows = (await call('get_versions', { slug })) as unknown as R[];
      expect(rows.map(r => r.valid_from)).toEqual(['2026-02-01', '2026-01-01']);
      const r = await read(slug, '2026-04-01');
      expect(r.valid_time).toMatchObject({ valid_from: '2026-02-01', undated_versions: 1 });
      expect(r.compiled_truth).toContain('Quoted.');
      expect((await read(slug, '2026-01-15')).compiled_truth).toContain('Unquoted.');
      const inputs = ['2026-01-01', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00+00:00', '2026-02-29', '2028-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-01', '2026', '0999-01-01', '2026-01-01T09:00:00Z', 'soon', ''];
      for (const input of inputs) {
        const [row] = await engine.executeRaw<{ d: string | null }>('SELECT ' + validDateSql('$1::text') + ' AS d', [input]);
        expect([input, row!.d ?? null]).toEqual([input, validDate(input)]);
      }
    });

    test('B-T6: windows of a large chosen version stay pinned to it across next cursors, and a gone edition says so', async () => {
      await engine.executeRaw("INSERT INTO config (key, value) VALUES ('mcp.inline_body_bytes', '2000') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
      try {
        const slug = fresh('windows');
        const old = Array.from({ length: 400 }, (_, i) => 'Old edition line ' + i + '.').join('\n');
        await put(slug, old, ["valid_from: '2026-01-01'"]);
        await put(slug, 'New edition.', ["valid_from: '2026-07-01'"]);
        const [v1] = await versionIds(slug);
        let r = await read(slug, '2026-03-01', true, { max_bytes: 1500 });
        expect(r.valid_time).toMatchObject({ status: 'in_force', chosen_version_id: v1 });
        expect(r.compiled_truth).toBeUndefined();
        expect(r.body).toBe('window');
        let text = r.window.text;
        let hops = 0;
        while (r.next) {
          expect(r.next.arguments).toMatchObject({ slug, source_id: 'default', as_of: '2026-03-01' });
          if (hops === 1) await put(slug, 'A third edition written mid-read.', ["valid_from: '2026-02-01'"]);
          r = await call('get_page', r.next.arguments, true);
          expect(r.version_id).toBe(v1);
          text += r.window.text;
          hops++;
        }
        expect(hops).toBeGreaterThan(2);
        expect(text).toBe(old);
        expect((await read(slug, '2026-03-01', true)).compiled_truth).toContain('third edition');

        const first = await read(slug, '2026-01-15', true, { max_bytes: 1500 });
        expect(first.version_id).toBe(v1);
        await engine.executeRaw('DELETE FROM page_versions WHERE id = $1', [first.version_id]);
        const gone = await call('get_page', first.next.arguments, true);
        expect(gone.valid_time).toMatchObject({ history: 'incomplete', uncertain: true, why: 'edition_pruned' });
        expect(gone.window).toBeUndefined();
        expect(gone.compiled_truth).toBeUndefined();
      } finally { await engine.executeRaw("DELETE FROM config WHERE key = 'mcp.inline_body_bytes'"); }
    });

    test('B-T7/B6/B5: plain read status, an unchanged plain read, get_versions dates and the correction advisory', async () => {
      const future = fresh('future');
      await put(future, 'Takes effect later.', ["valid_from: '2099-01-01'"]);
      const r = await call('get_page', { slug: future });
      expect(r.valid_time).toEqual({ status: 'not_yet_in_force', as_of: utcToday(), valid_from: '2099-01-01', valid_until: null });
      expect(r.compiled_truth).toContain('Takes effect later.');
      expect((await call('get_page', { slug: future, body: 'none' }, true)).valid_time.status).toBe('not_yet_in_force');
      const plain = fresh('plain');
      await put(plain, 'No dates.');
      const plainRead = await call('get_page', { slug: plain });
      expect('valid_time' in plainRead).toBe(false);
      expect(currentValidTime({})).toBeNull();

      const corrected = fresh('corrected');
      expect((await put(corrected, 'Draft.', ["valid_from: '2026-01-01'", "valid_until: '2026-06-01'"])).valid_time).toBeUndefined();
      expect((await put(corrected, 'Draft, fixed typo.', ["valid_from: '2026-01-01'", "valid_until: '2026-06-01'"])).valid_time)
        .toMatchObject({ code: 'valid_time_correction', valid_from: '2026-01-01' });
      const versions = (await call('get_versions', { slug: corrected })) as unknown as R[];
      expect(versions[0]).toMatchObject({ valid_from: '2026-01-01', valid_until: '2026-06-01' });
      expect((await call('get_page', { slug: corrected })).valid_time).toMatchObject({ status: 'not_in_force', valid_until: '2026-06-01' });
    });

    test('B-T8: 500 versions: the pick is one statement and stays within its budget', async () => {
      const slug = fresh('many');
      await put(slug, 'Edition 0.', ["valid_from: '2000-01-01'"]);
      const [{ id }] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
      await engine.executeRaw("INSERT INTO page_versions (page_id, compiled_truth, frontmatter, timeline, title, type, tags) SELECT $1, 'Edition ' || g, jsonb_build_object('valid_from', to_char(date '2000-01-01' + g * 7, 'YYYY-MM-DD')), '', 'Policy', 'note', '[]'::jsonb FROM generate_series(1, 500) g", [id]);
      const seen: string[] = [];
      const transaction = engine.transaction.bind(engine);
      const own = Object.getOwnPropertyDescriptor(engine, 'transaction');
      (engine as { transaction: unknown }).transaction = (fn: (tx: BrainEngine) => Promise<unknown>) => transaction(async tx => {
        const exec = tx.executeRaw.bind(tx);
        (tx as { executeRaw: unknown }).executeRaw = (sql: string, params?: unknown[]) => { seen.push(sql); return exec(sql, params as never); };
        return fn(tx);
      });
      let r: R, ms: number;
      try {
        await read(slug, '2005-06-01');
        seen.length = 0;
        const t0 = performance.now();
        r = await read(slug, '2005-06-01');
        ms = performance.now() - t0;
      } finally {
        if (own) Object.defineProperty(engine, 'transaction', own);
        else delete (engine as { transaction?: unknown }).transaction;
      }
      expect(seen.filter(s => s.includes('WITH rows AS'))).toHaveLength(1);
      const days = Math.floor((Date.UTC(2005, 5, 1) - Date.UTC(2000, 0, 1)) / 86_400_000 / 7) * 7;
      expect(r.valid_time).toMatchObject({ status: 'in_force', valid_from: new Date(Date.UTC(2000, 0, 1) + days * 86_400_000).toISOString().slice(0, 10) });
      expect(ms).toBeLessThan(2_000);
    }, 60_000);

    test('B-T9: a page stored in segments reads its edition through the segment reader and gets the date fix', async () => {
      const big = (fm: string[]) => page(Array.from({ length: 12_000 }, (_, i) => `Clause ${i}: refunds follow the policy of acme-example. ${'x'.repeat(40)}`).join('\n'), fm);
      const dated = fresh('segmented');
      const undated = fresh('segmented-undated');
      try {
        await importSegmented(engine, dated, big(["valid_from: '2026-01-01'"]));
        await importSegmented(engine, undated, big([]));
      } finally { await engine.setConfig('pages.segmented_storage', 'off'); }

      const r = await read(dated, '2026-03-01');
      expect(r.valid_time).toMatchObject({ status: 'in_force', chosen_is_current: true, valid_from: '2026-01-01' });
      expect(r.body).toBe('window');
      expect(r.compiled_truth).toBeUndefined();
      expect(r.window.text).toContain('Clause 0: refunds');
      expect(r.next.arguments).toMatchObject({ slug: dated, as_of: '2026-03-01' });

      const e = await refusal(read(undated, '2026-03-01'));
      expect(e?.code).toBe('valid_time_undeclared');
      expect(JSON.stringify(e?.fix ?? (e as R)?.detail?.fix)).toContain("valid_from: '<DATE>'");
    }, 300_000);
  });
}
