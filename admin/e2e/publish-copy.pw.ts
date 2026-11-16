import { test, expect, type Page } from '@playwright/test';
import { generateHtml, encryptContent } from '../../src/commands/publish';

// `gbrain publish` pages render markdown in the browser. Every fenced code
// block gets a copy button in its top-right corner that puts the block's
// exact text on the clipboard. These run the generated HTML in real Chromium.

const PROMPT = 'Sync my meetings into memory.\n- Skip any meeting already filed.\n- Report: <b>open</b> items & "quotes".';
const MARKDOWN = `## Evening sync\n\n\`\`\`text\n${PROMPT}\n\`\`\`\n\nInline \`code\` stays plain.\n\n\`\`\`bash\ngbrain sync --dry-run\n\`\`\`\n`;
const SECURE_URL = 'http://localhost:4799/page.html';

async function serve(page: Page, url: string, html: string) {
  await page.route(url, route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto(url);
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('each fenced code block gets a top-right copy button that copies its exact text', async ({ page }) => {
  await serve(page, SECURE_URL, generateHtml({ title: 'Copy', markdown: MARKDOWN }));

  const buttons = page.getByRole('button', { name: 'Copy code to clipboard' });
  await expect(buttons).toHaveCount(2);
  // Inline code gets no button.
  await expect(page.locator('p code')).toHaveCount(1);

  // The button sits in the block's top-right corner.
  const block = await page.locator('.code-block').first().boundingBox();
  const btn = await buttons.first().boundingBox();
  expect(block && btn).toBeTruthy();
  expect(btn!.x + btn!.width).toBeGreaterThan(block!.x + block!.width - 20);
  expect(btn!.y).toBeLessThan(block!.y + 20);

  await buttons.first().click();
  await expect(page.getByRole('button', { name: 'Copied' })).toHaveCount(1);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);

  await page.getByRole('button', { name: 'Copy code to clipboard' }).last().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('gbrain sync --dry-run');

  // The icon resets so the button can be used again.
  await expect(page.getByRole('button', { name: 'Copy code to clipboard' })).toHaveCount(2, { timeout: 5_000 });
});

test('password-protected pages get copy buttons after unlocking', async ({ page }) => {
  const encrypted = encryptContent(MARKDOWN, 'pw-example');
  await serve(page, SECURE_URL, generateHtml({ title: 'Locked', markdown: '', encrypted }));

  await expect(page.getByRole('button', { name: 'Copy code to clipboard' })).toHaveCount(0);
  await page.getByPlaceholder('Enter password').fill('pw-example');
  await page.getByRole('button', { name: 'Unlock' }).click();

  const buttons = page.getByRole('button', { name: 'Copy code to clipboard' });
  await expect(buttons).toHaveCount(2);
  await buttons.first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
});
