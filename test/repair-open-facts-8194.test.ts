/**
 * Discussion #8194 (GBRA-575): `gbrain repair open-facts`, the operator-only repair that opens facts stamped private
 * before `facts.default_visibility world`.
 *
 * 1. Protects: an operator on the brain host can open legacy private facts in one named source, preview first, then
 *    `--apply --expect <hash>`, keeping each fact's id, provenance, creation time and trust tier; a remote source-granted
 *    caller recalls them afterwards and not before; facts on private, reader-restricted, folder-ruled, quarantined or member
 *    pages, from a private or unresolved provenance page, expired, superseded, withdrawn or purged at any visibility, in a
 *    trust contest (pending, rejected or undone widening, pending forget), and transcript-lane rows stay private; the
 *    tighten repair plans nothing for what was opened; `--undo` re-privates exactly what the ledger recorded. Managed and
 *    unmanaged, repo-less.
 * 2. Fails when: the preview writes anything, the apply opens a fact outside the previewed set, a fact changes id or tier,
 *    an excluded fact opens, `gbrain repair visibility` would close an opened fact, the kind runs from `--all` or a remote
 *    caller, a remote put_page or remember widening over a private row is no longer held (#9196, GST-2511), or a page
 *    flipped private during the apply leaves its fact world.
 * 3. Real seams: the gbrain repair CLI module (parse and dispatch), MCP operation handlers and dispatch with remote=true and
 *    a source-granted token, PGLite (Postgres too when DATABASE_URL is set, with a second session for the race).
 * Red before the build: the kind does not exist yet. The pins (remote rewrite, #9196 holds) are green today.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../src/core/persistence/context.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { REPAIR_KINDS, resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, EXPLICIT_REPAIR_REGISTRY, REPAIR_REGISTRY, explicitRepairNotices, repairSpec } from '../src/core/repair/registry.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { parseFactsFence, renderFactsTable } from '../src/core/facts-fence.ts';
import { insertTrustProposal, listTrustProposals } from '../src/core/trust/proposals.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const engines: BrainEngine[] = [];
const urls = new Map<BrainEngine, string>();
const home = mkdtempSync(join(tmpdir(), 'gbrain-open-facts-'));
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };
/** Every fact the fixtures write is older than this instant (--created-before is required). */
const CUT = '2999-01-01T00:00:00.000Z';

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); urls.set(pg.engine, pg.databaseUrl); closePostgres = pg.close;
  }
}), 120_000);
afterAll(async () => {
  resetGateway();
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

interface Brain { engine: BrainEngine; sourceId: string; remote: OperationContext; local: OperationContext }
/** A source on a shared-shaped brain (no owner, no members) with a token granted only that source. */
async function brain(engine: BrainEngine, managed: boolean): Promise<Brain> {
  const sourceId = `open-${randomUUID().slice(0, 8)}`;
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.setConfig('brain.audience', 'shared');
  await registerLocalWriter(engine, 'cli');
  const minted = await mintLegacyToken(engine, { name: `token-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await readsUnscopedOnPurpose(engine, minted.id);
  if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const base = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
  await readLocalWriter(engine, 'cli');
  return {
    engine, sourceId,
    remote: { ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id } as Principal, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] } },
    local: { ...base, remote: false },
  } as Brain;
}
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;

type Row = [number, string, 'private' | 'world'];
const fence = (rows: Row[]) => ['## Facts', '', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  ...rows.map(([n, claim, vis]) => `| ${n} | ${claim} | fact | 1.0 | ${vis} | medium | 2026-09-01 |  | fixture |  |`),
  '<!--- gbrain:facts:end -->'].join('\n');
const pageText = (slug: string, front: string, rows: Row[]) =>
  `---\ntype: company\ntitle: ${slug}\n${front}---\n\n# ${slug}\n\nOrchardline body.\n\n${fence(rows)}\n`;
const page = (b: Brain, slug: string, front: string, rows: Row[]) =>
  run(b.local, 'put_page', { slug, content: pageText(slug, front, rows) });

/** A database-only private fact (no fence row), as older extraction lanes stored them. */
async function dbOnly(b: Brain, fact: string, holder: string | null, opts: { expired?: boolean; source?: string; context?: string; supersededBy?: number; entity?: string | null } = {}): Promise<number> {
  const rows = await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => tx.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, context, superseded_by, expired_at)
     VALUES ($1, $2, $3, 'fact', 'private', $4, $5, $6, $7, ${opts.expired ? 'now()' : 'NULL'}) RETURNING id`, // gbrain-allow-direct-insert: legacy database-only fact fixture
    [b.sourceId, opts.entity === undefined ? holder : opts.entity, fact, opts.source ?? 'mcp:extract_facts', holder, opts.context ?? null, opts.supersededBy ?? null]), TEST_WRITE_ATTRIBUTION));
  return Number(rows[0].id);
}
const coordinated = (b: Brain, sql: string, params: unknown[]) =>
  b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const facts = async (b: Brain, claim: string) => b.engine.executeRaw<{ id: number; visibility: string; row_num: number | null; created_at: string; source: string; trust_tier: string; context: string | null }>(
  'SELECT id::int AS id, visibility, row_num, created_at::text AS created_at, source, trust_tier, context FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id', [b.sourceId, claim]);
const visibilityOf = async (b: Brain, id: number) => (await b.engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id=$1', [id]))[0]?.visibility;
async function remoteRecall(b: Brain, entity: string): Promise<string> {
  __resetPrivateVisibilityCacheForTests();
  return JSON.stringify(await run(b.remote, 'recall', { entity }));
}
async function cli(engine: BrainEngine, args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runRepairCommand(engine, args); } finally { log.mockRestore(); }
  return lines.join('\n');
}
const expectHash = (out: string) => out.match(/--expect ([0-9a-f]{16,})/)?.[1];
/** The open-facts result of a --json run. */
async function openFacts(b: Brain, args: string[]): Promise<Record<string, any>> {
  return JSON.parse(await cli(b.engine, ['open-facts', '--source', b.sourceId, ...args, '--json'])).results[0];
}
const preview = (b: Brain, extra: string[] = []) => openFacts(b, ['--created-before', CUT, ...extra]);
async function previewAndApply(b: Brain, extra: string[] = []) {
  const planned = await preview(b, extra);
  const applied = planned.preview_hash ? await openFacts(b, ['--created-before', CUT, ...extra, '--apply', '--expect', planned.preview_hash]) : null;
  return { planned, applied };
}
async function confirmFact(b: Brain, id: number) {
  await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => withTrustPromotion(tx, 'user_confirmed', () =>
    tx.executeRaw(`UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1`, [id])), TEST_WRITE_ATTRIBUTION));
}
const fenceCell = async (b: Brain, slug: string, rowNum: number) => {
  const [stored] = await b.engine.executeRaw<{ body: string }>('SELECT compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [b.sourceId, slug]);
  return parseFactsFence(stored!.body).facts.find(f => f.rowNum === rowNum);
};

describe('repair open-facts: registration and who may run it (test 7)', () => {
  test('the kind exists, runs only when named and never from --all or the remediation plan', () => {
    expect(REPAIR_KINDS as readonly string[]).toContain('open-facts');
    expect(EXPLICIT_REPAIR_REGISTRY.map(s => s.kind)).toContain('open-facts');
    expect(AUTO_REPAIR_REGISTRY.map(s => s.kind)).not.toContain('open-facts');
    const spec = REPAIR_REGISTRY.find(s => s.kind === 'open-facts')!;
    expect(spec).toMatchObject({ explicit_only: true, preview_bound: true, embeds: 'none', checks: [] });
    expect(explicitRepairNotices().find(n => n.kind === 'open-facts')).toMatchObject({ code: 'explicit_kind_required' });
  });

  test('a remote caller, an unnamed run and member mode are refused; --created-before is required with a coded error', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[0]!;
    const b = await brain(engine, false);
    const scope = await resolveRepairScope(engine, b.sourceId);
    const spec = repairSpec('open-facts' as never);
    await expect(runRepair(b.remote, spec.handler, scope, { apply: false, explicit: true, spec })).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(runRepair(b.local, spec.handler, scope, { apply: false, spec })).rejects.toMatchObject({ code: 'explicit_kind_required' });
    await expect(withEnv({ GBRAIN_ENFORCED_MEMBER: 'alice-example' }, () => cli(engine, ['open-facts', '--source', b.sourceId, '--created-before', CUT])))
      .rejects.toMatchObject({ code: 'permission_denied', reason: 'member_mode_refused' });
    await expect(cli(engine, ['open-facts', '--source', b.sourceId])).rejects.toMatchObject({ code: 'invalid_params', reason: 'created_before_required' });
    await expect(cli(engine, ['open-facts', '--source', b.sourceId, '--created-before', 'yesterday'])).rejects.toMatchObject({ code: 'invalid_params', reason: 'created_before_invalid' });
    await expect(cli(engine, ['open-facts', '--source', b.sourceId, '--created-before', CUT, '--class', 'everything'])).rejects.toMatchObject({ code: 'invalid_params', reason: 'class_invalid' });
    await expect(cli(engine, ['open-facts', '--source', b.sourceId, '--created-before', CUT, '--ids-file', join(home, 'missing-ids.txt')])).rejects.toMatchObject({ code: 'invalid_params', reason: 'ids_file_unreadable' });
    await expect(cli(engine, ['open-facts', '--created-before', CUT])).rejects.toMatchObject({ code: 'invalid_params', reason: 'source_required' });
  }), 120_000);
});

for (const managed of [false, true]) {
  describe(`repair open-facts on a shared brain with no owner (${managed ? 'managed' : 'unmanaged'}, repo-less)`, () => {
    test('tests 1-3, 6, 9: opens exactly the previewed legacy private facts, keeps ids, and leaves every excluded fact private', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        await page(b, 'companies/acme-example', '', [[1, 'Acme Example orchardline revenue grew', 'private'], [2, 'Acme Example is in Springfield', 'world']]);
        await page(b, 'secret/plan-example', 'visibility: private\n', [[1, 'Orchardline merger plan', 'private']]);
        await page(b, 'people/alice-example', 'readable_by: [alice-example]\n', [[1, 'Alice Example orchardline salary', 'private']]);
        const loose = await dbOnly(b, 'Acme Example orchardline database-only legacy fact', 'companies/acme-example', { context: 'companies/acme-example extracted' });
        await dbOnly(b, 'Orchardline fact held on a private page', 'secret/plan-example');
        const expired = await dbOnly(b, 'Orchardline expired fact', 'companies/acme-example', { expired: true });

        const [fencedBefore] = await facts(b, 'Acme Example orchardline revenue grew');
        const [looseBefore] = await facts(b, 'Acme Example orchardline database-only legacy fact');
        expect(fencedBefore.visibility).toBe('private');
        expect(looseBefore.visibility).toBe('private');
        expect(await remoteRecall(b, 'companies/acme-example')).not.toContain('orchardline revenue grew');

        const planned = await preview(b);
        const hash = planned.preview_hash as string;
        expect(hash).toMatch(/^[0-9a-f]{16,}$/);
        expect(planned.apply_command).toContain(`--created-before ${CUT}`);
        expect(planned.details.eligible).toMatchObject({ fenced: 1, unfenced: 1 });
        expect(planned.details.excluded).toMatchObject({ holding_page_private: 3, expired: 1 });
        expect(planned.details.samples.fenced).toEqual(['Acme Example orchardline revenue grew']);
        expect(planned.listing.map((l: { detail: string }) => l.detail).sort()).toEqual([`fact ${fencedBefore.id} (fenced row 1)`, `fact ${loose} (unfenced)`].sort());
        // The preview wrote nothing.
        expect((await facts(b, 'Acme Example orchardline revenue grew'))[0].visibility).toBe('private');
        expect(await visibilityOf(b, loose)).toBe('private');

        const applied = await openFacts(b, ['--created-before', CUT, '--apply', '--expect', hash]);
        expect(applied.applied).toBe(2);
        expect(applied.outcomes?.fact_left_private).toBeUndefined();

        expect((await facts(b, 'Acme Example orchardline revenue grew')).map(f => [f.id, f.visibility, f.row_num, f.trust_tier]))
          .toEqual([[fencedBefore.id, 'world', 1, fencedBefore.trust_tier]]);
        expect((await fenceCell(b, 'companies/acme-example', 1))).toMatchObject({ claim: 'Acme Example orchardline revenue grew', visibility: 'world' });
        expect((await facts(b, 'Acme Example orchardline database-only legacy fact')).map(f => [f.id, f.visibility, f.created_at, f.source, f.context, f.trust_tier]))
          .toEqual([[loose, 'world', looseBefore.created_at, looseBefore.source, looseBefore.context, looseBefore.trust_tier]]);
        for (const claim of ['Orchardline merger plan', 'Alice Example orchardline salary', 'Orchardline fact held on a private page']) {
          expect((await facts(b, claim)).map(f => f.visibility)).toEqual(['private']);
        }
        expect(await visibilityOf(b, expired)).toBe('private');
        expect((await engine.executeRaw('SELECT 1 FROM trust_proposals WHERE target_id = ANY($1::bigint[]) OR related_id = ANY($1::bigint[])', [[fencedBefore.id, loose]])).length).toBe(0);

        const recalled = await remoteRecall(b, 'companies/acme-example');
        expect(recalled).toContain('orchardline revenue grew');
        expect(recalled).toContain('orchardline database-only legacy fact');
        __resetPrivateVisibilityCacheForTests();
        const dispatched = await dispatchToolCall(engine, 'recall', { entity: 'companies/acme-example' }, { remote: true, transport: 'http', auth: b.remote.auth, sourceId: b.sourceId,
          takesHoldersAllowList: ['world'] }) as { content: Array<{ text: string }> };
        expect(dispatched.content[0]!.text).toContain('orchardline database-only legacy fact');

        const tighten = await cli(engine, ['visibility', '--source', b.sourceId, '--json']);
        expect(tighten).not.toContain(`fact ${fencedBefore.id} `);
        expect(tighten).not.toContain(`fact ${loose} `);

        // A second preview lists nothing: every opened fact is world, every excluded one still excluded.
        const again = await preview(b);
        expect(again.affected).toBe(0);
      }
    }), 240_000);

    test('test 1: a changed set refuses the stale hash and opens nothing', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        await page(b, 'companies/acme-example', '', [[1, 'Acme Example is in Springfield', 'world']]);
        await dbOnly(b, 'Orchardline stale-hash fact one', 'companies/acme-example');
        const hash = expectHash(await cli(engine, ['open-facts', '--source', b.sourceId, '--created-before', CUT]));
        expect(hash).toBeTruthy();
        await dbOnly(b, 'Orchardline stale-hash fact two', 'companies/acme-example');
        await expect(cli(engine, ['open-facts', '--source', b.sourceId, '--created-before', CUT, '--apply', '--expect', hash!])).rejects.toMatchObject({ code: 'preview_changed' });
        expect((await facts(b, 'Orchardline stale-hash fact one')).map(f => f.visibility)).toEqual(['private']);
        expect((await facts(b, 'Orchardline stale-hash fact two')).map(f => f.visibility)).toEqual(['private']);
      }
    }), 120_000);

    test('tests 4, 14: every excluded fact is counted by reason and never opened', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        await page(b, 'companies/acme-example', '', [[1, 'Acme Example is in Springfield', 'world']]);
        await page(b, 'secret/plan-example', 'visibility: private\n', [[1, 'Orchardline merger plan', 'private']]);
        await page(b, 'companies/folder-example', '', [[1, 'Orchardline folder fact', 'private']]);
        await page(b, 'companies/quarantine-example', '', [[1, 'Orchardline quarantined fact', 'private']]);
        await page(b, 'secret/old-example', 'visibility: private\n', []);
        await coordinated(b, "UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug='secret/old-example'", [b.sourceId]);
        await proposeRevision(engine, b.sourceId, [{ id: 'folder', prefix: 'companies/folder-example', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
        expect(await engine.executeRaw("SELECT slug FROM pages WHERE source_id=$1 AND folder_rule_ids IS NOT NULL", [b.sourceId])).toEqual([{ slug: 'companies/folder-example' }]);
        await coordinated(b, `UPDATE pages SET frontmatter = frontmatter || '{"quarantine":{"reason":"junk_pattern","detail":"fixture","assessed_at":"2026-09-01T00:00:00Z"}}'::jsonb WHERE source_id=$1 AND slug='companies/quarantine-example'`, [b.sourceId]);
        const acme = 'companies/acme-example';
        const ids: Record<string, number> = {
          provenance_private: await dbOnly(b, 'Orchardline fact extracted from a private page', acme, { context: 'secret/plan-example extracted' }),
          provenance_unresolved: await dbOnly(b, 'Orchardline fact from a renamed page', acme, { context: 'gone/renamed-example extracted' }),
          holding_deleted_private: await dbOnly(b, 'Orchardline fact on a deleted private page', 'secret/old-example'),
          member_page: await dbOnly(b, 'Orchardline member note', 'memory/members/alice-example'),
          withdrawn_world: await dbOnly(b, 'Orchardline claim forgotten as world', acme),
          purged_world: await dbOnly(b, 'Orchardline claim purged as world', acme),
          pending_forget: await dbOnly(b, 'Orchardline claim with a pending forget', acme),
          contest_pending: await dbOnly(b, 'Orchardline contested pending', acme),
          contest_rejected: await dbOnly(b, 'Orchardline contested rejected', acme),
          contest_undone: await dbOnly(b, 'Orchardline contested undone', acme),
          transcript: await dbOnly(b, 'Orchardline transcript capture', acme, { source: 'hook:writeback' }),
          conversation: await dbOnly(b, 'Orchardline conversation extract', acme, { source: 'cli:extract-conversation-facts:v2' }),
        };
        ids.superseded = await dbOnly(b, 'Orchardline superseded claim', acme, { supersededBy: ids.member_page });
        ids.newer_side = await dbOnly(b, 'Orchardline contested newer side', acme);
        const [folder] = await facts(b, 'Orchardline folder fact');
        const [quarantined] = await facts(b, 'Orchardline quarantined fact');
        const open = await dbOnly(b, 'Orchardline plain legacy fact', acme);
        await coordinated(b, "INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ($1, 'world', $2, gbrain_fact_fingerprint($3))",
          [b.sourceId, acme, 'Orchardline claim forgotten as world']);
        await coordinated(b, "INSERT INTO fact_purges (source_id, visibility, subject, fact_hash) VALUES ($1, 'world', '*', gbrain_fact_fingerprint($2))",
          [b.sourceId, 'Orchardline claim purged as world']);
        await engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
          await insertTrustProposal(tx, { action: 'forget', sourceId: b.sourceId, target: { table: 'facts', id: ids.pending_forget! }, proposer: 'fixture', before: {} });
          for (const [key, status] of [['contest_pending', 'pending'], ['contest_rejected', 'rejected'], ['contest_undone', 'undone']] as const) {
            const { id } = await insertTrustProposal(tx, { action: 'supersede_fact', sourceId: b.sourceId, target: { table: 'facts', id: ids[key]! },
              related: { table: 'facts', id: key === 'contest_pending' ? ids.newer_side! : ids[key]! }, proposer: 'fence_projection', before: { visibility: { from: 'private', to: 'world' } } });
            if (status !== 'pending') await tx.executeRaw('UPDATE trust_proposals SET status=$2, decided_at=now() WHERE id=$1', [id, status]);
          }
        }, TEST_WRITE_ATTRIBUTION));

        const planned = await preview(b);
        expect(planned.details.excluded).toMatchObject({ provenance_private: 1, provenance_unresolved: 1, holding_page_private: 3, member_page: 1,
          withdrawn: 2, contested: 5, superseded: 1, holding_page_quarantined: 1 });
        expect(planned.details.eligible).toMatchObject({ unfenced: 1, 'unpaged:hook:writeback': 1, 'unpaged:cli:extract-conversation-facts:v2': 1 });
        expect(planned.listing.map((l: { detail: string }) => l.detail)).toEqual([`fact ${open} (unfenced)`]);
        await openFacts(b, ['--created-before', CUT, '--apply', '--expect', planned.preview_hash]);
        expect(await visibilityOf(b, open)).toBe('world');
        for (const [key, id] of Object.entries({ ...ids, folder: folder!.id, quarantined: quarantined!.id })) {
          expect([key, await visibilityOf(b, id)]).toEqual([key, 'private']);
        }
      }
    }), 240_000);

    test('test 5: unpaged facts are listed apart by lane and open only when the lane is named', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        const mail = await dbOnly(b, 'Orchardline mail extract with no page', null, { source: 'mail:extract', entity: null });
        const capture = await dbOnly(b, 'Orchardline capture with no page', null, { source: 'hook:compact', entity: null });
        const first = await previewAndApply(b);
        expect(first.planned.affected).toBe(0);
        expect(first.planned.details.eligible).toMatchObject({ 'unpaged:mail:extract': 1, 'unpaged:hook:compact': 1 });
        expect(await visibilityOf(b, mail)).toBe('private');
        const named = await previewAndApply(b, ['--class', 'unpaged:mail:extract']);
        expect(named.planned.listing.map((l: { class: string }) => l.class)).toEqual(['unpaged:mail:extract']);
        expect(await visibilityOf(b, mail)).toBe('world');
        expect(await visibilityOf(b, capture)).toBe('private');
      }
    }), 120_000);

    test('test 5, undo: --undo re-privates an opened unpaged fact', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        const mail = await dbOnly(b, 'Orchardline mail extract opened then undone', null, { source: 'mail:extract', entity: null });
        const { applied } = await previewAndApply(b, ['--class', 'unpaged:mail:extract']);
        expect(await visibilityOf(b, mail)).toBe('world');
        const ledger = applied!.details.ledger as string;
        const undo = await openFacts(b, ['--undo', ledger]);
        expect(undo.listing).toEqual([expect.objectContaining({ class: 'unpaged:mail:extract' })]);
        const undone = await openFacts(b, ['--undo', ledger, '--apply', '--expect', undo.preview_hash]);
        expect(undone.applied).toBe(1);
        expect(await visibilityOf(b, mail)).toBe('private');
      }
    }), 120_000);

    test('test 12: a same-tier and an above-tier fenced row each keep id and tier', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        await page(b, 'companies/tier-example', '', [[1, 'Orchardline same-tier row', 'private'], [2, 'Orchardline confirmed row', 'private'], [3, 'Orchardline world row', 'world']]);
        const [same] = await facts(b, 'Orchardline same-tier row');
        const [above] = await facts(b, 'Orchardline confirmed row');
        await confirmFact(b, above!.id);
        const { applied } = await previewAndApply(b);
        expect(applied!.applied).toBe(1);
        expect((await facts(b, 'Orchardline same-tier row')).map(f => [f.id, f.visibility, f.row_num, f.trust_tier])).toEqual([[same!.id, 'world', 1, same!.trust_tier]]);
        expect((await facts(b, 'Orchardline confirmed row')).map(f => [f.id, f.visibility, f.row_num, f.trust_tier])).toEqual([[above!.id, 'world', 2, 'user_confirmed']]);
        expect(await listTrustProposals(engine, { sourceId: b.sourceId, status: 'all' })).toEqual([]);
        expect((await fenceCell(b, 'companies/tier-example', 2))?.visibility).toBe('world');
      }
    }), 120_000);

    test('tests 8, 15: --undo re-privates exactly the opened facts, skipping a row superseded or expired since', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        await page(b, 'companies/undo-example', '', [[1, 'Orchardline undo fenced row', 'private']]);
        const kept = await dbOnly(b, 'Orchardline undo kept', 'companies/undo-example');
        const superseded = await dbOnly(b, 'Orchardline undo superseded later', 'companies/undo-example');
        const expiring = await dbOnly(b, 'Orchardline undo expired later', 'companies/undo-example');
        const [fenced] = await facts(b, 'Orchardline undo fenced row');
        const { applied } = await previewAndApply(b);
        expect(applied!.applied).toBeGreaterThan(0);
        const ledger = applied!.details.ledger as string;
        expect(ledger).toContain(home);
        for (const id of [kept, superseded, expiring, fenced!.id]) expect(await visibilityOf(b, id)).toBe('world');
        const replacement = await dbOnly(b, 'Orchardline undo replacement', 'companies/undo-example');
        await coordinated(b, 'UPDATE facts SET superseded_by=$2 WHERE id=$1', [superseded, replacement]);
        await coordinated(b, 'UPDATE facts SET expired_at=now() WHERE id=$1', [expiring]);
        const undo = await openFacts(b, ['--undo', ledger]);
        expect(undo.details.skipped).toMatchObject({ superseded: 1, expired: 1 });
        expect(undo.listing.map((l: { detail: string }) => l.detail).sort()).toEqual([`fact ${fenced!.id} (fenced row 1)`, `fact ${kept} (unfenced)`].sort());
        await openFacts(b, ['--undo', ledger, '--apply', '--expect', undo.preview_hash]);
        expect(await visibilityOf(b, kept)).toBe('private');
        expect((await facts(b, 'Orchardline undo fenced row')).map(f => f.visibility)).toEqual(['private']);
        expect((await fenceCell(b, 'companies/undo-example', 1))?.visibility).toBe('private');
        expect(await visibilityOf(b, superseded)).toBe('world');
        expect(await visibilityOf(b, replacement)).toBe('private');
      }
    }), 180_000);

    test('test 15: two applies across a window cursor open each fact once', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        await page(b, 'companies/window-example', '', [[1, 'Acme Example is in Springfield', 'world']]);
        const one = await dbOnly(b, 'Orchardline window fact one', 'companies/window-example');
        const two = await dbOnly(b, 'Orchardline window fact two', 'companies/window-example');
        const first = await previewAndApply(b, ['--limit', '1']);
        expect(first.planned.listing.map((l: { detail: string }) => l.detail)).toEqual([`fact ${one} (unfenced)`]);
        expect(first.planned.details.window.next_after).toBe(one);
        expect(await visibilityOf(b, two)).toBe('private');
        const second = await previewAndApply(b, ['--limit', '1', '--after', String(one)]);
        expect(second.planned.listing.map((l: { detail: string }) => l.detail)).toEqual([`fact ${two} (unfenced)`]);
        expect(second.applied!.applied).toBe(1);
        expect([await visibilityOf(b, one), await visibilityOf(b, two)]).toEqual(['world', 'world']);
        expect((await preview(b)).affected).toBe(0);
      }
    }), 120_000);

    test('test 15: --ids-file narrows the set to the named facts', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const b = await brain(engine, managed);
        await page(b, 'companies/ids-example', '', [[1, 'Acme Example is in Springfield', 'world']]);
        const named = await dbOnly(b, 'Orchardline named by id', 'companies/ids-example');
        const other = await dbOnly(b, 'Orchardline not named', 'companies/ids-example');
        const file = join(home, `ids-${b.sourceId}.txt`);
        writeFileSync(file, `# curated\n${named}\n`);
        await previewAndApply(b, ['--ids-file', file]);
        expect([await visibilityOf(b, named), await visibilityOf(b, other)]).toEqual(['world', 'private']);
      }
    }), 120_000);
  });
}

