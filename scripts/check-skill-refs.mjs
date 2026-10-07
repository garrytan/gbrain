#!/usr/bin/env bun
// check-skill-refs — three integrity gates over the skills/ markdown tree.
//
// 1. DANGLING REFS (fail): every backtick `skills/<x>/...` path, every
//    relative markdown link (`](./x.md)` / `](../x/y.md)`), every frontmatter
//    `composes:` slug, and every `(dispatcher for: a, b)` slug in RESOLVER.md
//    must resolve to an existing file/dir. Placeholder templates
//    (`skills/X/`, `skills/<slug>/`, `{...}` / `<...>` targets, example-slug
//    brain-page paths like `../people/alice-example.md`) and
//    skills/migrations/** are exempt — migrations are historical record,
//    placeholders are documentation idiom.
// 2. DONOR REMNANTS (fail, allowlist-ratcheted): donor-workspace path prefixes
//    must not appear outside files listed in scripts/skill-refs-allowlist.txt.
//    The allowlist is a ratchet: it may shrink, never silently grow — add a
//    line only with a review-visible commit. An entry whose file has no donor
//    hit (cleaned or deleted) fails as stale, so the list shrinks with it.
// 3. CLI REFS (fail): `gbrain <cmd>` tokens inside fenced code blocks AND
//    inline code spans must name a real top-level command (the CLI's
//    --tools-json surface, CLI_FLAG_REGISTRY, src/cli.ts dispatch, the
//    command table and op cliHints). A curated list of known-bad
//    subcommands (`gbrain embed refresh` parses `refresh` as a page slug)
//    fails too. Skill bodies are agent-executed instructions, so a command
//    that cannot run is a broken instruction, not a style nit. If the CLI
//    surface cannot be loaded the lane warns and skips.
// 4. OUTSIDE-ROOT LINKS (fail): a relative markdown link whose resolved
//    target lies outside the skills root breaks the moment the skills are
//    copied into a host workspace or a plugin tree (#6198). Links inside the
//    skills tree stay relative; repo docs use absolute URLs (fix:
//    `bun scripts/portable-skill-links.ts`). skills/migrations/** is exempt.
//    The same rule runs over the generated plugin/skills and
//    plugin-variants/*/skills trees next to the skills dir.
//
// Usage: bun scripts/check-skill-refs.mjs [--skills-dir skills/] [--allowlist scripts/skill-refs-allowlist.txt] [--no-cli-refs]

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = args.indexOf(flag);
  const v = i >= 0 ? args[i + 1] : undefined;
  // A value that looks like a flag (starts with --) means this option's value
  // was omitted; treat it as missing rather than swallowing the next flag.
  return v && !v.startsWith('--') ? v : dflt;
}
const SKILLS_DIR = argVal('--skills-dir', 'skills');
const ALLOWLIST_PATH = argVal('--allowlist', 'scripts/skill-refs-allowlist.txt');
const RUN_CLI_REFS = !args.includes('--no-cli-refs');

const DONOR_PREFIXES = ['/data/brain', '/data/.openclaw', '/data/gbrain', '/data/tmp'];
const PLACEHOLDER_RE = /skills\/(X|<[^>]+>|\{[^}]+\}|\$\{[^}]+\}|\.\.\.)\/?/;

