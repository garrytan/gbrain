#!/usr/bin/env bun
/**
 * Seed a fresh keyless, repo-less PGLite brain with the synthetic household (test/fixtures/synthetic-household) for
 * the cross-harness outcome check (docs/guides/household.md#check-it-across-harnesses). Usage:
 *   bun scripts/synthetic-household.ts <gbrain-home>
 * The brain lives at <gbrain-home>/.gbrain/brain.pglite with a keyless config, so `GBRAIN_HOME=<gbrain-home> gbrain serve`
 * serves it. It refuses a directory that already holds a brain. Every name in it is invented.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { gbrainPath, saveConfig, type GBrainConfig } from '../src/core/config.ts';
import { seedSyntheticHousehold, TIMEZONE } from '../test/fixtures/synthetic-household/household.ts';

export async function seedSyntheticHouseholdBrain(dir: string): Promise<Map<string, string>> {
  const home = resolve(dir);
  for (const f of ['config.json', 'brain.pglite']) {
    if (existsSync(join(home, '.gbrain', f))) throw new Error(`${join(home, '.gbrain', f)} already exists; the synthetic household seeds only a new, empty directory.`);
  }
  const saved = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = home;
  try {
    const dbPath = gbrainPath('brain.pglite');
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dbPath, engine: 'pglite' });
    await engine.initSchema();
    let slugs: Map<string, string>;
    try {
      await engine.setConfig('brain.timezone', TIMEZONE);
      slugs = await seedSyntheticHousehold((op, params) => handleToolCall(engine, op, params) as Promise<any>);
    } finally {
      await engine.disconnect();
    }
    saveConfig({ engine: 'pglite', database_path: dbPath, embedding_disabled: true } as unknown as GBrainConfig);
    return slugs;
  } finally {
    if (saved === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = saved;
  }
}

/** household_due on a brain seeded by seedSyntheticHouseholdBrain (trusted local read), with nothing else holding it open. */
export async function householdDueIn(home: string, params: Record<string, unknown>): Promise<any> {
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: `${home}/.gbrain/brain.pglite`, engine: 'pglite' });
  try {
    return await handleToolCall(engine, 'household_due', params);
  } finally {
    await engine.disconnect();
  }
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error('Usage: bun scripts/synthetic-household.ts <gbrain-home>');
    process.exit(2);
  }
  const slugs = await seedSyntheticHouseholdBrain(home);
  console.log(`Seeded ${slugs.size} household records into ${home}/.gbrain/brain.pglite`);
}
