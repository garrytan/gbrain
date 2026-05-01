/**
 * Contract-first operation definitions. Single source of truth for CLI, MCP, and tools-json.
 * Each operation defines its schema, handler, and optional CLI hints.
 */

import { randomUUID } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import type { BrainEngine } from './engine.ts';
import type { MBrainConfig } from './config.ts';
import { importFromContent, importFromFile, MAX_MARKDOWN_IMPORT_BYTES } from './import-file.ts';
import { parseMarkdown, serializeMarkdown } from './markdown.ts';
import { slugifyPath } from './sync.ts';
import { findSlugQualityIssues } from './slug-quality.ts';
import { hybridSearch } from './search/hybrid.ts';
import { expandQuery } from './search/expansion.ts';
import { rankSearchResults, sourceRankCandidateLimit } from './search/source-ranking.ts';
import {
  buildStructuralContextAtlasEntry,
  getStructuralContextAtlasEntry,
  listStructuralContextAtlasEntries,
  selectStructuralContextAtlasEntry,
} from './services/context-atlas-service.ts';
import { getAtlasOrientationCard } from './services/atlas-orientation-card-service.ts';
import { getAtlasOrientationBundle } from './services/atlas-orientation-bundle-service.ts';
import { createBrainLoopAuditOperations } from './operations-brain-loop-audit.ts';
import { createMemoryInboxOperations, DEFAULT_MEMORY_INBOX_SCOPE_ID } from './operations-memory-inbox.ts';
import { createMemoryControlPlaneOperations } from './operations-memory-control-plane.ts';
import { createMemoryMutationLedgerOperations } from './operations-memory-mutation-ledger.ts';
import { assertMemoryWriteAllowed, MemoryAccessPolicyError } from './services/memory-access-policy-service.ts';
import { recordMemoryMutationEvent } from './services/memory-mutation-ledger-service.ts';
import { getStructuralContextAtlasOverview } from './services/context-atlas-overview-service.ts';
import { getStructuralContextAtlasReport } from './services/context-atlas-report-service.ts';
import { getBroadSynthesisRoute } from './services/broad-synthesis-route-service.ts';
import { getMixedScopeBridge } from './services/mixed-scope-bridge-service.ts';
import { getMixedScopeDisclosure } from './services/mixed-scope-disclosure-service.ts';
import { getStructuralContextMapExplanation } from './services/context-map-explain-service.ts';
import { findStructuralContextMapPath } from './services/context-map-path-service.ts';
import { queryStructuralContextMap } from './services/context-map-query-service.ts';
import { getStructuralContextMapReport } from './services/context-map-report-service.ts';
import { DEFAULT_PERSONAL_EPISODE_SCOPE_ID, getPersonalEpisodeLookupRoute } from './services/personal-episode-lookup-route-service.ts';
import { previewPersonalExport } from './services/personal-export-visibility-service.ts';
import { DEFAULT_PROFILE_MEMORY_SCOPE_ID, getPersonalProfileLookupRoute } from './services/personal-profile-lookup-route-service.ts';
import { selectPersonalWriteTarget } from './services/personal-write-target-service.ts';
import { getPrecisionLookupRoute } from './services/precision-lookup-route-service.ts';
import { evaluateScopeGate } from './services/scope-gate-service.ts';
import { planRetrievalRequest } from './services/retrieval-request-planner-service.ts';
import { selectRetrievalRoute } from './services/retrieval-route-selector-service.ts';
import { selectActivationPolicy } from './services/memory-activation-policy-service.ts';
import { classifyMemoryScenario } from './services/memory-scenario-classifier-service.ts';
import { planScenarioMemoryRequest } from './services/scenario-memory-request-planner-service.ts';
import { getWorkspaceCorpusCard } from './services/workspace-corpus-card-service.ts';
import { getWorkspaceOrientationBundle } from './services/workspace-orientation-bundle-service.ts';
import { getWorkspaceProjectCard } from './services/workspace-project-card-service.ts';
import { getWorkspaceSystemCard } from './services/workspace-system-card-service.ts';
import {
  buildStructuralContextMapEntry,
  getStructuralContextMapEntry,
  listStructuralContextMapEntries,
} from './services/context-map-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID, rebuildNoteManifestEntries } from './services/note-manifest-service.ts';
import { findStructuralPath, getStructuralNeighbors, type StructuralNodeId } from './services/note-structural-graph-service.ts';
import { rebuildNoteSectionEntries } from './services/note-section-service.ts';
import { buildTaskResumeCard } from './services/task-memory-service.ts';
import {
  extractCodeClaimsFromTrace,
  parseCodeClaimVerificationEntry,
  verifyCodeClaims,
} from './services/code-claim-verification-service.ts';
import * as db from './db.ts';
import { getUnsupportedCapabilityReason } from './offline-profile.ts';
import type {
  CodeClaim,
  MemoryActivationArtifact,
  MemoryArtifactKind,
  MemoryScenario,
  MemoryScenarioKnownSubject,
  MemoryScenarioKnownSubjectKind,
  MemoryScenarioSourceKind,
  PersonalEpisodeSourceKind,
  ProfileMemoryType,
  RetrievalRequestPlannerInput,
  RetrievalRouteIntent,
  RetrievalTrace,
  RetrievalTraceWriteOutcome,
  ScopeGatePolicy,
} from './types.ts';
import { importContentHash, validateSlug } from './utils.ts';

// --- MCP server instructions ---
//
// Returned to MCP clients in the `instructions` field of `InitializeResult`.
// Clients render this near the top of the agent's system prompt, so agents see
// it before they decide which tools to call. See docs/MCP_INSTRUCTIONS.md for
// the design rationale.
export const MCP_INSTRUCTIONS = [
  'Use this server to look up knowledge about people, companies, technical concepts, internal systems, and organizational context. Prefer this over web search or codebase grep when the question involves a named entity, domain concept, or cross-system architecture. The brain contains compiled truth, relationship history, and technical maps that external search cannot provide.',
  'Do not use for: code editing, git operations, file management, library documentation, or general programming.',
].join('\n\n');

// --- Types ---

function structuralNodeId(value: string): StructuralNodeId {
  return value as StructuralNodeId;
}

export type ErrorCode =
  | 'page_not_found'
  | 'task_not_found'
  | 'trace_not_found'
  | 'memory_candidate_not_found'
  | 'invalid_params'
  | 'embedding_failed'
  | 'storage_error'
  | 'write_conflict'
  | 'bucket_not_found'
  | 'database_error'
  | 'unsupported_capability';

export class OperationError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion?: string,
    public docs?: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      suggestion: this.suggestion,
      docs: this.docs,
    };
  }
}

export type ParamType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface ParamDef {
  type: ParamType | ParamType[];
  required?: boolean;
  nullable?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  items?: ParamDef;
}

function paramHasType(paramDef: ParamDef | undefined, type: ParamType): boolean {
  if (!paramDef) return false;
  return Array.isArray(paramDef.type) ? paramDef.type.includes(type) : paramDef.type === type;
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
}

export interface Operation {
  name: string;
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;
  cliHints?: {
    name?: string;
    positional?: string[];
    stdin?: string;
    hidden?: boolean;
    aliases?: Record<string, string>;
  };
}

const RETRIEVAL_TRACE_WRITE_OUTCOMES = [
  'no_durable_write',
  'operational_write',
  'candidate_created',
  'promoted',
  'rejected',
  'superseded',
] as const satisfies readonly RetrievalTraceWriteOutcome[];

const RETRIEVAL_ROUTE_INTENTS = [
  'task_resume',
  'broad_synthesis',
  'precision_lookup',
  'mixed_scope_bridge',
  'personal_profile_lookup',
  'personal_episode_lookup',
] as const satisfies readonly RetrievalRouteIntent[];

const REQUESTED_SCOPES = [
  'work',
  'personal',
  'mixed',
] as const;

const PROFILE_MEMORY_TYPES = [
  'preference',
  'routine',
  'personal_project',
  'stable_fact',
  'relationship_boundary',
  'other',
] as const satisfies readonly ProfileMemoryType[];

const PERSONAL_EPISODE_SOURCE_KINDS = [
  'chat',
  'note',
  'import',
  'meeting',
  'reminder',
  'other',
] as const satisfies readonly PersonalEpisodeSourceKind[];

const PERSONAL_ROUTE_KINDS = [
  'profile',
  'episode',
] as const;

const SCOPE_GATE_POLICIES = [
  'allow',
  'defer',
  'deny',
] as const satisfies readonly ScopeGatePolicy[];

const MEMORY_SCENARIOS = [
  'coding_continuation',
  'project_qa',
  'knowledge_qa',
  'auto_accumulation',
  'personal_recall',
  'mixed',
] as const satisfies readonly MemoryScenario[];

const MEMORY_SCENARIO_SOURCE_KINDS = [
  'chat',
  'code_event',
  'import',
  'meeting',
  'cron',
  'manual',
  'session_end',
  'trace_review',
] as const satisfies readonly MemoryScenarioSourceKind[];

const MEMORY_SCENARIO_KNOWN_SUBJECT_KINDS = [
  'project',
  'system',
  'concept',
  'person',
  'company',
  'source',
  'file',
  'symbol',
  'task',
  'profile',
  'personal_episode',
] as const satisfies readonly MemoryScenarioKnownSubjectKind[];

const MEMORY_ARTIFACT_KINDS = [
  'current_artifact',
  'compiled_truth',
  'timeline',
  'source_record',
  'context_map',
  'codemap_pointer',
  'task_attempt_failed',
  'task_decision',
  'memory_candidate',
  'profile_memory',
  'personal_episode',
] as const satisfies readonly MemoryArtifactKind[];

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

export function parseOpArgs(
  op: Pick<Operation, 'params' | 'cliHints'>,
  args: string[],
  options: ParseOpArgsOptions = {},
): Record<string, unknown> {
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
      params[key] = paramHasType(paramDef, 'number') ? coerceNumber(key, value) : value;
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
      params[key] = paramHasType(paramDef, 'number') ? coerceNumber(key, value) : value;
      continue;
    }

    if (posIdx < positional.length) {
      const key = positional[posIdx++];
      const paramDef = op.params[key];
      params[key] = paramHasType(paramDef, 'number') ? coerceNumber(key, arg) : arg;
    }
  }

  if (op.cliHints?.stdin && !params[op.cliHints.stdin] && !stdin.isTTY) {
    params[op.cliHints.stdin] = stdin.read();
  }

  return params;
}

export function getMissingRequiredParams(
  op: Pick<Operation, 'params'>,
  params: Record<string, unknown>,
): string[] {
  return Object.entries(op.params)
    .filter(([, def]) => def.required)
    .filter(([key]) => params[key] === undefined)
    .map(([key]) => key);
}

