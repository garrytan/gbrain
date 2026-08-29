/**
 * `gbrain upgrade`'s one-time "Enable skill publishing now? (recommended)
 * [Y/n]" prompt (#4318 residual) — same close-before-resolve race the shared
 * `src/core/confirm-prompt.ts` helper was written to fix, but this inline
 * confirm in upgrade.ts predates that helper and was never migrated: it
 * called `rl.close()` inside the answer callback BEFORE resolving, while an
 * unguarded `rl.on('close', () => resolveAns(false))` listener fired
 * synchronously during that close and settled the promise first — so
 * pressing Enter (or typing "y") on this default-YES prompt always resolved
 * `false`, silently leaving skill publishing disabled regardless of what the
 * operator answered.
 *
 * The prompt is inline inside a large, side-effecting `runUpgrade()` flow
 * (DB writes, network) rather than an exported, injectable function, so this
 * pins the fix at the source level: a regression back to the close-before-
 * resolve shape fails here even though `test/confirm-prompt.test.ts` (which
 * only covers the shared helper) cannot see this file at all.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('gbrain upgrade — skill-publish prompt wiring (#4318 residual)', () => {
  // test-reads-source-ok: the prompt is inline inside a large, side-effecting,
  // non-exported runUpgrade() with no injectable stdin — resolve/close
  // ordering is only observable in source text, not an executable boundary.
  const src = readFileSync(join(import.meta.dir, '../src/commands/upgrade.ts'), 'utf8');

  test('the close listener is guarded by an `answered` flag, not unconditional', () => {
    // The buggy shape was `rl.on('close', () => resolveAns(false));` with no
    // guard. The fixed shape checks `answered` before declining on close.
    const idx = src.indexOf('[gbrain] Enable skill publishing now?');
    expect(idx).toBeGreaterThan(-1);
    const promptRegion = src.slice(idx - 100, idx + 700);
    expect(promptRegion).toContain('let answered = false;');
    expect(promptRegion).toContain('answered = true;');
    expect(promptRegion).toMatch(/rl\.on\('close',\s*\(\)\s*=>\s*\{\s*if \(!answered\) resolveAns\(false\);/);
    // The regression this guards against: an unconditional decline-on-close.
    expect(promptRegion).not.toMatch(/rl\.on\('close',\s*\(\)\s*=>\s*resolveAns\(false\)\);/);
  });

  test('resolveAns for the answer is called strictly before rl.close() in the question callback', () => {
    const idx = src.indexOf('[gbrain] Enable skill publishing now?');
    const promptRegion = src.slice(idx - 100, idx + 700);
    const resolveIdx = promptRegion.indexOf('resolveAns(a === ');
    const closeIdx = promptRegion.indexOf('rl.close();');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(closeIdx);
  });

  test('the [Y/n] default-yes contract is preserved: an empty (Enter-only) answer resolves true', () => {
    // The prompt reads "(recommended) [Y/n]" — pressing Enter with no text
    // must accept the recommendation. A fix that only reordered
    // resolve/close without preserving this branch (e.g. narrowing to
    // `a === 'y' || a === 'yes'`) would still pass the two tests above while
    // silently flipping this prompt's default from accept to decline.
    const idx = src.indexOf('[gbrain] Enable skill publishing now?');
    const promptRegion = src.slice(idx - 100, idx + 700);
    expect(promptRegion).toContain("resolveAns(a === '' || a === 'y' || a === 'yes');");
  });
});
