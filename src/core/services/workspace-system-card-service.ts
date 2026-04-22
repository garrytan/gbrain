import type { BrainEngine } from '../engine.ts';
import type { SystemEntryPoint, WorkspaceSystemCard, WorkspaceSystemCardInput, WorkspaceSystemCardResult } from '../types.ts';
import { getStructuralContextMapReport, resolveContextMapReads } from './context-map-report-service.ts';
import { getStructuralContextMapEntry } from './context-map-service.ts';

export async function getWorkspaceSystemCard(
  engine: BrainEngine,
  input: WorkspaceSystemCardInput = {},
): Promise<WorkspaceSystemCardResult> {
  const reportResult = await getStructuralContextMapReport(engine, input);
  if (!reportResult.report) {
    return {
      selection_reason: reportResult.selection_reason,
      candidate_count: reportResult.candidate_count,
      card: null,
    };
  }

  const mapEntry = await getStructuralContextMapEntry(engine, reportResult.report.map_id);
  const reads = mapEntry
    ? await resolveContextMapReads(engine, mapEntry, Number.POSITIVE_INFINITY)
    : reportResult.report.recommended_reads;
  const target = reads.find((read) => read.page_slug.startsWith('systems/'));
  if (!target) {
    return {
      selection_reason: 'no_system_read',
      candidate_count: reportResult.candidate_count,
      card: null,
    };
  }
  const page = await engine.getPage(target.page_slug);
  if (!page) {
    return {
      selection_reason: 'no_system_read',
      candidate_count: reportResult.candidate_count,
      card: null,
    };
  }

  const frontmatter = page.frontmatter ?? {};
  const repo = typeof frontmatter.repo === 'string' ? frontmatter.repo : undefined;
  const buildCommand = typeof frontmatter.build_command === 'string' ? frontmatter.build_command : undefined;
  const testCommand = typeof frontmatter.test_command === 'string' ? frontmatter.test_command : undefined;
  const entryPoints = normalizeEntryPoints(frontmatter.key_entry_points);

  return {
    selection_reason: reportResult.selection_reason,
    candidate_count: reportResult.candidate_count,
    card: buildCard({
      slug: page.slug,
      title: page.title,
      repo,
      buildCommand,
      testCommand,
      entryPoints,
      reportStatus: reportResult.report.status,
    }),
  };
}

function buildCard(input: {
  slug: string;
  title: string;
  repo?: string;
  buildCommand?: string;
  testCommand?: string;
  entryPoints: SystemEntryPoint[];
  reportStatus: string;
}): WorkspaceSystemCard {
  return {
    card_kind: 'workspace_system',
    system_slug: input.slug,
    title: input.title,
    repo: input.repo,
    build_command: input.buildCommand,
    test_command: input.testCommand,
    entry_points: input.entryPoints,
    summary_lines: [
      `Workspace map status is ${input.reportStatus}.`,
      input.repo ? `Repo: ${input.repo}.` : 'Repo: unavailable.',
      input.buildCommand ? 'Build command is available.' : 'Build command is unavailable.',
      input.testCommand ? 'Test command is available.' : 'Test command is unavailable.',
      `Key entry points available: ${input.entryPoints.length}.`,
    ],
  };
}

function normalizeEntryPoints(value: unknown): SystemEntryPoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name : '',
      path: typeof item.path === 'string' ? item.path : '',
      purpose: typeof item.purpose === 'string' ? item.purpose : '',
    }))
    .filter((item) => item.name && item.path && item.purpose);
}
