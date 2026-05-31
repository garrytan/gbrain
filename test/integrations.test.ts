import { describe, test, expect, beforeAll } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
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

  test('integrations submit preflights a new recipe as JSON', async () => {
    const recipesDir = mkdtempSync(join(tmpdir(), 'mbrain-recipes-empty-'));
    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'slack-to-brain.md');
    writeFileSync(recipePath, `---
id: slack-to-brain
name: Slack to Brain
version: 1.0.0
description: Slack messages become searchable brain entries
category: sense
requires: []
secrets:
  - name: SLACK_BOT_TOKEN
    description: Slack bot token
    where: https://api.slack.com/apps
health_checks:
  - type: env_exists
    name: SLACK_BOT_TOKEN
setup_time: 20 min
---
This recipe explains how to install a deterministic Slack collector, configure
the bot token, and import selected channel messages into MBrain.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    const previousSlackToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = 'do-not-leak-this-token';
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await runIntegrations(['submit', recipePath, '--json']);
      const payload = JSON.parse(logs.join('\n'));
      expect(payload).toMatchObject({
        ok: true,
        id: 'slack-to-brain',
        target_path: 'recipes/slack-to-brain.md',
        pr_title: 'Add Slack to Brain integration recipe',
        warnings: [],
        errors: [],
      });
      expect(payload.next_steps).toContain('Copy the recipe to recipes/slack-to-brain.md');
      expect(payload.next_steps.join('\n')).not.toContain('setup logs');
      expect(payload.contribution_package).toMatchObject({
        target_path: 'recipes/slack-to-brain.md',
        pr_title: 'Add Slack to Brain integration recipe',
        files_to_include: ['recipes/slack-to-brain.md'],
      });
      expect(payload.contribution_package.review_checklist).toContain('Recipe uses the constrained health_checks DSL; submit validates the DSL but does not execute checks');
      expect(payload.contribution_package.pr_body).toContain('Adds the `Slack to Brain` integration recipe.');
      expect(payload.contribution_package.pr_body).toContain('- ID: `slack-to-brain`');
      expect(payload.contribution_package.pr_body).toContain('- Health check types: `env_exists`');
      expect(payload.contribution_package.pr_body).not.toContain(recipePath);
      expect(payload.contribution_package.pr_body).not.toContain('do-not-leak-this-token');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      if (previousSlackToken === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previousSlackToken;
      }
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit stays side-effect-free unless PR creation is explicit', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-no-pr-repo-'));
    mkdirSync(join(repoDir, 'recipes'));
    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'linear-to-brain.md');
    writeFileSync(recipePath, `---
id: linear-to-brain
name: Linear to Brain
version: 1.0.0
description: Linear issues become searchable brain entries
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 20 min
---
This recipe explains how to install a deterministic Linear collector and import
selected issue updates into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = join(repoDir, 'recipes');
    process.chdir(repoDir);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      await runIntegrations(['submit', recipePath, '--json']);
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(true);
      expect(payload.pull_request).toBeUndefined();
      expect(existsSync(join(repoDir, 'recipes', 'linear-to-brain.md'))).toBe(false);
    } finally {
      console.log = originalLog;
      process.chdir(previousCwd);
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit --create-pr copies recipe, commits, and opens a draft PR', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-pr-repo-'));
    const recipesDir = join(repoDir, 'recipes');
    const binDir = join(repoDir, 'bin');
    mkdirSync(recipesDir);
    mkdirSync(binDir);
    mkdirSync(join(repoDir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"mbrain"}');
    writeFileSync(join(repoDir, 'src', 'commands', 'integrations.ts'), '// marker\n');
    const commandLog = join(repoDir, 'commands.log');
    const prBodyLog = join(repoDir, 'pr-body.md');
    writeFileSync(join(binDir, 'git'), `#!/bin/sh
echo "git $*" >> "${commandLog}"
if [ "$1" = "-C" ]; then
  shift 2
fi
case "$1 $2" in
  "status --porcelain") exit 0 ;;
  "rev-parse --show-toplevel") echo "${repoDir}"; exit 0 ;;
  "remote get-url") echo "git@github.com:meghendra6/mbrain.git"; exit 0 ;;
  "rev-parse --verify") exit 1 ;;
  "switch -c") exit 0 ;;
  "add recipes/notion-to-brain.md") exit 0 ;;
  "commit -m") exit 0 ;;
  "push -u") exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${commandLog}"
if [ "$1" = "--version" ]; then
  echo "gh version 2.0.0"
  exit 0
fi
if [ "$1 $2" = "pr create" ]; then
  cat > "${prBodyLog}"
  echo "https://github.com/example/mbrain/pull/123"
  exit 0
fi
exit 0
`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'gh'), 0o755);

    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'notion-to-brain.md');
    writeFileSync(recipePath, `---
id: notion-to-brain
name: Notion to Brain
version: 1.0.0
description: Notion pages become searchable brain entries
category: sense
requires: []
secrets:
  - name: NOTION_TOKEN
    description: Notion integration token
    where: https://www.notion.so/my-integrations
health_checks:
  - type: env_exists
    name: NOTION_TOKEN
setup_time: 20 min
---
This recipe explains how to install a deterministic Notion collector and import
selected pages into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    mkdirSync(join(repoDir, 'docs'));
    process.chdir(join(repoDir, 'docs'));
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      try {
        await runIntegrations(['submit', recipePath, '--create-pr', '--json']);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join('\n')}`);
      }
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(true);
      expect(payload.pull_request).toMatchObject({
        branch: 'mbrain/recipe-notion-to-brain',
        url: 'https://github.com/example/mbrain/pull/123',
        target_path: 'recipes/notion-to-brain.md',
      });
      expect(readFileSync(join(repoDir, 'recipes', 'notion-to-brain.md'), 'utf-8')).toContain('id: notion-to-brain');
      const commands = readFileSync(commandLog, 'utf-8');
      expect(commands).toContain(`git -C ${repoDir} status --porcelain`);
      expect(commands).toContain('git rev-parse --show-toplevel');
      expect(commands).toContain(`git -C ${repoDir} remote get-url origin`);
      expect(commands).toContain(`git -C ${repoDir} switch -c mbrain/recipe-notion-to-brain`);
      expect(commands).toContain(`git -C ${repoDir} add recipes/notion-to-brain.md`);
      expect(commands).toContain(`git -C ${repoDir} commit -m Add notion-to-brain integration recipe`);
      expect(commands).toContain(`git -C ${repoDir} push -u origin mbrain/recipe-notion-to-brain`);
      expect(commands).toContain('gh pr create --repo meghendra6/mbrain --base master --draft --title Add Notion to Brain integration recipe --body-file - --head mbrain/recipe-notion-to-brain');
      const prBody = readFileSync(prBodyLog, 'utf-8');
      expect(prBody).toContain('Adds the `Notion to Brain` integration recipe.');
      expect(prBody).not.toContain(recipePath);
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit --create-pr fails GitHub auth before branch side effects', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-auth-fail-'));
    const recipesDir = join(repoDir, 'recipes');
    const binDir = join(repoDir, 'bin');
    mkdirSync(recipesDir);
    mkdirSync(binDir);
    mkdirSync(join(repoDir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"mbrain"}');
    writeFileSync(join(repoDir, 'src', 'commands', 'integrations.ts'), '// marker\n');
    const commandLog = join(repoDir, 'commands.log');
    writeFileSync(join(binDir, 'git'), `#!/bin/sh
echo "git $*" >> "${commandLog}"
if [ "$1" = "-C" ]; then
  shift 2
fi
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${repoDir}"; exit 0 ;;
  "remote get-url") echo "git@github.com:meghendra6/mbrain.git"; exit 0 ;;
  "status --porcelain") exit 0 ;;
  "rev-parse --verify") exit 1 ;;
  "switch -c") exit 0 ;;
  "add recipes/trello-to-brain.md") exit 0 ;;
  "commit -m") exit 0 ;;
  "push -u") exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${commandLog}"
if [ "$1" = "--version" ]; then
  echo "gh version 2.0.0"
  exit 0
fi
if [ "$1 $2" = "auth status" ]; then
  echo "not logged in" >&2
  exit 1
fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/example/mbrain/pull/127"; exit 0; fi
exit 0
`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'gh'), 0o755);

    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'trello-to-brain.md');
    writeFileSync(recipePath, `---
id: trello-to-brain
name: Trello to Brain
version: 1.0.0
description: Trello cards become searchable brain entries
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 20 min
---
This recipe explains how to install a deterministic Trello collector and import
selected card updates into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.chdir(repoDir);
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--create-pr', '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors.join('\n')).toContain('gh auth status exited with 1');
      expect(existsSync(join(repoDir, 'recipes', 'trello-to-brain.md'))).toBe(false);
      const commands = readFileSync(commandLog, 'utf-8');
      expect(commands).toContain('gh auth status');
      expect(commands).not.toContain(`git -C ${repoDir} status --porcelain`);
      expect(commands).not.toContain(`git -C ${repoDir} switch -c mbrain/recipe-trello-to-brain`);
      expect(commands).not.toContain(`git -C ${repoDir} add recipes/trello-to-brain.md`);
      expect(commands).not.toContain(`git -C ${repoDir} commit -m Add trello-to-brain integration recipe`);
      expect(commands).not.toContain(`git -C ${repoDir} push -u origin mbrain/recipe-trello-to-brain`);
      expect(commands).not.toContain('gh pr create');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit --create-pr can retry an existing matching recipe branch', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-retry-branch-'));
    const recipesDir = join(repoDir, 'recipes');
    const binDir = join(repoDir, 'bin');
    mkdirSync(recipesDir);
    mkdirSync(binDir);
    mkdirSync(join(repoDir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"mbrain"}');
    writeFileSync(join(repoDir, 'src', 'commands', 'integrations.ts'), '// marker\n');
    const recipeContent = `---
id: retry-to-brain
name: Retry to Brain
version: 1.0.0
description: Retryable cards become searchable brain entries
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 20 min
---
This recipe explains how to retry a previously committed recipe branch without
duplicating commits or overwriting existing recipe content.
`;
    const targetPath = join(repoDir, 'recipes', 'retry-to-brain.md');
    const commandLog = join(repoDir, 'commands.log');
    const prBodyLog = join(repoDir, 'pr-body.md');
    writeFileSync(join(binDir, 'git'), `#!/bin/sh
echo "git $*" >> "${commandLog}"
if [ "$1" = "-C" ]; then
  shift 2
fi
if [ "$1 $2 $3 $4" = "status --porcelain -- recipes/retry-to-brain.md" ]; then exit 0; fi
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${repoDir}"; exit 0 ;;
  "remote get-url") echo "git@github.com:meghendra6/mbrain.git"; exit 0 ;;
  "branch --show-current") echo "main"; exit 0 ;;
  "status --porcelain") exit 0 ;;
  "rev-parse --verify") exit 0 ;;
  "switch mbrain/recipe-retry-to-brain") cat > "${targetPath}" <<'EOF_RECIPE'
