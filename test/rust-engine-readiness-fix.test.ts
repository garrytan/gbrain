/**
 * The embeddings fix a keyless Rust brain prints (readiness.ts `enableArgv`, carried by every `[gbrain degraded:
 * embed_unavailable]` notice, so MCP `think`, `query` and `search` print it too).
 *
 * `enableArgv` treats every engine that is not Postgres as PGLite: on a Rust brain it names `gbrain init --force
 * --embedding-model <m> --embedding-dimensions <n> --path <the Rust store directory>`. `gbrain init` has no Rust form,
 * so that command rewrites config.json to `engine: pglite` and creates a PGLite cluster inside the Rust store
 * directory: the brain's pages stop being read (records.redb stays on disk, unread). While a stdio `serve` holds the
 * store, the same command times out on the data-dir lock instead, and the notice has no stop-the-server step
 * (`lockOwnerFor` reads the lock only for `engine: pglite`), which PGLite's notice has.
 *
 * Owner: src/core/readiness.ts (`enableArgv`, `datastoreLabel`, `lockOwnerFor`) and src/commands/init.ts (no Rust
 * engine form). Not a search, query or ranking read, so the Rust engine lane does not fix it here; the case fails
 * until the owner gives the Rust brain a fix that keeps its engine.
 */
import { describe, expect, test } from 'bun:test';
import { enableArgv } from '../src/core/readiness.ts';
import type { GBrainConfig } from '../src/core/config.ts';

describe('the embeddings fix a Rust brain prints', () => {
  const rust = { engine: 'rust', database_path: '/brains/rust-example' } as unknown as GBrainConfig;

  test.failing('never names a command that re-initializes the Rust store directory as PGLite (fails until readiness.ts gives Rust its own fix)', () => {
    const argv = enableArgv(rust, 'voyage:voyage-4', 1024);
    const reinit = argv[0] === 'gbrain' && argv[1] === 'init' && argv.includes('--force');
    expect(reinit).toBe(false);
  });

  test('a PGLite brain keeps its re-init fix, aimed at its own data directory', () => {
    const pglite = { engine: 'pglite', database_path: '/brains/pglite-example' } as unknown as GBrainConfig;
    expect(enableArgv(pglite, 'voyage:voyage-4', 1024)).toEqual(['gbrain', 'init', '--force', '--embedding-model',
      'voyage:voyage-4', '--embedding-dimensions', '1024', '--path', '/brains/pglite-example']);
  });
});
