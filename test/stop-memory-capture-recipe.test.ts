import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = join(import.meta.dir, '..');
const hook = join(repoRoot, 'recipes/stop-memory-capture/stop-memory-capture.ts');

function runHook(input: unknown, env: Record<string, string>): string {
  return execFileSync('bun', [hook], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
  });
}

function readAutoDrafts(brainDir: string): string[] {
  const autoDir = join(brainDir, 'inbox', 'auto');
  if (!existsSync(autoDir)) return [];
  const days = readdirSync(autoDir);
  return days.flatMap((day) =>
    readdirSync(join(autoDir, day))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(autoDir, day, name)),
  );
}

describe('stop-memory-capture recipe', () => {
  test('prints Codex hook config for prompt, stop, and subagent-stop events', () => {
    const out = execFileSync('bun', [hook, '--print-config'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const config = JSON.parse(out) as { hooks: Record<string, unknown> };
    expect(Object.keys(config.hooks).sort()).toEqual([
      'Stop',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
    expect(out).toContain('stop-memory-capture.ts');
  });

  test('writes raw local evidence plus a redacted review draft', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-stop-capture-'));
    const brainDir = join(root, 'brain');
    const rawDir = join(root, 'raw');
    const privateHomePath = ['', 'Users', 'alice-example', 'example-worktree'].join('/');

    runHook({
      hook_event_name: 'Stop',
      session_id: 'session-one',
      cwd: privateHomePath,
      transcript: [
        { role: 'user', content: 'Remember this durable product decision.' },
        { role: 'assistant', content: 'Decision captured with rationale.' },
      ],
    }, {
      GBRAIN_CAPTURE_BRAIN_DIR: brainDir,
      GBRAIN_CAPTURE_RAW_DIR: rawDir,
      GBRAIN_CAPTURE_MIN_CHARS: '1',
    });

    const rawFiles = readdirSync(rawDir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.raw.md'));
    expect(rawFiles.length).toBe(1);

    const drafts = readAutoDrafts(brainDir);
    expect(drafts.length).toBe(1);
    const draft = readFileSync(drafts[0], 'utf8');
    expect(draft).toContain('hook_event: "Stop"');
    expect(draft).toContain('session_id: "session-one"');
    expect(draft).toContain('Capture segment 1');
    expect(draft).toContain('Remember this durable product decision.');
    expect(draft).not.toContain(privateHomePath);
    expect(draft).not.toContain('example-worktree');
  });

  test('creates raw, draft, and state files with owner-only permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-stop-capture-perms-'));
    const brainDir = join(root, 'brain');
    const rawDir = join(root, 'raw');

    runHook({
      hook_event_name: 'Stop',
      session_id: 'session-permissions',
      prompt: 'This durable session note is long enough to pass the capture threshold.',
    }, {
      GBRAIN_CAPTURE_BRAIN_DIR: brainDir,
      GBRAIN_CAPTURE_RAW_DIR: rawDir,
      GBRAIN_CAPTURE_MIN_CHARS: '1',
    });

    const rawFiles = readdirSync(rawDir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.raw.md') || name.endsWith('.json'))
      .map((name) => join(rawDir, name));
    const drafts = readAutoDrafts(brainDir);

    expect([...rawFiles, ...drafts].length).toBeGreaterThan(0);
    for (const file of [...rawFiles, ...drafts]) {
      expect(statSync(file).mode & 0o077).toBe(0);
    }
  });

  test('redacts common env secret names and database credentials from review drafts', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-stop-capture-secrets-'));
    const brainDir = join(root, 'brain');
    const rawDir = join(root, 'raw');
    const databaseKey = ['DATABASE', '_URL='].join('');
    const anthropicKeyName = ['ANTHROPIC', '_API', '_KEY='].join('');
    const openaiKeyName = ['OPENAI', '_API', '_KEY='].join('');
    const databaseUrl = [
      databaseKey,
      ['postgres', '://alice:'].join(''),
      'placeholder-db-password',
      '@example.com:5432/db',
    ].join('');
    const anthropicKey = [
      anthropicKeyName,
      'placeholder-anthropic-value',
    ].join('');
    const openaiKey = [
      openaiKeyName,
      'placeholder-openai-value',
    ].join('');

    runHook({
      hook_event_name: 'Stop',
      session_id: 'session-secret-redaction',
      prompt: [
        databaseUrl,
        anthropicKey,
        openaiKey,
        'This text is intentionally long enough to create a review draft.',
      ].join(' '),
    }, {
      GBRAIN_CAPTURE_BRAIN_DIR: brainDir,
      GBRAIN_CAPTURE_RAW_DIR: rawDir,
      GBRAIN_CAPTURE_MIN_CHARS: '1',
    });

    const drafts = readAutoDrafts(brainDir);
    expect(drafts.length).toBe(1);
    const draft = readFileSync(drafts[0], 'utf8');
    expect(draft).not.toContain(databaseKey);
    expect(draft).not.toContain('placeholder-db-password');
    expect(draft).not.toContain(anthropicKeyName);
    expect(draft).not.toContain('placeholder-anthropic-value');
    expect(draft).not.toContain(openaiKeyName);
    expect(draft).not.toContain('placeholder-openai-value');
    expect(draft).toContain('[redacted-database-url]');
    expect(draft).toContain('[redacted-secret]');
  });

  test('redacts private path tails and case-insensitive secret assignments from review drafts', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-stop-capture-deep-redact-'));
    const brainDir = join(root, 'brain');
    const rawDir = join(root, 'raw');
    const macHomeFile = ['', 'Users', 'alice-example', 'example-client-repo', '.env'].join('/');
    const linuxHomeFile = ['', 'home', 'alice-example', 'second-example-repo', 'config.local'].join('/');
    const lowerSecretName = ['openai', '_api', '_key='].join('');
    const mixedSecretName = ['MixedCase', 'Token='].join('');
    const dbUrlName = ['db', '_url='].join('');
    const dbUrlValue = [
      ['postgresql', '://alice:'].join(''),
      'placeholder-db-pass',
      '@example.invalid/db',
    ].join('');

    runHook({
      hook_event_name: 'Stop',
      session_id: 'session-deep-redaction',
      prompt: [
        `Check ${macHomeFile} and ${linuxHomeFile}`,
        `${lowerSecretName}placeholder-lowercase-value`,
        `${mixedSecretName}"placeholder-mixed-token"`,
        `${dbUrlName}${dbUrlValue}`,
        'This text is intentionally long enough to create a review draft.',
      ].join(' '),
    }, {
      GBRAIN_CAPTURE_BRAIN_DIR: brainDir,
      GBRAIN_CAPTURE_RAW_DIR: rawDir,
      GBRAIN_CAPTURE_MIN_CHARS: '1',
    });

    const drafts = readAutoDrafts(brainDir);
    expect(drafts.length).toBe(1);
    const draft = readFileSync(drafts[0], 'utf8');
    expect(draft).not.toContain('example-client-repo');
    expect(draft).not.toContain('second-example-repo');
    expect(draft).not.toContain(lowerSecretName);
    expect(draft).not.toContain('placeholder-lowercase-value');
    expect(draft).not.toContain(mixedSecretName);
    expect(draft).not.toContain('placeholder-mixed-token');
    expect(draft).not.toContain(dbUrlName);
    expect(draft).not.toContain('placeholder-db-pass');
    expect(draft).toContain('[redacted-local-path]');
    expect(draft).toContain('[redacted-secret]');
    expect(draft).toContain('[redacted-database-url]');
  });

  test('refuses to write through an existing symlinked review draft', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-stop-capture-symlink-'));
    const brainDir = join(root, 'brain');
    const rawDir = join(root, 'raw');
    const env = {
      GBRAIN_CAPTURE_BRAIN_DIR: brainDir,
      GBRAIN_CAPTURE_RAW_DIR: rawDir,
      GBRAIN_CAPTURE_MIN_CHARS: '1',
    };

    runHook({
      hook_event_name: 'Stop',
      session_id: 'session-symlink-defense',
      prompt: 'First durable session note creates the review draft path.',
    }, env);

    const drafts = readAutoDrafts(brainDir);
    expect(drafts.length).toBe(1);
    const outside = join(root, 'outside-target.md');
    writeFileSync(outside, 'outside stays\n');
    unlinkSync(drafts[0]);
    symlinkSync(outside, drafts[0]);

    expect(() => runHook({
      hook_event_name: 'Stop',
      session_id: 'session-symlink-defense',
      prompt: 'Second durable session note must not follow the symlink.',
    }, env)).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('outside stays\n');
  });

  test('appends repeated captures for the same session into one draft', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-stop-capture-session-'));
    const brainDir = join(root, 'brain');
    const rawDir = join(root, 'raw');
    const env = {
      GBRAIN_CAPTURE_BRAIN_DIR: brainDir,
      GBRAIN_CAPTURE_RAW_DIR: rawDir,
      GBRAIN_CAPTURE_MIN_CHARS: '1',
    };

    runHook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-repeat',
      prompt: 'First user prompt with durable context.',
    }, env);
    runHook({
      hook_event_name: 'SubagentStop',
      session_id: 'session-repeat',
      transcript: [
        { role: 'assistant', content: 'Second segment adds the follow-up decision.' },
      ],
    }, env);

    const drafts = readAutoDrafts(brainDir);
    expect(drafts.length).toBe(1);
    const draft = readFileSync(drafts[0], 'utf8');
    expect(draft).toContain('capture_segment_count: 2');
    expect(draft).toContain('latest_hook_event: "SubagentStop"');
    expect(draft).toContain('latest_content_hash: ');
    expect(draft).toContain('## Capture segment 1');
    expect(draft).toContain('## Capture segment 2');
    expect(draft).toContain('hook_event: "SubagentStop"');
    expect(draft).toContain('Second segment adds the follow-up decision.');
  });

  test('does not serialize private hook metadata into review-draft fallback content', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-stop-capture-fallback-'));
    const brainDir = join(root, 'brain');
    const rawDir = join(root, 'raw');
    const privateHomePath = ['', 'Users', 'alice-example', 'example-client-repo'].join('/');

    runHook({
      hook_event_name: 'Stop',
      session_id: 'session-metadata-only',
      cwd: privateHomePath,
      git_remote: 'git@example.com:acme-example/example-client-repo.git',
      repo_name: 'example-client-repo',
      mentioned_projects: ['example-client-repo'],
      transcript_path: '/tmp/example-transcript.jsonl',
    }, {
      GBRAIN_CAPTURE_BRAIN_DIR: brainDir,
      GBRAIN_CAPTURE_RAW_DIR: rawDir,
      GBRAIN_CAPTURE_MIN_CHARS: '1',
    });

    const drafts = readAutoDrafts(brainDir);
    expect(drafts.length).toBe(1);
    const draft = readFileSync(drafts[0], 'utf8');
    expect(draft).toContain('payload_status: "missing content payload"');
    expect(draft).toContain('No prompt, transcript, or messages payload was present');
    expect(draft).not.toContain(privateHomePath);
    expect(draft).not.toContain('example-client-repo');
    expect(draft).not.toContain('git@example.com');
    expect(draft).not.toContain('example-transcript');
  });
});
