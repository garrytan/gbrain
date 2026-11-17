/**
 * #5626 — `foresights lint` validates a page's explicit `type` against the active
 * schema pack. Pre-fix, `type: banana` linted clean; the `type-undeclared`
 * rule now flags any type the pack neither declares nor aliases (the same
 * classification as `schema lint --with-db`'s stored_type_undeclared).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lintContent, runLintCore } from '../src/commands/lint.ts';
import { loadResolvedPackByName } from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const page = (type: string) => `---\ntitle: Example\ntype: ${type}\ncreated: 2026-01-01\n---\n\nBody text for an example page.\n`;

describe('#5626 type-undeclared lint rule', () => {
  test('flags an undeclared type, never a declared type or an alias', async () => {
    const pack = (await loadResolvedPackByName('gbrain-base-v2')).manifest;
    const flagged = (type: string) => lintContent(page(type), 'notes/example.md', { typePack: pack })
      .filter((i) => i.rule === 'type-undeclared');
    const [issue] = flagged('banana');
    expect(issue).toBeDefined();
    expect(issue.line).toBe(3);
    expect(issue.fixable).toBe(false);
    expect(issue.message).toContain("'banana'");
    expect(issue.message).toContain("'gbrain-base-v2'");
    expect(issue.message).toContain('foresights schema add-type banana');
    expect(flagged('note')).toEqual([]);
    expect(flagged('memo')).toEqual([]);
  });

  test('no resolved pack skips the rule', () => {
    expect(lintContent(page('banana'), 'notes/example.md', { typePack: null }).some((i) => i.rule === 'type-undeclared')).toBe(false);
  });

  describe('runLintCore resolves the active pack from the engine', () => {
    let engine: PGLiteEngine;
    let dir: string;
    let home: string;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      await engine.setConfig('schema_pack', 'gbrain-base-v2');
      dir = mkdtempSync(join(tmpdir(), 'gbrain-5626-'));
      home = mkdtempSync(join(tmpdir(), 'gbrain-5626-home-'));
      mkdirSync(join(dir, 'notes'));
      writeFileSync(join(dir, 'notes', 'good.md'), page('note'));
      writeFileSync(join(dir, 'notes', 'bad.md'), page('meeting-transcript'));
    }, 60_000);
    afterAll(async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    test('reports one type-undeclared issue for the undeclared page', async () => {
      _resetPackCacheForTests();
      const seen: Array<{ file: string; rule: string }> = [];
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, () => runLintCore({
        target: dir,
        engine,
        contentSanity: { disabled: true },
        onPageIssues: (file, issues) => { for (const i of issues) seen.push({ file, rule: i.rule }); },
      }));
      expect(seen.filter((s) => s.rule === 'type-undeclared')).toEqual([{ file: join('notes', 'bad.md'), rule: 'type-undeclared' }]);
    });
  });
});
