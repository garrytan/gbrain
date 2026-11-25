import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import type { BrainEngine } from '../../../core/engine.ts';
import type { BulkFactDay } from '../../../core/facts/bulk-days.ts';
import type { FactDateOriginalRef } from '../../../core/engine-sql/fact-date-evidence.ts';
import { stripCodeBlocks } from '../../../core/markdown-code.ts';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const positiveInt = z.number().int().positive().max(2_147_483_647);
const shaHex = z.string().regex(/^[a-f0-9]{64}$/);
const manifest = z.strictObject({
  version: z.literal(1),
  facts: z.array(z.strictObject({
    source_id: z.string().min(1).max(255),
    fact_id: positiveInt,
    entity_slug: z.string().max(2048).nullable(),
    valid_from: z.iso.datetime({ offset: true }),
    claim_sha256: shaHex,
    original_page_id: positiveInt,
    original_revision: z.uuid(),
    excerpt_start: positiveInt,
    excerpt_length: positiveInt.max(4000),
    excerpt_sha256: shaHex,
    event_day: z.iso.date(),
  })).max(4000),
});
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const dateEvidenceKey = (source: string, day: string) => JSON.stringify([source, day]);

type Counts = { verified_same_day: number; verified_different_day: number; unknown: number };

function loadManifest(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !stat.size || stat.size > MAX_MANIFEST_BYTES) throw new Error('Invalid evidence file');
    const data = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < data.length) {
      const n = readSync(fd, data, length, data.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length !== stat.size) throw new Error('Evidence file changed during read');
    return manifest.parse(JSON.parse(data.subarray(0, length).toString('utf8')));
  } finally { closeSync(fd); }
}

const originalKey = (row: FactDateOriginalRef) => JSON.stringify([row.source_id, String(row.original_page_id), row.original_revision]);
const mask = (text: string) => text.replace(/[^\r\n]/g, ' ');

function prepareOriginal(body: string) {
  const offsets = [0];
  let end = 0;
  for (const character of body) { end += character.length; offsets.push(end); }
  const prose = stripCodeBlocks(body, { onHtmlComment() {} })
    .replace(/^\s*(?:\||\[[^\]\r\n]+\]:)[^\r\n]*/gm, mask)
    .replace(/\[\[([^\]\r\n]*?)\]\]/g, (link: string, inner: string) => {
      const separator = inner.indexOf('|');
      return separator < 0 ? mask(link) : mask(link.slice(0, separator + 3)) + inner.slice(separator + 1) + '  ';
    })
    .replace(/\]\([^()\r\n]*\)|(?:[a-z]+:\/\/|www\.)[^\s<>()\[\]]+/gi, mask)
    .replace(/\d{4}-\d{2}-\d{2}(?=[ \t]*[「『《“])/g, mask);
  const dates = [...prose.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g)];
  return { body, offsets, prose, dates };
}

function validatesExcerpt(original: ReturnType<typeof prepareOriginal>, entry: z.infer<typeof manifest>['facts'][number]): boolean {
  const start = original.offsets[entry.excerpt_start - 1];
  const end = original.offsets[entry.excerpt_start - 1 + entry.excerpt_length];
  if (start === undefined || end === undefined || digest(original.body.slice(start, end)) !== entry.excerpt_sha256) return false;
  if (!/\p{L}/u.test(original.prose.slice(start, end))) return false;
  const dates = new Set(original.dates.filter(match => match.index >= start && match.index+match[0].length <= end).map(match => match[0]));
  return dates.size === 1 && dates.has(entry.event_day);
}

/** Verify operator-reviewed evidence against the live fact and its exact original revision. */
export async function factDateEvidence(engine: BrainEngine, days: BulkFactDay[], path: string) {
  const input = loadManifest(path);
  const totals = new Map<string, Counts>(days.map(day => [dateEvidenceKey(day.source_id, day.day),
    { verified_same_day: 0, verified_different_day: 0, unknown: day.facts }]));
  if (!days.length || !input.facts.length) return totals;
  const { matches, originals: revisions } = await engine.readFactDateEvidence(
    days.map(({ source_id, day }) => ({ source_id, day })), input.facts,
  );
  const originals = new Map(revisions.map(row => [originalKey(row), prepareOriginal(row.body)]));
  const facts = new Map<string, { cohort: string; storedDay: string; evidenceDays: Set<string> }>();
  for (const { index, storedDay } of matches) {
    const entry = input.facts[index]!;
    const original = originals.get(originalKey(entry));
    if (!original || !validatesExcerpt(original, entry)) continue;
    const id = JSON.stringify([entry.source_id, entry.fact_id]);
    const fact = facts.get(id) ?? { cohort: dateEvidenceKey(entry.source_id, storedDay), storedDay, evidenceDays: new Set<string>() };
    fact.evidenceDays.add(entry.event_day);
    facts.set(id, fact);
  }
  for (const fact of facts.values()) {
    if (fact.evidenceDays.size !== 1) continue;
    const count = totals.get(fact.cohort)!;
    count.unknown--;
    if (fact.evidenceDays.has(fact.storedDay)) count.verified_same_day++;
    else count.verified_different_day++;
  }
  return totals;
}