describe('test 13: a repo-less keyless PGLite brain opens the stored fenced row in place', () => {
  test('the stored fenced row becomes world with the same id, its cell reads world, and nothing reports it opened while it stays private', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[0]!;
    const b = await brain(engine, false);
    expect(await engine.executeRaw('SELECT p.enabled, s.local_path FROM persistence_brain p, sources s WHERE p.singleton=1 AND s.id=$1', [b.sourceId]))
      .toEqual([{ enabled: false, local_path: null }]);
    await page(b, 'companies/keyless-example', '', [[1, 'Orchardline keyless row', 'private']]);
    const [before] = await facts(b, 'Orchardline keyless row');
    const { applied } = await previewAndApply(b);
    const [after] = await facts(b, 'Orchardline keyless row');
    expect(after!.id).toBe(before!.id);
    expect(applied!.applied).toBe(1);
    expect(after!.visibility).toBe('world');
    expect((await fenceCell(b, 'companies/keyless-example', 1))?.visibility).toBe('world');
  }), 120_000);
});

/**
 * Test 16 (review round 1 on PR #9523): a fenced open writes the page, its checkout file and the row in one transaction,
 * the row first. A fact the locked recheck keeps private (here a pending forget filed after the preview) rolls the page
 * and the file back, and a file write that fails rolls the row back; either way the apply reports fact_left_private and
 * never opened while the file, the stored cell or the row is still private. Unmanaged PGLite brain, with and without a
 * checkout holding the page's file.
 */