export function formatOpUsage(op: Pick<Operation, 'name' | 'cliHints'>): string {
  const positional = (op.cliHints?.positional || []).map(p => `<${p}>`).join(' ');
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

export function formatResult(
  opName: string,
  result: unknown,
  params: Record<string, unknown> = {},
): string {
  switch (opName) {
    case 'get_page': {
      const r = result as any;
      if (r.error === 'ambiguous_slug') {
        return `Ambiguous slug. Did you mean:\n${r.candidates.map((c: string) => `  ${c}`).join('\n')}\n`;
      }
      return serializeMarkdown(r.frontmatter || {}, r.compiled_truth || '', r.timeline || '', {
        type: r.type, title: r.title, tags: r.tags || [],
      });
    }
    case 'list_pages': {
      const pages = result as any[];
      if (pages.length === 0) return 'No pages found.\n';
      const rows = pages.map(p =>
        `${p.slug}\t${p.type}\t${p.updated_at?.toString().slice(0, 10) || '?'}\t${p.title}`,
      ).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 50;
      if (pages.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'list_tasks': {
      const tasks = result as any[];
      if (tasks.length === 0) return 'No tasks.\n';
      const rows = tasks.map(task =>
        `${task.id}\t${task.status}\t${task.scope}\t${task.title}`,
      ).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 20;
      if (tasks.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'list_task_traces': {
      const traces = result as any[];
      if (traces.length === 0) return 'No traces.\n';
      const rows = traces.map(trace =>
        `${trace.id}\t${trace.created_at?.toString().slice(0, 19) || '?'}\t${(trace.route || []).join(' -> ')}\t${trace.outcome}`,
      ).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 10;
      if (traces.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'list_task_attempts': {
      const attempts = result as any[];
      if (attempts.length === 0) return 'No attempts.\n';
      const rows = attempts.map(attempt =>
        `${attempt.id}\t${attempt.outcome}\t${attempt.created_at?.toString().slice(0, 19) || '?'}\t${attempt.summary}`,
      ).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 10;
      if (attempts.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'list_task_decisions': {
      const decisions = result as any[];
      if (decisions.length === 0) return 'No decisions.\n';
      const rows = decisions.map(decision =>
        `${decision.id}\t${decision.created_at?.toString().slice(0, 19) || '?'}\t${decision.summary}\t${decision.rationale}`,
      ).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 10;
      if (decisions.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'get_note_manifest_entry': {
      const entry = result as any;
      return [
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
      ].join('\n') + '\n';
    }
    case 'list_note_manifest_entries': {
      const entries = result as any[];
      if (entries.length === 0) return 'No note manifest entries.\n';
      const rows = entries.map((entry) =>
        `${entry.slug}\t${entry.page_type}\t${entry.last_indexed_at?.toString().slice(0, 19) || '?'}\t${entry.title}`,
      ).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 20;
      if (entries.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'rebuild_note_manifest': {
      const rebuild = result as any;
      return [
        `Rebuilt ${rebuild.rebuilt} note manifest entr${rebuild.rebuilt === 1 ? 'y' : 'ies'}.`,
        `Slugs: ${(rebuild.slugs || []).join(', ') || 'none'}`,
      ].join('\n') + '\n';
    }
    case 'get_note_section_entry': {
      const entry = result as any;
      return [
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
      ].join('\n') + '\n';
    }
    case 'list_note_section_entries': {
      const entries = result as any[];
      if (entries.length === 0) return 'No note section entries.\n';
      const rows = entries.map((entry) =>
        `${entry.section_id}\t${entry.line_start}-${entry.line_end}\t${entry.heading_text}`,
      ).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 50;
      if (entries.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'rebuild_note_sections': {
      const rebuild = result as any;
      return [
        `Rebuilt ${rebuild.rebuilt} note section entr${rebuild.rebuilt === 1 ? 'y' : 'ies'}.`,
        `Sections: ${(rebuild.section_ids || []).join(', ') || 'none'}`,
      ].join('\n') + '\n';
    }
    case 'get_note_structural_neighbors': {
      const edges = result as any[];
      if (edges.length === 0) return 'No structural neighbors.\n';
      const rows = edges.map((edge) =>
        `${edge.edge_kind}\t${edge.from_node_id}\t${edge.to_node_id}`,
      ).join('\n') + '\n';
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
      return [
        `Hop count: ${path.hop_count}`,
        `Nodes: ${(path.node_ids || []).join(' -> ')}`,
      ].join('\n') + '\n';
    }
    case 'build_context_map': {
      const map = result as any;
      return [
        `Built context map: ${map.id}`,
        `Scope: ${map.scope_id}`,
        `Kind: ${map.kind}`,
        `Nodes: ${map.node_count}`,
        `Edges: ${map.edge_count}`,
      ].join('\n') + '\n';
    }
    case 'get_context_map_entry': {
      const map = result as any;
      return [
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
      ].join('\n') + '\n';
    }
    case 'list_context_map_entries': {
      const entries = result as any[];
      if (entries.length === 0) return 'No context map entries.\n';
      const rows = entries.map((entry) =>
        `${entry.id}\t${entry.kind}\t${entry.status}\t${entry.generated_at?.toString().slice(0, 19) || '?'}\t${entry.node_count}/${entry.edge_count}`,
      ).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 20;
      if (entries.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'build_context_atlas': {
      const atlas = result as any;
      return [
        `Built context atlas: ${atlas.id}`,
        `Map: ${atlas.map_id}`,
        `Scope: ${atlas.scope_id}`,
        `Freshness: ${atlas.freshness}`,
        `Entrypoints: ${(atlas.entrypoints || []).join(', ') || 'none'}`,
      ].join('\n') + '\n';
    }
    case 'get_context_atlas_entry': {
      const atlas = result as any;
      return [
        `${atlas.title} [${atlas.kind}]`,
        `Id: ${atlas.id}`,
        `Map: ${atlas.map_id}`,
        `Scope: ${atlas.scope_id}`,
        `Freshness: ${atlas.freshness}`,
        `Entrypoints: ${(atlas.entrypoints || []).join(', ') || 'none'}`,
        `Budget hint: ${atlas.budget_hint}`,
        `Generated: ${new Date(atlas.generated_at).toISOString()}`,
      ].join('\n') + '\n';
    }
    case 'list_context_atlas_entries': {
      const entries = result as any[];
      if (entries.length === 0) return 'No context atlas entries.\n';
      const rows = entries.map((entry) =>
        `${entry.id}\t${entry.kind}\t${entry.freshness}\t${entry.generated_at?.toString().slice(0, 19) || '?'}\t${entry.map_id}`,
      ).join('\n') + '\n';
      const requestedLimit = (params.limit as number) ?? 20;
      if (entries.length >= requestedLimit) {
        return rows + `\n(result may be truncated at ${requestedLimit}; pass --limit N or -n N to change)\n`;
      }
      return rows;
    }
    case 'select_context_atlas_entry': {
      const selection = result as any;
      if (!selection.entry) {
        return [
          'No context atlas entry selected.',
          `Reason: ${selection.reason}`,
          `Candidates: ${selection.candidate_count}`,
        ].join('\n') + '\n';
      }
      const atlas = selection.entry;
      return [
        `Selected context atlas: ${atlas.id}`,
        `Reason: ${selection.reason}`,
        `Candidates: ${selection.candidate_count}`,
        `Map: ${atlas.map_id}`,
        `Scope: ${atlas.scope_id}`,
        `Freshness: ${atlas.freshness}`,
        `Budget hint: ${atlas.budget_hint}`,
      ].join('\n') + '\n';
    }
    case 'get_context_atlas_overview': {
      const resultValue = result as any;
      if (!resultValue.overview) {
        return [
          'No context atlas overview available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const overview = resultValue.overview;
      const reads = (overview.recommended_reads || [])
        .map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`)
        .join('\n');
      return [
        `${overview.entry.title} [${overview.entry.kind}]`,
        `Atlas: ${overview.entry.id}`,
        `Reason: ${resultValue.selection_reason}`,
        `Candidates: ${resultValue.candidate_count}`,
        `Freshness: ${overview.entry.freshness}`,
        `Overview kind: ${overview.overview_kind}`,
        `Recommended reads:`,
        reads || '- none',
      ].join('\n') + '\n';
    }
    case 'get_context_atlas_report': {
      const resultValue = result as any;
      if (!resultValue.report) {
        return [
          'No context atlas report available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const report = resultValue.report;
      return [
        report.title,
        `Entry: ${report.entry_id}`,
        `Reason: ${resultValue.selection_reason}`,
        `Candidates: ${resultValue.candidate_count}`,
        ...report.summary_lines,
        'Recommended reads:',
        ...report.recommended_reads.map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
      ].join('\n') + '\n';
    }
    case 'get_atlas_orientation_card': {
      const resultValue = result as any;
      if (!resultValue.card) {
        return [
          'No atlas orientation card available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const card = resultValue.card;
      return [
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
      ].join('\n') + '\n';
    }
    case 'get_atlas_orientation_bundle': {
      const resultValue = result as any;
      if (!resultValue.bundle) {
        return [
          'No atlas orientation bundle available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const bundle = resultValue.bundle;
      return [
        `${bundle.title} [atlas_orientation]`,
        `Atlas entry: ${bundle.atlas_entry_id}`,
        `Freshness: ${bundle.freshness}`,
        `Budget: ${bundle.budget_hint}`,
        `Reason: ${resultValue.selection_reason}`,
        `Candidates: ${resultValue.candidate_count}`,
        ...(bundle.summary_lines || []),
        `Report entry: ${bundle.report.entry_id}`,
        `Card entry: ${bundle.card.atlas_entry_id}`,
      ].join('\n') + '\n';
    }
    case 'get_context_map_report': {
      const resultValue = result as any;
      if (!resultValue.report) {
        return [
          'No context map report available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const report = resultValue.report;
      return [
        report.title,
        `Map: ${report.map_id}`,
        `Reason: ${resultValue.selection_reason}`,
        `Candidates: ${resultValue.candidate_count}`,
        ...report.summary_lines,
        'Recommended reads:',
        ...report.recommended_reads.map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
      ].join('\n') + '\n';
    }
    case 'get_context_map_explanation': {
      const resultValue = result as any;
      if (!resultValue.explanation) {
        return [
          'No context map explanation available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const explanation = resultValue.explanation;
      return [
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
      ].join('\n') + '\n';
    }
    case 'query_context_map': {
      const resultValue = result as any;
      if (!resultValue.result) {
        return [
          'No context map query result available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const queryResult = resultValue.result;
      return [
        `Context map query: ${queryResult.query}`,
        `Map: ${queryResult.map_id}`,
        `Reason: ${resultValue.selection_reason}`,
        `Candidates: ${resultValue.candidate_count}`,
        ...queryResult.summary_lines,
        'Matched nodes:',
        ...(queryResult.matched_nodes || []).map((node: any) => `- ${node.node_id} | ${node.label} | score=${node.score}`),
        'Recommended reads:',
        ...(queryResult.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
      ].join('\n') + '\n';
    }
    case 'find_context_map_path': {
      const resultValue = result as any;
      if (!resultValue.path) {
        return [
          'No context map path available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const path = resultValue.path;
      return [
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
      ].join('\n') + '\n';
    }
    case 'get_broad_synthesis_route': {
      const resultValue = result as any;
      if (!resultValue.route) {
        return [
          'No broad synthesis route available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const route = resultValue.route;
      return [
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
      ].join('\n') + '\n';
    }
    case 'get_precision_lookup_route': {
      const resultValue = result as any;
      if (!resultValue.route) {
        return [
          'No precision lookup route available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const route = resultValue.route;
      return [
        `Precision lookup route: ${route.slug}${route.section_id ? `#${route.section_id}` : ''}`,
        `Path: ${route.path}`,
        `Target kind: ${route.target_kind}`,
        `Reason: ${resultValue.selection_reason}`,
        `Candidates: ${resultValue.candidate_count}`,
        ...route.summary_lines,
        `Retrieval route: ${(route.retrieval_route || []).join(' -> ')}`,
        'Recommended reads:',
        ...(route.recommended_reads || []).map((item: any) => `- ${item.node_id} | ${item.label} | ${item.path}`),
      ].join('\n') + '\n';
    }
    case 'select_retrieval_route': {
      const resultValue = result as any;
      if (!resultValue.route) {
        return [
          'No retrieval route selected.',
          `Intent: ${resultValue.selected_intent}`,
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
          `Trace: ${resultValue.trace?.id || 'none'}`,
        ].join('\n') + '\n';
      }
      const route = resultValue.route;
      return [
        `Retrieval route: ${resultValue.selected_intent}`,
        `Route kind: ${route.route_kind}`,
        `Reason: ${resultValue.selection_reason}`,
        `Candidates: ${resultValue.candidate_count}`,
        `Trace: ${resultValue.trace?.id || 'none'}`,
        ...route.summary_lines,
        `Route steps: ${(route.retrieval_route || []).join(' -> ')}`,
      ].join('\n') + '\n';
    }
    case 'get_workspace_system_card': {
      const resultValue = result as any;
      if (!resultValue.card) {
        return [
          'No workspace system card available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const card = resultValue.card;
      return [
        `${card.title} [workspace_system]`,
        `System: ${card.system_slug}`,
        `Reason: ${resultValue.selection_reason}`,
        `Candidates: ${resultValue.candidate_count}`,
        ...(card.summary_lines || []),
        `Build: ${card.build_command || 'unavailable'}`,
        `Test: ${card.test_command || 'unavailable'}`,
        'Entry points:',
        ...(card.entry_points || []).map((item: any) => `- ${item.name} | ${item.path} | ${item.purpose}`),
      ].join('\n') + '\n';
    }
    case 'get_workspace_project_card': {
      const resultValue = result as any;
      if (!resultValue.card) {
        return [
          'No workspace project card available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const card = resultValue.card;
      return [
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
      ].join('\n') + '\n';
    }
    case 'get_workspace_orientation_bundle': {
      const resultValue = result as any;
      if (!resultValue.bundle) {
        return [
          'No workspace orientation bundle available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const bundle = resultValue.bundle;
      return [
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
      ].join('\n') + '\n';
    }
    case 'get_workspace_corpus_card': {
      const resultValue = result as any;
      if (!resultValue.card) {
        return [
          'No workspace corpus card available.',
          `Reason: ${resultValue.selection_reason}`,
          `Candidates: ${resultValue.candidate_count}`,
        ].join('\n') + '\n';
      }
      const card = resultValue.card;
      return [
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
      ].join('\n') + '\n';
    }
    case 'search':
    case 'query': {
      const results = result as any[];
      if (results.length === 0) return 'No results.\n';
      return results.map(r =>
        `[${r.score?.toFixed(4) || '?'}] ${r.slug} -- ${r.chunk_text?.slice(0, 100) || ''}${r.stale ? ' (stale)' : ''}`,
      ).join('\n') + '\n';
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
      const score = Math.max(0, 10
        - (h.missing_embeddings > 0 ? 2 : 0)
        - (h.stale_pages > 0 ? 1 : 0)
        - (h.dead_links > 0 ? 1 : 0)
        - (h.orphan_pages > 0 ? 1 : 0));
      return [
        `Health score: ${score}/10`,
        `Embed coverage: ${(h.embed_coverage * 100).toFixed(1)}%`,
        `Missing embeddings: ${h.missing_embeddings}`,
        `Stale pages: ${h.stale_pages}`,
        `Orphan pages: ${h.orphan_pages}`,
        `Dead links: ${h.dead_links}`,
      ].join('\n') + '\n';
    }
    case 'get_timeline': {
      const entries = result as any[];
      if (entries.length === 0) return 'No timeline entries.\n';
      return entries.map(e =>
        `${e.date}  ${e.summary}${e.source ? ` [${e.source}]` : ''}`,
      ).join('\n') + '\n';
    }
    case 'get_versions': {
      const versions = result as any[];
      if (versions.length === 0) return 'No versions.\n';
      return versions.map(v =>
        `#${v.id}  ${v.snapshot_at?.toString().slice(0, 19) || '?'}  ${v.compiled_truth?.slice(0, 60) || ''}...`,
      ).join('\n') + '\n';
    }
    case 'sync_brain': {
      const sync = result as any;
      switch (sync.status) {
        case 'up_to_date':
          return 'Already up to date.\n';
        case 'synced':
          return [
            `Synced ${sync.fromCommit?.slice(0, 8)}..${sync.toCommit.slice(0, 8)}:`,
            `  +${sync.added} added, ~${sync.modified} modified, -${sync.deleted} deleted, R${sync.renamed} renamed`,
            `  ${sync.chunksCreated} chunks created`,
          ].join('\n') + '\n';
        case 'first_sync':
          return `First sync complete. Checkpoint: ${sync.toCommit.slice(0, 8)}\n`;
        case 'dry_run':
          return '';
      }
      return JSON.stringify(result, null, 2) + '\n';
    }
    case 'resume_task': {
      const resume = result as any;
      return [
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
        `Latest trace route: ${(resume.latest_trace_route || []).join(' -> ') || 'none'}`,
        `Code claims: ${formatCodeClaimVerificationSummary(resume.code_claim_verification || [])}`,
        `State: ${resume.stale ? 'stale' : 'fresh'}`,
      ].join('\n') + '\n';
    }
    case 'get_task_working_set': {
      const state = result as any;
      const task = state.thread;
      const workingSet = state.working_set;
      return [
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
      ].join('\n') + '\n';
    }
    default:
      return JSON.stringify(result, null, 2) + '\n';
  }
}

function parseStringListParam(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', `${key} must be an array or string list.`);
  }

  const trimmed = value.trim();
  if (trimmed === '') return [];

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new OperationError('invalid_params', `${key} must be valid JSON when passed as an array string.`);
    }
    if (!Array.isArray(parsed)) {
      throw new OperationError('invalid_params', `${key} JSON value must be an array.`);
    }
    return parsed.map((item) => String(item));
  }

  return trimmed
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseOptionalStringParam(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', `${key} must be a string.`);
  }
  return value;
}

function parseKnownSubjectsParam(
  value: unknown,
  key: string,
): Array<string | MemoryScenarioKnownSubject> | undefined {
  if (value === undefined || value === null) return undefined;

  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new OperationError('invalid_params', `${key} must be valid JSON when passed as an array string.`);
      }
    } else {
      parsed = trimmed
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new OperationError('invalid_params', `${key} must be an array.`);
  }

  return parsed.map((item, index) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') {
      throw new OperationError('invalid_params', `${key}[${index}] must be a string or object.`);
    }

    const subject = item as Record<string, unknown>;
    if (typeof subject.ref !== 'string' || subject.ref.length === 0) {
      throw new OperationError('invalid_params', `${key}[${index}].ref must be a non-empty string.`);
    }

    const knownSubject: MemoryScenarioKnownSubject = { ref: subject.ref };
    if (subject.kind !== undefined) {
      if (subject.kind === null) {
        throw new OperationError('invalid_params', `${key}[${index}].kind must be one of: ${MEMORY_SCENARIO_KNOWN_SUBJECT_KINDS.join(', ')}.`);
      }
      const kind = parseEnumParam(subject.kind, `${key}[${index}].kind`, MEMORY_SCENARIO_KNOWN_SUBJECT_KINDS);
      if (kind) knownSubject.kind = kind;
    }
    return knownSubject;
  });
}

function parseActivationArtifacts(
  value: unknown,
  key: string,
): MemoryActivationArtifact[] {
  if (value === undefined || value === null) return [];

  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new OperationError('invalid_params', `${key} must be valid JSON when passed as a string.`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new OperationError('invalid_params', `${key} must be an array.`);
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new OperationError('invalid_params', `${key}[${index}] must be an object.`);
    }

    const artifact = item as Record<string, unknown>;
    if (typeof artifact.id !== 'string' || artifact.id.length === 0) {
      throw new OperationError('invalid_params', `${key}[${index}].id must be a non-empty string.`);
    }

    const artifactKind = parseEnumParam(
      artifact.artifact_kind,
      `${key}[${index}].artifact_kind`,
      MEMORY_ARTIFACT_KINDS,
    );
    if (!artifactKind) {
      throw new OperationError('invalid_params', `${key}[${index}].artifact_kind must be one of: ${MEMORY_ARTIFACT_KINDS.join(', ')}.`);
    }

    if (artifact.source_ref !== undefined && typeof artifact.source_ref !== 'string') {
      throw new OperationError('invalid_params', `${key}[${index}].source_ref must be a string.`);
    }
    if (artifact.stale !== undefined && typeof artifact.stale !== 'boolean') {
      throw new OperationError('invalid_params', `${key}[${index}].stale must be a boolean.`);
    }
    if (artifact.anchors_valid !== undefined && typeof artifact.anchors_valid !== 'boolean') {
      throw new OperationError('invalid_params', `${key}[${index}].anchors_valid must be a boolean.`);
    }

    let scopePolicy: ScopeGatePolicy | undefined;
    if (artifact.scope_policy !== undefined) {
      if (artifact.scope_policy === null) {
        throw new OperationError('invalid_params', `${key}[${index}].scope_policy must be one of: ${SCOPE_GATE_POLICIES.join(', ')}.`);
      }
      scopePolicy = parseEnumParam(
        artifact.scope_policy,
        `${key}[${index}].scope_policy`,
        SCOPE_GATE_POLICIES,
      );
    }

    return {
      id: artifact.id,
      artifact_kind: artifactKind,
      source_ref: artifact.source_ref,
      stale: artifact.stale,
      anchors_valid: artifact.anchors_valid,
      scope_policy: scopePolicy,
    };
  });
}

function formatCodeClaimVerificationSummary(results: Array<{
  claim?: { path?: string; symbol?: string; source_trace_id?: string };
  status?: string;
  reason?: string;
}>): string {
  if (results.length === 0) return 'none';
  return results
    .map((result) => [
      result.status ?? 'unknown',
      result.claim?.path
        ?? (result.claim?.symbol ? `symbol:${result.claim.symbol}` : 'unknown'),
      result.claim?.path && result.claim?.symbol ? result.claim.symbol : undefined,
      result.reason ?? 'unknown',
      result.claim?.source_trace_id,
    ].filter((part) => part !== undefined && part !== '').join(':'))
    .join(', ');
}

function parseEnumParam<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', `${key} must be a string.`);
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new OperationError('invalid_params', `${key} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function parseOptionalDateParam(value: unknown, key: string): Date | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', `${key} must be an ISO datetime string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new OperationError('invalid_params', `${key} must be a valid ISO datetime string.`);
  }
  return parsed;
}

function parseCodeClaimsParam(value: unknown, key: string): CodeClaim[] | undefined {
  if (value === undefined || value === null) return undefined;

  let rawClaims: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return [];
    if (trimmed.startsWith('[')) {
      try {
        rawClaims = JSON.parse(trimmed);
      } catch {
        throw new OperationError('invalid_params', `${key} must be valid JSON when passed as an array string.`);
      }
    } else {
      rawClaims = parseStringListParam(value, key)?.map((entry) =>
        entry.startsWith('code_claim:') ? entry : `code_claim:${entry}`);
    }
  }

  if (!Array.isArray(rawClaims)) {
    throw new OperationError('invalid_params', `${key} must be an array of code claim objects or code_claim entries.`);
  }

  return rawClaims.map((claim, index) => parseCodeClaimParamItem(claim, `${key}[${index}]`));
}

function parseCodeClaimParamItem(value: unknown, key: string): CodeClaim {
  if (typeof value === 'string') {
    const parsed = parseCodeClaimVerificationEntry(value.startsWith('code_claim:') ? value : `code_claim:${value}`);
    if (!parsed) {
      throw new OperationError('invalid_params', `${key} must be a valid code_claim entry.`);
    }
    return parsed;
  }

  if (!value || typeof value !== 'object') {
    throw new OperationError('invalid_params', `${key} must be a code claim object.`);
  }
  const claim = value as Record<string, unknown>;
  const hasPath = typeof claim.path === 'string' && claim.path.trim().length > 0;
  const hasSymbol = typeof claim.symbol === 'string' && claim.symbol.length > 0;
  if (!hasPath && !hasSymbol) {
    throw new OperationError('invalid_params', `${key} must include a non-empty path or symbol.`);
  }

  return {
    ...(hasPath ? { path: String(claim.path) } : {}),
    ...(hasSymbol ? { symbol: String(claim.symbol) } : {}),
    ...(typeof claim.branch_name === 'string' && claim.branch_name.length > 0 ? { branch_name: claim.branch_name } : {}),
    ...(typeof claim.source_trace_id === 'string' && claim.source_trace_id.length > 0 ? { source_trace_id: claim.source_trace_id } : {}),
  };
}

async function requireTaskThread(engine: BrainEngine, taskId: string) {
  const thread = await engine.getTaskThread(taskId);
  if (!thread) {
    throw new OperationError('task_not_found', `Task thread not found: ${taskId}`, 'Check the task id or create the task first.');
  }
  return thread;
}

const runtimeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<any>;

// --- Page CRUD ---

const get_page: Operation = {
  name: 'get_page',
  description: 'Read a specific knowledge page by slug. Use after search or query returns a relevant slug. Pages contain compiled truth (current understanding) and timeline (evidence history).',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    fuzzy: { type: 'boolean', description: 'Enable fuzzy slug resolution (default: false)' },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const fuzzy = (p.fuzzy as boolean) || false;

    let page = await ctx.engine.getPage(slug);
    let resolved_slug: string | undefined;

    if (!page && fuzzy) {
      const candidates = await ctx.engine.resolveSlugs(slug);
      if (candidates.length === 1) {
        page = await ctx.engine.getPage(candidates[0]);
        resolved_slug = candidates[0];
      } else if (candidates.length > 1) {
        return { error: 'ambiguous_slug', candidates };
      }
    }

    if (!page) {
      throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug or use fuzzy: true');
    }

    const tags = await ctx.engine.getTags(page.slug);
    return { ...page, tags, ...(resolved_slug ? { resolved_slug } : {}) };
  },
  cliHints: { name: 'get', positional: ['slug'] },
};

const SOURCE_ATTRIBUTION_RE = /\[Source:\s*([^\]\n]*)\]/g;

function hasUsableSourceAttribution(content: string): boolean {
  SOURCE_ATTRIBUTION_RE.lastIndex = 0;
  for (const match of content.matchAll(SOURCE_ATTRIBUTION_RE)) {
    if ((match[1] ?? '').trim()) return true;
  }
  return false;
}

function assertPutPageSourceAttribution(slug: string, content: string): void {
  const parsed = parseMarkdown(content, `${slug}.md`);
  const citedBody = [parsed.compiled_truth, parsed.timeline].join('\n');
  if (hasUsableSourceAttribution(citedBody)) return;
  throw new OperationError(
    'invalid_params',
    'put_page content must include at least one non-empty [Source: ...] attribution.',
    'Add a provenance citation such as [Source: User, direct message, 2026-04-26 09:00 AM KST] to the compiled truth or timeline before writing durable memory.',
    'docs/guides/source-attribution.md',
  );
}

function optionalPutPageString(field: string, value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationError('invalid_params', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function putPageSlug(value: unknown): string {
  const raw = optionalPutPageString('slug', value);
  if (raw === undefined) {
    throw new OperationError('invalid_params', 'slug must be a non-empty string');
  }
  try {
    return validateSlug(raw);
  } catch (error) {
    throw new OperationError('invalid_params', error instanceof Error ? error.message : 'slug is invalid');
  }
}

function putPageContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', 'content must be a string');
  }
  return value;
}

function putPageExpectedContentHash(value: unknown): string | undefined {
  const expected = optionalPutPageString('expected_content_hash', value);
  if (expected === undefined) return undefined;
  if (!/^[a-fA-F0-9]{64}$/.test(expected)) {
    throw new OperationError('invalid_params', 'expected_content_hash must be a SHA-256 hex content hash');
  }
  return expected.toLowerCase();
}

async function resolvePutPageMarkdownRepoPath(engine: BrainEngine, value: unknown): Promise<string | null> {
  const explicit = optionalPutPageString('repo', value);
  const repoPath = explicit
    ?? await engine.getConfig('markdown.repo_path')
    ?? await engine.getConfig('sync.repo_path');
  return repoPath ?? null;
}

interface PutPageMarkdownTarget {
  repoPath: string;
  relativePath: string;
  filePath: string;
}

interface PutPageMarkdownSnapshot {
  existed: boolean;
  content: string | null;
  isSymlink: boolean;
}

function putPageMarkdownTarget(repoPath: string, slug: string): PutPageMarkdownTarget {
  const requestedRepoRoot = resolve(repoPath);
  if (!existsSync(requestedRepoRoot) || !statSync(requestedRepoRoot).isDirectory()) {
    throw new OperationError(
      'invalid_params',
      `put_page markdown repo does not exist or is not a directory: ${repoPath}`,
    );
  }

  const repoRoot = realpathSync(requestedRepoRoot);
  const relativePath = `${validateSlug(slug)}.md`;
  const filePath = resolve(repoRoot, relativePath);
  const relativeToRoot = relative(repoRoot, filePath);
  if (relativeToRoot.startsWith('..') || relativeToRoot === '' || resolve(repoRoot, relativeToRoot) !== filePath) {
    throw new OperationError('invalid_params', `put_page markdown path escapes repo for slug: ${slug}`);
  }

  const target = { repoPath: repoRoot, relativePath, filePath };
  assertPutPageMarkdownParentIsSafe(target);
  return target;
}

function hashMarkdownPageContent(slug: string, content: string, relativePath?: string): string {
  return importContentHash(parseMarkdown(content, relativePath ?? `${slug}.md`));
}

function assertPutPageMarkdownContentMatchesTarget(content: string, target: PutPageMarkdownTarget): void {
  const parsed = parseMarkdown(content, target.relativePath);
  const expectedSlug = slugifyPath(target.relativePath);
  let canonicalParsedSlug: string;
  try {
    canonicalParsedSlug = slugifyPath(validateSlug(parsed.slug));
  } catch {
    canonicalParsedSlug = parsed.slug;
  }

  if (canonicalParsedSlug !== expectedSlug) {
    throw new OperationError(
      'invalid_params',
      `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expectedSlug}" (from ${target.relativePath}). Remove the frontmatter "slug:" line or move the file.`,
    );
  }
}

function assertPutPageMarkdownParentIsSafe(target: PutPageMarkdownTarget): void {
  const directory = dirname(target.relativePath);
  if (directory === '.' || directory === '') return;

  let currentPath = target.repoPath;
  for (const part of directory.split('/')) {
    if (!part) continue;
    currentPath = join(currentPath, part);
    if (!existsSync(currentPath)) continue;

    const stat = lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      throw new OperationError(
        'invalid_params',
        `put_page markdown path escapes repo through a symlink: ${relative(target.repoPath, currentPath)}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new OperationError(
        'invalid_params',
        `put_page markdown parent is not a directory: ${relative(target.repoPath, currentPath)}`,
      );
    }

    const realParent = realpathSync(currentPath);
    const relativeToRoot = relative(target.repoPath, realParent);
    if (relativeToRoot.startsWith('..') || resolve(target.repoPath, relativeToRoot) !== realParent) {
      throw new OperationError('invalid_params', `put_page markdown path escapes repo: ${target.relativePath}`);
    }
  }
}

function readMarkdownTargetSnapshot(target: PutPageMarkdownTarget): PutPageMarkdownSnapshot {
  if (!existsSync(target.filePath)) {
    return { existed: false, content: null, isSymlink: false };
  }
  return {
    existed: true,
    content: readFileSync(target.filePath, 'utf-8'),
    isSymlink: lstatSync(target.filePath).isSymbolicLink(),
  };
}

function atomicWriteMarkdownTarget(target: PutPageMarkdownTarget, content: string): void {
  const directory = dirname(target.filePath);
  assertPutPageMarkdownParentIsSafe(target);
  mkdirSync(directory, { recursive: true });
  assertPutPageMarkdownParentIsSafe(target);
  const tempPath = join(directory, `.${basename(target.filePath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, target.filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup; preserve the original write failure.
    }
    throw error;
  }
}

function restoreMarkdownTargetSnapshot(target: PutPageMarkdownTarget, snapshot: PutPageMarkdownSnapshot): void {
  if (snapshot.existed) {
    atomicWriteMarkdownTarget(target, snapshot.content ?? '');
    return;
  }
  rmSync(target.filePath, { force: true });
}

function hashMarkdownTargetSnapshot(target: PutPageMarkdownTarget, snapshot: PutPageMarkdownSnapshot): string | null {
  if (!snapshot.existed || snapshot.content === null) return null;
  return hashMarkdownPageContent(
    target.relativePath.replace(/\.md$/i, ''),
    snapshot.content,
    target.relativePath,
  );
}

function shouldWriteMarkdownTarget(snapshot: PutPageMarkdownSnapshot, content: string): boolean {
  return !snapshot.existed || snapshot.isSymlink || snapshot.content !== content;
}

function putPageMarkdownPreflightError(content: string): string | null {
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength <= MAX_MARKDOWN_IMPORT_BYTES) return null;
  return `Content too large (${byteLength} bytes, max ${MAX_MARKDOWN_IMPORT_BYTES}).`;
}

function putPageMarkdownConflict(input: {
  slug: string;
  existingPageHash: string | null;
  expectedContentHash?: string;
  markdownContentHash: string | null;
}): {
  expectedContentHash: string | null;
  currentContentHash: string | null;
  conflictInfo: Record<string, unknown>;
  message: string;
} | null {
  if (input.markdownContentHash === null) return null;

  if (input.existingPageHash === null) {
    return {
      expectedContentHash: input.expectedContentHash ?? null,
      currentContentHash: input.markdownContentHash,
      conflictInfo: {
        reason: 'markdown_file_without_db_page',
        markdown_content_hash: input.markdownContentHash,
      },
      message: `markdown file already exists for ${input.slug}`,
    };
  }

  if (input.markdownContentHash !== input.existingPageHash) {
    return {
      expectedContentHash: input.expectedContentHash ?? input.existingPageHash,
      currentContentHash: input.markdownContentHash,
      conflictInfo: {
        reason: 'markdown_file_changed',
        db_content_hash: input.existingPageHash,
        markdown_content_hash: input.markdownContentHash,
      },
      message: `markdown file changed since the DB page was indexed: ${input.slug}`,
    };
  }

  return null;
}

function putPageSourceRefs(value: unknown): string[] {
  let parsed: string[] | undefined;
  if (value === undefined) {
    return ['Source: mbrain put_page operation'];
  } else if (Array.isArray(value)) {
    parsed = value.map((ref, index) => putPageSourceRef(ref, `source_refs[${index}]`));
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      let rawRefs: unknown;
      try {
        rawRefs = JSON.parse(trimmed);
      } catch {
        rawRefs = undefined;
      }
      if (rawRefs !== undefined) {
        if (!Array.isArray(rawRefs)) {
          throw new OperationError('invalid_params', 'source_refs JSON value must be an array.');
        }
        parsed = rawRefs.map((ref, index) => putPageSourceRef(ref, `source_refs[${index}]`));
      } else {
        parsed = parsePutPageSourceRefString(value);
      }
    } else {
      parsed = parsePutPageSourceRefString(value);
    }
  } else {
    throw new OperationError('invalid_params', 'source_refs must be an array or string list.');
  }

  const refs = parsed?.map((ref) => ref.trim()).filter((ref) => ref.length > 0) ?? [];
  if (refs.length === 0) {
    throw new OperationError('invalid_params', 'source_refs must be a non-empty array of strings');
  }
  return refs;
}

function parsePutPageSourceRefString(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === '') return [];
  return trimmed
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
}

function putPageSourceRef(value: unknown, key: string): string {
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', `${key} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new OperationError('invalid_params', `${key} must be a non-empty string`);
  }
  return trimmed;
}

function putPageMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('invalid_params', 'metadata must be an object');
  }
  assertJsonSerializable(value, 'metadata', new WeakSet<object>());
  return value as Record<string, unknown>;
}

function assertJsonSerializable(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new OperationError('invalid_params', `${path} must be JSON-serializable`);
      }
      return;
    case 'object': {
      const objectValue = value as Record<string, unknown>;
      if (seen.has(objectValue)) {
        throw new OperationError('invalid_params', `${path} must be JSON-serializable`);
      }
      seen.add(objectValue);
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonSerializable(item, `${path}[${index}]`, seen));
        seen.delete(objectValue);
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new OperationError('invalid_params', `${path} must be JSON-serializable object data`);
      }
      for (const [key, entry] of Object.entries(objectValue)) {
        assertJsonSerializable(entry, `${path}.${key}`, seen);
      }
      seen.delete(objectValue);
      return;
    }
    default:
      throw new OperationError('invalid_params', `${path} must be JSON-serializable`);
  }
}

