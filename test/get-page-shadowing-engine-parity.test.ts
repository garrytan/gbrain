/**
 * Engine parity for getPage's federated slug-shadowing precedence. PGLite-half
 * always runs (hermetic). Postgres-half runs only when `DATABASE_URL` is set —
 * same gate as the other engine-parity tests (see
 * phantom-redirect-engine-parity.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let pglite: PGLiteEngine;
let pg: PostgresEngine | null = null;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();

  if (process.env.DATABASE_URL) {
    pg = new PostgresEngine();
    await pg.connect({ database_url: process.env.DATABASE_URL });
    await pg.initSchema();
  }
});

afterAll(async () => {
  await pglite.disconnect();
  if (pg) await pg.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(pglite);
  if (pg) {
    await pg.executeRaw('DELETE FROM pages');
    await pg.executeRaw(`DELETE FROM sources WHERE id IN ('alpha','beta','gamma','zeta')`);
  }
  for (const engine of [pglite, pg].filter(Boolean) as BrainEngine[]) {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha','alpha','/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta','beta','/tmp/beta') ON CONFLICT (id) DO NOTHING`);
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('gamma','gamma','/tmp/gamma') ON CONFLICT (id) DO NOTHING`);
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('zeta','zeta','/tmp/zeta') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('shared/dup', { type: 'note', title: 'Dup alpha', compiled_truth: 'a', frontmatter: {} }, { sourceId: 'alpha' });
    await engine.putPage('shared/dup', { type: 'note', title: 'Dup beta', compiled_truth: 'b', frontmatter: {} }, { sourceId: 'beta' });
    await engine.putPage('shared/dup', { type: 'note', title: 'Dup gamma', compiled_truth: 'g', frontmatter: {} }, { sourceId: 'gamma' });
  }
});

describe('getPage same-slug shadowing (parity)', () => {
  test('anchor (sourceIds[0]) wins even when not lexically first', async () => {
    for (const engine of [pglite, pg].filter(Boolean) as BrainEngine[]) {
      const page = await engine.getPage('shared/dup', { sourceIds: ['beta', 'alpha', 'gamma'] });
      expect(page?.title).toBe('Dup beta');
    }
  });

  test('anchor has no matching page: falls back to lexical order', async () => {
    for (const engine of [pglite, pg].filter(Boolean) as BrainEngine[]) {
      const page = await engine.getPage('shared/dup', { sourceIds: ['zeta', 'gamma', 'alpha'] });
      expect(page?.title).toBe('Dup alpha');
    }
  });
});
