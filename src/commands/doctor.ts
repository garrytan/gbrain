import type { BrainEngine } from '../core/engine.ts';
import {
  buildDoctorReport,
  collectDoctorInputs,
  doctorExitCode,
  formatDoctorReport,
} from '../core/services/doctor-service.ts';
import { collectInstalledAgentReadiness } from '../core/services/installed-agent-readiness-service.ts';

const EXPECTED_AGENT_RULES_VERSION = '0.5.6';

export async function runDoctor(engine: BrainEngine, args: string[]) {
  const jsonOutput = args.includes('--json');
  const agentArgs = parseAgentArgs(args);
  const inputs = await collectDoctorInputs(engine);

  if (agentArgs.agent) {
    inputs.installedAgent = await collectInstalledAgentReadiness({
      command: agentArgs.agentCommand,
      expectedRulesVersion: EXPECTED_AGENT_RULES_VERSION,
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

function parseAgentArgs(args: string[]): { agent: boolean; agentCommand: string } {
  let agent = false;
  let agentCommand = 'mbrain';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--agent') {
      agent = true;
    } else if (arg === '--agent-command') {
      agentCommand = args[i + 1] || agentCommand;
      i += 1;
    } else if (arg.startsWith('--agent-command=')) {
      agentCommand = arg.slice('--agent-command='.length);
    }
  }

  return { agent, agentCommand };
}
