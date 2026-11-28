/**
 * #10466: `gbrain rules retire` (and approve, which shares the context) saves through a local context. Like every other
 * owner CLI write it waits for the commit for the CLI write wait (30 s default, GBRAIN_WRITE_WAIT_MS, --wait), not the
 * 5 s agent default, so a retire that commits a few seconds later prints its success line instead of Error
 * [write_pending]. The wait runs inside the rule lease, so it stays a minute under the lease's 5 minute takeover age.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { retireRule } from '../src/core/rules/correct.ts';
import { renderRulePage } from '../src/core/rules/record.ts';
import * as service from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine?.disconnect(); });

let spy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { spy?.mockRestore(); spy = undefined; });

async function retireWaits(name: string, waitEnv: string): Promise<number[]> {
  const slug = `rules/me/${name}`;
  const content = renderRulePage({ scope: 'me', status: 'active', text: `Demos for acme-example run on ${name}.`, corrects: null, attribution: 'alice-example', receipt: '', checks: [] });
  await handleToolCall(engine, 'put_page', { slug, content });
  const waits: number[] = [];
  const real = service.waitForWrite;
  spy = spyOn(service, 'waitForWrite').mockImplementation(async (e, row, config, waitMs) => {
    if (row.slug === slug) waits.push(waitMs ?? 5000);
    return real(e, row, config, waitMs);
  });
  await withEnv({ GBRAIN_WRITE_WAIT_MS: waitEnv }, async () => {
    expect(await retireRule(engine, `me/${name}`)).toMatchObject({ retired: true });
  });
  expect((await engine.getPage(slug))!.frontmatter.status).toBe('retired');
  return waits;
}

describe('rules retire write wait (#10466)', () => {
  test('retire waits for the commit for the CLI write wait', async () => {
    expect(await retireWaits('mondays', '12345')).toEqual([12345]);
  });

  test('a wait longer than the rule lease allows stays a minute under its takeover age', async () => {
    expect(await retireWaits('tuesdays', '600000')).toEqual([240_000]);
  });
});
