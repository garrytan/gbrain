/**
 * Added by /ship coverage audit.
 * Value: protects=a failed exposure read prints a warning and reads as null, and no read runs when the change does not federate;
 *   fails_when=the .catch is dropped (federate throws after its config commit) or the federating guard is removed; why_new=sources-federate-member-pages
 *   never fails the read; seam=none; no_claim=the real SQL read (a rejecting executeRaw stands in for a broken database)
 * Value: protects=the operator lines name how many pages beyond the five examples exist, and add no such line when every page is listed;
 *   fails_when=the "... and N more" line is dropped or miscounted; why_new=the CLI cases expose at most two pages; seam=none; no_claim=none beyond protects
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { pagesExposedLines, remotePagesFederationExposesOrWarn, type PagesExposed } from '../src/core/access/federation-exposure.ts';
import type { SqlEngine } from '../src/core/persistence/model.ts';

function engineWith(executeRaw: () => Promise<never>): { engine: SqlEngine; calls: () => number } {
  let n = 0;
  return { engine: { executeRaw: async () => { n++; return executeRaw(); } } as unknown as SqlEngine, calls: () => n };
}

describe('#8982 federation exposure read never changes the federation', () => {
  test('a failed read warns on stderr and reads as null', async () => {
    const { engine, calls } = engineWith(async () => { throw new Error('relation "page_versions" does not exist'); });
    const err: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    try {
      expect(await remotePagesFederationExposesOrWarn(engine, 'source-a', true)).toBeNull();
    } finally { spy.mockRestore(); }
    expect(calls()).toBe(1);
    expect(err.join('\n')).toContain('Warning: could not check source-a for remote-written pages without readers: relation "page_versions" does not exist');
  });

  test('a change that does not federate reads nothing', async () => {
    const { engine, calls } = engineWith(async () => { throw new Error('must not read'); });
    expect(await remotePagesFederationExposesOrWarn(engine, 'source-a', false)).toBeNull();
    expect(calls()).toBe(0);
  });
});

describe('#8982 pagesExposedLines', () => {
  const exposed = (count: number, n: number): PagesExposed => ({
    count, examples: Array.from({ length: n }, (_, i) => ({ slug: `notes/page-${i}`, member: i === 0 ? 'alice-example' : null })),
    check: 'gbrain access who-can-read notes/page-0 --source source-a', restrict: 'gbrain access rule add --prefix notes/ --readers alice-example --source source-a',
  });

  test('more pages than examples name the rest as a count', () => {
    const lines = pagesExposedLines('source-a', exposed(7, 5));
    expect(lines[0]).toContain('Warning: 7 page(s) in source-a');
    expect(lines).toContain('  notes/page-0 (member alice-example)');
    expect(lines).toContain('  notes/page-1 (credential bound to no member now)');
    expect(lines).toContain('  ... and 2 more');
  });

  test('every page listed adds no count line', () => {
    expect(pagesExposedLines('source-a', exposed(3, 3)).some(l => l.includes('more'))).toBe(false);
  });
});
