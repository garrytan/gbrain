/**
 * v0.48.2 — init's reranker-default write against the live voyage default.
 *
 * Truth table (stub engine records setConfig calls):
 *   VOYAGE key present, any keyed embedding pick   → NO write (bundle default resolves to it)
 *   no key, keyed non-voyage pick (openai)         → search.reranker.enabled=false
 *   no key, keyless (resolvedModel undefined)      → NO write (recovery re-init contract)
 *   zeroentropyai:* pick, no Voyage key            → search.reranker.enabled=false (keyed non-Voyage)
 *   existing explicit reranker choice              → NO write (never-clobber)
 */
import { describe, expect, test } from 'bun:test';
import { _exports_for_test } from '../src/commands/init.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import * as fs from 'fs';
import * as path from 'path';

const { writeNewInstallRerankerDefault } = _exports_for_test;

function stubEngine(existing: Record<string, string> = {}): { engine: any; writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  const engine = {
    async getConfig(key: string): Promise<string | null> {
      return existing[key] ?? null;
    },
    async setConfig(key: string, value: string): Promise<void> {
      writes.push([key, value]);
    },
  };
  return { engine, writes };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = orig;
  }
}

describe('writeNewInstallRerankerDefault (v0.48.2)', () => {
  test('VOYAGE key present + voyage embedding pick → no write', async () => {
    await withEnv({ VOYAGE_API_KEY: 'pa-test' }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, 'voyage:voyage-4'));
      expect(writes).toEqual([]);
    });
  });

  test('VOYAGE key present + openai embedding pick → still no write (the default is provider-independent)', async () => {
    await withEnv({ VOYAGE_API_KEY: 'pa-test' }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, 'openai:text-embedding-3-small'));
      expect(writes).toEqual([]);
    });
  });

  test('no key + keyed non-voyage pick → explicit search.reranker.enabled=false', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, 'openai:text-embedding-3-small'));
      expect(writes).toEqual([['search.reranker.enabled', 'false']]);
    });
  });

  test('no key + keyless install → no write (recovery re-init must find virgin config)', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, undefined));
      expect(writes).toEqual([]);
    });
  });

  test('zeroentropyai pick without a Voyage key is a keyed non-Voyage install → enabled=false (its hosted reranker dies 2026-09-04)', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, 'zeroentropyai:zembed-1'));
      expect(writes).toEqual([['search.reranker.enabled', 'false']]);
    });
  });

  test('a Voyage key that lives only in the DB config plane counts (re-init is not locked into enabled=false)', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const { engine, writes } = stubEngine({ voyage_api_key: 'pa-db-plane' });
      await quiet(() => writeNewInstallRerankerDefault(engine, 'openai:text-embedding-3-small'));
      expect(writes).toEqual([]);
    });
  });

  test('never-clobber: an existing explicit reranker row blocks every write', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      const a = stubEngine({ 'search.reranker.model': 'voyage:rerank-2.5-lite' });
      await quiet(() => writeNewInstallRerankerDefault(a.engine, 'openai:text-embedding-3-small'));
      expect(a.writes).toEqual([]);
      const b = stubEngine({ 'search.reranker.enabled': 'true' });
      await quiet(() => writeNewInstallRerankerDefault(b.engine, 'openai:text-embedding-3-small'));
      expect(b.writes).toEqual([]);
    });
  });

  test('a voyage key on the FILE plane only (config.json) → no write', async () => {
    const home = emptyHome();
    fs.mkdirSync(path.join(home, '.gbrain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gbrain', 'config.json'), JSON.stringify({ voyage_api_key: 'pa-file' }));
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: home }, async () => {
      const { engine, writes } = stubEngine();
      await quiet(() => writeNewInstallRerankerDefault(engine, 'openai:text-embedding-3-small'));
      expect(writes).toEqual([]);
    });
  });
});
