/**
 * GBRA-585 (company brains, item 10): on PGLite every admin command refuses while `gbrain serve --http` runs, and
 * the refusal linked the legacy stale-lock section. Setup for several people on PGLite now says so up front and
 * points at the move to Postgres, and the live-serve refusal links the section about a running serve.
 * 1. Protects: servesLines on a several-person PGLite setup carries the engine line naming pglite_busy and
 *    `gbrain migrate --to postgres`; Postgres and one-person setups carry none; the fatal seam's live-serve
 *    refusal links docs/ENGINES.md#pglite-live-serve, and the anchor exists; the legacy-owner refusal keeps its link.
 * 2. Fails when: the line or the link is missing, or the anchor it names does not exist.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { writeFatalCliError } from '../src/cli/cli-error.ts';
import { LiveServeLockError } from '../src/core/pglite-lock.ts';
import { PGLITE_SEVERAL_NOTE, servesLines, type ServesOutcome } from '../src/commands/setup-serves.ts';

function stderrOf(run: () => number): string {
  const chunks: string[] = [];
  const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write);
  try { run(); return chunks.join(''); } finally { spy.mockRestore(); }
}

describe('PGLite with a running serve (GBRA-585 item 10)', () => {
  test('the live-serve refusal links the running-serve section, which exists', () => {
    const text = stderrOf(() => writeFatalCliError(new LiveServeLockError('GBrain\'s local database is already open through `gbrain serve` (MCP, PID 4242).', { pid: 4242, transport: 'http' }), { argv: ['access', 'member', 'list'] }));
    expect(text).toContain('Error [pglite_busy]');
    expect(text).toContain('docs/ENGINES.md#pglite-live-serve');
    expect(text).not.toContain('#legacy-pglite-lock');
    expect(readFileSync(new URL('../docs/ENGINES.md', import.meta.url), 'utf8')).toContain('<a id="pglite-live-serve"></a>');
  });

  test('setup --serves several on PGLite says admin commands refuse while serve runs and names the move to Postgres', () => {
    const outcome: ServesOutcome = { mode: 'several', brain_serves: 'one', engine: PGLITE_SEVERAL_NOTE };
    const lines = servesLines(outcome, false).join('\n');
    expect(lines).toContain('  engine     PGLite');
    expect(lines).toContain('pglite_busy');
    expect(lines).toContain('gbrain migrate --to postgres');
    expect(servesLines({ mode: 'several', brain_serves: 'one' }, false).join('\n')).not.toContain('engine');
  });
});