function putPageAuditContext(p: Record<string, unknown>) {
  return {
    session_id: optionalPutPageString('session_id', p.session_id) ?? `put_page:direct:${randomUUID()}`,
    realm_id: optionalPutPageString('realm_id', p.realm_id) ?? 'work',
    actor: optionalPutPageString('actor', p.actor) ?? 'mbrain:put_page',
    scope_id: optionalPutPageString('scope_id', p.scope_id) ?? 'workspace:default',
    source_refs: putPageSourceRefs(p.source_refs),
    metadata: putPageMetadata(p.metadata),
    redaction_visibility: 'visible' as const,
  };
}

type PutPageAuditContext = ReturnType<typeof putPageAuditContext>;

async function recordPutPageConflict(
  engine: BrainEngine,
  audit: PutPageAuditContext,
  input: {
    slug: string;
    expectedContentHash: string | null;
    currentContentHash: string | null;
    conflictInfo: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await recordMemoryMutationEvent(engine, {
      ...audit,
      operation: 'put_page',
      target_kind: 'page',
      target_id: input.slug,
      expected_target_snapshot_hash: input.expectedContentHash,
      current_target_snapshot_hash: input.currentContentHash,
      result: 'conflict',
      conflict_info: input.conflictInfo,
      dry_run: false,
    });
  } catch {
    // Conflict auditing is best effort so write_conflict remains the surfaced failure.
  }
}

async function assertPutPageMemoryWriteAllowed(
  engine: BrainEngine,
  input: {
    memory_session_id?: string | null;
    realm_id?: string | null;
    scope_id?: string | null;
  },
): Promise<void> {
  try {
    await assertMemoryWriteAllowed(engine, input);
  } catch (error) {
    if (error instanceof MemoryAccessPolicyError) {
      throw new OperationError('invalid_params', error.message);
    }
    throw error;
  }
}

function putPageOperationResult(result: { slug: string; status: string; chunks: number; error?: string }) {
  return {
    slug: result.slug,
    status: result.status === 'imported' ? 'created_or_updated' : result.status,
    chunks: result.chunks,
    ...(result.error ? { error: result.error } : {}),
  };
}

type PutPageImportResult = Awaited<ReturnType<typeof importFromContent>>;
type PutPageTransactionOutcome =
  | { kind: 'result'; result: PutPageImportResult }
  | {
      kind: 'conflict';
      audit: PutPageAuditContext;
      conflict: {
        slug: string;
        expectedContentHash: string | null;
        currentContentHash: string | null;
        conflictInfo: Record<string, unknown>;
      };
      error: OperationError;
    };

const put_page: Operation = {
  name: 'put_page',
  description: 'Create or update a knowledge page to record new information about people, companies, concepts, or systems discovered during the conversation. Markdown with YAML frontmatter; content should follow the compiled truth + timeline pattern. Rejects generic, numeric-only, or globally bucketed documentation slugs. Chunks, embeds, and reconciles tags.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    content: { type: 'string', required: true, description: 'Full markdown content with YAML frontmatter' },
    expected_content_hash: { type: 'string', description: 'Optional optimistic write precondition. Existing page content_hash must match before writing.' },
    repo: { type: 'string', description: 'Optional markdown repo root for markdown-first local/offline writes. Defaults to configured markdown.repo_path or sync.repo_path.' },
    memory_session_id: { type: 'string', description: 'Optional memory session id used for write authorization. Requires realm_id.' },
    session_id: { type: 'string', description: 'Optional audit session id. Defaults to put_page:direct.' },
    realm_id: { type: 'string', description: 'Optional audit realm id. Defaults to work.' },
    actor: { type: 'string', description: 'Optional audit actor. Defaults to mbrain:put_page.' },
    scope_id: { type: 'string', description: 'Optional audit scope id. Defaults to workspace:default.' },
    source_refs: { type: 'array', items: { type: 'string' }, description: 'Optional non-empty audit provenance references.' },
    metadata: { type: 'object', description: 'Optional audit metadata object.' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const slug = putPageSlug(p.slug);
    const content = putPageContent(p.content);
    assertWritableSlugQuality(slug);
    if (ctx.dryRun) return { dry_run: true, action: 'put_page', slug };
    const markdownRepoPath = await resolvePutPageMarkdownRepoPath(ctx.engine, p.repo);
    const markdownTarget = markdownRepoPath ? putPageMarkdownTarget(markdownRepoPath, slug) : null;
    if (markdownTarget) {
      assertPutPageMarkdownContentMatchesTarget(content, markdownTarget);
    }
    let markdownWriteSnapshot: PutPageMarkdownSnapshot | null = null;
    let markdownFileWritten = false;
    const memorySessionId = optionalPutPageString('memory_session_id', p.memory_session_id) ?? null;
    const authorizationRealmId = memorySessionId ? (optionalPutPageString('realm_id', p.realm_id) ?? null) : null;
    const authorizationScopeId = memorySessionId
      ? (optionalPutPageString('scope_id', p.scope_id) ?? 'workspace:default')
      : null;
    const prevalidatedPutPage = memorySessionId
      ? null
      : (() => {
        assertPutPageSourceAttribution(slug, content);
        return {
          audit: putPageAuditContext(p),
          expectedContentHash: putPageExpectedContentHash(p.expected_content_hash),
        };
      })();
    let outcome: PutPageTransactionOutcome;
    try {
      outcome = await ctx.engine.transaction(async (tx) => {
        if (memorySessionId) {
          await assertPutPageMemoryWriteAllowed(tx, {
            memory_session_id: memorySessionId,
            realm_id: authorizationRealmId,
            scope_id: authorizationScopeId,
          });
          assertPutPageSourceAttribution(slug, content);
        }
        const audit = prevalidatedPutPage ? prevalidatedPutPage.audit : putPageAuditContext(p);
        const expectedContentHash = prevalidatedPutPage
          ? prevalidatedPutPage.expectedContentHash
          : putPageExpectedContentHash(p.expected_content_hash);
        const existing = expectedContentHash !== undefined
          ? await tx.getPageForUpdate(slug)
          : await tx.getPage(slug);
        const previousHash = existing?.content_hash ?? null;
        const markdownSnapshot = markdownTarget ? readMarkdownTargetSnapshot(markdownTarget) : null;
        const markdownContentHash = markdownTarget && markdownSnapshot
          ? hashMarkdownTargetSnapshot(markdownTarget, markdownSnapshot)
          : null;

        if (expectedContentHash !== undefined && !existing) {
          return {
            kind: 'conflict' as const,
            audit,
            conflict: {
              slug,
              expectedContentHash,
              currentContentHash: null,
              conflictInfo: {
                reason: 'missing_page',
                expected_content_hash: expectedContentHash,
              },
            },
            error: new OperationError('write_conflict', `Page not found for expected content hash: ${slug}`),
          };
        }

        if (expectedContentHash !== undefined && previousHash !== expectedContentHash) {
          return {
            kind: 'conflict' as const,
            audit,
            conflict: {
              slug,
              expectedContentHash,
              currentContentHash: previousHash,
              conflictInfo: {
                reason: 'content_hash_mismatch',
                expected_content_hash: expectedContentHash,
                current_content_hash: previousHash,
              },
            },
            error: new OperationError('write_conflict', `content hash mismatch for ${slug}`),
          };
        }

        if (markdownTarget) {
          const markdownConflict = putPageMarkdownConflict({
            slug,
            existingPageHash: previousHash,
            expectedContentHash,
            markdownContentHash,
          });
          if (markdownConflict) {
            return {
              kind: 'conflict' as const,
              audit,
              conflict: {
                slug,
                expectedContentHash: markdownConflict.expectedContentHash,
                currentContentHash: markdownConflict.currentContentHash,
                conflictInfo: markdownConflict.conflictInfo,
              },
              error: new OperationError(
                'write_conflict',
                markdownConflict.message,
                'Run mbrain import for the markdown repo or merge the file changes before retrying put_page.',
              ),
            };
          }
        }

        const result = await (markdownTarget
          ? (() => {
            const preflightError = putPageMarkdownPreflightError(content);
            if (preflightError) {
              return {
                slug,
                status: 'skipped' as const,
                chunks: 0,
                error: preflightError,
              };
            }
            markdownWriteSnapshot = markdownSnapshot ?? readMarkdownTargetSnapshot(markdownTarget);
            if (shouldWriteMarkdownTarget(markdownWriteSnapshot, content)) {
              atomicWriteMarkdownTarget(markdownTarget, content);
              markdownFileWritten = true;
            }
            return importFromFile(tx, markdownTarget.filePath, markdownTarget.relativePath);
          })()
          : importFromContent(tx, slug, content));
        if (result.status === 'imported') {
          const finalPage = await tx.getPage(slug);
          if (!finalPage?.content_hash) {
            throw new OperationError('storage_error', `put_page import did not produce a final content hash for ${slug}`);
          }
          await recordMemoryMutationEvent(tx, {
            ...audit,
            operation: 'put_page',
            target_kind: 'page',
            target_id: slug,
            expected_target_snapshot_hash: expectedContentHash ?? previousHash,
            current_target_snapshot_hash: finalPage.content_hash,
            result: 'applied',
            conflict_info: null,
            dry_run: false,
          });
        } else if (result.error) {
          await recordMemoryMutationEvent(tx, {
            ...audit,
            operation: 'put_page',
            target_kind: 'page',
            target_id: slug,
            expected_target_snapshot_hash: expectedContentHash ?? previousHash,
            current_target_snapshot_hash: previousHash,
            result: 'failed',
            conflict_info: null,
            dry_run: false,
            metadata: {
              ...(audit.metadata ?? {}),
              import_status: result.status,
              error: result.error,
            },
          });
        } else {
          const finalPage = await tx.getPage(slug);
          const currentHash = finalPage?.content_hash ?? previousHash;
          if (!currentHash) {
            throw new OperationError('storage_error', `put_page import skipped without a current content hash for ${slug}`);
          }
          await recordMemoryMutationEvent(tx, {
            ...audit,
            operation: 'put_page',
            target_kind: 'page',
            target_id: slug,
            expected_target_snapshot_hash: expectedContentHash ?? previousHash,
            current_target_snapshot_hash: currentHash,
            result: 'applied',
            conflict_info: null,
            dry_run: false,
            metadata: {
              ...(audit.metadata ?? {}),
              import_status: result.status,
              skipped_reason: 'content_hash_unchanged',
            },
          });
        }

        return { kind: 'result' as const, result };
      });
    } catch (error) {
      if (markdownTarget && markdownFileWritten && markdownWriteSnapshot) {
        restoreMarkdownTargetSnapshot(markdownTarget, markdownWriteSnapshot);
      }
      throw error;
    }

    if (outcome.kind === 'conflict') {
      await recordPutPageConflict(ctx.engine, outcome.audit, outcome.conflict);
      throw outcome.error;
    }
    return putPageOperationResult(outcome.result);
  },
  cliHints: { name: 'put', positional: ['slug'], stdin: 'content' },
};

