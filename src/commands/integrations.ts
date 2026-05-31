/**
 * mbrain integrations — standalone CLI command for recipe discovery and health.
 *
 * NOT an operation (no database connection needed).
 * Reads embedded recipe files and heartbeat JSONL from ~/.mbrain/integrations/.
 *
 * ARCHITECTURE:
 *   recipes/*.md (embedded at build time)
 *     │
 *     ├── list    → parse frontmatter, check env vars, show status
 *     ├── show    → display recipe details + body
 *     ├── status  → check secrets + heartbeat
 *     ├── doctor  → run health_checks
 *     ├── stats   → aggregate heartbeat JSONL
 *     ├── test    → validate recipe file
 *     ├── submit  → preflight a community recipe contribution
 *     └── (bare)  → dashboard view
 *
 *   ~/.mbrain/integrations/<id>/heartbeat.jsonl
 *     └── append-only, pruned to 30 days on read
 */

import matter from 'gray-matter';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

// --- Types ---

interface RecipeSecret {
  name: string;
  description: string;
  where: string;
}

interface RecipeFrontmatter {
  id: string;
  name: string;
  version: string;
  description: string;
  category: 'infra' | 'sense' | 'reflex';
  requires: string[];
  secrets: RecipeSecret[];
  health_checks: RecipeHealthCheck[];
  setup_time: string;
  cost_estimate?: string;
}

interface ParsedRecipe {
  frontmatter: RecipeFrontmatter;
  raw_frontmatter: Record<string, unknown>;
  body: string;
  filename: string;
  validation_errors: string[];
}

interface HeartbeatEntry {
  ts: string;
  event: string;
  source_version?: string;
  status: string;
  details?: Record<string, unknown>;
  error?: string;
}

export type RecipeHealthCheck =
  | { type: 'env_exists'; name: string; label?: string }
  | { type: 'env_any_exists'; names: string[]; label?: string }
  | { type: 'url_responds'; url: string; label?: string; timeout_ms?: number }
  | { type: 'heartbeat_fresh'; max_age: string; label?: string };

interface CheckResult {
  integration: string;
  check: string;
  status: 'ok' | 'fail' | 'timeout';
  output: string;
}

interface RecipeValidationResult {
  errors: string[];
  warnings: string[];
}

interface RecipeSubmissionResult extends RecipeValidationResult {
  ok: boolean;
  id: string | null;
  target_path: string | null;
  pr_title: string | null;
  checklist: string[];
  next_steps: string[];
  contribution_package?: RecipeContributionPackage;
  pull_request?: RecipePullRequest;
}

interface RecipeContributionPackage {
  target_path: string;
  pr_title: string;
  pr_body: string;
  files_to_include: string[];
  review_checklist: string[];
}

interface RecipePullRequest {
  branch: string;
  url: string;
  target_path: string;
}

const RECIPE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_RECIPE_ID_LENGTH = 64;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const MBRAIN_GITHUB_REPO = 'meghendra6/mbrain';
const MBRAIN_ORIGIN_URLS = new Set([
  'git@github.com:meghendra6/mbrain.git',
  'https://github.com/meghendra6/mbrain.git',
  'https://github.com/meghendra6/mbrain',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasFrontmatterValue(raw: Record<string, unknown>, field: string): boolean {
  return raw[field] !== undefined && raw[field] !== null && raw[field] !== '';
}

function isRecipeId(value: string): boolean {
  return value.length <= MAX_RECIPE_ID_LENGTH && RECIPE_ID_PATTERN.test(value);
}

function normalizeLoopbackHttpUrl(value: string): { url: string | null; error: string | null } {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { url: null, error: 'must use http or https' };
    }
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1';
    } else if (parsed.hostname !== '127.0.0.1') {
      return { url: null, error: 'must target localhost or 127.0.0.1' };
    }
    return { url: parsed.toString(), error: null };
  } catch {
    return { url: null, error: 'must be a valid URL' };
  }
}

function normalizeHealthChecks(raw: unknown): { checks: RecipeHealthCheck[]; errors: string[] } {
  if (raw === undefined || raw === null) return { checks: [], errors: [] };
  if (!Array.isArray(raw)) {
    return { checks: [], errors: ['health_checks must be an array of typed objects'] };
  }

  const checks: RecipeHealthCheck[] = [];
  const errors: string[] = [];

  raw.forEach((entry, index) => {
    if (typeof entry === 'string') {
      errors.push(`health_checks[${index}] must be a typed object, not a shell command string`);
      return;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`health_checks[${index}] must be a typed object`);
      return;
    }

    const value = entry as Record<string, unknown>;
    const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim() : undefined;
    switch (value.type) {
      case 'env_exists': {
        if (typeof value.name !== 'string' || !value.name.trim()) {
          errors.push(`health_checks[${index}].name is required for env_exists`);
          return;
        }
        checks.push({ type: 'env_exists', name: value.name.trim(), ...(label ? { label } : {}) });
        return;
      }
      case 'env_any_exists': {
        if (!Array.isArray(value.names) || value.names.length === 0 || value.names.some((name) => typeof name !== 'string' || !name.trim())) {
          errors.push(`health_checks[${index}].names must be a non-empty string array for env_any_exists`);
          return;
        }
        checks.push({ type: 'env_any_exists', names: value.names.map((name) => String(name).trim()), ...(label ? { label } : {}) });
        return;
      }
      case 'url_responds': {
        if (typeof value.url !== 'string' || !value.url.trim()) {
          errors.push(`health_checks[${index}].url is required for url_responds`);
          return;
        }
        const normalizedUrl = normalizeLoopbackHttpUrl(value.url);
        if (normalizedUrl.error) {
          errors.push(`health_checks[${index}].url ${normalizedUrl.error}`);
          return;
        }
        const timeoutMs = value.timeout_ms;
        if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000)) {
          errors.push(`health_checks[${index}].timeout_ms must be an integer between 1 and 10000`);
          return;
        }
        checks.push({
          type: 'url_responds',
          url: normalizedUrl.url!,
          ...(label ? { label } : {}),
          ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
        });
        return;
      }
      case 'heartbeat_fresh': {
        if (typeof value.max_age !== 'string' || !value.max_age.trim()) {
          errors.push(`health_checks[${index}].max_age is required for heartbeat_fresh`);
          return;
        }
        if (parseDurationMs(value.max_age.trim()) === null) {
          errors.push(`health_checks[${index}].max_age must use a duration like 30s, 5m, 24h, or 7d`);
          return;
        }
        checks.push({ type: 'heartbeat_fresh', max_age: value.max_age.trim(), ...(label ? { label } : {}) });
        return;
      }
      default:
        errors.push(`health_checks[${index}].type must be env_exists, env_any_exists, url_responds, or heartbeat_fresh`);
    }
  });

  return { checks, errors };
}

