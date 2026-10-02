/**
 * Refactor wave 1 (W0) golden-file harness.
 *
 * A golden pins an output captured on master so a behavior-preserving refactor
 * must reproduce it byte for byte. Every golden goes through a NAMED normalizer
 * (timestamps, durations, temp paths, Map/Set iteration order) so the only
 * differences it can report are real ones. Each normalizer is proven by
 * capturing the golden twice and diffing to empty (`expectNormalizerStable`).
 *
 * Fixtures live under `test/fixtures/goldens/`. Regenerate deliberately with
 * `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test <file>`; a regenerated golden is a
 * reviewer-visible diff and must be justified in the PR body.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { expect } from 'bun:test';

export const GOLDENS_DIR = resolve(import.meta.dir, '..', 'fixtures', 'goldens');

export interface Normalizer<T = unknown> {
  /** Stable name recorded in the golden header, e.g. `doctor-json-v1`. */
  readonly name: string;
  readonly apply: (value: T) => unknown;
}

export function defineNormalizer<T>(name: string, apply: (value: T) => unknown): Normalizer<T> {
  return { name, apply };
}

/** Identity normalizer for outputs with no volatile content. */
export const IDENTITY: Normalizer = defineNormalizer('identity', (v) => v);

/** JSON with object keys sorted recursively; arrays keep their order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + '\n';
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value instanceof Map) {
    const entries: Array<[string, unknown]> = [...value.entries()].map(([k, v]) => [String(k), sortKeysDeep(v)]);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  if (value instanceof Set) return [...value].map(sortKeysDeep).sort(compareJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === 'bigint') return `${value}n`;
  return value;
}

function compareJson(a: unknown, b: unknown): number {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ─── Normalizer building blocks ─────────────────────────────────────────

const ISO_TS = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|m|min)\b/g;

/** Replace ISO-8601 timestamps with `<ts>`. */
export function scrubTimestamps(text: string): string {
  return text.replace(ISO_TS, '<ts>');
}

/** Replace `123ms` / `1.2s` style durations with `<dur>`. */
export function scrubDurations(text: string): string {
  return text.replace(DURATION, '<dur>');
}

/** Replace the OS temp dir and any extra roots (longest first) with placeholders. */
export function scrubPaths(text: string, roots: Record<string, string> = {}): string {
  const entries: Array<[string, string]> = [...Object.entries(roots), ['<tmp>', tmpdir()]];
  entries.sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [label, root] of entries) {
    if (root) out = out.split(root).join(label);
  }
  return out;
}

/** Walk a JSON value and apply `fn` to every string leaf. */
export function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

/** Replace values of keys matching `pattern` (e.g. /_ms$|duration/) with `<volatile>`. */
export function scrubKeys(value: unknown, pattern: RegExp, replacement: unknown = '<volatile>'): unknown {
  if (Array.isArray(value)) return value.map((v) => scrubKeys(v, pattern, replacement));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = pattern.test(k) ? replacement : scrubKeys(v, pattern, replacement);
    }
    return out;
  }
  return value;
}

// ─── Assertions ─────────────────────────────────────────────────────────

function render(normalizer: Normalizer<any>, actual: unknown): string {
  const body = normalizer.apply(actual);
  return stableStringify({ normalizer: normalizer.name, golden: body });
}

/**
 * Compare `actual` (after `normalizer`) with `test/fixtures/goldens/<name>.json`.
 * With `GBRAIN_TEST_UPDATE_GOLDENS=1` the fixture is (re)written instead.
 */
export function expectGolden<T>(name: string, actual: T, normalizer: Normalizer<T>): void {
  const file = join(GOLDENS_DIR, `${name}.json`);
  const text = render(normalizer, actual);
  if (process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(
      `FAIL: missing golden ${file}\nWhy: every W0 golden is captured on master before any move.\nFix: GBRAIN_TEST_UPDATE_GOLDENS=1 bun test <this file> on master, then review and commit the fixture.\nSee: test/fixtures/goldens/README.md`,
    );
  }
  const expected = readFileSync(file, 'utf8');
  if (text !== expected) {
    console.error(
      `FAIL: golden ${file} differs from the current output\nWhy: goldens pin behavior; a diff is either a regression or an intentional change.\nFix: if intentional, GBRAIN_TEST_UPDATE_GOLDENS=1 bun test <this file>, review the fixture diff and explain it in the PR body.\nSee: test/fixtures/goldens/README.md`,
    );
  }
  expect(text).toBe(expected);
}

/** Prove a normalizer: two independent captures must normalize to the same bytes. */
export async function expectNormalizerStable<T>(capture: () => T | Promise<T>, normalizer: Normalizer<T>): Promise<T> {
  const first = await capture();
  const second = await capture();
  expect(render(normalizer, second)).toBe(render(normalizer, first));
  return first;
}
