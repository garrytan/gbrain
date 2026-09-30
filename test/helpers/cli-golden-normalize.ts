/**
 * Refactor wave 1 (W0, A16b / EO5): normalizers for CLI subprocess goldens.
 *
 * Scrubs only what varies between two runs on the same commit: the temp
 * GBRAIN_HOME, ANSI colour codes, timestamps, durations and request UUIDs.
 * The release version is replaced with `<version>` because every PATCH
 * release bumps it; tests that scrub it also assert the raw output carries
 * exactly package.json's version, so the version contract is still pinned.
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import type { CliResult } from './cli-spawn.ts';
import { scrubDurations, scrubPaths, scrubTimestamps } from './golden.ts';

export const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(join(resolve(import.meta.dir, '..', '..'), 'package.json'), 'utf8'),
).version;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function scrubAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function scrubUuids(text: string): string {
  return text.replace(UUID, '<uuid>');
}

export function scrubVersion(text: string): string {
  return text.split(PACKAGE_VERSION).join('<version>');
}

/**
 * Volatile-text scrubbers in a fixed order. `home` is the temp GBRAIN_HOME.
 * Durations are opt-in: help and refusal text carry contract durations
 * ("default 30s") that must stay pinned.
 */
export function scrubCliText(text: string, home?: string, opts: { durations?: boolean } = {}): string {
  const roots: Record<string, string> = home ? { '<home>': home } : {};
  const base = scrubTimestamps(scrubPaths(scrubAnsi(text), roots));
  return scrubVersion(scrubUuids(opts.durations ? scrubDurations(base) : base));
}

export function lines(text: string): string[] {
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

export function firstLine(text: string): string | null {
  return text.split('\n').find((l) => l.trim() !== '') ?? null;
}

/** Full normalized capture of one invocation, as line arrays (reviewable diffs). */
export function normalizeCliResult(
  r: CliResult,
  home?: string,
  opts: { durations?: boolean } = {},
): { exitCode: number; stdout: string[]; stderr: string[] } {
  return {
    exitCode: r.exitCode,
    stdout: lines(scrubCliText(r.stdout, home, opts)),
    stderr: lines(scrubCliText(r.stderr, home, opts)),
  };
}
