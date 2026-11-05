/**
 * `gbrain config set|get memory.agent_writeback` (GBRA-219). Kept out of
 * runConfig, which sits at its function-size ceiling. DB-only: the setting and
 * its audit row commit in one transaction; the capture lanes and the file
 * mirror are never touched.
 */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { AGENT_WRITEBACK_KEY, AGENT_WRITEBACK_VALUES, parseAgentWriteback, resolveAgentWriteback, writeAgentWriteback } from '../core/facts/writeback-settings.ts';

export { AGENT_WRITEBACK_KEY };

export async function setAgentWritebackFromCli(engine: BrainEngine, value: string): Promise<void> {
  const mode = parseAgentWriteback(value);
  if (!mode) {
    console.error(`[config] ${AGENT_WRITEBACK_KEY} must be one of: ${AGENT_WRITEBACK_VALUES.join(' | ')}. Nothing was written.`);
    process.exit(1);
  }
  try {
    const { previous } = await writeAgentWriteback(engine, mode, { actor: 'operator', client_id: null, transport: 'cli' });
    console.log(`Set ${AGENT_WRITEBACK_KEY} = ${mode} (db plane; was ${previous ?? 'inherit'})`);
    console.log('This changes what agents are told to save. Background capture (session hooks) still follows memory.auto_writeback.');
  } catch (e) {
    console.error(`[config] ERROR: the write did not confirm (${e instanceof Error ? e.name : 'error'}), so it may or may not have landed.`);
    console.error(`[config] Read it back with \`gbrain config get ${AGENT_WRITEBACK_KEY}\` before re-running.`);
    process.exit(1);
  }
}

/** Unset is a real value (inherit), not a missing key. */
export async function printUnsetAgentWriteback(engine: BrainEngine): Promise<void> {
  const agent = await resolveAgentWriteback(engine, loadConfig());
  console.log('inherit');
  console.error(`[config] source: unset (inherits memory.auto_writeback); agents are told: ${agent.bundle.mode}${agent.status === 'degraded' ? ` (degraded: ${agent.reasons.join(', ')})` : ''}`);
}

/** The `config get memory.auto_writeback` source-line suffix when agents are told something else. */
export async function agentWritebackNote(engine: BrainEngine): Promise<string> {
  const agent = await resolveAgentWriteback(engine, loadConfig());
  if (agent.source === 'operator') return '';
  return `; agents are told: ${agent.bundle.mode} (${AGENT_WRITEBACK_KEY} ${agent.source === 'fail_closed' ? 'unreadable or invalid, failing closed' : agent.override})`;
}
