// v0.40.6.0 Schema Cathedral v3 — pure lint rule functions.
//
// Extracted from CLI handlers per codex C13 / D16 so:
//   - Phase 2's `withMutation` validation gate can run pre-write checks.
//   - Phase 5's `gbrain schema lint` CLI verb wires to the same rules.
//   - Phase 7's `schema_lint` MCP op composes them without printing to stdout.
//
// Each rule is a pure function: takes a manifest (+ optional opts) and
// returns an array of issues. No I/O except for the two DB-aware rules,
// which gate on opts.engine being present (file-plane callers omit).
//
// Issue shape mirrors the StructuredAgentError envelope from
// src/core/errors.ts so JSON output is consistent across CLI + MCP.

import type { SchemaPackManifest } from './manifest-v1.ts';
import type { BrainEngine } from '../engine.ts';
import { readRecentMutations } from './mutate-audit.ts';

export type LintSeverity = 'error' | 'warning';

export interface LintIssue {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** Source pack name; useful when linting extends-chain in v0.41+. */
  pack: string;
  /** Affected type name when applicable. */
  type?: string;
  /** Affected link verb when applicable. */
  link?: string;
  /** Paste-ready hint command, when one exists. */
  hint?: string;
}

export interface LintOpts {
  /** When set, DB-aware rules run. File-plane callers omit. */
  engine?: BrainEngine;
  /** Limit scan window for audit-aware rules. Default 7 days. */
  daysBack?: number;
}

export type LintRule = (manifest: SchemaPackManifest, opts?: LintOpts) =>
  | LintIssue[]
  | Promise<LintIssue[]>;

// ────────────────────────────────────────────────────────────────────────
// File-plane rules (synchronous, no engine)
// ────────────────────────────────────────────────────────────────────────

export const aliasShadowsType: LintRule = (manifest) => {
  const issues: LintIssue[] = [];
  const typeNames = new Set(manifest.page_types.map((t) => t.name));
  for (const t of manifest.page_types) {
    for (const a of t.aliases) {
      if (typeNames.has(a) && a !== t.name) {
        issues.push({
          rule: 'alias_shadows_type',
          severity: 'error',
          message: `type '${t.name}' declares alias '${a}' which is also a declared page_type name; query closure collision`,
          pack: manifest.name,
          type: t.name,
          hint: `remove alias '${a}' from type '${t.name}' OR rename one of them`,
        });
      }
    }
  }
  return issues;
};

export const aliasDeclaredByTwoTypes: LintRule = (manifest) => {
  const issues: LintIssue[] = [];
  const aliasToTypes = new Map<string, string[]>();
  for (const t of manifest.page_types) {
    for (const a of t.aliases) {
      const list = aliasToTypes.get(a) ?? [];
      list.push(t.name);
      aliasToTypes.set(a, list);
    }
  }
  for (const [alias, owners] of aliasToTypes) {
    if (owners.length > 1) {
      issues.push({
        rule: 'alias_declared_by_two_types',
        severity: 'error',
        message: `alias '${alias}' is declared by ${owners.length} types: ${owners.join(', ')}`,
        pack: manifest.name,
        hint: `keep the alias on the most-canonical type; remove from the others`,
      });
    }
  }
  return issues;
};

export const aliasReferencesUndeclaredType: LintRule = (manifest) => {
  // codex C14 — alias should be a known type OR a known alias of another
  // type. For v0.40.6.0 we lint the simpler case: alias must match a
  // declared page_type name. Closure validation is a v0.41+ extension.
  const issues: LintIssue[] = [];
  const typeNames = new Set(manifest.page_types.map((t) => t.name));
  for (const t of manifest.page_types) {
    for (const a of t.aliases) {
      if (!typeNames.has(a)) {
        issues.push({
          rule: 'alias_references_undeclared_type',
          severity: 'warning',
          message: `type '${t.name}' aliases '${a}' which is not a declared page_type in this pack`,
          pack: manifest.name,
          type: t.name,
          hint: `add a page_type for '${a}' OR remove the alias`,
        });
      }
    }
  }
  return issues;
};

export const enrichableTypesUndeclared: LintRule = (manifest) => {
  const issues: LintIssue[] = [];
  const typeNames = new Set(manifest.page_types.map((t) => t.name));
  for (const e of manifest.enrichable_types) {
    if (!typeNames.has(e.type)) {
      issues.push({
        rule: 'enrichable_types_undeclared',
        severity: 'error',
        message: `enrichable_types references '${e.type}' which is not a declared page_type`,
        pack: manifest.name,
        type: e.type,
        hint: `add a page_type for '${e.type}' OR remove the enrichable_types entry`,
      });
    }
  }
  return issues;
};

