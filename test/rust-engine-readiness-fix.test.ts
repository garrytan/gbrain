/**
 * The embeddings fix a keyless Rust brain prints (readiness.ts `enableArgv`, carried by every `[gbrain degraded:
 * embed_unavailable]` notice, so MCP `think`, `query` and `search` print it too).
 *
 * A Rust brain gets `gbrain embeddings enable --embedding-model <m> --embedding-dimensions <n>`, which keeps the Rust
 * engine and turns vectors on in place. `gbrain init` has no Rust form: the PGLite-shaped `init --force ... --path <dir>`
 * would rewrite config.json to `engine: pglite` and create a PGLite cluster inside the Rust store directory, so the brain's
 * pages would stop being read. While this process's own `gbrain serve` owns the Rust store, `lockOwnerFor` names it, so
 * the notice carries the same stop-the-server step PGLite's has.
 *
 * Owner: src/core/readiness.ts (`enableArgv`, `datastoreLabel`, `lockOwnerFor`).
 */
import { describe, expect, test } from 'bun:test';
import { enableArgv } from '../src/core/readiness.ts';
import type { GBrainConfig } from '../src/core/config.ts';

describe('the embeddings fix a Rust brain prints', () => {
  const rust = { engine: 'rust', database_path: '/brains/rust-example' } as unknown as GBrainConfig;

  test('never names a command that re-initializes the Rust store directory as PGLite', () => {
    const argv = enableArgv(rust, 'voyage:voyage-4', 1024);
    const reinit = argv[0] === 'gbrain' && argv[1] === 'init' && argv.includes('--force');
    expect(reinit).toBe(false);
    expect(argv).toEqual(['gbrain', 'embeddings', 'enable', '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024']);
  });

  test('PGLite and Postgres brains print the same in-place command', () => {
    const pglite = { engine: 'pglite', database_path: '/brains/pglite-example' } as unknown as GBrainConfig;
    const postgres = { engine: 'postgres', database_url: 'postgres://x/y' } as unknown as GBrainConfig;
    expect(enableArgv(pglite, 'voyage:voyage-4', 1024)).toEqual(enableArgv(rust, 'voyage:voyage-4', 1024));
    expect(enableArgv(postgres, 'voyage:voyage-4', 1024)).toEqual(enableArgv(rust, 'voyage:voyage-4', 1024));
  });
});
