/**
 * BrainEngine parity — the "turn on embeddings" fix that `whoami` (and every readiness consumer: doctor, embed, the
 * `[gbrain degraded: embed_unavailable]` notice) prints for a keyless brain (readiness.ts `enableArgv`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `whoami` on a keyless brain, asked locally and over stdio MCP, answers the same on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts), and its embeddings fix is
 *    `gbrain embeddings enable --embedding-model <m> --embedding-dimensions <n>`, which turns vectors on in place.
 *    Only the `why` sentence differs: it names the arm's own datastore.
 *  - Regression: PGLite and Postgres printed `gbrain init --force ... [--path <dir>]` while Rust printed
 *    `embeddings enable`. `init --force --path` rewrites a Rust brain's config to an empty PGLite brain, so no engine
 *    may print it, and an agent that copies the fix from one brain to another must get the same command.
 *  - Why existing coverage misses it: test/readiness.test.ts and test/rust-engine-readiness-fix.test.ts pin each
 *    engine's argv on its own; no case compared the whoami answer across engines.
 *  - Seam: the config the CLI would load, built from the arm's engine kind in a fresh GBRAIN_HOME with every provider
 *    key unset; the real `whoami` handler answers. The stdio answer reads the brain (config, applied policy
 *    revisions, the persistence brain id), so it also pins those reads across engines.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { sourcesOperations } from '../../src/core/ops/sources.ts';
import { listRecipes } from '../../src/core/ai/recipes/index.ts';

const { parityTest } = parityArms(testBackends());

const PROVIDER_ENVS = [...new Set(listRecipes().flatMap(r => r.auth_env?.required ?? []))];
const DATASTORE: Record<string, string> = { pglite: 'the PGLite brain at ', postgres: 'this Postgres brain', rust: 'the Rust brain at ' };

async function whoamiOnKeylessBrain(engine: BrainEngine, transport: 'local' | 'stdio'): Promise<Record<string, unknown>> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-whoami-'));
  const env: Record<string, string | undefined> = { GBRAIN_HOME: home, GBRAIN_BRAIN_ID: undefined, GBRAIN_MODEL: undefined };
  for (const k of PROVIDER_ENVS) env[k] = undefined;
  try {
    return await withEnv(env, async () => {
      const config = { engine: engine.kind, database_path: join(home, 'brain'), embedding_disabled: true };
      const ctx = { engine, config, remote: transport === 'stdio', ...(transport === 'stdio' ? { transport } : {}), dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const op = sourcesOperations.find(o => o.name === 'whoami')!;
      return await op.handler(ctx, {}) as Record<string, unknown>;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('engine parity: the whoami embeddings fix', () => {
  parityTest('a keyless brain prints the same whoami answer and the in-place embeddings enable fix on every engine', { methods: ['getConfig', 'listAppliedPolicyRevisions', 'readPersistenceBrainId'] }, async (engine, backend) => {
    const answers: Record<string, unknown> = {};
    for (const transport of ['local', 'stdio'] as const) {
      const answer = await whoamiOnKeylessBrain(engine, transport);
      expect(answer.transport).toBe(transport);
      const readiness = answer.readiness as Array<Record<string, any>>;
      const embeddings = readiness.find(e => e.capability === 'embeddings')!;
      expect(embeddings.state).toBe('disabled_by_choice');
      expect(embeddings.fix.argv.slice(0, 4)).toEqual(['gbrain', 'embeddings', 'enable', '--embedding-model']);
      expect(embeddings.fix.argv).not.toContain('init');
      expect(embeddings.fix.argv).not.toContain('--path');
      // The `why` sentence names this arm's own datastore; everything else must match across engines.
      expect(embeddings.fix.why).toContain(DATASTORE[backend]);
      const { why: _why, ...fix } = embeddings.fix;
      answers[transport] = { ...answer, readiness: readiness.map(e => (e.capability === 'embeddings' ? { ...e, fix } : e)) };
    }
    return answers;
  });
});
