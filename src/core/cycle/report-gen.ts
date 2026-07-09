/**
 * PMBrain Phase 3: report_gen
 *
 * Generates a Markdown project report from project, task, risk, and meeting pages.
 */

import type { BrainEngine } from '../engine.ts';
import type { CyclePhase, PhaseResult } from '../cycle.ts';
import { searchPages } from '../search.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gbrainPath } from '../config.ts';
import { groupProjectPages, normalizeProjectTitle } from './project-health.ts';

export interface ReportData {
  title: string;
  generatedAt: string;
  summary: {
    totalProjects: number;
    totalTasks: number;
    tasksDone: number;
    tasksInProgress: number;
    tasksBlocked: number;
    activeRisks: number;
  };
  projects: Array<{
    title: string;
    status: string;
    progress: number;
    tasks: {
      total: number;
      done: number;
      inProgress: number;
      blocked: number;
    };
    risks: number;
  }>;
  recentMeetings: Array<{
    title: string;
    date: string;
  }>;
}

export async function runReportGen(
  engine: BrainEngine,
  opts: { dryRun?: boolean; outputDir?: string } = {},
): Promise<PhaseResult> {
  const start = Date.now();
  const dryRun = !!opts.dryRun;
  const outputDir = opts.outputDir || gbrainPath('reports');

  try {
    const projects = await searchPages(engine, { type: 'project' });
    const projectGroups = groupProjectPages(projects);
    const tasks = await searchPages(engine, { type: 'task' });
    const risks = await searchPages(engine, { type: 'risk' });
    const meetings = await searchPages(engine, { type: 'meeting' });

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());

    const summary = {
      totalProjects: projectGroups.length,
      totalTasks: tasks.length,
      tasksDone: tasks.filter((t) => t.status === 'done').length,
      tasksInProgress: tasks.filter((t) => t.status === 'in_progress').length,
      tasksBlocked: tasks.filter((t) => t.status === 'blocked').length,
      activeRisks: risks.filter((r) => r.status !== 'mitigated' && r.status !== 'closed').length,
    };

    const projectDetails = projectGroups.map((project) => {
      const projectTasks = tasks.filter((t) => normalizeProjectTitle(t.project).toLowerCase() === project.key);
      const projectRisks = risks.filter((r) => normalizeProjectTitle(r.project).toLowerCase() === project.key);
      const done = projectTasks.filter((t) => t.status === 'done').length;
      const status = project.pages.find((p) => p.status)?.status;

      return {
        title: project.title,
        status: String(status || 'unknown'),
        progress: projectTasks.length > 0 ? Math.round((done / projectTasks.length) * 100) : 0,
        tasks: {
          total: projectTasks.length,
          done,
          inProgress: projectTasks.filter((t) => t.status === 'in_progress').length,
          blocked: projectTasks.filter((t) => t.status === 'blocked').length,
        },
        risks: projectRisks.filter((r) => r.status !== 'mitigated' && r.status !== 'closed').length,
      };
    });

    const weekAgo = new Date(now);
    weekAgo.setDate(now.getDate() - 7);
    const recentMeetings = meetings
      .filter((m) => {
        if (!m.date) return false;
        return new Date(String(m.date)) >= weekAgo;
      })
      .slice(0, 10)
      .map((m) => ({
        title: String(m.title),
        date: String(m.date),
      }));

    const report: ReportData = {
      title: `Weekly report ${weekStart.toISOString().slice(0, 10)} - ${now.toISOString().slice(0, 10)}`,
      generatedAt: now.toISOString(),
      summary,
      projects: projectDetails,
      recentMeetings,
    };

    if (dryRun) {
      return {
        phase: 'report_gen' as CyclePhase,
        status: 'ok',
        duration_ms: Date.now() - start,
        summary: `Would generate report: ${report.title} (dry-run)`,
        details: {
          projects: projectDetails.length,
          tasks_total: summary.totalTasks,
          tasks_done: summary.tasksDone,
          active_risks: summary.activeRisks,
          recent_meetings: recentMeetings.length,
          dryRun: true,
        },
      };
    }

    mkdirSync(outputDir, { recursive: true });
    const reportPath = join(outputDir, `week-${now.toISOString().slice(0, 10)}.md`);
    writeFileSync(reportPath, generateMarkdownReport(report), 'utf-8');

    return {
      phase: 'report_gen' as CyclePhase,
      status: 'ok',
      duration_ms: Date.now() - start,
      summary: `Generated report: ${report.title} (${projectDetails.length} project(s))`,
      details: {
        report_path: reportPath,
        projects: projectDetails.length,
        tasks_total: summary.totalTasks,
        tasks_done: summary.tasksDone,
        active_risks: summary.activeRisks,
        recent_meetings: recentMeetings.length,
        dryRun: false,
      },
    };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return {
      phase: 'report_gen' as CyclePhase,
      status: 'fail',
      duration_ms: Date.now() - start,
      summary: `report_gen phase failed: ${err.message}`,
      details: { error: err.message },
      error: {
        class: 'InternalError',
        code: 'REPORT_GEN_ERROR',
        message: err.message,
      },
    };
  }
}

function generateMarkdownReport(report: ReportData): string {
  const lines: string[] = [];

  lines.push(`# ${report.title}`);
  lines.push('');
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Projects: ${report.summary.totalProjects}`);
  lines.push(`- Tasks: ${report.summary.totalTasks}`);
  lines.push(`  - Done: ${report.summary.tasksDone}`);
  lines.push(`  - In progress: ${report.summary.tasksInProgress}`);
  lines.push(`  - Blocked: ${report.summary.tasksBlocked}`);
  lines.push(`- Active risks: ${report.summary.activeRisks}`);
  lines.push('');

  if (report.projects.length > 0) {
    lines.push('## Projects');
    lines.push('');
    for (const project of report.projects) {
      lines.push(`### ${project.title}`);
      lines.push('');
      lines.push(`- Status: ${project.status}`);
      lines.push(`- Progress: ${project.progress}%`);
      lines.push(`- Tasks: ${project.tasks.done}/${project.tasks.total} done`);
      if (project.tasks.inProgress > 0) lines.push(`  - In progress: ${project.tasks.inProgress}`);
      if (project.tasks.blocked > 0) lines.push(`  - Blocked: ${project.tasks.blocked}`);
      if (project.risks > 0) lines.push(`- Active risks: ${project.risks}`);
      lines.push('');
    }
  }

  if (report.recentMeetings.length > 0) {
    lines.push('## Recent Meetings');
    lines.push('');
    for (const meeting of report.recentMeetings) {
      lines.push(`- ${meeting.date}: ${meeting.title}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by PMBrain*');

  return lines.join('\n');
}
