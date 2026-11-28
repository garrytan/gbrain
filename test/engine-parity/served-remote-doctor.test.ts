/**
 * BrainEngine parity: a remote run_doctor (rust-engine/served/remote-whole-ops.ts REMOTE_WHOLE_OPERATIONS), called over
 * MCP stdio (dispatchToolCall with remote: true) in its three report forms: the focused report, the ops tier and the
 * page-class checks.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded or served) each form completes, no
 *    check says it could not run for the remote caller, and no report carries any text of a page the remote caller may
 *    not read: an owner-private page and a page only a named member may read, seeded with their own markers.
 *  - Regression: on the served arm (GBRAIN_TEST_RUST_SERVED=1, multi-user), the served client ran doctor itself and
 *    refused every local-only read before sending it, so many checks said "Unknown: this check could not run for the
 *    remote caller". run_doctor now crosses as one whole operation the brain server runs on the owner's floor.
 *  - Why existing coverage misses it: test/rust-served-remote-doctor.serial.test.ts ran one served brain; no parity file
 *    ran a remote run_doctor on both multi-user routes (test/rust-served-remote-whole-ops.test.ts requires one).
 *  - Seam: none. Pages are seeded with putPage; each form runs through dispatchToolCall.
 *  - The case name says where doctor runs: on the brain server for a served client, in process otherwise. In process on
 *    the Rust arm, doctor catches the raw-SQL refusals of four doctor files on its way; those are pinned by name in
 *    test/rust-stop-pins/l3-served-doctor.tsv. A served client sends no member, so it catches nothing and has no pin.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { PAGE_CHECK_NAMES } from '../../src/core/doctor-categories.ts';
import { rustServedRequested } from './rust-arm.ts';

const { parityTest } = parityArms(testBackends());

const STDIO = { remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default' } as const;
const COULD_NOT_RUN = 'Unknown: this check could not run for the remote caller';
const PRIVATE = 'doctormarkprivatepage4e1b';
const READERS = 'doctormarkreaderspage9c07';
const FORMS: Array<Record<string, unknown>> = [{}, { tier: 'ops' }, { only: [...PAGE_CHECK_NAMES] }];

type Check = { name?: unknown; message?: unknown };

/** Every check of a report text, in any of the three forms' shapes (the report, or a wrapper with a `checks` list). */
function checksOf(text: string): Check[] {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return []; }
  const checks = (body as { checks?: unknown } | null)?.checks;
  return Array.isArray(checks) ? checks as Check[] : [];
}

const WHERE = rustServedRequested() ? 'on the brain server' : 'in process';

parityTest(`a remote run_doctor (${WHERE}) completes in each form, runs every check, and shows no page the caller may not read`, { methods: ['putPage'], timeout: 240_000 }, async (engine: BrainEngine) => {
  await engine.putPage('notes/open-doctor', { type: 'note' as never, title: 'Open', compiled_truth: 'An open note.', timeline: '', frontmatter: {} });
  await engine.putPage(`notes/${PRIVATE}`, { type: 'note' as never, title: PRIVATE, compiled_truth: `${PRIVATE} body.`, timeline: '', frontmatter: { visibility: 'private' } });
  await engine.putPage(`notes/${READERS}`, { type: 'note' as never, title: READERS, compiled_truth: `${READERS} body.`, timeline: '', frontmatter: { readable_by: ['alice-example'] } });
  const forms = [];
  for (const params of FORMS) {
    const out = await dispatchToolCall(engine, 'run_doctor', params, STDIO as never);
    const text = out.content.map(c => c.text ?? '').join('\n');
    const checks = checksOf(out.content[0]?.text ?? '');
    forms.push({
      form: Object.keys(params).join(',') || 'focused',
      error: out.isError === true,
      hasChecks: checks.length > 0,
      couldNotRun: checks.filter(c => typeof c.message === 'string' && c.message.startsWith(COULD_NOT_RUN)).map(c => String(c.name)).sort(),
      leaked: [PRIVATE, READERS].filter(marker => text.includes(marker)),
    });
  }
  expect(forms).toEqual(FORMS.map(params => ({ form: Object.keys(params).join(',') || 'focused', error: false, hasChecks: true, couldNotRun: [], leaked: [] })));
  return forms;
});
