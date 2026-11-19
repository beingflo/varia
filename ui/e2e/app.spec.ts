import { expect, test, type Page } from '@playwright/test';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const press = (page: Page, key: string) => page.keyboard.press(`${MOD}+${key}`);

/** Waits until the worker has opened the database, whatever view is mounted. */
async function ready(page: Page) {
  await page.waitForFunction(() => document.documentElement.dataset.db === 'ready', null, { timeout: 20_000 });
}

async function openList(page: Page) {
  await press(page, 'k');
  await expect(page.getByLabel('search notes')).toBeVisible();
}

async function openDebug(page: Page) {
  await page.keyboard.press(`${MOD}+Shift+D`);
  await expect(page.getByText('varia · database')).toBeVisible();
}

const editor = (page: Page) => page.getByLabel('note body');

test('is cross-origin isolated, as the sqlite opfs VFS requires', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await ready(page);
});

test('lands on an empty note and saves it only on command', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  await expect(editor(page)).toHaveValue('');
  await expect(page).toHaveTitle('varia');

  await editor(page).fill('# Lab notes\nthe retry loop coalesces');
  await press(page, 's');
  // Saving a draft must not clear or deselect what was just written.
  await expect(editor(page)).toHaveValue('# Lab notes\nthe retry loop coalesces');

  await openList(page);
  await expect(page.getByText('Lab notes')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveValue('# Lab notes\nthe retry loop coalesces');
  await expect(editor(page)).toBeFocused();
});

test('does not save while typing', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await editor(page).fill('saved once');
  await press(page, 's');

  // Type more, wait past every debounce that used to exist, and read the row count off the
  // overlay's own table list (clicking a table would blur the editor and legitimately save).
  await editor(page).fill('saved once, then typed more');
  await page.waitForTimeout(1500);
  await openDebug(page);
  await expect(page.locator('nav button[aria-label="table version"]')).toContainText('version1');
  await page.keyboard.press('Escape');

  // An explicit save is what writes the newer text.
  await press(page, 's');
  await openDebug(page);
  await expect(page.locator('nav button[aria-label="table version"]')).toContainText('version2');
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveValue('saved once, then typed more');
});

test('saves on blur', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await editor(page).fill('saved by blur');
  await page.getByLabel('tags').click(); // moves focus away from the editor
  await openList(page);
  await expect(page.getByText('saved by blur')).toBeVisible();
});

test('starts a new note from anywhere and searches the list', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await editor(page).fill('first note');
  await press(page, 's');

  await press(page, 'e');
  await expect(editor(page)).toHaveValue('');

  await editor(page).fill('second note');
  await press(page, 's');

  await openList(page);
  await page.getByLabel('search notes').fill('second');
  await expect(page.getByText('first note')).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('search notes')).toHaveCount(0);
  await expect(editor(page)).toHaveValue('second note');
});

test('deletes the open note', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await editor(page).fill('doomed');
  await press(page, 's');
  await press(page, 'd');

  await expect(editor(page)).toHaveValue('');
  await openList(page);
  await expect(page.getByText('nothing yet')).toBeVisible();
});

test('restores an old version from history', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await editor(page).fill('first draft');
  await press(page, 's');
  await editor(page).fill('second draft');
  await press(page, 's');

  await page.keyboard.press(`${MOD}+Shift+H`);
  const versions = page.locator('.version');
  await expect(versions).toHaveCount(2);
  await versions.last().click();

  await expect(editor(page)).toHaveValue('first draft');
});

test('runs a todo list without a single button', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.keyboard.press(`${MOD}+Shift+E`);

  const title = page.getByLabel('list title');
  await expect(title).toHaveValue('list');
  await title.fill('work');
  await press(page, 's');

  const add = page.getByLabel('new item');
  await add.fill('buy milk');
  await add.press('Enter');
  await add.fill('book dentist');
  await add.press('Enter');
  await expect(page.getByRole('textbox', { name: 'buy milk' })).toBeVisible();

  await page.getByRole('checkbox', { name: 'buy milk' }).click();
  await expect(page.getByRole('textbox', { name: 'buy milk' })).toHaveCount(0);

  await page.keyboard.press(`${MOD}+Shift+A`);
  await expect(page.getByRole('textbox', { name: 'buy milk' })).toBeVisible();

  const item = page.getByRole('textbox', { name: 'book dentist' });
  await item.fill('book dentist urgently');
  await item.press('Tab');
  await expect(page.getByRole('textbox', { name: 'book dentist urgently' })).toBeVisible();

  await page.getByRole('textbox', { name: 'book dentist urgently' }).fill('');
  await page.getByRole('textbox', { name: 'book dentist urgently' }).press('Tab');
  await expect(page.getByRole('textbox', { name: 'book dentist urgently' })).toHaveCount(0);

  await expect(page.locator('main button')).toHaveCount(0);
});

