// `gbrain schema lint <name>` must lint the RESOLVED manifest.
//
// The named-pack branch of runLintCmd loads the manifest with loadPackFromFile,
// which returns the raw child with its `extends` chain unresolved. Every lint
// rule tests against `manifest.page_types`, so an extending pack that maps
// `frontmatter_links` onto an INHERITED type (e.g. `note` from gbrain-base-v2)
// is reported as referencing an undeclared page type -- a type the resolved
// pack plainly declares.
//
// The no-name branch does not have this bug: it goes through loadActivePack,
// which walks the chain.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSchema } from '../src/commands/schema.ts';
import { withEnv } from './helpers/with-env.ts';

/** Extends gbrain-base-v2 and declares NO page types of its own. */
const CHILD_PACK = `api_version: gbrain-schema-pack-v1
name: extends-child-test
version: 1.0.0
description: extending pack that reuses inherited base-v2 types
extends: gbrain-base-v2
page_types: []
link_types:
  - name: part_of
    inverse: contains
frontmatter_links:
  - page_type: note
    fields: [part_of]
    link_type: part_of
`;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-lint-extends-'));
  const dir = join(home, '.gbrain', 'schema-packs', 'extends-child-test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), CHILD_PACK);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('schema lint resolves the extends chain for a named pack', () => {
  test('an extending pack that reuses inherited types lints clean', async () => {
    const lines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExit = process.exit;
    let exitCode = 0;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    (process as unknown as { exit: (c?: number) => void }).exit = ((c?: number) => {
      exitCode = c ?? 0;
      throw new Error('__exit__');
    }) as never;

    try {
      await withEnv({ GBRAIN_HOME: home }, () => runSchema(['lint', 'extends-child-test', '--json']));
    } catch (e) {
      if ((e as Error).message !== '__exit__') throw e;
    } finally {
      console.log = origLog;
      console.error = origErr;
      (process as unknown as { exit: typeof origExit }).exit = origExit;
    }

    const out = lines.join('\n');
    const start = out.indexOf('{');
    expect(start, `expected JSON lint output, got:\n${out}`).toBeGreaterThanOrEqual(0);
    const report = JSON.parse(out.slice(start));

    const undeclared = (report.errors ?? []).filter(
      (e: { rule: string }) =>
        e.rule === 'frontmatter_links_undeclared_page_type' ||
        e.rule === 'frontmatter_links_undeclared_link_type',
    );

    expect(
      undeclared,
      `inherited base-v2 types must not be reported undeclared: ${JSON.stringify(undeclared)}`,
    ).toEqual([]);
    expect(exitCode).toBe(0);
  });
});
