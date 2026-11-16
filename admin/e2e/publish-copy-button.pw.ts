import { test, expect, type Page } from '@playwright/test';
import { generateHtml, encryptContent } from '../../src/commands/publish.ts';

// gbrain publish pages render their markdown in the browser. Each fenced code
// block gets a copy button that puts the block's exact text on the clipboard.
// These tests run the generated page in Chromium from a localhost origin, so
// the async Clipboard API is available.

const ORIGIN = 'http://localhost:4817';
const SHELL = 'gbrain sync --dry-run';
const PROMPT = [
  'Summarise today\'s meetings for alice-example.',
  '  - keep <angle brackets> & "quotes" exactly',
  '\tand a tab-indented line',
].join('\n');
const MARKDOWN = [
  '# Notes', '',
  'Inline `code` stays plain.', '',
  '```text', PROMPT, '```', '',
  '```bash', SHELL, '```', '',
].join('\n');

async function open(page: Page, html: string) {
  await page.route(`${ORIGIN}/page.html`, route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto(`${ORIGIN}/page.html`);
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('every fenced code block gets one copy button that copies its exact text', async ({ page }) => {
  await open(page, generateHtml({ title: 'Notes', markdown: MARKDOWN }));
  const buttons = page.getByRole('button', { name: 'Copy code block' });
  await expect(buttons).toHaveCount(2);
  await expect(page.locator('p > code')).toHaveCount(1);
  await expect(page.locator('p button')).toHaveCount(0);

  await buttons.nth(0).click();
  expect(await clipboard(page)).toBe(PROMPT);
  await expect(page.getByRole('button', { name: 'Copied' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Copy code block' }).last().click();
  expect(await clipboard(page)).toBe(SHELL);
  await expect(page.getByRole('button', { name: 'Copy code block' })).toHaveCount(2, { timeout: 5_000 });
});

test('the copy button works from the keyboard', async ({ page }) => {
  await open(page, generateHtml({ title: 'Notes', markdown: MARKDOWN }));
  const first = page.getByRole('button', { name: 'Copy code block' }).first();
  await first.focus();
  await page.keyboard.press('Enter');
  expect(await clipboard(page)).toBe(PROMPT);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  const second = page.getByRole('button', { name: 'Copy code block' }).last();
  await second.focus();
  await page.keyboard.press('Space');
  expect(await clipboard(page)).toBe(SHELL);
});

test('a password-protected page gets its copy buttons after unlocking', async ({ page }) => {
  const encrypted = encryptContent(MARKDOWN, 'pw-example');
  await open(page, generateHtml({ title: 'Locked', markdown: '', encrypted }));
  await expect(page.getByRole('button', { name: 'Copy code block' })).toHaveCount(0);
  await page.getByPlaceholder('Enter password').fill('pw-example');
  await page.getByRole('button', { name: 'Unlock' }).click();
  const buttons = page.getByRole('button', { name: 'Copy code block' });
  await expect(buttons).toHaveCount(2);
  await buttons.first().click();
  expect(await clipboard(page)).toBe(PROMPT);
});

test('the sanitizer still has the last word on page content, locked or not', async ({ page }) => {
  const hostile = [
    '<img src="x" onerror="window.__hit = 1">',
    '<script>window.__hit = 2</script>',
    '<pre><code onclick="window.__hit = 3">raw html block</code></pre>',
    '<button class="copy-btn" onclick="window.__hit = 4">fake</button>',
    '', '```', SHELL, '```', '',
  ].join('\n');
  for (const encrypted of [null, encryptContent(hostile, 'pw-example')]) {
    await open(page, generateHtml({ title: 'Hostile', markdown: encrypted ? '' : hostile, encrypted }));
    if (encrypted) {
      await page.getByPlaceholder('Enter password').fill('pw-example');
      await page.getByRole('button', { name: 'Unlock' }).click();
    }
    await expect(page.getByRole('button', { name: 'Copy code block' })).toHaveCount(2);
    await page.locator('#content img').evaluate(el => el.dispatchEvent(new Event('error')));
    await page.locator('#content button', { hasText: 'fake' }).click();
    await page.locator('#content code', { hasText: 'raw html block' }).click();
    expect(await page.evaluate(() => (window as unknown as { __hit?: number }).__hit)).toBeUndefined();
    expect(await page.locator('#content [onerror], #content [onclick], #content script').count()).toBe(0);
  }
});

test('a code block that shows a closing script tag stays inside the page script', async ({ page }) => {
  const snippet = '</script><img src="x" onerror="window.__hit = 5"><script>window.__hit = 6</script>';
  await open(page, generateHtml({ title: 'Snippet', markdown: ['```html', snippet, '```', ''].join('\n') }));
  const buttons = page.getByRole('button', { name: 'Copy code block' });
  await expect(buttons).toHaveCount(1);
  await buttons.click();
  expect(await clipboard(page)).toBe(snippet);
  expect(await page.evaluate(() => (window as unknown as { __hit?: number }).__hit)).toBeUndefined();
  await expect(page.locator('body > img')).toHaveCount(0);
});

test('a page with no fenced code block renders the same content with no buttons', async ({ page }) => {
  await open(page, generateHtml({ title: 'Plain', markdown: '# Plain\n\nJust text with `inline` code.' }));
  await expect(page.locator('#content button')).toHaveCount(0);
  expect(await page.locator('#content').innerHTML()).toBe('<h1>Plain</h1>\n<p>Just text with <code>inline</code> code.</p>\n');
});
