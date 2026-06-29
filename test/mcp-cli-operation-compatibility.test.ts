import { describe, expect, test } from 'bun:test';
import { getCliCommandCatalog } from '../src/cli.ts';
import { operations } from '../src/core/operations.ts';
import {
  buildOperationGoldenManifest,
  findOperationConformanceHardFailures,
  validateMcpRequiredParamParity,
} from '../src/core/services/operation-conformance-service.ts';

describe('MCP and CLI operation compatibility', () => {
  test('classifies shared, direct, CLI-only, and hidden command exposure explicitly', () => {
    const catalog = getCliCommandCatalog();

    expect(catalog.commands['serve']).toMatchObject({
      command: 'serve',
      mode: 'cli_only',
    });
    expect(catalog.commands['doctor']).toMatchObject({
      command: 'doctor',
      mode: 'cli_direct_engine',
      operation_spec_name: 'doctor',
    });
    expect(catalog.commands['setup-agent']).toMatchObject({
      command: 'setup-agent',
      mode: 'cli_only',
      operation_spec_name: 'setup_agent',
    });
  });

  test('every visible shared CLI operation has an MCP tool and no command shadow drift', () => {
    const manifest = buildOperationGoldenManifest({
      operations,
      cliCatalog: getCliCommandCatalog(),
    });
    const failures = findOperationConformanceHardFailures(manifest);

    expect(failures).toEqual([]);
    expect(manifest.summary.cli_shared_count).toBeGreaterThan(100);
    expect(manifest.summary.cli_direct_count).toBeGreaterThan(10);
    expect(manifest.summary.cli_only_count).toBe(6);
    expect(manifest.summary.mcp_operation_count).toBe(manifest.summary.operation_count);
  });

  test('MCP required params stay aligned with operation param contracts', () => {
    const manifest = buildOperationGoldenManifest({
      operations,
      cliCatalog: getCliCommandCatalog(),
    });

    expect(validateMcpRequiredParamParity(manifest)).toEqual([]);
  });
});
