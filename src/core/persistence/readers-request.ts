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

/** Where a value's text leaves the scan: inside a flow collection (`{`, `[`) or a quoted scalar a line break did not close. */
interface ValueState { depth: number; quote: '"' | "'" | null; last: string }

/** Advances `state` over `text`, the rest of a line: flow brackets and quotes open only where a YAML value can start (an anchor or a tag before one does not hide it), and a `#` after a space is a comment. */
function scanValue(text: string, state: ValueState): void {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (state.quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') { state.quote = null; state.last = c; }
    } else if (state.quote === "'") {
      if (c !== "'") continue;
      if (text[i + 1] === "'") i++;
      else { state.quote = null; state.last = c; }
    } else {
      if (c === '#' && (i === 0 || /\s/.test(text[i - 1]!))) return;
      if (/\s/.test(c)) continue;
      const startsValue = state.last === '' || ':[{,'.includes(state.last);
      if ((c === '&' || c === '!') && startsValue) {
        // An anchor or a tag decorates the value after it: skip it and leave `last`, so a `{` or `[` after it still opens a collection.
        const end = c === '!' && text[i + 1] === '<' ? text.indexOf('>', i) : -1;
        if (end >= 0) i = end;
        else while (i + 1 < text.length && !/[\s,[\]{}]/.test(text[i + 1]!)) i++;
        continue;
      }
      if ((c === '"' || c === "'") && startsValue) state.quote = c;
      else if ((c === '[' || c === '{') && startsValue) state.depth++;
      else if ((c === ']' || c === '}') && state.depth > 0) state.depth--;
      state.last = c;
    }
  }
}

/**
 * The top-level keys the content's leading frontmatter block states line by line; empty without a closed block.
 * A line inside a flow collection or a multiline quoted scalar belongs to its value and names no key (it parses as nested data);
 * when such a value never closes before the block ends the block is ambiguous, so every key-looking line counts (the guard only refuses).
 */
function frontmatterLineKeys(content: string): string[] {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (lines[i]?.trim() !== '---') return [];
  const keys: string[] = [];
  const every: string[] = [];
  const state: ValueState = { depth: 0, quote: null, last: '' };
  for (i++; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^(?:---|\.\.\.)\s*$/.test(line)) return state.depth > 0 || state.quote ? every : keys;
    const inside = state.depth > 0 || state.quote !== null;
    if (inside) scanValue(line, state);
    if (/^[\s#]/.test(line) || /^-(?:\s|$)/.test(line)) continue;
    const quoted = /^(?:"([^"]*)"|'([^']*)')\s*:(?:\s|$)/.exec(line);
    const plain = quoted ? null : /^(.*?):(?:\s|$)/.exec(line);
    const key = quoted ? (quoted[1] ?? quoted[2]!) : plain?.[1]?.trim();
    if (!key) continue;
    every.push(key);
    if (inside) continue;
    state.last = '';
    scanValue(line.slice((quoted ?? plain)![0].length), state);
    keys.push(key);
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

/**
 * What fixing the key does, for every fix text: the renamed key restricts the page to the readers it lists, so the owner's member must be in the
 * list for the owner's member-bound keys to keep reading it, and `gbrain access check` shows who can read it.
 */
export const READERS_FIX_EFFECT = "Renaming the key restricts the page to the members it lists, so list the owner's member too if the owner's member-bound keys must still read it, "
  + 'then check who can read it with gbrain access check --token <name> --as <member>.';

/** The next step for a source whose holds are all `readers_noncanonical`: no repair rewrites who may read a page, so read the status, edit each file and sync. */
export function readersHoldSteps(sourceId: string): { argv: string[]; commands: string[]; text: string } {
  const status = ['gbrain', 'sources', 'status', sourceId, '--json'], sync = `gbrain sync --source ${sourceId} --no-pull`;
  return { argv: status, commands: [status.join(' '), sync],
    text: `the readers_noncanonical hold(s) are files whose readers key page access does not read, which no repair rewrites: ${status.join(' ')} names each file; edit it so the key is readable_by, commit, then run ${sync}. ${READERS_FIX_EFFECT}` };
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
    + `${FIX}, then sync or import the file again. ${READERS_FIX_EFFECT}` };
}

/** Refuses a write whose content or `published` frontmatter spells the readers key in a way page access does not read; `showKeys` false leaves the spelling out. */
export function assertReadersKeyCanonical(row: Pick<WriteRequest, 'slug' | 'source_id'>, content: string, published: Record<string, unknown> | null | undefined, showKeys = true): void {
  const keys = misspelledReaderKeys(content, published);
  if (keys.length) throw readersNoncanonicalRefusal(row, keys, showKeys);
}

/** The write refusal a `readers_noncanonical` content hold becomes on a writer that has no file to hold (an ingested capture, a brainstorm save, a reconcile). */
export function readersNoncanonicalRefusal(row: Pick<WriteRequest, 'slug' | 'source_id'>, keys: readonly string[], showKeys = true): OperationError {
  return opError('readers_noncanonical', `The write names its readers with ${named(keys, showKeys)}, which page access does not read, so page ${row.slug} would be readable by every member and nothing was written. ${FIX}, and submit again. ${READERS_FIX_EFFECT}`,
    `Nothing was written to page ${row.slug} in source ${row.source_id}. ${FIX}, then submit again with a new request_id. A page that restricts its readers lists them as readable_by: [alice-example]. ${READERS_FIX_EFFECT}`,
    { docs: 'docs/guides/write-refusals.md#readers_noncanonical' });
}
