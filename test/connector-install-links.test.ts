import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeConnectorLink, connectorInstallLinks, cursorInstallLink, installLinkLines } from '../src/core/connector-install-links.ts';

const HOSTED = 'https://gbrain.io/mcp';
const TAILNET = 'https://your-machine.your-tailnet.ts.net/mcp';
const HOSTED_CLAUDE = 'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=GBrain&connectorUrl=https%3A%2F%2Fgbrain.io%2Fmcp';
const HOSTED_CURSOR = 'cursor://anysphere.cursor-deeplink/mcp/install?name=gbrain&config=eyJ1cmwiOiJodHRwczovL2dicmFpbi5pby9tY3AifQ%3D%3D';
const UNLINKABLE = [
  'http://your-machine.your-tailnet.ts.net/mcp',
  'http://127.0.0.1:3131/mcp',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'not a url',
  '',
  ['https://alice-example', 'hunter2@brain.example.com/mcp'].join(':'),
  'https://alice-example@brain.example.com/mcp',
  'https://:hunter2@brain.example.com/mcp',
];

describe('cursorInstallLink', () => {
  test('is Cursor\'s documented deeplink with base64(JSON {url}) as config', () => {
    expect(cursorInstallLink(HOSTED)).toBe(HOSTED_CURSOR);
  });

  test('base64-encodes first, then URL-encodes, so + / = never reach the query raw', () => {
    const url = 'https://brain.example.com/mcp?q=a~aa?';
    const raw = Buffer.from(JSON.stringify({ url })).toString('base64');
    expect(raw).toMatch(/\+/);
    expect(raw).toMatch(/\//);
    expect(raw).toMatch(/=/);
    const link = cursorInstallLink(url)!;
    const config = link.slice(link.indexOf('&config=') + '&config='.length);
    expect(config).toBe(encodeURIComponent(raw));
    expect(config).not.toMatch(/[+/=]/);
    expect(JSON.parse(Buffer.from(decodeURIComponent(config), 'base64').toString('utf-8'))).toEqual({ url });
  });

  test('a space in the name is %20', () => {
    expect(cursorInstallLink(HOSTED, 'my brain')).toStartWith('cursor://anysphere.cursor-deeplink/mcp/install?name=my%20brain&config=');
  });

  test('no link for anything but a credential-free absolute https URL', () => {
    for (const url of UNLINKABLE) expect(cursorInstallLink(url)).toBeNull();
  });
});

describe('claudeConnectorLink', () => {
  test('is the claude.ai add-custom-connector form with name and URL filled in', () => {
    expect(claudeConnectorLink(HOSTED)).toBe(HOSTED_CLAUDE);
  });

  test('a space in the name is %20, and URL query characters stay inside connectorUrl', () => {
    const url = 'https://brain.example.com/mcp?a=1&modal=other';
    const link = claudeConnectorLink(url, 'My Brain')!;
    expect(link).toBe(`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=My%20Brain&connectorUrl=${encodeURIComponent(url)}`);
    const params = new URL(link).searchParams;
    expect(params.getAll('modal')).toEqual(['add-custom-connector']);
    expect(params.get('connectorUrl')).toBe(url);
  });

  test('no link for anything but a credential-free absolute https URL', () => {
    for (const url of UNLINKABLE) expect(claudeConnectorLink(url)).toBeNull();
  });
});

describe('connectorInstallLinks', () => {
  test('public URL: Claude and Cursor; tailnet-only: Cursor only; unlinkable: nothing', () => {
    expect(connectorInstallLinks(TAILNET, true)).toEqual({ claude: claudeConnectorLink(TAILNET)!, cursor: cursorInstallLink(TAILNET)! });
    expect(connectorInstallLinks(TAILNET, false)).toEqual({ cursor: cursorInstallLink(TAILNET)! });
    for (const url of UNLINKABLE) {
      expect(connectorInstallLinks(url, true)).toEqual({});
      expect(connectorInstallLinks(url, false)).toEqual({});
    }
  });

  test('installLinkLines prints one labelled line per link plus a short note, and nothing for no links', () => {
    const pub = installLinkLines(connectorInstallLinks(TAILNET, true), true);
    expect(pub[0]).toBe(`  Claude           ${claudeConnectorLink(TAILNET)}`);
    expect(pub).toContain(`  Cursor           ${cursorInstallLink(TAILNET)}`);
    expect(pub.join('\n')).not.toContain('must be on your tailnet');
    const tailnet = installLinkLines(connectorInstallLinks(TAILNET, false), false);
    expect(tailnet[0]).toBe(`  Cursor           ${cursorInstallLink(TAILNET)}`);
    expect(tailnet.join('\n')).toContain('the Cursor machine must be on your tailnet');
    expect(tailnet.join('\n')).not.toContain('claude.ai');
    expect(installLinkLines({}, true)).toEqual([]);
  });
});

describe('docs carry the hosted gbrain.io links the helpers build', () => {
  const doc = (p: string) => readFileSync(join(import.meta.dir, '..', p), 'utf-8');
  test('docs/mcp/README.md has both hosted links', () => {
    expect(doc('docs/mcp/README.md')).toContain(claudeConnectorLink(HOSTED)!);
    expect(doc('docs/mcp/README.md')).toContain(cursorInstallLink(HOSTED)!);
  });
  test('docs/mcp/CLAUDE_DESKTOP.md has the hosted Claude link above its manual steps', () => {
    const text = doc('docs/mcp/CLAUDE_DESKTOP.md');
    const at = text.indexOf(claudeConnectorLink(HOSTED)!);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(text.indexOf('## 2. Add the integration'));
  });
});
