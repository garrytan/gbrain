import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
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
    const privateHomePath = ['', 'Users', 'alice-example', 'private-project'].join('/');

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
    expect(draft).not.toContain('private-project');
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
    const privateHomePath = ['', 'Users', 'alice-example', 'secret-client-repo'].join('/');

    runHook({
      hook_event_name: 'Stop',
      session_id: 'session-metadata-only',
      cwd: privateHomePath,
      git_remote: 'git@example.com:acme-example/secret-client-repo.git',
      repo_name: 'secret-client-repo',
      mentioned_projects: ['secret-client-repo'],
      transcript_path: '/tmp/private-transcript.jsonl',
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
    expect(draft).not.toContain('secret-client-repo');
    expect(draft).not.toContain('git@example.com');
    expect(draft).not.toContain('private-transcript');
  });
});
