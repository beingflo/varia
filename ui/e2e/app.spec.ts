import { expect, test, type Page } from '@playwright/test';

/** Waits until the worker has opened the database, whatever view is mounted. */
async function ready(page: Page) {
  await page.waitForFunction(() => document.documentElement.dataset.db === 'ready', null, { timeout: 20_000 });
}

async function newNote(page: Page, body: string) {
  await ready(page);
  await page.getByRole('button', { name: 'note' }).click();
  const editor = page.getByLabel('note body');
  await editor.fill(body);
  await editor.blur();
}

test('is cross-origin isolated, as the sqlite opfs VFS requires', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await ready(page);
});

test('keeps a note across a reload and lists it by title', async ({ page }) => {
  await page.goto('/');
  await newNote(page, '# Lab notes\nthe retry loop coalesces');

  // Back to the list first: the title can only come from a save that actually landed.
  await page.getByText('← back').click();
  await expect(page.getByText('Lab notes')).toBeVisible();

  await page.reload();
  await ready(page);
  await expect(page.getByText('Lab notes')).toBeVisible();

  await page.getByText('Lab notes').click();
  await expect(page.getByLabel('note body')).toHaveValue('# Lab notes\nthe retry loop coalesces');
});

test('searches bodies and item texts, and filters by tag', async ({ page }) => {
  await page.goto('/');
  await newNote(page, 'about coalesce');
  await page.getByLabel('tags').fill('lab, work');
  await page.getByLabel('tags').blur();

  await page.getByText('← back').click();
  await expect(page.getByText('lab')).toBeVisible();

  await page.getByPlaceholder('search').fill('coalesce');
  await expect(page.getByText('about coalesce')).toBeVisible();

  await page.getByPlaceholder('search').fill('nothing matches this');
  await expect(page.getByText('about coalesce')).toHaveCount(0);

  await page.getByPlaceholder('search').fill('');
  await page.getByRole('button', { name: 'lab' }).click();
  await expect(page.getByText('about coalesce')).toBeVisible();
});

test('shows version history and restores an older body', async ({ page }) => {
  await page.goto('/');
  await newNote(page, 'first draft');
  const editor = page.getByLabel('note body');
  await editor.fill('second draft');
  await editor.blur();

  await page.getByRole('button', { name: 'history' }).click();
  const rows = page.locator('.version');
  await expect(rows).toHaveCount(2);
  await rows.last().getByRole('button', { name: 'restore' }).click();
  await expect(editor).toHaveValue('first draft');
  await expect(rows).toHaveCount(3); // restoring is an ordinary edit: it adds a version
});

test('runs a todo list: add, check, show done, edit, delete, rename', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'list' }).click();

  const title = page.getByLabel('list title');
  await title.fill('work');
  await title.blur();

  const add = page.getByLabel('new item');
  for (const text of ['buy milk', 'book dentist']) {
    await add.fill(text);
    await add.press('Enter');
    await expect(page.getByRole('textbox', { name: text })).toBeVisible();
  }

  await page.getByRole('checkbox', { name: 'buy milk' }).click();
  await expect(page.getByRole('textbox', { name: 'buy milk' })).toHaveCount(0);

  await page.getByRole('checkbox', { name: /show done/i }).click();
  await expect(page.getByRole('textbox', { name: 'buy milk' })).toBeVisible();

  const item = page.getByRole('textbox', { name: 'book dentist' });
  await item.fill('book dentist urgently');
  await item.blur();
  // The view re-reads after the write, so the new label only appears once it is in the database.
  await expect(page.getByRole('textbox', { name: 'book dentist urgently' })).toBeVisible();
  await page.reload();
  await ready(page);
  await expect(page.getByRole('textbox', { name: 'book dentist urgently' })).toBeVisible();

  await page.getByLabel('delete book dentist urgently').click();
  await expect(page.getByRole('textbox', { name: 'book dentist urgently' })).toHaveCount(0);

  await page.getByText('← back').click();
  await expect(page.getByText('work')).toBeVisible();
});

test('a second tab sees writes without a reload', async ({ page, context }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'list' }).click();
  await page.getByLabel('new item').fill('from tab one');
  await page.getByLabel('new item').press('Enter');
  await expect(page.getByRole('textbox', { name: 'from tab one' })).toBeVisible();

  const second = await context.newPage();
  await second.goto(page.url());
  await ready(second);
  await second.getByLabel('new item').fill('from tab two');
  await second.getByLabel('new item').press('Enter');

  // No reload: the first tab is told over BroadcastChannel and re-reads.
  await expect(page.getByRole('textbox', { name: 'from tab two' })).toBeVisible({ timeout: 10_000 });
});

test('two tabs can write the same database', async ({ page, context }) => {
  await page.goto('/');
  await ready(page);

  const second = await context.newPage();
  await second.goto('/');
  await ready(second);

  await second.getByRole('button', { name: 'note' }).click();
  await second.getByLabel('note body').fill('written by tab two');
  await second.getByLabel('note body').blur();
  await second.getByText('← back').click();

  await expect(page.getByText('written by tab two')).toBeVisible({ timeout: 10_000 });
});
