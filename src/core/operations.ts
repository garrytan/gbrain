/**
 * Contract-first operation definitions. Single source of truth for CLI, MCP, and tools-json.
 * Each operation defines its schema, handler, and optional CLI hints.
 */

import { readFileSync } from 'fs';
import type { OperationAuthPrincipal } from './auth-principal.ts';
import type { MBrainConfig } from './config.ts';
import type { BrainEngine } from './engine.ts';
import { serializeMarkdown } from './markdown.ts';
import { getUnsupportedCapabilityReason } from './offline-profile.ts';
import {
  getMissingRequiredParams,
  type OperationCapability,
  OperationError,
  type ParamDef,
  type ParamType,
  paramHasType,
  validateOperationParams as validateParamsAgainstDescriptor,
} from './operation-params.ts';
import { createAgentSessionActivationOperations } from './operations-agent-session-activation.ts';
import { createAgentSessionMemoryOperations } from './operations-agent-session-memory.ts';
import { createAssertionOperations } from './operations-assertions.ts';
import { createBrainLoopAuditOperations } from './operations-brain-loop-audit.ts';
import { createCanonicalTargetProposalOperations } from './operations-canonical-target-proposals.ts';
import { createLifecycleForgettingOperations } from './operations-lifecycle-forgetting.ts';
import { createMemoryControlPlaneOperations } from './operations-memory-control-plane.ts';
import { createMemoryInboxOperations, DEFAULT_MEMORY_INBOX_SCOPE_ID } from './operations-memory-inbox.ts';
import { createMemoryMutationLedgerOperations } from './operations-memory-mutation-ledger.ts';
import { createMemoryWritebackRouterOperations } from './operations-memory-writeback-router.ts';
import { createNoteManifestOperations } from './operations-note-manifest.ts';
import { createProceduralMemoryOperations } from './operations-procedural-memory.ts';
import { createSourceRegistryOperations } from './operations-source-registry.ts';
import { createTaskOperations } from './operations-tasks.ts';
import type { RetrievalTraceWriteOutcome } from './types.ts';
import { createContextMapOperations } from './operations-context-maps.ts';
import { createMiscOperations } from './operations-misc.ts';
import { createNoteSectionOperations } from './operations-note-sections.ts';
import { createPageOperations } from './operations-pages.ts';
import { createProfileEpisodeOperations } from './operations-profile-episodes.ts';
import { assertPutPageRouteFirstPrecondition, createPutPageOperations } from './operations-put-page.ts';
import { createRetrievalOperations } from './operations-retrieval.ts';
import { createSearchOperations } from './operations-search.ts';
import { createTagsLinksTimelineOperations } from './operations-tags-links-timeline.ts';
import { createVersionsOperations } from './operations-versions.ts';

// --- MCP server instructions ---
//
// Returned to MCP clients in the `instructions` field of `InitializeResult`.
// Clients render this near the top of the agent's system prompt, so agents see
// it before they decide which tools to call. See docs/MCP_INSTRUCTIONS.md for
// the design rationale.
export const MCP_INSTRUCTIONS = [
  'Use this server to look up knowledge about people, companies, technical concepts, internal systems, and organizational context. Prefer this over web search or codebase grep when the question involves a named entity, domain concept, or cross-system architecture. The brain contains compiled truth, relationship history, and technical maps that external search cannot provide.',
  'Unsure which tool to use? Call get_skillpack first for the compact agent rules and orientation.',
  'Do not use for: code editing, git operations, file management, library documentation, or general programming.',
].join('\n\n');

// --- Types ---

export { assertPutPageRouteFirstPrecondition, hasPutPageRouteFirstPrecondition } from './operations-put-page.ts';
export { registerSyncBrainHandler, type SyncBrainHandler, type SyncBrainHandlerOptions } from './operations-misc.ts';

export { getMissingRequiredParams, OperationError, paramHasType } from './operation-params.ts';
export type { ErrorCode, OperationCapability, ParamDef, ParamType } from './operation-params.ts';

/**
 * Registry-facing validation wrapper: layers put_page's route-first
 * explanation over the shared descriptor-driven seam in operation-params.ts.
 */
export function validateOperationParams(
  operation: { name: string; params: Record<string, ParamDef> },
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (operation.name === 'put_page') {
    const missing = getMissingRequiredParams(operation, params);
    if (missing.includes('expected_content_hash')) {
      assertPutPageRouteFirstPrecondition(params);
    }
  }
  return validateParamsAgainstDescriptor(operation, params);
}

