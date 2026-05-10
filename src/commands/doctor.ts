import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import {
  buildDoctorReport,
  collectDoctorInputs,
  doctorExitCode,
  formatDoctorReport,
} from '../core/services/doctor-service.ts';
import { collectInstalledAgentReadiness } from '../core/services/installed-agent-readiness-service.ts';

const MARKER_VERSION_RE = /<!-- mbrain-agent-rules-version: ([\d.]+) -->/;
export const EMBEDDED_AGENT_RULES_VERSION = '0.5.7';

export async function runDoctor(engine: BrainEngine, args: string[]) {
  const jsonOutput = args.includes('--json');
  const agentArgs = parseDoctorAgentArgs(args);
  const inputs = await collectDoctorInputs(engine);

  if (agentArgs.agent) {
    inputs.installedAgent = await collectInstalledAgentReadiness({
      command: agentArgs.agentCommand,
      expectedRulesVersion: getExpectedAgentRulesVersion(),
      expectedRulesContent: getExpectedAgentRulesContent(),
    });
  }

  const report = buildDoctorReport(inputs);

  if (jsonOutput) {
    console.log(JSON.stringify(report));
  } else {
    console.log(formatDoctorReport(report));
  }

  process.exit(doctorExitCode(report));
}

export function parseDoctorAgentArgs(args: string[]): { agent: boolean; agentCommand: string } {
  let agent = false;
  let agentCommand = 'mbrain';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--agent') {
      agent = true;
    } else if (arg === '--agent-command') {
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        agentCommand = value;
        i += 1;
      }
    } else if (arg.startsWith('--agent-command=')) {
      const value = arg.slice('--agent-command='.length);
      if (value && !value.startsWith('--')) {
        agentCommand = value;
      }
    }
  }

  return { agent, agentCommand };
}

export function getExpectedAgentRulesVersion(): string {
  return getExpectedAgentRulesVersionFromCandidates(getAgentRulesCandidatePaths());
}

export function getExpectedAgentRulesContent(): string | null {
  return getExpectedAgentRulesContentFromCandidates(getAgentRulesCandidatePaths());
}

export function getExpectedAgentRulesVersionFromCandidates(candidatePaths: string[]): string {
  const content = getExpectedAgentRulesContentFromCandidates(candidatePaths);
  if (content) {
    const version = content.match(MARKER_VERSION_RE)?.[1];
    if (version) return version;
  }

  return EMBEDDED_AGENT_RULES_VERSION;
}

export function getExpectedAgentRulesContentFromCandidates(candidatePaths: string[]): string | null {
  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf-8');
    }
  }

  return null;
}

export function getAgentRulesCandidatePaths(): string[] {
  return [
    join(__dirname, '..', '..', 'docs', 'MBRAIN_AGENT_RULES.md'),
    join(__dirname, '..', 'docs', 'MBRAIN_AGENT_RULES.md'),
  ];
}