${recipeContent}EOF_RECIPE
exit 0 ;;
  "add recipes/retry-to-brain.md") exit 0 ;;
  "commit -m") exit 0 ;;
  "push -u") exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${commandLog}"
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1 $2" = "auth status" ]; then exit 0; fi
if [ "$1 $2" = "pr create" ]; then
  cat > "${prBodyLog}"
  echo "https://github.com/example/mbrain/pull/128"
  exit 0
fi
exit 0
`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'gh'), 0o755);

    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'retry-to-brain.md');
    writeFileSync(recipePath, recipeContent);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.chdir(repoDir);
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await runIntegrations(['submit', recipePath, '--create-pr', '--json']);
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(true);
      expect(payload.pull_request).toMatchObject({
        branch: 'mbrain/recipe-retry-to-brain',
        url: 'https://github.com/example/mbrain/pull/128',
        target_path: 'recipes/retry-to-brain.md',
      });
      const commands = readFileSync(commandLog, 'utf-8');
      expect(commands).toContain(`git -C ${repoDir} switch mbrain/recipe-retry-to-brain`);
      expect(commands).toContain(`git -C ${repoDir} status --porcelain -- recipes/retry-to-brain.md`);
      expect(commands).toContain(`git -C ${repoDir} remote get-url origin`);
      expect(commands).toContain(`git -C ${repoDir} push -u origin mbrain/recipe-retry-to-brain`);
      expect(commands).toContain('gh pr create --repo meghendra6/mbrain --base master --draft --title Add Retry to Brain integration recipe --body-file - --head mbrain/recipe-retry-to-brain');
      expect(commands).not.toContain(`git -C ${repoDir} add recipes/retry-to-brain.md`);
      expect(commands).not.toContain(`git -C ${repoDir} commit -m Add retry-to-brain integration recipe`);
      expect(readFileSync(prBodyLog, 'utf-8')).toContain('Adds the `Retry to Brain` integration recipe.');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit --create-pr refuses to run outside an MBrain repository', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-wrong-repo-'));
    const recipesDir = join(repoDir, 'recipes');
    const binDir = join(repoDir, 'bin');
    mkdirSync(recipesDir);
    mkdirSync(binDir);
    writeFileSync(join(repoDir, 'package.json'), '{"name":"not-mbrain"}');
    const commandLog = join(repoDir, 'commands.log');
    writeFileSync(join(binDir, 'git'), `#!/bin/sh
