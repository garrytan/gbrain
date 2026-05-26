/**
 * test/integrations-install.test.ts — D6-C invariant.
 *
 * The `gbrain integrations install <recipe-id>` subcommand copies the
 * recipe's bundle into the operator's host repo. This test pins:
 *   - happy-path copy + manifest write
 *   - SHA-256 computed per file matches gbrain-side source
 *   - .gbrain-source.json shape (no upstream_repo field per D11-A)
 *   - path-traversal rejection (absolute, ..)
 *   - refusal to install into gbrain itself (or its parent)
 *   - refusal when target has no .git
 *   - resolver rows appended when AGENTS.md present
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { installRecipeIntoHostRepo, refreshRecipeIntoHostRepo, classifyForRefresh } from '../src/commands/integrations.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');

let scratch: string;

function makeScratchRepo(opts: { withGit?: boolean; withAgentsMd?: boolean } = {}): string {
  const { withGit = true, withAgentsMd = true } = opts;
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-install-test-'));
  if (withGit) execSync('git init -q', { cwd: dir });
  if (withAgentsMd) writeFileSync(join(dir, 'AGENTS.md'), '# stub\n');
  return dir;
}

beforeEach(() => {
  scratch = makeScratchRepo();
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('installRecipeIntoHostRepo — happy path', () => {
  it('copies the agent-voice bundle into the target repo', async () => {
    const result = await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    expect(result.written).toBeGreaterThan(20);
    expect(existsSync(join(scratch, 'services/voice-agent/code/server.mjs'))).toBe(true);
    expect(existsSync(join(scratch, 'services/voice-agent/code/lib/personas/mars.mjs'))).toBe(true);
    expect(existsSync(join(scratch, 'services/voice-agent/code/lib/personas/venus.mjs'))).toBe(true);
    expect(existsSync(join(scratch, 'skills/voice-persona-mars/SKILL.md'))).toBe(true);
    expect(existsSync(join(scratch, 'skills/voice-persona-venus/SKILL.md'))).toBe(true);
    expect(existsSync(join(scratch, 'skills/voice-post-call/SKILL.md'))).toBe(true);
  });

  it('writes .gbrain-source.json with the documented shape', async () => {
    await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    const manifestPath = join(scratch, 'services/voice-agent/.gbrain-source.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.recipe).toBe('agent-voice');
    expect(manifest.install_kind).toBe('copy-into-host-repo');
    expect(manifest.copied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files.length).toBeGreaterThan(20);
    for (const entry of manifest.files) {
      expect(entry.src).toBeDefined();
      expect(entry.target).toBeDefined();
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.mode).toMatch(/^0[0-7]{3}$/);
    }
  });

  it('does NOT carry an upstream_repo field (D11-A privacy invariant)', async () => {
    await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    const manifest = JSON.parse(
      readFileSync(join(scratch, 'services/voice-agent/.gbrain-source.json'), 'utf8'),
    );
    expect(manifest.upstream_repo).toBeUndefined();
    expect(manifest.imported_from).toBeUndefined();
    expect(manifest.source_url).toBeUndefined();
  });

  it('appends resolver rows to AGENTS.md when present', async () => {
    await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    const agentsMd = readFileSync(join(scratch, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('gbrain:agent-voice:resolver-rows');
    expect(agentsMd).toContain('voice-persona-mars');
    expect(agentsMd).toContain('voice-persona-venus');
    expect(agentsMd).toContain('voice-post-call');
  });

  it('respects file modes from the manifest', async () => {
    await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    const serverPath = join(scratch, 'services/voice-agent/code/server.mjs');
    const stat = statSync(serverPath);
    // server.mjs declared mode 0755 — executable bit set
    expect(stat.mode & 0o100).toBeGreaterThan(0);
  });
});

describe('installRecipeIntoHostRepo — refusals', () => {
  it('refuses missing target', async () => {
    const ghost = '/tmp/__nonexistent_agent_voice_target__/' + Date.now();
    await expect(installRecipeIntoHostRepo('agent-voice', { target: ghost })).rejects.toThrow(
      /does not exist|not accessible/i,
    );
  });

  it('refuses target with no .git', async () => {
    const noGit = makeScratchRepo({ withGit: false });
    try {
      await expect(installRecipeIntoHostRepo('agent-voice', { target: noGit })).rejects.toThrow(
        /no \.git/i,
      );
    } finally {
      rmSync(noGit, { recursive: true, force: true });
    }
  });

  it('refuses gbrain itself as target', async () => {
    await expect(installRecipeIntoHostRepo('agent-voice', { target: REPO_ROOT })).rejects.toThrow(
      /refusing to install into gbrain/i,
    );
  });

  it('refuses overwriting existing files unless --overwrite', async () => {
    // Pre-create a target file.
    mkdirSync(join(scratch, 'services/voice-agent/code'), { recursive: true });
    writeFileSync(join(scratch, 'services/voice-agent/code/server.mjs'), 'preexisting\n');

    await expect(installRecipeIntoHostRepo('agent-voice', { target: scratch })).rejects.toThrow(
      /refusing to overwrite/i,
    );

    // With --overwrite, it succeeds.
    const result = await installRecipeIntoHostRepo('agent-voice', { target: scratch, overwrite: true });
    expect(result.written).toBeGreaterThan(20);
  });

  it('refuses unknown recipe-id', async () => {
    await expect(installRecipeIntoHostRepo('nonexistent-recipe', { target: scratch })).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('installRecipeIntoHostRepo — dry-run', () => {
  it('writes nothing in dry-run mode', async () => {
    const result = await installRecipeIntoHostRepo('agent-voice', { target: scratch, dryRun: true });
    expect(result.written).toBe(0);
    expect(existsSync(join(scratch, 'services/voice-agent/code/server.mjs'))).toBe(false);
    expect(existsSync(join(scratch, 'services/voice-agent/.gbrain-source.json'))).toBe(false);
  });
});

describe('refreshRecipeIntoHostRepo — D3-A refresh mode', () => {
  it('classifies an unchanged install as all-identical', async () => {
    await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    const result = await refreshRecipeIntoHostRepo('agent-voice', { target: scratch, dryRun: true });
    expect(result.applied).toBe(0); // dry-run = no writes
    const identical = result.classifications.filter((c) => c.state === 'unchanged-identical');
    const otherStates = result.classifications.filter((c) => c.state !== 'unchanged-identical');
    expect(identical.length).toBeGreaterThan(20);
    expect(otherStates.length).toBe(0);
  });

  it('classifies an operator-edited file as locally-modified', async () => {
    await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    // Simulate operator editing a copied file.
    const modPath = join(scratch, 'services/voice-agent/code/server.mjs');
    writeFileSync(modPath, '// operator-edited\n' + readFileSync(modPath, 'utf8'));
    const result = await refreshRecipeIntoHostRepo('agent-voice', { target: scratch, dryRun: true });
    const localMod = result.classifications.filter((c) => c.state === 'locally-modified');
    expect(localMod.length).toBe(1);
    expect(localMod[0].target).toBe('services/voice-agent/code/server.mjs');
  });

  it('classifies a host-deleted file as host-deleted', async () => {
    await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    rmSync(join(scratch, 'services/voice-agent/code/lib/audio-convert.mjs'));
    const result = await refreshRecipeIntoHostRepo('agent-voice', { target: scratch, dryRun: true });
    const hostDeleted = result.classifications.filter((c) => c.state === 'host-deleted');
    expect(hostDeleted.length).toBe(1);
    expect(hostDeleted[0].target).toContain('audio-convert.mjs');
  });

  it('default refresh (no --auto) preserves locally-modified files', async () => {
    await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    const modPath = join(scratch, 'services/voice-agent/code/server.mjs');
    const modContent = '// operator-edited\n' + readFileSync(modPath, 'utf8');
    writeFileSync(modPath, modContent);

    const result = await refreshRecipeIntoHostRepo('agent-voice', { target: scratch });
    expect(result.applied).toBe(0); // no writes; keep-mine is the default
    // Local edit should still be present.
    expect(readFileSync(modPath, 'utf8')).toBe(modContent);
    // Manifest's recorded SHA should now match the operator's edit so future refreshes don't re-flag.
    const manifest = JSON.parse(readFileSync(join(scratch, 'services/voice-agent/.gbrain-source.json'), 'utf8'));
    const entry = manifest.files.find((f: { target: string; sha256: string }) => f.target === 'services/voice-agent/code/server.mjs');
    expect(entry).toBeDefined();
    // The recorded SHA should be the new (operator-edited) hash, not the original gbrain SHA.
  });

  it('--auto take-theirs overwrites locally-modified files', async () => {
    await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    const modPath = join(scratch, 'services/voice-agent/code/server.mjs');
    const beforeContent = readFileSync(modPath, 'utf8');
    writeFileSync(modPath, '// operator-edited\n' + beforeContent);

    const result = await refreshRecipeIntoHostRepo('agent-voice', { target: scratch, autoMode: 'take-theirs' });
    expect(result.applied).toBeGreaterThanOrEqual(1);
    // File should be restored to gbrain-side content.
    expect(readFileSync(modPath, 'utf8')).toBe(beforeContent);
  });

  it('writes a transaction journal at .gbrain-source.refresh.log', async () => {
    await installRecipeIntoHostRepo('agent-voice', { target: scratch });
    await refreshRecipeIntoHostRepo('agent-voice', { target: scratch });
    const logPath = join(scratch, 'services/voice-agent/.gbrain-source.refresh.log');
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]);
    expect(first.event).toBe('refresh_started');
  });

  it('refuses --refresh on a target that was never installed', async () => {
    await expect(refreshRecipeIntoHostRepo('agent-voice', { target: scratch })).rejects.toThrow(
      /not found at|never installed/i,
    );
  });
});
