/**
 * `gbrain bootstrap harness` lane of the spring-loaded skills index
 * (src/core/setup/skills-block.ts), beside the brain-first block that
 * harness-brain-first.ts writes for each confirmed host. Selected like
 * setup's: --skill-loading, GBRAIN_SKILL_LOADING, the recorded choice, off.
 * A bootstrap install runs on the brain host, so the index lists every
 * bundled skill. Removal strips only the indexes this lane recorded, and
 * leaves one whose file still holds another connection's brain-first block.
 */
import { brainFirstTargetAt, codexInstructionFile, readBrainFirstLedger } from '../setup/brain-first.ts';
import { describeSkillsBlockOutcome, installerSkillsBlock, removeSkillsBlocksBy, type SkillLoading, type SkillsBlockOutcome } from '../setup/skills-block.ts';
import type { BrainFirstHost, HarnessInstructionPaths } from './harness-brain-first.ts';

const WRITER = 'gbrain bootstrap harness';

export function writeHarnessSkillsIndex(opts: { hosts: readonly BrainFirstHost[]; launcher: string; optOut: boolean; skillLoading?: SkillLoading; paths: HarnessInstructionPaths; settingsPath: string; log: (line: string) => void }): SkillsBlockOutcome[] {
  const { paths } = opts;
  return opts.hosts.map((host) => {
    const path = host === 'claude-code' ? paths.claudeMemoryPath
      : host === 'codex' ? codexInstructionFile(paths.codexAgentsOverride, paths.codexAgentsPath)
        : paths.opencodeAgentsPath;
    const declined = opts.optOut || readBrainFirstLedger().find((e) => e.harness === host && e.path === path)?.status === 'declined';
    const o = installerSkillsBlock({ target: brainFirstTargetAt(host, path), launcher: opts.launcher, writer: WRITER, brainFirstDeclined: declined, skillLoading: opts.skillLoading, audience: 'owner', settingsPath: opts.settingsPath });
    if (o.decision.value === 'spring' || o.action !== 'skip') opts.log(describeSkillsBlockOutcome(o, false).trim());
    return o;
  });
}

/** Runs after brain-first removal: an index whose file still holds another connection's brain-first block stays with it. */
export function removeHarnessSkillsIndex(server: string, log: (line: string) => void): SkillsBlockOutcome[] {
  const keptFor = (harness: string, path: string) => readBrainFirstLedger().some((b) => b.harness === harness && b.path === path && b.writer === WRITER
    && b.status === 'installed' && b.access.kind === 'mcp' && b.access.server !== server);
  const outcomes = removeSkillsBlocksBy(WRITER, { keep: (e) => keptFor(e.harness, e.path) });
  for (const o of outcomes) log(describeSkillsBlockOutcome(o, false).trim());
  return outcomes;
}
