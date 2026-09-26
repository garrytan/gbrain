import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { previewAttendanceRepair, applyAttendanceRepair, attendanceRepairHash, type AttendanceRepairPreview } from '../src/core/attendance-repair.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests, _resetPackCacheForTests } from '../src/core/schema-pack/index.ts';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';
import { makeResolver } from '../src/core/link-extraction.ts';
import { softDeleteSource, restoreSource } from '../src/core/destructive-guard.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { attendanceRepairConnectionIdentity } from '../src/commands/extract-attendance-repair.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const sourceId = 'repair-fixture';
const person = 'people/alice-example';
const meeting = 'meetings/planning';
const positive = 'Attendees: [Alice Example](../people/alice-example.md)';
const pack = { api_version: 'gbrain-schema-pack-v1', name: 'repair-fixture', version: '1.0.0', extends: null,
  page_types: [], link_types: [], frontmatter_links: [] };

for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])]) {
  describe(`preview-bound attendance repair (${kind}; repair-fixture non-overridden person_to_meeting)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let root: string;
    let checkpoints: unknown[];
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'gbrain-repair-'));
      writeFileSync(join(root, 'pack.json'), JSON.stringify(pack));
      __setPackLocatorForTests(name => name === pack.name ? join(root, 'pack.json') : bundledPackPath(name));
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => {
      await close?.(); rmSync(root, { recursive: true, force: true });
      _resetPackLocatorForTests(); _resetPackCacheForTests();
    });
    beforeEach(async () => {
      checkpoints = [];
      writeFileSync(join(root, 'pack.json'), JSON.stringify(pack));
      _resetPackCacheForTests();
      await engine.setConfig('schema_pack', pack.name);
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      await seed(person, 'person', 'Example person');
      await seed(meeting, 'meeting', positive);
    });
    async function seed(slug: string, type: string, body: string, frontmatter: Record<string, unknown> = {}) {
      await engine.putPage(slug, { type, title: slug, compiled_truth: body, frontmatter }, { sourceId, allowEmptyOverwrite: true });
    }
    async function legacy(producer: string | null = 'markdown') {
      await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,link_type,context,link_source)
        SELECT f.id,t.id,'attended','old evidence',$3 FROM pages f,pages t
        WHERE f.source_id=$1 AND t.source_id=$1 AND f.slug=$2 AND t.slug=$4`, [sourceId, meeting, producer, person]);
    }
    async function rows() {
      return engine.executeRaw(`SELECT l.* FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 ORDER BY l.id`, [sourceId]);
    }
    function preview(opts: { limit?: number; afterSlug?: string } = {}) {
      return previewAttendanceRepair(engine, { sourceId, remote: false, ...opts });
    }
    function apply(receipt: AttendanceRepairPreview, extra: Record<string, unknown> = {}) {
      return applyAttendanceRepair(engine, receipt, { remote: false, sourceId, yes: true, backupVerified: true,
        confirm: receipt.digest, checkpoint: async state => { checkpoints.push(state); }, ...extra });
    }

    test('preview is read-only, omits source text, and exact delta preserves unrelated IDs and evidence', async () => {
      await legacy();
      await engine.addLink(meeting, person, 'unrelated evidence', 'mentions', 'markdown', undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId });
      await engine.addLink(person, meeting, 'manual evidence', 'attended', 'manual', undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId });
      const before = await rows();
      const pages = await engine.executeRaw('SELECT * FROM pages WHERE source_id=$1 ORDER BY id', [sourceId]);
      const guards = await engine.executeRaw('SELECT * FROM page_write_guards ORDER BY source_incarnation,slug');
      const cp = await engine.executeRaw('SELECT * FROM op_checkpoints ORDER BY op,fingerprint');
      const receipt = await preview();
      expect(receipt.counts).toMatchObject({ scanned: 2, eligibleOrigins: 1, changed: 1, add: 1, remove: 1 });
      expect(receipt.direction).toBe('person_to_meeting');
      expect(JSON.stringify(receipt)).not.toContain('old evidence');
      expect(JSON.stringify(receipt)).not.toContain(positive);
      expect(await rows()).toEqual(before);
      expect(await engine.executeRaw('SELECT * FROM pages WHERE source_id=$1 ORDER BY id', [sourceId])).toEqual(pages);
      expect(await engine.executeRaw('SELECT * FROM page_write_guards ORDER BY source_incarnation,slug')).toEqual(guards);
      expect(await engine.executeRaw('SELECT * FROM op_checkpoints ORDER BY op,fingerprint')).toEqual(cp);
      expect(await apply(receipt)).toMatchObject({ created: 1, removed: 1, committed: 1 });
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints.at(-1)).toMatchObject({ committed: 1, pagesProcessed: 2, afterSlug: person });
      const after = await rows();
      expect(after.filter(row => row.link_source === 'manual' || row.link_type === 'mentions'))
        .toEqual(before.filter(row => row.link_source === 'manual' || row.link_type === 'mentions'));
      expect(await engine.executeRaw('SELECT * FROM pages WHERE source_id=$1 ORDER BY id', [sourceId])).toEqual(pages);
    });

    for (const body of [
      `${positive} <!-- [Hidden](../people/hidden-example.md) -->`,
      '## Attendees\n- [Alice Example](../people/alice-example.md) <!-- [Hidden](../people/hidden-example.md) -->',
    ]) test(`repair never approves or persists inline-commented attendance: ${JSON.stringify(body)}`, async () => {
      await seed('people/hidden-example', 'person', 'Not an attendee.');
      await seed(meeting, 'meeting', body);
      const receipt = await preview();
      expect(receipt.counts.add).toBe(1);
      expect(await apply(receipt)).toMatchObject({ created: 1, removed: 0 });
      expect((await engine.getBacklinks(meeting, { sourceId })).map(row => row.from_slug)).toEqual([person]);
    });

    test('second request and new preview are row-identity idempotent', async () => {
      await legacy();
      const receipt = await preview(); await apply(receipt);
      const after = await rows();
      expect(await apply(receipt)).toMatchObject({ created: 0, removed: 0, replayed: 1 });
      const again = await preview();
      expect(again.counts).toMatchObject({ add: 0, remove: 0, unchanged: 1 });
      await apply(again);
      expect(await rows()).toEqual(after);
    });

    test('receipts are credential-independent while cloned endpoint and brain pins remain distinct', async () => {
      await legacy();
      const url = new URL('postgresql://db.example.invalid:5432/brain_example');
      url.username = 'operator_example'; url.password = 'synthetic-original';
      url.searchParams.set('sslpassword', 'synthetic-query-original');
      const firstIdentity = attendanceRepairConnectionIdentity('host', { engine: 'postgres', database_url: url.toString() });
      const receipt = await previewAttendanceRepair(engine, { sourceId, remote: false, brainIdentity: firstIdentity });
      url.username = 'rotated_example'; url.password = 'synthetic-rotation';
      url.searchParams.set('sslpassword', 'synthetic-query-rotation');
      const rotatedIdentity = attendanceRepairConnectionIdentity('host', { engine: 'postgres', database_url: url.toString() });
      const rotated = await previewAttendanceRepair(engine, { sourceId, remote: false, brainIdentity: rotatedIdentity });
      const { approvalId, issuedAt, digest, ...stable } = receipt;
      const { approvalId: rotatedApprovalId, issuedAt: rotatedIssuedAt, digest: rotatedDigest, ...rotatedStable } = rotated;
      expect(rotatedStable).toEqual(stable);
      expect(rotatedApprovalId).not.toBe(approvalId); expect(rotatedDigest).not.toBe(digest);
      expect(rotatedIssuedAt).toBeGreaterThanOrEqual(issuedAt);
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const target = { engine: 'postgres', scheme: 'postgresql:', hosts: [['db.example.invalid', 5432]], database: 'brain_example' };
      expect(receipt.brain).toBe(attendanceRepairHash([attendanceRepairHash(incarnation), attendanceRepairHash(['host', target])]));
      for (const secret of ['operator_example', 'rotated_example', 'synthetic-original', 'synthetic-rotation',
        'synthetic-query-original', 'synthetic-query-rotation']) expect(JSON.stringify(receipt)).not.toContain(secret);
      url.hostname = 'cloned.example.invalid';
      const clonedIdentity = attendanceRepairConnectionIdentity('host', { engine: 'postgres', database_url: url.toString() });
      await expect(apply(receipt, { brainIdentity: clonedIdentity })).rejects.toThrow('brain or ontology changed');
      await expect(apply(receipt, { brainIdentity: attendanceRepairConnectionIdentity('other-brain', {
        engine: 'postgres', database_url: url.toString() }) })).rejects.toThrow('brain or ontology changed');
      expect(checkpoints).toHaveLength(0);
      expect(await apply(receipt, { brainIdentity: rotatedIdentity })).toMatchObject({ created: 1, removed: 1 });
    });

    test('global seven-day pruning expires replay proof and requires a fresh preview without changing graph rows', async () => {
      await legacy(); const receipt = await preview(); await apply(receipt); const before = await rows();
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '8 days' WHERE op='attendance-repair' AND fingerprint=$1",
        [attendanceRepairHash([receipt.digest, receipt.origins[0].page.id])]);
      expect(await purgeStaleCheckpoints(engine)).toBeGreaterThanOrEqual(1);
      checkpoints = [];
      await expect(apply(receipt)).rejects.toThrow('Attendance edges or resolution changed');
      expect(await rows()).toEqual(before); expect(checkpoints).toHaveLength(0);
      const fresh = await preview(); expect(fresh.counts).toMatchObject({ add: 0, remove: 0, unchanged: 1 });
      expect(await apply(fresh)).toMatchObject({ created: 0, removed: 0 });
      expect(await rows()).toEqual(before);
    });

    for (const state of ['changed', 'no-op', 'report-only']) for (const proof of ['retained', 'pruned']) {
      test(`${proof} expired proof refuses ${state} replay and fresh approval recovers without renewing old proof`, async () => {
        if (state === 'changed') await legacy();
        else if (state === 'no-op') await apply(await preview());
        else { await engine.setConfig('schema_pack', 'company-brain'); await legacy(); }
        const receipt = await preview();
        await apply(receipt);
        const before = await rows();
        const originalKey = attendanceRepairHash([receipt.digest, receipt.origins[0].page.id]);
        if (proof === 'pruned') {
          receipt.issuedAt = Date.now() - 8 * 86400_000;
          receipt.digest = attendanceRepairHash({ ...receipt, digest: '' });
        }
        const key = attendanceRepairHash([receipt.digest, receipt.origins[0].page.id]);
        await engine.executeRaw("UPDATE op_checkpoints SET fingerprint=$2, updated_at=now()-interval '8 days' WHERE op='attendance-repair' AND fingerprint=$1",
          [originalKey, key]);
        if (proof === 'pruned') expect(await purgeStaleCheckpoints(engine)).toBeGreaterThanOrEqual(1);
        const oldProof = await engine.executeRaw("SELECT * FROM op_checkpoints WHERE op='attendance-repair' AND fingerprint=$1", [key]);
        checkpoints = [];
        await expect(apply(receipt)).rejects.toThrow('expired');
        expect(checkpoints).toHaveLength(0); expect(await rows()).toEqual(before);
        const fresh = await preview();
        expect(fresh.digest).not.toBe(receipt.digest);
        expect(await apply(fresh)).toMatchObject({ created: 0, removed: 0, replayed: 0 });
        expect(await apply(fresh)).toMatchObject({ created: 0, removed: 0, replayed: 1 });
        expect(await rows()).toEqual(before);
        expect(await engine.executeRaw("SELECT * FROM op_checkpoints WHERE op='attendance-repair' AND fingerprint=$1", [key])).toEqual(oldProof);
      });
    }

    test('valid replay never refreshes durable proof age or row content', async () => {
      const receipt = await preview(); await apply(receipt);
      const key = attendanceRepairHash([receipt.digest, receipt.origins[0].page.id]);
      await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '6 days' WHERE op='attendance-repair' AND fingerprint=$1", [key]);
      const before = await engine.executeRaw("SELECT * FROM op_checkpoints WHERE op='attendance-repair' AND fingerprint=$1", [key]);
      expect(await apply(receipt)).toMatchObject({ replayed: 1 });
      expect(await engine.executeRaw("SELECT * FROM op_checkpoints WHERE op='attendance-repair' AND fingerprint=$1", [key])).toEqual(before);
    });

    for (const noOrigins of [false, true]) test(`expired first approval refuses before writes or cursor progress with zero origins=${noOrigins}`, async () => {
      if (noOrigins) await seed('a-prefix/example', 'concept', 'Skipped page');
      const receipt = await preview({ limit: 1 });
      receipt.issuedAt = Date.now() - 8 * 86400_000;
      receipt.digest = attendanceRepairHash({ ...receipt, digest: '' });
      const before = await rows();
      await expect(apply(receipt)).rejects.toThrow('expired');
      expect(checkpoints).toHaveLength(0); expect(await rows()).toEqual(before);
      expect((await apply(await preview({ limit: 1 }))).pagesProcessed).toBe(1);
    });

    test('fresh approvals recover a pruned no-op window and continue into the next window', async () => {
      await seed('meetings/second', 'meeting', positive);
      const first = await preview({ limit: 1 });
      await apply(first);
      const noOp = await preview({ limit: 1 }); await apply(noOp);
      noOp.issuedAt = Date.now() - 8 * 86400_000;
      const oldKey = attendanceRepairHash([noOp.digest, noOp.origins[0].page.id]);
      noOp.digest = attendanceRepairHash({ ...noOp, digest: '' });
      await engine.executeRaw("UPDATE op_checkpoints SET fingerprint=$2, updated_at=now()-interval '8 days' WHERE op='attendance-repair' AND fingerprint=$1",
        [oldKey, attendanceRepairHash([noOp.digest, noOp.origins[0].page.id])]);
      await purgeStaleCheckpoints(engine);
      await expect(apply(noOp)).rejects.toThrow('expired');
      const fresh = await preview({ limit: 1 });
      expect(await apply(fresh)).toMatchObject({ created: 0, removed: 0, replayed: 0, afterSlug: meeting });
      const next = await preview({ limit: 1, afterSlug: fresh.nextAfterSlug });
      expect(next.approvalId).not.toBe(fresh.approvalId);
      expect(await apply(next)).toMatchObject({ created: 1, removed: 0, afterSlug: 'meetings/second' });
      expect(await apply(next)).toMatchObject({ created: 0, removed: 0, replayed: 1 });
    });

    test('approval lifetime is rechecked inside every origin transaction before advancing its cursor', async () => {
      await seed('meetings/second', 'meeting', positive);
      const receipt = await preview();
      const transaction = engine.transaction;
      let transactions = 0;
      engine.transaction = (async function<T>(this: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) {
        return transaction.call(this, async tx => {
          transactions++;
          const executeRaw = tx.executeRaw;
          tx.executeRaw = (async function(sql: string, params?: unknown[]) {
            return executeRaw.call(tx, transactions > 1 && sql.includes('AS checked_at')
              ? sql.replace('clock_timestamp()', "(clock_timestamp()+interval '8 days')") : sql, params);
          }) as BrainEngine['executeRaw'];
          try { return await fn(tx); } finally { tx.executeRaw = executeRaw; }
        });
      }) as BrainEngine['transaction'];
      try { await expect(apply(receipt)).rejects.toThrow('approval expired'); }
      finally { engine.transaction = transaction; }
      expect(transactions).toBe(2);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toMatchObject({ committed: 1, afterSlug: meeting });
      expect(await rows()).toHaveLength(1);
    });

    test('approval identity and issuance validation rejects malformed, future and legacy receipts without writes', async () => {
      const receipt = await preview();
      const before = await rows();
      for (const change of [
        { approvalId: undefined }, { approvalId: 'x'.repeat(100_000) }, { approvalId: 42 }, { approvalId: 'not-a-uuid' },
        { issuedAt: undefined }, { issuedAt: '1' }, { issuedAt: NaN }, { issuedAt: Infinity }, { issuedAt: 0 },
        { issuedAt: -1 }, { issuedAt: 1.5 }, { issuedAt: Number.MAX_SAFE_INTEGER }, { version: 1 },
      ]) {
        const malformed = { ...receipt, ...change } as AttendanceRepairPreview;
        malformed.digest = attendanceRepairHash({ ...malformed, digest: '' });
        await expect(apply(malformed)).rejects.toThrow('identity mismatch');
      }
      const future = { ...receipt, issuedAt: receipt.issuedAt + 86400_000 };
      future.digest = attendanceRepairHash({ ...future, digest: '' });
      await expect(apply(future)).rejects.toThrow('not yet valid');
      expect(checkpoints).toHaveLength(0); expect(await rows()).toEqual(before);
      expect(await apply(receipt)).toMatchObject({ created: 1, removed: 0, replayed: 0 });
    });

    for (const producer of [null, 'manual', 'custom-producer']) {
      test(`preserves ${producer ?? 'NULL'} producer`, async () => {
        await legacy(producer);
        const before = await rows();
        const receipt = await preview();
        expect(receipt.counts.remove).toBe(0);
        await apply(receipt);
        expect((await rows()).filter(row => row.link_source === producer)).toEqual(before);
      });
    }

    for (const body of ['Mentioned [Alice](../people/alice-example.md).', 'Invited [Alice](../people/alice-example.md).',
      'Attendees: [Alice](../people/alice-example.md) did not attend', 'No evidence']) {
      test(`unproven legacy evidence is report-only: ${body}`, async () => {
        await seed(meeting, 'meeting', body); await legacy();
        const before = await rows(); const receipt = await preview();
        expect(receipt.counts).toMatchObject({ add: 0, remove: 0 });
        expect(receipt.diagnostics[0].reason).toBe('legacy_evidence_unproven');
        await apply(receipt); expect(await rows()).toEqual(before);
      });
    }

    test('frontmatter paths are report-only and never remove an existing frontmatter claim', async () => {
      await seed(meeting, 'meeting', '', { attendees: [person] });
      await engine.addLink(person, meeting, 'frontmatter evidence', 'attended', 'frontmatter', meeting, 'attendees',
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      const before = await rows();
      const receipt = await preview();
      expect(receipt.frontmatter).toBe('report_only');
      expect(receipt.counts).toMatchObject({ add: 0, remove: 0 });
      await apply(receipt);
      expect(await rows()).toEqual(before);
      await seed(meeting, 'meeting', 'No frontmatter left');
      await apply(await preview()); expect(await rows()).toEqual(before);
    });

    test('ambiguous hinted slug forms skip the origin without removing legacy rows', async () => {
      await seed('people/duc-example', 'person', 'One person');
      await seed('people/đuc-example', 'person', 'Another person');
      await seed(meeting, 'meeting', '', { attendees: ['Đuc Example'] }); await legacy();
      const before = await rows(); const receipt = await preview();
      expect(receipt.frontmatter).toBe('report_only');
      expect(receipt.counts.remove).toBe(0);
      await apply(receipt); expect(await rows()).toEqual(before);
    });

    test('title-only references remain report-only without a full-source resolver', async () => {
      await engine.executeRaw('UPDATE pages SET title=$1 WHERE source_id=$2 AND slug=$3', ['Different Label', sourceId, person]);
      await seed(meeting, 'meeting', '', { attendees: ['Different Label'] });
      const receipt = await preview();
      expect(receipt.frontmatter).toBe('report_only');
      expect(receipt.counts).toMatchObject({ add: 0, remove: 0 });
    });

    test('same-slug foreign endpoints and other-origin attendance remain unchanged', async () => {
      const foreign = 'repair-other';
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING', [foreign]);
      await engine.putPage(person, { type: 'person', title: 'Foreign Example', compiled_truth: 'Foreign person' }, { sourceId: foreign });
      await seed('meetings/other-origin', 'meeting', 'Other evidence');
      await engine.addLink(person, meeting, 'other origin evidence', 'attended', 'frontmatter', 'meetings/other-origin', 'attendees',
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      await engine.addLink(meeting, person, 'foreign evidence', 'attended', 'manual', undefined, undefined,
        { fromSourceId: sourceId, toSourceId: foreign });
      await legacy();
      const before = (await rows()).filter(row => row.link_source !== 'markdown');
      const receipt = await preview();
      await apply(receipt);
      expect((await rows()).filter(row => row.link_source !== 'markdown')).toEqual(before);
      expect(receipt.origins[0].endpoints.every(endpoint => endpoint.source_id === sourceId)).toBe(true);
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [foreign]);
    });

    test('missing and non-person body targets are counted and never guessed', async () => {
      await seed(person, 'concept', 'Not a person');
      expect((await preview()).counts).toMatchObject({ add: 0, ambiguous: 1 });
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, person]);
      expect((await preview()).counts).toMatchObject({ add: 0, ambiguous: 1 });
    });

    test('ambiguous bare body evidence never deletes an owned claim', async () => {
      await seed('duc-example', 'person', 'One person'); await seed('đuc-example', 'person', 'Another person');
      await seed(meeting, 'meeting', 'Attendees: [[Đuc Example]]');
      await engine.addLink('duc-example', meeting, 'preserved body evidence', 'attended', 'markdown', meeting, undefined,
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      const before = await rows(); const receipt = await preview();
      expect(receipt.counts).toMatchObject({ add: 0, remove: 0, ambiguous: 1 });
      await apply(receipt); expect(await rows()).toEqual(before);
    });

    test('hinted frontmatter names do not authorize a claim before or after another candidate appears', async () => {
      await seed('people/duc-example', 'person', 'One person');
      await seed(meeting, 'meeting', '', { attendees: ['Đuc Example'] });
      const receipt = await preview(); expect(receipt.counts.add).toBe(0);
      await seed('people/đuc-example', 'person', 'Another person');
      await apply(receipt);
      expect((await preview()).counts.add).toBe(0);
      expect(await rows()).toEqual([]);
    });

    for (const field of ['title', 'aliases']) test(`slash-containing frontmatter with a conflicting ${field} never bypasses A1 uniqueness`, async () => {
      await seed('people/other-example', 'person', 'Conflicting person', field === 'aliases' ? { aliases: [person.toUpperCase()] } : {});
      if (field === 'title') await engine.executeRaw('UPDATE pages SET title=$1 WHERE source_id=$2 AND slug=$3',
        [person.toUpperCase(), sourceId, 'people/other-example']);
      expect(await makeResolver(engine, { mode: 'batch', sourceId }).resolveAttendance!(person, 'people')).toBeNull();
      await seed(meeting, 'meeting', '', { attendees: [person] });
      await engine.addLink(person, meeting, 'preserved field evidence', 'attended', 'frontmatter', meeting, 'attendees',
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      const before = await rows(); const receipt = await preview();
      expect(receipt.frontmatter).toBe('report_only'); expect(receipt.counts).toMatchObject({ add: 0, remove: 0 });
      await apply(receipt); expect(await rows()).toEqual(before);
    });

    test('pack-owned outgoing semantics are excluded and pinned', async () => {
      writeFileSync(join(root, 'pack.json'), JSON.stringify({ ...pack, link_types: [{ name: 'attended' }],
        frontmatter_links: [{ page_type: 'meeting', fields: ['attendees'], link_type: 'attended' }] }));
      await legacy(); const before = await rows(); const receipt = await preview();
      expect(receipt.counts.pack_semantics_preserved).toBe(1);
      expect(receipt.direction).toBe('pack_semantics_preserved');
      await apply(receipt); expect(await rows()).toEqual(before);
    });

    test('unavailable pack is not treated as permission for legacy fallback', async () => {
      await engine.setConfig('schema_pack', 'unavailable-fixture'); await legacy();
      const before = await rows(); const receipt = await preview();
      expect(receipt.direction).toBe('pack_unavailable');
      await apply(receipt); expect(await rows()).toEqual(before);
    });

    for (const name of ['gbrain-base', 'company-brain']) test(`${name} shipped outgoing attendance is report-only`, async () => {
      await engine.setConfig('schema_pack', name); await legacy();
      const before = await rows(); const receipt = await preview();
      expect(receipt.pack).toBe(name); expect(receipt.direction).toBe('pack_semantics_preserved');
      expect(receipt.counts).toMatchObject({ add: 0, remove: 0, pack_semantics_preserved: 1 });
      await apply(receipt); expect(await rows()).toEqual(before);
    });

    for (const mutation of ['origin-edit', 'endpoint-edit', 'origin-delete', 'endpoint-delete', 'origin-recreate', 'endpoint-recreate',
      'source-recreate', 'source-archive', 'source-archive-flag', 'ontology', 'ontology-file', 'edge-edit', 'edge-insert', 'edge-delete', 'edge-resolution', 'endpoint-type']) {
      test(`${mutation} refuses stale preview without additional writes or checkpoint advance`, async () => {
        await legacy(); const receipt = await preview();
        const target = mutation.startsWith('origin') ? meeting : person;
        if (mutation.endsWith('-edit') && mutation !== 'edge-edit') await seed(target, target === meeting ? 'meeting' : 'person', 'Changed');
        else if (mutation.endsWith('-delete') && mutation !== 'edge-delete')
          await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2', [sourceId, target]);
        else if (mutation === 'origin-recreate' || mutation === 'endpoint-recreate') {
          await engine.executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, target]);
          await seed(target, target === meeting ? 'meeting' : 'person', target === meeting ? positive : 'Example person');
        } else if (mutation === 'source-recreate') {
          await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
          await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
          await seed(person, 'person', 'Example person'); await seed(meeting, 'meeting', positive);
        } else if (mutation === 'source-archive') await engine.executeRaw('UPDATE sources SET archived_at=now() WHERE id=$1', [sourceId]);
        else if (mutation === 'source-archive-flag') await engine.executeRaw('UPDATE sources SET archived=true, archived_at=NULL WHERE id=$1', [sourceId]);
        else if (mutation === 'ontology') await engine.setConfig('schema_pack', 'unavailable-fixture');
        else if (mutation === 'ontology-file') writeFileSync(join(root, 'pack.json'), JSON.stringify({ ...pack, version: '1.0.1' }));
        else if (mutation === 'edge-edit') await engine.executeRaw('UPDATE links SET context=$1 WHERE id=$2', ['changed evidence', receipt.origins[0].before[0].id]);
        else if (mutation === 'edge-delete') await engine.executeRaw('DELETE FROM links WHERE id=$1', [receipt.origins[0].before[0].id]);
        else if (mutation === 'edge-insert') await legacy('manual');
        else if (mutation === 'edge-resolution') await engine.executeRaw('UPDATE links SET resolution_type=$1 WHERE id=$2', ['qualified', receipt.origins[0].before[0].id]);
        else if (mutation === 'endpoint-type') await seed(person, 'concept', 'Example concept');
        const before = await rows();
        await expect(apply(receipt)).rejects.toThrow();
        expect(await rows()).toEqual(before); expect(checkpoints).toHaveLength(0);
      });
    }

    for (const archivedId of [sourceId, 'default']) for (const phase of ['preview', 'apply']) {
      test(`flag-only archived ${archivedId} refuses ${phase} without writes or checkpoint advance`, async () => {
        await legacy(); const receipt = await preview(); const before = await rows();
        const guards = await engine.executeRaw('SELECT * FROM page_write_guards ORDER BY source_incarnation,slug');
        const cp = await engine.executeRaw('SELECT * FROM op_checkpoints ORDER BY op,fingerprint');
        await engine.executeRaw('UPDATE sources SET archived=true, archived_at=NULL WHERE id=$1', [archivedId]);
        try {
          expect(await engine.executeRaw('SELECT archived, archived_at FROM sources WHERE id=$1', [archivedId]))
            .toEqual([{ archived: true, archived_at: null }]);
          await expect(phase === 'preview' ? preview() : apply(receipt)).rejects.toThrow(
            `Attendance repair requires an existing live source and brain identity: ${archivedId === 'default'
              ? "literal 'default' identity source" : `selected source '${archivedId}'`} is missing or archived`);
          expect(await rows()).toEqual(before); expect(checkpoints).toHaveLength(0);
          expect(await engine.executeRaw('SELECT * FROM page_write_guards ORDER BY source_incarnation,slug')).toEqual(guards);
          expect(await engine.executeRaw('SELECT * FROM op_checkpoints ORDER BY op,fingerprint')).toEqual(cp);
        } finally {
          await engine.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [archivedId]);
        }
      });
    }

    test('ordinary archive and restore lifecycle refuses repair while archived and permits a fresh preview after restore', async () => {
      await legacy(); const receipt = await preview(); const before = await rows();
      expect(await softDeleteSource(engine, sourceId)).toMatchObject({ id: sourceId, pageCount: 2 });
      expect(await engine.executeRaw('SELECT archived, archived_at IS NOT NULL AS timestamped FROM sources WHERE id=$1', [sourceId]))
        .toEqual([{ archived: true, timestamped: true }]);
      await expect(preview()).rejects.toThrow('existing live source and brain identity');
      await expect(apply(receipt)).rejects.toThrow('existing live source and brain identity');
      expect(await rows()).toEqual(before); expect(checkpoints).toHaveLength(0);
      expect(await restoreSource(engine, sourceId)).toBe(true);
      expect(await engine.executeRaw('SELECT archived, archived_at FROM sources WHERE id=$1', [sourceId]))
        .toEqual([{ archived: false, archived_at: null }]);
      const restored = await preview();
      expect(restored.counts).toMatchObject({ add: 1, remove: 1 });
      expect(await apply(restored)).toMatchObject({ created: 1, removed: 1, committed: 1 });
    });

    test('parser and digest mismatch refuse before any transaction', async () => {
      const receipt = await preview();
      const staleParser = { ...receipt, parser: 'old-parser' };
      staleParser.digest = attendanceRepairHash({ ...staleParser, digest: '' });
      await expect(apply(staleParser)).rejects.toThrow('identity mismatch');
      await expect(apply(receipt, { confirm: '0'.repeat(64) })).rejects.toThrow('identity mismatch');
      await expect(apply(receipt, { brainIdentity: 'other-connection' })).rejects.toThrow();
      expect(await rows()).toEqual([]);
    });

    test('failed insertion rolls back deletion and durable receipt', async () => {
      await legacy(); const receipt = await preview(); const before = await rows();
      await engine.executeRaw(`CREATE FUNCTION repair_fixture_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'fixture insertion rejection'; END $$`);
      await engine.executeRaw('CREATE TRIGGER repair_fixture_reject BEFORE INSERT ON links FOR EACH ROW EXECUTE FUNCTION repair_fixture_reject()');
      try { await expect(apply(receipt)).rejects.toThrow(); }
      finally {
        await engine.executeRaw('DROP TRIGGER repair_fixture_reject ON links');
        await engine.executeRaw('DROP FUNCTION repair_fixture_reject()');
      }
      expect(await rows()).toEqual(before); expect(checkpoints).toHaveLength(0);
      expect(await apply(receipt)).toMatchObject({ created: 1, removed: 1, replayed: 0 });
    });

    test('database read-only permissions refuse apply without a checkpoint or row changes', async () => {
      await legacy(); const receipt = await preview(); const before = await rows();
      const transaction = engine.transaction;
      engine.transaction = (async function<T>(this: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) {
        return transaction.call(this, async tx => {
          await tx.executeRaw('SET TRANSACTION READ ONLY');
          return fn(tx);
        });
      }) as BrainEngine['transaction'];
      try { await expect(apply(receipt)).rejects.toThrow(); }
      finally { engine.transaction = transaction; }
      expect(await rows()).toEqual(before); expect(checkpoints).toHaveLength(0);
    });

    if (kind === 'postgres') test('a separate PostgreSQL reader sees a consistent graph while the repair holds write fences', async () => {
      await legacy(); const receipt = await preview(); const before = await rows();
      const transaction = engine.transaction;
      let readDuringCommit = false;
      engine.transaction = (async function<T>(this: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) {
        return transaction.call(this, async tx => {
          const result = await fn(tx);
          if (!readDuringCommit) { expect(await rows()).toEqual(before); readDuringCommit = true; }
          return result;
        });
      }) as BrainEngine['transaction'];
      try { await apply(receipt); }
      finally { engine.transaction = transaction; }
      expect(readDuringCommit).toBe(true); expect(await rows()).not.toEqual(before);
    }, 20_000);

    test('interruption after commit before cursor safely replays the committed origin', async () => {
      await legacy(); const receipt = await preview();
      await expect(apply(receipt, { checkpoint: async () => { throw new Error('interrupted before cursor'); } })).rejects.toThrow('interrupted');
      const after = await rows();
      expect(await apply(receipt)).toMatchObject({ created: 0, removed: 0, replayed: 1 });
      expect(await rows()).toEqual(after);
    });

    for (const reason of ['pack_semantics_preserved', 'pack_unavailable', 'origin_size_limit', 'edge_limit', 'edge_size_limit', 'reference_limit']) {
      test(`report-only ${reason} with existing edges replays a commit before private checkpoint progress`, async () => {
        await legacy();
        if (reason === 'pack_semantics_preserved') await engine.setConfig('schema_pack', 'company-brain');
        if (reason === 'pack_unavailable') await engine.setConfig('schema_pack', 'unavailable-fixture');
        if (reason === 'origin_size_limit') await seed(meeting, 'meeting', 'x'.repeat(256 * 1024 + 1));
        if (reason === 'edge_limit') await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,link_type,link_source)
          SELECT f.id,t.id,'related-'||n,'markdown' FROM pages f,pages t,generate_series(1,600) n
          WHERE f.source_id=$1 AND t.source_id=$1 AND f.slug=$2 AND t.slug=$3`, [sourceId, meeting, person]);
        if (reason === 'edge_size_limit') await engine.executeRaw(`UPDATE links SET context=repeat('x',1048576)
          WHERE from_page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)`, [sourceId, meeting]);
        if (reason === 'reference_limit') await seed(meeting, 'meeting', `Attendees: ${Array.from({ length: 257 }, (_, i) => `[Example](../people/example-${i}.md)`).join(', ')}`);
        const before = await rows(); const receipt = await preview();
        expect(receipt.origins[0].reason).toBe(reason);
        expect(receipt.counts).toMatchObject({ add: 0, remove: 0 });
        await expect(apply(receipt, { checkpoint: async () => { throw new Error('interrupted before private cursor'); } })).rejects.toThrow('interrupted');
        expect(checkpoints).toHaveLength(0);
        expect(await apply(receipt)).toMatchObject({ created: 0, removed: 0, replayed: 1 });
        expect(await rows()).toEqual(before);
        expect(receipt.origins[0].before.length).toBeLessThanOrEqual(512);
        expect(receipt.origins[0].adjacentRows).toBeLessThanOrEqual(513);
        expect(JSON.stringify(receipt).length).toBeLessThan(100_000);
      });
    }

    test('mixed person and non-person explicit attendees leave the entire origin report-only', async () => {
      await seed('concepts/example', 'concept', 'Not a person');
      await seed(meeting, 'meeting', `${positive}, [Example concept](../concepts/example.md)`);
      await legacy();
      const before = await rows(); const receipt = await preview();
      expect(receipt.origins[0].reason).toBe('unresolved_attendees');
      expect(receipt.counts).toMatchObject({ add: 0, remove: 0 });
      await apply(receipt);
      expect(await apply(receipt)).toMatchObject({ replayed: 1 });
      expect(await rows()).toEqual(before);
    });

    test('interruption after cursor and failure at next origin never advances past failure', async () => {
      await seed('meetings/second', 'meeting', positive);
      const receipt = await preview();
      await expect(apply(receipt, { checkpoint: async (state: unknown) => { checkpoints.push(state); throw new Error('interrupted after cursor'); } })).rejects.toThrow();
      expect(checkpoints).toHaveLength(1);
      await seed('meetings/second', 'meeting', 'Changed');
      await expect(apply(receipt)).rejects.toThrow();
      expect(checkpoints).toHaveLength(2);
      expect((checkpoints[1] as { committed: number }).committed).toBe(1);
    });

    test('source recreation invalidates an already committed cursor', async () => {
      const receipt = await preview(); await apply(receipt);
      expect(checkpoints).toHaveLength(2);
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      await seed(person, 'person', 'Example person'); await seed(meeting, 'meeting', positive);
      await expect(apply(receipt)).rejects.toThrow('source, brain or ontology changed');
      expect(checkpoints).toHaveLength(2); expect(await rows()).toEqual([]);
    });

    test('committed edge recreation is not accepted as idempotent replay', async () => {
      const receipt = await preview(); await apply(receipt);
      const [edge] = await rows();
      await engine.executeRaw('DELETE FROM links WHERE id=$1', [edge.id]);
      await engine.addLink(person, meeting, positive, 'attended', 'markdown', meeting, undefined,
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      await expect(apply(receipt)).rejects.toThrow('Committed attendance edges changed');
    });

    test('owned obsolete attendance alone is removed and its committed replay stays stable', async () => {
      await apply(await preview());
      await seed(meeting, 'meeting', 'No attendance evidence');
      const receipt = await preview();
      expect(receipt.counts).toMatchObject({ add: 0, remove: 1 });
      await apply(receipt); expect(await rows()).toEqual([]);
      expect(await apply(receipt)).toMatchObject({ replayed: 1 });
    });

    test('authority, source, confirmation and backup refusals happen without mutation', async () => {
      const receipt = await preview();
      for (const remote of [true, undefined, null]) {
        await expect(previewAttendanceRepair(engine, { sourceId, remote: remote as boolean })).rejects.toThrow('trusted local');
        await expect(apply(receipt, { remote })).rejects.toThrow('trusted local');
      }
      await expect(previewAttendanceRepair(engine, { sourceId: '', remote: false })).rejects.toThrow('explicit');
      await expect(apply(receipt, { yes: false })).rejects.toThrow('--yes');
      await expect(apply(receipt, { backupVerified: false })).rejects.toThrow('--backup-verified');
      expect(await rows()).toEqual([]); expect(checkpoints).toHaveLength(0);
    });

    test('bounds reject invalid batches and cap retained diagnostics and source metadata', async () => {
      for (const limit of [0, -1, 1001, 1.5, NaN, Infinity]) await expect(preview({ limit })).rejects.toThrow('1–1000');
      for (let i = 0; i < 24; i++) await seed(`meetings/missing-${i}`, 'meeting', 'Attendees: [Missing](../people/missing-example.md)');
      const original = engine.executeRaw;
      const reads: string[] = [];
      engine.executeRaw = (async (sql: string, params?: unknown[]) => {
        reads.push(sql); return original.call(engine, sql, params);
      }) as BrainEngine['executeRaw'];
      let receipt: AttendanceRepairPreview;
      try { receipt = await preview(); } finally { engine.executeRaw = original; }
      expect(receipt.limit).toBe(250); expect(receipt.diagnostics).toHaveLength(20);
      expect(receipt.origins.every(origin => origin.lookupSlugs.length <= 256)).toBe(true);
      expect(reads.some(sql => /lower\(title\)|jsonb_array_elements_text|SELECT slug, source_id, type, title/.test(sql))).toBe(false);
      const one = await preview({ limit: 1 });
      expect(one.counts.scanned).toBe(1); expect(one.complete).toBe(false);
      expect((await preview({ limit: 1000, afterSlug: one.nextAfterSlug })).counts.scanned).toBe(25);
    });

    test('oversized origins and reference sets are report-only', async () => {
      await seed(meeting, 'meeting', 'x'.repeat(256 * 1024 + 1));
      expect((await preview()).diagnostics[0].reason).toBe('origin_size_limit');
      await seed(meeting, 'meeting', `Attendees: ${Array.from({ length: 257 }, (_, i) => `[Example](../people/example-${i}.md)`).join(', ')}`);
      expect((await preview()).diagnostics[0].reason).toBe('reference_limit');
    });

    test('oversized bodies and edge evidence never cross the DB boundary, and frontmatter is not materialized', async () => {
      await engine.executeRaw(`UPDATE pages SET compiled_truth=repeat('x',1048576),
        frontmatter=jsonb_build_object('attendees',repeat('x',2097152)) WHERE source_id=$1 AND slug=$2`, [sourceId, meeting]);
      const original = engine.executeRaw;
      const originTransfers: Record<string, unknown>[] = [];
      const statements: string[] = [];
      engine.executeRaw = (async function(this: BrainEngine, sql: string, params?: unknown[]) {
        statements.push(sql);
        const result = await original.call(this, sql, params);
        if (sql.includes('AS bytes')) originTransfers.push(...result as Record<string, unknown>[]);
        return result;
      }) as BrainEngine['executeRaw'];
      try {
        expect((await preview()).diagnostics[0].reason).toBe('origin_size_limit');
        expect(originTransfers).toHaveLength(1);
        expect(originTransfers[0]).toMatchObject({ compiled_truth: null, timeline: null, bytes: 1048576 });
        expect(Object.hasOwn(originTransfers[0], 'frontmatter')).toBe(false);
        expect(statements.some(sql => sql.includes('frontmatter'))).toBe(false);
      } finally { engine.executeRaw = original; }
      await seed(meeting, 'meeting', positive); await legacy();
      await engine.executeRaw(`UPDATE links SET context=repeat('x',1048576), origin_field=repeat('y',1048576)
        WHERE from_page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)`, [sourceId, meeting]);
      const receipt = await preview();
      expect(receipt.diagnostics[0].reason).toBe('edge_size_limit');
      expect(receipt.origins[0].before[0]).toMatchObject({ row_hash: null, origin_field: null });
      expect(JSON.stringify(receipt).length).toBeLessThan(10_000);
      await apply(receipt);
      expect(receipt.counts).toMatchObject({ add: 0, remove: 0 });
    });

    test('large non-attendance adjacency cannot force an unbounded attendance scan', async () => {
      await legacy();
      await engine.executeRaw(`INSERT INTO links(from_page_id,to_page_id,link_type,link_source)
        SELECT f.id,t.id,'related-'||n,'markdown' FROM pages f,pages t,generate_series(1,600) n
        WHERE f.source_id=$1 AND t.source_id=$1 AND f.slug=$2 AND t.slug=$3`, [sourceId, meeting, person]);
      const before = await rows(); const receipt = await preview();
      expect(receipt.diagnostics[0].reason).toBe('edge_limit');
      expect(receipt.origins[0].adjacentRows).toBe(513); expect(receipt.origins[0].before).toEqual([]);
      expect(receipt.counts).toMatchObject({ add: 0, remove: 0 });
      await apply(receipt); expect(await rows()).toEqual(before);
    });

    test('sparse windows include soft-deleted and nonmeeting pages before eligibility filtering', async () => {
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,deleted_at)
        SELECT $1,'a-sparse/'||lpad(n::text,4,'0'),CASE WHEN n%2=0 THEN 'meeting' ELSE 'concept' END,
          'Sparse Example','Fixture',CASE WHEN n%2=0 THEN now() ELSE NULL END
        FROM generate_series(1,600) n`, [sourceId]);
      const scans: number[] = []; const eligible: number[] = []; const seen: string[] = [];
      let afterSlug = '';
      for (let batch = 0; batch < 3; batch++) {
        const receipt = await preview({ afterSlug });
        scans.push(receipt.counts.scanned); eligible.push(receipt.counts.eligibleOrigins);
        seen.push(...receipt.window.map(page => page.slug));
        const applied = await apply(receipt);
        expect(applied.pagesProcessed).toBe(receipt.window.length);
        expect(checkpoints.at(-1)).toMatchObject({ afterSlug: receipt.nextAfterSlug, pagesProcessed: receipt.window.length });
        expect((await apply(receipt)).created).toBe(0);
        afterSlug = receipt.nextAfterSlug;
        expect(receipt.complete).toBe(batch === 2);
      }
      expect(scans).toEqual([250, 250, 102]); expect(eligible).toEqual([0, 0, 1]);
      expect(new Set(seen).size).toBe(602); expect(seen).toHaveLength(602);
      const empty = await preview({ afterSlug });
      expect(empty.counts).toMatchObject({ scanned: 0, eligibleOrigins: 0 }); expect(empty.complete).toBe(true);
      expect((await apply(empty)).afterSlug).toBe(afterSlug);
    }, 30_000);

    test('cursor covers skipped prefixes but never crosses a failed origin or skipped tail', async () => {
      await seed('a-prefix/example', 'concept', 'Skip prefix');
      await seed('meetings/z-failure', 'meeting', positive);
      await seed('zz-tail/example', 'concept', 'Skip tail');
      const receipt = await preview();
      await seed('meetings/z-failure', 'meeting', 'Changed after preview');
      await expect(apply(receipt)).rejects.toThrow();
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toMatchObject({ committed: 1, pagesProcessed: 2, afterSlug: meeting });
      await expect(apply(receipt)).rejects.toThrow();
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[1]).toMatchObject({ committed: 1, pagesProcessed: 2, afterSlug: meeting, replayed: 1 });
    });

    for (const change of ['source', 'ontology', 'skipped-page']) test(`zero-origin window refuses a stale ${change} before cursor advancement`, async () => {
      await seed('a-prefix/example', 'concept', 'Skip prefix');
      const receipt = await preview({ limit: 1 }); expect(receipt.counts.eligibleOrigins).toBe(0);
      if (change === 'ontology') await engine.setConfig('schema_pack', 'unavailable-fixture');
      else if (change === 'skipped-page') await seed('a-prefix/example', 'meeting', positive);
      else {
        await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      }
      await expect(apply(receipt)).rejects.toThrow(); expect(checkpoints).toHaveLength(0);
    });

    test('one-row slug windows traverse punctuation and Unicode in database order without duplicates', async () => {
      for (const slug of ['topics/a-example', 'topics/a_example', 'topics/é-example', 'topics/z-example']) await seed(slug, 'concept', 'Fixture');
      const expected = (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId])).map(page => page.slug);
      const seen: string[] = [];
      let afterSlug = '';
      for (let index = 0; index < expected.length; index++) {
        const receipt = await preview({ limit: 1, afterSlug });
        expect(receipt.window).toHaveLength(1); expect(receipt.complete).toBe(false);
        seen.push(receipt.window[0].slug); afterSlug = receipt.nextAfterSlug;
        expect((await apply(receipt)).afterSlug).toBe(afterSlug);
      }
      expect(seen).toEqual(expected);
      const done = await preview({ limit: 1, afterSlug }); expect(done.complete).toBe(true); expect(done.window).toEqual([]);
    });

    test('default 250 and maximum 1000 page windows keep lookup work independent of a 10000-page source', async () => {
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
        SELECT $1,'people/scale-'||n,'person','Scale Example '||n,'Example fixture' FROM generate_series(1,10000) n`, [sourceId]);
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
        SELECT $1,'meetings/scale-'||n,'meeting','Scale Meeting '||n,$2 FROM generate_series(1,1000) n`, [sourceId, positive]);
      const original = engine.executeRaw;
      let endpointQueries = 0; let endpointRows = 0; let largestLookup = 0;
      engine.executeRaw = (async function(this: BrainEngine, sql: string, params?: unknown[]) {
        const result = await original.call(this, sql, params);
        if (sql.includes('slug=ANY($2::text[])')) {
          endpointQueries++; endpointRows += result.length; largestLookup = Math.max(largestLookup, (params?.[1] as string[]).length);
        }
        return result;
      }) as BrainEngine['executeRaw'];
      try {
        const started = performance.now();
        const small = await preview();
        expect(small.counts.scanned).toBe(250); expect(small.complete).toBe(false);
        expect(endpointQueries).toBe(250); expect(endpointRows).toBe(250); expect(largestLookup).toBe(1);
        const large = await preview({ limit: 1000 });
        expect(large.counts.scanned).toBe(1000); expect(large.complete).toBe(false);
        expect(endpointQueries).toBe(1250); expect(endpointRows).toBe(1250); expect(largestLookup).toBe(1);
        console.log(JSON.stringify({ fixture: 'attendance-repair-scale', engine: kind, sourcePages: 11002,
          previewedOrigins: 1250, endpointQueries, endpointRows, largestLookup, elapsedMs: Math.round(performance.now() - started),
          rssBytes: process.memoryUsage().rss }));
      } finally { engine.executeRaw = original; }
    }, 120_000);
  });
}
