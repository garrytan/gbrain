/**
 * Tests for `sync --all --missing-path <fail|skip>`.
 *
 * Why this exists:
 *   `sources.local_path` is machine-specific state in a brain-wide table.
 *   Any brain whose sources were registered from more than one machine —
 *   or a sanctioned setup mid-migration (docs/architecture/topologies.md
 *   Topology 2, or the system-of-record git flow before every repo is
 *   cloned) — has sources whose checkout is simply not present on the
 *   machine running `sync --all`. Today each of those is reported as a
 *   hard per-source failure ("Not a git repository: <path>") and the run
 *   exits rc=1, every run. On one observed fleet that was 12 phantom
 *   failures per hour with zero actionable signal, which trains operators
 *   to ignore the exit code — the worst possible property for a cron.
 *
 *   `--missing-path skip` classifies those sources honestly instead:
 *   status `skipped_missing_path` in the --json envelope, a ⊘ line in the
 *   human aggregate, excluded from error_count and from the rc=1 gate.
 *
 *   The DEFAULT stays `fail`: on a single-machine brain a missing
 *   local_path usually means an unmounted volume or a deleted checkout,
 *   and silently skipping it would hide real data loss. Skip is opt-in.
 *
 * These tests pin the two pure helpers (same style as
 * sync-all-parallel.test.ts — no DB, no fs):
 *   1. parseMissingPathMode(): flag parsing, default, loud rejection of
 *      bad values (paste-ready hint names the flag and both values).
 *   2. partitionMissingPathSources(): classification is driven ONLY by
 *      the injected pathExists predicate; null local_path passes through
 *      as runnable (pure-DB sources are already excluded from --all by
 *      the local_path IS NOT NULL SELECT — defensive, not load-bearing).
 */
import { describe, expect, test } from 'bun:test';
import {
  parseMissingPathMode,
  partitionMissingPathSources,
} from '../src/commands/sync.ts';

// ── parseMissingPathMode ────────────────────────────────────────────

describe('parseMissingPathMode', () => {
  test('defaults to fail when the flag is absent', () => {
    expect(parseMissingPathMode([])).toBe('fail');
    expect(parseMissingPathMode(['--all', '--no-embed'])).toBe('fail');
  });

  test('parses skip and fail explicitly', () => {
    expect(parseMissingPathMode(['--all', '--missing-path', 'skip'])).toBe('skip');
    expect(parseMissingPathMode(['--all', '--missing-path', 'fail'])).toBe('fail');
  });

  test('rejects an unknown value with a paste-ready hint', () => {
    expect(() => parseMissingPathMode(['--missing-path', 'ignore']))
      .toThrow(/--missing-path.*(fail|skip)/);
  });

  test('rejects a dangling flag (no value)', () => {
    expect(() => parseMissingPathMode(['--all', '--missing-path']))
      .toThrow(/--missing-path/);
  });

  test('does not swallow a following flag as its value', () => {
    // `--missing-path --json` is a mistake, not "mode --json".
    expect(() => parseMissingPathMode(['--missing-path', '--json']))
      .toThrow(/--missing-path/);
  });
});

// ── partitionMissingPathSources ─────────────────────────────────────

type Src = { id: string; local_path: string | null };
const src = (id: string, local_path: string | null): Src => ({ id, local_path });

describe('partitionMissingPathSources', () => {
  test('splits sources by the injected pathExists predicate', () => {
    const sources = [src('here', '/present'), src('elsewhere', '/absent')];
    const { runnable, missing } = partitionMissingPathSources(
      sources, (p) => p === '/present');
    expect(runnable.map((s) => s.id)).toEqual(['here']);
    expect(missing.map((s) => s.id)).toEqual(['elsewhere']);
  });

  test('null local_path stays runnable (pure-DB sources are not "missing")', () => {
    const { runnable, missing } = partitionMissingPathSources(
      [src('db-only', null)], () => false);
    expect(runnable.map((s) => s.id)).toEqual(['db-only']);
    expect(missing).toEqual([]);
  });

  test('all-missing and empty inputs are well-formed', () => {
    const allMissing = partitionMissingPathSources(
      [src('a', '/x'), src('b', '/y')], () => false);
    expect(allMissing.runnable).toEqual([]);
    expect(allMissing.missing.map((s) => s.id)).toEqual(['a', 'b']);

    const empty = partitionMissingPathSources([], () => true);
    expect(empty.runnable).toEqual([]);
    expect(empty.missing).toEqual([]);
  });

  test('never consults the predicate for null paths and preserves order', () => {
    const asked: string[] = [];
    const sources = [src('a', '/1'), src('b', null), src('c', '/2')];
    const { runnable } = partitionMissingPathSources(sources, (p) => {
      asked.push(p);
      return true;
    });
    expect(asked).toEqual(['/1', '/2']);
    expect(runnable.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});
