/**
 * gbrain integrations — standalone CLI command for recipe discovery and health.
 *
 * NOT an operation (no database connection needed).
 * Reads embedded recipe files and heartbeat JSONL from ~/.gbrain/integrations/.
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
 *     └── (bare)  → dashboard view
 *
 *   ~/.gbrain/integrations/<id>/heartbeat.jsonl
 *     └── append-only, pruned to 30 days on read
 */

import matter from 'gray-matter';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { gbrainPath } from '../core/config.ts';
import { execSync } from 'child_process';

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
  health_checks: HealthCheck[];
  setup_time: string;
  cost_estimate?: string;
}

interface ParsedRecipe {
  frontmatter: RecipeFrontmatter;
  body: string;
  filename: string;
  embedded: boolean;
}

interface HeartbeatEntry {
  ts: string;
  event: string;
  source_version?: string;
  status: string;
  details?: Record<string, unknown>;
  error?: string;
}

// --- Health Check DSL Types ---

interface HttpCheck {
  type: 'http';
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  auth?: 'basic' | 'bearer';
  auth_user?: string;
  auth_pass?: string;
  auth_token?: string;
  label?: string;
}

interface EnvExistsCheck {
  type: 'env_exists';
  name: string;
  label?: string;
}

interface CommandCheck {
  type: 'command';
  argv: string[];
  label?: string;
}

interface AnyOfCheck {
  type: 'any_of';
  label?: string;
  checks: HealthCheck[];
}

type HealthCheck = string | HttpCheck | EnvExistsCheck | CommandCheck | AnyOfCheck;

interface CheckResult {
  integration: string;
  check: string;
  status: 'ok' | 'fail' | 'timeout' | 'blocked';
  output: string;
}

/**
 * Returns true if a string health_check contains shell metacharacters.
 * Only applied to user-created (non-embedded) recipes.
 */
