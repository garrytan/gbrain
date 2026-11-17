import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSharedSkillsAdapter } from '../src/core/shared-skills/adapter.ts';
import { joinBrain } from '../src/core/shared-skills/membership.ts';
import { prepareNativeRouter } from '../src/core/harness/native-router.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { caught, envelopeFor, expectFunnelSuggestions } from './helpers/agent-envelope.ts';

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'gbrain-shared-refusals-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const unreachable = async () => { throw new Error('no server call expected'); };

describe('shared-skills refusals name their own next step', () => {
  test('every fail() and conflict() call site carries a site-specific suggestion', () => {
    expectFunnelSuggestions('src/core/shared-skills/adapter.ts', 'fail', 24);
    expectFunnelSuggestions('src/core/shared-skills/membership.ts', 'fail', 20);
    expectFunnelSuggestions('src/core/harness/native-router.ts', 'conflict', 8);
  });

  test('joining without follow approval asks the user before the join call, on MCP and the CLI', async () => {
    const ctx = { remote: true, transport: 'stdio' } as OperationContext;
    const error = await caught(() => joinBrain(ctx, { adapter: 'codex', follow_policy: { approved: false } as never }));
    const mcp = envelopeFor(error, 'stdio', ['join_brain']);
    expect(mcp).toMatchObject({ code: 'follow_approval_required', docs: expect.stringContaining('approve-publication-following-and-editing-separately'),
      fix: { mcp: { tool: 'join_brain', arguments: { adapter: 'codex', follow_policy: { approved: true } } }, consent: ['persistent_install'], next: 'ask_user' } });
    expect(envelopeFor(error).fix).toMatchObject({ argv: ['gbrain', 'join-brain', '--adapter', 'codex', '--follow-policy', '{"approved":true}', '--json'], next: 'ask_user' });
  });

  test('a refresh with no enrollment receipt names the state directory and the approval it needs', async () => {
    const root = temp();
    const error = await caught(() => createSharedSkillsAdapter({ call: unreachable, root, adapter: 'codex' }).refresh());
    const env = envelopeFor(error);
    expect(env).toMatchObject({ code: 'membership_inactive', docs: expect.stringContaining('docs/guides/shared-brain-skills.md#troubleshoot-leave-and-recover') });
    expect(env.suggestion).toContain(root);
  });

  test('joining into a directory foresights did not create names the directory and never adopts it', async () => {
    const root = temp();
    writeFileSync(join(root, 'notes.md'), 'user file');
    const env = envelopeFor(await caught(() => createSharedSkillsAdapter({ call: unreachable, root, adapter: 'codex' }).join({ approved: true })));
    expect(env.code).toBe('local_conflict');
    expect(env.suggestion).toContain(`${root} already holds files foresights did not create`);
  });

  test('an unexpected native router body is reported with the version', async () => {
    const root = temp();
    const env = envelopeFor(await caught(() => prepareNativeRouter({ brain_id: randomUUID(), installation_id: randomUUID(), adapter: 'codex',
      state_root: join(root, 'state'), skills_dir: join(root, 'skills'), connection_name: 'gbrain', content: '# not a router' })));
    expect(env).toMatchObject({ code: 'local_conflict', docs: expect.stringContaining('docs/guides/shared-brain-skills.md#troubleshoot-leave-and-recover') });
    expect(env.suggestion).toContain('foresights --version');
  });
});
