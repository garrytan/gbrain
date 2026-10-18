export function boundedBodyPrefixSql(alias: string): string {
  return `left(coalesce(${alias}.compiled_truth, ${alias}.truth_lead), 65536)`;
}

export function readBody(page: { compiled_truth: string }): string {
  return page.compiled_truth;
}

export const leadSql = `SELECT ${boundedBodyPrefixSql('p')} AS lead, p.chunk_source = 'timeline' AS t FROM pages p WHERE p.id = $1`;

export function unlisted(page: { timeline: string }): string {
  return page.timeline;
}