echo "git $*" >> "${commandLog}"
if [ "$1" = "-C" ]; then
  shift 2
fi
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${repoDir}"; exit 0 ;;
  "remote get-url") echo "git@github.com:meghendra6/mbrain.git"; exit 0 ;;
  "status --porcelain") exit 0 ;;
  "rev-parse --verify") exit 1 ;;
  "switch -c") exit 0 ;;
  "add recipes/discord-to-brain.md") exit 0 ;;
  "commit -m") exit 0 ;;
  "push -u") exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${commandLog}"
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/example/mbrain/pull/124"; exit 0; fi
exit 0
`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'gh'), 0o755);

    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'discord-to-brain.md');
    writeFileSync(recipePath, `---
id: discord-to-brain
name: Discord to Brain
version: 1.0.0
description: Discord messages become searchable brain entries
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 20 min
---
This recipe explains how to install a deterministic Discord collector and import
selected messages into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.chdir(repoDir);
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--create-pr', '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors.join('\n')).toContain('MBrain repository');
      expect(existsSync(join(repoDir, 'recipes', 'discord-to-brain.md'))).toBe(false);
      const commands = readFileSync(commandLog, 'utf-8');
      expect(commands).toContain('git rev-parse --show-toplevel');
      expect(commands).not.toContain(`git -C ${repoDir} add recipes/discord-to-brain.md`);
      expect(commands).not.toContain(`git -C ${repoDir} commit -m Add discord-to-brain integration recipe`);
      expect(commands).not.toContain(`git -C ${repoDir} push -u origin mbrain/recipe-discord-to-brain`);
      expect(commands).not.toContain('gh pr create');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit --create-pr refuses to overwrite target files on an existing branch', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-existing-branch-'));
    const recipesDir = join(repoDir, 'recipes');
    const binDir = join(repoDir, 'bin');
    mkdirSync(recipesDir);
    mkdirSync(binDir);
    mkdirSync(join(repoDir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"mbrain"}');
    writeFileSync(join(repoDir, 'src', 'commands', 'integrations.ts'), '// marker\n');
    const targetPath = join(repoDir, 'recipes', 'asana-to-brain.md');
    const commandLog = join(repoDir, 'commands.log');
    writeFileSync(join(binDir, 'git'), `#!/bin/sh
echo "git $*" >> "${commandLog}"
if [ "$1" = "-C" ]; then
  shift 2
fi
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${repoDir}"; exit 0 ;;
  "remote get-url") echo "git@github.com:meghendra6/mbrain.git"; exit 0 ;;
  "branch --show-current") echo "main"; exit 0 ;;
  "status --porcelain") exit 0 ;;
  "rev-parse --verify") exit 0 ;;
  "switch mbrain/recipe-asana-to-brain") echo "existing branch recipe" > "${targetPath}"; exit 0 ;;
  "switch main") exit 0 ;;
  "add recipes/asana-to-brain.md") exit 0 ;;
  "commit -m") exit 0 ;;
  "push -u") exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${commandLog}"
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/example/mbrain/pull/125"; exit 0; fi
exit 0
`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'gh'), 0o755);

    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'asana-to-brain.md');
    writeFileSync(recipePath, `---
id: asana-to-brain
name: Asana to Brain
version: 1.0.0
description: Asana tasks become searchable brain entries
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 20 min
---
This recipe explains how to install a deterministic Asana collector and import
selected task updates into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.chdir(repoDir);
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--create-pr', '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors.join('\n')).toContain('Target path already exists on branch');
      expect(readFileSync(targetPath, 'utf-8')).toBe('existing branch recipe\n');
      const commands = readFileSync(commandLog, 'utf-8');
      expect(commands).toContain(`git -C ${repoDir} switch mbrain/recipe-asana-to-brain`);
      expect(commands).toContain(`git -C ${repoDir} switch main`);
      expect(commands).not.toContain(`git -C ${repoDir} add recipes/asana-to-brain.md`);
      expect(commands).not.toContain(`git -C ${repoDir} commit -m Add asana-to-brain integration recipe`);
      expect(commands).not.toContain(`git -C ${repoDir} push -u origin mbrain/recipe-asana-to-brain`);
      expect(commands).not.toContain('gh pr create');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit --create-pr cleans copied recipes when commit fails', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-commit-fail-'));
    const recipesDir = join(repoDir, 'recipes');
    const binDir = join(repoDir, 'bin');
    mkdirSync(recipesDir);
    mkdirSync(binDir);
    mkdirSync(join(repoDir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"mbrain"}');
    writeFileSync(join(repoDir, 'src', 'commands', 'integrations.ts'), '// marker\n');
    const targetPath = join(repoDir, 'recipes', 'jira-to-brain.md');
    const commandLog = join(repoDir, 'commands.log');
    writeFileSync(join(binDir, 'git'), `#!/bin/sh
echo "git $*" >> "${commandLog}"
if [ "$1" = "-C" ]; then
  shift 2
fi
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${repoDir}"; exit 0 ;;
  "remote get-url") echo "git@github.com:meghendra6/mbrain.git"; exit 0 ;;
  "branch --show-current") echo "main"; exit 0 ;;
  "status --porcelain") exit 0 ;;
  "rev-parse --verify") exit 1 ;;
  "switch -c") exit 0 ;;
  "add recipes/jira-to-brain.md") exit 0 ;;
  "commit -m") echo "missing git identity" >&2; exit 1 ;;
  "rm --cached") exit 0 ;;
  "switch main") exit 0 ;;
  "push -u") exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${commandLog}"
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/example/mbrain/pull/126"; exit 0; fi
exit 0
`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'gh'), 0o755);

    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'jira-to-brain.md');
    writeFileSync(recipePath, `---
