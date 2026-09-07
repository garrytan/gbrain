import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Execute the real runner invocation with Docker replaced by an argv recorder.
// On macOS /bin/bash is 3.2, where an empty array under nounset is special.
const line = readFileSync(new URL('../scripts/ci-local.sh', import.meta.url), 'utf8')
  .split('\n').find(value => value.startsWith('docker compose ') && value.includes('EXTRA_MOUNTS'));

for (const populated of [false, true]) {
  test(`ci-local runner preserves ${populated ? 'worktree' : 'empty'} mount argv`, () => {
    expect(line).toBeDefined();
    const script = [
      'set -eu',
      'COMPOSE_FILE=compose.yml',
      'INNER_CMD="echo test"',
      populated ? 'EXTRA_MOUNTS=(-v "/tmp/path with spaces:/git:ro")' : 'EXTRA_MOUNTS=()',
      'docker() { printf "<%s>\\n" "$@"; }',
      line!,
    ].join('\n');
    const result = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const expected = ['compose', '-f', 'compose.yml', 'run', '--rm',
      ...(populated ? ['-v', '/tmp/path with spaces:/git:ro'] : []),
      'runner', 'bash', '-c', 'echo test'];
    expect(result.stdout).toBe(expected.map(value => `<${value}>\n`).join(''));
  });
}
