/**
 * A call sent to the Rust brain's owner whose answer never came back (cancel, deadline, owner gone) may still commit,
 * so its error names the read that confirms the write instead of advising a rerun (owner-ipc/confirming-reads.ts and
 * routes.ts confirmingReadAdvice). These tests pin that every forwarded write has such a read, that each read named
 * is a member that only reads, and the three errors' answers before and after the send.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { OWNER_IPC_CONFIRMING_READS } from '../src/core/rust-engine/owner-ipc/confirming-reads.ts';
import {
  OWNER_IPC_ROUTES, confirmingReadAdvice, ownerBusy, ownerCallCancelled, ownerCallTimeout, ownerGone, ownerIpcProtocol,
  ownerMemberOnlyReads, ownerPeerRefused,
} from '../src/core/rust-engine/owner-ipc/routes.ts';
import { cliRenderContext, toAgentError } from '../src/core/agent-output.ts';
import { CODES } from '../src/core/error-registry.ts';

const forwarded = Object.entries(OWNER_IPC_ROUTES).filter(([, route]) => route === 'forward').map(([member]) => member);
const writes = forwarded.filter(member => !ownerMemberOnlyReads(member));

describe('the confirming read for each forwarded write', () => {
  // Value: protects=a new write routed over the owner socket gets a named confirming read; fails_when=a forwarded
  // write has no entry, or a read or unknown member has one; why_new=the table is new; seam=none; no_claim=the read
  // finds every row the write changed
  test('every forwarded write has an entry, and no read or unknown member has one', () => {
    expect(writes.filter(member => !(member in OWNER_IPC_CONFIRMING_READS))).toEqual([]);
    expect(Object.keys(OWNER_IPC_CONFIRMING_READS).filter(member => !writes.includes(member))).toEqual([]);
  });

  // Value: protects=a member that looks like a read but writes is not resent as a read after an owner exit; fails_when=readJobInbox
  // (marks inbox messages read), selectFactsReconcileDrain (settles due pages) or listOriginClaims (advisory locks) is listed as a
  // read; why_new=the typed members were first classified by name; seam=none; no_claim=every other typed member (checked by reading
  // each implementation, see the merge report)
  test('members that write while they read are writes with a confirming read', () => {
    for (const member of ['readJobInbox', 'selectFactsReconcileDrain', 'listOriginClaims']) {
      expect(ownerMemberOnlyReads(member)).toBe(false);
      expect(member in OWNER_IPC_CONFIRMING_READS).toBe(true);
    }
    expect(ownerGone('readJobInbox', 42, true)).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown', retryable: false });
    expect(confirmingReadAdvice('readJobInbox')).toContain('readChildCompletions');
    expect(confirmingReadAdvice('selectFactsReconcileDrain')).toContain('listFactsReconcileBacklog');
  });

  test('each member an entry names exists and only reads', () => {
    const named = Object.values(OWNER_IPC_CONFIRMING_READS).flatMap(read => read.match(/\b[a-z]+[A-Z]\w*\b/g) ?? []);
    expect(named.length).toBeGreaterThan(50);
    expect(named.filter(member => !(member in RUST_ENGINE_MEMBERS) || !ownerMemberOnlyReads(member))).toEqual([]);
  });

  test('insertFact names the facts read for that entity; a read says a rerun is safe', () => {
    expect(confirmingReadAdvice('insertFact')).toBe(
      'Before you rerun insertFact, run listFactsByEntity for that entity to see whether it committed; rerun it only if it did not.'
      + ' The owner answers that read only after the earlier insertFact call has ended, so what it finds is final.');
    expect(confirmingReadAdvice('getPage')).toBe('Before you rerun getPage: it only reads, so nothing was written and running it again is safe.');
    expect(confirmingReadAdvice('lockPageKeys')).toContain('there is nothing: the lock is released');
  });
});

describe('a sent call whose answer never came back', () => {
  // Value: protects=a sent write's timeout or owner exit is not reported as safe to retry; fails_when=the sent timeout
  // keeps code timeout or retryable true, or owner-gone keeps retryable true for a write; why_new=finding 4 covered only
  // the cancel; seam=none; no_claim=how long the owner takes to finish the call
  test('cancel, deadline and owner exit after the send: unknown, retryable only for a read, with the confirming read', () => {
    for (const error of [ownerCallCancelled('insertFact', true), ownerCallTimeout('insertFact', 300, 'sent'), ownerGone('insertFact', 42, true)]) {
      expect(error).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown', retryable: false });
      expect(error.suggestion).toContain('run listFactsByEntity for that entity to see whether it committed');
      expect(error.suggestion).not.toContain('Retry the same call');
    }
    for (const error of [ownerCallCancelled('getPage', true), ownerCallTimeout('getPage', 300, 'sent'), ownerGone('getPage', 42, true)]) {
      expect(error).toMatchObject({ code: 'owner_unavailable', reason: 'outcome_unknown', retryable: true });
    }
  });

  test('before the send nothing ran, so the answers stay as they were', () => {
    expect(ownerCallCancelled('insertFact', false)).toMatchObject({ code: 'cancelled' });
    expect(ownerCallTimeout('insertFact', 300, 'not_sent')).toMatchObject({ code: 'timeout', reason: 'not_sent', retryable: true });
    expect(ownerCallTimeout('insertFact', 300, 'queued')).toMatchObject({ code: 'timeout', reason: 'not_started', retryable: true });
    expect(ownerGone('insertFact', 42, false)).toMatchObject({ code: 'owner_unavailable', reason: 'not_sent', retryable: true });
  });
});

describe('the decide queue writes, whose confirming reads list only due rows', () => {
  // Value: protects=the advice for the two decide queue writes says what a due-only read can and cannot prove;
  // fails_when=the note is dropped, or the sweep note stops saying that a defer of a fact with no row is never
  // listed; why_new=the decide store members are new on the owner socket; seam=none; no_claim=the read finds rows
  // that are not yet due
  test('applyDecideReviewQueue and applyDecideSweepDeferred name the due-only rule', () => {
    const review = confirmingReadAdvice('applyDecideReviewQueue');
    expect(review).toContain('run listDueDecideReviewQueue for that kind and source');
    expect(review).toContain('That read lists only due rows: a defer or clear that committed takes the row out of it, so a row still listed means the call did not commit');
    const sweep = confirmingReadAdvice('applyDecideSweepDeferred');
    expect(sweep).toContain('run listDueDecideSweepDeferred for that source');
    expect(sweep).toContain('A defer of a fact that had no row is never listed, so the read cannot tell');
    expect(sweep).toContain('only adds one attempt and pushes the next try back');
    expect(confirmingReadAdvice('insertFact')).not.toContain('due rows');
  });
});

describe('the owner errors render a read-only fix and redact host details over HTTP', () => {
  // Value: protects=owner_busy, owner_ipc_peer_refused and owner_ipc_protocol carry a default fix an agent can run,
  // and the HTTP view never shows the socket path or the owner pid; fails_when=the registry row has no fix, the fix
  // is not read-only, or an HTTP envelope keeps a path or pid; why_new=the plan's two partial items; seam=none;
  // no_claim=what doctor prints
  test('each error renders gbrain doctor --json as its fix, appended to the suggestion', () => {
    const errors = [
      ownerBusy('queue_full', 'getPage', 8), ownerPeerRefused('peer_uid', 'peer_uid=1001 owner_uid=1000'),
      ownerIpcProtocol('version_mismatch', null, 'client_version=2 owner_version=1'),
    ];
    for (const error of errors) {
      expect(error.fix?.argv).toEqual(['gbrain', 'doctor', '--json']);
      expect(error.fix?.consent).toEqual([]);
      expect(String(error.fix?.why)).toStartWith('Read-only:');
      const env = toAgentError(error, { transport: 'cli', command: 'gbrain query', render: cliRenderContext() });
      expect(env.fix?.command).toBe('gbrain doctor --json');
      expect(env.suggestion).toContain('Next: gbrain doctor --json');
    }
    for (const code of ['owner_busy', 'owner_ipc_peer_refused', 'owner_ipc_protocol'] as const) {
      expect(CODES[code].fix.argv).toEqual(['gbrain', 'doctor', '--json']);
    }
  });

  test('over HTTP the socket path and the owner pid are redacted', () => {
    const socket = '/home/user-example/.gbrain/brain/.gbrain-owner.sock';
    const errors = [
      ownerPeerRefused('socket_owner', `socket=${socket} socket_uid=1001`),
      ownerGone('insertFact', 4242, true),
    ];
    for (const error of errors) {
      const env = toAgentError(error, { transport: 'http', op: 'put_page', render: cliRenderContext() });
      const text = JSON.stringify(env);
      expect(text).not.toContain('/home/user-example');
      expect(text).not.toContain('4242');
    }
    // The CLI view keeps them: the local user can act on them.
    expect(JSON.stringify(toAgentError(errors[0]!, { transport: 'cli', render: cliRenderContext() }))).toContain('/home/user-example');
  });
});

describe('the docs list the members the owner socket refuses', () => {
  const refused = Object.entries(OWNER_IPC_ROUTES).filter(([, route]) => route === 'refuse').map(([member]) => member).sort();
  const named = (text: string) => [...new Set([...text.matchAll(/`(\w+)`/g)].map(m => m[1]!).filter(name => name in OWNER_IPC_ROUTES))].sort();
  const doc = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');

  // Value: protects=the two design docs name every member routes.ts refuses; fails_when=a member is added to the REFUSE set and
  // either doc still lists the old members (the owner socket's refusals are read from these two paragraphs); why_new=worktreeClaimStore
  // and writerAdminStore joined the set after the docs were written; seam=none; no_claim=the rest of either paragraph
  test('RUST_ENGINE.md and the key-files entry name exactly the refused members', () => {
    expect(refused).toContain('worktreeClaimStore');
    expect(refused).toContain('writerAdminStore');
    const design = doc('docs/designs/RUST_ENGINE.md');
    const sentence = design.slice(design.indexOf('So `transaction`, `transactionDirect`'), design.indexOf('`owner-ipc/whole-op.ts` can send the four'));
    expect(sentence.length).toBeGreaterThan(200);
    expect(named(sentence)).toEqual(refused);
    const keyFiles = doc('docs/architecture/key-files/engines-2-more.md');
    const list = keyFiles.slice(keyFiles.indexOf('`refuse` (`transaction`'), keyFiles.indexOf('or `forward` (everything else'));
    expect(list.length).toBeGreaterThan(200);
    expect(named(list)).toEqual(refused);
  });
});