// --- Recipe Parsing ---

/**
 * Parse a recipe markdown file. Uses gray-matter directly (NOT parseMarkdown,
 * which splits on --- as timeline separator and would corrupt recipe bodies
 * that use horizontal rules).
 */
export function parseRecipe(content: string, filename: string): ParsedRecipe | null {
  try {
    const { data, content: body } = matter(content);
    if (!data.id) return null;
    const healthChecks = normalizeHealthChecks(data.health_checks);
    return {
      frontmatter: {
        id: data.id,
        name: data.name || data.id,
        version: data.version || '0.0.0',
        description: data.description || '',
        category: data.category || 'sense',
        requires: Array.isArray(data.requires) ? data.requires : [],
        secrets: Array.isArray(data.secrets) ? data.secrets : [],
        health_checks: healthChecks.checks,
        setup_time: data.setup_time || 'unknown',
        cost_estimate: data.cost_estimate,
      },
      raw_frontmatter: data as Record<string, unknown>,
      body: body.trim(),
      filename,
      validation_errors: healthChecks.errors,
    };
  } catch {
    return null;
  }
}

// --- Embedded Recipes ---

// Recipes are loaded from the recipes/ directory at runtime.
// For compiled binaries, these should be embedded at build time.
// For source installs (bun run), they're read from disk.
function getRecipesDir(): string {
  // Explicit override (for compiled binaries or custom installs)
  if (process.env.MBRAIN_RECIPES_DIR && existsSync(process.env.MBRAIN_RECIPES_DIR)) {
    return process.env.MBRAIN_RECIPES_DIR;
  }
  // Try relative to this file (source install via bun)
  const sourceDir = join(import.meta.dir, '../../recipes');
  if (existsSync(sourceDir)) return sourceDir;
  // Try relative to CWD (development)
  const cwdDir = join(process.cwd(), 'recipes');
  if (existsSync(cwdDir)) return cwdDir;
  // Try global install path (bun add -g)
  const globalDir = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'mbrain', 'recipes');
  if (existsSync(globalDir)) return globalDir;
  return '';
}

function loadAllRecipes(): ParsedRecipe[] {
  const dir = getRecipesDir();
  if (!dir || !existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  const recipes: ParsedRecipe[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const recipe = parseRecipe(content, file);
      if (recipe) {
        recipes.push(recipe);
      } else {
        console.error(`Warning: skipping ${file} (invalid or missing 'id' in frontmatter)`);
      }
    } catch {
      console.error(`Warning: skipping ${file} (unreadable)`);
    }
  }

  return recipes;
}

function findRecipe(id: string): ParsedRecipe | null {
  const recipes = loadAllRecipes();
  const exact = recipes.find(r => r.frontmatter.id === id);
  if (exact) return exact;

  // Fuzzy: check if id is a substring match
  const partial = recipes.filter(r =>
    r.frontmatter.id.includes(id) || r.frontmatter.name.toLowerCase().includes(id.toLowerCase())
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    console.error(`Recipe '${id}' not found. Did you mean one of these?`);
    for (const r of partial) {
      console.error(`  ${r.frontmatter.id} — ${r.frontmatter.description}`);
    }
    return null;
  }

  console.error(`Recipe '${id}' not found.`);
  const all = recipes.map(r => r.frontmatter.id);
  if (all.length > 0) {
    console.error(`Available recipes: ${all.join(', ')}`);
  }
  return null;
}

// --- Heartbeat ---

function heartbeatDir(id: string): string {
  return join(homedir(), '.mbrain', 'integrations', id);
}

function heartbeatPath(id: string): string {
  return join(heartbeatDir(id), 'heartbeat.jsonl');
}

function readHeartbeat(id: string): HeartbeatEntry[] {
  const path = heartbeatPath(id);
  if (!existsSync(path)) return [];

  try {
    const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim());
    const entries: HeartbeatEntry[] = [];
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HeartbeatEntry;
        if (new Date(entry.ts).getTime() >= thirtyDaysAgo) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Prune old entries on read
    if (entries.length < lines.length) {
      try {
        mkdirSync(heartbeatDir(id), { recursive: true });
        writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
      } catch {
        // Non-fatal: pruning failed
      }
    }

    return entries;
  } catch {
    return [];
  }
}

// --- Secret Checking ---

function checkSecrets(secrets: RecipeSecret[]): { set: string[]; missing: RecipeSecret[] } {
  const set: string[] = [];
  const missing: RecipeSecret[] = [];
  for (const s of secrets) {
    if (process.env[s.name]) {
      set.push(s.name);
    } else {
      missing.push(s);
    }
  }
  return { set, missing };
}

