/**
 * #7897 class guard: every call that imports page content (`importFromContent`, `importFromFile` / `importFile`,
 * `screenImportContent`) either holds a private request page privacy does not read, or is audited here as held some
 * other way or as a derived or eval-only write. External bytes stored without the hold were the #7841 / #7848 / #7880 /
 * #7897 bug class: `Visibility: private` landing as a world-readable page.
 *
 * Fails when: a source file gains an unflagged call that is not in AUDITED (opt in with `holdNoncanonicalPrivate: true`,
 * or add the call with its reason), an audited call goes away (remove it), or `importFromFile` stops holding.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Entry = 'importFromContent' | 'screenImportContent';
type Audit = { calls: Partial<Record<Entry, number>>; disposition: 'held' | 'derived' | 'eval'; why: string };

const AUDITED: Record<string, Audit> = {
  'src/commands/eval-longmemeval.ts': { calls: { importFromContent: 1 }, disposition: 'eval', why: 'benchmark haystack pages into a throwaway in-memory brain' },
  'src/commands/quarantine.ts': { calls: { importFromContent: 2 }, disposition: 'derived', why: 're-imports the stored page\'s own markdown' },
  'src/commands/reindex.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 're-serializes the stored page to re-chunk it' },
  'src/core/company-brain/demo.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 'the bundled fictional sample, into a throwaway in-memory brain' },
  'src/core/cycle/concept-writes.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 'a concept page gbrain serializes; derived writers never refuse (#7848)' },
  'src/core/cycle/pattern-claim-sources.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 're-serializes the stored page' },
  'src/core/cycle/patterns.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 're-serializes the stored page' },
  'src/core/cycle/synthesize-verify.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 'the verified rewrite of a page gbrain synthesized' },
  'src/core/enrichment-service.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 'a stub whose frontmatter gbrain builds (serializeMarkdown)' },
  'src/core/generations/adapters/page.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 'a stored preimage or a producer page gbrain serializes' },
  'src/core/import-file.ts': { calls: { importFromContent: 2 }, disposition: 'held', why: 'the identity-move retry passes the caller\'s options; importFromFile holds before it imports' },
  'src/core/minions/handlers/ingest-capture.ts': { calls: { importFromContent: 2 }, disposition: 'held', why: 'the shared import options set holdNoncanonicalPrivate (#7880)' },
  'src/core/oversized-backfill.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 're-serializes the stored page' },
  'src/core/persistence/connector-sync.ts': { calls: { importFromContent: 1 }, disposition: 'derived',
    why: 'GitHub and Google renders: fixed keys, provider text only as quoted values, visibility: private only in lowercase; the rest is the stored page' },
  'src/core/persistence/file-repair.ts': { calls: { importFromContent: 2 }, disposition: 'held', why: 'screenSyncImport screens the same bytes with the hold first' },
  'src/core/persistence/import-prepare.ts': { calls: { importFromContent: 1 }, disposition: 'held', why: 'screened with the hold before the import' },
  'src/core/persistence/page-prepare.ts': { calls: { importFromContent: 1 }, disposition: 'held', why: 'put_page, edit_page and capture refuse visibility_not_applied first' },
  'src/core/persistence/sync-prepare.ts': { calls: { importFromContent: 2, screenImportContent: 2 }, disposition: 'held',
    why: 'screenSyncImport screens with the hold first; the two unflagged screens are code files, which carry no frontmatter' },
  'src/core/transcripts/ingest.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 'render.ts writes fixed keys; other keys come from the stored page' },
  'src/core/trust/page-handlers.ts': { calls: { importFromContent: 1 }, disposition: 'derived', why: 'a stored version\'s markdown' },
  'src/eval/brainbench/metrics/write-back.ts': { calls: { importFromContent: 1 }, disposition: 'eval', why: 'benchmark brain' },
  'src/eval/brainbench/seed.ts': { calls: { importFromContent: 1 }, disposition: 'eval', why: 'benchmark brain' },
  'src/eval/longmemeval/call-plan.ts': { calls: { screenImportContent: 1 }, disposition: 'eval', why: 'cost plan; stores nothing' },
  'src/eval/longmemeval/diagnostics.ts': { calls: { importFromContent: 1 }, disposition: 'eval', why: 'throwaway in-memory brain' },
};

const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = `${dir}/${name}`;
  return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
});

/** Every call of an import entry point in src, with whether its arguments opt in to the hold. */
function importCalls(): Array<{ file: string; line: number; fn: string; held: boolean }> {
  return walk('src').sort().flatMap(file => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/\b(importFromContent|importFromFile|importFile|screenImportContent)\(/g)].flatMap(match => {
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const lead = text.slice(lineStart, match.index);
      if (/^\s*(\*|\/\/|\/\*)/.test(lead) || /function\s+$/.test(lead)) return [];
      let depth = 0, end = match.index + match[0].length - 1;
      for (; end < text.length; end++) if (text[end] === '(') depth++; else if (text[end] === ')' && --depth === 0) break;
      return [{ file, line: text.slice(0, match.index).split('\n').length, fn: match[1]!, held: text.slice(match.index, end).includes('holdNoncanonicalPrivate') }];
    });
  });
}

describe('import entry points hold a non-canonical private request (#7897)', () => {
  test('every unflagged importFromContent / screenImportContent call is audited, and every audited call still exists', () => {
    const unflagged = importCalls().filter(call => !call.held && (call.fn === 'importFromContent' || call.fn === 'screenImportContent'));
    const counted: Record<string, Partial<Record<Entry, number>>> = {};
    for (const call of unflagged) (counted[call.file] ??= {})[call.fn as Entry] = (counted[call.file]![call.fn as Entry] ?? 0) + 1;
    const unaudited = unflagged.filter(call => (counted[call.file]![call.fn as Entry] ?? 0) > (AUDITED[call.file]?.calls[call.fn as Entry] ?? 0)).map(call => `${call.file}:${call.line} ${call.fn}`);
    expect(unaudited).toEqual([]);
    expect(counted).toEqual(Object.fromEntries(Object.entries(AUDITED).map(([file, audit]) => [file, audit.calls])));
  });

  test('importFromFile holds before it imports, so its callers need no opt-in', () => {
    // test-reads-source-ok[structural]: the hold must run before the import inside importFromFile; call order is the contract this audit relies on.
    const source = readFileSync(join('src', 'core', 'import-file.ts'), 'utf8');
    const body = source.slice(source.indexOf('export async function importFromFile('), source.indexOf('\nexport ', source.indexOf('export async function importFromFile(') + 1));
    expect(body.indexOf('noncanonicalPrivateHold(content')).toBeGreaterThan(0);
    expect(body.indexOf('noncanonicalPrivateHold(content')).toBeLessThan(body.indexOf('importFromContent('));
  });
});