export const linkTypesUndeclared: LintRule = (manifest) => {
  const issues: LintIssue[] = [];
  const typeNames = new Set(manifest.page_types.map((t) => t.name));
  for (const lt of manifest.link_types) {
    if (lt.inference?.page_type && !typeNames.has(lt.inference.page_type)) {
      issues.push({
        rule: 'link_types_undeclared_page_type',
        severity: 'error',
        message: `link_type '${lt.name}' inference.page_type='${lt.inference.page_type}' is not a declared page_type`,
        pack: manifest.name,
        link: lt.name,
        hint: `add a page_type for '${lt.inference.page_type}' OR remove the inference rule`,
      });
    }
    if (lt.inference?.target_type && !typeNames.has(lt.inference.target_type)) {
      issues.push({
        rule: 'link_types_undeclared_target_type',
        severity: 'error',
        message: `link_type '${lt.name}' inference.target_type='${lt.inference.target_type}' is not a declared page_type`,
        pack: manifest.name,
        link: lt.name,
        hint: `add a page_type for '${lt.inference.target_type}' OR remove inference.target_type`,
      });
    }
  }
  return issues;
};

export const frontmatterLinksUndeclared: LintRule = (manifest) => {
  const issues: LintIssue[] = [];
  const typeNames = new Set(manifest.page_types.map((t) => t.name));
  const linkNames = new Set(manifest.link_types.map((l) => l.name));
  for (const fl of manifest.frontmatter_links) {
    if (!typeNames.has(fl.page_type)) {
      issues.push({
        rule: 'frontmatter_links_undeclared_page_type',
        severity: 'error',
        message: `frontmatter_links.page_type='${fl.page_type}' is not a declared page_type`,
        pack: manifest.name,
        type: fl.page_type,
        hint: `add a page_type for '${fl.page_type}' OR remove the frontmatter_links rule`,
      });
    }
    if (!linkNames.has(fl.link_type)) {
      issues.push({
        rule: 'frontmatter_links_undeclared_link_type',
        severity: 'error',
        message: `frontmatter_links.link_type='${fl.link_type}' is not a declared link_type`,
        pack: manifest.name,
        link: fl.link_type,
        hint: `add a link_type for '${fl.link_type}' OR remove the frontmatter_links rule`,
      });
    }
  }
  return issues;
};

export const expertRoutingWithoutPrefix: LintRule = (manifest) => {
  const issues: LintIssue[] = [];
  for (const t of manifest.page_types) {
    if (t.expert_routing && t.path_prefixes.length === 0) {
      issues.push({
        rule: 'expert_routing_without_prefix',
        severity: 'warning',
        message: `type '${t.name}' is expert_routing:true but has no path_prefixes; expert routing will silently miss content`,
        pack: manifest.name,
        type: t.name,
        hint: `add a path_prefix so put_page can infer this type from disk paths`,
      });
    }
  }
  return issues;
};

export const prefixCollision: LintRule = (manifest) => {
  const issues: LintIssue[] = [];
  const prefixToTypes = new Map<string, string[]>();
  for (const t of manifest.page_types) {
    for (const p of t.path_prefixes) {
      const list = prefixToTypes.get(p) ?? [];
      list.push(t.name);
      prefixToTypes.set(p, list);
    }
  }
  for (const [prefix, owners] of prefixToTypes) {
    if (owners.length > 1) {
      issues.push({
        rule: 'prefix_collision',
        severity: 'error',
        message: `path_prefix '${prefix}' is declared by ${owners.length} types: ${owners.join(', ')}; type inference is undefined`,
        pack: manifest.name,
        hint: `keep the prefix on one canonical type; remove from the others OR use distinct prefixes`,
      });
    }
  }
  return issues;
};

export const prefixStrictSubsetOverlap: LintRule = (manifest) => {
  const issues: LintIssue[] = [];
  // Build (prefix, owningType) pairs.
  const pairs: Array<{ prefix: string; type: string }> = [];
  for (const t of manifest.page_types) {
    for (const p of t.path_prefixes) pairs.push({ prefix: p, type: t.name });
  }
  for (let i = 0; i < pairs.length; i++) {
    for (let j = 0; j < pairs.length; j++) {
      if (i === j) continue;
      const a = pairs[i]!;
      const b = pairs[j]!;
      // a is strict subset of b: a starts with b AND a !== b.
      if (a.prefix !== b.prefix && a.prefix.startsWith(b.prefix) && a.type !== b.type) {
        issues.push({
          rule: 'prefix_strict_subset_overlap',
          severity: 'warning',
          message: `path_prefix '${a.prefix}' (type ${a.type}) is a strict subset of '${b.prefix}' (type ${b.type}); inference precedence is first-match-wins`,
          pack: manifest.name,
          hint: `ensure '${a.type}' is declared BEFORE '${b.type}' in page_types[] so the specific prefix wins`,
        });
      }
    }
  }
  return issues;
};

// ────────────────────────────────────────────────────────────────────────
// DB-aware rules (engine required; file-plane callers see empty arrays)
// ────────────────────────────────────────────────────────────────────────

