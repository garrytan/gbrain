/**
 * #6351: a preview that finds nothing prints an apply command with an
 * `--expect` hash. That command must succeed (applying nothing) for every
 * preview-bound kind, and an old empty hash must still refuse once the
 * source's incarnation changed (the generalised #6377 convention).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const KINDS = ['stale-atoms', 'captured-facts', 'conversation-labels', 'extractor-facts', 'failed-writes',
  'frontmatter', 'loop-facts', 'ontology-facts', 'fences', 'slug-conflicts'];

interface RepairJson { results: Array<{ affected: number; apply_command: string; applied: number }> }

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-empty-preview-'));
}, 60_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(async () => { await resetPgliteState(engine); });

async function repair(args: string[]): Promise<RepairJson> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try {
    await withEnv({ GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude') }, () => runRepairCommand(engine, [...args, '--json']));
  } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as RepairJson;
}
const applyArgs = (json: RepairJson) => json.results[0].apply_command.split(' ').slice(2);

describe('empty preview → printed apply command', () => {
  for (const kind of KINDS) {
    test(`${kind}: the apply it prints succeeds and applies nothing`, async () => {
      const preview = await repair([kind]);
      expect(preview.results[0].affected).toBe(0);
      expect(preview.results[0].apply_command).toContain('--expect ');
      const applied = await repair(applyArgs(preview));
      expect(applied.results[0].applied).toBe(0);
    });
  }

  test('an empty hash refuses with preview_changed after the source incarnation changes', async () => {
    const preview = await repair(['stale-atoms']);
    await engine.executeRaw("UPDATE sources SET incarnation = gen_random_uuid() WHERE id = 'default'");
    let error: unknown;
    try { await repair(applyArgs(preview)); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('preview_changed');
  });
});
