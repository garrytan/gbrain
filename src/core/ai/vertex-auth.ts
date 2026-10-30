import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OAuth2Client } from 'google-auth-library';

const execFileAsync = promisify(execFile);
const GCLOUD_TIMEOUT_MS = 30_000;
const MAX_TOKEN_OUTPUT_BYTES = 4096;

export interface GcloudTokenRunner {
  (file: string, args: readonly string[], options: {
    timeout: number;
    maxBuffer: number;
    encoding: 'utf8';
    windowsHide: boolean;
  }): Promise<{ stdout: string; stderr: string }>;
}

const defaultTokenRunner: GcloudTokenRunner = async (file, args, options) =>
  execFileAsync(file, [...args], options);

function assertGcloudExecutable(path: string): void {
  try {
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) {
      throw new Error();
    }
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error('Vertex gcloud executable must be an existing executable absolute file.');
  }
}

function assertAccount(account: string): void {
  if (!/^[^\s@]+@[^\s@]+$/.test(account)) {
    throw new Error('Vertex gcloud account must be an explicit email address.');
  }
}

function parseAccessToken(stdout: string): string {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_TOKEN_OUTPUT_BYTES || !/^[^\s\r\n]+\r?\n?$/.test(stdout)) {
    throw new Error('Vertex gcloud access-token response was invalid.');
  }
  return stdout.replace(/\r?\n$/, '');
}

/**
 * SDK-compatible auth client that asks the configured gcloud account for an
 * access token on each sequential request. gcloud owns refresh and token
 * storage; this process keeps no TTL cache. Concurrent SDK calls share only
 * the in-flight subprocess and the entry is cleared on both outcomes.
 */
export class GcloudOAuth2Client extends OAuth2Client {
  private inFlight: Promise<{ token: string }> | null = null;

  constructor(
    private readonly gcloudPath: string,
    private readonly account: string,
    private readonly run: GcloudTokenRunner = defaultTokenRunner,
  ) {
    super();
    assertGcloudExecutable(gcloudPath);
    assertAccount(account);
  }

  override getAccessToken(): Promise<{ token: string }> {
    if (!this.inFlight) {
      this.inFlight = this.mintToken().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async mintToken(): Promise<{ token: string }> {
    try {
      const { stdout } = await this.run(
        this.gcloudPath,
        ['auth', 'print-access-token', '--account', this.account],
        {
          timeout: GCLOUD_TIMEOUT_MS,
          maxBuffer: MAX_TOKEN_OUTPUT_BYTES,
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      return { token: parseAccessToken(stdout) };
    } catch (error) {
      if (error instanceof Error && error.message === 'Vertex gcloud access-token response was invalid.') throw error;
      throw new Error('Vertex gcloud access-token request failed.');
    }
  }
}
