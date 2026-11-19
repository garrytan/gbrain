/**
 * SQL that is true when page `p` (an alias over pages) holds `needle` (a SQL text expression, a marker's `:<id>>`) in a
 * field the redactor rewrites: its own columns, its raw data, timeline entries, takes, outgoing link contexts or facts
 * (repair/secret-spans.ts reads the same stores). A segmented page keeps its body in segments SQL does not read: with
 * `segmented` it counts as holding the marker (a check at one named slug, as secret-store/restore.ts does), and
 * without it never does (a search across a source must not match every segmented page).
 */
export function pageHoldsSql(p: string, needle: string, segmented = false): string {
  const has = (text: string) => `strpos(${text}, ${needle}) > 0`;
  return `(${has(`${p}.title || ' ' || coalesce(${p}.compiled_truth, '') || ' ' || coalesce(${p}.timeline, '') || ' ' || ${p}.frontmatter::text`)}
    OR EXISTS (SELECT 1 FROM raw_data hr WHERE hr.page_id = ${p}.id AND ${has('hr.data::text')})
    OR EXISTS (SELECT 1 FROM timeline_entries ht WHERE (ht.page_id = ${p}.id OR ht.event_page_id = ${p}.id) AND ${has("ht.summary || ' ' || ht.detail || ' ' || ht.source")})
    OR EXISTS (SELECT 1 FROM takes hk WHERE hk.page_id = ${p}.id AND ${has("coalesce(hk.claim, '') || ' ' || coalesce(hk.source, '') || ' ' || coalesce(hk.resolved_source, '')")})
    OR EXISTS (SELECT 1 FROM links hl WHERE hl.from_page_id = ${p}.id AND ${has('hl.context')})
    OR EXISTS (SELECT 1 FROM facts hf WHERE hf.source_id = ${p}.source_id AND (hf.source_markdown_slug = ${p}.slug OR (hf.source_markdown_slug IS NULL AND hf.entity_slug = ${p}.slug))
      AND ${has("coalesce(hf.fact, '') || ' ' || coalesce(hf.context, '') || ' ' || coalesce(hf.value::text, '')")})${segmented ? `
    OR ${p}.body_storage = 'segmented'` : ''})`;
}