function assertWritableSlugQuality(slug: string): void {
  const issues = findSlugQualityIssues(slug);
  if (issues.length === 0) return;

  const details = issues
    .map(issue => `${issue.rule}: ${issue.message} ${issue.suggestion}`)
    .join(' ');
  throw new OperationError('invalid_params', `put_page slug quality blocked for "${slug}". ${details}`);
}

const delete_page: Operation = {
  name: 'delete_page',
  description: 'Delete a page',
  params: {
    slug: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'delete_page', slug: p.slug };
    await ctx.engine.deletePage(p.slug as string);
    return { status: 'deleted' };
  },
  cliHints: { name: 'delete', positional: ['slug'] },
};

const list_pages: Operation = {
  name: 'list_pages',
  description: 'List pages with optional filters',
  params: {
    type: { type: 'string', description: 'Filter by page type' },
    tag: { type: 'string', description: 'Filter by tag' },
    limit: { type: 'number', description: 'Max results (default 50)' },
  },
  handler: async (ctx, p) => {
    const pages = await ctx.engine.listPages({
      type: p.type as any,
      tag: p.tag as string,
      limit: (p.limit as number) ?? 50,
    });
    return pages.map(pg => ({
      slug: pg.slug,
      type: pg.type,
      title: pg.title,
      updated_at: pg.updated_at,
    }));
  },
  cliHints: { name: 'list', aliases: { n: 'limit' } },
};

// --- Search ---

const search: Operation = {
  name: 'search',
  description: 'Search the knowledge graph for people, companies, concepts, systems, and organizational context by keyword. Use this BEFORE Grep or WebSearch when the question involves a named entity or domain-specific topic. Returns matching pages with relevance scores.',
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  handler: async (ctx, p) => {
    const limit = (p.limit as number) ?? 20;
    return rankSearchResults(
      await ctx.engine.searchKeyword(p.query as string, { limit: sourceRankCandidateLimit(limit) }),
      limit,
    );
  },
  cliHints: { name: 'search', positional: ['query'] },
};

const query: Operation = {
  name: 'query',
  description: 'Semantic search across the knowledge graph. Use when the question is conceptual, cross-cutting, or when keyword search returned no results. Combines vector similarity with keyword matching and multi-query expansion for best recall.',
  params: {
    query: { type: 'string', required: true },
    limit: { type: 'number', description: 'Max results (default 20)' },
    expand: { type: 'boolean', description: 'Enable multi-query expansion (default: true)' },
  },
  handler: async (ctx, p) => {
    const expand = p.expand !== false;
    return hybridSearch(ctx.engine, p.query as string, {
      limit: (p.limit as number) ?? 20,
      expansion: expand,
      expandFn: expand ? (query) => expandQuery(query, { config: ctx.config }) : undefined,
    });
  },
  cliHints: { name: 'query', positional: ['query'] },
};

// --- Tags ---

const add_tag: Operation = {
  name: 'add_tag',
  description: 'Add tag to page',
  params: {
    slug: { type: 'string', required: true },
    tag: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_tag', slug: p.slug, tag: p.tag };
    await ctx.engine.addTag(p.slug as string, p.tag as string);
    return { status: 'ok' };
  },
  cliHints: { name: 'tag', positional: ['slug', 'tag'] },
};

const remove_tag: Operation = {
  name: 'remove_tag',
  description: 'Remove tag from page',
  params: {
    slug: { type: 'string', required: true },
    tag: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_tag', slug: p.slug, tag: p.tag };
    await ctx.engine.removeTag(p.slug as string, p.tag as string);
    return { status: 'ok' };
  },
  cliHints: { name: 'untag', positional: ['slug', 'tag'] },
};

const get_tags: Operation = {
  name: 'get_tags',
  description: 'List tags for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getTags(p.slug as string);
  },
  cliHints: { name: 'tags', positional: ['slug'] },
};

// --- Links ---

const add_link: Operation = {
  name: 'add_link',
  description: 'Create a typed link between two pages in the knowledge graph. Use to connect entities and technical concepts: people/companies (invested_in, works_at, founded), or systems/concepts (implements, depends_on, extends, contradicts, layer_of, prerequisite_for). Links are bidirectional in traversal and power cross-system navigation.',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    link_type: { type: 'string', description: 'Link type. People/deal: invested_in, works_at, founded, mentioned_in. Technical: implements, depends_on, extends, contradicts, layer_of, prerequisite_for. Free-text; no allowlist enforced.' },
    context: { type: 'string', description: 'Context for the link' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_link', from: p.from, to: p.to };
    await ctx.engine.addLink(
      p.from as string, p.to as string,
      (p.context as string) || '', (p.link_type as string) || '',
    );
    return { status: 'ok' };
  },
  cliHints: { name: 'link', positional: ['from', 'to'] },
};

const remove_link: Operation = {
  name: 'remove_link',
  description: 'Remove link between pages',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_link', from: p.from, to: p.to };
    await ctx.engine.removeLink(p.from as string, p.to as string);
    return { status: 'ok' };
  },
  cliHints: { name: 'unlink', positional: ['from', 'to'] },
};

const get_links: Operation = {
  name: 'get_links',
  description: 'List outgoing links from a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getLinks(p.slug as string);
  },
};

const get_backlinks: Operation = {
  name: 'get_backlinks',
  description: 'List incoming links to a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getBacklinks(p.slug as string);
  },
  cliHints: { name: 'backlinks', positional: ['slug'] },
};

const traverse_graph: Operation = {
  name: 'traverse_graph',
  description: 'Traverse link graph from a page',
  params: {
    slug: { type: 'string', required: true },
    depth: { type: 'number', description: 'Max traversal depth (default 5)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.traverseGraph(p.slug as string, (p.depth as number) ?? 5);
  },
  cliHints: { name: 'graph', positional: ['slug'] },
};

// --- Timeline ---

const add_timeline_entry: Operation = {
  name: 'add_timeline_entry',
  description: 'Add timeline entry to a page',
  params: {
    slug: { type: 'string', required: true },
    date: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    detail: { type: 'string' },
    source: { type: 'string' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_timeline_entry', slug: p.slug };
    await ctx.engine.addTimelineEntry(p.slug as string, {
      date: p.date as string,
      source: (p.source as string) || '',
      summary: p.summary as string,
      detail: (p.detail as string) || '',
    });
    return { status: 'ok' };
  },
  cliHints: { name: 'timeline-add', positional: ['slug', 'date', 'summary'] },
};

const get_timeline: Operation = {
  name: 'get_timeline',
  description: 'Get timeline entries for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getTimeline(p.slug as string);
  },
  cliHints: { name: 'timeline', positional: ['slug'] },
};

// --- Admin ---

const get_stats: Operation = {
  name: 'get_stats',
  description: 'Brain statistics (page count, chunk count, etc.)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getStats();
  },
  cliHints: { name: 'stats' },
};

const get_health: Operation = {
  name: 'get_health',
  description: 'Brain health dashboard (embed coverage, stale pages, orphans)',
  params: {},
  handler: async (ctx) => {
    return ctx.engine.getHealth();
  },
  cliHints: { name: 'health' },
};

const get_versions: Operation = {
  name: 'get_versions',
  description: 'Page version history',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getVersions(p.slug as string);
  },
  cliHints: { name: 'history', positional: ['slug'] },
};

const revert_version: Operation = {
  name: 'revert_version',
  description: 'Revert page to a previous version',
  params: {
    slug: { type: 'string', required: true },
    version_id: { type: 'number', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'revert_version', slug: p.slug, version_id: p.version_id };
    await ctx.engine.createVersion(p.slug as string);
    await ctx.engine.revertToVersion(p.slug as string, p.version_id as number);
    return { status: 'reverted' };
  },
  cliHints: { name: 'revert', positional: ['slug', 'version_id'] },
};

// --- Sync ---

