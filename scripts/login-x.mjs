#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

const workspace = path.resolve(process.argv[2] ?? '.bookmarks');
const authDir = path.join(workspace, 'playwright', '.auth');
const storageStatePath = path.join(authDir, 'x.json');

await mkdir(authDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-dev-shm-usage', '--no-sandbox'],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 1200 },
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
});

const page = await context.newPage();
await page.goto('https://x.com/login', {
  waitUntil: 'domcontentloaded',
  timeout: 45_000,
});

const rl = readline.createInterface({ input, output });
await rl.question(
  'Log into X in the opened browser, then press Enter here to save the session: ',
);
rl.close();

await context.storageState({ path: storageStatePath });
await context.close();
await browser.close();

console.log(storageStatePath);
