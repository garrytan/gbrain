import { describe, expect, test } from 'bun:test';
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

    expect(changelog).toContain('The live ChatGPT Developer Mode path has also');
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
    expect(status).toContain('| 06 Autopilot Daemon | Implemented |');
    expect(status).toContain('| 12 Review, Audit, And Health | Implemented |');
    expect(status).toContain('| 14 Migration And Cleanup | Implemented |');
    expect(status).toContain('The original 00-14 Postgres runtime plan is implemented');
    expect(status).toContain('bun run smoke:postgres-runtime');
    expect(status).toContain('Tier 2 skill tests require provider credentials');
  });
});