test('ctrl+j and ctrl+k move the selection without closing the list', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  await editor(page).fill('alpha');
  await press(page, 's');
  await press(page, 'e');
  await expect(editor(page)).toHaveValue(''); // the fresh draft is ready before typing
  await editor(page).fill('beta');
  await press(page, 's');

  await openList(page); // newest first: beta, alpha
  await expect(page.locator('.notes li')).toHaveCount(2);
  await page.keyboard.press('Control+j');
  await expect(page.getByLabel('search notes')).toBeVisible(); // the list stayed open
  await page.keyboard.press('Enter');
  await expect(editor(page)).toHaveValue('alpha');

  await openList(page);
  await expect(page.locator('.notes li')).toHaveCount(2);
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('search notes')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(editor(page)).toHaveValue('beta');
});

test('keeps both notes when a new one is started right after saving', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await editor(page).fill('alpha');
  await press(page, 's');
  await press(page, 'e'); // immediately, without waiting for the save
  await expect(editor(page)).toHaveValue('');
  await editor(page).fill('beta');
  await press(page, 's');

  await openList(page);
  await expect(page.getByText('alpha')).toBeVisible();
  await expect(page.getByText('beta')).toBeVisible();
});

test('fits an empty note in the viewport without scrolling', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByLabel('tags')).toBeInViewport();
});

test('grows the editor instead of scrolling inside it', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of a note long enough to overflow`).join('\n');
  await editor(page).fill(long);

  const info = await page.evaluate(() => {
    const el = document.querySelector('.editor') as HTMLTextAreaElement;
    return {
      fieldScrolls: el.scrollHeight > el.clientHeight + 2,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
    };
  });
  expect(info.fieldScrolls).toBe(false);
  expect(info.pageScrolls).toBe(true);
});

test('shrinks the editor back down when a new note starts', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of a note long enough to overflow`).join('\n');
  await editor(page).fill(long);
  await press(page, 's');

  const grown = await page.evaluate(() => Math.round(document.querySelector('.editor')!.getBoundingClientRect().height));
  expect(grown).toBeGreaterThan(800);

  await press(page, 'e');
  await expect(editor(page)).toHaveValue('');
  await expect
    .poll(() => page.evaluate(() => Math.round(document.querySelector('.editor')!.getBoundingClientRect().height)))
    .toBeLessThan(800);
});

test('centres the writing column on wide windows', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await ready(page);

  const { columnCentre, windowCentre } = await page.evaluate(() => {
    const box = document.querySelector('.editor')!.getBoundingClientRect();
    return { columnCentre: box.x + box.width / 2, windowCentre: window.innerWidth / 2 };
  });
  expect(Math.abs(columnCentre - windowCentre)).toBeLessThan(2);
});

test('a second tab sees writes without a reload', async ({ page, context }) => {
  await page.goto('/');
  await ready(page);
  await editor(page).fill('from tab one');
  await press(page, 's');

  const second = await context.newPage();
  await second.goto('/');
  await ready(second);
  await openList(second);
  await expect(second.getByText('from tab one')).toBeVisible();

  await editor(page).fill('from tab one, edited');
  await press(page, 's');

  await expect(second.getByText('from tab one, edited')).toBeVisible({ timeout: 10_000 });
});

test('debug overlay reads the database and leaves the app untouched', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await editor(page).fill('a note for the overlay');
  await press(page, 's');

  await openDebug(page);
  await page.getByLabel('table op', { exact: true }).click();
  await expect(page.getByText('note_snapshot').first()).toBeVisible();
  await page.getByLabel('table version').click();
  await expect(page.getByText('a note for the overlay').first()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByText('varia · database')).toHaveCount(0);
  await expect(editor(page)).toHaveValue('a note for the overlay');
});
