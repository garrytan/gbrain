import { describe, test, expect, beforeAll } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseRecipe, runIntegrations, runRecipeHealthCheck } from '../src/commands/integrations.ts';

// --- parseRecipe tests ---

describe('parseRecipe', () => {
  test('parses valid recipe with full frontmatter', () => {
    const content = `---
id: test-recipe
name: Test Recipe
version: 1.0.0
description: A test recipe
category: sense
requires: []
secrets:
  - name: API_KEY
    description: Test key
    where: https://example.com
health_checks:
  - type: env_exists
    name: TEST_API_KEY
    label: Test API
setup_time: 5 min
---

# Setup Guide

Step 1: do the thing.

---

Step 2: do the other thing.
`;
    const recipe = parseRecipe(content, 'test.md');
    expect(recipe).not.toBeNull();
    expect(recipe!.frontmatter.id).toBe('test-recipe');
    expect(recipe!.frontmatter.name).toBe('Test Recipe');
    expect(recipe!.frontmatter.version).toBe('1.0.0');
    expect(recipe!.frontmatter.category).toBe('sense');
    expect(recipe!.frontmatter.secrets).toHaveLength(1);
    expect(recipe!.frontmatter.secrets[0].name).toBe('API_KEY');
    expect(recipe!.frontmatter.secrets[0].where).toBe('https://example.com');
    expect(recipe!.frontmatter.health_checks).toEqual([
      { type: 'env_exists', name: 'TEST_API_KEY', label: 'Test API' },
    ]);
    // Body should contain the horizontal rule (---) without being split
    expect(recipe!.body).toContain('Step 1');
    expect(recipe!.body).toContain('Step 2');
    expect(recipe!.body).toContain('---');
  });

  test('body with --- horizontal rules is NOT split as timeline', () => {
    const content = `---
id: hr-test
name: HR Test
---

Section one content.

---

Section two content.

---

Section three content.
`;
    const recipe = parseRecipe(content, 'hr-test.md');
    expect(recipe).not.toBeNull();
    // All three sections should be in the body (gray-matter doesn't split on ---)
    expect(recipe!.body).toContain('Section one');
    expect(recipe!.body).toContain('Section two');
    expect(recipe!.body).toContain('Section three');
  });

  test('returns null for missing id', () => {
    const content = `---
name: No ID Recipe
---
Content here.
`;
    const recipe = parseRecipe(content, 'no-id.md');
    expect(recipe).toBeNull();
  });

  test('returns null for malformed YAML', () => {
    const content = `---
id: broken
  this is not: valid: yaml: [
---
Content.
`;
    const recipe = parseRecipe(content, 'broken.md');
    expect(recipe).toBeNull();
  });

  test('returns null for no frontmatter', () => {
    const content = `# Just a markdown file

No frontmatter here.
`;
    const recipe = parseRecipe(content, 'plain.md');
    expect(recipe).toBeNull();
  });

  test('defaults missing optional fields', () => {
    const content = `---
id: minimal
---
Minimal recipe.
`;
    const recipe = parseRecipe(content, 'minimal.md');
    expect(recipe).not.toBeNull();
    expect(recipe!.frontmatter.name).toBe('minimal');
    expect(recipe!.frontmatter.version).toBe('0.0.0');
    expect(recipe!.frontmatter.category).toBe('sense');
    expect(recipe!.frontmatter.requires).toEqual([]);
    expect(recipe!.frontmatter.secrets).toEqual([]);
    expect(recipe!.frontmatter.health_checks).toEqual([]);
  });

  test('records validation errors for legacy shell health checks', () => {
    const content = `---
id: shell-check
name: Shell Check
health_checks:
  - "echo should-not-run"
---
Shell health checks should not be accepted.
`;
    const recipe = parseRecipe(content, 'shell-check.md');
    expect(recipe).not.toBeNull();
    expect(recipe!.frontmatter.health_checks).toEqual([]);
    expect(recipe!.validation_errors).toContain(
      'health_checks[0] must be a typed object, not a shell command string',
    );
  });

  test('parses bounded health check DSL variants', () => {
    const content = `---
id: typed-checks
health_checks:
  - type: env_any_exists
    names: [CLAWVISOR_URL, GOOGLE_CLIENT_ID]
    label: Calendar auth
  - type: url_responds
    url: http://localhost:4040/api/tunnels
    label: ngrok API
    timeout_ms: 2000
  - type: heartbeat_fresh
    max_age: 24h
    label: Integration heartbeat
---
Typed health checks only.
`;
    const recipe = parseRecipe(content, 'typed-checks.md');
    expect(recipe).not.toBeNull();
    expect(recipe!.validation_errors).toEqual([]);
    expect(recipe!.frontmatter.health_checks).toEqual([
      { type: 'env_any_exists', names: ['CLAWVISOR_URL', 'GOOGLE_CLIENT_ID'], label: 'Calendar auth' },
      { type: 'url_responds', url: 'http://127.0.0.1:4040/api/tunnels', label: 'ngrok API', timeout_ms: 2000 },
      { type: 'heartbeat_fresh', max_age: '24h', label: 'Integration heartbeat' },
    ]);
  });

  test('rejects unsafe or unbounded health check fields', () => {
    const content = `---
id: unsafe-checks
health_checks:
  - type: url_responds
    url: file:///etc/passwd
  - type: url_responds
    url: http://localhost:4040/api/tunnels
    timeout_ms: 60000
  - type: heartbeat_fresh
    max_age: sometime
---
Unsafe health checks should be rejected.
`;
    const recipe = parseRecipe(content, 'unsafe-checks.md');
    expect(recipe).not.toBeNull();
    expect(recipe!.frontmatter.health_checks).toEqual([]);
    expect(recipe!.validation_errors).toContain('health_checks[0].url must use http or https');
    expect(recipe!.validation_errors).toContain('health_checks[1].timeout_ms must be an integer between 1 and 10000');
    expect(recipe!.validation_errors).toContain('health_checks[2].max_age must use a duration like 30s, 5m, 24h, or 7d');
  });

  test('rejects url_responds targets outside localhost loopback', () => {
    const content = `---
id: remote-probe
health_checks:
  - type: url_responds
    url: http://169.254.169.254/latest/meta-data
---
Remote probes should not be allowed in recipe health checks.
`;
    const recipe = parseRecipe(content, 'remote-probe.md');
    expect(recipe).not.toBeNull();
    expect(recipe!.frontmatter.health_checks).toEqual([]);
    expect(recipe!.validation_errors).toContain(
      'health_checks[0].url must target localhost or 127.0.0.1',
    );
  });

  test('parses reflex category', () => {
    const content = `---
id: meeting-prep
category: reflex
---
Prep for meetings.
`;
    const recipe = parseRecipe(content, 'reflex.md');
    expect(recipe).not.toBeNull();
    expect(recipe!.frontmatter.category).toBe('reflex');
  });

  test('parses multiple secrets', () => {
    const content = `---
id: multi-secret
secrets:
  - name: KEY_A
    description: First key
    where: https://a.com
  - name: KEY_B
    description: Second key
    where: https://b.com
  - name: KEY_C
    description: Third key
    where: https://c.com
---
Content.
`;
    const recipe = parseRecipe(content, 'multi.md');
    expect(recipe).not.toBeNull();
    expect(recipe!.frontmatter.secrets).toHaveLength(3);
    expect(recipe!.frontmatter.secrets[2].name).toBe('KEY_C');
  });
});