// Relative-markdown-link exemptions: skill bodies illustrate BRAIN-repo page
// links (`[Alice Example](../people/alice-example.md)`). Those targets live in
// a brain repo, not the skills tree — any relative target whose first real
// path segment is a brain-content top-level dir is a documentation example,
// not a skills cross-link. Example-slug segments (`*-example`) are likewise
// placeholders per the privacy rule.
const BRAIN_CONTENT_DIRS = new Set([
  'people', 'companies', 'meetings', 'daily', 'concepts', 'sources',
  'research', 'projects', 'media', 'conversations', 'analysis', 'notes',
  'ideas', 'takes', 'funds', 'deals',
]);
function isPlaceholderLinkTarget(target) {
  if (/[<{$]/.test(target)) return true; // <slug>, {slug}, ${var} templates
  const segs = target.split('/').filter((s) => s && s !== '.' && s !== '..');
  if (segs.length === 0) return true;
  if (BRAIN_CONTENT_DIRS.has(segs[0])) return true; // brain-page path example
  if (segs.some((s) => /-example(\.|\/|$)/.test(s))) return true; // alice-example, acme-example, ...
  return false;
}

const SKILLS_ROOT = resolve(SKILLS_DIR);
const PORTABLE_FIX = 'bun scripts/portable-skill-links.ts';

/** A relative link that escapes `root` once resolved from `file`'s directory, or null. */
function outsideRootLink(root, file, raw) {
  const target = raw.split('#')[0];
  if (!relative(root, resolve(dirname(file), target)).startsWith('..')) return null;
  const line = readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes(`](${raw})`)) + 1;
  return {
    line,
    message: `\`](${raw})\` resolves outside the skills root, so it dangles once the skills are copied into a host workspace or plugin. Fix: ${PORTABLE_FIX} (protocol links point at skills/conventions/agent-operator-protocol.md; other repo docs become absolute URLs)`,
  };
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    // .md feeds every lane; .jsonl feeds the donor-remnant scan only —
    // routing-eval fixtures can carry a donor-workspace path too.
    else if (e.name.endsWith('.md') || e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

if (!existsSync(SKILLS_DIR)) {
  console.error(`check-skill-refs: skills dir not found: ${SKILLS_DIR}`);
  process.exit(2);
}

const allowlist = new Set(
  existsSync(ALLOWLIST_PATH)
    ? readFileSync(ALLOWLIST_PATH, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : [],
);

const files = walk(SKILLS_DIR);
const failures = [];
const warnings = [];
const allowlistHits = new Set();

for (const file of files) {
  // Path identity is always "skills/<path-under-skills-dir>", independent of cwd
  // canonicalization (macOS /var vs /private/var) or an absolute --skills-dir.
  const underSkills = relative(SKILLS_DIR, file);
  const rel = join('skills', underSkills);
  const inMigrations = underSkills.startsWith('migrations/');
  const text = readFileSync(file, 'utf8');

  // --- 2. donor remnants (skip migrations wholesale) ---
  if (!inMigrations && allowlist.has(rel)) {
    if (DONOR_PREFIXES.some((prefix) => text.includes(prefix))) allowlistHits.add(rel);
  } else if (!inMigrations) {
    for (const prefix of DONOR_PREFIXES) {
      if (text.includes(prefix)) {
        const line = text.split('\n').findIndex((l) => l.includes(prefix)) + 1;
        failures.push(`[donor-remnant] ${rel}:${line} — contains "${prefix}" (add to ${ALLOWLIST_PATH} only with review)`);
        break;
      }
    }
  }

  if (inMigrations) continue;

  // The lanes below are markdown-only (backtick refs, relative md-links,
  // frontmatter). .jsonl files are scanned for donor remnants above only.
  if (!file.endsWith('.md')) continue;

  // --- 1a. backtick skills/ path refs ---
  for (const m of text.matchAll(/`(skills\/[^`\s]+)`/g)) {
    let ref = m[1].replace(/[.,;:]+$/, '');
    if (PLACEHOLDER_RE.test(ref)) continue;
    // strip trailing anchors / line refs like skills/foo/SKILL.md:12
    ref = ref.replace(/:\d+(-\d+)?$/, '').replace(/#.*$/, '');
    if (ref.endsWith('/')) ref = ref.slice(0, -1);
    // Resolve against the PARENT of the skills dir (refs are written as
    // "skills/<x>/..."), never bare cwd — the check must be cwd-independent.
    if (!existsSync(join(SKILLS_DIR, '..', ref))) {
      const line = text.split('\n').findIndex((l) => l.includes(m[1])) + 1;
      failures.push(`[dangling-ref] ${rel}:${line} — \`${m[1]}\` does not exist`);
    }
  }

  // --- 1d. relative markdown links ---
  // `](./x.md)` / `](../x/y.md)` targets must resolve against the linking
  // file's own directory. http(s) and anchor-only targets never match the
  // leading ./ or ../ pattern; placeholder/example targets are exempt.
  for (const m of text.matchAll(/\]\((\.{1,2}\/[^)\s]+)\)/g)) {
    const raw = m[1];
    const target = raw.split('#')[0];
    if (!target) continue; // anchor-only after a ./ prefix — nothing to resolve
    if (isPlaceholderLinkTarget(target)) continue;
    const outside = outsideRootLink(SKILLS_ROOT, file, raw);
    if (outside) {
      failures.push(`[outside-root-link] ${rel}:${outside.line} — ${outside.message}`);
      continue;
    }
    if (!existsSync(join(dirname(file), target))) {
      const line = text.split('\n').findIndex((l) => l.includes(raw)) + 1;
      failures.push(`[dangling-md-link] ${rel}:${line} — \`](${raw})\` does not resolve from ${rel}'s directory`);
    }
  }

  // --- 1b. frontmatter composes: slugs ---
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const composesMatch = fm.match(/^composes:\s*(.*)$/m);
    if (composesMatch) {
      const inline = composesMatch[1].trim();
      let slugs = [];
      if (inline && inline !== '|' && !inline.startsWith('#')) {
        slugs = inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        // block-list form: lines "  - slug" following the key
        const after = fm.slice(fm.indexOf(composesMatch[0]) + composesMatch[0].length);
        for (const line of after.split(/\r?\n/)) {
          const lm = line.match(/^\s+-\s+(\S+)/);
          if (lm) slugs.push(lm[1]);
          else if (line.trim() && !line.startsWith(' ')) break;
        }
      }
      for (const slug of slugs) {
        if (!existsSync(join(SKILLS_DIR, slug))) {
          failures.push(`[dangling-composes] ${rel} — composes: "${slug}" is not a skill dir under ${SKILLS_DIR}/`);
        }
      }
    }
  }
}