describe('test 16: the fenced open is one transaction with its page, its checkout file and its row', () => {
  const slug = 'companies/filed-example';
  const fileCell = (path: string) => parseFactsFence(readFileSync(path, 'utf8')).facts.find(f => f.rowNum === 1)?.visibility;
  async function filedBrain(withFile: boolean, claim: string) {
    const b = await brain(engines[0]!, false);
    let file: string | null = null;
    await page(b, slug, '', [[1, claim, 'private']]);
    if (withFile) {
      const root = mkdtempSync(join(home, 'checkout-'));
      mkdirSync(join(root, 'companies'), { recursive: true });
      await b.engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [b.sourceId, root]);
      const stored = (await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId }))!;
      file = join(root, slug + '.md');
      writeFileSync(file, serializePageToMarkdown(stored.page, stored.tags));
      await coordinated(b, 'UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [b.sourceId, slug, slug + '.md']);
    }
    const [before] = await facts(b, claim);
    expect(before!.visibility).toBe('private');
    return { b, file, before: before!, text: file ? readFileSync(file, 'utf8') : null };
  }
  const forgetAfterPreview = (b: Brain, id: number) => b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () =>
    insertTrustProposal(tx, { action: 'forget', sourceId: b.sourceId, target: { table: 'facts', id }, proposer: 'fixture', before: {} }), TEST_WRITE_ATTRIBUTION));
  const leftPrivate = (applied: Record<string, any>, b: Brain) => {
    expect(applied.applied).toBe(0);
    expect(applied.outcome_items).toEqual([expect.objectContaining({ item: `${b.sourceId}:${slug}`, outcome: 'fact_left_private' })]);
    expect(applied.outcome_items[0].reason).toBeTruthy();
  };

  test('(a) a page with its file in the checkout: the file cell, the stored cell and the row read world, with the same id', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { b, file, before } = await filedBrain(true, 'Orchardline filed row');
    const { applied } = await previewAndApply(b);
    expect(applied!.applied).toBe(1);
    expect(applied!.outcome_items).toEqual([expect.objectContaining({ item: `${b.sourceId}:${slug}`, outcome: 'opened' })]);
    const [after] = await facts(b, 'Orchardline filed row');
    expect(after).toMatchObject({ id: before.id, visibility: 'world', trust_tier: before.trust_tier });
    expect((await fenceCell(b, slug, 1))?.visibility).toBe('world');
    expect(fileCell(file!)).toBe('world');
  }), 120_000);

  for (const withFile of [true, false]) {
    test(`(b) ${withFile ? 'with' : 'without'} a checkout file: a fact the locked recheck keeps private leaves the file, the stored cell and the row private`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
      const { b, file, before, text } = await filedBrain(withFile, 'Orchardline contested row');
      const planned = await preview(b);
      expect(planned.preview_hash).toBeTruthy();
      await forgetAfterPreview(b, before.id);
      leftPrivate(await openFacts(b, ['--created-before', CUT, '--apply', '--expect', planned.preview_hash]), b);
      expect(await visibilityOf(b, before.id)).toBe('private');
      expect((await fenceCell(b, slug, 1))?.visibility).toBe('private');
      if (file) expect(readFileSync(file, 'utf8')).toBe(text!);
    }), 120_000);
  }

  test.skipIf(process.getuid?.() === 0)('(b) a checkout file write that fails after the row update rolls the row back and reports fact_left_private', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { b, file, before, text } = await filedBrain(true, 'Orchardline unwritable row');
    const dir = join(file!, '..');
    chmodSync(dir, 0o555);
    let applied: Record<string, any> | null;
    try { ({ applied } = await previewAndApply(b)); } finally { chmodSync(dir, 0o755); }
    leftPrivate(applied!, b);
    expect(await visibilityOf(b, before.id)).toBe('private');
    expect((await fenceCell(b, slug, 1))?.visibility).toBe('private');
    expect(readFileSync(file!, 'utf8')).toBe(text!);
  }), 120_000);
});