describe('runRecipeHealthCheck', () => {
  test('checks required environment variables without running shell commands', async () => {
    const previous = process.env.MBRAIN_TEST_HEALTH_TOKEN;
    process.env.MBRAIN_TEST_HEALTH_TOKEN = 'present';
    try {
      const result = await runRecipeHealthCheck('test-recipe', {
        type: 'env_exists',
        name: 'MBRAIN_TEST_HEALTH_TOKEN',
        label: 'Test token',
      });
      expect(result).toEqual({
        integration: 'test-recipe',
        check: 'Test token',
        status: 'ok',
        output: 'Test token: OK',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.MBRAIN_TEST_HEALTH_TOKEN;
      } else {
        process.env.MBRAIN_TEST_HEALTH_TOKEN = previous;
      }
    }
  });

  test('reports missing alternatives for env_any_exists', async () => {
    delete process.env.MBRAIN_TEST_HEALTH_A;
    delete process.env.MBRAIN_TEST_HEALTH_B;

    const result = await runRecipeHealthCheck('test-recipe', {
      type: 'env_any_exists',
      names: ['MBRAIN_TEST_HEALTH_A', 'MBRAIN_TEST_HEALTH_B'],
      label: 'Any auth',
    });

    expect(result.status).toBe('fail');
    expect(result.output).toBe('Any auth: missing one of MBRAIN_TEST_HEALTH_A, MBRAIN_TEST_HEALTH_B');
  });

  test('does not reveal which env_any_exists alternative is configured', async () => {
    const previousA = process.env.MBRAIN_TEST_HEALTH_A;
    const previousB = process.env.MBRAIN_TEST_HEALTH_B;
    process.env.MBRAIN_TEST_HEALTH_A = 'present';
    delete process.env.MBRAIN_TEST_HEALTH_B;
    try {
      const result = await runRecipeHealthCheck('test-recipe', {
        type: 'env_any_exists',
        names: ['MBRAIN_TEST_HEALTH_A', 'MBRAIN_TEST_HEALTH_B'],
        label: 'Any auth',
      });

      expect(result.status).toBe('ok');
      expect(result.output).toBe('Any auth: OK');
      expect(result.output).not.toContain('MBRAIN_TEST_HEALTH_A');
    } finally {
      if (previousA === undefined) {
        delete process.env.MBRAIN_TEST_HEALTH_A;
      } else {
        process.env.MBRAIN_TEST_HEALTH_A = previousA;
      }
      if (previousB === undefined) {
        delete process.env.MBRAIN_TEST_HEALTH_B;
      } else {
        process.env.MBRAIN_TEST_HEALTH_B = previousB;
      }
    }
  });

  test('normalizes localhost URL health checks before fetch', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return new Response(new URL(request.url).hostname);
      },
    });
    try {
      const result = await runRecipeHealthCheck('test-recipe', {
        type: 'url_responds',
        url: `http://localhost:${server.port}/health`,
        label: 'Localhost health',
        timeout_ms: 1000,
      });
      expect(result.status).toBe('ok');
      expect(result.output).toBe('Localhost health: OK');
    } finally {
      server.stop(true);
    }
  });

  test('checks typed URLs with bounded fetch timeout', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('ok');
      },
    });
    try {
      const result = await runRecipeHealthCheck('test-recipe', {
        type: 'url_responds',
        url: `http://127.0.0.1:${server.port}/health`,
        label: 'Local health',
        timeout_ms: 1000,
      });
      expect(result.status).toBe('ok');
      expect(result.output).toBe('Local health: OK');
    } finally {
      server.stop(true);
    }
  });

  test('does not follow redirects from loopback URL health checks', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data' },
        });
      },
    });
    try {
      const result = await runRecipeHealthCheck('test-recipe', {
        type: 'url_responds',
        url: `http://127.0.0.1:${server.port}/health`,
        label: 'Redirecting health',
        timeout_ms: 1000,
      });
      expect(result.status).toBe('fail');
      expect(result.output).toBe('Redirecting health: redirects are not followed');
    } finally {
      server.stop(true);
    }
  });

  test('refuses non-loopback URLs even when called directly', async () => {
    const result = await runRecipeHealthCheck('test-recipe', {
      type: 'url_responds',
      url: 'http://169.254.169.254/latest/meta-data',
      label: 'metadata probe',
      timeout_ms: 1000,
    });

    expect(result).toEqual({
      integration: 'test-recipe',
      check: 'metadata probe',
      status: 'fail',
      output: 'metadata probe: URL must target localhost or 127.0.0.1',
    });
  });
});