type IntegrationStatus = 'available' | 'configured' | 'active';

function getStatus(recipe: ParsedRecipe): IntegrationStatus {
  const { missing } = checkSecrets(recipe.frontmatter.secrets);
  // All required secrets must be set to be "configured"
  if (missing.length > 0) return 'available';

  const heartbeat = readHeartbeat(recipe.frontmatter.id);
  const recentEvents = heartbeat.filter(e =>
    Date.now() - new Date(e.ts).getTime() < 24 * 60 * 60 * 1000
  );
  if (recentEvents.length > 0) return 'active';

  return 'configured';
}

// --- Dependency Resolution ---

function checkDependencies(recipe: ParsedRecipe, allRecipes: ParsedRecipe[]): string[] {
  const warnings: string[] = [];
  const visited = new Set<string>();

  function check(id: string, chain: string[]): void {
    if (visited.has(id)) return;
    if (chain.includes(id)) {
      warnings.push(`Circular dependency: ${chain.join(' -> ')} -> ${id}`);
      return;
    }
    visited.add(id);

    const r = allRecipes.find(r => r.frontmatter.id === id);
    if (!r && id !== recipe.frontmatter.id) {
      warnings.push(`${recipe.frontmatter.id} requires '${id}' (not found)`);
      return;
    }
    if (r) {
      for (const dep of r.frontmatter.requires) {
        check(dep, [...chain, id]);
      }
    }
  }

  for (const dep of recipe.frontmatter.requires) {
    check(dep, [recipe.frontmatter.id]);
  }

  return warnings;
}

function recipeTargetPath(id: string): string {
  return `recipes/${id}.md`;
}

function uniqueHealthCheckTypes(checks: RecipeHealthCheck[]): string[] {
  return Array.from(new Set(checks.map(check => check.type))).sort();
}

function normalizeSubmissionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/`/g, "'");
}

function formatInlineCodeValue(value: string): string {
  return `\`${normalizeSubmissionText(value)}\``;
}

function formatInlineCodeList(values: string[]): string {
  return values.length > 0 ? values.map(formatInlineCodeValue).join(', ') : 'None';
}

function buildContributionPackage(recipe: ParsedRecipe, targetPath: string, prTitle: string): RecipeContributionPackage {
  const f = recipe.frontmatter;
  const name = normalizeSubmissionText(f.name);
  const description = normalizeSubmissionText(f.description);
  const setupTime = normalizeSubmissionText(f.setup_time);
  const secretNames = f.secrets.map(secret => normalizeSubmissionText(secret.name));
  const healthCheckTypes = uniqueHealthCheckTypes(f.health_checks);
  const reviewChecklist = [
    'Recipe frontmatter passes mbrain integrations submit',
    'Recipe uses the constrained health_checks DSL; submit validates the DSL but does not execute checks',
    'No secret values, setup logs, or local machine paths are included',
    'docs/integrations/README.md is updated if this should appear in the public recipe table',
  ];

  const prBody = [
    '## Summary',
    '',
    `Adds the \`${name}\` integration recipe.`,
    '',
    '## Recipe',
    '',
    `- ID: ${formatInlineCodeValue(f.id)}`,
    `- Target path: ${formatInlineCodeValue(targetPath)}`,
    `- Category: ${formatInlineCodeValue(f.category)}`,
    `- Version: ${formatInlineCodeValue(f.version)}`,
    `- Setup time: ${setupTime}`,
    `- Description: ${description}`,
    `- Requires: ${formatInlineCodeList(f.requires)}`,
    `- Secret names: ${formatInlineCodeList(secretNames)}`,
    `- Health check types: ${formatInlineCodeList(healthCheckTypes)}`,
    '',
    '## Preflight',
    '',
    reviewChecklist.map(item => `- [ ] ${item}`).join('\n'),
  ].join('\n');

  return {
    target_path: targetPath,
    pr_title: prTitle,
    pr_body: prBody,
    files_to_include: [targetPath],
    review_checklist: reviewChecklist,
  };
}

