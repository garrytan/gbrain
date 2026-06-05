import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = 'scripts/install-qwen3-llamacpp-embedding-daemon.sh';

function runScript(args: string[]) {
  return Bun.spawnSync({
    cmd: ['bash', SCRIPT, ...args],
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('qwen3 embedding daemon installer script', () => {
  test('renders a systemd user service profile', () => {
    const result = runScript(['--print', 'systemd']);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('[Unit]');
    expect(stdout).toContain('Description=MBrain Qwen3 embedding server');
    expect(stdout).toContain('ExecStart=/bin/bash');
    expect(stdout).toContain('scripts/run-qwen3-llamacpp-embedding-cpu.sh');
    expect(stdout).toContain('Restart=always');
    expect(stdout).toContain('Environment="MBRAIN_LOCAL_EMBEDDING_MODEL=qwen3-embedding:0.6b"');
  });

  test('quotes systemd paths that contain spaces', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-daemon-script-'));
    const linkRoot = join(tempDir, 'repo with spaces');
    symlinkSync(process.cwd(), linkRoot, 'dir');

    try {
      const result = Bun.spawnSync({
        cmd: ['bash', join(linkRoot, SCRIPT), '--print', 'systemd'],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = result.stdout.toString();

      expect(result.exitCode).toBe(0);
      expect(stdout).toContain(`WorkingDirectory="${linkRoot}"`);
      expect(stdout).toContain(
        `ExecStart=/bin/bash "${join(linkRoot, 'scripts/run-qwen3-llamacpp-embedding-cpu.sh')}"`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('renders a launchd LaunchAgent profile', () => {
    const result = runScript(['--print', 'launchd']);
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('<key>Label</key>');
    expect(stdout).toContain('<string>com.mbrain.qwen3-embedding</string>');
    expect(stdout).toContain('<key>ProgramArguments</key>');
    expect(stdout).toContain('scripts/run-qwen3-llamacpp-embedding-cpu.sh');
    expect(stdout).toContain('<key>RunAtLoad</key>');
    expect(stdout).toContain('<key>KeepAlive</key>');
    expect(stdout).toContain('<key>MBRAIN_LOCAL_EMBEDDING_MODEL</key>');
  });
});