/**
 * Test 17 (review round 2 on PR #9523, the owner's grant of one scoped fix): --undo reads the ledger it is given and refuses
 * a missing one or one that records another brain or source; an open whose intent line is its only record (its write
 * confirmed after the run stopped waiting) is closed unless the fact was world before that run or an accepted trust
 * proposal widened it since; a date-only --created-before is midnight UTC whatever the session time zone; a lane with
 * spaces can be named. Unmanaged PGLite brain.
 */
describe('test 17: undo reads the named ledger, intent-only opens, the UTC cut and spaced lanes', () => {
  const slug = 'companies/undo-example';
  const factMd5 = (claim: string) => createHash('md5').update(claim).digest('hex');
  const ledgerLines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text));
  const writeLedger = (lines: object[]) => {
    const path = join(mkdtempSync(join(home, 'ledger-')), 'open-facts.jsonl');
    writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    return path;
  };
  /** An unfenced private fact on a page, opened by a real apply; its own ledger lines and the default ledger's path. */
  async function opened(claim: string) {
    const b = await brain(engines[0]!, false);
    await page(b, slug, '', []);
    const id = await dbOnly(b, claim, slug);
    const { applied } = await previewAndApply(b);
    expect(applied!.applied).toBe(1);
    expect(await visibilityOf(b, id)).toBe('world');
    const ledger = applied!.details.ledger as string;
    const mine = ledgerLines(ledger).filter(line => line.source_id === b.sourceId);
    return { b, id, ledger, mine, intent: mine.find(line => line.phase === 'intent')!, committed: mine.find(line => line.phase === 'committed')! };
  }
  const undo = async (b: Brain, ledger: string) => {
    const planned = await openFacts(b, ['--undo', ledger]);
    const applied = planned.preview_hash && planned.listing?.length ? await openFacts(b, ['--undo', ledger, '--apply', '--expect', planned.preview_hash]) : null;
    return { planned, applied };
  };

  test('--undo plans from the file it names, not the default ledger', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { b, id, ledger, mine, committed } = await opened('Orchardline fact undone from a copied ledger');
    const copy = writeLedger(mine);
    writeFileSync(ledger, readFileSync(ledger, 'utf8') + JSON.stringify({ ...committed, at: new Date().toISOString(), action: 'close' }) + '\n');
    const { planned, applied } = await undo(b, copy);
    expect(planned.details.ledger).toBe(copy);
    expect(applied!.applied).toBe(1);
    expect(await visibilityOf(b, id)).toBe('private');
  }), 120_000);

  test('a missing ledger, or one that records another brain or another source, refuses with a typed reason', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { b, id, intent } = await opened('Orchardline fact behind a foreign ledger');
    const brainId = (await resolveRepairScope(b.engine, b.sourceId)).brain_id;
    await expect(cli(b.engine, ['open-facts', '--source', b.sourceId, '--undo', join(home, 'no-such-ledger.jsonl')])).rejects.toMatchObject({ code: 'invalid_params', reason: 'undo_ledger_missing' });
    await expect(cli(b.engine, ['open-facts', '--source', b.sourceId, '--undo', writeLedger([{ ...intent, brain_id: 'brain-elsewhere' }])]))
      .rejects.toMatchObject({ code: 'invalid_params', reason: 'undo_ledger_wrong_brain' });
    const otherSource = writeLedger([{ ...intent, brain_id: brainId, source_id: 'source-elsewhere' }]);
    const refused = await cli(b.engine, ['open-facts', '--source', b.sourceId, '--undo', otherSource]).then(() => null, (error: unknown) => error as Record<string, any>);
    expect(refused).toMatchObject({ code: 'invalid_params', reason: 'undo_ledger_wrong_source' });
    expect(String(refused!.fix ?? refused!.next ?? JSON.stringify(refused))).toContain('--source source-elsewhere');
    expect(await visibilityOf(b, id)).toBe('world');
  }), 120_000);

  test('an open recorded only by its intent line is closed: the late-commit case', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { b, id, intent } = await opened('Orchardline fact whose commit line never came');
    expect(intent.facts).toEqual([expect.objectContaining({ id, fact_md5: factMd5('Orchardline fact whose commit line never came'), visibility_before: 'private' })]);
    const { applied } = await undo(b, writeLedger([intent]));
    expect(applied!.applied).toBe(1);
    expect(await visibilityOf(b, id)).toBe('private');
  }), 120_000);

  test('an intent-only fact that was world before that run, or that an accepted proposal widened since, is skipped and reported', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const before = await opened('Orchardline fact already world before the run');
    const worldBefore = await undo(before.b, writeLedger([{ ...before.intent, facts: before.intent.facts.map((f: object) => ({ ...f, visibility_before: 'world' })) }]));
    expect(worldBefore.planned.details.skipped).toEqual({ world_before_run: 1 });
    expect(worldBefore.applied).toBeNull();
    expect(await visibilityOf(before.b, before.id)).toBe('world');

    const widened = await opened('Orchardline fact widened by an accepted proposal');
    const ledger = writeLedger([widened.intent]);
    await widened.b.engine.transaction(tx => withCoordinatedWrite(tx, [widened.b.sourceId], async () => {
      const { id } = await insertTrustProposal(tx, { action: 'supersede_fact', sourceId: widened.b.sourceId, target: { table: 'facts', id: widened.id }, proposer: 'fixture',
        before: { visibility: { from: 'private', to: 'world' } } });
      await tx.executeRaw("UPDATE trust_proposals SET status='accepted', decided_at=now() WHERE id=$1", [id]);
    }, TEST_WRITE_ATTRIBUTION));
    const later = await undo(widened.b, ledger);
    expect(later.planned.details.skipped).toEqual({ widened_by_proposal: 1 });
    expect(later.applied).toBeNull();
    expect(await visibilityOf(widened.b, widened.id)).toBe('world');
  }), 120_000);

  test('a date-only --created-before is midnight UTC in any session time zone, the preview prints it, and a time without an offset refuses', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const b = await brain(engines[0]!, false);
    await page(b, slug, '', []);
    const id = await dbOnly(b, 'Orchardline fact saved at five UTC on the cut day', slug);
    await coordinated(b, "UPDATE facts SET created_at='2026-06-01T05:00:00Z' WHERE id=$1", [id]);
    await b.engine.executeRaw("SET TIME ZONE 'Pacific/Honolulu'");
    try {
      const dateOnly = await openFacts(b, ['--created-before', '2026-06-01']);
      expect(dateOnly.details.created_before).toBe('2026-06-01T00:00:00.000Z');
      expect(dateOnly.listing ?? []).toEqual([]);
      const afterFive = await openFacts(b, ['--created-before', '2026-06-01T06:00:00+00:00']);
      expect(afterFive.details.created_before).toBe('2026-06-01T06:00:00.000Z');
      expect(afterFive.listing.map((l: { detail: string }) => l.detail)).toEqual([`fact ${id} (unfenced)`]);
    } finally { await b.engine.executeRaw('RESET TIME ZONE'); }
    await expect(cli(b.engine, ['open-facts', '--source', b.sourceId, '--created-before', '2026-06-01T00:00:00'])).rejects.toMatchObject({ code: 'invalid_params', reason: 'created_before_invalid' });
  }), 120_000);

  test('--class unpaged:<lane> takes a lane whose name has spaces', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const b = await brain(engines[0]!, false);
    const id = await dbOnly(b, 'Orchardline note from a lane with spaces', null, { source: 'mail extract', entity: null });
    const planned = await preview(b);
    expect(planned.details.eligible).toMatchObject({ 'unpaged:mail extract': 1 });
    expect(planned.warnings.join('\n')).toContain("--class 'unpaged:mail extract'");
    const { applied } = await previewAndApply(b, ['--class', 'unpaged:mail extract']);
    expect(applied!.applied).toBe(1);
    expect(await visibilityOf(b, id)).toBe('world');
  }), 120_000);
});

