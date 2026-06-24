import { describe, expect, test } from 'bun:test';
import goldenManifest from './fixtures/operation-golden-manifest.json';
import { getCliCommandCatalog } from '../src/cli.ts';
import { operations } from '../src/core/operations.ts';
import {
  buildOperationGoldenManifest,
  OPERATION_GOLDEN_MANIFEST_SCHEMA_VERSION,
} from '../src/core/services/operation-conformance-service.ts';

describe('operation golden manifest', () => {
  test('builds a deterministic manifest from the live operation registry', () => {
    const manifest = buildOperationGoldenManifest({
      operations,
      cliCatalog: getCliCommandCatalog(),
    });

    expect(manifest.schema_version).toBe(OPERATION_GOLDEN_MANIFEST_SCHEMA_VERSION);
    expect(manifest.generated_from).toBe('live_operation_registry');
    expect(manifest.operations.map(entry => entry.name)).toEqual(
      [...manifest.operations.map(entry => entry.name)].sort(),
    );
    expect(new Set(manifest.operations.map(entry => entry.name)).size).toBe(manifest.operations.length);
    expect(manifest.cli_commands.find(entry => entry.command === 'doctor')).toMatchObject({
      mode: 'cli_direct_engine',
      operation_spec_name: 'doctor',
    });
    expect(manifest.cli_commands.find(entry => entry.command === 'setup-agent')).toMatchObject({
      mode: 'cli_only',
      operation_spec_name: 'setup_agent',
    });
    expect(manifest.operations.find(entry => entry.name === 'file_list')?.cli_exposure).toEqual({
      mode: 'mcp',
      reason: 'mcp operation without CLI command',
    });

    const putPage = manifest.operations.find(entry => entry.name === 'put_page');
    expect(putPage).toMatchObject({
      name: 'put_page',
      mutating: true,
      cli_exposure: {
        mode: 'cli_shared',
        command: 'put',
      },
      mcp: {
        read_only: false,
        destructive: true,
      },
    });
    expect(putPage?.params.expected_content_hash).toMatchObject({
      type: ['string'],
      required: true,
      nullable: true,
    });
    expect(putPage?.surface_profile).toMatchObject({
      effective_tier: 'core',
      required_capabilities: ['canonical_write'],
      capability_classification: 'explicit',
      visible_profiles: ['stdio', 'http_local', 'http_remote', 'edge_remote'],
      callable_profiles: ['stdio', 'http_local', 'http_remote', 'edge_remote'],
    });
    expect(putPage?.full_schema_hash).toMatch(/^[a-f0-9]{64}$/);

    const adminPutPage = manifest.operations.find(entry => entry.name === 'admin_put_page');
    expect(adminPutPage?.surface_profile.forbidden_profiles).toEqual(['http_local', 'http_remote', 'edge_remote']);
    expect(adminPutPage?.surface_profile.decisions.http_remote.denial_reasons).toContain('forbidden_operation');

    const deletePage = manifest.operations.find(entry => entry.name === 'delete_page');
    expect(deletePage?.surface_profile.required_capabilities).toEqual(['canonical_write']);
    expect(deletePage?.surface_profile.capability_classification).toBe('explicit');

    const rawChunks = manifest.operations.find(entry => entry.name === 'request_raw_source_chunks');
    expect(rawChunks?.surface_profile).toMatchObject({
      effective_tier: 'admin',
      required_capabilities: ['raw_source'],
      capability_classification: 'explicit',
      visible_profiles: [],
      callable_profiles: [],
    });
    expect(rawChunks?.surface_profile.decisions.http_remote.denial_reasons).toContain('tier_not_callable');

    const hidden = manifest.operations.find(entry => entry.name === 'get_skillpack');
    expect(hidden?.cli_exposure.mode).toBe('not_cli');
    expect(hidden?.cli_exposure.reason).toContain('hidden');
  });

  test('checked-in golden manifest matches the live operation contract', () => {
    const manifest = buildOperationGoldenManifest({
      operations,
      cliCatalog: getCliCommandCatalog(),
    });

    expect(manifest).toEqual(goldenManifest as unknown as typeof manifest);
  });
});