export async function dispatchOperation(ctx: OperationContext, operation: Operation, params: Record<string, unknown> | null | undefined): Promise<unknown> {
  const preparedParams = params ?? {};
  return operation.handler(ctx, validateOperationParams(operation, preparedParams));
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface OperationContext {
  engine: BrainEngine;
  config: MBrainConfig;
  logger: Logger;
  dryRun: boolean;
  auth_principal?: OperationAuthPrincipal;
}

export interface Operation {
  name: string;
  description: string;
  discovery?: {
    compactDescription?: boolean;
    description?: string;
  };
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;
  capabilityRequired?: OperationCapability;
  // Tool-catalog tier (see src/mcp/tool-tiers.ts). Explicit override of the catalog
  // classification. 'admin' ops are hidden from the default MCP catalog and blocked by
  // named MCP dispatch unless that tier is explicitly enabled.
  tier?: 'core' | 'extended' | 'admin';
  cliHints?: {
    name?: string;
    positional?: string[];
    stdin?: string;
    hidden?: boolean;
    aliases?: Record<string, string>;
  };
}

type ParamValueForDefinition<Def extends ParamDef> =
  Def['type'] extends readonly ParamType[]
    ? unknown
    : Def['type'] extends 'string'
      ? string
      : Def['type'] extends 'number'
        ? number
        : Def['type'] extends 'boolean'
          ? boolean
          : Def['type'] extends 'array'
            ? unknown[]
            : Def['type'] extends 'object'
              ? Record<string, unknown>
              : unknown;

export type OperationParamsFor<Params extends Record<string, ParamDef>> = {
  [Key in keyof Params as Params[Key]['required'] extends true ? Key : never]: ParamValueForDefinition<Params[Key]>;
} & {
  [Key in keyof Params as Params[Key]['required'] extends true ? never : Key]?: ParamValueForDefinition<Params[Key]>;
};

export type TypedOperation<Params extends Record<string, ParamDef>> =
  Omit<Operation, 'params' | 'handler'> & {
    params: Params;
    handler: (ctx: OperationContext, params: OperationParamsFor<Params>) => Promise<unknown>;
  };

export function defineOperation<Params extends Record<string, ParamDef>>(
  operation: TypedOperation<Params>,
): Operation {
  return operation as Operation;
}

export function getOperationCapabilityRequirements(operation: Operation): OperationCapability[] {
  const requirements = new Set<OperationCapability>();
  if (operation.capabilityRequired) {
    requirements.add(operation.capabilityRequired);
  }
  for (const param of Object.values(operation.params)) {
    collectParamCapabilityRequirements(param, requirements);
  }
  return [...requirements];
}

export function isOperationSupportedByConfig(operation: Operation, config: MBrainConfig): boolean {
  return getOperationCapabilityRequirements(operation).every((capability) => getUnsupportedCapabilityReason(config, capability) === null);
}

function collectParamCapabilityRequirements(param: ParamDef, requirements: Set<OperationCapability>): void {
  if (param.capabilityRequired) {
    requirements.add(param.capabilityRequired);
  }
  if (param.items) {
    collectParamCapabilityRequirements(param.items, requirements);
  }
}

const RETRIEVAL_TRACE_WRITE_OUTCOMES = [
  'no_durable_write',
  'operational_write',
  'candidate_created',
  'promoted',
  'rejected',
  'superseded',
] as const satisfies readonly RetrievalTraceWriteOutcome[];

export interface ParseOpArgsOptions {
  warn?: (msg: string) => void;
  stdin?: {
    isTTY: boolean;
    read: () => string;
  };
}

function splitEquals(raw: string): { token: string; inlineValue?: string } {
  const eq = raw.indexOf('=');
  if (eq === -1) return { token: raw };
  return { token: raw.slice(0, eq), inlineValue: raw.slice(eq + 1) };
}

function coerceNumber(key: string, raw: string): number {
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid number for --${key.replace(/_/g, '-')}: "${raw}"`);
  }
  return n;
}

export function parseOpArgs(op: Pick<Operation, 'params' | 'cliHints'>, args: string[], options: ParseOpArgsOptions = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const positional = op.cliHints?.positional || [];
  const aliases = op.cliHints?.aliases || {};
  const warn = options.warn ?? ((msg: string) => console.error(`Warning: ${msg}`));
  const stdin = options.stdin ?? {
    isTTY: process.stdin.isTTY,
    read: () => readFileSync('/dev/stdin', 'utf-8'),
  };
  let posIdx = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--') && arg.length > 2) {
      const { token, inlineValue } = splitEquals(arg.slice(2));
      const key = token.replace(/-/g, '_');
      const paramDef = op.params[key];
      if (!paramDef) {
        warn(`unknown flag --${token} (ignored)`);
        if (inlineValue === undefined && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
        continue;
      }
      if (paramHasType(paramDef, 'boolean')) {
        params[key] = inlineValue === undefined ? true : inlineValue !== 'false';
        continue;
      }
      let value: string | undefined = inlineValue;
      if (value === undefined) {
        if (i + 1 >= args.length) {
          warn(`--${token} expects a value`);
          continue;
        }
        value = args[++i];
      }
      params[key] = coerceCliParamValue(key, value, paramDef);
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1 && arg !== '--') {
      const { token, inlineValue } = splitEquals(arg.slice(1));
      const key = aliases[token];
      if (!key) {
        warn(`unknown flag -${token} (ignored)`);
        if (inlineValue === undefined && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
        continue;
      }
      const paramDef = op.params[key];
      if (paramHasType(paramDef, 'boolean')) {
        params[key] = inlineValue === undefined ? true : inlineValue !== 'false';
        continue;
      }
      let value: string | undefined = inlineValue;
      if (value === undefined) {
        if (i + 1 >= args.length) {
          warn(`-${token} expects a value`);
          continue;
        }
        value = args[++i];
      }
      params[key] = coerceCliParamValue(key, value, paramDef);
      continue;
    }

    if (posIdx < positional.length) {
      const key = positional[posIdx++];
      const paramDef = op.params[key];
      params[key] = coerceCliParamValue(key, arg, paramDef);
    }
  }

  if (op.cliHints?.stdin && !params[op.cliHints.stdin] && !stdin.isTTY) {
    params[op.cliHints.stdin] = stdin.read();
  }

  return params;
}

function coerceCliParamValue(key: string, value: string, paramDef: ParamDef): unknown {
  if (paramDef.nullable && value === 'null' && isCliNullLiteralParam(key)) return null;
  return paramHasType(paramDef, 'number') ? coerceNumber(key, value) : value;
}

function isCliNullLiteralParam(key: string): boolean {
  return key.endsWith('_content_hash') || key.endsWith('_snapshot_hash');
}

export function formatOpUsage(op: Pick<Operation, 'name' | 'cliHints'>): string {
  const positional = (op.cliHints?.positional || []).map((p) => `<${p}>`).join(' ');
  const name = op.cliHints?.name || op.name;
  return `Usage: mbrain ${name}${positional ? ` ${positional}` : ''}`;
}

export function formatOpHelp(op: Pick<Operation, 'name' | 'description' | 'params' | 'cliHints'>): string {
  const lines = [`${formatOpUsage(op)} [options]`, '', op.description, ''];
  const entries = Object.entries(op.params);
  if (entries.length > 0) {
    lines.push('Options:');
    for (const [key, def] of entries) {
      const isPos = op.cliHints?.positional?.includes(key);
      const req = def.required ? ' (required)' : '';
      const prefix = isPos ? `  <${key}>` : `  --${key.replace(/_/g, '-')}`;
      lines.push(`${prefix.padEnd(28)} ${def.description || ''}${req}`.trimEnd());
    }
  }
  return lines.join('\n') + '\n';
}

function formatProvenanceDate(value: unknown): string {
  if (!value) return 'unknown';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function formatProvenanceList(items: any[] | undefined, format: (item: any) => string): string[] {
  if (!Array.isArray(items) || items.length === 0) return ['- none'];
  return items.map(format);
}

export function formatResult(opName: string, result: unknown, params: Record<string, unknown> = {}): string {
  switch (opName) {
    case 'get_page': {
      const r = result as any;
      if (r.error === 'ambiguous_slug') {
        return `Ambiguous slug. Did you mean:\n${r.candidates.map((c: string) => `  ${c}`).join('\n')}\n`;
      }
      return serializeMarkdown(r.frontmatter || {}, r.compiled_truth || '', r.timeline || '', {
        type: r.type,
        title: r.title,
        tags: r.tags || [],
      });
    }
    case 'explain_page_provenance': {
      const r = result as any;
      if (r.error === 'ambiguous_slug') {
        return `Ambiguous slug. Did you mean:\n${r.candidates.map((c: string) => `  ${c}`).join('\n')}\n`;
      }

      const lines = [
        `Why: ${r.resolved_slug}`,
        `Title: ${r.page?.title ?? 'unknown'}`,
        `Type: ${r.page?.type ?? 'unknown'}`,
        `Updated: ${formatProvenanceDate(r.page?.updated_at)}`,
        `Content hash: ${r.page?.content_hash ?? 'unknown'}`,
        '',
        'Citations',
        ...formatProvenanceList(r.citations, (citation) => `- ${citation}`),
        '',
        'Version History',
        ...formatProvenanceList(r.version_history, (version) => {
          const id = version.id ?? '?';
          const at = formatProvenanceDate(version.created_at ?? version.snapshot_at);
          const hash = version.content_hash ? ` ${version.content_hash}` : '';
          return `- ${id} ${at}${hash}`;
        }),
        '',
        'Timeline',
        ...formatProvenanceList(r.timeline_entries, (entry) => {
          const summary = entry.summary ?? entry.content ?? entry.detail ?? '';
          return `- ${entry.date ?? formatProvenanceDate(entry.created_at)} ${summary}`.trimEnd();
        }),
        '',
        'Ingest Log',
        ...formatProvenanceList(r.ingest_log, (entry) => `- ${formatProvenanceDate(entry.created_at)} ${entry.source_type}:${entry.source_ref} ${entry.summary}`),
        '',
        'Memory Candidate Trail',
        ...formatProvenanceList(
          r.candidate_trail,
          (entry) => `- ${entry.id} ${entry.status}/${entry.verification_status} ${entry.review_reason ?? entry.proposed_content ?? ''}`.trimEnd(),
        ),
        '',
        'Canonical Handoffs',
        ...formatProvenanceList(
          r.canonical_handoffs,
          (entry) => `- ${entry.id} ${entry.candidate_id} ${entry.completion_kind ?? 'pending'} ${entry.completion_ref ?? entry.target_object_id ?? ''}`.trimEnd(),
        ),
        '',
        'Backlinks',
        ...formatProvenanceList(r.backlinks, (link) => {
          const from = link.from_slug ?? link.from ?? 'unknown';
          const type = link.link_type ?? 'link';
          return `- ${from} ${type} ${link.context ?? ''}`.trimEnd();
        }),
      ];

      return `${lines.join('\n')}\n`;
    }
    case 'list_pages': {
      const pages = result as any[];
      if (pages.length === 0) return 'No pages found.\n';
      const rows = pages.map((p) => `${p.slug}\t${p.type}\t${p.updated_at?.toString().slice(0, 10) || '?'}\t${p.title}`).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 50;
      if (pages.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'list_tasks': {
      const tasks = result as any[];
      if (tasks.length === 0) return 'No tasks.\n';
      const rows = tasks.map((task) => `${task.id}\t${task.status}\t${task.scope}\t${task.title}`).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 20;
      if (tasks.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'list_task_traces': {
      const traces = result as any[];
      if (traces.length === 0) return 'No traces.\n';
      const rows =
        traces
          .map((trace) => `${trace.id}\t${trace.created_at?.toString().slice(0, 19) || '?'}\t${(trace.route || []).join(' -> ')}\t${trace.outcome}`)
          .join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 10;
      if (traces.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'list_task_attempts': {
      const attempts = result as any[];
      if (attempts.length === 0) return 'No attempts.\n';
      const rows =
        attempts.map((attempt) => `${attempt.id}\t${attempt.outcome}\t${attempt.created_at?.toString().slice(0, 19) || '?'}\t${attempt.summary}`).join('\n') +
        '\n';
      const requestedLimit = (params.limit as number) ?? 10;
      if (attempts.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'list_task_decisions': {
      const decisions = result as any[];
      if (decisions.length === 0) return 'No decisions.\n';
      const rows =
        decisions
          .map((decision) => `${decision.id}\t${decision.created_at?.toString().slice(0, 19) || '?'}\t${decision.summary}\t${decision.rationale}`)
          .join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 10;
      if (decisions.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'get_note_manifest_entry': {
      const entry = result as any;
      return (
        [
          `${entry.title} [${entry.page_type}]`,
          `Slug: ${entry.slug}`,
          `Path: ${entry.path}`,
          `Scope: ${entry.scope_id}`,
          `Aliases: ${(entry.aliases || []).join(', ') || 'none'}`,
          `Tags: ${(entry.tags || []).join(', ') || 'none'}`,
          `Wiki links: ${(entry.outgoing_wikilinks || []).join(', ') || 'none'}`,
          `URLs: ${(entry.outgoing_urls || []).join(', ') || 'none'}`,
          `Source refs: ${(entry.source_refs || []).join(', ') || 'none'}`,
          `Headings: ${(entry.heading_index || []).map((heading: any) => `${'#'.repeat(heading.depth)} ${heading.text}`).join(' | ') || 'none'}`,
          `Extractor: ${entry.extractor_version}`,
          `Last indexed: ${new Date(entry.last_indexed_at).toISOString()}`,
        ].join('\n') + '\n'
      );
    }
    case 'list_note_manifest_entries': {
      const entries = result as any[];
      if (entries.length === 0) return 'No note manifest entries.\n';
      const rows =
        entries.map((entry) => `${entry.slug}\t${entry.page_type}\t${entry.last_indexed_at?.toString().slice(0, 19) || '?'}\t${entry.title}`).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 20;
      if (entries.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'rebuild_note_manifest': {
      const rebuild = result as any;
      return (
        [`Rebuilt ${rebuild.rebuilt} note manifest entr${rebuild.rebuilt === 1 ? 'y' : 'ies'}.`, `Slugs: ${(rebuild.slugs || []).join(', ') || 'none'}`].join(
          '\n',
        ) + '\n'
      );
    }
    case 'get_note_section_entry': {
      const entry = result as any;
      return (
        [
          `${entry.heading_text} [depth ${entry.depth}]`,
          `Section: ${entry.section_id}`,
          `Page: ${entry.page_slug}`,
          `Path: ${entry.page_path}`,
          `Scope: ${entry.scope_id}`,
          `Heading path: ${(entry.heading_path || []).join(' / ') || 'none'}`,
          `Parent: ${entry.parent_section_id || 'none'}`,
          `Line range: ${entry.line_start}-${entry.line_end}`,
          `Wiki links: ${(entry.outgoing_wikilinks || []).join(', ') || 'none'}`,
          `URLs: ${(entry.outgoing_urls || []).join(', ') || 'none'}`,
          `Source refs: ${(entry.source_refs || []).join(', ') || 'none'}`,
          `Extractor: ${entry.extractor_version}`,
          `Last indexed: ${new Date(entry.last_indexed_at).toISOString()}`,
        ].join('\n') + '\n'
      );
    }
    case 'list_note_section_entries': {
      const entries = result as any[];
      if (entries.length === 0) return 'No note section entries.\n';
      const rows = entries.map((entry) => `${entry.section_id}\t${entry.line_start}-${entry.line_end}\t${entry.heading_text}`).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 50;
      if (entries.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'rebuild_note_sections': {
      const rebuild = result as any;
      return (
        [
          `Rebuilt ${rebuild.rebuilt} note section entr${rebuild.rebuilt === 1 ? 'y' : 'ies'}.`,
          `Sections: ${(rebuild.section_ids || []).join(', ') || 'none'}`,
        ].join('\n') + '\n'
      );
    }
    case 'get_note_structural_neighbors': {
      const edges = result as any[];
      if (edges.length === 0) return 'No structural neighbors.\n';
      const rows = edges.map((edge) => `${edge.edge_kind}\t${edge.from_node_id}\t${edge.to_node_id}`).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 20;
      if (edges.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'find_note_structural_path': {
      const path = result as any;
      if (!path || !Array.isArray(path.node_ids) || path.node_ids.length === 0) {
        return 'No structural path found.\n';
      }
      return [`Hop count: ${path.hop_count}`, `Nodes: ${(path.node_ids || []).join(' -> ')}`].join('\n') + '\n';
    }
    case 'build_context_map': {
      const map = result as any;
      return (
        [`Built context map: ${map.id}`, `Scope: ${map.scope_id}`, `Kind: ${map.kind}`, `Nodes: ${map.node_count}`, `Edges: ${map.edge_count}`].join('\n') +
        '\n'
      );
    }
    case 'get_context_map_entry': {
      const map = result as any;
      return (
        [
          `${map.title} [${map.kind}]`,
          `Id: ${map.id}`,
          `Scope: ${map.scope_id}`,
          `Mode: ${map.build_mode}`,
          `Status: ${map.status}`,
          `Source hash: ${map.source_set_hash}`,
          `Nodes: ${map.node_count}`,
          `Edges: ${map.edge_count}`,
          `Communities: ${map.community_count}`,
          `Generated: ${new Date(map.generated_at).toISOString()}`,
          `Stale reason: ${map.stale_reason || 'none'}`,
        ].join('\n') + '\n'
      );
    }
    case 'list_context_map_entries': {
      const entries = result as any[];
      if (entries.length === 0) return 'No context map entries.\n';
      const rows =
        entries
          .map(
            (entry) =>
              `${entry.id}\t${entry.kind}\t${entry.status}\t${entry.generated_at?.toString().slice(0, 19) || '?'}\t${entry.node_count}/${entry.edge_count}`,
          )
          .join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 20;
      if (entries.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'build_context_atlas': {
      const atlas = result as any;
      return (
        [
          `Built context atlas: ${atlas.id}`,
          `Map: ${atlas.map_id}`,
          `Scope: ${atlas.scope_id}`,
          `Freshness: ${atlas.freshness}`,
          `Entrypoints: ${(atlas.entrypoints || []).join(', ') || 'none'}`,
        ].join('\n') + '\n'
      );
    }
    case 'get_context_atlas_entry': {
      const atlas = result as any;
      return (
        [
          `${atlas.title} [${atlas.kind}]`,
          `Id: ${atlas.id}`,
          `Map: ${atlas.map_id}`,
          `Scope: ${atlas.scope_id}`,
          `Freshness: ${atlas.freshness}`,
          `Entrypoints: ${(atlas.entrypoints || []).join(', ') || 'none'}`,
          `Budget hint: ${atlas.budget_hint}`,
          `Generated: ${new Date(atlas.generated_at).toISOString()}`,
        ].join('\n') + '\n'
      );
    }
    case 'list_context_atlas_entries': {
      const entries = result as any[];
      if (entries.length === 0) return 'No context atlas entries.\n';
      const rows =
        entries
          .map((entry) => `${entry.id}\t${entry.kind}\t${entry.freshness}\t${entry.generated_at?.toString().slice(0, 19) || '?'}\t${entry.map_id}`)
          .join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 20;
      if (entries.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'select_context_atlas_entry': {
      const selection = result as any;
      if (!selection.entry) {
        return ['No context atlas entry selected.', `Reason: ${selection.reason}`, `Candidates: ${selection.candidate_count}`].join('\n') + '\n';
      }
      const atlas = selection.entry;
      return (
        [
          `Selected context atlas: ${atlas.id}`,
          `Reason: ${selection.reason}`,
          `Candidates: ${selection.candidate_count}`,
          `Map: ${atlas.map_id}`,
          `Scope: ${atlas.scope_id}`,
          `Freshness: ${atlas.freshness}`,
          `Budget hint: ${atlas.budget_hint}`,
        ].join('\n') + '\n'
      );
    }
    case 'get_context_atlas_overview': {
      const resultValue = result as any;
      if (!resultValue.overview) {
        return (
          ['No context atlas overview available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const overview = resultValue.overview;
      const reads = (overview.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`).join('\n');
      return (
        [
          `${overview.entry.title} [${overview.entry.kind}]`,
          `Atlas: ${overview.entry.id}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          `Freshness: ${overview.entry.freshness}`,
          `Overview kind: ${overview.overview_kind}`,
          `Recommended reads:`,
          reads || '- none',
        ].join('\n') + '\n'
      );
    }
    case 'get_context_atlas_report': {
      const resultValue = result as any;
      if (!resultValue.report) {
        return (
          ['No context atlas report available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const report = resultValue.report;
      return (
        [
          report.title,
          `Entry: ${report.entry_id}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...report.summary_lines,
          'Recommended reads:',
          ...report.recommended_reads.map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
        ].join('\n') + '\n'
      );
    }
    case 'get_atlas_orientation_card': {
      const resultValue = result as any;
      if (!resultValue.card) {
        return (
          ['No atlas orientation card available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const card = resultValue.card;
      return (
        [
          `${card.title} [atlas_orientation]`,
          `Atlas entry: ${card.atlas_entry_id}`,
          `Map: ${card.map_id}`,
          `Freshness: ${card.freshness}`,
          `Budget: ${card.budget_hint}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...(card.summary_lines || []),
          'Anchor slugs:',
          ...(card.anchor_slugs || []).map((item: any) => `- ${item}`),
          'Recommended reads:',
          ...(card.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
        ].join('\n') + '\n'
      );
    }
    case 'get_atlas_orientation_bundle': {
      const resultValue = result as any;
      if (!resultValue.bundle) {
        return (
          ['No atlas orientation bundle available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const bundle = resultValue.bundle;
      return (
        [
          `${bundle.title} [atlas_orientation]`,
          `Atlas entry: ${bundle.atlas_entry_id}`,
          `Freshness: ${bundle.freshness}`,
          `Budget: ${bundle.budget_hint}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...(bundle.summary_lines || []),
          `Report entry: ${bundle.report.entry_id}`,
          `Card entry: ${bundle.card.atlas_entry_id}`,
        ].join('\n') + '\n'
      );
    }
    case 'get_context_map_report': {
      const resultValue = result as any;
      if (!resultValue.report) {
        return ['No context map report available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n';
      }
      const report = resultValue.report;
      return (
        [
          report.title,
          `Map: ${report.map_id}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...report.summary_lines,
          'Recommended reads:',
          ...report.recommended_reads.map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
        ].join('\n') + '\n'
      );
    }
    case 'get_context_map_explanation': {
      const resultValue = result as any;
      if (!resultValue.explanation) {
        return (
          ['No context map explanation available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const explanation = resultValue.explanation;
      return (
        [
          explanation.title,
          `Map: ${explanation.map_id}`,
          `Node: ${explanation.node_id}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...explanation.summary_lines,
          'Neighbor edges:',
          ...(explanation.neighbor_edges || []).map((edge: any) => `- ${edge.edge_kind} | ${edge.from_node_id} -> ${edge.to_node_id}`),
          'Recommended reads:',
          ...(explanation.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
        ].join('\n') + '\n'
      );
    }
    case 'query_context_map': {
      const resultValue = result as any;
      if (!resultValue.result) {
        return (
          ['No context map query result available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const queryResult = resultValue.result;
      return (
        [
          `Context map query: ${queryResult.query}`,
          `Map: ${queryResult.map_id}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...queryResult.summary_lines,
          'Matched nodes:',
          ...(queryResult.matched_nodes || []).map((node: any) => `- ${node.node_id} | ${node.label} | score=${node.score}`),
          'Recommended reads:',
          ...(queryResult.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
        ].join('\n') + '\n'
      );
    }
    case 'find_context_map_path': {
      const resultValue = result as any;
      if (!resultValue.path) {
        return ['No context map path available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n';
      }
      const path = resultValue.path;
      return (
        [
          `Context map path: ${path.from_node_id} -> ${path.to_node_id}`,
          `Map: ${path.map_id}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...path.summary_lines,
          `Hop count: ${path.hop_count}`,
          `Nodes: ${(path.node_ids || []).join(' -> ')}`,
          'Edges:',
          ...(path.edges || []).map((edge: any) => `- ${edge.edge_kind} | ${edge.from_node_id} -> ${edge.to_node_id}`),
          'Recommended reads:',
          ...(path.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
        ].join('\n') + '\n'
      );
    }
    case 'get_broad_synthesis_route': {
      const resultValue = result as any;
      if (!resultValue.route) {
        return (
          ['No broad synthesis route available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const route = resultValue.route;
      return (
        [
          `Broad synthesis route: ${route.query}`,
          `Map: ${route.map_id}`,
          `Status: ${route.status}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...route.summary_lines,
          `Retrieval route: ${(route.retrieval_route || []).join(' -> ')}`,
          `Focal node: ${route.focal_node_id || 'none'}`,
          'Matched nodes:',
          ...(route.matched_nodes || []).map((node: any) => `- ${node.node_id} | ${node.label} | score=${node.score}`),
          'Recommended reads:',
          ...(route.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
        ].join('\n') + '\n'
      );
    }
    case 'get_precision_lookup_route': {
      const resultValue = result as any;
      if (!resultValue.route) {
        return (
          ['No precision lookup route available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const route = resultValue.route;
      return (
        [
          `Precision lookup route: ${route.slug}${route.section_id ? `#${route.section_id}` : ''}`,
          `Path: ${route.path}`,
          `Target kind: ${route.target_kind}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...route.summary_lines,
          `Retrieval route: ${(route.retrieval_route || []).join(' -> ')}`,
          'Recommended reads:',
          ...(route.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
        ].join('\n') + '\n'
      );
    }
    case 'select_retrieval_route': {
      const resultValue = result as any;
      if (!resultValue.route) {
        return (
          [
            'No retrieval route selected.',
            `Intent: ${resultValue.selected_intent}`,
            `Reason: ${resultValue.selection_reason}`,
            `Candidates: ${resultValue.candidate_count}`,
            `Trace: ${resultValue.trace?.id || 'none'}`,
          ].join('\n') + '\n'
        );
      }
      const route = resultValue.route;
      return (
        [
          `Retrieval route: ${resultValue.selected_intent}`,
          `Route kind: ${route.route_kind}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          `Trace: ${resultValue.trace?.id || 'none'}`,
          ...route.summary_lines,
          `Route steps: ${(route.retrieval_route || []).join(' -> ')}`,
        ].join('\n') + '\n'
      );
    }
    case 'retrieve_context': {
      const resultValue = result as any;
      const scopeGate = resultValue.scope_gate;
      return (
        [
          `Scenario: ${resultValue.scenario ?? 'unknown'}`,
          `Answerable from probe: ${resultValue.answerability?.answerable_from_probe ? 'yes' : 'no'}`,
          `Must read context: ${resultValue.answerability?.must_read_context ? 'yes' : 'no'}`,
          `Reason codes: ${formatCsv(resultValue.answerability?.reason_codes)}`,
          ...(scopeGate ? [`Scope gate: ${scopeGate.policy ?? 'unknown'} (${scopeGate.resolved_scope ?? 'unknown'})`] : []),
          'Required reads:',
          ...formatSelectorLines(resultValue.required_reads),
          `Read plan: mode=${resultValue.read_plan?.mode ?? 'none'} max_depth=${resultValue.read_plan?.max_depth ?? 'none'} selected=${resultValue.read_plan?.selected_selectors?.length ?? 0} deferred=${resultValue.read_plan?.deferred_candidate_ids?.length ?? 0} gaps=${formatCsv(resultValue.read_plan?.gap_reasons)}`,
          ...formatReadPlanActions(resultValue.read_plan),
          'Candidates:',
          ...formatCandidateLines(resultValue.candidates),
          `Candidate signal policy: mode=${resultValue.candidate_signal_policy?.mode ?? 'none'} included=${resultValue.candidate_signal_policy?.included_count ?? 0} suppressed=${resultValue.candidate_signal_policy?.suppressed_count ?? 0} reasons=${formatCsv(resultValue.candidate_signal_policy?.reason_codes)}`,
          'Candidate signals:',
          ...formatCandidateSignalLines(resultValue.candidate_signals),
          ...(resultValue.warnings?.length ? ['Warnings:', ...resultValue.warnings.map((warning: string) => `- ${warning}`)] : []),
          'Chunks are candidate pointers; call read_context before answering.',
          'Candidate signals are non-canonical; do not use them as answer evidence.',
        ].join('\n') + '\n'
      );
    }
    case 'read_context': {
      const resultValue = result as any;
      const scopeGate = resultValue.scope_gate;
      return (
        [
          `Answer ready: ${resultValue.answer_ready?.ready ? 'yes' : 'no'}`,
          `Citation policy: ${resultValue.answer_ready?.citation_policy ?? 'none'}`,
          `Unsupported reasons: ${formatCsv(resultValue.answer_ready?.unsupported_reasons)}`,
          ...(scopeGate ? [`Scope gate: ${scopeGate.policy ?? 'unknown'} (${scopeGate.resolved_scope ?? 'unknown'})`] : []),
          'Canonical reads:',
          ...formatCanonicalReadLines(resultValue.canonical_reads),
          'Continuations:',
          ...formatSelectorLines(resultValue.continuations),
          'Unread selectors:',
          ...formatSelectorLines(resultValue.unread_required),
          ...(resultValue.warnings?.length ? ['Warnings:', ...resultValue.warnings.map((warning: string) => `- ${warning}`)] : []),
        ].join('\n') + '\n'
      );
    }
    case 'proof_agent_memory': {
      const resultValue = result as any;
      return (
        [
          `Proof status: ${resultValue.status}`,
          `Generated: ${resultValue.generated_at}`,
          'Scenarios:',
          ...(resultValue.scenarios ?? []).map((scenario: any) => `${scenario.id}\t${scenario.status}\t${scenario.activation}\t${scenario.authority}`),
          'Memory why:',
          ...(resultValue.memory_why?.concise_lines ?? []),
          `Authority violations: ${formatCsv(resultValue.authority_violations) || 'none'}`,
          ...(params.verbose === true && resultValue.memory_why?.verbose
            ? [
                'Verbose:',
                `Selected selectors: ${formatCsv(resultValue.memory_why.verbose.selected_selectors)}`,
                `Omitted candidates: ${formatCsv(resultValue.memory_why.verbose.omitted_candidate_refs)}`,
                `Graph paths considered: ${formatCsv(resultValue.memory_why.verbose.graph_paths_considered)}`,
              ]
            : []),
        ].join('\n') + '\n'
      );
    }
    case 'get_workspace_system_card': {
      const resultValue = result as any;
      if (!resultValue.card) {
        return (
          ['No workspace system card available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const card = resultValue.card;
      return (
        [
          `${card.title} [workspace_system]`,
          `System: ${card.system_slug}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...(card.summary_lines || []),
          `Build: ${card.build_command || 'unavailable'}`,
          `Test: ${card.test_command || 'unavailable'}`,
          'Entry points:',
          ...(card.entry_points || []).map((item: any) => `- ${item.name} | ${item.path} | ${item.purpose}`),
        ].join('\n') + '\n'
      );
    }
    case 'get_workspace_project_card': {
      const resultValue = result as any;
      if (!resultValue.card) {
        return (
          ['No workspace project card available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const card = resultValue.card;
      return (
        [
          `${card.title} [workspace_project]`,
          `Project: ${card.project_slug}`,
          `Path: ${card.path}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...(card.summary_lines || []),
          `Repo: ${card.repo || 'unavailable'}`,
          `Status: ${card.status || 'unavailable'}`,
          'Related systems:',
          ...(card.related_systems || []).map((item: any) => `- ${item}`),
        ].join('\n') + '\n'
      );
    }
    case 'get_workspace_orientation_bundle': {
      const resultValue = result as any;
      if (!resultValue.bundle) {
        return (
          ['No workspace orientation bundle available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') +
          '\n'
        );
      }
      const bundle = resultValue.bundle;
      return (
        [
          `${bundle.title} [workspace_orientation]`,
          `Map: ${bundle.map_id}`,
          `Status: ${bundle.status}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...(bundle.summary_lines || []),
          `System card: ${bundle.system_card?.system_slug || 'none'}`,
          `Project card: ${bundle.project_card?.project_slug || 'none'}`,
          'Recommended reads:',
          ...(bundle.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
        ].join('\n') + '\n'
      );
    }
    case 'get_workspace_corpus_card': {
      const resultValue = result as any;
      if (!resultValue.card) {
        return (
          ['No workspace corpus card available.', `Reason: ${resultValue.selection_reason}`, `Candidates: ${resultValue.candidate_count}`].join('\n') + '\n'
        );
      }
      const card = resultValue.card;
      return (
        [
          `${card.title} [workspace_corpus]`,
          `Map: ${card.map_id}`,
          `Status: ${card.status}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          ...(card.summary_lines || []),
          'Anchor slugs:',
          ...(card.anchor_slugs || []).map((item: any) => `- ${item}`),
          'Recommended reads:',
          ...(card.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
        ].join('\n') + '\n'
      );
    }
    case 'search':
    case 'query': {
      const results = result as any[];
      if (results.length === 0) return 'No results.\n';
      return (
        results.map((r) => `[${r.score?.toFixed(4) || '?'}] ${r.slug} -- ${r.chunk_text?.slice(0, 100) || ''}${r.stale ? ' (stale)' : ''}`).join('\n') + '\n'
      );
    }
    case 'get_tags': {
      const tags = result as string[];
      return tags.length > 0 ? tags.join(', ') + '\n' : 'No tags.\n';
    }
    case 'get_stats': {
      const s = result as any;
      const lines = [
        `Pages:     ${s.page_count}`,
        `Chunks:    ${s.chunk_count}`,
        `Embedded:  ${s.embedded_count}`,
        `Links:     ${s.link_count}`,
        `Tags:      ${s.tag_count}`,
        `Timeline:  ${s.timeline_entry_count}`,
      ];
      if (s.pages_by_type) {
        lines.push('', 'By type:');
        for (const [k, v] of Object.entries(s.pages_by_type)) {
          lines.push(`  ${k}: ${v}`);
        }
      }
      return lines.join('\n') + '\n';
    }
    case 'get_health': {
      const h = result as any;
      const score = Math.max(
        0,
        10 - (h.missing_embeddings > 0 ? 2 : 0) - (h.stale_pages > 0 ? 1 : 0) - (h.dead_links > 0 ? 1 : 0) - (h.orphan_pages > 0 ? 1 : 0),
      );
      return (
        [
          `Health score: ${score}/10`,
          `Embed coverage: ${(h.embed_coverage * 100).toFixed(1)}%`,
          `Missing embeddings: ${h.missing_embeddings}`,
          `Stale pages: ${h.stale_pages}`,
          `Orphan pages: ${h.orphan_pages}`,
          `Dead links: ${h.dead_links}`,
        ].join('\n') + '\n'
      );
    }
    case 'get_timeline': {
      const entries = result as any[];
      if (entries.length === 0) return 'No timeline entries.\n';
      return entries.map((e) => `${e.date}  ${e.summary}${e.source ? ` [${e.source}]` : ''}`).join('\n') + '\n';
    }
    case 'get_versions': {
      const versions = result as any[];
      if (versions.length === 0) return 'No versions.\n';
      return versions.map((v) => `#${v.id}  ${v.snapshot_at?.toString().slice(0, 19) || '?'}  ${v.compiled_truth?.slice(0, 60) || ''}...`).join('\n') + '\n';
    }
    case 'sync_brain': {
      const sync = result as any;
      if (Array.isArray(sync.targets)) {
        const lines = [
          sync.status === 'dry_run'
            ? 'Sub-brain sync dry run:'
            : sync.status === 'up_to_date'
              ? 'Sub-brain sync complete: already up to date'
              : 'Sub-brain sync complete:',
        ];
        for (const target of sync.targets) {
          lines.push(
            `  ${target.id}: ${target.status} @ ${String(target.toCommit ?? '').slice(0, 8) || '?'}` +
              ` (+${target.added} ~${target.modified} -${target.deleted} R${target.renamed}, ${target.chunksCreated} chunks)`,
          );
        }
        lines.push(
          `Total: +${sync.added} added, ~${sync.modified} modified, -${sync.deleted} deleted, R${sync.renamed} renamed`,
          `${sync.chunksCreated} chunks created`,
        );
        return lines.join('\n') + '\n';
      }
      switch (sync.status) {
        case 'up_to_date':
          return 'Already up to date.\n';
        case 'synced':
          return (
            [
              sync.fromCommit ? `Synced ${sync.fromCommit.slice(0, 8)}..${sync.toCommit.slice(0, 8)}:` : `Synced to ${sync.toCommit.slice(0, 8)}:`,
              `  +${sync.added} added, ~${sync.modified} modified, -${sync.deleted} deleted, R${sync.renamed} renamed`,
              `  ${sync.chunksCreated} chunks created`,
            ].join('\n') + '\n'
          );
        case 'first_sync':
          return `First sync complete. Checkpoint: ${sync.toCommit.slice(0, 8)}\n`;
        case 'dry_run':
          return '';
      }
      return JSON.stringify(result, null, 2) + '\n';
    }
    case 'resume_task': {
      const resume = result as any;
      return (
        [
          `${resume.title} [${resume.status}]`,
          `Goal: ${resume.goal}`,
          `Summary: ${resume.current_summary}`,
          `Active paths: ${(resume.active_paths || []).join(', ') || 'none'}`,
          `Active symbols: ${(resume.active_symbols || []).join(', ') || 'none'}`,
          `Blockers: ${(resume.blockers || []).join(', ') || 'none'}`,
          `Open questions: ${(resume.open_questions || []).join(', ') || 'none'}`,
          `Next steps: ${(resume.next_steps || []).join(', ') || 'none'}`,
          `Failed attempts: ${(resume.failed_attempts || []).join(', ') || 'none'}`,
          `Decisions: ${(resume.active_decisions || []).join(', ') || 'none'}`,
          `Repeated-work warnings: ${(resume.repeated_work_warnings || []).join(', ') || 'none'}`,
          `Decision reuse: ${(resume.decision_reuse || []).join(', ') || 'none'}`,
          `Verification warnings: ${(resume.verification_warnings || []).join(', ') || 'none'}`,
          `Trace template: ${resume.retrieval_trace_template?.selected_intent || 'none'}`,
          `Latest trace route: ${(resume.latest_trace_route || []).join(' -> ') || 'none'}`,
          `Code claims: ${formatCodeClaimVerificationSummary(resume.code_claim_verification || [])}`,
          `State: ${resume.stale ? 'stale' : 'fresh'}`,
        ].join('\n') + '\n'
      );
    }
    case 'get_task_working_set': {
      const state = result as any;
      const task = state.thread;
      const workingSet = state.working_set;
      return (
        [
          `${task.title} [${task.status}]`,
          `Scope: ${task.scope}`,
          `Goal: ${task.goal}`,
          `Summary: ${task.current_summary}`,
          `Active paths: ${(workingSet?.active_paths || []).join(', ') || 'none'}`,
          `Active symbols: ${(workingSet?.active_symbols || []).join(', ') || 'none'}`,
          `Blockers: ${(workingSet?.blockers || []).join(', ') || 'none'}`,
          `Open questions: ${(workingSet?.open_questions || []).join(', ') || 'none'}`,
          `Next steps: ${(workingSet?.next_steps || []).join(', ') || 'none'}`,
          `Verification notes: ${(workingSet?.verification_notes || []).join(', ') || 'none'}`,
          `Last verified: ${workingSet?.last_verified_at ? new Date(workingSet.last_verified_at).toISOString() : 'never'}`,
        ].join('\n') + '\n'
      );
    }
    default:
      return JSON.stringify(result, null, 2) + '\n';
  }
}

function formatCsv(values: unknown): string {
  return Array.isArray(values) && values.length > 0 ? values.join(', ') : 'none';
}

function formatSelectorLines(selectors: unknown): string[] {
  if (!Array.isArray(selectors) || selectors.length === 0) return ['- none'];
  return selectors.map((selector) => {
    const value = selector as Record<string, unknown>;
    return `- ${formatSelectorId(value)} [${String(value.kind ?? 'unknown')}]`;
  });
}

function formatReadPlanActions(readPlan: unknown): string[] {
  const value = readPlan as Record<string, unknown> | undefined;
  const actions = value?.next_actions;
  if (!Array.isArray(actions) || actions.length === 0) return [];
  return ['Read plan next actions:', ...actions.map((action) => `- ${String(action)}`)];
}

function formatSelectorId(selector: Record<string, unknown>): string {
  if (typeof selector.selector_id === 'string' && selector.selector_id.length > 0) {
    return selector.selector_id;
  }
  return (
    [selector.kind, selector.scope_id, selector.slug ?? selector.section_id ?? selector.source_ref ?? selector.object_id]
      .filter((part) => part !== undefined && part !== null && part !== '')
      .join(':') || 'unknown'
  );
}

function formatCandidateLines(candidates: unknown): string[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return ['- none'];
  return candidates.map((candidate) => {
    const value = candidate as Record<string, any>;
    const target = value.canonical_target ?? {};
    const selector = value.read_selector ?? {};
    const chunks = Array.isArray(value.matched_chunks) ? value.matched_chunks : [];
    const topScore = typeof chunks[0]?.score === 'number' ? chunks[0].score.toFixed(4) : '?';
    const targetLabel = target.slug ?? target.section_id ?? target.path ?? target.title ?? 'unknown';
    return [
      `- ${value.candidate_id ?? 'candidate'} -> ${formatSelectorId(selector)}`,
      `[${selector.kind ?? target.kind ?? 'unknown'} target=${targetLabel} activation=${value.activation ?? 'unknown'} score=${topScore}]`,
    ].join(' ');
  });
}

function formatCandidateSignalLines(signals: unknown): string[] {
  if (!Array.isArray(signals) || signals.length === 0) return ['- none'];
  return signals.map((signal) => {
    const value = signal as Record<string, any>;
    const target = value.target_object_id ?? value.target_object_type ?? 'unknown';
    const score = typeof value.score === 'number' ? value.score.toFixed(4) : '?';
    return `- ${value.candidate_id ?? 'candidate'} [status=${value.status ?? 'unknown'} target=${target} authority=${value.authority ?? 'unknown'} relation=${value.relation_to_canonical ?? 'unknown'} score=${score} promotion=${value.promotion_hint ?? 'unknown'} disposition=${value.disposition_hint ?? 'unknown'}] ${value.summary ?? ''}`.trim();
  });
}

function formatCanonicalReadLines(reads: unknown): string[] {
  if (!Array.isArray(reads) || reads.length === 0) return ['- none'];
  return reads.flatMap((read) => {
    const value = read as Record<string, any>;
    const selector = value.selector ?? {};
    const sourceRefs = Array.isArray(value.source_refs) ? value.source_refs : [];
    const text = String(value.text ?? '').trim();
    return [
      `Read: ${value.title ?? 'unknown'} [${value.authority ?? 'unknown'} tokens=${value.token_estimate ?? '?'} has_more=${value.has_more ? 'yes' : 'no'}]`,
      `Selector: ${formatSelectorId(selector)}`,
      `Source refs: ${sourceRefs.join(', ') || 'none'}`,
      text,
    ].filter((line) => line.length > 0);
  });
}

function formatCodeClaimVerificationSummary(
  results: Array<{
    claim?: { path?: string; symbol?: string; source_trace_id?: string };
    status?: string;
    reason?: string;
  }>,
): string {
  if (results.length === 0) return 'none';
  return results
    .map((result) =>
      [
        result.status ?? 'unknown',
        result.claim?.path ?? (result.claim?.symbol ? `symbol:${result.claim.symbol}` : 'unknown'),
        result.claim?.path && result.claim?.symbol ? result.claim.symbol : undefined,
        result.reason ?? 'unknown',
        result.claim?.source_trace_id,
      ]
        .filter((part) => part !== undefined && part !== '')
        .join(':'),
    )
    .join(', ');
}

// --- Operation modules ---

const [get_page, explain_page_provenance, delete_page, list_pages] = createPageOperations();
const [put_page, admin_put_page] = createPutPageOperations();
const [search, query, resolve_slugs, get_chunks] = createSearchOperations();
const [add_tag, remove_tag, get_tags, add_link, remove_link, get_links, get_backlinks, traverse_graph, add_timeline_entry, get_timeline] = createTagsLinksTimelineOperations();
const [get_stats, get_health, list_compile_debt, get_anticipation_pack, get_versions, revert_version] = createVersionsOperations();
const [
  get_profile_memory_entry,
  list_profile_memory_entries,
  upsert_profile_memory_entry,
  delete_profile_memory_entry,
  write_profile_memory_entry,
  get_personal_episode_entry,
  list_personal_episode_entries,
  record_personal_episode,
  delete_personal_episode_entry,
  write_personal_episode_entry,
] = createProfileEpisodeOperations();
const [get_note_section_entry, list_note_section_entries, rebuild_note_sections, get_note_structural_neighbors, find_note_structural_path] = createNoteSectionOperations();
const [
  build_context_map,
  get_context_map_entry,
  list_context_map_entries,
  get_context_map_report,
  get_context_map_explanation,
  query_context_map,
  find_context_map_path,
  build_context_atlas,
  get_context_atlas_entry,
  list_context_atlas_entries,
  select_context_atlas_entry,
  get_context_atlas_overview,
  get_context_atlas_report,
  get_atlas_orientation_card,
  get_atlas_orientation_bundle,
] = createContextMapOperations();
const [
  get_broad_synthesis_route,
  get_precision_lookup_route,
  get_mixed_scope_bridge,
  get_mixed_scope_disclosure,
  get_personal_profile_lookup_route,
  get_personal_episode_lookup_route,
  select_personal_write_target,
  preview_personal_export,
  evaluate_scope_gate,
  select_retrieval_route,
  plan_retrieval_request,
  retrieve_context,
  read_context,
  classify_memory_scenario,
  select_activation_policy,
  proof_agent_memory,
  plan_scenario_memory_request,
  reverify_code_claims,
  get_workspace_system_card,
  get_workspace_project_card,
  get_workspace_orientation_bundle,
  get_workspace_corpus_card,
] = createRetrievalOperations();
const [sync_brain, put_raw_data, get_raw_data, rerun_memory_job, log_ingest, get_ingest_log, file_list, file_upload, file_url, get_skillpack] = createMiscOperations();

const memoryInboxOperations = createMemoryInboxOperations({
  defaultScopeId: DEFAULT_MEMORY_INBOX_SCOPE_ID,
  OperationError,
  syncBrainHandler: sync_brain.handler,
});

const memoryWritebackRouterOperations = createMemoryWritebackRouterOperations({
  defaultScopeId: DEFAULT_MEMORY_INBOX_SCOPE_ID,
  OperationError,
});

const canonicalTargetProposalOperations = createCanonicalTargetProposalOperations({
  defaultScopeId: DEFAULT_MEMORY_INBOX_SCOPE_ID,
  OperationError,
});

const brainLoopAuditOperations = createBrainLoopAuditOperations({
  OperationError,
});

const memoryMutationLedgerOperations = createMemoryMutationLedgerOperations({
  OperationError,
  allowPrivilegedLedgerRecord: () => process.env.MBRAIN_ENABLE_PRIVILEGED_LEDGER_RECORD === '1',
});

const memoryControlPlaneOperations = createMemoryControlPlaneOperations({
  OperationError,
});

const noteManifestOperations = createNoteManifestOperations({ OperationError });

const taskOperations = createTaskOperations({ OperationError });

const proceduralMemoryOperations = createProceduralMemoryOperations({ OperationError });

const sourceRegistryOperations = createSourceRegistryOperations({
  OperationError,
});

const agentSessionMemoryOperations = createAgentSessionMemoryOperations({
  OperationError,
});

const agentSessionActivationOperations = createAgentSessionActivationOperations({
  OperationError,
});

const assertionOperations = createAssertionOperations({
  OperationError,
});

const lifecycleForgettingOperations = createLifecycleForgettingOperations({
  OperationError,
});

// --- Exports ---

export const operations: Operation[] = [
  // Page CRUD
  get_page,
  explain_page_provenance,
  put_page,
  admin_put_page,
  delete_page,
  list_pages,
  // Search
  search,
  query,
  // Tags
  add_tag,
  remove_tag,
  get_tags,
  // Links
  add_link,
  remove_link,
  get_links,
  get_backlinks,
  traverse_graph,
  // Timeline
  add_timeline_entry,
  get_timeline,
  // Admin
  get_stats,
  get_health,
  list_compile_debt,
  get_anticipation_pack,
  get_versions,
  revert_version,
  // Sync
  sync_brain,
  // Raw data
  put_raw_data,
  get_raw_data,
  // Source registry and raw ingest provenance
  ...sourceRegistryOperations,
  // Agent session memory capture
  ...agentSessionMemoryOperations,
  ...agentSessionActivationOperations,
  // Assertion pipeline and session grants
  ...assertionOperations,
  // Lifecycle forgetting audit, restore, and purge planning
  ...lifecycleForgettingOperations,
  // Resolution & chunks
  resolve_slugs,
  get_chunks,
  // Profile memory
  get_profile_memory_entry,
  list_profile_memory_entries,
  upsert_profile_memory_entry,
  delete_profile_memory_entry,
  ...memoryInboxOperations,
  ...memoryWritebackRouterOperations,
  ...canonicalTargetProposalOperations,
  write_profile_memory_entry,
  // Personal episodes
  get_personal_episode_entry,
  list_personal_episode_entries,
  record_personal_episode,
  delete_personal_episode_entry,
  write_personal_episode_entry,
  // Note manifest
  ...noteManifestOperations,
  // Note sections
  get_note_section_entry,
  list_note_section_entries,
  rebuild_note_sections,
  // Structural graph
  get_note_structural_neighbors,
  find_note_structural_path,
  // Persisted context maps
  build_context_map,
  get_context_map_entry,
  list_context_map_entries,
  get_context_map_report,
  get_context_map_explanation,
  query_context_map,
  find_context_map_path,
  get_broad_synthesis_route,
  get_precision_lookup_route,
  get_mixed_scope_bridge,
  get_mixed_scope_disclosure,
  get_personal_profile_lookup_route,
  get_personal_episode_lookup_route,
  select_personal_write_target,
  preview_personal_export,
  evaluate_scope_gate,
  select_retrieval_route,
  plan_retrieval_request,
  retrieve_context,
  read_context,
  classify_memory_scenario,
  select_activation_policy,
  proof_agent_memory,
  plan_scenario_memory_request,
  reverify_code_claims,
  get_workspace_system_card,
  get_workspace_project_card,
  get_workspace_orientation_bundle,
  get_workspace_corpus_card,
  // Context atlas registry
  build_context_atlas,
  get_context_atlas_entry,
  list_context_atlas_entries,
  select_context_atlas_entry,
  get_context_atlas_overview,
  get_context_atlas_report,
  get_atlas_orientation_card,
  get_atlas_orientation_bundle,
  // Operational memory
  ...taskOperations,
  // Procedural memory loop (deterministic recurrence detection -> procedure lane)
  ...proceduralMemoryOperations,
  ...brainLoopAuditOperations,
  ...memoryMutationLedgerOperations,
  ...memoryControlPlaneOperations,
  rerun_memory_job,
  // Ingest log
  log_ingest,
  get_ingest_log,
  // Files
  file_list,
  file_upload,
  file_url,
  // Skillpack
  get_skillpack,
];

export const operationsByName = Object.fromEntries(operations.map((op) => [op.name, op])) as Record<string, Operation>;