function validateRecipe(recipe: ParsedRecipe, allRecipes: ParsedRecipe[], strictSubmission = false): RecipeValidationResult {
  const errors: string[] = [...recipe.validation_errors];
  const warnings: string[] = [];
  const f = recipe.frontmatter;
  const raw = recipe.raw_frontmatter;

  if (!strictSubmission) {
    if (!f.id) errors.push('Missing: id');
    if (!f.name) warnings.push('Missing: name (will default to id)');
    if (!f.description) warnings.push('Missing: description');
    if (!f.version) warnings.push('Missing: version');
    if (!['infra', 'sense', 'reflex'].includes(f.category)) {
      errors.push(`Invalid category: '${f.category}' (must be 'infra', 'sense', or 'reflex')`);
    }

    if (raw.requires !== undefined && !Array.isArray(raw.requires)) {
      errors.push('requires must be an array of recipe ids');
    }

    if (raw.secrets !== undefined && !Array.isArray(raw.secrets)) {
      errors.push('secrets must be an array');
    } else if (Array.isArray(raw.secrets)) {
      for (const secret of raw.secrets) {
        if (!secret || typeof secret !== 'object' || Array.isArray(secret)) {
          errors.push('Secret missing name');
          continue;
        }
        const value = secret as Record<string, unknown>;
        const name = isNonEmptyString(value.name) ? value.name : undefined;
        if (!name) errors.push('Secret missing name');
        if (!isNonEmptyString(value.where)) warnings.push(`Secret '${name}' missing 'where' URL`);
      }
    }

    if (f.requires.length > 0) {
      warnings.push(...checkDependencies(recipe, allRecipes));
    }

    if (!recipe.body || recipe.body.length < 50) {
      warnings.push('Recipe body is very short (< 50 chars). Is the setup guide complete?');
    }

    return { errors, warnings };
  }

  const addMissing = (field: string) => {
    errors.push(`Missing: ${field}`);
  };

  if (!hasFrontmatterValue(raw, 'id')) {
    errors.push('Missing: id');
  } else if (!isNonEmptyString(raw.id) || (strictSubmission && !isRecipeId(raw.id.trim()))) {
    errors.push(`Invalid id: '${raw.id}' (use lowercase letters, numbers, hyphens, and at most ${MAX_RECIPE_ID_LENGTH} characters)`);
  }

  if (!hasFrontmatterValue(raw, 'name')) {
    addMissing('name');
  } else if (!isNonEmptyString(raw.name)) {
    errors.push(`Invalid name: '${raw.name}'`);
  }

  if (!hasFrontmatterValue(raw, 'description')) {
    addMissing('description');
  } else if (!isNonEmptyString(raw.description)) {
    errors.push(`Invalid description: '${raw.description}'`);
  }

  if (!hasFrontmatterValue(raw, 'version')) {
    addMissing('version');
  } else if (!isNonEmptyString(raw.version) || !SEMVER_PATTERN.test(raw.version.trim())) {
    errors.push(`Invalid version: '${raw.version}' (must be semver like 1.0.0)`);
  }

  if (!hasFrontmatterValue(raw, 'category')) {
    addMissing('category');
  } else if (!isNonEmptyString(raw.category) || !['infra', 'sense', 'reflex'].includes(raw.category.trim())) {
    errors.push(`Invalid category: '${raw.category}' (must be 'infra', 'sense', or 'reflex')`);
  }

  if (!hasFrontmatterValue(raw, 'setup_time')) {
    addMissing('setup_time');
  } else if (!isNonEmptyString(raw.setup_time)) {
    errors.push(`Invalid setup_time: '${raw.setup_time}'`);
  }

  if (raw.requires !== undefined && !Array.isArray(raw.requires)) {
    errors.push('requires must be an array of recipe ids');
  } else if (Array.isArray(raw.requires)) {
    raw.requires.forEach((dep, index) => {
      if (!isNonEmptyString(dep)) {
        errors.push(`requires[${index}] must be a recipe id string`);
      } else if (!isRecipeId(dep.trim())) {
        errors.push(`requires[${index}] has invalid recipe id '${dep}'`);
      }
    });
  } else {
    errors.push('Missing: requires (add requires: [] when the recipe has no dependencies)');
  }

  if (raw.secrets !== undefined && !Array.isArray(raw.secrets)) {
    errors.push('secrets must be an array');
  } else if (Array.isArray(raw.secrets)) {
    raw.secrets.forEach((secret, index) => {
      if (!secret || typeof secret !== 'object' || Array.isArray(secret)) {
        errors.push(`secrets[${index}] must be an object`);
        return;
      }
      const value = secret as Record<string, unknown>;
      if (!isNonEmptyString(value.name)) errors.push(`secrets[${index}].name is required`);
      if (!isNonEmptyString(value.description)) errors.push(`secrets[${index}].description is required`);
      if (!isNonEmptyString(value.where)) {
        errors.push(`secrets[${index}].where is required`);
      }
    });
  } else {
    errors.push('Missing: secrets');
  }

  if (f.requires.length > 0) {
    for (const dep of f.requires) {
      if (dep === f.id) {
        errors.push(`requires cannot include the recipe itself: ${dep}`);
      } else if (!allRecipes.some(r => r.frontmatter.id === dep)) {
        errors.push(`Requires unknown recipe: ${dep}`);
      }
    }
  }

  if (!recipe.body || recipe.body.length < 50) {
    const message = 'Recipe body is very short (< 50 chars). Is the setup guide complete?';
    errors.push(message);
  }

  return { errors, warnings };
}

function buildRecipeSubmission(recipe: ParsedRecipe): RecipeSubmissionResult {
  const allRecipes = loadAllRecipes();
  const validation = validateRecipe(recipe, allRecipes, true);
  const id = isNonEmptyString(recipe.raw_frontmatter.id) ? recipe.raw_frontmatter.id.trim() : null;
  const safeId = id && isRecipeId(id);
  const targetPath = safeId ? recipeTargetPath(id) : null;
  const errors = [...validation.errors];

  if (safeId) {
    if (allRecipes.some(r => r.frontmatter.id === id)) {
      errors.push(`Recipe id already exists: ${id}`);
    }

    const recipesDir = getRecipesDir();
    if (recipesDir && existsSync(join(recipesDir, `${id}.md`))) {
      errors.push(`Target path already exists: ${recipeTargetPath(id)}`);
    }
  }

  const rawName = recipe.raw_frontmatter.name;
  const safeName = isNonEmptyString(rawName) ? normalizeSubmissionText(rawName) : null;
  const prTitle = safeId && safeName ? `Add ${safeName} integration recipe` : null;
  const checklist = targetPath ? [
    `Copy the recipe to ${targetPath}`,
    'Use contribution_package.pr_body as the PR body',
    'Update docs/integrations/README.md if this should appear in the public recipe table',
    'Run bun test test/integrations.test.ts',
    'Open a PR with the generated title and sanitized PR body',
  ] : [];
  const contributionPackage = errors.length === 0 && targetPath && prTitle
    ? buildContributionPackage(recipe, targetPath, prTitle)
    : undefined;

  return {
    ok: errors.length === 0,
    id,
    target_path: targetPath,
    pr_title: prTitle,
    errors,
    warnings: validation.warnings,
    checklist,
    next_steps: checklist,
    ...(contributionPackage ? { contribution_package: contributionPackage } : {}),
  };
}

