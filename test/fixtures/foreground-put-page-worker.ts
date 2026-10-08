/**
 * Child process for test/managed-sync-foreground-priority.test.ts: the agent's
 * page writes from a second process while another process drains a managed sync.
 * Env: WORKER_DATABASE_URL, WORKER_SOURCE, WORKER_SLUGS (comma-separated, one
 * put_page each, in order; with WORKER_GO, the go file's content instead), WORKER_INTERVAL_MS (gap between writes; 0 = back to
 * back), WORKER_OUT (JSON results), WORKER_GO (optional: a file whose creation starts the writes, so a
 * test can start the process ahead and write at a chosen moment). GBRAIN_HOME is the drain's, so both processes
 * are the same local writer on the same owner host. WORKER_PREPARING_HOLD_MS (optional): when this process claims its
 * own write, its preparation waits that long first (results record `held: [start, end]`), so the write stays claimed
 * by this process, unpublished, while the drain's lanes hold the worktree.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { observeAdmissionTransactions } from '../../scripts/persistence/read-admission.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';

// `admitted`: when the write's admission transaction committed (wall clock), so the test can tell a claim that
// could already see the write from one that chose its row before the write was visible.
let admittedAt: number | undefined;
const postgres = new PostgresEngine();
const engine = observeAdmissionTransactions(postgres, () => { admittedAt ??= Date.now(); });
await postgres.connect({ database_url: process.env.WORKER_DATABASE_URL!, poolSize: 4 });
const sourceId = process.env.WORKER_SOURCE!;
const interval = Number(process.env.WORKER_INTERVAL_MS ?? '0');
const results: Array<{ slug: string; state: string; error?: string; submitted: number; returned: number; admitted?: number; held?: [number, number] }> = [];
const holdMs = Number(process.env.WORKER_PREPARING_HOLD_MS ?? '0');
let held: [number, number] | undefined;
if (holdMs > 0) installFaultHook(async (point, detail) => {
  if (point !== 'consumer:preparing' || detail.operation !== 'put_page' || held) return;
  const start = Date.now();
  await Bun.sleep(holdMs);
  held = [start, Date.now()];
});
const logger = { info() {}, warn() {}, error() {} };
const go = process.env.WORKER_GO;
if (go) while (!existsSync(go) || !readFileSync(go, 'utf8')) await Bun.sleep(5);
const slugs = (go ? readFileSync(go, 'utf8') : process.env.WORKER_SLUGS!).split(',');
for (const slug of slugs) {
  const submitted = Date.now();
  admittedAt = undefined;
  try {
    const out = await submitPageMutation({ engine, config: { engine: 'postgres', database_url: process.env.WORKER_DATABASE_URL! }, remote: false, dryRun: false, sourceId, logger } as never,
      { operation: 'put_page', params: { slug, content: `---\ntitle: ${slug}\n---\nA foreground note written during the catch-up.\n` }, waitMs: 60_000 });
    results.push({ slug, state: String((out as { state?: string }).state ?? ''), submitted, returned: Date.now(), admitted: admittedAt, ...(held ? { held } : {}) });
  } catch (error) {
    results.push({ slug, state: 'error', error: (error as Error).message, submitted, returned: Date.now(), admitted: admittedAt });
  }
  if (interval) await Bun.sleep(interval);
}
writeFileSync(process.env.WORKER_OUT!, JSON.stringify(results));
await disposePersistenceConsumer(engine);
await engine.disconnect();
process.exit(0);
