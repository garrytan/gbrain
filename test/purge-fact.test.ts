/**
 * `purge_fact` (#5575 Part C): the claim leaves every swept live store, a
 * text-free tombstone blocks its return (typed purged_content, regardless of
 * expired_at), the journal keeps no claim text, a retry replays the stored
 * receipt, derived rows are hidden through derivation_inputs, and remote
 * routes get trusted_local_only. Real PGLite; Postgres too when DATABASE_URL
 * is set. No provider calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { operations } from '../src/core/operations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { admitWrite, completeWrite } from '../src/core/persistence/journal.ts';
import { requestPrincipalForContext } from '../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { recordDerivationInputs } from '../src/core/facts/derivation-inputs.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const CLAIM = 'Door code is 4417';
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-fact-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
const ROW_CLAIM = `| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
const ROW_TEA = '| 2 | Likes green tea | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |';
const pageBody = (title: string) => `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\nProse about ${title}.\n\n## Facts\n\n${fence([ROW_CLAIM, ROW_TEA])}\n`;

const ctx = (engine: BrainEngine, remote = false): OperationContext => ({ engine, sourceId: 'default', remote, dryRun: false,
  config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const purge = operations.find(o => o.name === 'purge_fact')!;
const run = (engine: BrainEngine, params: Record<string, unknown>, remote = false) => purge.handler(ctx(engine, remote), params) as Promise<Record<string, any>>;

async function seedPage(engine: BrainEngine, slug: string): Promise<number> {
  await importFromContent(engine, slug, pageBody(slug.split('/')[1]!), { noEmbed: true, sourceId: 'default' });
  await runExtractFacts(engine, { slugs: [slug] });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1 AND entity_slug=$2', [CLAIM, slug]);
  return Number(row.id);
}

async function confirmedPurge(engine: BrainEngine, id: number, extra: Record<string, unknown> = {}) {
  const dry = await run(engine, { id, dry_run: true, ...extra });
  return run(engine, { id, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID(), ...extra });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return e instanceof OperationError ? e.canonical ?? e.code : String((e as Error).message); }
}

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) await registerLocalWriter(engine, 'cli');
}), 120_000);
afterAll(async () => { await engines[0]?.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

describe('purge_fact', () => {
  test('dry run changes nothing and returns a fact-bound confirmation token; a real run needs it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const id = await seedPage(engine, 'people/dry-example');
      const dry = await run(engine, { id, dry_run: true });
      expect(dry.dry_run).toBe(true);
      expect(dry.confirm_token).toBe(dry.fact_hash.slice(0, 8));
      expect(Object.keys(dry).indexOf('residuals')).toBeLessThan(Object.keys(dry).indexOf('stores'));
      expect(dry.stores.find((s: any) => s.store === 'facts')).toMatchObject({ status: 'would_remove', removed: 1 });
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id=$1', [id])).toHaveLength(1);
      expect(await codeOf(run(engine, { id, request_id: randomUUID() }))).toBe('confirmation_required');
      expect(await codeOf(run(engine, { id, confirm: 'deadbeef', request_id: randomUUID() }))).toBe('confirmation_required');
      expect(await codeOf(run(engine, { id, confirm: dry.confirm_token, expected_revision: 'stale-revision', request_id: randomUUID() }))).toBe('revision_conflict');
      expect(await engine.executeRaw('SELECT 1 FROM fact_purges')).toHaveLength(0);
    }
  }), 60_000);

  test('removes the claim from live stores, keeps no text in the journal and replays the receipt', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/alice-example';
      const id = await seedPage(engine, slug);
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.createVersion(slug, { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
      const dry = await run(engine, { id, dry_run: true });
      const requestId = randomUUID();
      const done = await run(engine, { id, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: requestId, reason: 'leaked secret' });
      expect(done.state).toBe('committed');
      expect(done.summary).toContain('Removed from live stores');
      expect(JSON.stringify(done)).not.toContain(CLAIM);
      expect(done.stores.find((s: any) => s.store === 'facts')).toMatchObject({ status: 'deleted', removed: 1 });
      expect(done.stores.find((s: any) => s.store === 'page_versions').status).toBe('deleted');
      expect(['committed', 'complete']).toContain(done.completion);
      const [page] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug=$1', [slug]);
      expect(page.compiled_truth).not.toContain(CLAIM);
      expect(page.compiled_truth).toContain('Likes green tea');
      expect(await engine.executeRaw(`SELECT 1 FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1 AND strpos(c.chunk_text,$2)>0`, [slug, CLAIM])).toHaveLength(0);
      expect(await engine.executeRaw(`SELECT 1 FROM page_versions WHERE strpos(compiled_truth,$1)>0`, [CLAIM])).toHaveLength(0);
      const [ledger] = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM fact_purges WHERE subject=$1', [slug]);
      expect(ledger.fact_hash).toBe(done.fact_hash);
      expect(JSON.stringify(ledger)).not.toContain(CLAIM);
      const journal = await engine.executeRaw<{ intent: unknown; outcome: unknown }>(`SELECT intent,outcome FROM persistence_requests WHERE operation='purge_fact'`);
      expect(JSON.stringify(journal)).not.toContain(CLAIM);
      const effects = await engine.executeRaw<{ kind: string; data: { mode?: string; commit_subject?: string } }>(`SELECT e.kind,e.data FROM persistence_effects e
        JOIN persistence_requests r ON r.id=e.request_id WHERE r.request_id=$1::uuid ORDER BY e.kind`, [requestId]);
      expect(effects.map(e => e.kind)).toEqual(['embedding', 'git', 'withdrawal-mirror']);
      expect(effects[1]!.data).toMatchObject({ mode: 'purge', commit_subject: `gbrain: purge fact ${done.hash8}` });
      const replay = await run(engine, { id, request_id: requestId, reason: 'leaked secret', confirm: 'ignored-on-replay' });
      expect(replay.replayed).toBe(true);
      expect(replay.purge.removed.facts).toBe(1);
      expect(await codeOf(run(engine, { id, request_id: requestId, reason: 'different reason' }))).toBe('idempotency_conflict');
    }
  }), 60_000);

  test('trust proposals targeting or relating to the purged fact are swept with it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/trustprop-example';
      const id = await seedPage(engine, slug);
      const [other] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE entity_slug=$1 AND id<>$2 ORDER BY id LIMIT 1', [slug, id]);
      const insert = (target: number, related: number | null) => engine.executeRaw(`INSERT INTO trust_proposals (action, source_id, target_table, target_id, related_table, related_id, before_state, proposer)
        VALUES ('supersede_fact', 'default', 'facts', $1, $2, $3, $4::text::jsonb, 'test') RETURNING id`,
      [target, related === null ? null : 'facts', related, JSON.stringify({ fact: CLAIM })]);
      await insert(id, Number(other.id));
      await insert(Number(other.id), id);
      const done = await confirmedPurge(engine, id);
      expect(done.state).toBe('committed');
      expect(await engine.executeRaw('SELECT 1 FROM trust_proposals WHERE target_id=$1 OR related_id=$1', [id])).toHaveLength(0);
      expect(await engine.executeRaw('SELECT 1 FROM trust_proposals WHERE strpos(before_state::text,$1)>0', [CLAIM])).toHaveLength(0);
    }
  }), 60_000);

  test('held writes carrying the claim and gate receipts naming the purged fact or those holds are swept', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/heldclaim-example';
      const id = await seedPage(engine, slug);
      const [hold] = await engine.executeRaw<{ id: string }>(`INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, reason_families, reasons, detector_error, payload)
        VALUES ('fact', 'default', $1, 'fp-heldclaim', 1, 'external_untrusted', ARRAY['override']::text[], ARRAY[]::text[], false, $2::text::jsonb) RETURNING id::text AS id`,
      [slug, JSON.stringify({ fact: CLAIM })]);
      const receipt = (table: string, target: string, hash: string) => engine.executeRaw(`INSERT INTO write_gate_receipts (target_table, target_id, source_id, content_hash, tier, detector_version, verdict, reason_families, reasons, detector_error)
        VALUES ($1, $2, 'default', $3, 'agent_written', 1, 'flag', ARRAY['override']::text[], ARRAY[]::text[], false)`, [table, target, hash]);
      await receipt('facts', String(id), 'h-fact');
      await receipt('write_gate_holds', hold!.id, 'h-hold');
      const done = await confirmedPurge(engine, id);
      expect(done.state).toBe('committed');
      expect(done.purge.removed).toMatchObject({ write_gate_holds: 1, write_gate_receipts: 2 });
      expect(await engine.executeRaw(`SELECT 1 FROM write_gate_holds WHERE strpos(payload::text, $1) > 0`, [CLAIM])).toHaveLength(0);
      expect(await engine.executeRaw(`SELECT 1 FROM write_gate_receipts WHERE (target_table='facts' AND target_id=$1) OR (target_table='write_gate_holds' AND target_id=$2)`, [String(id), hold!.id])).toHaveLength(0);
    }
  }), 60_000);

  test('no resurrection: stale re-import, re-extraction and direct inserts are refused or dropped', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/bob-example';
      const id = await seedPage(engine, slug);
      await confirmedPurge(engine, id);
      await importFromContent(engine, slug, pageBody('bob-example') + '\nEdited.\n', { noEmbed: true, sourceId: 'default' });
      await runExtractFacts(engine, { slugs: [slug] });
      const [page] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug=$1', [slug]);
      expect(page.compiled_truth).not.toContain(CLAIM);
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE fact=$1 AND entity_slug=$2', [CLAIM, slug])).toHaveLength(0);
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      expect(snapshot!.withdrawals.some(w => w.purged)).toBe(true);
      for (const expired of [null, new Date()]) {
        const insert = engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
          `INSERT INTO facts(source_id,fact,entity_slug,visibility,expired_at,source) VALUES ('default',$1,$2,'world',$3,'test') RETURNING id`,
          ['door  code is 4417.', slug, expired]), TEST_WRITE_ATTRIBUTION));
        expect(await insert.then(() => 'inserted', e => String((e as Error).message))).toContain('purged_content');
      }
      // Another entity's copy of the same claim is out of this purge's subject scope.
      const other = engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        `INSERT INTO facts(source_id,fact,entity_slug,visibility,source) VALUES ('default',$1,'people/carol-example','world','test') RETURNING id`,
        [CLAIM]), TEST_WRITE_ATTRIBUTION));
      expect(await other.then(() => 'inserted', e => String((e as Error).message))).toBe('inserted');
    }
  }), 60_000);

  test('journal intents carrying the claim: pending refuses, terminal ones are redacted and still replay', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/dana-example';
      const id = await seedPage(engine, slug);
      const c = ctx(engine);
      const principal = await requestPrincipalForContext(c);
      const [source] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation FROM sources WHERE id='default'`);
      const admit = async () => admitWrite(engine, { principal, operation: 'remember', sourceId: 'default', sourceIncarnation: source.incarnation,
        slug, requestId: randomUUID(), callerIntent: { fact: CLAIM }, intent: { fact: CLAIM, entity_slug: slug },
        authority: await submissionAuthority(c, 'remember', 'default', source.incarnation, slug) });
      const pending = await admit();
      expect(await codeOf(confirmedPurge(engine, id))).toBe('purge_blocked_pending_recovery');
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id=$1', [id])).toHaveLength(1);
      await engine.transaction(tx => completeWrite(tx, pending, 'committed', { id: String(id), status: 'inserted' }));
      const [before] = await engine.executeRaw<{ terminal_bytes: string }>(`SELECT terminal_bytes::text FROM persistence_counters WHERE key='brain'`);
      const done = await confirmedPurge(engine, id);
      expect(done.state).toBe('committed');
      expect(done.purge.removed.persistence_requests).toBe(1);
      const [redacted] = await engine.executeRaw<{ intent: unknown; compacted: boolean; outcome: { status: string } }>(
        'SELECT intent,compacted,outcome FROM persistence_requests WHERE id=$1::uuid', [pending.id]);
      expect(redacted).toMatchObject({ intent: null, compacted: true, outcome: { status: 'inserted' } });
      const [after] = await engine.executeRaw<{ terminal_bytes: string }>(`SELECT terminal_bytes::text FROM persistence_counters WHERE key='brain'`);
      expect(Number(after.terminal_bytes)).toBeGreaterThan(0);
      expect(Number(before.terminal_bytes)).toBeGreaterThan(0);
    }
  }), 60_000);

  test('derived rows are hidden through derivation_inputs even past a 32-entry sample', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/erin-example';
      const id = await seedPage(engine, slug);
      const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [slug]);
      const derived = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
        const [take] = await tx.executeRaw<{ id: number }>(`INSERT INTO takes(page_id,row_num,claim,kind,holder) VALUES ($1,90,'Synthesized view of the door','take','brain') RETURNING id`, [page.id]);
        const inputs = Array.from({ length: 39 }, (_, i) => ({ table: 'facts', id: 900_000 + i }));
        await recordDerivationInputs(tx, { table: 'takes', id: take.id, sourceId: 'default' }, [...inputs, { table: 'facts', id }]);
        return Number(take.id);
      }, TEST_WRITE_ATTRIBUTION));
      const done = await confirmedPurge(engine, id);
      expect(done.stores.find((s: any) => s.store === 'derived_artifacts')).toMatchObject({ status: 'retained_inactive', removed: 1 });
      const [take] = await engine.executeRaw<{ active: boolean }>('SELECT active FROM takes WHERE id=$1', [derived]);
      expect(take.active).toBe(false);
      expect(await engine.executeRaw(`SELECT 1 FROM needs_rederive WHERE derived_table='takes' AND derived_id=$1`, [String(derived)])).toHaveLength(1);
    }
  }), 60_000);

  test('verbatim takes are purged and a stale takes fence cannot re-project them', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/fay-example';
      const id = await seedPage(engine, slug);
      const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [slug]);
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
        const [take] = await tx.executeRaw<{ id: number }>(`INSERT INTO takes(page_id,row_num,claim,kind,holder) VALUES ($1,7,$2,'fact','brain') RETURNING id`, [page.id, CLAIM]);
        await tx.executeRaw('UPDATE facts SET consolidated_into=$1 WHERE id=$2', [take.id, id]);
      }, TEST_WRITE_ATTRIBUTION));
      const done = await confirmedPurge(engine, id);
      expect(done.purge.removed.takes).toBe(1);
      expect(await engine.executeRaw('SELECT 1 FROM takes WHERE claim=$1', [CLAIM])).toHaveLength(0);
      const stale = `${pageBody('fay-example')}\n## Takes\n\n<!--- gbrain:takes:begin -->\n\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 7 | ${CLAIM} | fact | brain | 0.5 |  |  |\n| 8 | Keeps bees | take | brain | 0.5 |  |  |\n<!--- gbrain:takes:end -->\n`;
      await importFromContent(engine, slug, stale, { noEmbed: true, sourceId: 'default' });
      const [body] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug=$1', [slug]);
      expect(body.compiled_truth).not.toContain(CLAIM);
      expect(body.compiled_truth).toContain('Keeps bees');
      const insert = engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        `INSERT INTO takes(page_id,row_num,claim,kind,holder) VALUES ($1,9,$2,'fact','brain') RETURNING id`, [page.id, CLAIM]), TEST_WRITE_ATTRIBUTION));
      expect(await insert.then(() => 'inserted', e => String((e as Error).message))).toContain('purged_content');
    }
  }), 60_000);

  test('remote routes get trusted_local_only; the local CLI path is the only way in', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      expect(await codeOf(run(engine, { id: 1, dry_run: true }, true))).toBe('trusted_local_only');
      for (const transport of ['stdio', undefined] as const) {
        const result = await dispatchToolCall(engine, 'purge_fact', { id: 1, dry_run: true }, { config: { engine: engine.kind } as never, remote: true, transport });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text).error).toMatch(/permission_denied|trusted_local_only/);
        expect(result.content[0]!.text).toContain('gbrain forget');
      }
    }
  }), 60_000);
});

describe('purged claims and writers', () => {
  test('remember of a purged claim refuses with typed purged_content before admission work; isFactWithdrawn covers it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const { assertFactNotWithdrawn } = await import('../src/core/facts/single-prepare.ts');
    const { isFactWithdrawn, isFactPurged } = await import('../src/core/facts/withdrawal.ts');
    for (const engine of engines) {
      const slug = 'people/gus-example';
      const id = await seedPage(engine, slug);
      await confirmedPurge(engine, id);
      expect(await isFactPurged(engine, 'default', 'world', 'DOOR CODE IS 4417!', slug)).toBe(true);
      expect(await isFactWithdrawn(engine, 'default', 'world', CLAIM, slug)).toBe(true);
      expect(await isFactPurged(engine, 'default', 'world', CLAIM, 'people/other-example')).toBe(false);
      expect(await codeOf(assertFactNotWithdrawn(engine, 'default', { fact: CLAIM, kind: 'fact', visibility: 'world', entity_slug: slug }))).toBe('purged_content');
    }
  }), 60_000);
});
