import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { connectorWaitBudget, CONNECTOR_WAIT_BUDGET_MS } from '../src/core/persistence/connector-sync.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { createConnectorFixture, googleConfig, json, options, settleConnectorWrites, sourceCheckpoint, withGoogleAccount } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);
const config = { ...googleConfig, g_services: 'gmail' };
const tid = '17ff00000000b001';
function gmailFetcher(sentAt: number) { return withGoogleAccount(async (url: string) => {
  const u = new URL(url);
  if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
  if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: config.g_account, historyId: '5000' });
  if (u.pathname.endsWith('/users/me/messages')) return json({ messages:
    Number(/after:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? 0) * 1000 <= sentAt
    && sentAt < Number(/before:(\d+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? Infinity) * 1000
      ? [{ id: '18ff00000000b001', threadId: tid }] : [] });
  if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '5000', history: [] });
  if (u.pathname.endsWith(`/users/me/threads/${tid}`)) return json({ id: tid, messages: [{
    id: '18ff00000000b001', threadId: tid, labelIds: ['INBOX'], internalDate: String(sentAt),
    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Alice Example <alice@example.invalid>' },
      { name: 'To', value: config.g_account }, { name: 'Subject', value: 'Contract question' }],
    body: { data: Buffer.from('Could you confirm the acme-example contract terms?').toString('base64url') } },
  }] });
  throw new Error(`Unexpected Google fixture route: ${url}`);
}, config.g_account); }

for (const { refuse, grace } of [{ refuse: true, grace: false }, { refuse: false, grace: false }, { refuse: true, grace: true }]) test(`#9011: pending Gmail publication derives ${grace ? 'no grace hold' : 'nothing'} before ${refuse ? 'purge refusal' : 'committed recovery'}`, async () => withEnv(env, async () => {
  const fetcher = gmailFetcher(Date.now() - (grace ? 3_600_000 : 3 * 86_400_000));
  for (const engine of engines) {
    const f = await boundSource(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reached = 0;
    let publicationId: string | undefined;
    const loopRows = () => engine.executeRaw('SELECT summary,evidence FROM open_loops WHERE source_id=$1', [f.id]);
    installFaultHook(async (point, detail) => {
      if (point !== 'consumer:preparing') return;
      const [row] = await engine.executeRaw<{ kind: string }>("SELECT intent->>'kind' AS kind FROM persistence_requests WHERE id=$1::uuid", [detail.writeId]);
      if (row?.kind !== 'connector_v2_import') return;
      reached++;
      publicationId = detail.writeId;
      await gate;
      if (refuse) throw new OperationError('purged_content', 'Synthetic late publication purge refusal.', 'Keep the content purged.');
    });
    connectorWaitBudget.ms = 1_000;
    let observed: unknown[] = [];
    let checkpoint: unknown;
    let result;
    try {
      result = await runGoogleSync(engine, f.id, cfg, options, fetcher);
      observed = await loopRows();
      checkpoint = await sourceCheckpoint(engine, f.id);
    } finally {
      release();
      connectorWaitBudget.ms = CONNECTOR_WAIT_BUDGET_MS;
      await settleConnectorWrites(engine, f.id).catch(() => {});
      await disposePersistenceConsumer(engine);
      installFaultHook(undefined);
    }
    expect(reached).toBeGreaterThan(0);
    expect(result?.status).toBe('partial');
    expect(observed).toEqual([]);
    expect(JSON.stringify(checkpoint)).not.toContain('acme-example contract');
    const rows = await engine.executeRaw<{ state: string; error_code: string | null }>(
      'SELECT state,error_code FROM persistence_requests WHERE id=$1::uuid', [publicationId]);
    expect(rows).toEqual([{ state: refuse ? 'failed' : 'committed', error_code: refuse ? 'purged_content' : null }]);
    expect(await loopRows()).toEqual([]);
    if (!refuse) {
      // The cursor did not pass the pending item. A resumed, now-committed import still detects its obligation once.
      const resumed = await runGoogleSync(engine, f.id, cfg, options, fetcher);
      expect(resumed.failedFiles ?? 0).toBe(0);
      expect((await loopRows()).length).toBe(1);
      await runGoogleSync(engine, f.id, cfg, options, fetcher);
      expect((await loopRows()).length).toBe(1);
    }
  }
}), 180_000);
