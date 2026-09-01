/**
 * #4748 — deployment-specific brain identity in the MCP initialize response.
 *
 * resolveMcpInstructions is APPEND-ONLY: the canonical operating contract is
 * always the prefix (it can never be replaced or weakened by config/env),
 * the operator-set identity rides under a `Deployment identity:` banner, and
 * a blank/absent identity keeps the output byte-identical to the canonical
 * contract (the pre-#4748 wire shape).
 */

import { describe, expect, test } from 'bun:test';
import { GBRAIN_MCP_INSTRUCTIONS, resolveMcpInstructions } from '../src/mcp/instructions.ts';

describe('resolveMcpInstructions', () => {
  test('appends the configured deployment identity under the canonical contract', () => {
    const instructions = resolveMcpInstructions(
      { mcp: { instructions: '  Personal brain  ' } },
      {},
    );
    expect(instructions).toStartWith(GBRAIN_MCP_INSTRUCTIONS);
    expect(instructions).toEndWith('Deployment identity:\nPersonal brain');
  });

  test('lets the environment override file configuration', () => {
    expect(
      resolveMcpInstructions(
        { mcp: { instructions: 'Personal brain' } },
        { GBRAIN_MCP_INSTRUCTIONS: 'Company brain' },
      ),
    ).toEndWith('Deployment identity:\nCompany brain');
  });

  test('blank or absent identity keeps the canonical contract byte-identical', () => {
    expect(resolveMcpInstructions({ mcp: { instructions: '   ' } }, {})).toBe(
      GBRAIN_MCP_INSTRUCTIONS,
    );
    expect(resolveMcpInstructions(null, {})).toBe(GBRAIN_MCP_INSTRUCTIONS);
    expect(resolveMcpInstructions({}, {})).toBe(GBRAIN_MCP_INSTRUCTIONS);
  });
});
