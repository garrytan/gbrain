import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import type { BrainEngine } from '../../../core/engine.ts';
import type { BulkFactDay } from '../../../core/facts/bulk-days.ts';

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
    line: positiveInt,
    line_sha256: shaHex,
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

function hasDateAsProse(line: string, eventDay: string): boolean {
  if (/^\s*(?:\x60{3,}|~~~|<!--|\||\[[^\]]+\]:)/.test(line)) return false;
  const prose = line
    .replace(/\[\[[^\]\n]*\]\]|\]\([^()\n]*\)|\x60[^\x60\n]*\x60|(?:[a-z]+:\/\/|www\.)\S+/gi, '')
    .replace(/\d{4}-\d{2}-\d{2}(?=[ \t]*[「『《“])/g, '');
  const dates = new Set(prose.match(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g));
  return dates.size === 1 && dates.has(eventDay) && /\p{L}/u.test(prose);
}

/** Verify operator-reviewed evidence against the live fact and its exact original revision. */
export async function factDateEvidence(engine: BrainEngine, days: BulkFactDay[], path: string) {
  const input = loadManifest(path);
  const totals = new Map<string, Counts>(days.map(day => [dateEvidenceKey(day.source_id, day.day),
    { verified_same_day: 0, verified_different_day: 0, unknown: day.facts }]));
  if (!days.length || !input.facts.length) return totals;
  const rows = await engine.executeRaw<{
    source_id: string; fact_id: string; day: string; event_day: string;
    claim: string; claim_sha256: string; line_text: string | null; line_sha256: string;
  }>(`
    WITH cohort AS (
      SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS d(source_id text, day date)
    )
    SELECT f.source_id, f.id::text AS fact_id, to_char(d.day, 'YYYY-MM-DD') AS day, a.event_day,
      f.fact AS claim, a.claim_sha256, a.line_sha256, orig.line_text
    FROM jsonb_to_recordset($2::text::jsonb) AS a(source_id text, fact_id bigint, entity_slug text, valid_from timestamptz,
      claim_sha256 text, original_page_id bigint, original_revision uuid, line integer, line_sha256 text, event_day text)
    JOIN facts f ON f.source_id=a.source_id AND f.id=a.fact_id AND f.valid_from=a.valid_from AND f.expired_at IS NULL
      AND f.entity_slug IS NOT DISTINCT FROM a.entity_slug
    JOIN cohort d ON d.source_id=f.source_id AND d.day=(f.valid_from AT TIME ZONE 'UTC')::date
    JOIN pages p ON p.source_id=f.source_id AND p.id=a.original_page_id AND p.deleted_at IS NULL
    CROSS JOIN LATERAL (
      SELECT CASE WHEN count(*)=1 THEN min(split_part(b.body, E'\\n', a.line)) END AS line_text
      FROM (
        SELECT p.compiled_truth AS body WHERE p.knowledge_revision=a.original_revision AND p.body_storage='inline'
        UNION ALL
        SELECT v.compiled_truth FROM page_versions v WHERE v.page_id=p.id AND v.knowledge_revision=a.original_revision
          AND v.is_deleted IS NOT TRUE AND v.body_storage='inline' AND p.knowledge_revision IS DISTINCT FROM a.original_revision
      ) b
    ) orig
  `, [JSON.stringify(days.map(({ source_id, day }) => ({ source_id, day }))), JSON.stringify(input.facts)]);
  const facts = new Map<string, { cohort: string; storedDay: string; evidenceDays: Set<string> }>();
  for (const row of rows) {
    if (!row.line_text || digest(row.claim) !== row.claim_sha256 || digest(row.line_text) !== row.line_sha256 ||
        !hasDateAsProse(row.line_text, row.event_day)) continue;
    const id = JSON.stringify([row.source_id, row.fact_id]);
    const fact = facts.get(id) ?? { cohort: dateEvidenceKey(row.source_id, row.day), storedDay: row.day, evidenceDays: new Set<string>() };
    fact.evidenceDays.add(row.event_day);
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
