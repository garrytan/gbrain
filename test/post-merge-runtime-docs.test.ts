import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('post-merge runtime documentation', () => {
  test('records live ChatGPT validation as complete instead of pending', () => {
    const chatgpt = read('docs/mcp/CHATGPT.md');
    const todos = read('TODOS.md');
    const changelog = read('CHANGELOG.md');
    const readme = read('README.md');
    const verify = read('docs/MBRAIN_VERIFY.md');
    const deploy = read('docs/mcp/DEPLOY.md');

    expect(chatgpt).toContain('live ChatGPT Developer Mode validation completed');
    expect(chatgpt).toContain('The guide was validated with ChatGPT Developer Mode on 2026-05-31');
    expect(chatgpt).not.toContain('live ChatGPT validation still pending');
    expect(chatgpt).not.toContain('Live ChatGPT Developer Mode validation is still required');

    expect(todos).toContain('### ChatGPT MCP live validation and OAuth hardening');
    expect(todos).toContain('**Completed:** Unreleased');
    expect(todos).not.toContain('remaining P0 gap');
    expect(todos).not.toContain('Live ChatGPT validation is still needed');

    // The CHANGELOG must frame the live ChatGPT pass as a one-time manual check,
    // not as a reproducible end-to-end gate (the reproducible evidence is the
    // descriptor tests + simulated smoke:http-oauth flow).
    expect(changelog).toContain('confirmed manually once against a public HTTPS tunnel');
    expect(changelog).not.toContain('validated end-to-end against a public HTTPS tunnel');
    expect(changelog).toContain('ChatGPT can now see MBrain app actions after OAuth connects');
    expect(changelog).not.toContain('before the final live ChatGPT Developer Mode pass');

    expect(readme).toContain('To verify the OAuth runtime locally, or to reproduce a ChatGPT-style setup');
    expect(readme).toContain('HTTP MCP clients receive full tool descriptors');
    expect(readme).toContain('`resources/list` returns an explicit empty list');
    expect(verify).toContain('The ChatGPT Developer Mode guide was live-validated on 2026-05-31');
    expect(verify).toContain('full HTTP `tools/list` descriptors/action discovery');
    expect(deploy).toContain('For HTTP MCP clients such as ChatGPT Developer Mode');
    expect(deploy).toContain('`resources/list` returns an explicit empty list');
  });

  test('links the implementation index to the current phase status snapshot', () => {
    const index = read('docs/superpowers/specs/2026-05-20-mbrain-implementation-index.md');
    const status = read('docs/superpowers/specs/2026-05-31-mbrain-postgres-runtime-status.md');

    expect(index).toContain('2026-05-31-mbrain-postgres-runtime-status.md');
    // Honest phase labels: 00/04/06 are partial (CLI/doctor gaps, matrix-authority
    // not wired, no real OS scheduler/daemon); 12/14 remain implemented.
    expect(status).toContain('| 00 Postgres Foundation | Partial |');
    expect(status).toContain('| 04 Governed Canonical Write | Partial |');
    expect(status).toContain('| 06 Autopilot Daemon | Partial |');
    expect(status).toContain('fresh Postgres double-init, and schema idempotency coverage are implemented');
    expect(status).toContain('backup-artifact/restorable-backup coverage are not yet present');
    expect(status).not.toContain('fresh-init / idempotent-migration / backup-artifact tests are not yet present');
    expect(status).toContain('code claims still route to `verify_first`');
    expect(status).toContain('otherwise eligible non-`user_direct` claims fall back conservatively to `candidate`');
    expect(status).not.toContain('every other source kind fails conservative to `candidate`');
    expect(status).toContain('| 12 Review, Audit, And Health | Implemented |');
    expect(status).toContain('| 14 Migration And Cleanup | Implemented |');
    expect(status).toContain('The original 00-14 Postgres runtime plan is substantially implemented');
    expect(status).toContain('bun run smoke:postgres-runtime');
    expect(status).toContain('Tier 2 skill tests require provider credentials');
  });

  test('keeps gitignored superpowers runtime docs git-tracked', () => {
    // docs/superpowers/ is in .gitignore (see .gitignore); these runtime docs are
    // force-tracked. Guard that they stay tracked so a re-add respecting .gitignore
    // cannot silently drop the status snapshot + phase specs without CI noticing.
    const tracked = execFileSync('git', [
      'ls-files',
      'docs/superpowers/specs/2026-05-31-mbrain-postgres-runtime-status.md',
      'docs/superpowers/specs/2026-05-20-mbrain-implementation-index.md',
      'docs/superpowers/specs/2026-05-20-mbrain-phase-14-migration-cleanup.md',
    ], { encoding: 'utf8' });

    expect(tracked).toContain('2026-05-31-mbrain-postgres-runtime-status.md');
    expect(tracked).toContain('2026-05-20-mbrain-implementation-index.md');
    expect(tracked).toContain('2026-05-20-mbrain-phase-14-migration-cleanup.md');
  });
});