describe('test 11: the #9196 / GST-2511 holds still apply to every other widening', () => {
  const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
  const body = (rows: ReturnType<typeof row>[]) => `Profile.\n\n## Facts\n\n${renderFactsTable(rows as never)}`;
  const note = (title: string, text: string) => `---\ntype: note\ntitle: ${title}\n---\n${text}\n`;
  test('a remote put_page that writes world over a confirmed private row is held private (GST-2511)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      for (const managed of [true, false]) {
        const b = await brain(engine, managed);
        const slug = 'people/kim-example';
        await run(b.local, 'put_page', { slug, content: note('Kim', body([row(1, 'Kim lives in Turin'), row(2, 'Kim keeps bees', 'private')])) });
        for (const r of await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [b.sourceId, slug])) await confirmFact(b, Number(r.id));
        const current = await run(b.remote, 'get_page', { slug, include_content: true });
        const widened = await run(b.remote, 'put_page', { slug, content: note('Kim', body([row(1, 'Kim lives in Turin'), row(2, 'Kim keeps bees')])), expected_revision: current.revision });
        expect(widened.contested?.proposal_ref).toMatch(/^tp\d+$/);
        expect((await facts(b, 'Kim keeps bees')).map(f => f.visibility)).toEqual(['private', 'private']);
        expect(await remoteRecall(b, slug)).not.toContain('Kim keeps bees');
      }
    }
  }), 120_000);

  test('a remote remember fence append of a confirmed private claim leaves the confirmed row private and files no open', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine, true);
      const slug = 'people/lia-example';
      await run(b.local, 'put_page', { slug, content: note('Lia', body([row(1, 'Lia lives in Turin'), row(2, 'Lia keeps bees', 'private')])) });
      for (const r of await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [b.sourceId, slug])) await confirmFact(b, Number(r.id));
      const [confirmed] = await facts(b, 'Lia keeps bees');
      await run(b.remote, 'remember', { fact: 'Lia keeps bees', provenance: 'chat', entity: slug });
      const rows = await facts(b, 'Lia keeps bees');
      expect(rows.find(f => f.id === confirmed!.id)).toMatchObject({ visibility: 'private', trust_tier: 'user_confirmed' });
      expect(rows.filter(f => f.id !== confirmed!.id && f.trust_tier === 'user_confirmed')).toEqual([]);
    }
  }), 120_000);
});

