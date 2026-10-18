/**
 * #6007: SQL statements one remote put_page of a new ~60 KB page issues on
 * Postgres, per phase of the coordinated write path, counted at the socket by
 * the env-gated wire trace (src/core/sql-trace.ts). Each round trip is one
 * record; `execute` and `simple` records are statements, `describe` records
 * are the extra round trip a statement pays the first time a pooled
 * connection prepares it (reported, not budgeted: which connection runs a
 * statement is not deterministic).
 *
 * Phases come from the transaction each statement runs in (begin..commit on
 * one connection, labelled by its signature statement) and, for statements
 * outside a transaction, from known consumer-scan and effect statements or
 * the statement's position between the transactions. Consumer passes run on
 * their own connections concurrently with the write, so one that lands after
 * the claim commit would otherwise count as preparation.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { readWriteSwitchSnapshot, resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { _resetPublicationCeilingForTest, readPublicationCeilingMs } from '../../src/core/persistence/publication-deadline.ts';

interface TraceRecord { t: number; ms: number; conn: number; kind: string; sql: string }
type Phase = 'admission' | 'claim' | 'prepare' | 'recovery_record' | 'publication' | 'completion' | 'consumer_scan' | 'wait_poll' | 'effects' | 'other';
const CRITICAL: Phase[] = ['admission', 'claim', 'prepare', 'recovery_record', 'publication', 'completion'];

/**
 * Per-phase statement budgets, about 10% above the measured counts (#6007 on
 * v0.60.62.0 measured admission 27, claim 5, prepare 23, recovery record 6,
 * publication 48, completion 6: 115 on the critical path, and an 8-statement
 * receipt; v0.60.62.0 added four config reads to preparation and a second
 * alias delete to publication over v0.60.60.0's 19 and 47; the
 * code before #6007 measured 29, 5, 21, 9, 61, 10: 135, and 10). The claim
 * counts only the transaction that claimed this write; another tick's empty
 * claim attempt is a consumer scan.
 */
const BUDGET: Record<string, number> = {
  admission: 28, claim: 6, prepare: 25, recovery_record: 7, publication: 50, completion: 7, critical_path: 118, receipt: 9,
};

