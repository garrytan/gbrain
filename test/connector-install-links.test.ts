import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_ADD_CONNECTOR_BASE, CURSOR_MCP_INSTALL_BASE, claudeConnectorLink, connectorInstallLinks, cursorInstallLink,
} from '../src/core/connector-install-links.ts';

const BAD_URLS = [
  'http://your-machine.your-tailnet.ts.net/mcp', 'not a url', '', 'file:///etc/passwd', 'javascript:alert(1)',
  'https://user:secret@brain.example.com/mcp', 'https://user@brain.example.com/mcp',
];

/** Cursor's documented decoding: URL-decode the query value, base64-decode, JSON.parse. */
function cursorConfig(link: string): { name: string | null; config: unknown } {
  const params = new URL(link).searchParams;
  return { name: params.get('name'), config: JSON.parse(Buffer.from(params.get('config')!, 'base64').toString('utf-8')) };
}

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
    for (const bad of BAD_URLS) expect(claudeConnectorLink(bad)).toBeNull();
  });

  test('the hosted gbrain.io link in the Claude Desktop guide is the one the helper builds', () => {
    const doc = readFileSync(join(import.meta.dir, '..', 'docs', 'mcp', 'CLAUDE_DESKTOP.md'), 'utf-8');
    expect(doc).toContain(claudeConnectorLink('https://gbrain.io/mcp')!);
  });
});

describe('cursorInstallLink', () => {
  test('carries base64(JSON) of the mcp.json url entry, URL-encoded after base64', () => {
    const link = cursorInstallLink('https://gbrain.io/mcp')!;
    expect(link.startsWith(`${CURSOR_MCP_INSTALL_BASE}?name=gbrain&config=`)).toBe(true);
    expect(cursorConfig(link)).toEqual({ name: 'gbrain', config: { url: 'https://gbrain.io/mcp' } });
    // base64's '+', '/' and '=' never reach the query raw
    expect(link.split('config=')[1]).not.toMatch(/[+/=]/);
  });

  test('keeps an awkward URL and name intact', () => {
    const url = 'https://brain.example.com:8443/mcp?x=1&y=ü';
    const { name, config } = cursorConfig(cursorInstallLink(url, 'team brain')!);
    expect(name).toBe('team brain');
    expect(config).toEqual({ url: new URL(url).href });
  });

  test('returns null for the same unlinkable URLs', () => {
    for (const bad of BAD_URLS) expect(cursorInstallLink(bad)).toBeNull();
  });

  test('the hosted gbrain.io Cursor link in the MCP index is the one the helper builds', () => {
    const doc = readFileSync(join(import.meta.dir, '..', 'docs', 'mcp', 'README.md'), 'utf-8');
    expect(doc).toContain(cursorInstallLink('https://gbrain.io/mcp')!);
  });
});

describe('connectorInstallLinks', () => {
  test('a public URL gets Claude and Cursor; a tailnet-only one gets Cursor only; an unlinkable one gets nothing', () => {
    const url = 'https://your-machine.your-tailnet.ts.net/mcp';
    expect(connectorInstallLinks(url, { isPublic: true })).toEqual({ claude: claudeConnectorLink(url)!, cursor: cursorInstallLink(url)! });
    expect(connectorInstallLinks(url, { isPublic: false })).toEqual({ cursor: cursorInstallLink(url)! });
    expect(connectorInstallLinks('http://127.0.0.1:3131/mcp', { isPublic: true })).toEqual({});
  });
});
