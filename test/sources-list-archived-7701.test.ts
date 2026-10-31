/**
 * #7701: `gbrain sources list` loads archived (soft-deleted) sources but dropped the flag when it built each entry, so the
 * table never printed its archived marker and `--json` had no `archived` field: an archived source read as live.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

async function listOutput(args: string[]): Promise<string> {
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...parts: unknown[]) => { captured.push(parts.map(String).join(' ')); };
  try { await runSources(engine, ['list', ...args]); } finally { console.log = origLog; }
  return captured.join('\n');
}

// Value: protects=an archived source is marked archived in `sources list` (table and --json) and a live one is not (#7701);
// fails_when=runList builds SourceListEntry without the row's archived flag; why_new=no test listed an archived source;
// seam=runSources(['list']) on PGLite; no_claim=the MCP sources_list op.
test('sources list marks an archived source in the table and in --json', async () => {
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('source-a','source-a',NULL,'{}'), ('source-b','source-b',NULL,'{}')");
  await engine.executeRaw("UPDATE sources SET archived=true WHERE id='source-a'");

  const table = (await listOutput([])).split('\n');
  expect(table.find(line => line.includes('source-a'))).toContain('⚠ archived');
  expect(table.find(line => line.includes('source-b'))).not.toContain('archived');

  const { sources } = JSON.parse(await listOutput(['--json'])) as { sources: Array<{ id: string; archived: boolean }> };
  expect(sources.find(s => s.id === 'source-a')?.archived).toBe(true);
  expect(sources.find(s => s.id === 'source-b')?.archived).toBe(false);
});
