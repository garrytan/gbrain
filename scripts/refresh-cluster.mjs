#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const workspaceArgIndex = args.indexOf('--workspace');
const workspace = path.resolve(
  workspaceArgIndex >= 0 ? args[workspaceArgIndex + 1] : '.bookmarks',
);
const forwardedArgs = [...args];
if (workspaceArgIndex === -1) {
  forwardedArgs.unshift('--workspace', workspace);
}

if (!process.env.PLAYWRIGHT_STORAGE_STATE) {
  process.env.PLAYWRIGHT_STORAGE_STATE = path.join(
    workspace,
    'playwright',
    '.auth',
    'x.json',
  );
}

await new Promise((resolve, reject) => {
  const child = spawn(
    'bun',
    ['run', 'src/cli.ts', 'ingest:bookmarks', ...forwardedArgs],
    {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    },
  );

  child.on('exit', (code) => {
    if (code === 0) {
      resolve();
      return;
    }

    reject(new Error(`ingest:bookmarks failed with code ${code}`));
  });
});
