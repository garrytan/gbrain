/**
 * A recorded MCP install must not become a missing-registration warning when
 * the owner cannot read the harness config. Hooks alone remain insufficient.
 * Existing plugin/smoke tests do not exercise the bootstrap receipt fallback.
 * Uses the real receipt reader and doctor check; no production seam is needed.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { harnessWiringCheck } from '../src/commands/doctor/checks/harness-wiring.ts';
import { receiptPath, type InstallReceipt } from '../src/core/bootstrap/format.ts';
import { gbrainPath } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

test('bootstrap MCP evidence is informational when the harness config is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gb-harness-record-'));
  try {
    await withEnv({
      HOME: join(root, 'home'), GBRAIN_HOME: join(root, 'brain'),
      CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
      XDG_CONFIG_HOME: join(root, 'xdg'),
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: undefined,
      CODEX_SANDBOX: undefined, CODEX_CI: undefined,
      OPENCODE: undefined, OPENCODE_PID: undefined,
    }, async () => {
      const path = receiptPath(gbrainPath());
      mkdirSync(dirname(path), { recursive: true });
      const receipt: InstallReceipt = {
        receipt_version: 1, workspace_dir: join(root, 'workspace'),
        source_id: 'default', agent_name: 'example-agent',
        created_at: '2026-01-01T00:00:00Z', created_by: 'test',
        brain_created_by_bootstrap: false, created_paths: [], registrations: [],
      };
      const save = () => writeFileSync(path, JSON.stringify(receipt));
      for (const detail of ['mcp', 'mcp+hooks']) {
        receipt.registrations = [{ host: 'claude-code', scope: 'project', detail }];
        save();
        for (const smoke of [false, true]) {
          const check = await harnessWiringCheck({ smoke });
          expect(check).toMatchObject({ status: 'ok', severity: 'info',
            details: { reason: 'registration_unverified', harnesses: ['claude-code'] } });
          expect(check.message).toContain('bootstrap');
          expect(check.message).toContain('not verified from this process');
          expect(check.message).not.toContain('no memory tools');
        }
      }
      for (const registrations of [
        [],
        [{ host: 'claude-code' as const, scope: 'project', detail: 'hooks' }],
        [{ host: 'codex' as const, scope: 'user', detail: 'mcp+hooks' }],
      ]) {
        receipt.registrations = registrations;
        save();
        expect((await harnessWiringCheck({ smoke: false })).status).toBe('warn');
      }
      writeFileSync(path, '{invalid');
      expect((await harnessWiringCheck({ smoke: false })).status).toBe('warn');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