export function isUnsafeHealthCheck(check: string): boolean {
  return /[;&|`$(){}\\<>\n]/.test(check);
}

/** Expand $VAR references with process.env values */
export function expandVars(s: string): string {
  return s.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] || '');
}

// --- SSRF Protection ---

/** Parse an IPv4 octet from decimal, hex (0x prefix), or octal (leading 0) notation. */
export function parseOctet(s: string): number {
  if (s.length === 0) return NaN;
  if (s.startsWith('0x') || s.startsWith('0X')) {
    if (!/^0[xX][0-9a-fA-F]+$/.test(s)) return NaN;
    return parseInt(s, 16);
  }
  if (s.length > 1 && s.startsWith('0')) {
    if (!/^0[0-7]+$/.test(s)) return NaN;
    return parseInt(s, 8);
  }
  if (!/^\d+$/.test(s)) return NaN;
  return parseInt(s, 10);
}

/**
 * Convert an IPv4 hostname to 4 octets. Handles bypass encodings:
 *   - Dotted decimal: 127.0.0.1
 *   - Single decimal: 2130706433 (= 0x7f000001)
 *   - Hex: 0x7f000001
 *   - Per-octet hex/octal: 0x7f.0.0.1, 0177.0.0.1
 * Returns null for non-IP hostnames (fall through to hostname-based checks).
 */
export function hostnameToOctets(hostname: string): number[] | null {
  // Single integer form
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFFFF) {
      return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    }
    return null;
  }
  // Hex integer form (0x prefix, no dots)
  if (/^0[xX][0-9a-fA-F]+$/.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFFFF) {
      return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    }
    return null;
  }
  // Dotted notation with possible octal/hex per octet
  const parts = hostname.split('.');
  if (parts.length === 4) {
    const octets = parts.map(parseOctet);
    if (octets.every(o => Number.isFinite(o) && o >= 0 && o <= 255)) return octets;
  }
  return null;
}

/** Classify an IPv4 address as internal/private/reserved. */
export function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 127) return true;              // 127.0.0.0/8 loopback
  if (a === 10) return true;               // 10.0.0.0/8 RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. AWS metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 0) return true;                // 0.0.0.0/8 unspecified
  return false;
}

/** Returns true if the URL targets an internal/metadata endpoint or uses a non-http(s) scheme. Fail-closed on parse errors. */
export function isInternalUrl(urlStr: string): boolean {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return true; // malformed → block
  }
  // B4: scheme allowlist — block file:, data:, blob:, ftp:, gopher:, javascript:, etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;

  let host = url.hostname.toLowerCase();

  // Block known metadata hostnames
  const metadataHostnames = new Set([
    'metadata.google.internal',
    'metadata.google',
    'metadata',
    'instance-data',
    'instance-data.ec2.internal',
  ]);
  if (metadataHostnames.has(host)) return true;

  // localhost aliases
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // Strip IPv6 brackets if present (WHATWG URL returns hostname with brackets for IPv6)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // IPv6 loopback (and any all-zeros form that resolves to loopback-adjacent)
  if (host === '::1' || host === '::') return true;

  // Handle IPv4-mapped IPv6. WHATWG URL canonicalizes `::ffff:127.0.0.1` to `::ffff:7f00:1`
  // (two hex hextets), so we must parse hex hextets back to IPv4 octets.
  if (host.startsWith('::ffff:')) {
    const tail = host.slice(7);
    // Mixed form: ::ffff:A.B.C.D (if parser preserved dotted notation)
    const dotted = hostnameToOctets(tail);
    if (dotted && isPrivateIpv4(dotted)) return true;
    // Hex-compressed form: ::ffff:XXXX:YYYY → two 16-bit hextets
    const hextets = tail.split(':');
    if (hextets.length === 2 && hextets.every(h => /^[0-9a-f]{1,4}$/.test(h))) {
      const hi = parseInt(hextets[0], 16);
      const lo = parseInt(hextets[1], 16);
      const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
      if (isPrivateIpv4(octets)) return true;
    }
  }

  // IPv4 range check (handles hex, octal, single decimal bypass forms)
  const octets = hostnameToOctets(host);
  if (octets && isPrivateIpv4(octets)) return true;

  // Trailing dot on numeric-looking hostname — strip and re-check
  if (host.endsWith('.')) {
    const stripped = host.slice(0, -1);
    const strippedOctets = hostnameToOctets(stripped);
    if (strippedOctets && isPrivateIpv4(strippedOctets)) return true;
  }

  return false;
}

export async function executeHealthCheck(
  check: HealthCheck,
  integrationId: string,
  isEmbedded: boolean,
): Promise<CheckResult> {
  const label = typeof check === 'string' ? check : (check as any).label || JSON.stringify(check);
  const base = { integration: integrationId, check: label };

  // String health checks (deprecated path)
  if (typeof check === 'string') {
    // B2: Hard-block string health_checks for non-embedded recipes. User-provided
    // recipes must use the typed DSL; string health_checks are a known exec/SSRF bypass.
    if (!isEmbedded) {
      return { ...base, status: 'blocked', output: 'Blocked: string health_checks are restricted to embedded recipes. Migrate to typed health_check DSL (http, command, env_exists, any_of).' };
    }
    // Defense-in-depth for embedded recipes: still reject obviously dangerous shell metachars.
    if (isUnsafeHealthCheck(check)) {
      return { ...base, status: 'blocked', output: 'Blocked: contains unsafe shell characters. Migrate to typed health_check DSL.' };
    }
    try {
      const output = execSync(check, { timeout: 10000, encoding: 'utf-8', env: process.env }).trim();
      return { ...base, status: output.includes('FAIL') ? 'fail' : 'ok', output };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ...base, status: msg.includes('TIMEDOUT') ? 'timeout' : 'fail', output: msg };
    }
  }

  // Typed DSL checks
  switch (check.type) {
    case 'http': {
      // Fix 4: gate http health_checks on embedded trust. User-provided recipes
      // must NOT be able to make arbitrary outbound HTTP (SSRF / internal reconnaissance).
      if (!isEmbedded) {
        return { ...base, status: 'blocked', output: `Blocked: http health_checks are restricted to embedded recipes. (${check.label || check.url})` };
      }
      try {
        const url = expandVars(check.url);
        if (!url || url.includes('undefined')) {
          return { ...base, status: 'fail', output: `Missing env var in URL: ${check.url}` };
        }
        // B4: scheme allowlist. B3: manual redirect with per-hop re-validation.
        if (isInternalUrl(url)) {
          return { ...base, status: 'blocked', output: `Blocked: URL targets internal/private network or uses non-http(s) scheme: ${check.url}` };
        }
        const headers: Record<string, string> = {};
        if (check.headers) {
          for (const [k, v] of Object.entries(check.headers)) {
            headers[k] = expandVars(v);
          }
        }
        if (check.auth === 'basic' && check.auth_user && check.auth_pass) {
          const user = expandVars(check.auth_user);
          const pass = expandVars(check.auth_pass);
          headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
        } else if (check.auth === 'bearer' && check.auth_token) {
          headers['Authorization'] = 'Bearer ' + expandVars(check.auth_token);
        }
        const method = check.method || 'GET';
        const body = check.body ? expandVars(check.body) : undefined;
        if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

        // B3: manual redirect handling. Follow up to 3 hops, re-validating each Location.
        const MAX_REDIRECTS = 3;
        let currentUrl = url;
        let resp: Response | null = null;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const fetchOpts: RequestInit = {
            method,
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(10000),
          };
          if (body) fetchOpts.body = body;
          resp = await fetch(currentUrl, fetchOpts);
          if (resp.status < 300 || resp.status >= 400) break; // terminal
          const location = resp.headers.get('location');
          if (!location) break;
          // Resolve relative redirects against the current URL
          let next: string;
          try {
            next = new URL(location, currentUrl).toString();
          } catch {
            return { ...base, status: 'blocked', output: `Blocked: malformed redirect Location header from ${currentUrl}` };
          }
          if (isInternalUrl(next)) {
            return { ...base, status: 'blocked', output: `Blocked: redirect hop ${hop + 1} targets internal URL: ${next}` };
          }
          if (hop === MAX_REDIRECTS) {
            return { ...base, status: 'fail', output: `${check.label || 'HTTP'}: exceeded ${MAX_REDIRECTS} redirect hops` };
          }
          currentUrl = next;
        }
        if (!resp) {
          return { ...base, status: 'fail', output: `${check.label || 'HTTP'}: no response` };
        }
        const ok = resp.status >= 200 && resp.status < 400;
        return { ...base, status: ok ? 'ok' : 'fail', output: `${check.label || 'HTTP'}: ${ok ? 'OK' : `HTTP ${resp.status}`}` };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('TimeoutError') || msg.includes('abort')) {
          return { ...base, status: 'timeout', output: `${check.label || 'HTTP'}: timeout` };
        }
        return { ...base, status: 'fail', output: `${check.label || 'HTTP'}: ${msg}` };
      }
    }

    case 'env_exists': {
      const val = process.env[check.name];
      return {
        ...base,
        status: val ? 'ok' : 'fail',
        output: `${check.label || check.name}: ${val ? 'set' : 'NOT SET'}`,
      };
    }

    case 'command': {
      // Fix 2: Gate command execution on embedded trust. Non-embedded recipes
      // (from $GBRAIN_RECIPES_DIR or ./recipes) must NOT be able to spawn arbitrary binaries.
      if (!isEmbedded) {
        return { ...base, status: 'blocked', output: `Blocked: command health_checks are restricted to embedded recipes. (${check.argv[0]})` };
      }
      try {
        const { spawnSync } = await import('child_process');
        const result = spawnSync(check.argv[0], check.argv.slice(1), {
          timeout: 10000,
          encoding: 'utf-8',
          env: process.env,
        });
        const ok = result.status === 0;
        const output = (result.stdout || '').trim() || (ok ? 'OK' : 'FAIL');
        return { ...base, status: ok ? 'ok' : 'fail', output: `${check.label || check.argv[0]}: ${output}` };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ...base, status: 'fail', output: `${check.label || check.argv[0]}: ${msg}` };
      }
    }

    case 'any_of': {
      for (const sub of check.checks) {
        const result = await executeHealthCheck(sub, integrationId, isEmbedded);
        if (result.status === 'ok') {
          return { ...base, status: 'ok', output: `${check.label || 'any_of'}: ${result.output}` };
        }
      }
      return { ...base, status: 'fail', output: `${check.label || 'any_of'}: all checks failed` };
    }

    default:
      return { ...base, status: 'fail', output: `Unknown check type: ${(check as any).type}` };
  }
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
    return {
      frontmatter: {
        id: data.id,
        name: data.name || data.id,
        version: data.version || '0.0.0',
        description: data.description || '',
        category: data.category || 'sense',
        requires: data.requires || [],
        secrets: data.secrets || [],
        health_checks: (data.health_checks || []) as HealthCheck[],
        setup_time: data.setup_time || 'unknown',
        cost_estimate: data.cost_estimate,
      },
      body: body.trim(),
      filename,
      embedded: false,
    };
  } catch {
    return null;
  }
}

// --- Embedded Recipes ---

// Recipes are loaded from multiple tiers with an explicit trust boundary:
//   TRUSTED (embedded=true):  package-bundled recipes shipped with gbrain
//     - source install: ../../recipes relative to this file
//     - global install: ~/.bun/install/global/node_modules/gbrain/recipes
//   UNTRUSTED (embedded=false): user-provided recipes discovered at runtime
//     - $GBRAIN_RECIPES_DIR
//     - ./recipes in process cwd
// The trust flag gates command/http health_checks and deprecated string health_checks.
// An attacker who drops a malicious recipe in ./recipes/ MUST NOT get embedded=true.
export function getRecipeDirs(): Array<{ dir: string; trusted: boolean }> {
  const dirs: Array<{ dir: string; trusted: boolean }> = [];
  const sourceDir = join(import.meta.dir, '../../recipes');
  if (existsSync(sourceDir)) dirs.push({ dir: sourceDir, trusted: true });
  const globalDir = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain', 'recipes');
  if (existsSync(globalDir)) dirs.push({ dir: globalDir, trusted: true });
  if (process.env.GBRAIN_RECIPES_DIR && existsSync(process.env.GBRAIN_RECIPES_DIR)) {
    dirs.push({ dir: process.env.GBRAIN_RECIPES_DIR, trusted: false });
  }
  const cwdDir = join(process.cwd(), 'recipes');
  if (existsSync(cwdDir)) dirs.push({ dir: cwdDir, trusted: false });
  return dirs;
}

function loadAllRecipes(): ParsedRecipe[] {
  const dirs = getRecipeDirs();
  const recipes: ParsedRecipe[] = [];
  const seen = new Set<string>();

  for (const { dir, trusted } of dirs) {
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      if (seen.has(file)) continue;
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const recipe = parseRecipe(content, file);
        if (recipe) {
          recipe.embedded = trusted;
          recipes.push(recipe);
          seen.add(file);
        } else {
          console.error(`Warning: skipping ${file} (invalid or missing 'id' in frontmatter)`);
        }
      } catch {
        console.error(`Warning: skipping ${file} (unreadable)`);
      }
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
  return gbrainPath('integrations', id);
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
  const { set, missing } = checkSecrets(recipe.frontmatter.secrets);
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

  console.log("\n  Run 'gbrain integrations show <id>' for setup details.");
  console.log('');
}

function cmdShow(args: string[]): void {
  const id = args.find(a => !a.startsWith('-'));
  if (!id) {
    console.error('Usage: gbrain integrations show <recipe-id>');
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
    console.error('Usage: gbrain integrations status <recipe-id>');
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
      console.log('  Run: gbrain integrations doctor');
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
    for (const check of recipe.frontmatter.health_checks) {
      const result = await executeHealthCheck(check, recipe.frontmatter.id, recipe.embedded);
      results.push(result);
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
      const icon = c.status === 'ok' ? '  \u2713' : c.status === 'timeout' ? '  \u23F1' : '  \u2717';
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
    console.error('Usage: gbrain integrations test <recipe-file.md>');
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

  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate required fields
  const f = recipe.frontmatter;
  if (!f.id) errors.push('Missing: id');
  if (!f.name) warnings.push('Missing: name (will default to id)');
  if (!f.description) warnings.push('Missing: description');
  if (!f.version) warnings.push('Missing: version');
  if (!['sense', 'reflex'].includes(f.category)) {
    errors.push(`Invalid category: '${f.category}' (must be 'sense' or 'reflex')`);
  }

  // Check secrets format
  for (const s of f.secrets) {
    if (!s.name) errors.push('Secret missing name');
    if (!s.where) warnings.push(`Secret '${s.name}' missing 'where' URL`);
  }

  // Check dependencies
  if (f.requires.length > 0) {
    const allRecipes = loadAllRecipes();
    const depWarnings = checkDependencies(recipe, allRecipes);
    warnings.push(...depWarnings);
  }

  // Check body isn't empty
  if (!recipe.body || recipe.body.length < 50) {
    warnings.push('Recipe body is very short (< 50 chars). Is the setup guide complete?');
  }

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

function printHelp(): void {
  console.log(`gbrain integrations — manage integration recipes

USAGE
  gbrain integrations                  Show integration dashboard
  gbrain integrations list [--json]    List available integrations
  gbrain integrations show <id>        Show recipe details
  gbrain integrations status <id>      Check secrets + health
  gbrain integrations doctor [--json]  Run health checks
  gbrain integrations stats [--json]   Show signal statistics
  gbrain integrations test <file>      Validate a recipe file
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
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printHelp();
      process.exit(1);
  }
}
