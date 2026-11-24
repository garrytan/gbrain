/**
 * BrainEngine parity: the `gbrain sources add --json` answer (src/commands/sources.ts runSources 'add'), byte for byte
 * (gbrain-evals Night 5 Cat 9 bb9-007).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm, `sources add <id> --path <dir> --json` prints the same JSON text: the id, the name,
 *    the local path, a null remote URL and a top-level `federated` flag (true for a default add, as for `--federated`; false
 *    for `--no-federated`). The stored source keeps the flag under `config.federated`, as getSource reads it back. The
 *    answer has no `config` key on any arm.
 *  - Regression: an engine that returns the source row in another shape (the flag at the top level, a missing config, a
 *    stringified config) prints a different answer, or reads the wrong flag.
 *  - Why existing coverage misses it: test/sources.test.ts runs the command on PGLite only.
 *  - Seam: console.log is captured; the real command, real engines, a temp directory per case.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, spyOn } from 'bun:test';
import { runSources } from '../../src/commands/sources.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

async function captured(run: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try { await run(); } finally { log.mockRestore(); err.mockRestore(); }
  return out;
}

describe('engine parity: sources add --json', () => {
  parityTest('sources add --json prints the same bytes, with the federation flag the add chose', { methods: ['getSource'], timeout: 90_000 }, async (engine) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-sources-add-'));
    try {
      return await withEnv({ GBRAIN_HOME: home }, async () => {
        const answers: Record<string, unknown> = {};
        const listed: Record<string, unknown> = {};
        for (const [id, flags] of [['plain-example', []], ['fed-example', ['--federated']], ['iso-example', ['--no-federated']]] as const) {
          const dir = join(home, 'checkouts', id);
          mkdirSync(dir, { recursive: true });
          const lines = await captured(() => runSources(engine, ['add', id, '--path', dir, ...flags, '--json']));
          const text = lines.find(line => line.startsWith('{')) ?? '';
          answers[id] = text.split(home).join('<home>');
          listed[id] = ((await engine.getSource(id))?.config as { federated?: unknown } | undefined)?.federated ?? null;
        }
        const parsed = Object.fromEntries(Object.entries(answers).map(([id, text]) => [id, JSON.parse(String(text))]));
        expect(Object.fromEntries(Object.entries(parsed).map(([id, v]) => [id, { federated: (v as { federated?: unknown }).federated, config: 'config' in (v as object) }])))
          .toEqual({ 'plain-example': { federated: true, config: false }, 'fed-example': { federated: true, config: false }, 'iso-example': { federated: false, config: false } });
        expect(listed).toEqual({ 'plain-example': true, 'fed-example': true, 'iso-example': false });
        return { answers, listed };
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