// --- 1c. RESOLVER.md dispatcher clauses ---
const resolverPath = join(SKILLS_DIR, 'RESOLVER.md');
if (existsSync(resolverPath)) {
  const rtext = readFileSync(resolverPath, 'utf8');
  for (const m of rtext.matchAll(/\(dispatcher for:\s*([^)]+)\)/g)) {
    for (const slug of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const cleaned = slug.replace(/`/g, '');
      if (!/^[a-z0-9-]+$/.test(cleaned)) continue; // prose, not a slug
      if (!existsSync(join(SKILLS_DIR, cleaned))) {
        failures.push(`[dangling-dispatcher] ${SKILLS_DIR}/RESOLVER.md — dispatcher slug "${cleaned}" is not a skill dir`);
      }
    }
  }
}

// --- 3. CLI refs (fail) ---
// `gbrain embed` takes flags or a page slug, so a bare word after it is read
// as a slug: `embed refresh` runs the paid-consent gate, then "Page not found".
const KNOWN_BAD_SUBCOMMANDS = {
  embed: { refresh: 'gbrain embed --stale --dry-run (preview), then gbrain embed --stale --yes --max-usd <cap> after the user approves' },
};
// A command position: line/span start, after a shell separator or `$ ` prompt,
// past `nohup`/`exec`/`time` and env assignments. Prose that merely mentions
// gbrain mid-sentence ("turned off gbrain update checks") is not a command.
const GBRAIN_CMD_RE = /(?:^|[|&;(]|\$)\s*(?:(?:nohup|exec|time)\s+|[A-Z_][A-Z0-9_]*=\S*\s+)*gbrain\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g;

/** `gbrain <cmd> [<sub>]` in fenced code lines and inline code spans. */
function cliRefs(text) {
  const refs = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker && (!fence || marker[1].startsWith(fence))) {
      fence = fence ? null : marker[1];
      continue;
    }
    const snippets = fence ? [line.trim()] : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    for (const snippet of snippets) {
      for (const m of snippet.matchAll(GBRAIN_CMD_RE)) refs.push({ cmd: m[1], sub: m[2], snippet });
    }
  }
  return refs;
}

if (RUN_CLI_REFS) {
  let known = null;
  try {
    const raw = execSync('bun src/cli.ts --tools-json 2>/dev/null', { encoding: 'utf8', timeout: 30_000 });
    const parsed = JSON.parse(raw.slice(raw.indexOf('[') >= 0 && raw.indexOf('[') < (raw.indexOf('{') + 1 || Infinity) ? raw.indexOf('[') : raw.indexOf('{')));
    const list = Array.isArray(parsed) ? parsed : parsed.tools || [];
    known = new Set();
    for (const t of list) {
      const n = (t.cliHints && t.cliHints.name) || t.cli_name || t.name;
      if (n) known.add(String(n).replaceAll('_', '-'));
      for (const a of (t.cliHints && t.cliHints.aliases) || []) known.add(String(a));
    }
  } catch {
    warnings.push('[cli-refs] could not load --tools-json; skipping CLI-ref check');
  }
  if (known && known.size === 0) {
    warnings.push('[cli-refs] --tools-json parsed to an EMPTY command set; skipping CLI-ref check (the CLI-ref lane is not running)');
  }
  if (known && known.size > 0) {
    // top-level commands defined directly in src/cli.ts (not ops): derive from source
    try {
      const cliSrc = readFileSync('src/cli.ts', 'utf8');
      for (const m of cliSrc.matchAll(/(?:command === |case )'([a-z][a-z0-9-]*)'/g)) known.add(m[1]);
      // Refactor wave 1: CLI-only commands are records in the command table.
      const tableSrc = readFileSync('src/cli/command-table.ts', 'utf8');
      for (const m of tableSrc.matchAll(/\{ name: '([a-z][a-z0-9-]*)'/g)) known.add(m[1]);
      // Every CLI-only command has a row in the generated flag registry.
      const registrySrc = readFileSync('src/core/cli-flag-registry.generated.ts', 'utf8');
      const registry = registrySrc.slice(registrySrc.indexOf('CLI_FLAG_REGISTRY'), registrySrc.indexOf('CLI_ROUTING_FLAGS'));
      for (const m of registry.matchAll(/^\s+'([a-z][a-z0-9-]*)': \[/gm)) known.add(m[1]);
    } catch {}
    // ops cliHints that --tools-json does not serialize: read them from source.
    // operations.ts is a façade post-peel — the op declarations (and their
    // cliHints) live in src/core/ops/*.ts, so scan the whole surface.
    try {
      const opsFiles = ['src/core/operations.ts'];
      try {
        for (const f of readdirSync('src/core/ops')) {
          if (f.endsWith('.ts')) opsFiles.push(`src/core/ops/${f}`);
        }
      } catch {}
      for (const opsFile of opsFiles) {
        const opsSrc = readFileSync(opsFile, 'utf8');
        for (const m of opsSrc.matchAll(/cliHints:\s*\{\s*name:\s*'([a-z][a-z0-9-]*)'/g)) known.add(m[1]);
        for (const m of opsSrc.matchAll(/aliases:\s*\[([^\]]*)\]/g)) {
          for (const a of m[1].matchAll(/'([a-z][a-z0-9-]*)'/g)) known.add(a[1]);
        }
      }
    } catch {}
    for (const file of files) {
      if (file.includes('/migrations/')) continue;
      if (!file.endsWith('.md')) continue; // gbrain-cmd scan is markdown-only
      const rel = join('skills', relative(SKILLS_DIR, file));
      for (const { cmd, sub, snippet } of cliRefs(readFileSync(file, 'utf8'))) {
        if (!known.has(cmd)) {
          failures.push(`[cli-refs] ${rel} — \`${snippet}\`: \`gbrain ${cmd}\` is not a gbrain command, so an agent following this skill gets "unknown command". Fix: name the real command (\`gbrain --help\` lists them)`);
          continue;
        }
        const replacement = sub && KNOWN_BAD_SUBCOMMANDS[cmd]?.[sub];
        if (replacement) failures.push(`[cli-refs] ${rel} — \`${snippet}\`: \`gbrain ${cmd} ${sub}\` does not run as written. Fix: ${replacement}`);
      }
    }
  }
}

