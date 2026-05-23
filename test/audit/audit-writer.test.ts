/**
 * v0.40.4.0 — shared audit-writer primitive contract.
 *
 * Pins the byte-for-byte contract that the 5 refactored audit modules
 * (rerank-audit, shell-audit, supervisor-audit, audit-slug-fallback,
 * phantom-audit) depend on. A regression here is a regression in
 * every consumer simultaneously, which is precisely the point of
 * unifying them — single test target.
 *
 * Hermetic via `withEnv` for `GBRAIN_AUDIT_DIR` override; tmpdir per
 * test for isolation. No mock.module, no module-load env reads.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import {
  createAuditWriter,
  computeIsoWeekFilename,
  resolveAuditDir,
} from '../../src/core/audit/audit-writer.ts';

interface TestEvent {
  ts: string;
  message: string;
  count?: number;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-audit-writer-test-'));
}

const tmpDirs: string[] = [];
function makeDir(): string {
  const d = tmpDir();
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
});

describe('computeIsoWeekFilename', () => {
  it('formats <prefix>-YYYY-Www.jsonl', () => {
    const name = computeIsoWeekFilename('test-feature', new Date('2026-05-22T12:00:00Z'));
    expect(name).toMatch(/^test-feature-\d{4}-W\d{2}\.jsonl$/);
  });

  it('handles year-boundary edge: 2027-01-01 → 2026-W53', () => {
    // 2027-01-01 is a Friday; the ISO week starts on Monday 2026-12-28.
    const name = computeIsoWeekFilename('phantoms', new Date('2027-01-01T12:00:00Z'));
    expect(name).toBe('phantoms-2026-W53.jsonl');
  });

  it('handles year-boundary edge: 2024-01-01 → 2024-W01', () => {
    // 2024-01-01 is a Monday → ISO week 1 of 2024.
    const name = computeIsoWeekFilename('rerank-failures', new Date('2024-01-01T12:00:00Z'));
    expect(name).toBe('rerank-failures-2024-W01.jsonl');
  });

  it('week numbers zero-pad to two digits', () => {
    const name = computeIsoWeekFilename('shell-jobs', new Date('2026-01-05T12:00:00Z'));
    expect(name).toBe('shell-jobs-2026-W02.jsonl');
  });

  it('different prefixes produce distinct filenames for the same date', () => {
    const d = new Date('2026-05-22T12:00:00Z');
    expect(computeIsoWeekFilename('a', d)).not.toBe(computeIsoWeekFilename('b', d));
  });
});

describe('resolveAuditDir', () => {
  it('honors GBRAIN_AUDIT_DIR override', async () => {
    const dir = makeDir();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      expect(resolveAuditDir()).toBe(dir);
    });
  });

  it('falls back to gbrainPath("audit") when override is unset', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: undefined }, async () => {
      const resolved = resolveAuditDir();
      expect(resolved).toContain('audit');
    });
  });

  it('treats whitespace-only override as unset', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: '   ' }, async () => {
      const resolved = resolveAuditDir();
      // Should fall back to the default path, not literally "   "
      expect(resolved.trim().length).toBeGreaterThan(3);
      expect(resolved).not.toBe('   ');
    });
  });
});

describe('createAuditWriter — log()', () => {
  it('stamps ts at call time when not provided', async () => {
    const dir = makeDir();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter<TestEvent>({ featureName: 'log-stamps-ts' });
      writer.log({ message: 'hello' });
      const file = path.join(dir, writer.computeFilename());
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(1);
      const row = JSON.parse(lines[0]);
      expect(row.message).toBe('hello');
      expect(typeof row.ts).toBe('string');
      expect(Date.parse(row.ts)).toBeGreaterThan(0);
    });
  });

  it('honors caller-supplied ts override', async () => {
    const dir = makeDir();
    const fixedTs = '2026-05-22T14:00:00.000Z';
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter<TestEvent>({ featureName: 'ts-override' });
      writer.log({ ts: fixedTs, message: 'pinned' });
      const file = path.join(dir, writer.computeFilename());
      const content = fs.readFileSync(file, 'utf8');
      const row = JSON.parse(content.trim());
      expect(row.ts).toBe(fixedTs);
      expect(row.message).toBe('pinned');
    });
  });

  it('appends one JSONL line per log() call (no in-place overwrite)', async () => {
    const dir = makeDir();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter<TestEvent>({ featureName: 'append-mode' });
      writer.log({ message: 'first', count: 1 });
      writer.log({ message: 'second', count: 2 });
      writer.log({ message: 'third', count: 3 });
      const file = path.join(dir, writer.computeFilename());
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(3);
      expect(JSON.parse(lines[0]).message).toBe('first');
      expect(JSON.parse(lines[2]).count).toBe(3);
    });
  });

  it('mkdirs the parent directory recursively', async () => {
    const root = makeDir();
    const dir = path.join(root, 'nested', 'deeper', 'audit');
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      // dir does NOT exist yet
      expect(fs.existsSync(dir)).toBe(false);
      const writer = createAuditWriter<TestEvent>({ featureName: 'mkdir-recursive' });
      writer.log({ message: 'creates dirs' });
      expect(fs.existsSync(dir)).toBe(true);
      const file = path.join(dir, writer.computeFilename());
      expect(fs.existsSync(file)).toBe(true);
    });
  });

  it('best-effort: write failure stderr-warns but does not throw', async () => {
    // Force a non-creatable path: use a file-as-dir trick. Create a regular
    // file at `${root}/blocker`, then point GBRAIN_AUDIT_DIR at
    // `${root}/blocker/sub` — mkdirSync(recursive:true) on a path whose
    // parent is a regular file fails with ENOTDIR. The writer must
    // swallow this error and write a stderr line.
    const root = makeDir();
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a dir');
    const badDir = path.join(blocker, 'sub');

    const stderrWrites: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any, ...rest: any[]) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as any;

    try {
      await withEnv({ GBRAIN_AUDIT_DIR: badDir }, async () => {
        const writer = createAuditWriter<TestEvent>({
          featureName: 'fail-open',
          errorLabel: 'test-label',
          errorTrailer: '; trailing-phrase',
        });
        // MUST NOT throw.
        expect(() => writer.log({ message: 'will fail' })).not.toThrow();
      });
    } finally {
      process.stderr.write = origStderrWrite;
    }

    const errMsg = stderrWrites.join('');
    expect(errMsg).toContain('[test-label]');
    expect(errMsg).toContain('write failed');
    expect(errMsg).toContain('trailing-phrase');
  });
});

describe('createAuditWriter — readRecent()', () => {
  it('returns events from current week, filtered by ts cutoff', async () => {
    const dir = makeDir();
    const now = new Date('2026-05-22T12:00:00Z');
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter<TestEvent>({ featureName: 'read-current' });

      // Write 3 events: 1 day ago (in window), 6 days ago (in window),
      // 8 days ago (out of window).
      const inWin1 = new Date(now.getTime() - 1 * 86400000).toISOString();
      const inWin2 = new Date(now.getTime() - 6 * 86400000).toISOString();
      const outOfWin = new Date(now.getTime() - 8 * 86400000).toISOString();

      // All written to current-week file for simplicity (the readRecent
      // window filter is what we're testing, not the cross-week walk).
      writer.log({ ts: inWin1, message: 'in window 1' });
      writer.log({ ts: inWin2, message: 'in window 2' });
      writer.log({ ts: outOfWin, message: 'out of window' });

      const recent = writer.readRecent(7, now);
      expect(recent.length).toBe(2);
      expect(recent.map(e => e.message).sort()).toEqual(['in window 1', 'in window 2']);
    });
  });

  it('walks current + previous ISO week (handles Monday-midnight straddle)', async () => {
    const dir = makeDir();
    // Pick a Monday so the previous week is reachable through the
    // (now - 7 days) computation.
    const now = new Date('2026-05-25T12:00:00Z'); // Monday
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter<TestEvent>({ featureName: 'read-cross-week' });

      // Write an event 5 days ago by directly placing it in the
      // previous-week file. (Simulates events from before the week roll.)
      const previousTs = new Date(now.getTime() - 5 * 86400000).toISOString();
      const previousFile = path.join(
        dir,
        writer.computeFilename(new Date(now.getTime() - 7 * 86400000)),
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(previousFile, JSON.stringify({ ts: previousTs, message: 'previous' }) + '\n');

      // Write a current-week event.
      const currentTs = new Date(now.getTime() - 1 * 86400000).toISOString();
      writer.log({ ts: currentTs, message: 'current' });

      const recent = writer.readRecent(7, now);
      const messages = recent.map(e => e.message).sort();
      expect(messages).toEqual(['current', 'previous']);
    });
  });

  it('skips corrupt JSON lines silently', async () => {
    const dir = makeDir();
    const now = new Date('2026-05-22T12:00:00Z');
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter<TestEvent>({ featureName: 'corrupt-skip' });
      const goodTs = new Date(now.getTime() - 1 * 86400000).toISOString();

      // Write good + corrupt + good directly to the file.
      const file = path.join(dir, writer.computeFilename(now));
      fs.mkdirSync(dir, { recursive: true });
      const content = [
        JSON.stringify({ ts: goodTs, message: 'good-1' }),
        '{not-valid-json',
        JSON.stringify({ ts: goodTs, message: 'good-2' }),
        '',
      ].join('\n');
      fs.writeFileSync(file, content);

      const recent = writer.readRecent(7, now);
      expect(recent.length).toBe(2);
      expect(recent.map(e => e.message).sort()).toEqual(['good-1', 'good-2']);
    });
  });

  it('returns empty array when no audit files exist', async () => {
    const dir = makeDir();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter<TestEvent>({ featureName: 'missing-file' });
      const recent = writer.readRecent(7);
      expect(recent).toEqual([]);
    });
  });

  it('skips events with non-finite ts', async () => {
    const dir = makeDir();
    const now = new Date('2026-05-22T12:00:00Z');
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter<TestEvent>({ featureName: 'non-finite-ts' });
      const file = path.join(dir, writer.computeFilename(now));
      fs.mkdirSync(dir, { recursive: true });
      const content = [
        JSON.stringify({ ts: 'not-a-date', message: 'bad-ts' }),
        JSON.stringify({ ts: '', message: 'empty-ts' }),
        JSON.stringify({ ts: new Date(now.getTime() - 1 * 86400000).toISOString(), message: 'good' }),
      ].join('\n');
      fs.writeFileSync(file, content);
      const recent = writer.readRecent(7, now);
      expect(recent.length).toBe(1);
      expect(recent[0].message).toBe('good');
    });
  });
});

describe('createAuditWriter — round-trip', () => {
  it('log then readRecent recovers every field', async () => {
    const dir = makeDir();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter<TestEvent>({ featureName: 'round-trip' });
      writer.log({ message: 'round-trip-test', count: 42 });
      const recent = writer.readRecent(7);
      expect(recent.length).toBe(1);
      expect(recent[0].message).toBe('round-trip-test');
      expect(recent[0].count).toBe(42);
      expect(typeof recent[0].ts).toBe('string');
    });
  });

  it('preserves arbitrary nested fields', async () => {
    const dir = makeDir();
    interface NestedEvent {
      ts: string;
      nested: { a: number; b: string[]; c: { deep: boolean } };
    }
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter<NestedEvent>({ featureName: 'nested-fields' });
      writer.log({ nested: { a: 1, b: ['x', 'y'], c: { deep: true } } });
      const recent = writer.readRecent(7);
      expect(recent[0].nested.a).toBe(1);
      expect(recent[0].nested.b).toEqual(['x', 'y']);
      expect(recent[0].nested.c.deep).toBe(true);
    });
  });
});

describe('createAuditWriter — filename behavior', () => {
  it('computeFilename uses featureName as prefix', () => {
    const writer = createAuditWriter({ featureName: 'my-feature' });
    const name = writer.computeFilename(new Date('2026-05-22T12:00:00Z'));
    expect(name.startsWith('my-feature-')).toBe(true);
    expect(name.endsWith('.jsonl')).toBe(true);
  });

  it('resolveDir matches the module-level resolveAuditDir', async () => {
    const dir = makeDir();
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const writer = createAuditWriter({ featureName: 'resolve-dir-check' });
      expect(writer.resolveDir()).toBe(dir);
      expect(writer.resolveDir()).toBe(resolveAuditDir());
    });
  });
});
