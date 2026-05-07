import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runSubbrain } from '../src/commands/subbrain.ts';
import { SUBBRAIN_REGISTRY_CONFIG_KEY } from '../src/core/subbrains.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-subbrain-command-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['-C', repoPath, 'init'], { stdio: 'ignore' });
  return repoPath;
}

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-subbrain-non-git-'));
  tempDirs.push(dir);
  return dir;
}

function makeEngine(initialConfig: Record<string, string> = {}) {
  const config = new Map(Object.entries(initialConfig));
  const setConfigCalls: Array<[string, string]> = [];
  return {
    config,
    setConfigCalls,
    engine: {
      getConfig: async (key: string) => config.get(key) ?? null,
      setConfig: async (key: string, value: string) => {
        config.set(key, value);
        setConfigCalls.push([key, value]);
      },
    } as any,
  };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (message?: unknown) => {
    lines.push(String(message ?? ''));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
}

describe('subbrain command', () => {
  test('adds a git-backed subbrain with default prefix and default flag', async () => {
    const repoPath = makeRepo();
    const { engine, config } = makeEngine();

    const output = await captureStdout(() => runSubbrain(engine, ['add', 'personal', repoPath, '--default']));
    const stored = JSON.parse(config.get(SUBBRAIN_REGISTRY_CONFIG_KEY) ?? '{}');

    expect(output).toContain('Added sub-brain personal');
    expect(stored.subbrains.personal).toEqual({
      id: 'personal',
      path: realpathSync(repoPath),
      prefix: 'personal',
      default: true,
    });
  });

  test('lists registered subbrains as json', async () => {
    const repoPath = makeRepo();
    const { engine } = makeEngine({
      [SUBBRAIN_REGISTRY_CONFIG_KEY]: JSON.stringify({
        subbrains: {
          personal: { id: 'personal', path: repoPath, prefix: 'personal', default: true },
        },
      }),
    });

    const output = await captureStdout(() => runSubbrain(engine, ['list', '--json']));

    expect(JSON.parse(output)).toEqual({
      subbrains: {
        personal: { id: 'personal', path: repoPath, prefix: 'personal', default: true },
      },
    });
  });

  test('removes a registered subbrain from the registry', async () => {
    const repoPath = makeRepo();
    const { engine, config } = makeEngine({
      [SUBBRAIN_REGISTRY_CONFIG_KEY]: JSON.stringify({
        subbrains: {
          personal: { id: 'personal', path: repoPath, prefix: 'personal' },
        },
      }),
    });

    const output = await captureStdout(() => runSubbrain(engine, ['remove', 'personal']));

    expect(output).toContain('Removed sub-brain personal');
    expect(JSON.parse(config.get(SUBBRAIN_REGISTRY_CONFIG_KEY) ?? '{}')).toEqual({ subbrains: {} });
  });

  test('does not mutate the registry when remove is invoked with --help', async () => {
    const { engine, config } = makeEngine({
      [SUBBRAIN_REGISTRY_CONFIG_KEY]: JSON.stringify({
        subbrains: {
          personal: { id: 'personal', path: '/brain/personal', prefix: 'personal' },
        },
      }),
    });

    const output = await captureStdout(() => runSubbrain(engine, ['remove', 'personal', '--help']));

    expect(output).toContain('Usage: mbrain subbrain remove <id>');
    expect(JSON.parse(config.get(SUBBRAIN_REGISTRY_CONFIG_KEY) ?? '{}')).toEqual({
      subbrains: {
        personal: { id: 'personal', path: '/brain/personal', prefix: 'personal' },
      },
    });
  });

  test('rejects extra remove arguments instead of ignoring them', async () => {
    const { engine, config } = makeEngine({
      [SUBBRAIN_REGISTRY_CONFIG_KEY]: JSON.stringify({
        subbrains: {
          personal: { id: 'personal', path: '/brain/personal', prefix: 'personal' },
        },
      }),
    });

    await expect(runSubbrain(engine, ['remove', 'personal', '--force']))
      .rejects.toThrow('Usage: mbrain subbrain remove <id>');
    expect(JSON.parse(config.get(SUBBRAIN_REGISTRY_CONFIG_KEY) ?? '{}')).toEqual({
      subbrains: {
        personal: { id: 'personal', path: '/brain/personal', prefix: 'personal' },
      },
    });
  });

  test('rejects paths that are not git repositories', async () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'note.md'), '# Not Git\n');
    const { engine } = makeEngine();

    await expect(runSubbrain(engine, ['add', 'personal', dir]))
      .rejects.toThrow('Sub-brain path is not a git repository');
  });

  test('rejects removing an unknown subbrain', async () => {
    const { engine } = makeEngine();

    await expect(runSubbrain(engine, ['remove', 'personal']))
      .rejects.toThrow('Unknown sub-brain: personal');
  });

  test('supports explicit prefix during add', async () => {
    const repoPath = makeRepo();
    const { engine, config } = makeEngine();

    await captureStdout(() => runSubbrain(engine, ['add', 'office', repoPath, '--prefix', 'work']));
    const stored = JSON.parse(config.get(SUBBRAIN_REGISTRY_CONFIG_KEY) ?? '{}');

    expect(stored.subbrains.office.prefix).toBe('work');
  });
});
