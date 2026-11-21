/**
 * Tripwire for loss row L7-1 (docs/designs/RUST_ENGINE.md): a Rust brain cannot meet a worktree refresh row today.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: no shipped path writes or imports a `persistence_worktree_refreshes` row into a Rust store. The graduation
 *    inventory does not carry the relation to Rust (`engines.rust` is false), and the Rust store's only code that
 *    creates a refresh row in its keyspace (`put_refresh`, worktree_admission.rs) is compiled for tests only; the one
 *    production write there (`complete_synced_refresh_in`) rewrites a row it has just read. Rust
 *    `listResumableRefreshes` ignores that keyspace, so if a row ever arrives, admission fences its sources and the
 *    owner never resumes it: no resume, no refusal, no log.
 *  - Regression: none yet. This file fails by itself the day either path opens, so the change that opens it must also
 *    ship the typed Rust refresh resume (or the swap refusal of a brain with a non-terminal refresh row).
 *  - Why existing coverage misses it: the parity arms never hold a refresh row on Rust, and the inventory tests check
 *    the relation set, not which engines carry each relation.
 *  - Seam: none. It reads the inventory constant and the Rust store's source text.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRADUATION_INVENTORY } from '../src/core/persistence/graduation-inventory.ts';

const REQUIRED = 'typed Rust refresh resume required (L7-1)';
const ADMISSION = join(import.meta.dir, '..', 'rust', 'crates', 'gbrain-store', 'src', 'persistence', 'worktree_admission.rs');

/** The source text before the file's test module, with each `#[cfg(test)]` item removed up to its closing brace. */
function productionText(path: string): string {
  const text = readFileSync(path, 'utf8');
  const tests = text.indexOf('#[cfg(test)]\nmod tests');
  let body = tests === -1 ? text : text.slice(0, tests);
  for (let at = body.indexOf('#[cfg(test)]'); at !== -1; at = body.indexOf('#[cfg(test)]')) {
    const open = body.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < body.length; end++) {
      if (body[end] === '{') depth++;
      else if (body[end] === '}' && --depth === 0) break;
    }
    body = body.slice(0, at) + body.slice(end + 1);
  }
  return body;
}

/** The name of each production function that writes a refresh key. */
function refreshKeyWriters(text: string): string[] {
  const writers: string[] = [];
  const pattern = /put_json\(\s*[a-z_]+\s*,\s*&refresh_key\(/g;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const before = text.slice(0, m.index);
    const fn = [...before.matchAll(/fn ([a-z_0-9]+)/g)].at(-1)?.[1] ?? '(none)';
    writers.push(fn);
  }
  return writers;
}

describe('a Rust brain meets no worktree refresh row (L7-1)', () => {
  test('the graduation inventory does not carry persistence_worktree_refreshes to the Rust engine', () => {
    const row = GRADUATION_INVENTORY.entries.find(entry => entry.relation === 'persistence_worktree_refreshes');
    expect(row, 'persistence_worktree_refreshes has no graduation inventory row').toBeDefined();
    expect(row!.engines.rust, `persistence_worktree_refreshes now carries to the Rust engine: ${REQUIRED}`).toBe(false);
  });

  test('the Rust store writes a refresh row only where it rewrites one it read', () => {
    const text = productionText(ADMISSION);
    expect(refreshKeyWriters(text), `a production Rust writer of the refresh keyspace appeared: ${REQUIRED}`)
      .toEqual(['complete_synced_refresh_in']);
    // Every other use of the keyspace prefix is the key builder and the scan that reads every row.
    expect(text.split('keys::PERSISTENCE, REFRESH').length - 1, `a new use of the refresh keyspace appeared: ${REQUIRED}`).toBe(2);
    // The test-only creator stays test-only.
    expect(text.includes('fn put_refresh'), `put_refresh is no longer #[cfg(test)]: ${REQUIRED}`).toBe(false);
    expect(readFileSync(ADMISSION, 'utf8')).toContain('#[cfg(test)]\npub(crate) fn put_refresh(');
  });
});
