import type { BrainEngine } from '../engine.ts';
import type { WorkspaceProjectCard, WorkspaceProjectCardInput, WorkspaceProjectCardResult } from '../types.ts';
import { getStructuralContextMapReport, resolveContextMapReads } from './context-map-report-service.ts';
import { getStructuralContextMapEntry } from './context-map-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';

export async function getWorkspaceProjectCard(
  engine: BrainEngine,
  input: WorkspaceProjectCardInput = {},
): Promise<WorkspaceProjectCardResult> {
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
  const target = reads.find((read) => read.page_slug.startsWith('projects/'));
  if (!target) {
    return {
      selection_reason: 'no_project_read',
      candidate_count: reportResult.candidate_count,
      card: null,
    };
  }

  const [page, manifest] = await Promise.all([
    engine.getPage(target.page_slug),
    engine.listNoteManifestEntries({
      scope_id: input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug: target.page_slug,
      limit: 1,
    }).then((entries) => entries[0] ?? null),
  ]);

  if (!page || !manifest) {
    return {
      selection_reason: 'no_project_read',
      candidate_count: reportResult.candidate_count,
      card: null,
    };
  }

  const frontmatter = page.frontmatter ?? {};
  const repo = typeof frontmatter.repo === 'string' ? frontmatter.repo : undefined;
  const status = typeof frontmatter.status === 'string' ? frontmatter.status : undefined;
  const relatedSystems = manifest.outgoing_wikilinks
    .filter((slug) => slug.startsWith('systems/'))
    .sort((left, right) => left.localeCompare(right));

  return {
    selection_reason: reportResult.selection_reason,
    candidate_count: reportResult.candidate_count,
    card: buildCard({
      slug: page.slug,
      title: page.title,
      path: target.path,
      repo,
      status,
      relatedSystems,
      reportStatus: reportResult.report.status,
    }),
  };
}

function buildCard(input: {
  slug: string;
  title: string;
  path: string;
  repo?: string;
  status?: string;
  relatedSystems: string[];
  reportStatus: string;
}): WorkspaceProjectCard {
  return {
    card_kind: 'workspace_project',
    project_slug: input.slug,
    title: input.title,
    path: input.path,
    repo: input.repo,
    status: input.status,
    related_systems: input.relatedSystems,
    summary_lines: [
      `Workspace map status is ${input.reportStatus}.`,
      `Project path: ${input.path}.`,
      input.repo ? `Repo: ${input.repo}.` : 'Repo: unavailable.',
      input.status ? `Canonical status: ${input.status}.` : 'Canonical status: unavailable.',
      `Linked systems available: ${input.relatedSystems.length}.`,
    ],
  };
}
