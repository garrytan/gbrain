import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  buildSkillSurfaceManifest,
  listSkillSurfaceResources,
  readSkillSurfaceResource,
  skillSurfaceDocumentDefinitions,
} from '../src/core/services/skill-surface-manifest-service.ts';

const STALE_DIRECT_WRITE_PATTERN = /(?:mbrain\s+put|put_page|mbrain_add_timeline_entry|add_timeline_entry)\b/;

describe('skill surface manifest service', () => {
  test('builds deterministic docs manifest entries with hashes and resource URIs', () => {
    const manifest = buildSkillSurfaceManifest();

    expect(manifest.map((entry) => entry.id)).toEqual([
      'agent-rules',
      'skillpack',
      'guide-brain-agent-loop',
      'guide-brain-first-lookup',
      'guide-source-attribution',
      'guide-search-modes',
      'mcp-instructions',
    ]);
    expect(manifest.every((entry) => entry.sha256.match(/^[a-f0-9]{64}$/))).toBe(true);
    expect(manifest.every((entry) => entry.mime_type === 'text/markdown')).toBe(true);
    expect(manifest.every((entry) => entry.agent_loadable)).toBe(true);
    expect(manifest.every((entry) => entry.mcp_resource_loadable)).toBe(true);
    expect(manifest.find((entry) => entry.id === 'agent-rules')?.version).toBe('0.5.12');
    expect(manifest.find((entry) => entry.id === 'skillpack')?.version).toBe('0.7.1');
  });

  test('exposes only manifest-backed docs resources', () => {
    const resources = listSkillSurfaceResources();
    const uris = resources.map((resource) => resource.uri);

    expect(uris).toContain('mbrain://docs/agent-rules');
    expect(uris).toContain('mbrain://docs/guides/brain-first-lookup');
    expect(readSkillSurfaceResource('mbrain://docs/agent-rules')?.text).toContain('retrieve_context');
    expect(readSkillSurfaceResource('file:///etc/passwd')).toBeNull();
  });

  test('selected agent docs teach current probe-read-route flow', () => {
    const factualAnswerDocs = new Set([
      'agent-rules',
      'guide-brain-agent-loop',
      'guide-brain-first-lookup',
      'guide-search-modes',
    ]);
    for (const definition of skillSurfaceDocumentDefinitions()) {
      const text = readFileSync(definition.relativePath, 'utf8');
      if (factualAnswerDocs.has(definition.id)) {
        expect(text).toContain('retrieve_context');
        expect(text).toContain('read_context');
      }
      expect(text).not.toMatch(/search\/query chunks? (?:are|as) factual evidence/i);

      if (STALE_DIRECT_WRITE_PATTERN.test(text)) {
        expect(text).toMatch(/route_memory_writeback|write_session_id|expected_content_hash/);
      }
    }
  });
});
