/**
 * GST-2688: the module old updaters load after the swap stays a leaf.
 *
 * 1. Protects: `gbrain upgrade` from about v0.60.150 to v0.60.248 ends with
 *    `(await import('./sources-writer-movement.ts')).MOVEMENT_SUPERVISOR_STEP`
 *    after the new release is on disk. That import runs in the OLD process,
 *    whose module cache still holds the old copies of everything it loaded at
 *    startup, so any module this file pulls in that imports a newer export
 *    from one of those (existingHostIdFor, markNotAdmitted, ...) throws, and
 *    the upgrade exits 1 although the binary and the migrations landed.
 *    So src/commands/sources-writer-movement.ts may load nothing but
 *    src/commands/movement-step.ts; the command lives in
 *    src/commands/sources-writer-movement-cli.ts.
 * 2. Fails when: anyone adds an import to sources-writer-movement.ts, or an
 *    import to movement-step.ts.
 * 3. Existing coverage: none; the Upgrade matrix's v0.60.241.0 cells caught it.
 * 4. Seam: none. A child process loads the file into a fresh registry.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { MOVEMENT_SUPERVISOR_STEP } from '../src/commands/sources-writer-movement.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');

describe('the path old updaters import after the swap', () => {
  test('sources-writer-movement.ts loads only the movement-step leaf and still exports the step', () => {
    const entry = resolve(REPO_ROOT, 'src/commands/sources-writer-movement.ts');
    const script = `const m = await import(${JSON.stringify(entry)}); console.log(JSON.stringify({ step: m.MOVEMENT_SUPERVISOR_STEP, loaded: Object.keys(require.cache) }));`;
    const r = Bun.spawnSync([process.execPath, '-e', script], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const out = JSON.parse(r.stdout.toString().trim().split('\n').pop()!) as { step: string; loaded: string[] };
    expect(out.loaded.map(f => f.slice(REPO_ROOT.length + 1)).sort()).toEqual(['src/commands/movement-step.ts', 'src/commands/sources-writer-movement.ts']);
    expect(out.step).toBe(MOVEMENT_SUPERVISOR_STEP);
    expect(out.step).toBe('after restarting serve and the workers, run: gbrain sources writer movement');
  }, 60_000);
});
