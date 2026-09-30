import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { planEmbeddingMigration, readMigrationState } from '../../src/core/embedding-migration.ts';
import { authorizeMigrationBudget } from '../../src/core/embedding-migration-budget.ts';
import { invokeAI, withAIInvocationGuard } from '../../src/core/ai/invocation-guard.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

const [mode, kind, database, root, boundary, requestKind] = process.argv.slice(2);
if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) throw new Error('Provider keys must be stripped');
if (kind === 'postgres') assertSafeE2eDatabaseUrl(database);
const engine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
await engine.connect(kind === 'postgres' ? { database_url: database } : { database_path: database });
const model = 'openai:text-embedding-3-small';
const reranker = 'synthetic:priced-reranker';
const invocation = { kind: requestKind as 'embedding' | 'rerank', operation: 'synthetic-migration-crash',
  model: requestKind === 'rerank' ? reranker : model, maxInputTokens: 40_000 };
const dispatches = join(root, 'dispatches');
const pause = async () => { console.log('MIGRATION_WAVE_CRASH_BOUNDARY'); await new Promise(() => {}); };
try {
  await engine.setConfig('pricing.overrides', JSON.stringify({ [model]: 0.02, [reranker]: 0.02 }));
  const plan = await planEmbeddingMigration(engine, { to: model, dim: 1536 });
  const before = (await readMigrationState(engine)).state?.budget;
  const debit = await authorizeMigrationBudget(engine, plan, mode === 'crash' ? 0.001 : undefined, [], reranker);
  const dispatch = async () => {
    appendFileSync(dispatches, 'synthetic-dispatch\n');
    if (mode === 'crash' && boundary === 'after-dispatch') await pause();
    return { tokens: 40_000 };
  };
  if (mode === 'crash') {
    await withAIInvocationGuard(async call => {
      if (boundary === 'before-reservation') await pause();
      const permit = await debit(call);
      if (boundary === 'after-debit') await pause();
      return permit;
    }, () => invokeAI(invocation, dispatch, value => ({ inputTokens: value.tokens, outputTokens: 0 })));
    throw new Error('Crash boundary was not reached');
  }
  const resumed = (await readMigrationState(engine)).state!.budget!;
  if (JSON.stringify(before) !== JSON.stringify(resumed)) throw new Error('Resume reset durable authorization');
  const expectedRequests = boundary === 'before-reservation' ? 0 : 1;
  if (resumed.requests !== expectedRequests || (expectedRequests ? resumed.debited_usd <= 0 : resumed.debited_usd !== 0)) {
    throw new Error('Unexpected durable crash debit');
  }
  let rejected = false;
  await withAIInvocationGuard(debit, async () => {
    if (!expectedRequests) await invokeAI(invocation, dispatch, value => ({ inputTokens: value.tokens, outputTokens: 0 }));
    try { await invokeAI(invocation, dispatch, value => ({ inputTokens: value.tokens, outputTokens: 0 })); }
    catch { rejected = true; }
  });
  const final = (await readMigrationState(engine)).state!.budget!;
  const count = existsSync(dispatches) ? readFileSync(dispatches, 'utf8').trim().split('\n').length : 0;
  if (!rejected || final.requests !== 1 || final.debited_usd > final.max_cost_usd || count !== (boundary === 'after-debit' ? 0 : 1)) {
    throw new Error('Restart exceeded authorized dispatches');
  }
  console.log(JSON.stringify({ result: 'MIGRATION_WAVE_BUDGET_RECOVERED', boundary, requestKind, budget: final, dispatches: count }));
} finally { await engine.disconnect(); }
