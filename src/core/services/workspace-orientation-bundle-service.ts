import type { BrainEngine } from '../engine.ts';
import type {
  WorkspaceOrientationBundle,
  WorkspaceOrientationBundleInput,
  WorkspaceOrientationBundleResult,
} from '../types.ts';
import { getStructuralContextMapReport } from './context-map-report-service.ts';
import { getWorkspaceProjectCard } from './workspace-project-card-service.ts';
import { getWorkspaceSystemCard } from './workspace-system-card-service.ts';

export async function getWorkspaceOrientationBundle(
  engine: BrainEngine,
  input: WorkspaceOrientationBundleInput = {},
): Promise<WorkspaceOrientationBundleResult> {
  const reportResult = await getStructuralContextMapReport(engine, input);
  if (!reportResult.report) {
    return {
      selection_reason: reportResult.selection_reason,
      candidate_count: reportResult.candidate_count,
      bundle: null,
    };
  }

  const [systemResult, projectResult] = await Promise.all([
    getWorkspaceSystemCard(engine, input),
    getWorkspaceProjectCard(engine, input),
  ]);

  return {
    selection_reason: reportResult.selection_reason,
    candidate_count: reportResult.candidate_count,
    bundle: buildBundle({
      report: reportResult.report,
      systemCard: systemResult.card,
      projectCard: projectResult.card,
    }),
  };
}

function buildBundle(input: {
  report: Awaited<ReturnType<typeof getStructuralContextMapReport>>['report'] extends infer T ? Exclude<T, null> : never;
  systemCard: Awaited<ReturnType<typeof getWorkspaceSystemCard>>['card'];
  projectCard: Awaited<ReturnType<typeof getWorkspaceProjectCard>>['card'];
}): WorkspaceOrientationBundle {
  return {
    bundle_kind: 'workspace_orientation',
    title: `${input.report.title} Bundle`,
    map_id: input.report.map_id,
    status: input.report.status,
    summary_lines: [
      `Context map status is ${input.report.status}.`,
      input.systemCard ? 'Workspace system card attached.' : 'No workspace system card attached.',
      input.projectCard ? 'Workspace project card attached.' : 'No workspace project card attached.',
      `Recommended reads available: ${input.report.recommended_reads.length}.`,
    ],
    recommended_reads: input.report.recommended_reads,
    system_card: input.systemCard ?? null,
    project_card: input.projectCard ?? null,
  };
}