id: jira-to-brain
name: Jira to Brain
version: 1.0.0
description: Jira issues become searchable brain entries
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 20 min
---
This recipe explains how to install a deterministic Jira collector and import
selected issue updates into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.chdir(repoDir);
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--create-pr', '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors.join('\n')).toContain('missing git identity');
      expect(existsSync(targetPath)).toBe(false);
      const commands = readFileSync(commandLog, 'utf-8');
      expect(commands).toContain(`git -C ${repoDir} rm --cached --ignore-unmatch recipes/jira-to-brain.md`);
      expect(commands).toContain(`git -C ${repoDir} switch main`);
      expect(commands).not.toContain(`git -C ${repoDir} push -u origin mbrain/recipe-jira-to-brain`);
      expect(commands).not.toContain('gh pr create');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit --create-pr refuses unverified origin before branch side effects', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-wrong-origin-'));
    const recipesDir = join(repoDir, 'recipes');
    const binDir = join(repoDir, 'bin');
    mkdirSync(recipesDir);
    mkdirSync(binDir);
    mkdirSync(join(repoDir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"mbrain"}');
    writeFileSync(join(repoDir, 'src', 'commands', 'integrations.ts'), '// marker\n');
    const commandLog = join(repoDir, 'commands.log');
    writeFileSync(join(binDir, 'git'), `#!/bin/sh
echo "git $*" >> "${commandLog}"
if [ "$1" = "-C" ]; then
  shift 2
fi
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${repoDir}"; exit 0 ;;
  "remote get-url") echo "git@github.com:someone/fork.git"; exit 0 ;;
  "status --porcelain") exit 0 ;;
  "rev-parse --verify") exit 1 ;;
  "switch -c") exit 0 ;;
  "add recipes/github-to-brain.md") exit 0 ;;
  "commit -m") exit 0 ;;
  "push -u") exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${commandLog}"
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1 $2" = "auth status" ]; then exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/example/mbrain/pull/129"; exit 0; fi
exit 0
`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'gh'), 0o755);

    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'github-to-brain.md');
    writeFileSync(recipePath, `---
id: github-to-brain
name: GitHub to Brain
version: 1.0.0
description: GitHub issues become searchable brain entries
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 20 min
---
This recipe explains how to install a deterministic GitHub collector and import
selected issue updates into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.chdir(repoDir);
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--create-pr', '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors.join('\n')).toContain('must run with origin set to meghendra6/mbrain');
      expect(existsSync(join(repoDir, 'recipes', 'github-to-brain.md'))).toBe(false);
      const commands = readFileSync(commandLog, 'utf-8');
      expect(commands).toContain(`git -C ${repoDir} remote get-url origin`);
      expect(commands).not.toContain(`git -C ${repoDir} switch -c mbrain/recipe-github-to-brain`);
      expect(commands).not.toContain(`git -C ${repoDir} push -u origin mbrain/recipe-github-to-brain`);
      expect(commands).not.toContain('gh pr create');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit --create-pr refuses unverified origin push URL before branch side effects', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-wrong-push-origin-'));
    const recipesDir = join(repoDir, 'recipes');
    const binDir = join(repoDir, 'bin');
    mkdirSync(recipesDir);
    mkdirSync(binDir);
    mkdirSync(join(repoDir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"mbrain"}');
    writeFileSync(join(repoDir, 'src', 'commands', 'integrations.ts'), '// marker\n');
    const commandLog = join(repoDir, 'commands.log');
    writeFileSync(join(binDir, 'git'), `#!/bin/sh
echo "git $*" >> "${commandLog}"
if [ "$1" = "-C" ]; then
  shift 2
fi
if [ "$1 $2 $3" = "remote get-url --push" ]; then echo "git@github.com:someone/fork.git"; exit 0; fi
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${repoDir}"; exit 0 ;;
  "remote get-url") echo "git@github.com:meghendra6/mbrain.git"; exit 0 ;;
  "status --porcelain") exit 0 ;;
  "rev-parse --verify") exit 1 ;;
  "switch -c") exit 0 ;;
  "add recipes/slack-to-brain.md") exit 0 ;;
  "commit -m") exit 0 ;;
  "push -u") exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${commandLog}"
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1 $2" = "auth status" ]; then exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/example/mbrain/pull/130"; exit 0; fi
exit 0
`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'gh'), 0o755);

    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'slack-to-brain.md');
    writeFileSync(recipePath, `---
