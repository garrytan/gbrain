import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_ADD_CONNECTOR_BASE, claudeConnectorLink } from '../src/core/claude-connector-link.ts';

describe('claudeConnectorLink', () => {
  test('prefills the add-connector dialog with the name and the encoded MCP URL', () => {
    const link = claudeConnectorLink('https://gbrain.io/mcp');
    expect(link).toBe(`${CLAUDE_ADD_CONNECTOR_BASE}?modal=add-custom-connector&connectorName=GBrain&connectorUrl=https%3A%2F%2Fgbrain.io%2Fmcp`);
    const params = new URL(link!).searchParams;
    expect(params.get('modal')).toBe('add-custom-connector');
    expect(params.get('connectorName')).toBe('GBrain');
    expect(params.get('connectorUrl')).toBe('https://gbrain.io/mcp');
  });

  test('round-trips query strings, ports and a custom name without leaking into other parameters', () => {
    const url = 'https://brain.example.com:8443/mcp?x=1&modal=evil';
    const link = claudeConnectorLink(url, 'Team Brain & Co')!;
    // a space is %20, never '+', so decodeURIComponent and URLSearchParams agree
    expect(link).toContain('connectorName=Team%20Brain%20%26%20Co');
    const params = new URL(link).searchParams;
    expect(params.get('connectorUrl')).toBe(url);
    expect(params.get('connectorName')).toBe('Team Brain & Co');
    expect(params.getAll('modal')).toEqual(['add-custom-connector']);
  });

  test('returns null for anything claude.ai cannot connect to, or a URL carrying credentials', () => {
    for (const bad of [
      'http://your-machine.your-tailnet.ts.net/mcp', 'not a url', '', 'file:///etc/passwd', 'javascript:alert(1)',
      'https://user:secret@brain.example.com/mcp', 'https://user@brain.example.com/mcp',
    ]) {
      expect(claudeConnectorLink(bad)).toBeNull();
    }
  });

  test('the hosted gbrain.io link in the Claude Desktop guide is the one the helper builds', () => {
    const doc = readFileSync(join(import.meta.dir, '..', 'docs', 'mcp', 'CLAUDE_DESKTOP.md'), 'utf-8');
    expect(doc).toContain(claudeConnectorLink('https://gbrain.io/mcp')!);
  });
});