// --- 4. outside-root links in the generated plugin trees ---
// The plugin trees ship to users verbatim; a link that escapes their skills
// root dangles in every install. Only the link rule runs here: the variants
// carry a subset of skills by design.
const generatedRoots = [join(SKILLS_DIR, '..', 'plugin', 'skills')];
const variantsDir = join(SKILLS_DIR, '..', 'plugin-variants');
if (existsSync(variantsDir)) {
  for (const v of readdirSync(variantsDir)) generatedRoots.push(join(variantsDir, v, 'skills'));
}
for (const root of generatedRoots.filter((r) => existsSync(r))) {
  for (const file of walk(root)) {
    const underRoot = relative(root, file);
    if (underRoot.startsWith('migrations/') || !file.endsWith('.md')) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/\]\((\.{1,2}\/[^)\s]+)\)/g)) {
      if (isPlaceholderLinkTarget(m[1].split('#')[0])) continue;
      const outside = outsideRootLink(resolve(root), file, m[1]);
      if (outside) failures.push(`[outside-root-link] ${relative(join(SKILLS_DIR, '..'), file)}:${outside.line} — ${outside.message}, then bun run regen:all`);
    }
  }
}

// The ratchet only shrinks if a clean file leaves the list: an entry whose
// file no longer carries a donor prefix (or no longer exists) fails.
for (const entry of allowlist) {
  if (allowlistHits.has(entry)) continue;
  failures.push(`[stale-allowlist] ${entry} — listed in ${ALLOWLIST_PATH} but has no donor-remnant hit. Why: an unused entry would let a future donor path in that file pass unreviewed. Fix: delete the line "${entry}" from ${ALLOWLIST_PATH}`);
}

for (const w of warnings) console.error(`WARN ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`check-skill-refs: ${failures.length} failure(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`check-skill-refs: OK (${files.length} files scanned, ${warnings.length} warning(s))`);
