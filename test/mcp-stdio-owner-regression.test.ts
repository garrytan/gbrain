import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'mcp', 'server.ts'),
  'utf-8',
);

describe('mcp stdio lifecycle owner regression', () => {
  test('startMcpServer does not install its own stdio or signal shutdown hooks', () => {
    expect(SERVER_SRC).not.toContain('process.stdin.on(');
    expect(SERVER_SRC).not.toContain('process.on(\'SIGTERM\'');
    expect(SERVER_SRC).not.toContain('process.on(\'SIGINT\'');
    expect(SERVER_SRC).not.toContain('process.on(\'SIGHUP\'');
    expect(SERVER_SRC).not.toContain('transport.onclose =');
    expect(SERVER_SRC).not.toContain('engine.disconnect?.()');
    expect(SERVER_SRC).not.toContain('process.exit(');
  });
});
