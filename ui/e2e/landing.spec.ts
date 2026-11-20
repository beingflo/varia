import { expect, test } from '@playwright/test';

// No `varia:entered` flag: these are first visits. app.spec.ts starts as a returning user.
test.use({ storageState: { cookies: [], origins: [] } });

const ready = (page: import('@playwright/test').Page) =>
  page.waitForFunction(() => document.documentElement.dataset.db === 'ready', null, { timeout: 20_000 });

test('first visit shows the landing, "use now" hands over to the app for good', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'varia' })).toBeVisible();
  // The url says what is on screen, so a reload or a bookmark stays on the landing.
  expect(new URL(page.url()).pathname).toBe('/landing');

  await page.getByRole('button', { name: 'use now' }).click();
  await ready(page);
  expect(await page.evaluate(() => localStorage.getItem('varia:entered'))).toBe('1');

  await page.goto('/');
  await expect(page.getByLabel('note body')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
});

test('/landing stays reachable once entered, and does not boot the app', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('varia:entered', '1'));
  await page.goto('/landing');
  await expect(page.getByRole('heading', { name: 'shortcuts' })).toBeVisible();
  // No database worker: the landing must not pay for the app's chunk.
  expect(await page.evaluate(() => document.documentElement.dataset.db)).toBeUndefined();

  // The flag does not keep anyone out of the landing, and `/` still means the app.
  await page.goto('/');
  await expect(page.getByLabel('note body')).toBeVisible();
});
