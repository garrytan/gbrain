function s(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\n/g, ' ');
}

function table(headers: string[], rows: unknown[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${row.map(s).join(' | ')} |`).join('\n');
  return [head, sep, body].filter(Boolean).join('\n');
}

export function boardMarkdown(board: { counts: Record<string, unknown>[]; items: Record<string, unknown>[] }): string {
  const countRows = board.counts.map(c => [c.project, c.workstream, c.status, c.count]);
  const itemRows = board.items.map(job => {
    const data = (job.data ?? {}) as Record<string, unknown>;
    const progress = (job.progress ?? {}) as Record<string, unknown>;
    return [job.id, data.project_id, data.workstream_id, job.status, data.title, data.owner, progress.summary, progress.next_step];
  });
  return [
    '# HQ Minions OpenClaw Board',
    '',
    '## Counts',
    '',
    table(['Project', 'Workstream', 'Status', 'Count'], countRows),
    '',
    '## Items',
    '',
    table(['ID', 'Project', 'Workstream', 'Status', 'Title', 'Owner', 'Summary', 'Next step'], itemRows)
  ].join('\n');
}

export function jobMarkdown(details: { job: Record<string, unknown>; attachments: Record<string, unknown>[] }): string {
  const data = (details.job.data ?? {}) as Record<string, unknown>;
  const progress = (details.job.progress ?? {}) as Record<string, unknown>;
  return [
    `# Work item ${details.job.id}`,
    '',
    `**Status:** ${s(details.job.status)}`,
    `**Title:** ${s(data.title)}`,
    `**Project:** ${s(data.project_id)}`,
    `**Workstream:** ${s(data.workstream_id)}`,
    `**Owner:** ${s(data.owner)}`,
    `**Summary:** ${s(progress.summary)}`,
    `**Next step:** ${s(progress.next_step)}`,
    '',
    '## Acceptance criteria',
    '',
    Array.isArray(data.acceptance_criteria) ? data.acceptance_criteria.map(x => `- ${s(x)}`).join('\n') : '',
    '',
    '## Attachments',
    '',
    details.attachments.length ? details.attachments.map(a => `- ${s(a.filename)} (${s(a.size_bytes)} bytes, sha256=${s(a.sha256)})`).join('\n') : '_No attachments._'
  ].join('\n');
}
