import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

// A fetch that stalls on a Ubicloud runner sends no bytes and never fails on its own, so the job sat until its
// timeout. With git's low-speed abort in the job environment the stalled fetch fails and actions/checkout, which
// retries a failed fetch, tries again. Every workflow that checks out on a Ubicloud runner carries it, since a
// workflow called through workflow_call does not inherit its caller's env.
type Workflow = { env?: Record<string, unknown>; jobs: Record<string, { 'runs-on'?: unknown; steps?: { uses?: string }[] }> };
const dir = join(import.meta.dir, '../../.github/workflows');
const workflows = readdirSync(dir).filter(f => f.endsWith('.yml')).sort()
  .map(file => ({ file, text: readFileSync(join(dir, file), 'utf8') }))
  .map(({ file, text }) => ({ file, text, parsed: load(text) as Workflow }));
const checksOutOnUbicloud = ({ text, parsed }: (typeof workflows)[number]) => /ubicloud-/.test(text)
  && Object.values(parsed.jobs ?? {}).some(job => (job.steps ?? []).some(step => step.uses?.startsWith('actions/checkout@')));

describe('a stalled checkout fetch fails and is retried', () => {
  const covered = workflows.filter(checksOutOnUbicloud);

  test('the scan finds the workflows that run the full suites', () => {
    expect(covered.map(w => w.file)).toEqual(expect.arrayContaining(['e2e.yml', 'persistence-validation.yml', 'test.yml']));
  });

  test.each(covered.map(w => [w.file, w] as const))('%s sets the low-speed abort for every job', (_file, w) => {
    expect(w.parsed.env).toMatchObject({ GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '120' });
  });
});
