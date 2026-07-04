import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { operations } from '../src/core/operations.ts';
import { effectiveToolTier } from '../src/mcp/tool-tiers.ts';
import goldenManifest from './fixtures/operation-golden-manifest.json';
import operationDocsAnnotations from './fixtures/operation-docs-annotations.json';

const repoRoot = new URL('..', import.meta.url).pathname;

const CURRENT_OPERATION_DOCS = [
  'README.md',
  'CLAUDE.md',
  'docs/MBRAIN_AGENT_RULES.md',
  'docs/MBRAIN_SKILLPACK.md',
  'docs/MBRAIN_VERIFY.md',
  'docs/MCP_INSTRUCTIONS.md',
  'docs/architecture/infra-layer.md',
  'docs/local-offline.md',
  'docs/local-offline.ko.md',
  'docs/mcp/ALTERNATIVES.md',
  'docs/mcp/CHATGPT.md',
  'docs/mcp/CLAUDE_CODE.md',
  'docs/mcp/CLAUDE_COWORK.md',
  'docs/mcp/CLAUDE_DESKTOP.md',
  'docs/mcp/DEPLOY.md',
  'docs/mcp/PERPLEXITY.md',
  'test/e2e/fixtures/projects/mbrain.md',
] as const;

const BRITTLE_OPERATION_COUNT_PATTERNS = [
  /\b(?:all|every|the)\s+~?\d+\s+(?:MBrain\s+)?(?:MCP\s+)?(?:operations?|tools?)\b/gi,
  /\b(?:defines?|exposes?|supports?|ships?|contains?|has|records?)\s+~?\d+\s+(?:shared\s+)?(?:MBrain\s+)?(?:MCP\s+)?(?:operations?|tools?)\b/gi,
  /\b~?\d+\s+(?:shared\s+)?(?:MBrain\s+)?(?:MCP\s+)?(?:operations?|tools?)\s+(?:are|is)\s+available\b/gi,
  /\b~?\d+\s+(?:shared\s+)?(?:MBrain\s+)?(?:MCP\s+)?(?:ops|operations?|tools?)\b/gi,
  /\b(?:operations?|tools?|remote\s+MCP)\s*(?:\||:|-|--|—)\s*~?\d+\s*(?:shared\s+)?(?:ops|operations?|tools?)\b/gi,
  /\boperation definitions?\s*(?:\(|:|-|--|—)?\s*~?\d+\s*(?:ops|operations?)?\)?/gi,
  /\boperations?\.ts\b[^\n]*\b~?\d+\s+(?:ops|operations?|tools?)\b/gi,
] as const;

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf-8');
}

describe('operation docs contract', () => {
  test('current-facing docs do not hard-code stale operation counts', () => {
    const operationCount = (goldenManifest as { summary: { operation_count: number } }).summary.operation_count;
    expect(operationCount).toBeGreaterThan(100);

    const violations = CURRENT_OPERATION_DOCS.flatMap((path) => {
      const content = readRepoFile(path);
      return BRITTLE_OPERATION_COUNT_PATTERNS.flatMap((pattern) => {
        return Array.from(content.matchAll(pattern), (match) => `${path}: ${match[0]}`);
      });
    });

    expect(violations).toEqual([]);
  });

  test('every non-admin operation is documented or explicitly annotated', () => {
    const docsContent = CURRENT_OPERATION_DOCS
      .map((path) => readRepoFile(path))
      .join('\n');
    const annotations = operationDocsAnnotations as {
      undocumented: Record<string, string>;
    };
    const missing = operations
      .filter((operation) => effectiveToolTier(operation) !== 'admin')
      .filter((operation) => !docsContent.includes(operation.name))
      .filter((operation) => !annotations.undocumented[operation.name]?.trim())
      .map((operation) => operation.name)
      .sort();

    expect(missing).toEqual([]);
  });
});