export const extractableEmptyCorpus: LintRule = async (manifest, opts) => {
  if (!opts?.engine) return [];
  const issues: LintIssue[] = [];
  for (const t of manifest.page_types) {
    if (!t.extractable || t.path_prefixes.length === 0) continue;
    // Check each prefix; if all return zero, warn.
    let totalPages = 0;
    for (const p of t.path_prefixes) {
      try {
        const rows = await opts.engine.executeRaw(
          `SELECT COUNT(*)::text AS cnt FROM pages WHERE deleted_at IS NULL AND source_path LIKE $1`,
          [`${p}%`],
        ) as Array<{ cnt?: string }>;
        const cnt = rows[0]?.cnt ? parseInt(rows[0].cnt, 10) : 0;
        totalPages += cnt;
      } catch {
        // Engine call failed (no `pages` table on a fresh PGLite install?); skip.
        return [];
      }
    }
    if (totalPages === 0) {
      issues.push({
        rule: 'extractable_empty_corpus',
        severity: 'warning',
        message: `type '${t.name}' is extractable:true but its path_prefixes match 0 pages in the DB`,
        pack: manifest.name,
        type: t.name,
        hint: `either remove extractable:true OR check that path_prefixes match actual import paths`,
      });
    }
  }
  return issues;
};

export const mutationCountAnomaly: LintRule = (manifest, opts) => {
  const daysBack = opts?.daysBack ?? 7;
  const issues: LintIssue[] = [];
  try {
    const recs = readRecentMutations(daysBack);
    const forPack = recs.filter((r) => r.pack === manifest.name);
    if (forPack.length > 50) {
      issues.push({
        rule: 'mutation_count_anomaly',
        severity: 'warning',
        message: `pack '${manifest.name}' has ${forPack.length} mutations in the last ${daysBack} days; consider committing pack.json to source control`,
        pack: manifest.name,
        hint: `cd to your brain repo, git add the pack file, commit + push so the changes survive across machines`,
      });
    }
  } catch {
    // Audit dir unreadable; skip silently.
  }
  return issues;
};

// ────────────────────────────────────────────────────────────────────────
// Aggregator
// ────────────────────────────────────────────────────────────────────────

/** All rules. File-plane callers can compose a subset via FILE_PLANE_RULES. */
export const ALL_LINT_RULES: ReadonlyArray<{ name: string; rule: LintRule; planeAware: boolean }> = [
  { name: 'alias_shadows_type', rule: aliasShadowsType, planeAware: false },
  { name: 'alias_declared_by_two_types', rule: aliasDeclaredByTwoTypes, planeAware: false },
  { name: 'alias_references_undeclared_type', rule: aliasReferencesUndeclaredType, planeAware: false },
  { name: 'enrichable_types_undeclared', rule: enrichableTypesUndeclared, planeAware: false },
  { name: 'link_types_undeclared', rule: linkTypesUndeclared, planeAware: false },
  { name: 'frontmatter_links_undeclared', rule: frontmatterLinksUndeclared, planeAware: false },
  { name: 'expert_routing_without_prefix', rule: expertRoutingWithoutPrefix, planeAware: false },
  { name: 'prefix_collision', rule: prefixCollision, planeAware: false },
  { name: 'prefix_strict_subset_overlap', rule: prefixStrictSubsetOverlap, planeAware: false },
  { name: 'extractable_empty_corpus', rule: extractableEmptyCorpus, planeAware: true },
  { name: 'mutation_count_anomaly', rule: mutationCountAnomaly, planeAware: true },
];

/** File-plane subset: rules safe to run inside `withMutation`'s pre-write gate. */
export const FILE_PLANE_LINT_RULES = ALL_LINT_RULES.filter((r) => !r.planeAware);

export interface LintReport {
  ok: boolean;
  errors: LintIssue[];
  warnings: LintIssue[];
}

function classify(issues: LintIssue[]): LintReport {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Run every rule (file-plane + DB-aware when engine is provided).
 * Returns a structured report ready to render via CLI or wire-encode
 * via MCP.
 */
export async function runAllLintRules(
  manifest: SchemaPackManifest,
  opts?: LintOpts,
): Promise<LintReport> {
  const issues: LintIssue[] = [];
  for (const { rule, planeAware } of ALL_LINT_RULES) {
    if (planeAware && !opts?.engine) continue;
    const out = await rule(manifest, opts);
    issues.push(...out);
  }
  return classify(issues);
}

/**
 * Run only file-plane rules. Used by `withMutation`'s pre-write
 * validation gate so a mutation that creates a dangling ref fails
 * BEFORE the atomic write happens.
 *
 * Returns the same shape as runAllLintRules but skips DB-aware checks.
 */
export async function runFilePlaneLintRules(
  manifest: SchemaPackManifest,
): Promise<LintReport> {
  const issues: LintIssue[] = [];
  for (const { rule, planeAware } of ALL_LINT_RULES) {
    if (planeAware) continue;
    const out = await rule(manifest);
    issues.push(...out);
  }
  return classify(issues);
}