id: slack-to-brain
name: Slack to Brain
version: 1.0.0
description: Slack messages become searchable brain entries
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 20 min
---
This recipe explains how to install a deterministic Slack collector and import
selected message updates into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.chdir(repoDir);
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--create-pr', '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors.join('\n')).toContain('must run with origin push URL set to meghendra6/mbrain');
      expect(existsSync(join(repoDir, 'recipes', 'slack-to-brain.md'))).toBe(false);
      const commands = readFileSync(commandLog, 'utf-8');
      expect(commands).toContain(`git -C ${repoDir} remote get-url origin`);
      expect(commands).toContain(`git -C ${repoDir} remote get-url --push origin`);
      expect(commands).not.toContain(`git -C ${repoDir} switch -c mbrain/recipe-slack-to-brain`);
      expect(commands).not.toContain(`git -C ${repoDir} push -u origin mbrain/recipe-slack-to-brain`);
      expect(commands).not.toContain('gh pr create');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit --create-pr reports branch recovery after push fails', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-push-fail-'));
    const recipesDir = join(repoDir, 'recipes');
    const binDir = join(repoDir, 'bin');
    mkdirSync(recipesDir);
    mkdirSync(binDir);
    mkdirSync(join(repoDir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"mbrain"}');
    writeFileSync(join(repoDir, 'src', 'commands', 'integrations.ts'), '// marker\n');
    const commandLog = join(repoDir, 'commands.log');
    writeFileSync(join(binDir, 'git'), `#!/bin/sh
echo "git $*" >> "${commandLog}"
if [ "$1" = "-C" ]; then
  shift 2
fi
if [ "$1 $2 $3" = "remote get-url --push" ]; then echo "git@github.com:meghendra6/mbrain.git"; exit 0; fi
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${repoDir}"; exit 0 ;;
  "remote get-url") echo "git@github.com:meghendra6/mbrain.git"; exit 0 ;;
  "branch --show-current") echo "main"; exit 0 ;;
  "status --porcelain") exit 0 ;;
  "rev-parse --verify") exit 1 ;;
  "switch -c") exit 0 ;;
  "add recipes/push-fail-to-brain.md") exit 0 ;;
  "commit -m") exit 0 ;;
  "push -u") echo "push failed" >&2; exit 1 ;;
  "switch main") exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${commandLog}"
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1 $2" = "auth status" ]; then exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/example/mbrain/pull/131"; exit 0; fi
exit 0
`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'gh'), 0o755);

    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'push-fail-to-brain.md');
    writeFileSync(recipePath, `---
id: push-fail-to-brain
name: Push Fail to Brain
version: 1.0.0
description: Push failures become searchable brain entries
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 20 min
---
This recipe explains how to install a deterministic push failure collector and
import selected updates into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.chdir(repoDir);
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--create-pr', '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors.join('\n')).toContain('push failed');
      expect(payload.errors.join('\n')).toContain(`git -C ${repoDir} branch -D mbrain/recipe-push-fail-to-brain`);
      const commands = readFileSync(commandLog, 'utf-8');
      expect(commands).toContain(`git -C ${repoDir} switch main`);
      expect(commands).not.toContain('gh pr create');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit --create-pr reports branch recovery after PR creation fails', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'mbrain-submit-pr-fail-'));
    const recipesDir = join(repoDir, 'recipes');
    const binDir = join(repoDir, 'bin');
    mkdirSync(recipesDir);
    mkdirSync(binDir);
    mkdirSync(join(repoDir, 'src', 'commands'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"mbrain"}');
    writeFileSync(join(repoDir, 'src', 'commands', 'integrations.ts'), '// marker\n');
    const commandLog = join(repoDir, 'commands.log');
    writeFileSync(join(binDir, 'git'), `#!/bin/sh
echo "git $*" >> "${commandLog}"
if [ "$1" = "-C" ]; then
  shift 2
fi
case "$1 $2" in
  "rev-parse --show-toplevel") echo "${repoDir}"; exit 0 ;;
  "remote get-url") echo "git@github.com:meghendra6/mbrain.git"; exit 0 ;;
  "branch --show-current") echo "main"; exit 0 ;;
  "status --porcelain") exit 0 ;;
  "rev-parse --verify") exit 1 ;;
  "switch -c") exit 0 ;;
  "add recipes/linear-fail-to-brain.md") exit 0 ;;
  "commit -m") exit 0 ;;
  "push -u") exit 0 ;;
  "switch main") exit 0 ;;