describe('test 15: a page flipped private while the apply waits leaves its fact private (Postgres, two sessions)', () => {
  test('the locked recheck reads the committed flip', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines.find(e => urls.has(e));
    if (!engine) return;
    const b = await brain(engine, false);
    await page(b, 'companies/race-example', '', [[1, 'Acme Example is in Springfield', 'world']]);
    const raced = await dbOnly(b, 'Orchardline raced fact', 'companies/race-example');
    const planned = await preview(b);
    expect(planned.listing.map((l: { detail: string }) => l.detail)).toEqual([`fact ${raced} (unfenced)`]);
    const other = postgres(urls.get(engine)!, { max: 1, prepare: false });
    try {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const flip = other.begin(async sql => {
        await sql.unsafe(`UPDATE pages SET frontmatter = frontmatter || '{"visibility":"private"}'::jsonb WHERE source_id=$1 AND slug='companies/race-example'`, [b.sourceId]);
        await held;
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      const apply = openFacts(b, ['--created-before', CUT, '--apply', '--expect', planned.preview_hash]);
      await new Promise(resolve => setTimeout(resolve, 1500));
      release();
      await flip;
      const applied = await apply;
      expect(applied.applied).toBe(0);
      expect(await visibilityOf(b, raced)).toBe('private');
    } finally { await other.end(); }
  }), 120_000);
});

