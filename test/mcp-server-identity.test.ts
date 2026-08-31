import { describe, expect, test } from 'bun:test';
import { GBRAIN_MCP_INSTRUCTIONS, resolveMcpInstructions } from '../src/mcp/instructions.ts';

describe('resolveMcpInstructions', () => {
  test('returns the configured deployment identity', () => {
    const instructions = resolveMcpInstructions(
      { mcp: { instructions: '  Personal brain  ' } },
      {},
    );
    expect(instructions).toContain(GBRAIN_MCP_INSTRUCTIONS);
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

  test('omits blank instructions', () => {
    expect(resolveMcpInstructions({ mcp: { instructions: '   ' } }, {})).toBe(
      GBRAIN_MCP_INSTRUCTIONS,
    );
  });
});
