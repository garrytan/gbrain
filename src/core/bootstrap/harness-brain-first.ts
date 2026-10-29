/**
 * `gbrain bootstrap harness` lane of the brain-first instruction block
 * (src/core/setup/brain-first.ts): each host whose MCP entry is confirmed gets
 * the managed block in its own instruction file; removal strips only the
 * blocks this lane recorded.
 */
import { brainFirstTargetAt, codexInstructionFile, describeBrainFirstOutcome, installerBrainFirst, readBrainFirstLedger, removeBrainFirst } from '../setup/brain-first.ts';

const WRITER = 'gbrain bootstrap harness';

export type BrainFirstHost = 'claude-code' | 'codex' | 'opencode';

export interface HarnessInstructionPaths {
  claudeMemoryPath: string;
  codexAgentsPath: string;
  codexAgentsOverride: string;
  opencodeAgentsPath: string;
}

export function writeHarnessBrainFirst(opts: { hosts: readonly BrainFirstHost[]; server: string; optOut: boolean; paths: HarnessInstructionPaths; log: (line: string) => void }): void {
  const { paths } = opts;
  for (const host of opts.hosts) {
    const path = host === 'claude-code' ? paths.claudeMemoryPath
      : host === 'codex' ? codexInstructionFile(paths.codexAgentsOverride, paths.codexAgentsPath)
        : paths.opencodeAgentsPath;
    const o = installerBrainFirst({ target: brainFirstTargetAt(host, path), access: { kind: 'mcp', server: opts.server },
      writer: WRITER, instructions: opts.optOut ? false : undefined });
    opts.log(describeBrainFirstOutcome(o, false).trim());
  }
}

export function removeHarnessBrainFirst(server: string, log: (line: string) => void): void {
  for (const e of readBrainFirstLedger().filter((entry) => entry.writer === WRITER)) {
    log(describeBrainFirstOutcome(removeBrainFirst({ harness: e.harness, path: e.path, dryRun: false, server }), false).trim());
  }
}