const SCAN = [
  /^SELECT \( EXISTS/, /^SELECT EXISTS \(SELECT 1 FROM persistence_requests r/, /FROM persistence_brain WHERE singleton=1/,
  /persistence_host_bindings h JOIN persistence_source_bindings/, /r\.recovery IS NOT NULL AND NOT\(r\.worktree_id/,
  /FROM persistence_effects e JOIN persistence_worktrees w ON w\.id=e\.worktree_id WHERE e\.recovery IS NOT NULL/,
  /FROM persistence_topology_changes c/, /FROM persistence_worktree_refreshes f JOIN/, /^WITH expired AS/, /page_projection_jobs/,
  /^WITH purged AS \( DELETE FROM persistence_consumers/,
  // #6650: the consumer's dead-owner claim scan, at most every 5 s on any tick (an idle tick can land inside a slow preparation).
  /^SELECT DISTINCT concat_ws\(':',r\.claim_phase->'owner'->>'pid'/,
  /^SELECT 1 FROM persistence_effects e WHERE e\.id>\$1::bigint AND e\.kind='embedding' AND e\.state='queued' AND e\.attempts=0/,
];
/**
 * The consumer's idle no-op embedding settle pass (embedding-noop-settle.ts) reads the embedding write target, then
 * runs the probe above on the same connection, concurrently with the measured write. Write paths share that config
 * read, so it is a scan only when the probe follows it on its connection.
 */
const SETTLE_TARGET_READ = /^SELECT key,value FROM config WHERE key IN \('search_embedding_column','embedding_columns','embedding_model'/;
const statementKinds = new Set(['execute', 'simple']);
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function classify(records: TraceRecord[]) {
  const sorted = records.filter(r => r.kind !== 'connect').sort((a, b) => a.t - b.t);
  const open = new Map<number, TraceRecord[]>();
  const groups: { records: TraceRecord[]; begin: number; end: number }[] = [];
  const standalone: TraceRecord[] = [];
  for (const record of sorted) {
    const text = flat(record.sql).toLowerCase();
    const group = open.get(record.conn);
    if (text === 'begin' && record.kind === 'simple') { open.set(record.conn, [record]); continue; }
    if (!group) { standalone.push(record); continue; }
    group.push(record);
    if (text === 'commit' || text === 'rollback') {
      open.delete(record.conn);
      groups.push({ records: group, begin: group[0]!.t, end: record.t });
    }
  }
  for (const group of open.values()) groups.push({ records: group, begin: group[0]!.t, end: group[group.length - 1]!.t });
  const settleReads = new Set(standalone.filter((record, i) => SETTLE_TARGET_READ.test(flat(record.sql))
    && SCAN.some(pattern => pattern.test(flat(standalone.slice(i + 1).find(next => next.conn === record.conn)?.sql ?? '')))));
  const labelled = groups.map(group => {
    const text = group.records.map(r => flat(r.sql)).join('\n');
    let phase: Phase = 'other';
    if (/INSERT INTO persistence_requests/.test(text)) phase = 'admission';
    else if (/SET publication_started=true|UPDATE persistence_requests SET state=\$2,outcome/.test(text)) phase = 'publication';
    else if (/UPDATE persistence_requests SET recovery=\$3/.test(text)) phase = 'recovery_record';
    else if (/UPDATE persistence_requests (r )?SET recovery=NULL/.test(text)) phase = 'completion';
    // A claim transaction that claimed nothing is another consumer tick's empty attempt, not this write's claim.
    else if (/FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w\.id=r\.worktree_id WHERE r\.state='queued'/.test(text)) phase = /SET state='running'/.test(text) ? 'claim' : 'consumer_scan';
    else if (/persistence_effects/.test(text)) phase = 'effects';
    return { ...group, phase };
  });
  const anchor = (phase: Phase, edge: 'begin' | 'end') => {
    const found = labelled.filter(group => group.phase === phase);
    return found.length ? (edge === 'begin' ? Math.min(...found.map(g => g.begin)) : Math.max(...found.map(g => g.end))) : undefined;
  };
  const admissionBegin = anchor('admission', 'begin') ?? Infinity;
  const claimEnd = labelled.filter(g => g.phase === 'claim' && /SET state='running'/.test(g.records.map(r => r.sql).join('\n'))).map(g => g.end)[0]
    ?? standalone.find(r => /^UPDATE persistence_requests SET state='running'/.test(flat(r.sql)) && statementKinds.has(r.kind))?.t
    ?? anchor('claim', 'end') ?? Infinity;
  const publicationBegin = anchor('publication', 'begin') ?? Infinity;
  const publicationEnd = anchor('publication', 'end') ?? Infinity;
  const phaseOf = (record: TraceRecord): Phase => {
    const text = flat(record.sql);
    if (settleReads.has(record) || SCAN.some(pattern => pattern.test(text))) return 'consumer_scan';
    if (/^SELECT state,error_code,error_message,completed_at,updated_at,blocked_reason,outcome FROM persistence_requests/.test(text)) return 'wait_poll';
    if (/^UPDATE persistence_requests SET state='running'/.test(text) || /FOR UPDATE OF r SKIP LOCKED\) RETURNING/.test(text)) return 'claim';
    if (/persistence_effects/.test(text) && record.t > publicationEnd) return 'effects';
    if (record.t < admissionBegin) return 'admission';
    if (record.t > claimEnd && record.t < publicationBegin) return 'prepare';
    if (record.t > publicationEnd) return /^SELECT \* FROM persistence_requests WHERE id=\$1::uuid$/.test(text) ? 'completion' : 'effects';
    return 'other';
  };
  const counts = new Map<string, { statements: number; describes: number }>();
  const add = (phase: string, record: TraceRecord) => {
    const entry = counts.get(phase) ?? { statements: 0, describes: 0 };
    if (statementKinds.has(record.kind)) entry.statements++; else if (record.kind === 'describe') entry.describes++;
    counts.set(phase, entry);
  };
  for (const group of labelled) {
    // A transaction that starts after the publication commit and is not the completion belongs to post-commit effects.
    const phase = group.phase === 'other' && group.begin > publicationEnd ? 'effects' : group.phase;
    for (const record of group.records) add(phase, record);
  }
  for (const record of standalone) add(phaseOf(record), record);
  const result: Record<string, { statements: number; describes: number }> = Object.fromEntries(counts);
  result.critical_path = CRITICAL.reduce((sum, phase) => ({
    statements: sum.statements + (counts.get(phase)?.statements ?? 0), describes: sum.describes + (counts.get(phase)?.describes ?? 0),
  }), { statements: 0, describes: 0 });
  return result;
}

test('the consumer\'s dead-owner claim scan landing inside preparation is a consumer scan, not preparation', () => {
  const at = (t: number, conn: number, kind: string, sql: string): TraceRecord => ({ t, ms: 0, conn, kind, sql });
  const records = [
    at(1, 1, 'simple', 'begin'), at(2, 1, 'execute', 'INSERT INTO persistence_requests (id) VALUES ($1)'), at(3, 1, 'simple', 'commit'),
    at(10, 2, 'execute', "UPDATE persistence_requests SET state='running', execution_token=$2::uuid WHERE id=$1"),
    at(11, 4, 'execute', "SELECT config->>'slug_root_mode' AS mode FROM sources WHERE id = $1"),
    at(12, 3, 'execute', "SELECT DISTINCT\n concat_ws(':',r.claim_phase->'owner'->>'pid',r.claim_phase->'owner'->>'nonce',r.claim_phase->'owner'->>'start') AS key,(r.claim_phase->'owner')::text AS owner\n FROM persistence_requests r WHERE r.state='running' LIMIT 100"),
    at(13, 4, 'execute', "SELECT key,value FROM config WHERE key LIKE 'persistence.limits.%'"),
    at(20, 5, 'simple', 'begin'), at(21, 5, 'execute', 'UPDATE persistence_requests SET publication_started=true WHERE id=$1'), at(22, 5, 'simple', 'commit'),
  ];
  const phases = classify(records);
  expect(phases.consumer_scan).toEqual({ statements: 1, describes: 0 });
  expect(phases.prepare).toEqual({ statements: 2, describes: 0 });
});

test('the consumer\'s no-op embedding settle pass landing after the claim commit is a consumer scan, not preparation', () => {
  const at = (t: number, conn: number, kind: string, sql: string): TraceRecord => ({ t, ms: 0, conn, kind, sql });
  const records = [
    at(1, 1, 'simple', 'begin'), at(2, 1, 'execute', 'INSERT INTO persistence_requests (id) VALUES ($1)'), at(3, 1, 'simple', 'commit'),
    at(10, 2, 'execute', "UPDATE persistence_requests SET state='running', execution_token=$2::uuid WHERE id=$1"),
    at(11, 3, 'simple', "SELECT key,value FROM config WHERE key IN ('search_embedding_column','embedding_columns','embedding_model','embedding_dimensions','contextual_retrieval.mode') ORDER BY key"),
    at(12, 4, 'execute', "SELECT config->>'slug_root_mode' AS mode FROM sources WHERE id = $1"),
    at(13, 3, 'execute', "SELECT 1 FROM persistence_effects e WHERE e.id>$1::bigint AND e.kind='embedding' AND e.state='queued'\n AND e.attempts=0 AND e.recovery IS NULL ORDER BY e.id LIMIT 1"),
    at(14, 4, 'simple', "SELECT key,value FROM config WHERE key IN ('search_embedding_column','embedding_columns','embedding_model','embedding_dimensions','contextual_retrieval.mode') ORDER BY key"),
    at(20, 5, 'simple', 'begin'), at(21, 5, 'execute', 'UPDATE persistence_requests SET publication_started=true WHERE id=$1'), at(22, 5, 'simple', 'commit'),
  ];
  const phases = classify(records);
  expect(phases.consumer_scan).toEqual({ statements: 2, describes: 0 });
  expect(phases.prepare).toEqual({ statements: 2, describes: 0 });
});

const d = hasDatabase() ? describe : describe.skip;
d('#6007 put_page statement budget (Postgres)', () => {
  test('one remote put_page of a new 60 KB page stays within its per-phase statement budget', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-statement-budget-'));
    const trace = join(fixtureDir, 'trace.jsonl');
    const root = join(fixtureDir, 'brain'); mkdirSync(root);
    _resetWriteThroughCacheForTest();
    await withEnv({ GBRAIN_SQL_TRACE: trace, GBRAIN_SQL_TRACE_LABEL: 'statement-budget', GBRAIN_HOME: join(fixtureDir, 'home') }, async () => {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      const engine: PostgresEngine = pg.engine;
      try {
        await engine.setConfig('sync.repo_path', root);
        await claimWorktree(engine, 'default', root);
        const registration: LocalRegistration = await registerLocalWriter(engine, 'stdio', {
          sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'],
        });
        const dispatch = async (name: string, params: Record<string, unknown>) => {
          const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, name, params, {
            remote: true, config: { engine: 'postgres', embedding_disabled: true }, sourceId: 'default',
            auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] },
            logger: { info() {}, warn() {}, error() {} },
          }));
          return JSON.parse((response.content[0] as { text: string }).text) as Record<string, unknown>;
        };
        const body = Array.from({ length: 600 }, (_, i) => `Paragraph ${i}: ${'measured canonical text '.repeat(4)}`).join('\n\n');
        expect(Buffer.byteLength(body)).toBeGreaterThan(55_000);
        const settle = async () => {
          for (let i = 0; i < 200; i++) {
            const [row] = await engine.executeRaw<{ n: number }>(
              "SELECT count(*)::int AS n FROM persistence_effects WHERE state IN ('queued','running')");
            if (row!.n === 0) break;
            await Bun.sleep(25);
          }
          await Bun.sleep(400);
        };
        const now = () => performance.timeOrigin + performance.now();
        const measured: { put: Record<string, { statements: number; describes: number }>; receipt: { statements: number; describes: number } }[] = [];
        const windows: { put: [number, number]; receipt: [number, number] }[] = [];
        for (let i = 0; i < 5; i++) {
          await settle();
          // The 5 s config snapshots (write switches, publication ceiling) are refreshed outside the measured window, so a
          // slow host whose writes run more than 5 s after the warm-up still measures one write with warm caches. A read
          // of a snapshot still inside its TTL returns it as is, so both are dropped first: one read 4.9 s earlier would
          // otherwise expire inside the measured write.
          resetWriteSwitches();
          _resetPublicationCeilingForTest();
          await Promise.all([readWriteSwitchSnapshot(engine), readPublicationCeilingMs(engine)]);
          const requestId = randomUUID();
          const started = now();
          const result = await dispatch('put_page', { slug: `notes/budget-${i}`, content: `---\ntitle: Budget ${i}\ntype: note\n---\n\n${body}`, request_id: requestId });
          const finished = now();
          expect(result.state).toBe('committed');
          await settle();
          const receiptStart = now();
          const receipt = await dispatch('get_write_request', { request_id: requestId });
          const receiptEnd = now();
          expect(receipt.state).toBe('committed');
          windows.push({ put: [started, finished], receipt: [receiptStart, receiptEnd] });
        }
        await Bun.sleep(1300);
        const records = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as TraceRecord);
        // The first two writes warm the pool's prepared statements; the last three are measured.
        for (const window of windows.slice(2)) {
          const inWindow = (range: [number, number]) => records.filter(r => r.t >= range[0] && r.t <= range[1]);
          const receiptRecords = inWindow(window.receipt).filter(r => r.kind !== 'connect' && !SCAN.some(p => p.test(flat(r.sql))) && !/persistence_effects e/.test(r.sql));
          measured.push({ put: classify(inWindow(window.put)), receipt: {
            statements: receiptRecords.filter(r => statementKinds.has(r.kind)).length, describes: receiptRecords.filter(r => r.kind === 'describe').length } });
        }
        console.log(`[statement-budget] ${JSON.stringify(measured.map(m => ({ ...Object.fromEntries(Object.entries(m.put).map(([k, v]) => [k, `${v.statements}+${v.describes}d`])), receipt: `${m.receipt.statements}+${m.receipt.describes}d` })))}`);
        for (const m of measured) {
          for (const [phase, budget] of Object.entries(BUDGET)) {
            const value = phase === 'receipt' ? m.receipt.statements : m.put[phase]?.statements ?? 0;
            expect({ phase, statements: value }).toEqual({ phase, statements: Math.min(value, budget) });
          }
        }
      } finally {
        await disposePersistenceConsumer(engine);
        await pg.close();
      }
    });
    rmSync(fixtureDir, { recursive: true, force: true });
  }, 120_000);
});