describe('remote page rewrite keeps hidden private fence rows (Discussion #8194, second half; test 10, a pin, green today)', () => {
  test('a remote put_page that rewrites only the body keeps the private row in the page and the database with the same id', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      for (const managed of [false, true]) {
        const b = await brain(engine, managed);
        await page(b, 'companies/beta-example', '', [[1, 'Beta Example orchardline private row', 'private'], [2, 'Beta Example world row', 'world']]);
        const [before] = await facts(b, 'Beta Example orchardline private row');
        expect(before.visibility).toBe('private');
        const read = await run(b.remote, 'get_page', { slug: 'companies/beta-example', include_content: true });
        expect(String(read.content)).not.toContain('orchardline private row');
        await run(b.remote, 'put_page', { slug: 'companies/beta-example', expected_revision: read.revision, content_origin: 'user_said',
          content: String(read.content).replace('Orchardline body.', 'Orchardline body, rewritten.') });
        expect((await facts(b, 'Beta Example orchardline private row')).map(f => [f.id, f.visibility, f.row_num])).toEqual([[before.id, 'private', 1]]);
        const [stored] = await engine.executeRaw<{ body: string }>('SELECT compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, 'companies/beta-example']);
        expect(stored.body).toContain('Beta Example orchardline private row');
        expect(stored.body).toContain('Orchardline body, rewritten.');
      }
    }
  }), 180_000);
});
