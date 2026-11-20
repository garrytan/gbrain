/**
 * A page whose frontmatter names its readers with a key that is not exactly
 * `readable_by` (`Readable_By`, `readable-by`, `READABLE_BY`, `readable by`,
 * `readableBy`) is refused (`readers_noncanonical`); it never commits, or comes back
 * as a no-op, as a page every member can read. Page access reads only the exact
 * lowercase `readable_by` key, so any other spelling is stored as an ordinary
 * frontmatter key and the author's restriction is silently lost.
 *
 * Like the private-visibility guard (visibility-request.ts), the key is read from the
 * content's leading frontmatter block line by line and from the parse, so a spelling
 * the parse reshapes or drops is still seen. A page that carries the exact key as well
 * is refused too: the author's intent is ambiguous, and the guard can only refuse, never widen.
 */
import { opError, type OperationError } from '../ops/contract.ts';
import type { ContentRefusal } from '../import-screen.ts';
import type { WriteRequest } from './model.ts';

const READERS_KEY = 'readable_by';
/** The longest spelling a message echoes. */
const SPELLING_MAX = 60;
/** How many spellings a message names. */
const SPELLINGS_NAMED = 3;

/** True when `key` reads as the readers key in another spelling: the same letters once case, `-`, `_` and spaces are ignored. */
const misspelled = (key: string): boolean => key !== READERS_KEY && key.toLowerCase().replace(/[-_\s]+/g, '') === 'readableby';

/** The top-level keys the content's leading frontmatter block states line by line; empty without a closed block. */
function frontmatterLineKeys(content: string): string[] {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (lines[i]?.trim() !== '---') return [];
  const keys: string[] = [];
  for (i++; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^(?:---|\.\.\.)\s*$/.test(line)) return keys;
    if (/^[\s#]/.test(line) || /^-(?:\s|$)/.test(line)) continue;
    const quoted = /^(?:"([^"]*)"|'([^']*)')\s*:(?:\s|$)/.exec(line);
    const plain = quoted ? null : /^(.*?):(?:\s|$)/.exec(line);
    const key = quoted ? (quoted[1] ?? quoted[2]!) : plain?.[1]?.trim();
    if (key) keys.push(key);
  }
  return [];
}

/**
 * The spellings of the readers key `content` (its leading frontmatter block) and `frontmatter`
 * (its parse, or the frontmatter a stored page would keep) carry that page access does not read,
 * in order of appearance, without repeats.
 */
export function misspelledReaderKeys(content: string, frontmatter: Record<string, unknown> | null | undefined): string[] {
  const keys = [...frontmatterLineKeys(content), ...Object.keys(frontmatter ?? {})];
  return [...new Set(keys.filter(misspelled))];
}

/** Printable, bounded and without quotes, so a key a message echoes cannot carry markup, control characters or a long payload. */
const shown = (key: string): string => {
  const clean = key.replace(/[^\x20-\x7E]/g, '?').replace(/[`"']/g, '?');
  return clean.length > SPELLING_MAX ? `${clean.slice(0, SPELLING_MAX)}...` : clean;
};

/** How a message names the keys found: the spellings for a local caller, a plain description when `named` is false. */
function named(keys: readonly string[], showKeys: boolean): string {
  if (!showKeys || !keys.length) return 'a spelling';
  const list = keys.slice(0, SPELLINGS_NAMED).map(key => `\`${shown(key)}\``).join(', ');
  return keys.length > SPELLINGS_NAMED ? `${list} and ${keys.length - SPELLINGS_NAMED} more` : list;
}

const FIX = 'Write the key as readable_by (lowercase, with an underscore) on its own frontmatter line and remove any other spelling of it';

/**
 * The `readers_noncanonical` hold a file earns on sync and import, or null when its frontmatter
 * spells no readers key page access would ignore. `showKeys` false leaves the spelling out of the message.
 */
export function noncanonicalReadersHold(content: string, frontmatter: Record<string, unknown> | null | undefined, showKeys = true): ContentRefusal | null {
  const keys = misspelledReaderKeys(content, frontmatter);
  if (!keys.length) return null;
  return { code: 'readers_noncanonical', message: `The frontmatter names its readers with ${named(keys, showKeys)}, which page access does not read, so the page would be readable by every member; it was not imported. `
    + `${FIX}, then sync or import the file again.` };
}

/** Refuses a write whose content or `published` frontmatter spells the readers key in a way page access does not read; `showKeys` false leaves the spelling out. */
export function assertReadersKeyCanonical(row: Pick<WriteRequest, 'slug' | 'source_id'>, content: string, published: Record<string, unknown> | null | undefined, showKeys = true): void {
  const keys = misspelledReaderKeys(content, published);
  if (keys.length) throw readersNoncanonicalRefusal(row, keys, showKeys);
}

/** The write refusal a `readers_noncanonical` content hold becomes on a writer that has no file to hold (an ingested capture, a brainstorm save, a reconcile). */
export function readersNoncanonicalRefusal(row: Pick<WriteRequest, 'slug' | 'source_id'>, keys: readonly string[], showKeys = true): OperationError {
  return opError('readers_noncanonical', `The write names its readers with ${named(keys, showKeys)}, which page access does not read, so page ${row.slug} would be readable by every member and nothing was written. ${FIX}, and submit again.`,
    `Nothing was written to page ${row.slug} in source ${row.source_id}. ${FIX}, then submit again with a new request_id. A page that restricts its readers lists them as readable_by: [alice-example].`,
    { docs: 'docs/guides/write-refusals.md#readers_noncanonical' });
}
