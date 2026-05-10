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

export async function runDoctor(engine: BrainEngine, args: string[]) {
  const jsonOutput = args.includes('--json');
  const agentArgs = parseDoctorAgentArgs(args);
  const inputs = await collectDoctorInputs(engine);

  if (agentArgs.agent) {
    inputs.installedAgent = await collectInstalledAgentReadiness({
      command: agentArgs.agentCommand,
      expectedRulesVersion: getExpectedAgentRulesVersion(),
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
  return loadAgentRules()?.match(MARKER_VERSION_RE)?.[1] ?? 'unknown';
}

function loadAgentRules(): string | null {
  const candidates = [
    join(__dirname, '..', '..', 'docs', 'MBRAIN_AGENT_RULES.md'),
    join(__dirname, '..', 'docs', 'MBRAIN_AGENT_RULES.md'),
    join(process.cwd(), 'docs', 'MBRAIN_AGENT_RULES.md'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf-8');
    }
  }

  return null;
}