function runSubmitCommand(command: string, args: string[], input?: string): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf-8',
      env: process.env,
      input,
      stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer | string; message?: string };
    const stderr = failure.stderr ? String(failure.stderr).trim() : '';
    const status = failure.status !== undefined ? ` exited with ${failure.status}` : ' failed';
    throw new Error(`${command} ${args.join(' ')}${status}${stderr ? `: ${stderr}` : failure.message ? `: ${failure.message}` : ''}`);
  }
}

function runSubmitGit(repoRoot: string, args: string[]): string {
  return runSubmitCommand('git', ['-C', repoRoot, ...args]);
}

function assertCanonicalMbrainOrigin(repoRoot: string): void {
  const originUrl = runSubmitGit(repoRoot, ['remote', 'get-url', 'origin']).trim();
  if (!MBRAIN_ORIGIN_URLS.has(originUrl)) {
    throw new Error(
      `mbrain integrations submit --create-pr must run with origin set to ${MBRAIN_GITHUB_REPO}; found ${originUrl || '(empty)'}`,
    );
  }

  const originPushUrl = runSubmitGit(repoRoot, ['remote', 'get-url', '--push', 'origin']).trim();
  if (!MBRAIN_ORIGIN_URLS.has(originPushUrl)) {
    throw new Error(
      `mbrain integrations submit --create-pr must run with origin push URL set to ${MBRAIN_GITHUB_REPO}; found ${originPushUrl || '(empty)'}`,
    );
  }
}

function getMbrainRepoRootForRecipePr(): string {
  const repoRoot = resolve(runSubmitCommand('git', ['rev-parse', '--show-toplevel']).trim());
  const packagePath = join(repoRoot, 'package.json');
  const integrationsSourcePath = join(repoRoot, 'src', 'commands', 'integrations.ts');
  const recipesPath = join(repoRoot, 'recipes');

  if (!existsSync(packagePath) || !existsSync(integrationsSourcePath) || !existsSync(recipesPath)) {
    throw new Error('mbrain integrations submit --create-pr must run from an MBrain repository clone');
  }

  try {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as { name?: unknown };
    if (pkg.name !== 'mbrain') {
      throw new Error('package name mismatch');
    }
  } catch {
    throw new Error('mbrain integrations submit --create-pr must run from an MBrain repository clone');
  }

  return repoRoot;
}

