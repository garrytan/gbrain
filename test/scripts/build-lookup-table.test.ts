/**
 * scripts/build-lookup-table.ts (#7233): the "Which gbrain call for which
 * lookup" table is written once in skills/conventions/brain-first.md and
 * copied into AGENTS.md, INSTALL_FOR_AGENTS.md, the bootstrap AGENTS
 * template and skills/RESOLVER.md. Fails when a committed copy drifts from
 * the source region, or when --check stops reporting it.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const SCRIPT = join(REPO, 'scripts/build-lookup-table.ts');
const SOURCE_REGION = /<!-- BEGIN lookup-table -->\n([\s\S]*?)<!-- END lookup-table -->/;
const COPY_REGION = /<!-- BEGIN GENERATED lookup-table[^>]*-->\n([\s\S]*?)<!-- END GENERATED lookup-table -->/;
const COPIES = ['AGENTS.md', 'INSTALL_FOR_AGENTS.md', 'templates/bootstrap/AGENTS.md.template', 'skills/RESOLVER.md'];

describe('build-lookup-table', () => {
  test('every committed copy matches the brain-first source region', () => {
    const table = SOURCE_REGION.exec(readFileSync(join(REPO, 'skills/conventions/brain-first.md'), 'utf8'))?.[1];
    expect(table).toBeTruthy();
    for (const file of COPIES) {
      expect(COPY_REGION.exec(readFileSync(join(REPO, file), 'utf8'))?.[1], file).toBe(table);
    }
  });

  test('--check exits 0 and reports the copies current', () => {
    const r = spawnSync('bun', [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('lookup table copies are current');
  });
});
