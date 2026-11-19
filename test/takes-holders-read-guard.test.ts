/**
 * GST-3058: every read of an operation's take-holders list goes through readHolders (src/core/ops/context.ts).
 *
 * 1. Protects: the [world] default for remote callers. A credential bound to the brain owner reaches dispatch with no
 *    list so readHolders can grant it every holder; code that read `ctx.takesHoldersAllowList` directly would hand
 *    that empty list, read as "every holder", to whoever else reached it.
 * 2. Fails when: a source file outside the allow-list reads the raw field from an operation context.
 * 3. Static: scans src/ text; comment lines are skipped.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
/** readHolders itself, and the write authority, whose fill stays [world] for every remote caller. */
const ALLOWED = new Set(['src/core/ops/context.ts', 'src/core/persistence/authority.ts']);
const RAW_READ = /\b(?:ctx|context|opCtx|operationContext)\??\.takesHoldersAllowList\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
}

describe('take-holder reads go through readHolders', () => {
  test('no source file outside the allow-list reads ctx.takesHoldersAllowList', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (RAW_READ.test(code)) hits.push(rel + ':' + (i + 1));
      });
    }
    expect(hits).toEqual([]);
  });

  test('the scan catches a raw read', () => {
    expect(RAW_READ.test('const list = ctx.takesHoldersAllowList ?? [];')).toBe(true);
    expect(RAW_READ.test('takesHoldersAllowList: readHolders(ctx),')).toBe(false);
  });
});