function createRecipePullRequest(recipeContent: string, result: RecipeSubmissionResult): RecipePullRequest {
  if (!result.ok || !result.id || !result.target_path || !result.pr_title || !result.contribution_package) {
    throw new Error('Recipe submission is not PR-ready');
  }

  const repoRoot = getMbrainRepoRootForRecipePr();
  runSubmitCommand('gh', ['--version']);
  runSubmitCommand('gh', ['auth', 'status']);
  assertCanonicalMbrainOrigin(repoRoot);

  const cleanStatus = runSubmitGit(repoRoot, ['status', '--porcelain']).trim();
  if (cleanStatus) {
    throw new Error('git status --porcelain reported uncommitted changes; commit or stash them before creating a recipe PR');
  }

  const originalBranch = runSubmitGit(repoRoot, ['branch', '--show-current']).trim();
  const branch = `mbrain/recipe-${result.id}`;
  const targetPath = result.target_path;
  const targetAbsPath = resolve(repoRoot, targetPath);
  if (!targetAbsPath.startsWith(`${repoRoot}/`)) {
    throw new Error(`Target path escapes the repository: ${targetPath}`);
  }
  let recipeWritten = false;
  let commitCreated = false;
  let branchExists = true;
  try {
    runSubmitGit(repoRoot, ['rev-parse', '--verify', branch]);
  } catch {
    branchExists = false;
  }

  try {
    if (branchExists) {
      runSubmitGit(repoRoot, ['switch', branch]);
    } else {
      runSubmitGit(repoRoot, ['switch', '-c', branch]);
    }

    if (existsSync(targetAbsPath)) {
      const existingRecipe = readFileSync(targetAbsPath, 'utf-8');
      if (existingRecipe !== recipeContent) {
        throw new Error(`Target path already exists on branch: ${targetPath}`);
      }
      const targetStatus = runSubmitGit(repoRoot, ['status', '--porcelain', '--', targetPath]).trim();
      if (targetStatus) {
        runSubmitGit(repoRoot, ['add', targetPath]);
        runSubmitGit(repoRoot, ['commit', '-m', `Add ${result.id} integration recipe`]);
        commitCreated = true;
      }
    } else {
      mkdirSync(join(repoRoot, 'recipes'), { recursive: true });
      writeFileSync(targetAbsPath, recipeContent);
      recipeWritten = true;
      runSubmitGit(repoRoot, ['add', targetPath]);
      runSubmitGit(repoRoot, ['commit', '-m', `Add ${result.id} integration recipe`]);
      commitCreated = true;
    }

    runSubmitGit(repoRoot, ['push', '-u', 'origin', branch]);
    const prUrl = runSubmitCommand('gh', [
      'pr',
      'create',
      '--repo',
      MBRAIN_GITHUB_REPO,
      '--base',
      'master',
      '--draft',
      '--title',
      result.pr_title,
      '--body-file',
      '-',
      '--head',
      branch,
    ], result.contribution_package.pr_body).trim();

    return { branch, url: prUrl, target_path: targetPath };
  } catch (error) {
    let recoveryHint = '';
    if (recipeWritten && !commitCreated) {
      try {
        runSubmitGit(repoRoot, ['rm', '--cached', '--ignore-unmatch', targetPath]);
      } catch {
        // Best-effort cleanup only; preserve the original failure below.
      }
      try {
        if (existsSync(targetAbsPath)) unlinkSync(targetAbsPath);
      } catch {
        // Best-effort cleanup only; preserve the original failure below.
      }
    }
    if (originalBranch && originalBranch !== branch) {
      try {
        runSubmitGit(repoRoot, ['switch', originalBranch]);
      } catch {
        // Preserve the original failure; the user can recover with git switch.
      }
    }
    if (commitCreated) {
      recoveryHint = ` Recovery: inspect the orphan branch with git -C ${repoRoot} log -1 ${branch}; delete it with git -C ${repoRoot} branch -D ${branch} if you do not need the commit.`;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}${recoveryHint}`);
  }
}

function printSubmissionResult(result: RecipeSubmissionResult, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.errors.length > 0) {
    console.log('FAIL:');
    for (const error of result.errors) console.log(`  ✗ ${error}`);
  }
  if (result.warnings.length > 0) {
    console.log('WARNINGS:');
    for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
  }
  if (result.ok) {
    console.log(`READY: ${result.id} can be submitted as ${result.target_path}`);
    if (result.pr_title) console.log(`PR title: ${result.pr_title}`);
    if (result.contribution_package) {
      console.log('\nPR body:');
      console.log(result.contribution_package.pr_body);
    }
    if (result.pull_request) {
      console.log(`\nCreated draft PR: ${result.pull_request.url}`);
    }
    console.log('\nChecklist:');
    for (const step of result.checklist) console.log(`  - ${step}`);
  }
}

function parseDurationMs(value: string): number | null {
  const match = value.trim().match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;
  switch (unit) {
    case 's': return amount * 1000;
    case 'm': return amount * 60 * 1000;
    case 'h': return amount * 60 * 60 * 1000;
    case 'd': return amount * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

function healthCheckLabel(check: RecipeHealthCheck): string {
  if (check.label) return check.label;
  switch (check.type) {
    case 'env_exists': return check.name;
    case 'env_any_exists': return check.names.join(' or ');
    case 'url_responds': return check.url;
    case 'heartbeat_fresh': return 'Heartbeat';
  }
}

export async function runRecipeHealthCheck(integration: string, check: RecipeHealthCheck): Promise<CheckResult> {
  const label = healthCheckLabel(check);

  switch (check.type) {
    case 'env_exists':
      if (process.env[check.name]) {
        return { integration, check: label, status: 'ok', output: `${label}: OK` };
      }
      return { integration, check: label, status: 'fail', output: `${label}: missing ${check.name}` };

    case 'env_any_exists': {
      const present = check.names.find((name) => process.env[name]);
      if (present) {
        return { integration, check: label, status: 'ok', output: `${label}: OK` };
      }
      return {
        integration,
        check: label,
        status: 'fail',
        output: `${label}: missing one of ${check.names.join(', ')}`,
      };
    }

    case 'url_responds': {
      const normalizedUrl = normalizeLoopbackHttpUrl(check.url);
      if (normalizedUrl.error) {
        return { integration, check: label, status: 'fail', output: `${label}: URL ${normalizedUrl.error}` };
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), check.timeout_ms ?? 10_000);
      try {
        const response = await fetch(normalizedUrl.url!, { signal: controller.signal, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400) {
          return { integration, check: label, status: 'fail', output: `${label}: redirects are not followed` };
        }
        if (response.ok) {
          return { integration, check: label, status: 'ok', output: `${label}: OK` };
        }
        return { integration, check: label, status: 'fail', output: `${label}: HTTP ${response.status}` };
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'AbortError';
        return {
          integration,
          check: label,
          status: timedOut ? 'timeout' : 'fail',
          output: `${label}: ${timedOut ? 'timeout' : error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    case 'heartbeat_fresh': {
      const maxAgeMs = parseDurationMs(check.max_age);
      if (maxAgeMs === null) {
        return { integration, check: label, status: 'fail', output: `${label}: invalid max_age ${check.max_age}` };
      }

      const entries = readHeartbeat(integration);
      const latest = entries
        .map((entry) => new Date(entry.ts).getTime())
        .filter((ts) => Number.isFinite(ts))
        .sort((a, b) => b - a)[0];
      if (!latest) {
        return { integration, check: label, status: 'fail', output: `${label}: no heartbeat data` };
      }
      const ageMs = Date.now() - latest;
      if (ageMs <= maxAgeMs) {
        return { integration, check: label, status: 'ok', output: `${label}: OK` };
      }
      return { integration, check: label, status: 'fail', output: `${label}: stale` };
    }
  }
}

// --- Subcommands ---

function cmdList(args: string[]): void {
  const jsonMode = args.includes('--json');
  const recipes = loadAllRecipes();

  if (recipes.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ senses: [], reflexes: [] }));
    } else {
      console.log('No integrations available.');
    }
    return;
  }

  const infra = recipes.filter(r => r.frontmatter.category === 'infra');
  const senses = recipes.filter(r => r.frontmatter.category === 'sense');
  const reflexes = recipes.filter(r => r.frontmatter.category === 'reflex');

  if (jsonMode) {
    const toJson = (r: ParsedRecipe) => ({
      id: r.frontmatter.id,
      name: r.frontmatter.name,
      version: r.frontmatter.version,
      description: r.frontmatter.description,
      category: r.frontmatter.category,
      status: getStatus(r),
      setup_time: r.frontmatter.setup_time,
      requires: r.frontmatter.requires,
    });
    console.log(JSON.stringify({
      infra: infra.map(toJson),
      senses: senses.map(toJson),
      reflexes: reflexes.map(toJson),
    }, null, 2));
    return;
  }

  const printSection = (title: string, items: ParsedRecipe[]) => {
    if (items.length === 0) return;
    console.log(`\n  ${title}`);
    console.log('  ' + '-'.repeat(62));
    for (const r of items) {
      const status = getStatus(r);
      const statusStr = status === 'active' ? 'ACTIVE' : status === 'configured' ? 'CONFIGURED' : 'AVAILABLE';
      const id = r.frontmatter.id.padEnd(22);
      const desc = r.frontmatter.description.slice(0, 28).padEnd(28);
      const deps = r.frontmatter.requires.length > 0 ? ` (needs ${r.frontmatter.requires.join(', ')})` : '';
      console.log(`  ${id}${desc}  ${statusStr}${deps}`);
    }
  };

  // Dashboard view
  printSection('INFRASTRUCTURE (set up first)', infra);
  printSection('SENSES (data inputs)', senses);
  printSection('REFLEXES (automated responses)', reflexes);

  // Stats summary
  const allHeartbeats = recipes.flatMap(r => readHeartbeat(r.frontmatter.id));
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekEvents = allHeartbeats.filter(e => new Date(e.ts).getTime() >= weekAgo);
  if (weekEvents.length > 0) {
    console.log(`\n  This week: ${weekEvents.length} events logged.`);
  }

  console.log("\n  Run 'mbrain integrations show <id>' for setup details.");
  console.log('');
}