esac
exit 0
`);
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh
echo "gh $*" >> "${commandLog}"
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1 $2" = "auth status" ]; then exit 0; fi
if [ "$1 $2" = "pr create" ]; then echo "PR creation failed" >&2; exit 1; fi
exit 0
`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'gh'), 0o755);

    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'linear-fail-to-brain.md');
    writeFileSync(recipePath, `---
id: linear-fail-to-brain
name: Linear Fail to Brain
version: 1.0.0
description: Linear issues become searchable brain entries
category: sense
requires: []
secrets: []
health_checks: []
setup_time: 20 min
---
This recipe explains how to install a deterministic Linear collector and import
selected issue updates into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    const previousPath = process.env.PATH;
    const previousCwd = process.cwd();
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    process.chdir(repoDir);
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--create-pr', '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors.join('\n')).toContain('PR creation failed');
      expect(payload.errors.join('\n')).toContain(`git -C ${repoDir} branch -D mbrain/recipe-linear-fail-to-brain`);
      const commands = readFileSync(commandLog, 'utf-8');
      expect(commands).toContain(`git -C ${repoDir} switch main`);
      expect(commands).toContain('gh pr create --repo meghendra6/mbrain --base master --draft --title Add Linear Fail to Brain integration recipe --body-file - --head mbrain/recipe-linear-fail-to-brain');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit normalizes user metadata in the generated PR package', async () => {
    const recipesDir = mkdtempSync(join(tmpdir(), 'mbrain-recipes-empty-'));
    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'metadata-safety.md');
    writeFileSync(recipePath, `---
id: metadata-safety
name: |
  Markdown \`Name\`
  ## Injected
version: 1.0.0
description: |
  Slack messages become searchable brain entries.
  ## Injected Section
category: sense
requires: []
secrets: []
health_checks: []
setup_time: |
  20 min
  - [ ] Injected checklist
---
This recipe explains how to install a deterministic collector and import
selected messages into MBrain without relying on unsafe shell execution.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      await runIntegrations(['submit', recipePath, '--json']);
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.contribution_package.pr_title).toBe("Add Markdown 'Name' ## Injected integration recipe");
      expect(payload.contribution_package.pr_body).toContain("Adds the `Markdown 'Name' ## Injected` integration recipe.");
      expect(payload.contribution_package.pr_body).toContain('- Setup time: 20 min - [ ] Injected checklist');
      expect(payload.contribution_package.pr_body).toContain('- Description: Slack messages become searchable brain entries. ## Injected Section');
      expect(payload.contribution_package.pr_title).not.toContain('\n');
      expect(payload.contribution_package.pr_body).not.toContain('\n## Injected');
      expect(payload.contribution_package.pr_body).not.toContain('\n- [ ] Injected checklist');
    } finally {
      console.log = originalLog;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit rejects recipe ids that already exist', async () => {
    const recipesDir = mkdtempSync(join(tmpdir(), 'mbrain-recipes-existing-'));
    writeFileSync(join(recipesDir, 'duplicate-recipe.md'), `---
id: duplicate-recipe
name: Existing Duplicate
version: 1.0.0
description: Already bundled recipe
category: sense
requires: []
secrets: []
setup_time: 5 min
---
Existing bundled recipe body with enough text to satisfy validation.
`);
    const submitDir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(submitDir, 'duplicate-recipe.md');
    writeFileSync(recipePath, `---
id: duplicate-recipe
name: Duplicate Recipe
version: 1.0.0
description: New duplicate recipe
category: sense
requires: []
secrets: []
setup_time: 5 min
---
Submitted recipe body with enough text to satisfy validation.
`);

    const previousRecipesDir = process.env.MBRAIN_RECIPES_DIR;
    process.env.MBRAIN_RECIPES_DIR = recipesDir;
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath])).rejects.toThrow('EXIT:1');
      expect(logs.join('\n')).toContain('Recipe id already exists: duplicate-recipe');
      expect(errors.join('\n')).toBe('');
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
      if (previousRecipesDir === undefined) {
        delete process.env.MBRAIN_RECIPES_DIR;
      } else {
        process.env.MBRAIN_RECIPES_DIR = previousRecipesDir;
      }
    }
  });

  test('integrations submit rejects unsafe recipe ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(dir, 'unsafe.md');
    writeFileSync(recipePath, `---
id: ../unsafe
name: Unsafe Recipe
version: 1.0.0
description: Should not produce an unsafe target path
category: sense
requires: []
secrets: []
setup_time: 5 min
---
Submitted recipe body with enough text to satisfy validation.
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
      await expect(runIntegrations(['submit', recipePath])).rejects.toThrow('EXIT:1');
      expect(logs.join('\n')).toContain("Invalid id: '../unsafe' (use lowercase letters, numbers, hyphens, and at most 64 characters)");
      expect(errors.join('\n')).toBe('');
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
    }
  });

  test('integrations submit rejects legacy shell health checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(dir, 'legacy-health.md');
    writeFileSync(recipePath, `---
id: legacy-health
name: Legacy Health
version: 1.0.0
description: Should reject shell health checks
category: sense
requires: []
secrets: []
health_checks:
  - "echo unsafe"
setup_time: 5 min
---
Submitted recipe body with enough text to satisfy validation.
`);

    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors).toContain('health_checks[0] must be a typed object, not a shell command string');
      expect(payload.contribution_package).toBeUndefined();
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }
  });

  test('integrations submit rejects non-PR-ready metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(dir, 'bad-metadata.md');
    writeFileSync(recipePath, `---
id: bad-metadata
name: Bad Metadata
version: 1
description: Should reject invalid version and unknown dependencies
category: sense
requires: [missing-dependency]
secrets: []
setup_time: 5 min
---
Submitted recipe body with enough text to satisfy validation.
`);

    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors).toContain("Invalid version: '1' (must be semver like 1.0.0)");
      expect(payload.errors).toContain('Requires unknown recipe: missing-dependency');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }
  });

  test('integrations submit caps recipe id length', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const longId = 'a'.repeat(65);
    const recipePath = join(dir, 'long-id.md');
    writeFileSync(recipePath, `---
id: ${longId}
name: Long ID
version: 1.0.0
description: Should reject oversized ids before they reach filenames or branch names
category: sense
requires: []
secrets: []
setup_time: 5 min
---
Submitted recipe body with enough text to satisfy validation.
`);

    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors).toContain(
        `Invalid id: '${longId}' (use lowercase letters, numbers, hyphens, and at most 64 characters)`,
      );
      expect(payload.target_path).toBeNull();
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }
  });

  test('integrations submit makes omitted requires guidance actionable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(dir, 'missing-requires.md');
    writeFileSync(recipePath, `---
id: missing-requires
name: Missing Requires
version: 1.0.0
description: Should explain how dependency-free recipes declare requires
category: sense
secrets: []
setup_time: 5 min
---
Submitted recipe body with enough text to satisfy validation.
`);

    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.errors).toContain('Missing: requires (add requires: [] when the recipe has no dependencies)');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }
  });

  test('integrations submit reports non-string metadata without crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-submit-'));
    const recipePath = join(dir, 'bad-name.md');
    writeFileSync(recipePath, `---
id: bad-name
name: 123
version: 1.0.0
description: Should reject invalid metadata without crashing
category: sense
requires: []
secrets: []
setup_time: 5 min
---
Submitted recipe body with enough text to satisfy validation.
`);

    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['submit', recipePath, '--json'])).rejects.toThrow('EXIT:1');
      const payload = JSON.parse(logs.join('\n'));
      expect(payload.ok).toBe(false);
      expect(payload.pr_title).toBeNull();
      expect(payload.contribution_package).toBeUndefined();
      expect(payload.errors).toContain("Invalid name: '123'");
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }
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

  test('integrations test remains lenient about recipe version formatting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-test-'));
    const recipePath = join(dir, 'numeric-version.md');
    writeFileSync(recipePath, `---
id: numeric-version
name: Numeric Version
version: 1
description: Existing test command remains a lightweight validator
category: sense
requires: []
secrets: []
---
This recipe body is long enough for the lightweight test command to accept it.
`);

    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await runIntegrations(['test', recipePath]);
      expect(logs.join('\n')).toContain('PASS: numeric-version v1');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }
  });

  test('integrations test rejects malformed secrets shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-test-'));
    const recipePath = join(dir, 'bad-secrets.md');
    writeFileSync(recipePath, `---
id: bad-secrets
name: Bad Secrets
version: 1.0.0
description: Malformed secrets should not be accepted silently
category: sense
requires: []
secrets: NOT_AN_ARRAY
---
This recipe body is long enough for the lightweight test command to inspect it.
`);

    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['test', recipePath])).rejects.toThrow('EXIT:1');
      expect(logs.join('\n')).toContain('secrets must be an array');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }
  });

  test('integrations test rejects malformed requires shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-recipe-test-'));
    const recipePath = join(dir, 'bad-requires.md');
    writeFileSync(recipePath, `---
id: bad-requires
name: Bad Requires
version: 1.0.0
description: Malformed requires should not be accepted silently
category: sense
requires: credential-gateway
secrets: []
---
This recipe body is long enough for the lightweight test command to inspect it.
`);

    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
    try {
      await expect(runIntegrations(['test', recipePath])).rejects.toThrow('EXIT:1');
      expect(logs.join('\n')).toContain('requires must be an array of recipe ids');
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
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
  test('bundles always-on infra recipes for Fly.io and Railway webhook hosting', () => {
    const { readFileSync } = require('fs');
    const hostingRecipes = [
      { file: 'fly-app-hosting.md', id: 'fly-app-hosting' },
      { file: 'railway-app-hosting.md', id: 'railway-app-hosting' },
    ];

    for (const { file, id } of hostingRecipes) {
      const content = readFileSync(new URL(`../recipes/${file}`, import.meta.url), 'utf-8');
      const recipe = parseRecipe(content, file);
      expect(recipe).not.toBeNull();
      expect(recipe!.validation_errors).toEqual([]);
      expect(recipe!.frontmatter.id).toBe(id);
      expect(recipe!.frontmatter.category).toBe('infra');
      expect(recipe!.frontmatter.requires).toEqual([]);
      expect(recipe!.frontmatter.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(recipe!.frontmatter.health_checks.map((check) => check.type)).not.toContain('url_responds');
      expect(recipe!.body).toContain('Bring your own HTTP service');
      expect(recipe!.body).toContain('does not turn stdio MCP into HTTP');
      expect(recipe!.body).toContain('Do not paste raw logs');
      expect(recipe!.body).toContain('redact tokens');
      expect(recipe!.body).toContain('local paths');
      expect(recipe!.body).toContain('single-quote literal secret values that contain spaces or shell metacharacters');
    }
  });

  test('Railway hosting recipe avoids stale Nixpacks-only builder guidance', () => {
    const { readFileSync } = require('fs');
    const content = readFileSync(new URL('../recipes/railway-app-hosting.md', import.meta.url), 'utf-8');
    const recipe = parseRecipe(content, 'railway-app-hosting.md');

    expect(recipe).not.toBeNull();
    expect(recipe!.body).toContain('Railpack-compatible project');
    expect(recipe!.body).not.toContain('Nixpacks-compatible');
  });

  test('integration docs list the always-on hosting recipes', () => {
    const { readFileSync } = require('fs');
    const docs = readFileSync(new URL('../docs/integrations/README.md', import.meta.url), 'utf-8');

    expect(docs).toContain('[fly-app-hosting](../../recipes/fly-app-hosting.md)');
    expect(docs).toContain('[railway-app-hosting](../../recipes/railway-app-hosting.md)');
    expect(docs).toContain('Always-on public hosting for webhook and collector services');
  });

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
