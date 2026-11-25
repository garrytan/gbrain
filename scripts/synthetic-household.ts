#!/usr/bin/env bun
/**
 * Seed a fresh keyless, repo-less PGLite brain with the synthetic household (test/fixtures/synthetic-household) for
 * the cross-harness outcome check (docs/guides/household.md#check-it-across-harnesses). Usage:
 *   bun scripts/synthetic-household.ts <gbrain-home>
 * The brain lives at <gbrain-home>/.gbrain/brain.pglite with a keyless config, so `GBRAIN_HOME=<gbrain-home> gbrain serve`
 * serves it. It refuses a directory that already has a .gbrain folder, and removes the one it made if seeding fails. Every name in it is invented.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { gbrainPath, saveConfig, type GBrainConfig } from '../src/core/config.ts';
import { seedSyntheticHousehold, TIMEZONE } from '../test/fixtures/synthetic-household/household.ts';

export async function seedSyntheticHouseholdBrain(dir: string): Promise<Map<string, string>> {
  const saved = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = resolve(dir);
  try {
    const brainDir = gbrainPath();
    const dbPath = gbrainPath('brain.pglite');
    mkdirSync(dirname(brainDir), { recursive: true });
    try {
      mkdirSync(brainDir);
    } catch (e: any) {
      if (e?.code === 'EEXIST') throw new Error(`${brainDir} already exists; the synthetic household seeds only a new, empty directory.`);
      throw e;
    }
    try {
      const engine = new PGLiteEngine();
      let slugs: Map<string, string>;
      try {
        await engine.connect({ database_path: dbPath, engine: 'pglite' });
        await engine.initSchema();
        await engine.setConfig('brain.timezone', TIMEZONE);
        slugs = await seedSyntheticHousehold((op, params) => handleToolCall(engine, op, params) as Promise<any>);
      } finally {
        await engine.disconnect().catch(() => {});
      }
      saveConfig({ engine: 'pglite', database_path: dbPath, embedding_disabled: true } as unknown as GBrainConfig);
      return slugs;
    } catch (e) {
      rmSync(brainDir, { recursive: true, force: true });
      throw e;
    }
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