function cmdShow(args: string[]): void {
  const id = args.find(a => !a.startsWith('-'));
  if (!id) {
    console.error('Usage: mbrain integrations show <recipe-id>');
    return;
  }

  const recipe = findRecipe(id);
  if (!recipe) return;

  const f = recipe.frontmatter;
  console.log(`\n${f.name} (${f.id} v${f.version})`);
  console.log(`${f.description}\n`);
  console.log(`Category:   ${f.category}`);
  console.log(`Setup time: ${f.setup_time}`);
  if (f.cost_estimate) console.log(`Cost:       ${f.cost_estimate}`);
  if (f.requires.length > 0) console.log(`Requires:   ${f.requires.join(', ')}`);

  console.log('\nSecrets needed:');
  for (const s of f.secrets) {
    const isSet = process.env[s.name] ? '  [set]' : '  [missing]';
    console.log(`  ${s.name}${isSet}`);
    console.log(`    ${s.description}`);
    console.log(`    Get it: ${s.where}`);
  }

  if (f.health_checks.length > 0) {
    console.log(`\nHealth checks: ${f.health_checks.length} configured`);
  }

  console.log('\n--- Recipe Body ---\n');
  console.log(recipe.body);
}

function cmdStatus(args: string[]): void {
  const jsonMode = args.includes('--json');
  const id = args.find(a => !a.startsWith('-'));
  if (!id) {
    console.error('Usage: mbrain integrations status <recipe-id>');
    return;
  }

  const recipe = findRecipe(id);
  if (!recipe) return;

  const { set, missing } = checkSecrets(recipe.frontmatter.secrets);
  const heartbeat = readHeartbeat(recipe.frontmatter.id);
  const status = getStatus(recipe);

  if (jsonMode) {
    console.log(JSON.stringify({
      id: recipe.frontmatter.id,
      status,
      secrets: { set, missing: missing.map(m => ({ name: m.name, where: m.where })) },
      heartbeat: {
        total_events: heartbeat.length,
        last_event: heartbeat.length > 0 ? heartbeat[heartbeat.length - 1] : null,
      },
    }, null, 2));
    return;
  }

  console.log(`\n${recipe.frontmatter.name}: ${status.toUpperCase()}`);

  if (set.length > 0) {
    console.log('\nSecrets configured:');
    for (const s of set) console.log(`  ${s}  [set]`);
  }

  if (missing.length > 0) {
    console.log('\nMissing secrets:');
    for (const m of missing) {
      console.log(`  ${m.name}  [missing]`);
      console.log(`    Get it: ${m.where}`);
    }
  }

  if (heartbeat.length > 0) {
    const last = heartbeat[heartbeat.length - 1];
    const lastDate = new Date(last.ts);
    const ageMs = Date.now() - lastDate.getTime();
    const ageHours = Math.floor(ageMs / (60 * 60 * 1000));

    console.log(`\nLast event: ${last.event} (${ageHours}h ago)`);

    if (ageMs > 24 * 60 * 60 * 1000) {
      console.log(`  WARNING: no events in ${Math.floor(ageMs / (24 * 60 * 60 * 1000))} days`);
      console.log('  Check: is ngrok running? Is the voice server alive?');
      console.log('  Run: mbrain integrations doctor');
    }
  } else {
    console.log('\nNo heartbeat data yet.');
  }
  console.log('');
}

async function cmdDoctor(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const recipes = loadAllRecipes();
  const configured = recipes.filter(r => getStatus(r) !== 'available');

  if (configured.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ checks: [], overall: 'no_integrations' }));
    } else {
      console.log('No configured integrations to check.');
    }
    return;
  }

  const results: CheckResult[] = [];

  for (const recipe of configured) {
    for (const error of recipe.validation_errors) {
      results.push({
        integration: recipe.frontmatter.id,
        check: 'recipe validation',
        status: 'fail',
        output: error,
      });
    }
    for (const check of recipe.frontmatter.health_checks) {
      results.push(await runRecipeHealthCheck(recipe.frontmatter.id, check));
    }
  }

  if (jsonMode) {
    const fails = results.filter(r => r.status !== 'ok');
    console.log(JSON.stringify({
      checks: results,
      overall: fails.length === 0 ? 'ok' : 'issues_found',
    }, null, 2));
    return;
  }

  for (const recipe of configured) {
    const checks = results.filter(r => r.integration === recipe.frontmatter.id);
    const allOk = checks.every(c => c.status === 'ok');
    console.log(`  ${recipe.frontmatter.id}: ${allOk ? 'OK' : 'ISSUES'}`);
    for (const c of checks) {
      const icon = c.status === 'ok' ? '  ✓' : c.status === 'timeout' ? '  ⏱' : '  ✗';
      console.log(`${icon} ${c.output}`);
    }
  }

  const totalFails = results.filter(r => r.status !== 'ok').length;
  console.log(`\n  OVERALL: ${totalFails === 0 ? 'All checks passed' : `${totalFails} issue(s) found`}`);
}

