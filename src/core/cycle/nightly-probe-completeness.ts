/** Completeness is an identity census, not a passing aggregate over whatever rows survived. */
export interface ProbeCompleteness { complete: boolean; retryable: boolean }
export interface ProbeInputResult { questionIds: string[]; completeness: ProbeCompleteness }

/** Empty, duplicate or unexpected ids cannot certify coverage. Never include model text in diagnostics. */
export function probeCompleteness(expected: readonly string[], rows: unknown[], stage: 'reader' | 'judge'): ProbeCompleteness {
  const seen = new Set<string>();
  let complete = expected.length > 0 && new Set(expected).size === expected.length;
  let retryable = true;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { complete = false; continue; }
    const row = raw as Record<string, unknown>;
    const id = row.question_id;
    if (typeof id !== 'string' || !expected.includes(id) || seen.has(id)) complete = false;
    if (typeof id === 'string') seen.add(id);
    const aggregate = row.final_aggregate && typeof row.final_aggregate === 'object' ? row.final_aggregate as Record<string, unknown> : {};
    const slotErrors = Array.isArray(aggregate.errors) ? aggregate.errors : [];
    const errors = [row.error, ...slotErrors.map(e => e && typeof e === 'object' ? (e as Record<string, unknown>).error : e)]
      .filter(e => e !== undefined && e !== null && e !== '');
    if (errors.length) {
      complete = false;
      // Only a known output-format/transient failure is repairable. Unknown errors,
      // authentication, permissions and budget refusals are terminal for this run.
      retryable &&= errors.every(e => typeof e === 'string'
        && !/auth|permission|forbidden|unauthori[sz]ed|\b40[123]\b|budget|quota|credit|no.pricing|rate.limit|\b429\b/i.test(e)
        && /truncat|max_tokens|stopReason=length|no JSON|malformed|unparseable|\b50[234]\b|timed? ?out/i.test(e));
    }
    if (stage === 'reader') {
      if (typeof row.hypothesis !== 'string' || !row.hypothesis.trim() || typeof row.question !== 'string') complete = false;
    } else if (row.verdict !== 'pass' && row.verdict !== 'fail') complete = false;
  }
  if (seen.size !== expected.length || expected.some(id => !seen.has(id))) complete = false;
  return { complete, retryable: !complete && retryable };
}