// --- CLI structure tests ---

describe('CLI integration', () => {
  let cliSource: string;

  beforeAll(() => {
    const { readFileSync } = require('fs');
    cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
  });

  test('DIRECT_NO_ENGINE_COMMANDS contains integrations', () => {
    const directNoEngineBlock = cliSource.match(/const DIRECT_NO_ENGINE_COMMANDS: Record<string, CliNoEngineLoader> = \{(.*?)\n\};/s)?.[1] ?? '';
    expect(directNoEngineBlock).toContain('integrations');
  });

  test('handleDirectCommand routes integrations before operation dispatch', () => {
    const directDispatchIdx = cliSource.indexOf('if (await handleDirectCommand(command, subArgs)) {');
    const opDispatchIdx = cliSource.indexOf('const op = cliOps.get(command);');
    expect(directDispatchIdx).toBeGreaterThan(0);
    expect(opDispatchIdx).toBeGreaterThan(0);
    expect(directDispatchIdx).toBeLessThan(opDispatchIdx);
  });

  test('help text mentions integrations', () => {
    expect(cliSource).toContain('integrations');
  });

  test('integrations test rejects legacy shell health checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-test-'));
    const recipePath = join(dir, 'legacy.md');
    writeFileSync(recipePath, `---
id: legacy
health_checks:
  - "echo unsafe"
---
Legacy shell checks should fail validation.
`);

    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['test', recipePath])).rejects.toThrow('EXIT:1');
      expect(logs.join('\n')).toContain('health_checks[0] must be a typed object');
      expect(errors.join('\n')).toBe('');
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
    }
  });

  test('integrations test accepts infra category and typed checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-test-'));
    const recipePath = join(dir, 'infra.md');
    writeFileSync(recipePath, `---
id: infra-recipe
name: Infra Recipe
version: 1.0.0
description: Typed infra recipe
category: infra
health_checks:
  - type: env_exists
    name: MBRAIN_TEST_INFRA_TOKEN
---
This recipe has enough body text to satisfy the validator without warnings.
`);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      await runIntegrations(['test', recipePath]);
      expect(logs.join('\n')).toContain('PASS: infra-recipe v1.0.0');
    } finally {
      console.log = originalLog;
    }
  });

  test('integrations doctor reports recipe validation errors as failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipes-'));
    writeFileSync(join(dir, 'legacy.md'), `---
id: legacy-doctor
name: Legacy Doctor
health_checks:
  - "echo unsafe"
---
Legacy shell checks should fail doctor validation.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    process.env.MBRAIN_RECIPES_DIR = dir;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      await runIntegrations(['doctor', '--json']);
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.overall).toBe('issues_found');
      expect(payload.checks[0]).toMatchObject({
        integration: 'legacy-doctor',
        status: 'fail',
        output: 'health_checks[0] must be a typed object, not a shell command string',
      });
    } finally {
      console.log = originalLog;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });
});

// --- Recipe file validation ---

describe('twilio-voice-brain recipe', () => {
  test('recipe file parses correctly', () => {
    const { readFileSync } = require('fs');
    const content = readFileSync(
      new URL('../recipes/twilio-voice-brain.md', import.meta.url),
      'utf-8'
    );
    const recipe = parseRecipe(content, 'twilio-voice-brain.md');
    expect(recipe).not.toBeNull();
    expect(recipe!.frontmatter.id).toBe('twilio-voice-brain');
    expect(recipe!.frontmatter.category).toBe('sense');
    expect(recipe!.frontmatter.secrets.length).toBeGreaterThan(0);
    expect(recipe!.frontmatter.health_checks.length).toBeGreaterThan(0);
    // Body should not be corrupted (contains --- horizontal rules)
    expect(recipe!.body.length).toBeGreaterThan(100);
  });

  test('recipe has required secrets with where URLs', () => {
    const { readFileSync } = require('fs');
    const content = readFileSync(
      new URL('../recipes/twilio-voice-brain.md', import.meta.url),
      'utf-8'
    );
    const recipe = parseRecipe(content, 'twilio-voice-brain.md');
    expect(recipe).not.toBeNull();
    for (const secret of recipe!.frontmatter.secrets) {
      expect(secret.name).toBeTruthy();
      expect(secret.where).toBeTruthy();
      expect(secret.where).toContain('https://');
    }
  });

  test('recipe has all required secrets', () => {
    const { readFileSync } = require('fs');
    const content = readFileSync(
      new URL('../recipes/twilio-voice-brain.md', import.meta.url),
      'utf-8'
    );
    const recipe = parseRecipe(content, 'twilio-voice-brain.md');
    expect(recipe).not.toBeNull();
    const secretNames = recipe!.frontmatter.secrets.map((s: any) => s.name);
    expect(secretNames).toContain('TWILIO_ACCOUNT_SID');
    expect(secretNames).toContain('TWILIO_AUTH_TOKEN');
    expect(secretNames).toContain('OPENAI_API_KEY');
  });

  test('recipe version is valid semver', () => {
    const { readFileSync } = require('fs');
    const content = readFileSync(
      new URL('../recipes/twilio-voice-brain.md', import.meta.url),
      'utf-8'
    );
    const recipe = parseRecipe(content, 'twilio-voice-brain.md');
    expect(recipe).not.toBeNull();
    expect(recipe!.frontmatter.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('recipe requires resolve to existing recipe files', () => {
    const { readFileSync, existsSync } = require('fs');
    const { resolve } = require('path');
    const content = readFileSync(
      new URL('../recipes/twilio-voice-brain.md', import.meta.url),
      'utf-8'
    );
    const recipe = parseRecipe(content, 'twilio-voice-brain.md');
    expect(recipe).not.toBeNull();
    const recipesDir = new URL('../recipes/', import.meta.url).pathname;
    for (const dep of recipe!.frontmatter.requires) {
      const depPath = resolve(recipesDir, `${dep}.md`);
      expect(existsSync(depPath)).toBe(true);
    }
  });
});

// --- All recipes parse without error ---

describe('all recipes', () => {
  test('every recipe file in recipes/ parses correctly', () => {
    const { readFileSync, readdirSync } = require('fs');
    const { resolve } = require('path');
    const recipesDir = new URL('../recipes/', import.meta.url).pathname;
    const files = readdirSync(recipesDir).filter((f: string) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(resolve(recipesDir, file), 'utf-8');
      const recipe = parseRecipe(content, file);
      expect(recipe).not.toBeNull();
      expect(recipe!.frontmatter.id).toBeTruthy();
      expect(recipe!.validation_errors).toEqual([]);
    }
  });

  test('no recipe contains personal references', () => {
    const { readFileSync, readdirSync } = require('fs');
    const { resolve } = require('path');
    const recipesDir = new URL('../recipes/', import.meta.url).pathname;
    const files = readdirSync(recipesDir).filter((f: string) => f.endsWith('.md'));
    const personalPatterns = /wintermute|mercury|16507969501|\+1650796/i;
    for (const file of files) {
      const content = readFileSync(resolve(recipesDir, file), 'utf-8');
      expect(content).not.toMatch(personalPatterns);
    }
  });
});
