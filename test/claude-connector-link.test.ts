import { describe, expect, test } from 'bun:test';
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
    const params = new URL(claudeConnectorLink(url, 'Team Brain & Co')!).searchParams;
    expect(params.get('connectorUrl')).toBe(url);
    expect(params.get('connectorName')).toBe('Team Brain & Co');
    expect(params.getAll('modal')).toEqual(['add-custom-connector']);
  });

  test('returns null for anything claude.ai cannot connect to', () => {
    for (const bad of ['http://your-machine.your-tailnet.ts.net/mcp', 'not a url', '', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(claudeConnectorLink(bad)).toBeNull();
    }
  });
});
