/**
 * #6604: after `gbrain upgrade` swaps the install in place, the old parent
 * process still has the old release's modules cached. A dynamic import there
 * loads new files into the old graph, so a changed named export throws and the
 * upgrade exits 1 after a successful install. Every module the post-swap tail
 * needs must be imported statically (loaded before the swap).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// test-reads-source-ok[structural]: #6604 is a post-swap module-graph hazard a hermetic upgrade run cannot reproduce; the guard pins that no dynamic import follows the swap.
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'upgrade.ts'), 'utf-8');
const SWAP_MARKER = 'const newVersion = verifyUpgrade();';

function functionBody(name: string): string | null {
  const m = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\s*\\(`).exec(SRC);
  if (!m) return null;
  let i = SRC.indexOf('{', SRC.indexOf(')', m.index + m[0].length));
  for (let depth = 0, j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(i, j + 1);
  }
  return null;
}

function postSwapCode(): Map<string, string> {
  const runUpgrade = functionBody('runUpgrade')!;
  const start = runUpgrade.indexOf(SWAP_MARKER);
  expect(start).toBeGreaterThan(0);
  const seen = new Map<string, string>([['runUpgrade (after the swap)', runUpgrade.slice(start)]]);
  const queue = [runUpgrade.slice(start)];
  while (queue.length) {
    for (const call of queue.pop()!.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = call[1]!;
      if (seen.has(name)) continue;
      const body = functionBody(name);
      if (!body) continue;
      seen.set(name, body);
      queue.push(body);
    }
  }
  return seen;
}

describe('#6604 upgrade post-swap tail', () => {
  test('runUpgrade and every local helper it reaches after the swap use no dynamic import', () => {
    const offenders = [...postSwapCode()].filter(([, body]) => /await import\(/.test(body)).map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test('the post-swap walk reaches describeMigrationFailure and the verify helpers', () => {
    const names = [...postSwapCode().keys()];
    expect(names).toEqual(expect.arrayContaining(['describeMigrationFailure', 'postSwapSmoke', 'saveUpgradeState']));
  });

  test('the movement step constant lives in a leaf module with no imports', () => {
    // test-reads-source-ok[structural]: the leaf must stay import-free so the post-swap step loads nothing from the new tree.
    const leaf = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'movement-step.ts'), 'utf-8');
    expect(new Bun.Transpiler({ loader: 'ts' }).scanImports(leaf)).toEqual([]);
    expect(SRC).toMatch(/^import \{ MOVEMENT_SUPERVISOR_STEP \} from '\.\/movement-step\.ts';$/m);
  });
});
