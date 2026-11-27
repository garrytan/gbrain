/**
 * Which member a Rust typed refusal names, and whether the Rust engine serves that member. Plain data and parsing, no
 * addon and no `bun:test` import, so the parity harness, the Rust CLI parity test and the unit tests share one rule.
 *
 * The rule (docs/research/rust-test-audit-r2.md, item 6): a case may stop on a typed `engine_capability_missing`
 * refusal only when the member that refused is one the Rust engine does not serve (rust-tally.tsv pins how many cases
 * stop, per file). A refusal by a member the engine reports as served, or by a setup step the harness ran before the
 * case's own members, fails the case with that member named, unless the case has a row in test/rust-stop-pins/ with an
 * owner and a due date.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUST_ENGINE_MEMBERS } from '../../src/core/rust-engine/members.ts';
import { servedCapabilities } from '../../src/core/rust-engine/store-capabilities.ts';
import { STORE_MEMBERS } from '../../src/core/rust-engine/store-members/index.ts';

/** True when `name` is a BrainEngine member the Rust engine serves: a store member, or a lifecycle member. */
export function rustServes(name: string): boolean {
  if (!Object.hasOwn(RUST_ENGINE_MEMBERS, name)) return false;
  return Object.hasOwn(STORE_MEMBERS, name) || (RUST_ENGINE_MEMBERS as Record<string, string>)[name] === 'implemented';
}

/** True when `name` is a BrainEngine member (served or refused), as opposed to a step or command name. */
export function isEngineMember(name: string): boolean {
  return Object.hasOwn(RUST_ENGINE_MEMBERS, name);
}

/** True when the Rust engine reports `capability` as served (every member of it is served). */
export function rustServesCapability(capability: string): boolean {
  return (servedCapabilities() as ReadonlySet<string>).has(capability);
}

function holders(error: unknown): Array<Record<string, unknown>> {
  if (typeof error !== 'object' || error === null) return [];
  const e = error as { detail?: unknown; envelope?: { detail?: unknown } };
  return [error, e.detail, e.envelope, e.envelope?.detail].filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null);
}

/**
 * What a refusal says about itself: `member` is the first word of the name it carries (`getPage (option x)` names
 * `getPage`), `capability` the one it needs, `text` the whole member text. From the refusal's `detail`
 * (`member=<name> capability=<cap> ...`, src/core/rust-engine/errors.ts), or its message when no detail is present.
 */
export interface RefusalFacts { member: string | null; capability: string | null; text: string | null }

export function refusalFacts(error: unknown): RefusalFacts {
  let detail: string | undefined;
  for (const h of holders(error)) if (typeof h.detail === 'string') { detail = h.detail; break; }
  const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : '';
  const fromDetail = detail === undefined ? null : /member=(.+?) capability=(\S+)/.exec(detail);
  const fromMessage = /does not support (.+?) yet \(it needs the (\S+) capability\)/.exec(message);
  const found = fromDetail ?? fromMessage;
  const text = found?.[1] ?? null;
  const reason = holders(error).map((h) => h.reason ?? h.capability).find((r): r is string => typeof r === 'string');
  return { member: text === null ? null : (/^[A-Za-z_$][\w$]*/.exec(text)?.[0] ?? null), capability: found?.[2] ?? reason ?? null, text };
}

// ---- setup refusals --------------------------------------------------------------------------------------------

const setupRefusals = new WeakMap<object, string>();

/**
 * Run one fixture step of a parity case (createSource, restrictFolder, ...). A typed refusal it raises is tagged with the
 * step's name, so the Rust arm can tell a case that stopped in its setup from one that stopped at its own members.
 */
export async function setupStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'engine_capability_missing') setupRefusals.set(error, step);
    throw error;
  }
}

/** The fixture step that raised `error` as a typed refusal, or undefined. */
export function setupRefusalStep(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? setupRefusals.get(error) : undefined;
}

// ---- stop pins ---------------------------------------------------------------------------------------------------

export interface StopPin { file: string; name: string; member: string; owner: string; due: string; reason: string }

const STOP_PIN_DIR = join(import.meta.dir, '..', 'rust-stop-pins');

/**
 * The rows of every `test/rust-stop-pins/<family>.tsv` (one file per family, so families never edit the same file):
 * `file<TAB>case name<TAB>member<TAB>owner<TAB>due<TAB>reason`; `#` starts a comment. A row lets one case stop on the typed
 * refusal of `member` although the Rust engine serves that member, or the case's setup stopped on it. Owner and a
 * `YYYY-MM-DD` due date are required: the row is a promise to fix the gap, not a way to hide it.
 */
export function readStopPins(dir = STOP_PIN_DIR): StopPin[] {
  let names: string[];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.tsv')).sort(); } catch { return []; }
  return names.flatMap((name) => {
    const path = join(dir, name);
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#')).map((line) => {
      const [file, caseName, member, owner, due, reason] = line.split('\t');
      if (!file || !caseName || !member || !owner || !due || !reason) {
        throw new Error(`${path}: a row needs file, case name, member, owner, due date and reason, tab separated: ${line}`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`))) throw new Error(`${path}: the due date must be YYYY-MM-DD: ${line}`);
      return { file, name: caseName, member, owner, due, reason };
    });
  });
}

/** The UTC calendar day, as a pin's due date is written. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
