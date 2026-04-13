import { describe, test, expect, beforeAll } from 'bun:test';
import { parseRecipe } from '../src/commands/integrations.ts';

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
});
