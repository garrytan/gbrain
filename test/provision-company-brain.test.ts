import { describe, expect, test } from 'bun:test';
import {
  commandPrefix,
  parseClientOutput,
  readArgs,
  renderCommand,
  validate,
  type CompanyBrainManifest,
} from '../scripts/provision-company-brain.ts';

describe('company brain provisioner args', () => {
  test('parses manifest without mistaking option values for positionals', () => {
    const args = readArgs([
      'deploy/saas/company-brain.example.yml',
      '--local',
      '--sync',
      '--credentials-out',
      'clients.json',
    ]);

    expect(args.manifestPath).toBe('deploy/saas/company-brain.example.yml');
    expect(args.local).toBe(true);
    expect(args.sync).toBe(true);
    expect(args.credentialsOut).toBe('clients.json');
  });

  test('supports help without a manifest', () => {
    const args = readArgs(['--help']);
    expect(args.help).toBe(true);
    expect(args.manifestPath).toBeUndefined();
  });

  test('rejects unknown flags and missing flag values', () => {
    expect(() => readArgs(['manifest.yml', '--wat'])).toThrow(/Unknown flag/);
    expect(() => readArgs(['manifest.yml', '--gbrain-bin'])).toThrow(/requires a value/);
  });

  test('uses checkout cli path in local mode', () => {
    const prefix = commandPrefix({
      manifestPath: 'manifest.yml',
      local: true,
      dryRun: false,
      skipClients: false,
      sync: false,
      help: false,
    });

    expect(prefix[0]).toBe(process.execPath);
    expect(prefix[1].replace(/\\/g, '/')).toEndWith('src/cli.ts');
  });
});

describe('company brain manifest validation', () => {
  const validManifest: CompanyBrainManifest = {
    sources: [
      { id: 'shared', url: 'https://github.com/acme/shared.git' },
      { id: 'customers', path: '/srv/customers' },
    ],
    clients: [
      {
        name: 'alice',
        source: 'customers',
        federated_read: ['customers', 'shared'],
        scopes: ['read', 'write'],
      },
    ],
  };

  test('accepts a scoped company-brain manifest', () => {
    expect(() => validate(validManifest)).not.toThrow();
  });

  test('rejects invalid source shapes', () => {
    expect(() => validate({ sources: [{ id: 'BadId', url: 'https://example.com/repo.git' }] }))
      .toThrow(/source.id/);
    expect(() => validate({ sources: [{ id: 'shared' }] }))
      .toThrow(/needs either path or url/);
    expect(() => validate({ sources: [{ id: 'shared', path: '/x', url: 'https://example.com/repo.git' }] }))
      .toThrow(/cannot set both/);
  });

  test('rejects clients outside the source boundary', () => {
    expect(() => validate({
      sources: [{ id: 'shared', path: '/srv/shared' }],
      clients: [{ name: 'alice', source: 'customers' }],
    })).toThrow(/unknown source/);

    expect(() => validate({
      sources: [{ id: 'shared', path: '/srv/shared' }],
      clients: [{ name: 'alice', source: 'shared', federated_read: ['internal'] }],
    })).toThrow(/reads unknown source/);
  });
});

describe('company brain command output helpers', () => {
  test('quotes dry-run commands that contain spaces', () => {
    expect(renderCommand(['gbrain', 'auth', 'register-client', '--scopes', 'read write']))
      .toBe('gbrain auth register-client --scopes "read write"');
  });

  test('parses confidential and public OAuth client output', () => {
    expect(parseClientOutput('Client ID: abc\nClient Secret: def\n')).toEqual({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(parseClientOutput('Client ID: abc\nClient Secret: <public client - none issued>\n')).toEqual({
      clientId: 'abc',
      clientSecret: undefined,
    });
  });
});
