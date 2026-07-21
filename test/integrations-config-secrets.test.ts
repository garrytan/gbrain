/**
 * #2789: integrations show/status must resolve secrets the way the gateway
 * does — process.env overlaid on the ~/.gbrain/config.json keys that
 * buildGatewayConfig folds into the gateway env. Also pins the X recipe's
 * secret name to the env var the x-api resolver actually reads.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import { secretValue } from '../src/commands/integrations.ts';

const originalHome = process.env.GBRAIN_HOME;
const originalKey = process.env.ANTHROPIC_API_KEY;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-secrets-'));
  process.env.GBRAIN_HOME = home;
  delete process.env.ANTHROPIC_API_KEY;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalHome;
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  rmSync(home, { recursive: true, force: true });
});

describe('secretValue folds config-stored creds (#2789)', () => {
  test('config.json anthropic_api_key resolves when env is unset', () => {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: '/x', anthropic_api_key: 'sk-cfg-only' }),
    );
    expect(secretValue('ANTHROPIC_API_KEY')).toBe('sk-cfg-only');
  });

  test('process.env wins over config.json', () => {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: '/x', anthropic_api_key: 'sk-cfg' }),
    );
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    expect(secretValue('ANTHROPIC_API_KEY')).toBe('sk-env');
  });

  test('missing everywhere resolves undefined', () => {
    expect(secretValue('DEFINITELY_NOT_SET_ANYWHERE_XYZ')).toBeUndefined();
  });
});

describe('x-to-brain secret name matches the resolver (#2789)', () => {
  test('recipe frontmatter declares X_API_BEARER_TOKEN (the env var handle-to-tweet reads)', () => {
    const recipe = matter(readFileSync(join(import.meta.dir, '..', 'recipes', 'x-to-brain.md'), 'utf-8'));
    const names = (recipe.data.secrets as Array<{ name: string }>).map(s => s.name);
    expect(names).toContain('X_API_BEARER_TOKEN');
    expect(names).not.toContain('X_BEARER_TOKEN');
    // The recipe body's curl validation steps must use the same var.
    expect(recipe.content).not.toContain('$X_BEARER_TOKEN');
  });
});
