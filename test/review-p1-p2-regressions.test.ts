import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('P1/P2 review regression guards', () => {
  const serveSource = readFileSync(resolve(process.cwd(), 'src/commands/serve-http.ts'), 'utf8');
  const jobsSource = readFileSync(resolve(process.cwd(), 'src/commands/jobs.ts'), 'utf8');
  const supervisorSource = readFileSync(resolve(process.cwd(), 'src/core/minions/supervisor.ts'), 'utf8');
  const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');

  test('OAuth token requests pass through the client-credentials limiter once', () => {
    const tokenRoutes = serveSource.match(/app\.post\('\/token',[\s\S]*?\n  \}\);/g) ?? [];
    expect(tokenRoutes).toHaveLength(2);
    expect(tokenRoutes.filter(route => route.includes('ccRateLimiter'))).toHaveLength(1);
  });

  test('Admin worker controls invoke the canonical jobs supervisor', () => {
    expect(serveSource).toContain("'jobs', 'supervisor', 'start', '--detach', '--json'");
    expect(serveSource).toContain("'jobs', 'supervisor', 'stop', '--json'");
    expect(serveSource).not.toContain("'jobs', 'work', '--concurrency', '2'");
    expect(serveSource).not.toContain("admin-worker.pid");
  });

  test('Supervisor PID records carry identity metadata and stop fails closed', () => {
    expect(supervisorSource).toContain('started_at: new Date().toISOString()');
    expect(supervisorSource).toContain('instance_id: this.instanceId');
    expect(supervisorSource).toContain('executable: process.execPath');
    expect(supervisorSource).toContain("void this.shutdown('control_file', ExitCodes.CLEAN)");
    expect(jobsSource).toContain('if (!isExpectedSupervisorProcess(record))');
    expect(jobsSource).toContain("reason: 'process_identity_mismatch'");
    expect(jobsSource).toContain("reason: stoppedCleanly ? 'drained' : forced ? 'forced_after_timeout'");
  });

  test('README describes cloud model transfer and does not promise audio import', () => {
    expect(readme).toContain('会发送给你配置的模型提供商');
    expect(readme).not.toContain('音频文件（自动转写）');
  });

  test('Admin sessions have expiry pruning and a hard cap', () => {
    expect(serveSource).toContain('ADMIN_SESSION_CAP');
    expect(serveSource).toContain('setInterval(pruneAdminSessions');
    expect(serveSource).toContain('createAdminSession(');
  });
});
