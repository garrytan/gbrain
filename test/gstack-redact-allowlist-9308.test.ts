import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

const tracked = (path: string) => spawnSync('git', ['ls-files', '--error-unmatch', path], { cwd: `${import.meta.dir}/..` }).status === 0;

describe('#9308: the pre-push redaction allowlist sits where the guard reads it', () => {
  test('it is committed at the repository root, not under .gstack/', () => {
    expect(tracked('.gstack-redact-allowlist')).toBe(true);
    expect(tracked('.gstack/redact-allowlist')).toBe(false);
  });
});
