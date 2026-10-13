/**
 * #6606 (Cat 41 r1): an agent saved the user's item with `remember
 * --visibility private`; session hooks push world-visible facts only
 * (turn-context.test.ts pins that), so the next fresh session got nothing and
 * nothing at write time said so. A local private save now tells the agent
 * (notice `private_fact_not_pushed`, naming the world re-save and the private
 * copy to forget, since replaces cannot change visibility) and the human
 * CLI line says it; world saves and remote callers get neither. PGLite,
 * synthetic facts only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { operationsByName } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { formatRememberResult } from '../src/cli/remember-format.ts';

let engine: PGLiteEngine;
const sourceId = 'remember-private-test';

async function remember(params: Record<string, unknown>, remote: boolean): Promise<{ result: Record<string, any>; notices: Notice[] }> {
  const notices: Notice[] = [];
  const ctx: OperationContext = { engine, remote, sourceId, config: { engine: 'pglite' }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} }, emitNotice: (n) => { if (n) notices.push(n); } };
  const result = await operationsByName.remember!.handler(ctx, { provenance: 'chat 2026-10-13', entity: 'user', ...params }) as Record<string, any>;
  return { result, notices };
}

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli'); await registerLocalWriter(engine, 'stdio');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
});

describe('remember --visibility private says the fact is not pushed (#6606)', () => {
  test('a local private save emits private_fact_not_pushed naming the world re-save and the private copy', async () => {
    const { result, notices } = await remember({ fact: 'The user\'s locker code is 0000-EX.', visibility: 'private' }, false);
    expect(result.status).toBe('inserted');
    const notice = notices.find(n => n.code === 'private_fact_not_pushed');
    expect(notice).toBeDefined();
    expect(notice!.why).toContain('will not reach a new agent session');
    expect(notice!.why).toContain('saving it again with visibility world');
    expect(notice!.why).toContain(`\`gbrain forget ${result.id}\` drops the private copy`);
    expect(formatRememberResult(result, { visibility: 'private' })).toContain('note: private — local CLI recall only; not pushed into new agent sessions');
  });

  test('a world save, a remote private save and a duplicate emit no such notice', async () => {
    const world = await remember({ fact: 'The user\'s bike is teal.' }, false);
    expect(world.notices.map(n => n.code)).not.toContain('private_fact_not_pushed');
    expect(formatRememberResult(world.result, {})).not.toContain('note: private');
    const remote = await remember({ fact: 'The user\'s gym is on Example Street.', visibility: 'private' }, true);
    expect(remote.notices.map(n => n.code)).not.toContain('private_fact_not_pushed');
    await remember({ fact: 'The user\'s coat is red.', visibility: 'private' }, false);
    const again = await remember({ fact: 'The user\'s coat is red.', visibility: 'private' }, false);
    expect(again.result.status).toBe('duplicate');
    expect(again.notices.map(n => n.code)).not.toContain('private_fact_not_pushed');
  });
});
