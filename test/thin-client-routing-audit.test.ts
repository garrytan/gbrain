/**
 * v0.32 — thin-client routing audit regression guard.
 *
 * The v0.32 audit (eng-review D3 + Codex round 2 #4) classified every
 * `case '...'` in src/cli.ts's dispatch switch as one of:
 *   - already routed (4 commands)
 *   - already refused (14 commands)
 *   - CLI-local (24 commands)
 *   - route fix added (recall, forget, jobs list/get)
 *   - REFUSE added (7 commands: pages, files, eval, code-def, code-refs,
 *     code-callers, code-callees)
 *
 * This test pins the REFUSE additions. A future refactor that drops one of
 * these from THIN_CLIENT_REFUSED_COMMANDS would silently re-introduce the
 * silent-empty-results bug class v0.31.1 was fixing.
 *
 * The deeper transport-mock routing tests (recall/forget/jobs actually call
 * callRemoteTool with the right params) live in a serial test follow-up; the
 * structural invariants pinned here catch the most common regression mode.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI_TS_PATH = join(import.meta.dir, '..', 'src', 'cli.ts');
const CLI_SOURCE = readFileSync(CLI_TS_PATH, 'utf8');

// Codex round 2 #4 + audit table: every member of this list must be in
// THIN_CLIENT_REFUSED_COMMANDS and have a hint in THIN_CLIENT_REFUSE_HINTS.
// Justifications:
//   - pages: pages.purge-deleted is admin+localOnly (operations.ts:856-864)
//   - files: file_list + file_url MCP ops are localOnly:true
//   - eval:  export/prune/replay touch local engine; no MCP equivalent
//   - code-def / code-refs / code-callers / code-callees: NO MCP ops exist
const V032_REFUSE_ADDITIONS = [
  'pages', 'files', 'eval',
  'code-def', 'code-refs', 'code-callers', 'code-callees',
];

describe('thin-client routing audit — v0.32 REFUSE additions stay in the table', () => {
  test('THIN_CLIENT_REFUSED_COMMANDS set declaration is intact', () => {
    expect(CLI_SOURCE).toContain('const THIN_CLIENT_REFUSED_COMMANDS = new Set([');
  });

  for (const command of V032_REFUSE_ADDITIONS) {
    test(`'${command}' is in THIN_CLIENT_REFUSED_COMMANDS`, () => {
      // We look for the literal in the set declaration. The set is plain
      // text in src/cli.ts so a simple string check is honest: a future
      // refactor that drops the entry would also drop the literal.
      const setStart = CLI_SOURCE.indexOf('const THIN_CLIENT_REFUSED_COMMANDS = new Set([');
      const setEnd = CLI_SOURCE.indexOf(']);', setStart);
      const setBlock = CLI_SOURCE.slice(setStart, setEnd);
      expect(setBlock).toContain(`'${command}'`);
    });

    test(`'${command}' has a hint in THIN_CLIENT_REFUSE_HINTS`, () => {
      const hintsStart = CLI_SOURCE.indexOf(
        'const THIN_CLIENT_REFUSE_HINTS: Record<string, string> = {',
      );
      const hintsEnd = CLI_SOURCE.indexOf('};', hintsStart);
      const hintsBlock = CLI_SOURCE.slice(hintsStart, hintsEnd);
      // Hint keys with embedded dashes are quoted (`'code-def':`); others
      // can be bare (`pages:`). Accept either shape.
      const bareKey = new RegExp(`\\b${command.replace(/-/g, '\\-')}\\s*:`);
      const quotedKey = new RegExp(`['"]${command.replace(/-/g, '\\-')}['"]\\s*:`);
      expect(bareKey.test(hintsBlock) || quotedKey.test(hintsBlock)).toBe(true);
    });
  }

  test('every v0.31.1-era REFUSED command is still in the set (no accidental removals)', () => {
    const setStart = CLI_SOURCE.indexOf('const THIN_CLIENT_REFUSED_COMMANDS = new Set([');
    const setEnd = CLI_SOURCE.indexOf(']);', setStart);
    const setBlock = CLI_SOURCE.slice(setStart, setEnd);
    const v0_31_originals = [
      'sync', 'embed', 'extract', 'migrate', 'apply-migrations',
      'repair-jsonb', 'orphans', 'integrity', 'serve',
      'dream', 'transcripts', 'storage', 'takes', 'sources',
    ];
    for (const cmd of v0_31_originals) {
      expect(setBlock).toContain(`'${cmd}'`);
    }
  });
});

describe('thin-client routing audit — v0.32 ROUTE additions wire callRemoteTool', () => {
  // The route additions are: recall, forget (in recall.ts) + jobs list / get
  // (in jobs.ts). Each file must import callRemoteTool from mcp-client AND
  // call it at least once. If a future refactor removes the import without
  // removing the routing path, the call would fail at runtime — easier to
  // catch at the source-string level.

  test('src/commands/recall.ts imports callRemoteTool + isThinClient', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'commands', 'recall.ts'),
      'utf8',
    );
    expect(src).toContain(`from '../core/config.ts'`);
    expect(src).toContain('isThinClient');
    expect(src).toContain(`from '../core/mcp-client.ts'`);
    expect(src).toContain('callRemoteTool');
  });

  test('src/commands/recall.ts: recall routing branch calls callRemoteTool with op="recall"', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'commands', 'recall.ts'),
      'utf8',
    );
    expect(src).toContain(`callRemoteTool(cfg!, 'recall'`);
  });

  test('src/commands/recall.ts: forget routing branch calls callRemoteTool with op="forget_fact"', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'commands', 'recall.ts'),
      'utf8',
    );
    expect(src).toContain(`callRemoteTool(cfg!, 'forget_fact'`);
  });

  test('src/commands/jobs.ts: list/get routing branches call callRemoteTool', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'commands', 'jobs.ts'),
      'utf8',
    );
    expect(src).toContain(`from '../core/mcp-client.ts'`);
    expect(src).toContain(`callRemoteTool(cfg!, 'list_jobs'`);
    expect(src).toContain(`callRemoteTool(cfg!, 'get_job'`);
  });
});
