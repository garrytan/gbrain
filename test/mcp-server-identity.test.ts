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
import { GBRAIN_MCP_INSTRUCTIONS, resolveMcpInstructions, buildMcpInstructions } from '../src/mcp/instructions.ts';
import { buildAmbientWritebackSection } from '../src/core/facts/writeback-instructions.ts';

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

  test('an empty or whitespace-only env value is unset — it does NOT blank a configured identity', () => {
    // A shell that exports GBRAIN_MCP_INSTRUCTIONS='' (or '   ') has not set
    // an identity; the file config must still win instead of the env
    // shadowing it into the bare canonical contract.
    for (const blank of ['', '   ', '\n\t']) {
      expect(
        resolveMcpInstructions(
          { mcp: { instructions: 'Personal brain' } },
          { GBRAIN_MCP_INSTRUCTIONS: blank },
        ),
      ).toEndWith('Deployment identity:\nPersonal brain');
    }
    // And with nothing configured either, a blank env is still byte-identical.
    expect(resolveMcpInstructions({}, { GBRAIN_MCP_INSTRUCTIONS: '' })).toBe(GBRAIN_MCP_INSTRUCTIONS);
  });

  test('blank or absent identity keeps the canonical contract byte-identical', () => {
    expect(resolveMcpInstructions({ mcp: { instructions: '   ' } }, {})).toBe(
      GBRAIN_MCP_INSTRUCTIONS,
    );
    expect(resolveMcpInstructions(null, {})).toBe(GBRAIN_MCP_INSTRUCTIONS);
    expect(resolveMcpInstructions({}, {})).toBe(GBRAIN_MCP_INSTRUCTIONS);
  });
});

// The merge of the ambient-writeback section (#4788) and the deployment
// identity (#4748) fixed the composition order: contract → writeback section
// → identity. Both extensions are append-only; each is byte-identical to the
// layer below it when unset.
describe('resolveMcpInstructions — three-way composition with the ambient-writeback section', () => {
  const WRITEBACK = { mode: 'salient' as const, transientTtl: '3d', visibility: 'world' as const, extractFactsAvailable: true };

  test('writeback on + identity set: contract, then the writeback section, then the identity LAST', () => {
    const out = resolveMcpInstructions({ mcp: { instructions: 'Team wiki brain' } }, {}, { writeback: WRITEBACK });
    const base = buildMcpInstructions({ writeback: WRITEBACK });
    expect(out).toBe(`${base}\n\nDeployment identity:\nTeam wiki brain`);
    expect(out.startsWith(GBRAIN_MCP_INSTRUCTIONS + '\n\n')).toBe(true);
    expect(out.indexOf(buildAmbientWritebackSection(WRITEBACK))).toBeLessThan(out.indexOf('Deployment identity:'));
  });

  test('writeback on + no identity: byte-identical to buildMcpInstructions (the writeback pins keep holding)', () => {
    expect(resolveMcpInstructions({}, {}, { writeback: WRITEBACK })).toBe(buildMcpInstructions({ writeback: WRITEBACK }));
    expect(resolveMcpInstructions(null, { GBRAIN_MCP_INSTRUCTIONS: '  ' }, { writeback: WRITEBACK })).toBe(buildMcpInstructions({ writeback: WRITEBACK }));
  });

  test('writeback off/null + identity: contract then identity, no writeback section', () => {
    for (const opts of [undefined, {}, { writeback: null }]) {
      const out = resolveMcpInstructions({ mcp: { instructions: 'Personal brain' } }, {}, opts);
      expect(out).toBe(`${GBRAIN_MCP_INSTRUCTIONS}\n\nDeployment identity:\nPersonal brain`);
      expect(out).not.toContain('mode: salient');
    }
  });

  test('the env override still wins over config with writeback on', () => {
    const out = resolveMcpInstructions({ mcp: { instructions: 'from-config' } }, { GBRAIN_MCP_INSTRUCTIONS: 'from-env' }, { writeback: WRITEBACK });
    expect(out.endsWith('Deployment identity:\nfrom-env')).toBe(true);
    expect(out).not.toContain('from-config');
  });
});