function cmdStats(args: string[]): void {
  const jsonMode = args.includes('--json');
  const recipes = loadAllRecipes();

  const allEntries: (HeartbeatEntry & { integration: string })[] = [];
  for (const r of recipes) {
    const entries = readHeartbeat(r.frontmatter.id);
    for (const e of entries) {
      allEntries.push({ ...e, integration: r.frontmatter.id });
    }
  }

  if (allEntries.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ total_events: 0, message: 'No stats yet' }));
    } else {
      console.log('No stats yet. Set up an integration and start using it.');
    }
    return;
  }

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekEntries = allEntries.filter(e => new Date(e.ts).getTime() >= weekAgo);

  // Count by integration
  const bySense: Record<string, number> = {};
  for (const e of weekEntries) {
    bySense[e.integration] = (bySense[e.integration] || 0) + 1;
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      total_events: allEntries.length,
      week_events: weekEntries.length,
      by_integration: bySense,
    }, null, 2));
    return;
  }

  console.log(`\n  This week: ${weekEntries.length} events`);
  const sorted = Object.entries(bySense).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    const pct = Math.round((count / weekEntries.length) * 100);
    console.log(`    ${name}: ${count} (${pct}%)`);
  }
  console.log(`\n  All time: ${allEntries.length} events`);
  console.log('');
}

function cmdTest(args: string[]): void {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) {
    console.error('Usage: mbrain integrations test <recipe-file.md>');
    return;
  }

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf-8');
  const recipe = parseRecipe(content, basename(filePath));

  if (!recipe) {
    console.error('FAIL: Could not parse recipe. Missing or invalid YAML frontmatter.');
    console.error('Required field: id');
    process.exit(1);
  }

  const { errors, warnings } = validateRecipe(recipe, loadAllRecipes(), false);
  const f = recipe.frontmatter;

  // Report
  if (errors.length > 0) {
    console.log('FAIL:');
    for (const e of errors) console.log(`  ✗ ${e}`);
  }
  if (warnings.length > 0) {
    console.log('WARNINGS:');
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
  if (errors.length === 0 && warnings.length === 0) {
    console.log(`PASS: ${f.id} v${f.version} — ${f.description}`);
  }

  if (errors.length > 0) process.exit(1);
}

function cmdSubmit(args: string[]): void {
  const jsonMode = args.includes('--json');
  const createPr = args.includes('--create-pr');
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) {
    const result: RecipeSubmissionResult = {
      ok: false,
      id: null,
      target_path: null,
      pr_title: null,
      errors: ['Usage: mbrain integrations submit <recipe-file.md> [--json] [--create-pr]'],
      warnings: [],
      checklist: [],
      next_steps: [],
    };
    printSubmissionResult(result, jsonMode);
    process.exit(1);
  }

  if (!existsSync(filePath)) {
    const result: RecipeSubmissionResult = {
      ok: false,
      id: null,
      target_path: null,
      pr_title: null,
      errors: [`File not found: ${filePath}`],
      warnings: [],
      checklist: [],
      next_steps: [],
    };
    printSubmissionResult(result, jsonMode);
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf-8');
  const recipe = parseRecipe(content, basename(filePath));
  if (!recipe) {
    const result: RecipeSubmissionResult = {
      ok: false,
      id: null,
      target_path: null,
      pr_title: null,
      errors: ['Could not parse recipe. Missing or invalid YAML frontmatter.', 'Required field: id'],
      warnings: [],
      checklist: [],
      next_steps: [],
    };
    printSubmissionResult(result, jsonMode);
    process.exit(1);
  }

  const result = buildRecipeSubmission(recipe);
  if (createPr && result.ok) {
    try {
      result.pull_request = createRecipePullRequest(content, result);
    } catch (error) {
      result.ok = false;
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  printSubmissionResult(result, jsonMode);
  if (!result.ok) process.exit(1);
}

function printHelp(): void {
  console.log(`mbrain integrations — manage integration recipes

USAGE
  mbrain integrations                  Show integration dashboard
  mbrain integrations list [--json]    List available integrations
  mbrain integrations show <id>        Show recipe details
  mbrain integrations status <id>      Check secrets + health
  mbrain integrations doctor [--json]  Run health checks
  mbrain integrations stats [--json]   Show signal statistics
  mbrain integrations test <file>      Validate a recipe file
  mbrain integrations submit <file>    Preflight a community recipe PR
  mbrain integrations submit <file> --create-pr
                                      Copy the recipe and open a draft PR
`);
}

// --- Main Entry ---

export async function runIntegrations(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    if (!sub) {
      // Bare command: show dashboard
      cmdList([]);
    } else {
      printHelp();
    }
    return;
  }

  const subArgs = args.slice(1);

  switch (sub) {
    case 'list':
      cmdList(subArgs);
      break;
    case 'show':
      cmdShow(subArgs);
      break;
    case 'status':
      cmdStatus(subArgs);
      break;
    case 'doctor':
      await cmdDoctor(subArgs);
      break;
    case 'stats':
      cmdStats(subArgs);
      break;
    case 'test':
      cmdTest(subArgs);
      break;
    case 'submit':
      cmdSubmit(subArgs);
      break;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printHelp();
      process.exit(1);
  }
}
