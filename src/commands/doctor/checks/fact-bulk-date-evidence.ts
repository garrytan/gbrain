import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import type { BrainEngine } from '../../../core/engine.ts';
import type { BulkFactDay } from '../../../core/facts/bulk-days.ts';
import { stripCodeBlocks } from '../../../core/markdown-code.ts';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ORIGINAL_BYTES = 256 * 1024;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
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

type Original = { source_id: string; original_page_id: string | number; original_revision: string };
const originalKey = (row: Original) => JSON.stringify([row.source_id, String(row.original_page_id), row.original_revision]);
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

async function readOriginals(engine: BrainEngine, originals: Original[]) {
  const rows = await engine.executeRaw<Original & { body: string }>(`
    WITH requested AS (
      SELECT DISTINCT * FROM jsonb_to_recordset($1::text::jsonb)
        AS r(source_id text, original_page_id bigint, original_revision uuid)
    ), matched AS (
      SELECT a.*, orig.body
       FROM requested a JOIN pages p ON p.source_id=a.source_id AND p.id=a.original_page_id AND p.deleted_at IS NULL
       CROSS JOIN LATERAL (
         SELECT CASE WHEN count(*)=1 THEN min(b.body) END AS body FROM (
           SELECT p.compiled_truth AS body WHERE p.knowledge_revision=a.original_revision AND p.body_storage='inline'
           UNION ALL
           SELECT v.compiled_truth FROM page_versions v WHERE v.page_id=p.id AND v.knowledge_revision=a.original_revision
             AND v.is_deleted IS NOT TRUE AND v.body_storage='inline' AND p.knowledge_revision IS DISTINCT FROM a.original_revision
         ) b
       ) orig
       WHERE octet_length(orig.body)<=$2::integer
    ), bounded AS (
      SELECT *,sum(octet_length(body)) OVER (ORDER BY source_id,original_page_id,original_revision) AS covered_bytes FROM matched
    )
    SELECT source_id,original_page_id,original_revision::text,body FROM bounded WHERE covered_bytes<=$3::integer
  `, [JSON.stringify(originals), MAX_ORIGINAL_BYTES, MAX_ARCHIVE_BYTES]);
  return new Map(rows.map(row => [originalKey(row), prepareOriginal(row.body)]));
}

/** Verify operator-reviewed evidence against the live fact and its exact original revision. */
export async function factDateEvidence(engine: BrainEngine, days: BulkFactDay[], path: string) {
  const input = loadManifest(path);
  const totals = new Map<string, Counts>(days.map(day => [dateEvidenceKey(day.source_id, day.day),
    { verified_same_day: 0, verified_different_day: 0, unknown: day.facts }]));
  if (!days.length || !input.facts.length) return totals;
  const rows = await engine.executeRaw<{ ord: number; day: string; claim: string }>(`
    WITH cohort AS (
      SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS d(source_id text, day date)
    )
    SELECT j.ord::int, to_char(d.day,'YYYY-MM-DD') AS day, f.fact AS claim
    FROM jsonb_array_elements($2::text::jsonb) WITH ORDINALITY j(input,ord)
    CROSS JOIN LATERAL jsonb_to_record(j.input) AS a(source_id text, fact_id bigint, entity_slug text, valid_from timestamptz)
    JOIN facts f ON f.source_id=a.source_id AND f.id=a.fact_id AND f.valid_from=a.valid_from AND f.expired_at IS NULL
      AND f.entity_slug IS NOT DISTINCT FROM a.entity_slug
    JOIN cohort d ON d.source_id=f.source_id AND d.day=(f.valid_from AT TIME ZONE 'UTC')::date
  `, [JSON.stringify(days.map(({ source_id, day }) => ({ source_id, day }))), JSON.stringify(input.facts)]);
  const bound = rows.flatMap(row => {
    const entry = input.facts[row.ord - 1];
    return entry && digest(row.claim) === entry.claim_sha256 ? [{ entry, storedDay: row.day }] : [];
  });
  if (!bound.length) return totals;
  const originals = await readOriginals(engine, bound.map(({ entry }) => ({
    source_id: entry.source_id, original_page_id: entry.original_page_id, original_revision: entry.original_revision,
  })));
  const facts = new Map<string, { cohort: string; storedDay: string; evidenceDays: Set<string> }>();
  for (const { entry, storedDay } of bound) {
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