const sync_brain: Operation = {
  name: 'sync_brain',
  description: 'Sync git repo to brain (incremental)',
  params: {
    repo: { type: 'string', description: 'Path to git repo (optional if configured)' },
    dry_run: { type: 'boolean', description: 'Preview changes without applying' },
    full: { type: 'boolean', description: 'Full re-sync (ignore checkpoint)' },
    no_pull: { type: 'boolean', description: 'Skip git pull' },
    no_embed: { type: 'boolean', description: 'Compatibility no-op: sync already defers embeddings' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    // Keep sync local-only so the remote Edge bundle doesn't pull in CLI/import engine code.
    const { performSync } = await runtimeImport('../commands/sync.ts');
    return performSync(ctx.engine, {
      repoPath: p.repo as string | undefined,
      dryRun: ctx.dryRun || (p.dry_run as boolean) || false,
      noPull: (p.no_pull as boolean) || false,
      noEmbed: (p.no_embed as boolean) || false,
      full: (p.full as boolean) || false,
    });
  },
  cliHints: { name: 'sync' },
};

// --- Raw Data ---

const put_raw_data: Operation = {
  name: 'put_raw_data',
  description: 'Store raw API response data for a page',
  params: {
    slug: { type: 'string', required: true },
    source: { type: 'string', required: true, description: 'Data source (e.g., crustdata, happenstance)' },
    data: { type: 'object', required: true, description: 'Raw data object' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'put_raw_data', slug: p.slug, source: p.source };
    await ctx.engine.putRawData(p.slug as string, p.source as string, p.data as object);
    return { status: 'ok' };
  },
};

const get_raw_data: Operation = {
  name: 'get_raw_data',
  description: 'Retrieve raw data for a page',
  params: {
    slug: { type: 'string', required: true },
    source: { type: 'string', description: 'Filter by source' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getRawData(p.slug as string, p.source as string | undefined);
  },
};

// --- Resolution & Chunks ---

const resolve_slugs: Operation = {
  name: 'resolve_slugs',
  description: 'Fuzzy-resolve a partial slug to matching page slugs',
  params: {
    partial: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.resolveSlugs(p.partial as string);
  },
};

const get_chunks: Operation = {
  name: 'get_chunks',
  description: 'Get content chunks for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getChunks(p.slug as string);
  },
};

// --- Profile Memory ---

const get_profile_memory_entry: Operation = {
  name: 'get_profile_memory_entry',
  description: 'Get one canonical profile-memory entry by id.',
  params: {
    id: { type: 'string', required: true, description: 'Profile-memory entry id' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getProfileMemoryEntry(String(p.id));
  },
  cliHints: { name: 'profile-memory-get' },
};

const list_profile_memory_entries: Operation = {
  name: 'list_profile_memory_entries',
  description: 'List canonical profile-memory entries.',
  params: {
    scope_id: { type: 'string', description: 'Profile-memory scope id (default: personal:default)' },
    subject: { type: 'string', description: 'Exact profile-memory subject filter' },
    profile_type: {
      type: 'string',
      description: 'Optional exact profile-memory type filter',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Offset for pagination (default 0)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.listProfileMemoryEntries({
      scope_id: String(p.scope_id ?? DEFAULT_PROFILE_MEMORY_SCOPE_ID),
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      profile_type: typeof p.profile_type === 'string' ? p.profile_type as any : undefined,
      limit: typeof p.limit === 'number' ? p.limit : 20,
      offset: typeof p.offset === 'number' ? p.offset : 0,
    });
  },
  cliHints: { name: 'profile-memory-list', aliases: { n: 'limit' } },
};

function requirePersonalSourceRef(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationError('invalid_params', 'source_ref is required for personal memory writes');
  }
  return value.trim();
}

const upsert_profile_memory_entry: Operation = {
  name: 'upsert_profile_memory_entry',
  description: 'Create or update one canonical personal profile-memory entry.',
  params: {
    id: { type: 'string', description: 'Optional profile-memory entry id (generated when omitted)' },
    scope_id: { type: 'string', description: 'Profile-memory scope id (default: personal:default)' },
    profile_type: {
      type: 'string',
      required: true,
      description: 'Canonical profile-memory type',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    subject: { type: 'string', required: true, description: 'Exact profile-memory subject' },
    content: { type: 'string', required: true, description: 'Canonical profile-memory content' },
    source_ref: { type: 'string', required: true, description: 'Required single provenance string' },
    sensitivity: { type: 'string', description: 'Sensitivity classification', enum: ['public', 'personal', 'secret'] },
    export_status: { type: 'string', description: 'Export visibility status', enum: ['private_only', 'exportable'] },
    last_confirmed_at: { type: 'string', description: 'Optional ISO timestamp for last confirmation' },
    superseded_by: { type: 'string', description: 'Optional id of a newer superseding entry' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const id = typeof p.id === 'string' ? p.id : crypto.randomUUID();
    const scopeId = String(p.scope_id ?? DEFAULT_PROFILE_MEMORY_SCOPE_ID);
    const sourceRef = requirePersonalSourceRef(p.source_ref);
    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'upsert_profile_memory_entry',
        id,
        scope_id: scopeId,
        profile_type: p.profile_type,
        subject: p.subject,
      };
    }

    return ctx.engine.upsertProfileMemoryEntry({
      id,
      scope_id: scopeId,
      profile_type: String(p.profile_type) as any,
      subject: String(p.subject),
      content: String(p.content),
      source_refs: [sourceRef],
      sensitivity: String(p.sensitivity ?? 'personal') as any,
      export_status: String(p.export_status ?? 'private_only') as any,
      last_confirmed_at: typeof p.last_confirmed_at === 'string' ? p.last_confirmed_at : null,
      superseded_by: typeof p.superseded_by === 'string' ? p.superseded_by : null,
    });
  },
  cliHints: { name: 'profile-memory-upsert' },
};

const delete_profile_memory_entry: Operation = {
  name: 'delete_profile_memory_entry',
  description: 'Delete one canonical profile-memory entry by id.',
  params: {
    id: { type: 'string', required: true, description: 'Profile-memory entry id' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const id = String(p.id).trim();
    if (id.length === 0) {
      throw new OperationError('invalid_params', 'id must be a non-empty string');
    }
    if (ctx.dryRun) return { dry_run: true, action: 'delete_profile_memory_entry', id };
    await ctx.engine.deleteProfileMemoryEntry(id);
    return { status: 'deleted', id };
  },
  cliHints: { name: 'profile-memory-delete', positional: ['id'] },
};

const get_personal_episode_entry: Operation = {
  name: 'get_personal_episode_entry',
  description: 'Get one canonical personal-episode entry by id.',
  params: {
    id: { type: 'string', required: true, description: 'Personal-episode entry id' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getPersonalEpisodeEntry(String(p.id));
  },
  cliHints: { name: 'personal-episode-get' },
};

const list_personal_episode_entries: Operation = {
  name: 'list_personal_episode_entries',
  description: 'List canonical personal-episode entries.',
  params: {
    scope_id: { type: 'string', description: 'Personal-episode scope id (default: personal:default)' },
    title: { type: 'string', description: 'Exact personal-episode title filter' },
    source_kind: {
      type: 'string',
      description: 'Optional personal-episode source kind filter',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Offset for pagination (default 0)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.listPersonalEpisodeEntries({
      scope_id: String(p.scope_id ?? DEFAULT_PROFILE_MEMORY_SCOPE_ID),
      title: typeof p.title === 'string' ? p.title : undefined,
      source_kind: typeof p.source_kind === 'string' ? p.source_kind as any : undefined,
      limit: typeof p.limit === 'number' ? p.limit : 20,
      offset: typeof p.offset === 'number' ? p.offset : 0,
    });
  },
  cliHints: { name: 'personal-episode-list', aliases: { n: 'limit' } },
};

const record_personal_episode: Operation = {
  name: 'record_personal_episode',
  description: 'Record one append-only canonical personal-episode entry.',
  params: {
    id: { type: 'string', description: 'Optional personal-episode id (generated when omitted)' },
    scope_id: { type: 'string', description: 'Personal-episode scope id (default: personal:default)' },
    title: { type: 'string', required: true, description: 'Compact personal-episode title' },
    start_time: { type: 'string', required: true, description: 'ISO timestamp for episode start' },
    end_time: { type: 'string', description: 'Optional ISO timestamp for episode end' },
    source_kind: {
      type: 'string',
      required: true,
      description: 'Personal-episode source kind',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
    summary: { type: 'string', required: true, description: 'Episode summary' },
    source_ref: { type: 'string', required: true, description: 'Required single provenance string' },
    candidate_id: { type: 'string', description: 'Optional linked candidate or profile id' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const id = typeof p.id === 'string' ? p.id : crypto.randomUUID();
    const scopeId = String(p.scope_id ?? DEFAULT_PROFILE_MEMORY_SCOPE_ID);
    const sourceRef = requirePersonalSourceRef(p.source_ref);
    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'record_personal_episode',
        id,
        scope_id: scopeId,
        title: p.title,
        source_kind: p.source_kind,
      };
    }

    return ctx.engine.createPersonalEpisodeEntry({
      id,
      scope_id: scopeId,
      title: String(p.title),
      start_time: String(p.start_time),
      end_time: typeof p.end_time === 'string' ? p.end_time : null,
      source_kind: String(p.source_kind) as any,
      summary: String(p.summary),
      source_refs: [sourceRef],
      candidate_ids: typeof p.candidate_id === 'string' ? [p.candidate_id] : [],
    });
  },
  cliHints: { name: 'personal-episode-record' },
};

const delete_personal_episode_entry: Operation = {
  name: 'delete_personal_episode_entry',
  description: 'Delete one canonical personal-episode entry by id.',
  params: {
    id: { type: 'string', required: true, description: 'Personal-episode entry id' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const id = String(p.id).trim();
    if (id.length === 0) {
      throw new OperationError('invalid_params', 'id must be a non-empty string');
    }
    if (ctx.dryRun) return { dry_run: true, action: 'delete_personal_episode_entry', id };
    await ctx.engine.deletePersonalEpisodeEntry(id);
    return { status: 'deleted', id };
  },
  cliHints: { name: 'personal-episode-delete', positional: ['id'] },
};

const memoryInboxOperations = createMemoryInboxOperations({
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

const write_profile_memory_entry: Operation = {
  name: 'write_profile_memory_entry',
  description: 'Write one canonical profile-memory entry only after personal write-target preflight allows it.',
  params: {
    id: { type: 'string', description: 'Optional profile-memory entry id (generated when omitted)' },
    scope_id: { type: 'string', description: 'Profile-memory scope id (default: personal:default)' },
    profile_type: {
      type: 'string',
      required: true,
      description: 'Canonical profile-memory type',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    subject: { type: 'string', required: true, description: 'Exact profile-memory subject' },
    content: { type: 'string', required: true, description: 'Canonical profile-memory content' },
    query: { type: 'string', description: 'Plain-text request used for personal write-target preflight' },
    requested_scope: { type: 'string', description: 'Optional explicit scope override', enum: ['work', 'personal', 'mixed'] },
    source_ref: { type: 'string', required: true, description: 'Required single provenance string' },
    sensitivity: { type: 'string', description: 'Sensitivity classification', enum: ['public', 'personal', 'secret'] },
    export_status: { type: 'string', description: 'Export visibility status', enum: ['private_only', 'exportable'] },
    last_confirmed_at: { type: 'string', description: 'Optional ISO timestamp for last confirmation' },
    superseded_by: { type: 'string', description: 'Optional id of a newer superseding entry' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const sourceRef = requirePersonalSourceRef(p.source_ref);
    const preflight = await selectPersonalWriteTarget(ctx.engine, {
      target_kind: 'profile_memory',
      requested_scope: typeof p.requested_scope === 'string' ? p.requested_scope as any : undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
    });

    if (!preflight.route) {
      throw new OperationError('invalid_params', `profile_memory write blocked: ${preflight.selection_reason}`);
    }

    const id = typeof p.id === 'string' ? p.id : crypto.randomUUID();
    const scopeId = String(p.scope_id ?? preflight.route.scope_id);
    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'write_profile_memory_entry',
        id,
        scope_id: scopeId,
        profile_type: p.profile_type,
        subject: p.subject,
        preflight: preflight.selection_reason,
      };
    }

    return ctx.engine.upsertProfileMemoryEntry({
      id,
      scope_id: scopeId,
      profile_type: String(p.profile_type) as any,
      subject: String(p.subject),
      content: String(p.content),
      source_refs: [sourceRef],
      sensitivity: String(p.sensitivity ?? 'personal') as any,
      export_status: String(p.export_status ?? 'private_only') as any,
      last_confirmed_at: typeof p.last_confirmed_at === 'string' ? p.last_confirmed_at : null,
      superseded_by: typeof p.superseded_by === 'string' ? p.superseded_by : null,
    });
  },
  cliHints: { name: 'profile-memory-write' },
};

const write_personal_episode_entry: Operation = {
  name: 'write_personal_episode_entry',
  description: 'Write one canonical personal-episode entry only after personal write-target preflight allows it.',
  params: {
    id: { type: 'string', description: 'Optional personal-episode id (generated when omitted)' },
    scope_id: { type: 'string', description: 'Personal-episode scope id (default: personal:default)' },
    title: { type: 'string', required: true, description: 'Compact personal-episode title' },
    start_time: { type: 'string', required: true, description: 'ISO timestamp for episode start' },
    end_time: { type: 'string', description: 'Optional ISO timestamp for episode end' },
    source_kind: {
      type: 'string',
      required: true,
      description: 'Personal-episode source kind',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
    summary: { type: 'string', required: true, description: 'Episode summary' },
    query: { type: 'string', description: 'Plain-text request used for personal write-target preflight' },
    requested_scope: { type: 'string', description: 'Optional explicit scope override', enum: ['work', 'personal', 'mixed'] },
    source_ref: { type: 'string', required: true, description: 'Required single provenance string' },
    candidate_id: { type: 'string', description: 'Optional linked candidate or profile id' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const sourceRef = requirePersonalSourceRef(p.source_ref);
    const preflight = await selectPersonalWriteTarget(ctx.engine, {
      target_kind: 'personal_episode',
      requested_scope: typeof p.requested_scope === 'string' ? p.requested_scope as any : undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      title: typeof p.title === 'string' ? p.title : undefined,
    });

    if (!preflight.route) {
      throw new OperationError('invalid_params', `personal_episode write blocked: ${preflight.selection_reason}`);
    }

    const id = typeof p.id === 'string' ? p.id : crypto.randomUUID();
    const scopeId = String(p.scope_id ?? preflight.route.scope_id);
    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'write_personal_episode_entry',
        id,
        scope_id: scopeId,
        title: p.title,
        source_kind: p.source_kind,
        preflight: preflight.selection_reason,
      };
    }

    return ctx.engine.createPersonalEpisodeEntry({
      id,
      scope_id: scopeId,
      title: String(p.title),
      start_time: String(p.start_time),
      end_time: typeof p.end_time === 'string' ? p.end_time : null,
      source_kind: String(p.source_kind) as any,
      summary: String(p.summary),
      source_refs: [sourceRef],
      candidate_ids: typeof p.candidate_id === 'string' ? [p.candidate_id] : [],
    });
  },
  cliHints: { name: 'personal-episode-write' },
};

// --- Operational Memory ---

const list_tasks: Operation = {
  name: 'list_tasks',
  description: 'List task threads from canonical operational memory.',
  params: {
    scope: { type: 'string', description: 'Filter by task scope', enum: ['work', 'personal', 'mixed'] },
    status: {
      type: 'string',
      description: 'Filter by task status',
      enum: ['active', 'paused', 'blocked', 'completed', 'abandoned'],
    },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.listTaskThreads({
      scope: p.scope as any,
      status: p.status as any,
      limit: (p.limit as number) ?? 20,
    });
  },
  cliHints: { name: 'task-list', aliases: { n: 'limit' } },
};

const start_task: Operation = {
  name: 'start_task',
  description: 'Create a new operational-memory task thread.',
  params: {
    title: { type: 'string', required: true, description: 'Task title' },
    goal: { type: 'string', description: 'Task goal' },
    scope: { type: 'string', description: 'Task scope', default: 'work', enum: ['work', 'personal', 'mixed'] },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const id = crypto.randomUUID();
    if (ctx.dryRun) {
      return { dry_run: true, action: 'start_task', id, title: p.title, scope: p.scope ?? 'work' };
    }

    return ctx.engine.transaction(async (tx) => {
      await tx.createTaskThread({
        id,
        scope: String(p.scope ?? 'work') as any,
        title: String(p.title),
        goal: String(p.goal ?? ''),
        status: 'active',
        repo_path: process.cwd(),
        branch_name: null,
        current_summary: '',
      });

      await tx.upsertTaskWorkingSet({
        task_id: id,
        active_paths: [],
        active_symbols: [],
        blockers: [],
        open_questions: [],
        next_steps: [],
        verification_notes: [],
        last_verified_at: null,
      });

      return tx.getTaskThread(id);
    });
  },
  cliHints: { name: 'task-start' },
};

const update_task: Operation = {
  name: 'update_task',
  description: 'Update canonical task-thread state for an existing task.',
  params: {
    task_id: { type: 'string', required: true, description: 'Task thread id' },
    title: { type: 'string', description: 'Updated task title' },
    goal: { type: 'string', description: 'Updated task goal' },
    status: {
      type: 'string',
      description: 'Updated task status',
      enum: ['active', 'paused', 'blocked', 'completed', 'abandoned'],
    },
    current_summary: { type: 'string', description: 'Updated task summary' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const taskId = String(p.task_id);
    const patch = Object.fromEntries(
      Object.entries({
        title: p.title,
        goal: p.goal,
        status: p.status,
        current_summary: p.current_summary,
      }).filter(([, value]) => value !== undefined),
    );

    if (Object.keys(patch).length === 0) {
      throw new OperationError('invalid_params', 'update_task requires at least one patch field.');
    }

    if (ctx.dryRun) {
      return { dry_run: true, action: 'update_task', task_id: taskId, patch };
    }

    await requireTaskThread(ctx.engine, taskId);
    return ctx.engine.updateTaskThread(taskId, patch as any);
  },
  cliHints: { name: 'task-update', positional: ['task_id'] },
};

const resume_task: Operation = {
  name: 'resume_task',
  description: 'Resume an operational-memory task thread from canonical task state.',
  params: {
    task_id: { type: 'string', required: true, description: 'Task thread id' },
  },
  handler: async (ctx, p) => {
    return buildTaskResumeCard(ctx.engine, p.task_id as string);
  },
  cliHints: { name: 'task-resume', positional: ['task_id'] },
};

const get_task_working_set: Operation = {
  name: 'get_task_working_set',
  description: 'Get the canonical task thread and working-set state for one task.',
  params: {
    task_id: { type: 'string', required: true, description: 'Task thread id' },
  },
  handler: async (ctx, p) => {
    const thread = await requireTaskThread(ctx.engine, String(p.task_id));
    const workingSet = await ctx.engine.getTaskWorkingSet(String(p.task_id));
    return {
      thread,
      working_set: workingSet,
    };
  },
  cliHints: { name: 'task-show', positional: ['task_id'] },
};

const get_note_manifest_entry: Operation = {
  name: 'get_note_manifest_entry',
  description: 'Read one derived note-manifest entry by slug for structural inspection.',
  params: {
    slug: { type: 'string', required: true, description: 'Canonical page slug' },
    scope_id: { type: 'string', description: 'Manifest scope id (default: workspace:default)' },
  },
  handler: async (ctx, p) => {
    const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    const entry = await ctx.engine.getNoteManifestEntry(scopeId, String(p.slug));
    if (!entry) {
      throw new OperationError(
        'page_not_found',
        `Note manifest entry not found: ${String(p.slug)}`,
        'Run manifest-rebuild for the slug, or verify the page exists.',
      );
    }
    return entry;
  },
  cliHints: { name: 'manifest-get', positional: ['slug'] },
};

const list_note_manifest_entries: Operation = {
  name: 'list_note_manifest_entries',
  description: 'List derived note-manifest entries for structural inspection.',
  params: {
    scope_id: { type: 'string', description: 'Manifest scope id (default: workspace:default)' },
    slug: { type: 'string', description: 'Filter to a single slug' },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.listNoteManifestEntries({
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      slug: p.slug as string | undefined,
      limit: (p.limit as number) ?? 20,
    });
  },
  cliHints: { name: 'manifest-list', aliases: { n: 'limit' } },
};

const rebuild_note_manifest: Operation = {
  name: 'rebuild_note_manifest',
  description: 'Rebuild derived note-manifest entries from canonical page state.',
  params: {
    slug: { type: 'string', description: 'Optional slug to rebuild a single entry' },
    scope_id: { type: 'string', description: 'Manifest scope id (default: workspace:default)' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    const slug = p.slug as string | undefined;

    if (ctx.dryRun) {
      return { dry_run: true, action: 'rebuild_note_manifest', scope_id: scopeId, slug: slug ?? null };
    }

    try {
      const entries = await rebuildNoteManifestEntries(ctx.engine, {
        scope_id: scopeId,
        slug,
      });
      return {
        scope_id: scopeId,
        rebuilt: entries.length,
        slugs: entries.map((entry) => entry.slug),
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Page not found:')) {
        throw new OperationError(
          'page_not_found',
          error.message,
          'Check the slug or omit it to rebuild all entries.',
        );
      }
      throw error;
    }
  },
  cliHints: { name: 'manifest-rebuild' },
};

const get_note_section_entry: Operation = {
  name: 'get_note_section_entry',
  description: 'Get one derived note-section entry by scope and section id.',
  params: {
    section_id: { type: 'string', required: true, description: 'Durable section id.' },
    scope_id: { type: 'string', description: 'Section scope id (default: workspace:default)' },
  },
  handler: async (ctx, p) => {
    const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    const sectionId = String(p.section_id);
    const entry = await ctx.engine.getNoteSectionEntry(scopeId, sectionId);
    if (!entry) {
      throw new OperationError(
        'page_not_found',
        `Section not found: ${sectionId}`,
        'Run section-rebuild for the page, or verify the section id.',
      );
    }
    return entry;
  },
  cliHints: { name: 'section-get', positional: ['section_id'] },
};

const list_note_section_entries: Operation = {
  name: 'list_note_section_entries',
  description: 'List derived note-section entries for structural inspection.',
  params: {
    page_slug: { type: 'string', required: true, description: 'Canonical page slug' },
    scope_id: { type: 'string', description: 'Section scope id (default: workspace:default)' },
    limit: { type: 'number', description: 'Max results (default 50)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.listNoteSectionEntries({
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      page_slug: String(p.page_slug),
      limit: (p.limit as number) ?? 50,
    });
  },
  cliHints: { name: 'section-list', positional: ['page_slug'], aliases: { n: 'limit' } },
};

const rebuild_note_sections: Operation = {
  name: 'rebuild_note_sections',
  description: 'Rebuild derived note-section rows from canonical page state.',
  params: {
    page_slug: { type: 'string', description: 'Optional slug to rebuild a single page' },
    scope_id: { type: 'string', description: 'Section scope id (default: workspace:default)' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    const pageSlug = typeof p.page_slug === 'string' ? p.page_slug : undefined;

    if (ctx.dryRun) {
      return { dry_run: true, action: 'rebuild_note_sections', scope_id: scopeId, page_slug: pageSlug ?? null };
    }

    try {
      const entries = await rebuildNoteSectionEntries(ctx.engine, {
        scope_id: scopeId,
        page_slug: pageSlug,
      });
      return {
        scope_id: scopeId,
        rebuilt: entries.length,
        section_ids: entries.map((entry) => entry.section_id),
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Page not found:')) {
        throw new OperationError(
          'page_not_found',
          error.message,
          'Check the slug or omit it to rebuild all section entries.',
        );
      }
      throw error;
    }
  },
  cliHints: { name: 'section-rebuild' },
};

const get_note_structural_neighbors: Operation = {
  name: 'get_note_structural_neighbors',
  description: 'List deterministic structural neighbors for a page or section node.',
  params: {
    node_id: { type: 'string', required: true, description: 'page:<slug> or section:<section_id>' },
    scope_id: { type: 'string', description: 'Structural scope id (default: workspace:default)' },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  handler: async (ctx, p) => {
    try {
      return await getStructuralNeighbors(ctx.engine, structuralNodeId(String(p.node_id)), {
        scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
        limit: (p.limit as number) ?? 20,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid structural node id:')) {
        throw new OperationError('invalid_params', error.message);
      }
      if (error instanceof Error && error.message.startsWith('Structural node not found:')) {
        throw new OperationError('page_not_found', error.message);
      }
      throw error;
    }
  },
  cliHints: { name: 'section-neighbors', positional: ['node_id'], aliases: { n: 'limit' } },
};

const find_note_structural_path: Operation = {
  name: 'find_note_structural_path',
  description: 'Find a bounded deterministic structural path between two nodes.',
  params: {
    from_node_id: { type: 'string', required: true, description: 'Start node id' },
    to_node_id: { type: 'string', required: true, description: 'Target node id' },
    scope_id: { type: 'string', description: 'Structural scope id (default: workspace:default)' },
    max_depth: { type: 'number', description: 'Maximum hop count (default 6)' },
  },
  handler: async (ctx, p) => {
    try {
      return await findStructuralPath(
        ctx.engine,
        structuralNodeId(String(p.from_node_id)),
        structuralNodeId(String(p.to_node_id)),
        {
          scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
          max_depth: (p.max_depth as number) ?? 6,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid structural node id:')) {
        throw new OperationError('invalid_params', error.message);
      }
      if (error instanceof Error && error.message.startsWith('Structural node not found:')) {
        throw new OperationError('page_not_found', error.message);
      }
      throw error;
    }
  },
  cliHints: { name: 'section-path', positional: ['from_node_id', 'to_node_id'] },
};

const build_context_map: Operation = {
  name: 'build_context_map',
  description: 'Build or rebuild the persisted structural workspace context map.',
  params: {
    scope_id: { type: 'string', description: 'Context-map scope id (default: workspace:default)' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    if (ctx.dryRun) {
      return { dry_run: true, action: 'build_context_map', scope_id: scopeId };
    }
    return buildStructuralContextMapEntry(ctx.engine, scopeId);
  },
  cliHints: { name: 'map-build' },
};

const get_context_map_entry: Operation = {
  name: 'get_context_map_entry',
  description: 'Get one persisted structural context map by id.',
  params: {
    id: { type: 'string', required: true, description: 'Context map id' },
  },
  handler: async (ctx, p) => {
    const entry = await getStructuralContextMapEntry(ctx.engine, String(p.id));
    if (!entry) {
      throw new OperationError(
        'page_not_found',
        `Context map entry not found: ${String(p.id)}`,
        'Run map-build for the relevant scope first.',
      );
    }
    return entry;
  },
  cliHints: { name: 'map-get', positional: ['id'] },
};

const list_context_map_entries: Operation = {
  name: 'list_context_map_entries',
  description: 'List persisted structural context map entries.',
  params: {
    scope_id: { type: 'string', description: 'Context-map scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional context-map kind filter' },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  handler: async (ctx, p) => {
    return listStructuralContextMapEntries(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      limit: (p.limit as number) ?? 20,
    });
  },
  cliHints: { name: 'map-list', aliases: { n: 'limit' } },
};

const build_context_atlas: Operation = {
  name: 'build_context_atlas',
  description: 'Build or rebuild the persisted workspace atlas registry entry.',
  params: {
    scope_id: { type: 'string', description: 'Atlas scope id (default: workspace:default)' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    if (ctx.dryRun) {
      return { dry_run: true, action: 'build_context_atlas', scope_id: scopeId };
    }
    return buildStructuralContextAtlasEntry(ctx.engine, scopeId);
  },
  cliHints: { name: 'atlas-build' },
};

const get_context_atlas_entry: Operation = {
  name: 'get_context_atlas_entry',
  description: 'Get one persisted atlas registry entry by id.',
  params: {
    id: { type: 'string', required: true, description: 'Atlas entry id' },
  },
  handler: async (ctx, p) => {
    const entry = await getStructuralContextAtlasEntry(ctx.engine, String(p.id));
    if (!entry) {
      throw new OperationError(
        'page_not_found',
        `Context atlas entry not found: ${String(p.id)}`,
        'Run atlas-build for the relevant scope first.',
      );
    }
    return entry;
  },
  cliHints: { name: 'atlas-get', positional: ['id'] },
};

const list_context_atlas_entries: Operation = {
  name: 'list_context_atlas_entries',
  description: 'List persisted atlas registry entries.',
  params: {
    scope_id: { type: 'string', description: 'Atlas scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional atlas kind filter' },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  handler: async (ctx, p) => {
    return listStructuralContextAtlasEntries(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      limit: (p.limit as number) ?? 20,
    });
  },
  cliHints: { name: 'atlas-list', aliases: { n: 'limit' } },
};

const select_context_atlas_entry: Operation = {
  name: 'select_context_atlas_entry',
  description: 'Select the best persisted atlas registry entry for a scope.',
  params: {
    scope_id: { type: 'string', description: 'Atlas scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional atlas kind filter' },
    max_budget_hint: { type: 'number', description: 'Optional maximum allowed budget hint' },
    allow_stale: { type: 'boolean', description: 'Allow stale atlas entries when no fresh match exists' },
  },
  handler: async (ctx, p) => {
    return selectStructuralContextAtlasEntry(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      max_budget_hint: typeof p.max_budget_hint === 'number' ? p.max_budget_hint : undefined,
      allow_stale: p.allow_stale === true,
    });
  },
  cliHints: { name: 'atlas-select' },
};

const get_context_atlas_overview: Operation = {
  name: 'get_context_atlas_overview',
  description: 'Render a compact overview artifact for a persisted atlas entry.',
  params: {
    atlas_id: { type: 'string', description: 'Optional atlas entry id for a direct read' },
    scope_id: { type: 'string', description: 'Atlas scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional atlas kind filter when atlas_id is omitted' },
    max_budget_hint: { type: 'number', description: 'Optional maximum allowed budget hint for selection' },
    allow_stale: { type: 'boolean', description: 'Allow stale atlas entries when atlas_id is omitted' },
  },
  handler: async (ctx, p) => {
    return getStructuralContextAtlasOverview(ctx.engine, {
      atlas_id: typeof p.atlas_id === 'string' ? p.atlas_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      max_budget_hint: typeof p.max_budget_hint === 'number' ? p.max_budget_hint : undefined,
      allow_stale: p.allow_stale === true,
    });
  },
  cliHints: { name: 'atlas-overview' },
};

const get_context_atlas_report: Operation = {
  name: 'get_context_atlas_report',
  description: 'Render a compact human-readable report for a persisted atlas entry.',
  params: {
    atlas_id: { type: 'string', description: 'Optional atlas entry id for a direct read' },
    scope_id: { type: 'string', description: 'Atlas scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional atlas kind filter when atlas_id is omitted' },
    max_budget_hint: { type: 'number', description: 'Optional maximum allowed budget hint for selection' },
    allow_stale: { type: 'boolean', description: 'Allow stale atlas entries when atlas_id is omitted' },
  },
  handler: async (ctx, p) => {
    return getStructuralContextAtlasReport(ctx.engine, {
      atlas_id: typeof p.atlas_id === 'string' ? p.atlas_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      max_budget_hint: typeof p.max_budget_hint === 'number' ? p.max_budget_hint : undefined,
      allow_stale: p.allow_stale === true,
    });
  },
  cliHints: { name: 'atlas-report' },
};

const get_atlas_orientation_card: Operation = {
  name: 'get_atlas_orientation_card',
  description: 'Render a compact orientation card from atlas selection and the workspace corpus card.',
  params: {
    atlas_id: { type: 'string', description: 'Optional atlas entry id for a direct read' },
    scope_id: { type: 'string', description: 'Atlas scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional atlas kind filter when atlas_id is omitted' },
    max_budget_hint: { type: 'number', description: 'Optional maximum allowed budget hint for selection' },
    allow_stale: { type: 'boolean', description: 'Allow stale atlas entries when atlas_id is omitted' },
  },
  handler: async (ctx, p) => {
    return getAtlasOrientationCard(ctx.engine, {
      atlas_id: typeof p.atlas_id === 'string' ? p.atlas_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      max_budget_hint: typeof p.max_budget_hint === 'number' ? p.max_budget_hint : undefined,
      allow_stale: p.allow_stale === true,
    });
  },
  cliHints: { name: 'atlas-orientation-card' },
};

const get_atlas_orientation_bundle: Operation = {
  name: 'get_atlas_orientation_bundle',
  description: 'Render a compact atlas bundle from atlas report and atlas orientation card.',
  params: {
    atlas_id: { type: 'string', description: 'Optional atlas entry id for a direct read' },
    scope_id: { type: 'string', description: 'Atlas scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional atlas kind filter when atlas_id is omitted' },
    max_budget_hint: { type: 'number', description: 'Optional maximum allowed budget hint for selection' },
    allow_stale: { type: 'boolean', description: 'Allow stale atlas entries when atlas_id is omitted' },
  },
  handler: async (ctx, p) => {
    return getAtlasOrientationBundle(ctx.engine, {
      atlas_id: typeof p.atlas_id === 'string' ? p.atlas_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      max_budget_hint: typeof p.max_budget_hint === 'number' ? p.max_budget_hint : undefined,
      allow_stale: p.allow_stale === true,
    });
  },
  cliHints: { name: 'atlas-orientation-bundle' },
};

const get_context_map_report: Operation = {
  name: 'get_context_map_report',
  description: 'Render a compact human-readable report for a persisted context map.',
  params: {
    map_id: { type: 'string', description: 'Optional context map id for a direct read' },
    scope_id: { type: 'string', description: 'Map scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter when map_id is omitted' },
  },
  handler: async (ctx, p) => {
    return getStructuralContextMapReport(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
    });
  },
  cliHints: { name: 'map-report' },
};

const get_context_map_explanation: Operation = {
  name: 'get_context_map_explanation',
  description: 'Render a bounded local explanation for one node inside a persisted context map.',
  params: {
    map_id: { type: 'string', description: 'Optional context map id for a direct read' },
    scope_id: { type: 'string', description: 'Map scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter when map_id is omitted' },
    node_id: { type: 'string', required: true, description: 'Exact structural node id to explain' },
  },
  handler: async (ctx, p) => {
    return getStructuralContextMapExplanation(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      node_id: String(p.node_id),
    });
  },
  cliHints: { name: 'map-explain' },
};

const query_context_map: Operation = {
  name: 'query_context_map',
  description: 'Run a bounded structural query over one persisted context map.',
  params: {
    map_id: { type: 'string', description: 'Optional context map id for a direct read' },
    scope_id: { type: 'string', description: 'Map scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter when map_id is omitted' },
    query: { type: 'string', required: true, description: 'Plain-text structural query string' },
    limit: { type: 'number', description: 'Max matched nodes to return (default 5)' },
  },
  handler: async (ctx, p) => {
    return queryStructuralContextMap(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      query: String(p.query),
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    });
  },
  cliHints: { name: 'map-query', aliases: { n: 'limit' } },
};

const find_context_map_path: Operation = {
  name: 'find_context_map_path',
  description: 'Find a bounded structural path inside one persisted context map.',
  params: {
    map_id: { type: 'string', description: 'Optional context map id for a direct read' },
    scope_id: { type: 'string', description: 'Map scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter when map_id is omitted' },
    from_node_id: { type: 'string', required: true, description: 'Exact start node id' },
    to_node_id: { type: 'string', required: true, description: 'Exact target node id' },
    max_depth: { type: 'number', description: 'Optional maximum search depth (default 6)' },
  },
  handler: async (ctx, p) => {
    return findStructuralContextMapPath(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      from_node_id: String(p.from_node_id),
      to_node_id: String(p.to_node_id),
      max_depth: typeof p.max_depth === 'number' ? p.max_depth : undefined,
    });
  },
  cliHints: { name: 'map-path', positional: ['from_node_id', 'to_node_id'] },
};

const get_broad_synthesis_route: Operation = {
  name: 'get_broad_synthesis_route',
  description: 'Compose report, structural query, and optional explain into one bounded broad-synthesis route.',
  params: {
    map_id: { type: 'string', description: 'Optional context map id for a direct read' },
    scope_id: { type: 'string', description: 'Map scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter when map_id is omitted' },
    query: { type: 'string', required: true, description: 'Plain-text route query string' },
    limit: { type: 'number', description: 'Max matched nodes to inspect while composing the route (default 5)' },
  },
  handler: async (ctx, p) => {
    return getBroadSynthesisRoute(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
      query: String(p.query),
      limit: typeof p.limit === 'number' ? p.limit : undefined,
    });
  },
  cliHints: { name: 'broad-synthesis-route', aliases: { n: 'limit' } },
};

const get_precision_lookup_route: Operation = {
  name: 'get_precision_lookup_route',
  description: 'Resolve an exact canonical page or section route for precision lookup intent.',
  params: {
    scope_id: { type: 'string', description: 'Canonical note scope id (default: workspace:default)' },
    slug: { type: 'string', description: 'Exact canonical page slug' },
    path: { type: 'string', description: 'Exact canonical note path, optionally with #section/path fragment' },
    section_id: { type: 'string', description: 'Exact canonical section id' },
    source_ref: { type: 'string', description: 'Exact extracted source reference string' },
  },
  handler: async (ctx, p) => {
    return getPrecisionLookupRoute(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      slug: typeof p.slug === 'string' ? p.slug : undefined,
      path: typeof p.path === 'string' ? p.path : undefined,
      section_id: typeof p.section_id === 'string' ? p.section_id : undefined,
      source_ref: typeof p.source_ref === 'string' ? p.source_ref : undefined,
    });
  },
  cliHints: { name: 'precision-lookup-route' },
};

const get_mixed_scope_bridge: Operation = {
  name: 'get_mixed_scope_bridge',
  description: 'Resolve the published explicit mixed-scope bridge across one work route and one personal route.',
  params: {
    requested_scope: { type: 'string', description: 'Explicit scope override; must be mixed for this route', enum: ['work', 'personal', 'mixed'] },
    personal_route_kind: { type: 'string', required: true, description: 'Personal-side route kind for the bridge', enum: ['profile', 'episode'] },
    map_id: { type: 'string', description: 'Optional context map id for the work-side broad synthesis route' },
    scope_id: { type: 'string', description: 'Work-side scope id for broad synthesis (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter for the work-side route' },
    query: { type: 'string', required: true, description: 'Work-side broad synthesis query' },
    limit: { type: 'number', description: 'Optional work-side match limit' },
    subject: { type: 'string', description: 'Exact personal profile subject for the personal-side profile route' },
    profile_type: {
      type: 'string',
      description: 'Optional exact personal profile-memory type filter',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    episode_title: { type: 'string', description: 'Exact personal episode title for the personal-side episode route' },
    episode_source_kind: {
      type: 'string',
      description: 'Optional exact personal episode source kind filter',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
  },
  handler: async (ctx, p) => {
    const personalRouteKind = String(p.personal_route_kind);
    if (personalRouteKind !== 'profile' && personalRouteKind !== 'episode') {
      throw new OperationError('invalid_params', 'personal_route_kind must be one of profile or episode.');
    }
    if (personalRouteKind === 'profile' && typeof p.subject !== 'string') {
      throw new OperationError('invalid_params', 'profile mixed bridge requires subject.');
    }
    if (personalRouteKind === 'episode' && typeof p.episode_title !== 'string') {
      throw new OperationError('invalid_params', 'episode mixed bridge requires episode_title.');
    }

    return getMixedScopeBridge(ctx.engine, {
      requested_scope: typeof p.requested_scope === 'string' ? p.requested_scope as any : undefined,
      personal_route_kind: personalRouteKind as any,
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: typeof p.kind === 'string' ? p.kind : undefined,
      query: String(p.query),
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      profile_type: typeof p.profile_type === 'string' ? p.profile_type as any : undefined,
      episode_title: typeof p.episode_title === 'string' ? p.episode_title : undefined,
      episode_source_kind: typeof p.episode_source_kind === 'string' ? p.episode_source_kind as any : undefined,
    });
  },
  cliHints: { name: 'mixed-scope-bridge' },
};

const get_mixed_scope_disclosure: Operation = {
  name: 'get_mixed_scope_disclosure',
  description: 'Project a resolved mixed-scope bridge into a visibility-safe disclosure artifact.',
  params: {
    requested_scope: { type: 'string', description: 'Explicit scope override; must be mixed for this route', enum: ['work', 'personal', 'mixed'] },
    personal_route_kind: { type: 'string', required: true, description: 'Personal-side route kind for the bridge', enum: ['profile', 'episode'] },
    map_id: { type: 'string', description: 'Optional context map id for the work-side broad synthesis route' },
    scope_id: { type: 'string', description: 'Work-side scope id for broad synthesis (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter for the work-side route' },
    query: { type: 'string', required: true, description: 'Work-side broad synthesis query' },
    limit: { type: 'number', description: 'Optional work-side match limit' },
    subject: { type: 'string', description: 'Exact personal profile subject for the personal-side profile route' },
    profile_type: {
      type: 'string',
      description: 'Optional exact personal profile-memory type filter',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    episode_title: { type: 'string', description: 'Exact personal episode title for the personal-side episode route' },
    episode_source_kind: {
      type: 'string',
      description: 'Optional exact personal episode source kind filter',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
  },
  handler: async (ctx, p) => {
    const personalRouteKind = String(p.personal_route_kind);
    if (personalRouteKind !== 'profile' && personalRouteKind !== 'episode') {
      throw new OperationError('invalid_params', 'personal_route_kind must be one of profile or episode.');
    }
    if (personalRouteKind === 'profile' && typeof p.subject !== 'string') {
      throw new OperationError('invalid_params', 'profile mixed disclosure requires subject.');
    }
    if (personalRouteKind === 'episode' && typeof p.episode_title !== 'string') {
      throw new OperationError('invalid_params', 'episode mixed disclosure requires episode_title.');
    }

    return getMixedScopeDisclosure(ctx.engine, {
      requested_scope: typeof p.requested_scope === 'string' ? p.requested_scope as any : undefined,
      personal_route_kind: personalRouteKind as any,
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: typeof p.kind === 'string' ? p.kind : undefined,
      query: String(p.query),
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      profile_type: typeof p.profile_type === 'string' ? p.profile_type as any : undefined,
      episode_title: typeof p.episode_title === 'string' ? p.episode_title : undefined,
      episode_source_kind: typeof p.episode_source_kind === 'string' ? p.episode_source_kind as any : undefined,
    });
  },
  cliHints: { name: 'mixed-scope-disclosure' },
};

const get_personal_profile_lookup_route: Operation = {
  name: 'get_personal_profile_lookup_route',
  description: 'Resolve an exact personal profile-memory route for personal/profile lookup intent.',
  params: {
    scope_id: { type: 'string', description: 'Personal profile-memory scope id (default: personal:default)' },
    requested_scope: { type: 'string', description: 'Optional explicit scope override for gate enforcement', enum: ['work', 'personal', 'mixed'] },
    query: { type: 'string', description: 'Optional natural-language query for gate inference' },
    subject: { type: 'string', required: true, description: 'Exact personal profile subject' },
    profile_type: {
      type: 'string',
      description: 'Optional exact profile-memory type filter',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
  },
  handler: async (ctx, p) => {
    return getPersonalProfileLookupRoute(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_PROFILE_MEMORY_SCOPE_ID),
      requested_scope: typeof p.requested_scope === 'string' ? p.requested_scope as any : undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      subject: String(p.subject),
      profile_type: typeof p.profile_type === 'string' ? p.profile_type as any : undefined,
    });
  },
  cliHints: { name: 'personal-profile-lookup-route' },
};

const get_personal_episode_lookup_route: Operation = {
  name: 'get_personal_episode_lookup_route',
  description: 'Resolve an exact personal episode route for personal/episode lookup intent.',
  params: {
    scope_id: { type: 'string', description: 'Personal episode scope id (default: personal:default)' },
    requested_scope: { type: 'string', description: 'Optional explicit scope override for gate enforcement', enum: ['work', 'personal', 'mixed'] },
    query: { type: 'string', description: 'Optional natural-language query for gate inference' },
    title: { type: 'string', required: true, description: 'Exact personal episode title' },
    source_kind: {
      type: 'string',
      description: 'Optional exact personal episode source kind filter',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
  },
  handler: async (ctx, p) => {
    return getPersonalEpisodeLookupRoute(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_PERSONAL_EPISODE_SCOPE_ID),
      requested_scope: typeof p.requested_scope === 'string' ? p.requested_scope as any : undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      title: String(p.title),
      source_kind: typeof p.source_kind === 'string' ? p.source_kind as any : undefined,
    });
  },
  cliHints: { name: 'personal-episode-lookup-route' },
};

const select_personal_write_target: Operation = {
  name: 'select_personal_write_target',
  description: 'Select the safe personal durable-memory target after scope-gate preflight.',
  params: {
    target_kind: {
      type: 'string',
      required: true,
      description: 'One of profile_memory or personal_episode',
      enum: ['profile_memory', 'personal_episode'],
    },
    requested_scope: { type: 'string', description: 'Optional explicit scope override', enum: ['work', 'personal', 'mixed'] },
    query: { type: 'string', description: 'Optional plain-text request used for scope classification' },
    subject: { type: 'string', description: 'Optional profile-memory subject when target_kind is profile_memory' },
    title: { type: 'string', description: 'Optional personal-episode title when target_kind is personal_episode' },
  },
  handler: async (ctx, p) => {
    const targetKind = String(p.target_kind);
    if (targetKind !== 'profile_memory' && targetKind !== 'personal_episode') {
      throw new OperationError('invalid_params', 'target_kind must be one of profile_memory or personal_episode.');
    }

    return selectPersonalWriteTarget(ctx.engine, {
      target_kind: targetKind as any,
      requested_scope: typeof p.requested_scope === 'string' ? p.requested_scope as any : undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      title: typeof p.title === 'string' ? p.title : undefined,
    });
  },
  cliHints: { name: 'personal-write-target' },
};

const preview_personal_export: Operation = {
  name: 'preview_personal_export',
  description: 'Preview the personal records that are currently exportable under published visibility rules.',
  params: {
    requested_scope: { type: 'string', description: 'Optional explicit scope override', enum: ['work', 'personal', 'mixed'] },
    query: { type: 'string', description: 'Optional plain-text request used for scope classification' },
    scope_id: { type: 'string', description: 'Optional personal scope id for the export preview (default: personal:default)' },
  },
  handler: async (ctx, p) => {
    return previewPersonalExport(ctx.engine, {
      requested_scope: typeof p.requested_scope === 'string' ? p.requested_scope as any : undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      scope_id: typeof p.scope_id === 'string' ? p.scope_id : undefined,
    });
  },
  cliHints: { name: 'personal-export-preview' },
};

const evaluate_scope_gate: Operation = {
  name: 'evaluate_scope_gate',
  description: 'Evaluate the deterministic scope gate for the current published retrieval stack.',
  params: {
    intent: { type: 'string', required: true, description: 'One of task_resume, broad_synthesis, precision_lookup, mixed_scope_bridge, personal_profile_lookup, personal_episode_lookup' },
    requested_scope: { type: 'string', description: 'Optional explicit scope override', enum: ['work', 'personal', 'mixed'] },
    task_id: { type: 'string', description: 'Task id used to derive task scope when present' },
    query: { type: 'string', description: 'Optional plain-text request used for signal detection' },
    repo_path: { type: 'string', description: 'Optional repo path or file path used for work-signal detection' },
    subject: { type: 'string', description: 'Optional personal profile subject used for signal detection' },
    episode_title: { type: 'string', description: 'Optional personal episode title used for signal detection' },
  },
  handler: async (ctx, p) => {
    const intent = String(p.intent);
    if (
      intent !== 'task_resume'
      && intent !== 'broad_synthesis'
      && intent !== 'precision_lookup'
      && intent !== 'mixed_scope_bridge'
      && intent !== 'personal_profile_lookup'
      && intent !== 'personal_episode_lookup'
    ) {
      throw new OperationError('invalid_params', 'intent must be one of task_resume, broad_synthesis, precision_lookup, mixed_scope_bridge, personal_profile_lookup, personal_episode_lookup.');
    }

    return evaluateScopeGate(ctx.engine, {
      intent,
      requested_scope: typeof p.requested_scope === 'string' ? p.requested_scope as any : undefined,
      task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      repo_path: typeof p.repo_path === 'string' ? p.repo_path : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      title: typeof p.episode_title === 'string' ? p.episode_title : undefined,
    });
  },
  cliHints: { name: 'scope-gate' },
};

const select_retrieval_route: Operation = {
  name: 'select_retrieval_route',
  description: 'Select one published retrieval route by explicit intent.',
  params: {
    intent: { type: 'string', required: true, description: 'One of task_resume, broad_synthesis, precision_lookup, mixed_scope_bridge, personal_profile_lookup, personal_episode_lookup' },
    task_id: { type: 'string', description: 'Task id for task_resume intent' },
    persist_trace: { type: 'boolean', description: 'Persist a Retrieval Trace for the selected route; task_id is optional and task-less traces are stored with task_id=null' },
    requested_scope: { type: 'string', description: 'Optional explicit scope override', enum: ['work', 'personal', 'mixed'] },
    personal_route_kind: { type: 'string', description: 'Personal-side route kind for mixed_scope_bridge intent', enum: ['profile', 'episode'] },
    map_id: { type: 'string', description: 'Optional context map id for broad_synthesis intent' },
    scope_id: { type: 'string', description: 'Scope id for delegated route selection' },
    kind: { type: 'string', description: 'Optional map kind filter for broad_synthesis intent' },
    query: { type: 'string', description: 'Query string for broad_synthesis intent' },
    limit: { type: 'number', description: 'Optional broad_synthesis match limit' },
    slug: { type: 'string', description: 'Exact slug for precision_lookup intent' },
    path: { type: 'string', description: 'Exact path for precision_lookup intent, optionally with #section/path fragment' },
    section_id: { type: 'string', description: 'Exact section id for precision_lookup intent' },
    source_ref: { type: 'string', description: 'Exact extracted source reference string for precision_lookup intent' },
    subject: { type: 'string', description: 'Exact profile-memory subject for personal_profile_lookup intent' },
    profile_type: {
      type: 'string',
      description: 'Optional exact profile-memory type filter for personal_profile_lookup intent',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    episode_title: { type: 'string', description: 'Exact personal episode title for personal_episode_lookup intent' },
    episode_source_kind: {
      type: 'string',
      description: 'Optional exact personal episode source kind filter for personal_episode_lookup intent',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
  },
  handler: async (ctx, p) => {
    const intent = String(p.intent);
    if (
      intent !== 'task_resume'
      && intent !== 'broad_synthesis'
      && intent !== 'precision_lookup'
      && intent !== 'mixed_scope_bridge'
      && intent !== 'personal_profile_lookup'
      && intent !== 'personal_episode_lookup'
    ) {
      throw new OperationError('invalid_params', 'intent must be one of task_resume, broad_synthesis, precision_lookup, mixed_scope_bridge, personal_profile_lookup, personal_episode_lookup.');
    }
    if (intent === 'task_resume' && typeof p.task_id !== 'string') {
      throw new OperationError('invalid_params', 'task_resume intent requires task_id.');
    }
    if (intent === 'broad_synthesis' && typeof p.query !== 'string') {
      throw new OperationError('invalid_params', 'broad_synthesis intent requires query.');
    }
    if (intent === 'mixed_scope_bridge' && typeof p.personal_route_kind !== 'string') {
      throw new OperationError('invalid_params', 'mixed_scope_bridge intent requires personal_route_kind.');
    }
    if (intent === 'mixed_scope_bridge' && typeof p.query !== 'string') {
      throw new OperationError('invalid_params', 'mixed_scope_bridge intent requires query.');
    }
    if (intent === 'mixed_scope_bridge' && p.personal_route_kind === 'profile' && typeof p.subject !== 'string') {
      throw new OperationError('invalid_params', 'mixed_scope_bridge profile intent requires subject.');
    }
    if (intent === 'mixed_scope_bridge' && p.personal_route_kind === 'episode' && typeof p.episode_title !== 'string') {
      throw new OperationError('invalid_params', 'mixed_scope_bridge episode intent requires episode_title.');
    }
    if (intent === 'personal_profile_lookup' && typeof p.subject !== 'string') {
      throw new OperationError('invalid_params', 'personal_profile_lookup intent requires subject.');
    }
    if (intent === 'personal_episode_lookup' && typeof p.episode_title !== 'string') {
      throw new OperationError('invalid_params', 'personal_episode_lookup intent requires episode_title.');
    }
    if (intent === 'precision_lookup' && typeof p.slug !== 'string' && typeof p.section_id !== 'string') {
      if (typeof p.path !== 'string' && typeof p.source_ref !== 'string') {
        throw new OperationError('invalid_params', 'precision_lookup intent requires slug, path, section_id, or source_ref.');
      }
    }
    return selectRetrievalRoute(ctx.engine, {
      intent,
      task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
      persist_trace: p.persist_trace === true,
      requested_scope: typeof p.requested_scope === 'string' ? p.requested_scope as any : undefined,
      personal_route_kind: typeof p.personal_route_kind === 'string' ? p.personal_route_kind as any : undefined,
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? (
        intent === 'personal_profile_lookup'
          ? DEFAULT_PROFILE_MEMORY_SCOPE_ID
          : intent === 'personal_episode_lookup'
            ? DEFAULT_PERSONAL_EPISODE_SCOPE_ID
            : DEFAULT_NOTE_MANIFEST_SCOPE_ID
      )),
      kind: p.kind as string | undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      slug: typeof p.slug === 'string' ? p.slug : undefined,
      path: typeof p.path === 'string' ? p.path : undefined,
      section_id: typeof p.section_id === 'string' ? p.section_id : undefined,
      source_ref: typeof p.source_ref === 'string' ? p.source_ref : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      profile_type: typeof p.profile_type === 'string' ? p.profile_type as any : undefined,
      episode_title: typeof p.episode_title === 'string' ? p.episode_title : undefined,
      episode_source_kind: typeof p.episode_source_kind === 'string' ? p.episode_source_kind as any : undefined,
    });
  },
  cliHints: { name: 'retrieval-route' },
};

const plan_retrieval_request: Operation = {
  name: 'plan_retrieval_request',
  description: 'Plan one or more retrieval route selections for a high-level request without executing them.',
  params: {
    intent: { type: 'string', description: 'Optional explicit intent override', enum: [...RETRIEVAL_ROUTE_INTENTS] },
    allow_decomposition: { type: 'boolean', description: 'Allow deterministic decomposition into multiple route intents' },
    task_id: { type: 'string', description: 'Task id for task_resume decomposition or inference' },
    persist_trace: { type: 'boolean', description: 'Forwarded trace preference for planned selector inputs' },
    requested_scope: { type: 'string', description: 'Optional explicit scope override', enum: [...REQUESTED_SCOPES] },
    personal_route_kind: { type: 'string', description: 'Personal-side route kind for mixed_scope_bridge planning', enum: [...PERSONAL_ROUTE_KINDS] },
    map_id: { type: 'string', description: 'Optional context map id for broad_synthesis planning' },
    scope_id: { type: 'string', description: 'Scope id for planned route selection' },
    kind: { type: 'string', description: 'Optional map kind filter for broad_synthesis planning' },
    query: { type: 'string', description: 'Query string for synthesis or signal inference' },
    limit: { type: 'number', description: 'Optional broad_synthesis match limit' },
    slug: { type: 'string', description: 'Exact slug for precision_lookup planning' },
    path: { type: 'string', description: 'Exact path for precision_lookup planning, optionally with #section/path fragment' },
    section_id: { type: 'string', description: 'Exact section id for precision_lookup planning' },
    source_ref: { type: 'string', description: 'Exact extracted source reference string for precision_lookup planning' },
    subject: { type: 'string', description: 'Exact profile-memory subject for personal_profile_lookup or mixed planning' },
    profile_type: {
      type: 'string',
      description: 'Optional exact profile-memory type filter for personal_profile_lookup planning',
      enum: [...PROFILE_MEMORY_TYPES],
    },
    episode_title: { type: 'string', description: 'Exact personal episode title for personal_episode_lookup planning' },
    episode_source_kind: {
      type: 'string',
      description: 'Optional exact personal episode source kind filter for personal_episode_lookup planning',
      enum: [...PERSONAL_EPISODE_SOURCE_KINDS],
    },
  },
  mutating: false,
  handler: async (_ctx, p) => {
    const input: RetrievalRequestPlannerInput = {
      intent: parseEnumParam(p.intent, 'intent', RETRIEVAL_ROUTE_INTENTS),
      allow_decomposition: p.allow_decomposition === true,
      task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
      persist_trace: p.persist_trace === true,
      requested_scope: parseEnumParam(p.requested_scope, 'requested_scope', REQUESTED_SCOPES),
      personal_route_kind: parseEnumParam(p.personal_route_kind, 'personal_route_kind', PERSONAL_ROUTE_KINDS),
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: typeof p.scope_id === 'string' ? p.scope_id : undefined,
      kind: typeof p.kind === 'string' ? p.kind : undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      slug: typeof p.slug === 'string' ? p.slug : undefined,
      path: typeof p.path === 'string' ? p.path : undefined,
      section_id: typeof p.section_id === 'string' ? p.section_id : undefined,
      source_ref: typeof p.source_ref === 'string' ? p.source_ref : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      profile_type: parseEnumParam(p.profile_type, 'profile_type', PROFILE_MEMORY_TYPES),
      episode_title: typeof p.episode_title === 'string' ? p.episode_title : undefined,
      episode_source_kind: parseEnumParam(p.episode_source_kind, 'episode_source_kind', PERSONAL_EPISODE_SOURCE_KINDS),
    };

    return planRetrievalRequest(input);
  },
  cliHints: { name: 'plan-retrieval-request' },
};

const classify_memory_scenario: Operation = {
  name: 'classify_memory_scenario',
  description: 'Classify a memory request into a scenario before retrieval.',
  params: {
    query: { type: 'string', description: 'Raw user request or system task' },
    task_id: { type: 'string', description: 'Optional active task id' },
    repo_path: { type: 'string', description: 'Optional active repository path' },
    requested_scope: { type: 'string', description: 'Optional explicit scope override', enum: [...REQUESTED_SCOPES] },
    source_kind: { type: 'string', description: 'Optional source kind for classification', enum: [...MEMORY_SCENARIO_SOURCE_KINDS] },
    known_subjects: {
      type: ['array', 'string'],
      items: { type: ['string', 'object'] },
      description: 'Optional detected subject refs as strings or objects with ref and kind, or a JSON array string',
    },
  },
  mutating: false,
  handler: async (_ctx, p) => classifyMemoryScenario({
    query: parseOptionalStringParam(p.query, 'query'),
    task_id: parseOptionalStringParam(p.task_id, 'task_id'),
    repo_path: parseOptionalStringParam(p.repo_path, 'repo_path'),
    requested_scope: parseEnumParam(p.requested_scope, 'requested_scope', REQUESTED_SCOPES),
    source_kind: parseEnumParam(p.source_kind, 'source_kind', MEMORY_SCENARIO_SOURCE_KINDS),
    known_subjects: parseKnownSubjectsParam(p.known_subjects, 'known_subjects'),
  }),
  cliHints: { name: 'classify-memory-scenario', aliases: { scope: 'requested_scope' } },
};

const select_activation_policy: Operation = {
  name: 'select_activation_policy',
  description: 'Select how retrieved memory artifacts may affect a response.',
  params: {
    scenario: { type: 'string', required: true, description: 'Memory scenario', enum: [...MEMORY_SCENARIOS] },
    artifacts: {
      type: ['array', 'string'],
      items: { type: 'object' },
      description: 'Activation artifacts as objects or a JSON array string',
    },
  },
  mutating: false,
  handler: async (_ctx, p) => {
    const scenario = parseEnumParam(p.scenario, 'scenario', MEMORY_SCENARIOS);
    if (!scenario) {
      throw new OperationError('invalid_params', `scenario must be one of: ${MEMORY_SCENARIOS.join(', ')}.`);
    }

    return selectActivationPolicy({
      scenario,
      artifacts: parseActivationArtifacts(p.artifacts, 'artifacts'),
    });
  },
  cliHints: { name: 'select-activation-policy' },
};

const plan_scenario_memory_request: Operation = {
  name: 'plan_scenario_memory_request',
  description: 'Plan scenario-aware memory reads, activation, next tool, and writeback hints without mutating memory.',
  params: {
    query: { type: 'string', description: 'Raw user request or system task' },
    task_id: { type: 'string', description: 'Optional active task id' },
    repo_path: { type: 'string', description: 'Optional active repository path' },
    requested_scope: { type: 'string', description: 'Optional explicit scope override', enum: [...REQUESTED_SCOPES] },
    source_kind: { type: 'string', description: 'Optional source kind for classification', enum: [...MEMORY_SCENARIO_SOURCE_KINDS] },
    known_subjects: {
      type: ['array', 'string'],
      items: { type: ['string', 'object'] },
      description: 'Optional detected subject refs as strings or objects with ref and kind, or a JSON array string',
    },
    artifacts: {
      type: ['array', 'string'],
      items: { type: 'object' },
      description: 'Optional activation artifacts as objects or a JSON array string',
    },
  },
  mutating: false,
  handler: async (_ctx, p) => planScenarioMemoryRequest({
    query: parseOptionalStringParam(p.query, 'query'),
    task_id: parseOptionalStringParam(p.task_id, 'task_id'),
    repo_path: parseOptionalStringParam(p.repo_path, 'repo_path'),
    requested_scope: parseEnumParam(p.requested_scope, 'requested_scope', REQUESTED_SCOPES),
    source_kind: parseEnumParam(p.source_kind, 'source_kind', MEMORY_SCENARIO_SOURCE_KINDS),
    known_subjects: parseKnownSubjectsParam(p.known_subjects, 'known_subjects'),
    artifacts: parseActivationArtifacts(p.artifacts, 'artifacts'),
  }),
  cliHints: { name: 'plan-scenario-memory-request', aliases: { scope: 'requested_scope' } },
};

const reverify_code_claims: Operation = {
  name: 'reverify_code_claims',
  description: 'Re-check code path, symbol, and branch claims against the current workspace.',
  params: {
    repo_path: { type: 'string', required: true, description: 'Repository root used to verify file and symbol claims' },
    branch_name: { type: 'string', description: 'Current branch name for branch-sensitive claims' },
    claims: { type: 'array', items: { type: 'object' }, description: 'Code claims to verify directly' },
    trace_id: { type: 'string', description: 'Retrieval trace id containing code_claim verification entries' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (typeof p.repo_path !== 'string' || p.repo_path.trim().length === 0) {
      throw new OperationError('invalid_params', 'reverify_code_claims requires repo_path as a non-empty string.');
    }
    const repoPath = p.repo_path;
    const branchName = typeof p.branch_name === 'string' ? p.branch_name : undefined;
    const traceId = typeof p.trace_id === 'string' ? p.trace_id : undefined;
    const directClaims = parseCodeClaimsParam(p.claims, 'claims');
    if (traceId && directClaims !== undefined) {
      throw new OperationError('invalid_params', 'reverify_code_claims accepts either claims or trace_id, not both.');
    }

    let trace: RetrievalTrace | null = null;
    if (traceId) {
      trace = await ctx.engine.getRetrievalTrace(traceId);
      if (!trace) {
        throw new OperationError('trace_not_found', `Retrieval trace not found: ${traceId}`);
      }
    }

    const claims = directClaims ?? (trace ? extractCodeClaimsFromTrace(trace) : undefined);
    if (!claims || claims.length === 0) {
      throw new OperationError('invalid_params', 'reverify_code_claims requires claims or a trace_id with code_claim verification entries.');
    }

    const results = verifyCodeClaims({
      repo_path: repoPath,
      branch_name: branchName,
      claims,
    });
    const staleCount = results.filter((result) => result.status === 'stale').length;
    const currentCount = results.filter((result) => result.status === 'current').length;
    const unverifiableCount = results.filter((result) => result.status === 'unverifiable').length;
    const nonCurrentCount = results.length - currentCount;
    let writtenTrace: RetrievalTrace | null = null;

    if (!ctx.dryRun && trace && nonCurrentCount > 0) {
      writtenTrace = await ctx.engine.putRetrievalTrace({
        id: crypto.randomUUID(),
        task_id: trace.task_id,
        scope: trace.scope,
        route: ['code_claim_reverification'],
        source_refs: [`retrieval_trace:${trace.id}`],
        verification: results.map((result) =>
          `code_claim_result:${result.claim.path ?? result.claim.symbol ?? 'unknown'}:${result.status}:${result.reason}`),
        write_outcome: 'operational_write',
        outcome: `code claim reverify stale=${staleCount} current=${currentCount} unverifiable=${unverifiableCount}`,
      });
    }

    return {
      trace_id: trace?.id ?? null,
      results,
      written_trace: writtenTrace,
      dry_run: ctx.dryRun || undefined,
    };
  },
  cliHints: { name: 'reverify-code-claims' },
};

const get_workspace_system_card: Operation = {
  name: 'get_workspace_system_card',
  description: 'Render a compact workspace system card from the current context-map report.',
  params: {
    map_id: { type: 'string', description: 'Optional context map id for a direct read' },
    scope_id: { type: 'string', description: 'Map scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter when map_id is omitted' },
  },
  handler: async (ctx, p) => {
    return getWorkspaceSystemCard(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
    });
  },
  cliHints: { name: 'workspace-system-card' },
};

const get_workspace_project_card: Operation = {
  name: 'get_workspace_project_card',
  description: 'Render a compact workspace project card from the current context-map report.',
  params: {
    map_id: { type: 'string', description: 'Optional context map id for a direct read' },
    scope_id: { type: 'string', description: 'Map scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter when map_id is omitted' },
  },
  handler: async (ctx, p) => {
    return getWorkspaceProjectCard(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
    });
  },
  cliHints: { name: 'workspace-project-card' },
};

const get_workspace_orientation_bundle: Operation = {
  name: 'get_workspace_orientation_bundle',
  description: 'Render a compact workspace orientation bundle from the current context-map report and cards.',
  params: {
    map_id: { type: 'string', description: 'Optional context map id for a direct read' },
    scope_id: { type: 'string', description: 'Map scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter when map_id is omitted' },
  },
  handler: async (ctx, p) => {
    return getWorkspaceOrientationBundle(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
    });
  },
  cliHints: { name: 'workspace-orientation' },
};

const get_workspace_corpus_card: Operation = {
  name: 'get_workspace_corpus_card',
  description: 'Render a compact workspace corpus card from the current orientation bundle.',
  params: {
    map_id: { type: 'string', description: 'Optional context map id for a direct read' },
    scope_id: { type: 'string', description: 'Map scope id (default: workspace:default)' },
    kind: { type: 'string', description: 'Optional map kind filter when map_id is omitted' },
  },
  handler: async (ctx, p) => {
    return getWorkspaceCorpusCard(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
    });
  },
  cliHints: { name: 'workspace-corpus-card' },
};

const record_retrieval_trace: Operation = {
  name: 'record_retrieval_trace',
  description: 'Record a retrieval trace for a task-scoped operational-memory flow.',
  params: {
    task_id: { type: 'string', required: true, description: 'Task thread id' },
    outcome: { type: 'string', required: true, description: 'Trace outcome summary' },
    route: { type: 'array', items: { type: 'string' }, description: 'Ordered retrieval route' },
    source_refs: { type: 'array', items: { type: 'string' }, description: 'Source references consulted' },
    derived_consulted: { type: 'array', items: { type: 'string' }, description: 'Derived artifacts consulted separately from canonical source refs' },
    verification: { type: 'array', items: { type: 'string' }, description: 'Verification steps performed' },
    write_outcome: { type: 'string', enum: [...RETRIEVAL_TRACE_WRITE_OUTCOMES], description: 'Structured write outcome for the trace' },
    selected_intent: { type: 'string', enum: [...RETRIEVAL_ROUTE_INTENTS], description: 'Structured retrieval intent selected for the trace' },
    scope_gate_policy: { type: 'string', enum: [...SCOPE_GATE_POLICIES], description: 'Structured scope gate policy, when evaluated' },
    scope_gate_reason: { type: 'string', description: 'Structured scope gate reason, when evaluated' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const taskId = String(p.task_id);
    const route = parseStringListParam(p.route, 'route') ?? [];
    const sourceRefs = parseStringListParam(p.source_refs, 'source_refs') ?? [];
    const derivedConsulted = parseStringListParam(p.derived_consulted, 'derived_consulted') ?? [];
    const verification = parseStringListParam(p.verification, 'verification') ?? [];
    const writeOutcome = parseEnumParam(p.write_outcome, 'write_outcome', RETRIEVAL_TRACE_WRITE_OUTCOMES);
    const selectedIntent = parseEnumParam(p.selected_intent, 'selected_intent', RETRIEVAL_ROUTE_INTENTS);
    const scopeGatePolicy = parseEnumParam(p.scope_gate_policy, 'scope_gate_policy', SCOPE_GATE_POLICIES);
    const scopeGateReason = typeof p.scope_gate_reason === 'string' ? p.scope_gate_reason : undefined;

    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'record_retrieval_trace',
        task_id: taskId,
        outcome: String(p.outcome),
        route,
        source_refs: sourceRefs,
        derived_consulted: derivedConsulted,
        verification,
        write_outcome: writeOutcome,
        selected_intent: selectedIntent,
        scope_gate_policy: scopeGatePolicy,
        scope_gate_reason: scopeGateReason,
      };
    }

    const thread = await requireTaskThread(ctx.engine, taskId);
    return ctx.engine.putRetrievalTrace({
      id: crypto.randomUUID(),
      task_id: taskId,
      scope: thread.scope,
      route,
      source_refs: sourceRefs,
      derived_consulted: derivedConsulted,
      verification,
      write_outcome: writeOutcome,
      selected_intent: selectedIntent,
      scope_gate_policy: scopeGatePolicy,
      scope_gate_reason: scopeGateReason ?? null,
      outcome: String(p.outcome),
    });
  },
  cliHints: { name: 'task-trace', positional: ['task_id'] },
};

const list_task_traces: Operation = {
  name: 'list_task_traces',
  description: 'List retrieval traces for one task thread.',
  params: {
    task_id: { type: 'string', required: true, description: 'Task thread id' },
    limit: { type: 'number', description: 'Max results (default 10)' },
  },
  handler: async (ctx, p) => {
    const taskId = String(p.task_id);
    await requireTaskThread(ctx.engine, taskId);
    return ctx.engine.listRetrievalTraces(taskId, {
      limit: (p.limit as number) ?? 10,
    });
  },
  cliHints: { name: 'task-traces', positional: ['task_id'], aliases: { n: 'limit' } },
};

const list_task_attempts: Operation = {
  name: 'list_task_attempts',
  description: 'List recorded attempts for one task thread.',
  params: {
    task_id: { type: 'string', required: true, description: 'Task thread id' },
    limit: { type: 'number', description: 'Max results (default 10)' },
  },
  handler: async (ctx, p) => {
    const taskId = String(p.task_id);
    await requireTaskThread(ctx.engine, taskId);
    return ctx.engine.listTaskAttempts(taskId, {
      limit: (p.limit as number) ?? 10,
    });
  },
  cliHints: { name: 'task-attempts', positional: ['task_id'], aliases: { n: 'limit' } },
};

const list_task_decisions: Operation = {
  name: 'list_task_decisions',
  description: 'List recorded decisions for one task thread.',
  params: {
    task_id: { type: 'string', required: true, description: 'Task thread id' },
    limit: { type: 'number', description: 'Max results (default 10)' },
  },
  handler: async (ctx, p) => {
    const taskId = String(p.task_id);
    await requireTaskThread(ctx.engine, taskId);
    return ctx.engine.listTaskDecisions(taskId, {
      limit: (p.limit as number) ?? 10,
    });
  },
  cliHints: { name: 'task-decisions', positional: ['task_id'], aliases: { n: 'limit' } },
};

const refresh_task_working_set: Operation = {
  name: 'refresh_task_working_set',
  description: 'Refresh a task working set snapshot and advance its verification timestamp.',
  params: {
    task_id: { type: 'string', required: true, description: 'Task thread id' },
    active_paths: { type: 'array', items: { type: 'string' }, description: 'Active file paths' },
    active_symbols: { type: 'array', items: { type: 'string' }, description: 'Active symbols' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'Current blockers' },
    open_questions: { type: 'array', items: { type: 'string' }, description: 'Open questions' },
    next_steps: { type: 'array', items: { type: 'string' }, description: 'Next steps' },
    verification_notes: { type: 'array', items: { type: 'string' }, description: 'Verification notes' },
    last_verified_at: { type: 'string', description: 'Override verification timestamp (ISO datetime)' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const taskId = String(p.task_id);
    if (ctx.dryRun) {
      return { dry_run: true, action: 'refresh_task_working_set', task_id: taskId };
    }

    await requireTaskThread(ctx.engine, taskId);
    const existing = await ctx.engine.getTaskWorkingSet(taskId);
    return ctx.engine.upsertTaskWorkingSet({
      task_id: taskId,
      active_paths: parseStringListParam(p.active_paths, 'active_paths') ?? existing?.active_paths ?? [],
      active_symbols: parseStringListParam(p.active_symbols, 'active_symbols') ?? existing?.active_symbols ?? [],
      blockers: parseStringListParam(p.blockers, 'blockers') ?? existing?.blockers ?? [],
      open_questions: parseStringListParam(p.open_questions, 'open_questions') ?? existing?.open_questions ?? [],
      next_steps: parseStringListParam(p.next_steps, 'next_steps') ?? existing?.next_steps ?? [],
      verification_notes: parseStringListParam(p.verification_notes, 'verification_notes') ?? existing?.verification_notes ?? [],
      last_verified_at: parseOptionalDateParam(p.last_verified_at, 'last_verified_at') ?? new Date(),
    });
  },
  cliHints: { name: 'task-working-set', positional: ['task_id'] },
};

const record_attempt: Operation = {
  name: 'record_attempt',
  description: 'Record a task attempt outcome for repeated-work prevention.',
  params: {
    task_id: { type: 'string', required: true, description: 'Task thread id' },
    summary: { type: 'string', required: true, description: 'Attempt summary' },
    outcome: {
      type: 'string',
      required: true,
      description: 'Attempt outcome',
      enum: ['failed', 'partial', 'succeeded', 'abandoned'],
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) {
      return { dry_run: true, action: 'record_attempt', task_id: p.task_id, summary: p.summary };
    }

    await requireTaskThread(ctx.engine, String(p.task_id));
    return ctx.engine.recordTaskAttempt({
      id: crypto.randomUUID(),
      task_id: String(p.task_id),
      summary: String(p.summary),
      outcome: String(p.outcome) as any,
      applicability_context: {},
      evidence: [],
    });
  },
  cliHints: { name: 'task-attempt' },
};

const record_decision: Operation = {
  name: 'record_decision',
  description: 'Record a task decision and rationale.',
  params: {
    task_id: { type: 'string', required: true, description: 'Task thread id' },
    summary: { type: 'string', required: true, description: 'Decision summary' },
    rationale: { type: 'string', required: true, description: 'Decision rationale' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) {
      return { dry_run: true, action: 'record_decision', task_id: p.task_id, summary: p.summary };
    }

    await requireTaskThread(ctx.engine, String(p.task_id));
    return ctx.engine.recordTaskDecision({
      id: crypto.randomUUID(),
      task_id: String(p.task_id),
      summary: String(p.summary),
      rationale: String(p.rationale),
      consequences: [],
      validity_context: {},
    });
  },
  cliHints: { name: 'task-decision' },
};

// --- Ingest Log ---

const log_ingest: Operation = {
  name: 'log_ingest',
  description: 'Log an ingestion event',
  params: {
    source_type: { type: 'string', required: true },
    source_ref: { type: 'string', required: true },
    pages_updated: { type: 'array', required: true, items: { type: 'string' } },
    summary: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'log_ingest' };
    await ctx.engine.logIngest({
      source_type: p.source_type as string,
      source_ref: p.source_ref as string,
      pages_updated: p.pages_updated as string[],
      summary: p.summary as string,
    });
    return { status: 'ok' };
  },
};

const get_ingest_log: Operation = {
  name: 'get_ingest_log',
  description: 'Get recent ingestion log entries',
  params: {
    limit: { type: 'number', description: 'Max entries (default 20)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getIngestLog({ limit: (p.limit as number) ?? 20 });
  },
};

// --- File Operations ---

const FILE_LIST_LIMIT = 100;

const file_list: Operation = {
  name: 'file_list',
  description: 'List stored files',
  params: {
    slug: { type: 'string', description: 'Filter by page slug' },
  },
  handler: async (ctx, p) => {
    assertCapabilitySupported(ctx.config, 'files');
    const sql = db.getConnection();
    const slug = p.slug as string | undefined;
    if (slug) {
      return sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at FROM files WHERE page_slug = ${slug} ORDER BY filename LIMIT ${FILE_LIST_LIMIT}`;
    }
    return sql`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at FROM files ORDER BY page_slug, filename LIMIT ${FILE_LIST_LIMIT}`;
  },
};

const file_upload: Operation = {
  name: 'file_upload',
  description: 'Upload a file to storage',
  params: {
    path: { type: 'string', required: true, description: 'Local file path' },
    page_slug: { type: 'string', description: 'Associate with page' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    assertCapabilitySupported(ctx.config, 'files');
    if (ctx.dryRun) return { dry_run: true, action: 'file_upload', path: p.path };

    const { readFileSync, statSync } = await import('fs');
    const { basename, extname } = await import('path');
    const { createHash } = await import('crypto');

    const filePath = p.path as string;
    const pageSlug = (p.page_slug as string) || null;
    const stat = statSync(filePath);
    const content = readFileSync(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    const filename = basename(filePath);
    const storagePath = pageSlug ? `${pageSlug}/${filename}` : `unsorted/${hash.slice(0, 8)}-${filename}`;

    const MIME_TYPES: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
    };
    const mimeType = MIME_TYPES[extname(filePath).toLowerCase()] || null;

    const sql = db.getConnection();
    const existing = await sql`SELECT id FROM files WHERE content_hash = ${hash} AND storage_path = ${storagePath}`;
    if (existing.length > 0) {
      return { status: 'already_exists', storage_path: storagePath };
    }

    // Upload to storage backend if configured
    if (ctx.config.storage) {
      const { createStorage } = await import('./storage.ts');
      const storage = await createStorage(ctx.config.storage as any);
      try {
        await storage.upload(storagePath, content, mimeType || undefined);
      } catch (uploadErr) {
        throw new OperationError('storage_error', `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`);
      }
    }

    try {
      await sql`
        INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
        VALUES (${pageSlug}, ${filename}, ${storagePath}, ${mimeType}, ${stat.size}, ${hash}, ${'{}'}::jsonb)
        ON CONFLICT (storage_path) DO UPDATE SET
          content_hash = EXCLUDED.content_hash,
          size_bytes = EXCLUDED.size_bytes,
          mime_type = EXCLUDED.mime_type
      `;
    } catch (dbErr) {
      // Rollback: clean up storage if DB write failed
      if (ctx.config.storage) {
        try {
          const { createStorage } = await import('./storage.ts');
          const storage = await createStorage(ctx.config.storage as any);
          await storage.delete(storagePath);
        } catch { /* best effort cleanup */ }
      }
      throw dbErr;
    }

    return { status: 'uploaded', storage_path: storagePath, size_bytes: stat.size };
  },
};

const file_url: Operation = {
  name: 'file_url',
  description: 'Get a URL for a stored file',
  params: {
    storage_path: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    assertCapabilitySupported(ctx.config, 'files');
    const sql = db.getConnection();
    const rows = await sql`SELECT storage_path, mime_type, size_bytes FROM files WHERE storage_path = ${p.storage_path as string}`;
    if (rows.length === 0) {
      throw new OperationError('storage_error', `File not found: ${p.storage_path}`);
    }
    // TODO: generate signed URL from Supabase Storage
    return { storage_path: rows[0].storage_path, url: `mbrain:files/${rows[0].storage_path}` };
  },
};

// --- Skillpack ---

const get_skillpack: Operation = {
  name: 'get_skillpack',
  description: 'Read the MBrain SKILLPACK reference architecture. Returns the full document or a specific section by number/name. Use this to learn detailed patterns for enrichment, meeting ingestion, cron schedules, and more.',
  params: {
    section: { type: 'string', description: 'Section number or keyword (e.g. "5", "enrichment", "meeting", "cron"). Omit to get the compact agent rules.' },
  },
  handler: async (_ctx, p) => {
    const section = p.section as string | undefined;

    // If no section requested, return the compact agent rules
    if (!section) {
      const rulesPath = resolveDocPath('MBRAIN_AGENT_RULES.md');
      if (!rulesPath) {
        return { error: 'not_found', message: 'MBRAIN_AGENT_RULES.md not found in the mbrain package.' };
      }
      return { document: 'MBRAIN_AGENT_RULES.md', content: readFileSync(rulesPath, 'utf-8') };
    }

    // Load full SKILLPACK and extract section
    const skillpackPath = resolveDocPath('MBRAIN_SKILLPACK.md');
    if (!skillpackPath) {
      return { error: 'not_found', message: 'MBRAIN_SKILLPACK.md not found in the mbrain package.' };
    }

    const fullContent = readFileSync(skillpackPath, 'utf-8');

    // Try to find section by number (e.g. "## 5." or "## 5 ")
    const sectionNum = parseInt(section, 10);
    if (!isNaN(sectionNum)) {
      const extracted = extractSection(fullContent, sectionNum);
      if (extracted) {
        return { document: 'MBRAIN_SKILLPACK.md', section: sectionNum, content: extracted };
      }
      return { error: 'section_not_found', message: `Section ${sectionNum} not found.`, available: listSections(fullContent) };
    }

    // Try keyword search in section headers
    const keyword = section.toLowerCase();
    const lines = fullContent.split('\n');
    const matchingSections: Array<{ num: number; title: string }> = [];
    for (const line of lines) {
      const match = parseSkillpackSectionHeader(line);
      if (match && (match.title.toLowerCase().includes(keyword) || line.toLowerCase().includes(keyword))) {
        matchingSections.push(match);
      }
    }

    if (matchingSections.length === 1) {
      const extracted = extractSection(fullContent, matchingSections[0].num);
      return { document: 'MBRAIN_SKILLPACK.md', section: matchingSections[0].num, title: matchingSections[0].title, content: extracted };
    }

    if (matchingSections.length > 1) {
      return { matches: matchingSections, hint: 'Multiple sections match. Specify a section number.' };
    }

    return { error: 'section_not_found', message: `No section matching "${section}".`, available: listSections(fullContent) };
  },
  cliHints: { hidden: true },
};

function resolveDocPath(filename: string): string | null {
  const candidates = [
    join(process.cwd(), 'docs', filename),
    join(__dirname, '..', '..', 'docs', filename),
    join(__dirname, '..', 'docs', filename),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function extractSection(content: string, sectionNum: number): string | null {
  const lines = content.split('\n');
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const match = parseSkillpackSectionHeader(lines[i]);
    if (match) {
      const num = match.num;
      if (num === sectionNum && start === -1) {
        start = i;
      } else if (start !== -1 && num > sectionNum) {
        end = i;
        break;
      }
    }
  }

  if (start === -1) return null;
  return lines.slice(start, end).join('\n').trim();
}

function listSections(content: string): Array<{ num: number; title: string }> {
  const sections: Array<{ num: number; title: string }> = [];
  for (const line of content.split('\n')) {
    const match = parseSkillpackSectionHeader(line);
    if (match) {
      sections.push({ num: match.num, title: match.title.replace(/\s*--\s*/, ' - ').trim() });
    }
  }
  return sections;
}

function parseSkillpackSectionHeader(line: string): { num: number; title: string } | null {
  const match = line.match(/^## (?:(?:Section )?(\d+)[a-z]?[:.\s]+)(.+)$/i);
  if (!match) return null;
  return { num: parseInt(match[1], 10), title: match[2].trim() };
}

// --- Exports ---

export const operations: Operation[] = [
  // Page CRUD
  get_page, put_page, delete_page, list_pages,
  // Search
  search, query,
  // Tags
  add_tag, remove_tag, get_tags,
  // Links
  add_link, remove_link, get_links, get_backlinks, traverse_graph,
  // Timeline
  add_timeline_entry, get_timeline,
  // Admin
  get_stats, get_health, get_versions, revert_version,
  // Sync
  sync_brain,
  // Raw data
  put_raw_data, get_raw_data,
  // Resolution & chunks
  resolve_slugs, get_chunks,
  // Profile memory
  get_profile_memory_entry, list_profile_memory_entries, upsert_profile_memory_entry, delete_profile_memory_entry, ...memoryInboxOperations, write_profile_memory_entry,
  // Personal episodes
  get_personal_episode_entry, list_personal_episode_entries, record_personal_episode, delete_personal_episode_entry, write_personal_episode_entry,
  // Note manifest
  get_note_manifest_entry, list_note_manifest_entries, rebuild_note_manifest,
  // Note sections
  get_note_section_entry, list_note_section_entries, rebuild_note_sections,
  // Structural graph
  get_note_structural_neighbors, find_note_structural_path,
  // Persisted context maps
  build_context_map, get_context_map_entry, list_context_map_entries, get_context_map_report, get_context_map_explanation, query_context_map, find_context_map_path, get_broad_synthesis_route, get_precision_lookup_route, get_mixed_scope_bridge, get_mixed_scope_disclosure, get_personal_profile_lookup_route, get_personal_episode_lookup_route, select_personal_write_target, preview_personal_export, evaluate_scope_gate, select_retrieval_route, classify_memory_scenario, select_activation_policy, plan_scenario_memory_request, plan_retrieval_request, reverify_code_claims, get_workspace_system_card, get_workspace_project_card, get_workspace_orientation_bundle, get_workspace_corpus_card,
  // Context atlas registry
  build_context_atlas, get_context_atlas_entry, list_context_atlas_entries, select_context_atlas_entry, get_context_atlas_overview, get_context_atlas_report, get_atlas_orientation_card, get_atlas_orientation_bundle,
  // Operational memory
  list_tasks, start_task, update_task, resume_task, get_task_working_set, record_retrieval_trace, list_task_traces, list_task_attempts, list_task_decisions, refresh_task_working_set, record_attempt, record_decision, ...brainLoopAuditOperations, ...memoryMutationLedgerOperations, ...memoryControlPlaneOperations,
  // Ingest log
  log_ingest, get_ingest_log,
  // Files
  file_list, file_upload, file_url,
  // Skillpack
  get_skillpack,
];

function assertCapabilitySupported(
  config: MBrainConfig,
  capability: 'files',
) {
  const reason = getUnsupportedCapabilityReason(config, capability);
  if (reason) {
    throw new OperationError('unsupported_capability', reason);
  }
}

export const operationsByName = Object.fromEntries(
  operations.map(op => [op.name, op]),
) as Record<string, Operation>;
