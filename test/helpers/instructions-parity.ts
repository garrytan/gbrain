/**
 * F1 parity helper: the instructions a transport serves are the contract for
 * exactly the tools its tools/list advertises (plus optional writeback,
 * readiness tail and deployment identity after it).
 */
import { buildMcpInstructions } from '../../src/mcp/instructions.ts';
import type { AmbientWritebackOpts } from '../../src/core/facts/writeback-instructions.ts';

export function contractFor(toolNames: Iterable<string>, writeback?: AmbientWritebackOpts | null): string {
  const listed = new Set(toolNames);
  return buildMcpInstructions({ writeback, tools: { callable: n => listed.has(n) } });
}
