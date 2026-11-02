// Real browsers against a real server and database. Needs `npm install` in both
// projects and an installed Chrome (or set E2E_CHANNEL=msedge).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const PG_PORT = 54332;
Object.assign(process.env, {
  DATABASE_URL: `postgres://kanban_app:kanban_app@localhost:${PG_PORT}/kanban`,
  OWNER_DATABASE_URL: `postgres://postgres:postgres@localhost:${PG_PORT}/kanban`,
  JWT_SECRET: 'e2e-secret',
  AUTH_RATE_LIMIT: '100000',
  FRONTEND_DIST: resolve('dist'),
});

const { startEmbeddedPostgres } = await import('../../julley-backend/src/db/embedded.js');
const { migrate } = await import('../../julley-backend/src/db/migrate.js');
const { seed } = await import('../../julley-backend/src/db/seed.js');
const { startNode } = await import('../../julley-backend/src/app.js');
const { pool } = await import('../../julley-backend/src/db/pool.js');

const { buildFrames, visibleTasks } = await import('../src/lib/replay.js');

const SHOTS = resolve(process.env.E2E_SCREENSHOTS ?? 'e2e/screenshots');
const results = [];
const pageErrors = [];

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL ${name}\n     ${String(err.message).split('\n').slice(0, 6).join('\n     ')}`);
  }
}

async function signIn(browser, baseUrl, email, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 }, ...options });
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(`${email}: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|WebSocket/.test(msg.text())) {
      pageErrors.push(`${email}: ${msg.text()}`);
    }
  });
  await page.goto(baseUrl);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByTestId('board').waitFor();
  return { context, page, email };
}

const card = (page, title) => page.getByTestId('task-card').filter({ hasText: title });
const column = (page, name) => page.getByRole('region', { name, exact: true });
const inColumn = (page, name, title) => column(page, name).getByTestId('task-card').filter({ hasText: title });
const titlesIn = (page, name) => column(page, name).getByTestId('task-card').locator('h4').allTextContents();
const synced = (page) => page.getByTestId('sync-status').getByText('Live').waitFor();

async function dragCard(page, title, targetColumn, { toTitle, position = 'above' } = {}) {
  const from = await card(page, title).boundingBox();
  const target = toTitle ? card(page, toTitle) : column(page, targetColumn).locator('.column-tasks');
  const to = await target.boundingBox();
  const x = to.x + to.width / 2;
  const y = toTitle
    ? (position === 'above' ? to.y + 4 : to.y + to.height - 4)
    : to.y + to.height - 8;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.move(x, y + 1);
  await page.waitForTimeout(80);
  await page.mouse.up();
}

const dbDir = await mkdtemp(join(tmpdir(), 'tenant-flow-e2e-'));
const database = await startEmbeddedPostgres({ dir: dbDir, port: PG_PORT, persistent: false });
await migrate();
await seed();
let node = await startNode({ port: 0 });
const { port: apiPort } = node;
const baseUrl = `http://localhost:${apiPort}`;
await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'chrome', headless: true });

try {
  let ben;
  let cara;

  await step('login shows the sign-in form; wrong password is refused', async () => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.getByRole('tab', { name: 'Conflict' }).click();
    await page.waitForTimeout(3200);
    await page.screenshot({ path: join(SHOTS, '01-login.png') });
    await page.getByLabel('Email').fill('ben@acme.test');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').getByText('Incorrect email or password').waitFor();
    await context.close();
  });

  await step('two users sign in and land on the same board', async () => {
    ben = await signIn(browser, baseUrl, 'ben@acme.test');
    cara = await signIn(browser, baseUrl, 'cara@acme.test');
    // Cara is in two branches, so make sure both are looking at Mumbai.
    await cara.page.getByRole('button', { name: /^Branch: / }).click();
    await cara.page.getByRole('button', { name: /^Mumbai/ }).click();
    await cara.page.getByRole('tab', { name: 'Warehouse rollout' }).click();
    await card(cara.page, 'Pilot scanning in aisle 12').waitFor();
    await card(ben.page, 'Pilot scanning in aisle 12').waitFor();
    await synced(ben.page);
    await synced(cara.page);
  });

  await step('organization selector and branch switcher show the right scope', async () => {
    await cara.page.getByRole('button', { name: /^Organization: Acme Logistics/ }).click();
    const orgs = await cara.page.locator('.popover .menu-item span').allTextContents();
    assert.deepEqual(orgs, ['Acme Logistics']);
    await cara.page.keyboard.press('Escape');
    await cara.page.getByRole('button', { name: /^Branch: Mumbai/ }).click();
    const branches = await cara.page.locator('.popover .menu-item span').allTextContents();
    assert.deepEqual(branches, ['Berlin', 'Mumbai']);
    await cara.page.keyboard.press('Escape');
    await ben.page.getByRole('button', { name: /^Branch: Mumbai/ }).click();
    const bens = await ben.page.locator('.popover .menu-item span').allTextContents();
    assert.deepEqual(bens, ['Mumbai'], 'Ben must not see Berlin');
    await ben.page.keyboard.press('Escape');
  });

  await step('presence shows both users in the branch', async () => {
    for (const { page } of [ben, cara]) {
      await page.getByTestId('presence').locator('.avatar').nth(1).waitFor();
      assert.equal(await page.getByTestId('presence').locator('.avatar').count(), 2);
    }
    await ben.page.screenshot({ path: join(SHOTS, '02-board.png') });
  });

  await step('role gating: a member has no admin controls, a branch admin does', async () => {
    assert.equal(await cara.page.getByRole('button', { name: 'Add column' }).count(), 0);
    assert.equal(await cara.page.getByRole('button', { name: 'Settings' }).count(), 0);
    assert.equal(await ben.page.getByRole('button', { name: 'Add column' }).count(), 1);
    assert.equal(await ben.page.getByRole('button', { name: 'Settings' }).count(), 1);
  });

  await step('a task created by one user appears live for the other', async () => {
    await column(ben.page, 'Backlog').getByRole('button', { name: 'Add task' }).click();
    await ben.page.getByLabel('New task title').fill('Label the returns shelf');
    await ben.page.keyboard.press('Enter');
    await ben.page.keyboard.press('Escape');
    await inColumn(ben.page, 'Backlog', 'Label the returns shelf').waitFor();
    await inColumn(cara.page, 'Backlog', 'Label the returns shelf').waitFor({ timeout: 3000 });
    await synced(ben.page);
  });

  await step('drag and drop across columns syncs live and survives a reload', async () => {
    await dragCard(ben.page, 'Label the returns shelf', 'Review');
    await inColumn(ben.page, 'Review', 'Label the returns shelf').waitFor();
    await inColumn(cara.page, 'Review', 'Label the returns shelf').waitFor({ timeout: 3000 });
    await synced(ben.page);
    await cara.page.reload();
    await inColumn(cara.page, 'Review', 'Label the returns shelf').waitFor();
    await synced(cara.page);
  });

  await step('drag and drop reorders within a column, for both users', async () => {
    const before = await titlesIn(ben.page, 'Backlog');
    assert.equal(before[0], 'Audit barcode label stock');
    await dragCard(ben.page, 'Confirm spare scanner budget', 'Backlog', { toTitle: 'Audit barcode label stock', position: 'above' });
    await synced(ben.page);
    await cara.page.waitForTimeout(300);
    const expected = ['Confirm spare scanner budget', 'Audit barcode label stock', 'Draft shift plan for cutover week'];
    assert.deepEqual(await titlesIn(ben.page, 'Backlog'), expected);
    assert.deepEqual(await titlesIn(cara.page, 'Backlog'), expected);
  });

  await step('undo and redo a move, seen by the other user', async () => {
    await ben.page.locator('body').click({ position: { x: 1300, y: 780 } });
    await ben.page.keyboard.press('Control+z');
    await synced(ben.page);
    await cara.page.waitForTimeout(300);
    assert.equal((await titlesIn(cara.page, 'Backlog'))[0], 'Audit barcode label stock');
    await ben.page.keyboard.press('Control+Shift+z');
    await synced(ben.page);
    await cara.page.waitForTimeout(300);
    assert.equal((await titlesIn(cara.page, 'Backlog'))[0], 'Confirm spare scanner budget');
  });

  await step('delete, then undo, restores the task for everyone', async () => {
    await card(ben.page, 'Label the returns shelf').click();
    await ben.page.getByTestId('task-panel').getByRole('button', { name: 'Delete task' }).click();
    await card(cara.page, 'Label the returns shelf').waitFor({ state: 'detached', timeout: 3000 });
    await ben.page.getByRole('button', { name: 'Undo', exact: true }).click();
    await inColumn(cara.page, 'Review', 'Label the returns shelf').waitFor({ timeout: 3000 });
    await synced(ben.page);
  });

  await step("the task panel edits sync, and open cards show who has them open", async () => {
    await card(cara.page, 'Pilot scanning in aisle 12').click();
    const panel = cara.page.getByTestId('task-panel');
    await panel.waitFor();
    await card(ben.page, 'Pilot scanning in aisle 12').getByTestId('card-viewer').waitFor({ timeout: 3000 });
    await panel.getByLabel('Priority').selectOption('low');
    await card(ben.page, 'Pilot scanning in aisle 12').locator('.tag').waitFor({ state: 'detached', timeout: 3000 });
    await cara.page.screenshot({ path: join(SHOTS, '03-task-panel.png') });
    await panel.getByLabel('Priority').selectOption('urgent');
    await card(ben.page, 'Pilot scanning in aisle 12').locator('.tag-urgent').waitFor({ timeout: 3000 });
  });

  await step('non-overlapping edits merge: remote updates reach a form being edited', async () => {
    const panel = cara.page.getByTestId('task-panel');
    const description = panel.getByLabel('Description');
    await description.click();
    await description.fill('Cara is halfway through typing');
    // Ben changes a different field while Cara types.
    await card(ben.page, 'Pilot scanning in aisle 12').click();
    await ben.page.getByTestId('task-panel').getByLabel('Due date').fill('2030-01-15');
    await panel.getByLabel('Due date').and(cara.page.locator('[value="2030-01-15"]')).waitFor({ timeout: 3000 });
    assert.equal(await description.inputValue(), 'Cara is halfway through typing', 'typing is not clobbered');
    await panel.getByLabel('Title').click(); // blur saves
    await synced(cara.page);
    await ben.page.getByTestId('task-panel').getByLabel('Description').and(ben.page.getByText('Cara is halfway through typing')).waitFor({ timeout: 3000 });
    await cara.page.keyboard.press('Escape');
  });

  await step('editing the same field raises a conflict dialog; "Keep mine" wins', async () => {
    const carasPanel = cara.page.getByTestId('task-panel');
    await card(cara.page, 'Pilot scanning in aisle 12').click();
    await carasPanel.getByLabel('Title').click();
    await carasPanel.getByLabel('Title').fill('Pilot scanning: Cara');

    const bensTitle = ben.page.getByTestId('task-panel').getByLabel('Title');
    await bensTitle.click();
    await bensTitle.fill('Pilot scanning: Ben');
    await ben.page.getByTestId('task-panel').getByLabel('Description').click();
    await card(cara.page, 'Pilot scanning: Ben').waitFor({ timeout: 3000 });

    await carasPanel.getByLabel('Description').click(); // blur commits Cara's title
    const dialog = cara.page.getByTestId('conflict-dialog');
    await dialog.waitFor({ timeout: 3000 });
    assert.match(await dialog.innerText(), /Pilot scanning: Ben/);
    assert.match(await dialog.innerText(), /Pilot scanning: Cara/);
    await cara.page.screenshot({ path: join(SHOTS, '04-conflict.png') });
    await cara.page.getByRole('button', { name: 'Keep mine' }).click();
    await card(ben.page, 'Pilot scanning: Cara').waitFor({ timeout: 3000 });
    await ben.page.keyboard.press('Escape');
    await cara.page.keyboard.press('Escape');
    await synced(cara.page);
  });

  await step('undo refuses to overwrite a change someone else made afterwards', async () => {
    await column(ben.page, 'Done').getByRole('button', { name: 'Add task' }).click();
    await ben.page.getByLabel('New task title').fill('Undo guard');
    await ben.page.keyboard.press('Enter');
    await ben.page.keyboard.press('Escape');
    await inColumn(cara.page, 'Done', 'Undo guard').waitFor({ timeout: 3000 });
    await synced(ben.page);

    await dragCard(ben.page, 'Undo guard', 'Review');
    await inColumn(cara.page, 'Review', 'Undo guard').waitFor({ timeout: 3000 });
    await synced(ben.page);
    await dragCard(cara.page, 'Undo guard', 'Backlog');
    await inColumn(ben.page, 'Backlog', 'Undo guard').waitFor({ timeout: 3000 });
    await synced(cara.page);

    await ben.page.locator('body').click({ position: { x: 1300, y: 780 } });
    await ben.page.keyboard.press('Control+z');
    await ben.page.getByTestId('toast').filter({ hasText: /Can't undo: Cara Lindqvist changed this/ }).waitFor({ timeout: 3000 });
    await inColumn(ben.page, 'Backlog', 'Undo guard').waitFor();
    await synced(ben.page);
  });

  await step('network recovery: events missed while offline arrive on reconnect', async () => {
    await cara.context.setOffline(true);
    await cara.page.getByTestId('sync-status').getByText(/Reconnecting/).waitFor({ timeout: 45_000 });
    await cara.page.screenshot({ path: join(SHOTS, '05-offline.png') });

    await column(ben.page, 'Backlog').getByRole('button', { name: 'Add task' }).click();
    await ben.page.getByLabel('New task title').fill('Created while Cara was away');
    await ben.page.keyboard.press('Enter');
    await ben.page.keyboard.press('Escape');
    await synced(ben.page);
    assert.equal(await card(cara.page, 'Created while Cara was away').count(), 0);

    await cara.context.setOffline(false);
    await inColumn(cara.page, 'Backlog', 'Created while Cara was away').waitFor({ timeout: 20_000 });
    await synced(cara.page);
  });

  await step('network recovery: offline writes stay on screen, then deliver once', async () => {
    await cara.context.setOffline(true);
    await column(cara.page, 'Done').getByRole('button', { name: 'Add task' }).click();
    await cara.page.getByLabel('New task title').fill('Written offline');
    await cara.page.keyboard.press('Enter');
    await cara.page.keyboard.press('Escape');
    await inColumn(cara.page, 'Done', 'Written offline').waitFor();
    await cara.page.getByTestId('sync-status').getByText(/waiting/).waitFor({ timeout: 10_000 });
    assert.equal(await card(ben.page, 'Written offline').count(), 0);

    await cara.context.setOffline(false);
    await inColumn(ben.page, 'Done', 'Written offline').waitFor({ timeout: 25_000 });
    await synced(cara.page);
    await ben.page.waitForTimeout(300);
    assert.equal(await card(ben.page, 'Written offline').count(), 1, 'delivered exactly once');
    assert.equal(await card(cara.page, 'Written offline').count(), 1);
  });

  await step('network recovery: survives the server restarting', async () => {
    await node.stop();
    await cara.page.getByTestId('sync-status').getByText(/Reconnecting/).waitFor({ timeout: 5000 });
    await column(cara.page, 'Done').getByRole('button', { name: 'Add task' }).click();
    await cara.page.getByLabel('New task title').fill('Written during outage');
    await cara.page.keyboard.press('Enter');
    await cara.page.keyboard.press('Escape');
    await inColumn(cara.page, 'Done', 'Written during outage').waitFor();
    await cara.page.waitForTimeout(500);

    node = await startNode({ port: apiPort });
    await inColumn(ben.page, 'Done', 'Written during outage').waitFor({ timeout: 25_000 });
    await synced(cara.page);
    await synced(ben.page);
    assert.equal(await card(ben.page, 'Written during outage').count(), 1);
  });

  await step('drag conflict: the loser sees their card return, and is told why', async () => {
    await cara.context.setOffline(true);
    await dragCard(cara.page, 'Written offline', 'Review');
    await inColumn(cara.page, 'Review', 'Written offline').waitFor();

    await dragCard(ben.page, 'Written offline', 'Backlog');
    await inColumn(ben.page, 'Backlog', 'Written offline').waitFor();
    await synced(ben.page);

    await cara.context.setOffline(false);
    await cara.page.getByTestId('toast').filter({ hasText: /Ben Okafor moved/ }).waitFor({ timeout: 25_000 });
    await inColumn(cara.page, 'Backlog', 'Written offline').waitFor({ timeout: 3000 });
    await synced(cara.page);
  });

  await step('columns: drag to reorder, rename, delete and undo, all live', async () => {
    const names = (page) => page.locator('[data-testid=column] .column-name').allTextContents();
    const head = await column(ben.page, 'Done').locator('.column-count').boundingBox();
    const target = await column(ben.page, 'Backlog').locator('.column-count').boundingBox();
    await ben.page.mouse.move(head.x + 20, head.y + 6);
    await ben.page.mouse.down();
    await ben.page.mouse.move(head.x, head.y + 6, { steps: 4 });
    await ben.page.mouse.move(target.x - 60, target.y + 20, { steps: 15 });
    await ben.page.waitForTimeout(150);
    await ben.page.mouse.up();
    await synced(ben.page);
    await cara.page.waitForTimeout(300);
    assert.equal((await names(ben.page))[0], 'Done');
    assert.equal((await names(cara.page))[0], 'Done');

    await column(ben.page, 'Done').getByRole('button', { name: 'Done', exact: true }).click();
    await ben.page.getByLabel('Column name').fill('Finished');
    await ben.page.keyboard.press('Enter');
    await column(cara.page, 'Finished').waitFor({ timeout: 3000 });

    await ben.page.getByRole('button', { name: 'Finished column options' }).click();
    await ben.page.getByRole('button', { name: 'Delete column' }).click();
    await column(cara.page, 'Finished').waitFor({ state: 'detached', timeout: 3000 });
    await ben.page.getByRole('button', { name: 'Undo', exact: true }).click();
    await inColumn(cara.page, 'Finished', 'Order 40 handheld scanners').waitFor({ timeout: 3000 });
    await synced(ben.page);
    assert.equal((await names(cara.page))[0], 'Finished', 'restored to its old place');

    // Columns move by keyboard too, from the grip.
    await ben.page.getByRole('button', { name: 'Move Finished column' }).focus();
    await ben.page.keyboard.press('Space');
    await ben.page.waitForTimeout(100);
    await ben.page.keyboard.press('ArrowRight');
    await ben.page.waitForTimeout(250);
    await ben.page.keyboard.press('Space');
    await synced(ben.page);
    await cara.page.waitForTimeout(300);
    assert.equal((await names(cara.page))[1], 'Finished');
  });

  await step('keyboard: a card can be moved without a mouse', async () => {
    const before = await titlesIn(ben.page, 'Review');
    const slot = ben.page.locator('.card-slot').filter({ hasText: before[0] });
    await slot.focus();
    await ben.page.keyboard.press('Space');
    await ben.page.waitForTimeout(100);
    await ben.page.keyboard.press('ArrowDown');
    await ben.page.waitForTimeout(250);
    await ben.page.keyboard.press('Space');
    await synced(ben.page);
    await cara.page.waitForTimeout(300);
    const after = await titlesIn(cara.page, 'Review');
    assert.notDeepEqual(after, before);
    assert.equal(after[1], before[0]);
  });

  await step('people search: suggests the organization as you type, and only the organization', async () => {
    await ben.page.getByRole('button', { name: 'Settings' }).click();
    const input = ben.page.getByLabel('Email of the person to add');
    const results = ben.page.getByTestId('people-results');

    await input.pressSequentially('d');
    await results.getByRole('option', { name: /Dan Ito/ }).waitFor({ timeout: 3000 });
    await ben.page.screenshot({ path: join(SHOTS, '12-people-search.png') });

    // Already in this branch, so not offered.
    await input.fill('');
    await input.pressSequentially('cara');
    await results.getByText('No one in this organization matches').waitFor({ timeout: 3000 });

    // Another organization: never offered, however exact the text.
    await input.fill('');
    await input.pressSequentially('hank@globex');
    await results.getByText('No one in this organization matches').waitFor({ timeout: 3000 });
    assert.equal(await results.getByRole('option').count(), 0);

    // Keyboard: arrow to the match, Enter fills it in, and Escape doesn't close the dialog.
    await input.fill('');
    await input.pressSequentially('dan');
    await results.getByRole('option', { name: /Dan Ito/ }).waitFor({ timeout: 3000 });
    await ben.page.keyboard.press('ArrowDown');
    await ben.page.keyboard.press('Enter');
    assert.equal(await input.inputValue(), 'dan@acme.test');
    await input.press('Backspace');
    await results.waitFor({ timeout: 3000 });
    await ben.page.keyboard.press('Escape');
    await results.waitFor({ state: 'detached' });
    assert.ok(await input.isVisible(), 'the dialog stays open');

    // Choosing with the mouse, then adding, works end to end.
    await input.fill('');
    await input.pressSequentially('d');
    await results.getByRole('option', { name: /Dan Ito/ }).click();
    await ben.page.getByRole('button', { name: 'Add', exact: true }).click();
    await ben.page.getByRole('button', { name: 'Remove Dan Ito' }).waitFor({ timeout: 3000 });
    await ben.page.getByRole('button', { name: 'Remove Dan Ito' }).click();
    await ben.page.getByRole('button', { name: 'Remove Dan Ito' }).waitFor({ state: 'detached', timeout: 3000 });
    await ben.page.getByRole('button', { name: 'Close', exact: true }).click();
  });

  await step('settings: an admin adds a member, who can then enter the branch', async () => {
    await ben.page.getByRole('button', { name: 'Settings' }).click();
    await ben.page.getByLabel('Email of the person to add').fill('hank@globex.test');
    await ben.page.getByRole('button', { name: 'Add', exact: true }).click();
    await ben.page.getByRole('button', { name: 'Remove Hank Weber' }).waitFor({ timeout: 3000 });
    await ben.page.screenshot({ path: join(SHOTS, '10-settings.png') });
    await ben.page.getByRole('button', { name: 'Remove Hank Weber' }).click();
    await ben.page.getByRole('button', { name: 'Remove Hank Weber' }).waitFor({ state: 'detached', timeout: 3000 });
    await ben.page.getByRole('button', { name: 'Close', exact: true }).click();
  });

  await step('activity log records the story, live', async () => {
    await ben.page.getByRole('button', { name: 'Activity' }).click();
    const activity = ben.page.getByTestId('activity');
    await activity.waitFor();
    const text = await activity.innerText();
    assert.match(text, /Cara Lindqvist added “Written offline”/);
    assert.match(text, /moved/);
    await ben.page.screenshot({ path: join(SHOTS, '06-activity.png') });
    await column(cara.page, 'Finished').getByRole('button', { name: 'Add task' }).click();
    await cara.page.getByLabel('New task title').fill('Logged live');
    await cara.page.keyboard.press('Enter');
    await cara.page.keyboard.press('Escape');
    await activity.getByText('Cara Lindqvist added “Logged live”').waitFor({ timeout: 3000 });
    await ben.page.getByRole('button', { name: 'Close activity' }).click();
  });

  await step('time machine: scrubbing rewinds the board, without touching live state', async () => {
    await ben.page.getByRole('button', { name: 'Time Machine' }).click();
    const machine = ben.page.getByTestId('time-machine');
    await machine.waitFor();
    await machine.getByTestId('tm-count').waitFor();

    const slider = machine.getByLabel("Point in the board's history");
    const total = Number(await slider.getAttribute('max'));
    assert.ok(total > 30, `expected a long history, got ${total}`);
    await machine.getByText('Written offline').waitFor();

    // Early on, the board is only just being built, and later cards don't exist yet.
    await slider.fill('3');
    assert.equal(await machine.getByText('Written offline').count(), 0);
    await machine.getByTestId('tm-caption').getByText(/added/).waitFor();
    assert.ok((await machine.getByTestId('task-card').count()) === 2);
    await ben.page.screenshot({ path: join(SHOTS, '11-time-machine.png') });

    // Moves replay: this seeded card started in Backlog before Ben moved it to Done.
    const history = await ben.page.evaluate(async () => {
      const token = localStorage.getItem('tenant-flow.token');
      const headers = { authorization: `Bearer ${token}` };
      const { organizations } = await (await fetch('/api/organizations', { headers })).json();
      const { tenants } = await (await fetch(`/api/organizations/${organizations[0].id}/tenants`, { headers })).json();
      const tenant = tenants.find((t) => t.name === 'Mumbai');
      const { boards } = await (await fetch(`/api/tenants/${tenant.id}/boards`, { headers })).json();
      const board = boards.find((b) => b.name === 'Warehouse rollout');
      const base = `/api/tenants/${tenant.id}/boards/${board.id}`;
      const snapshot = await (await fetch(base, { headers })).json();
      const events = [];
      let after = 0;
      while (after !== null) {
        const page = await (await fetch(`${base}/history?afterSeq=${after}&limit=500`, { headers })).json();
        events.push(...page.events);
        after = page.nextAfterSeq;
      }
      return { snapshot, events };
    });

    // The core invariant: folding the whole log reproduces the live board exactly.
    const rebuilt = buildFrames(history.events).at(-1);
    const shape = (task) => [task.id, task.columnId, task.position, task.title, task.description, task.priority, task.assigneeId, task.dueDate, task.version].join('|');
    assert.deepEqual(visibleTasks(rebuilt).map(shape).sort(), history.snapshot.tasks.map(shape).sort());
    const columnShape = (c) => [c.id, c.name, c.position, c.version].join('|');
    assert.deepEqual(Object.values(rebuilt.columns).map(columnShape).sort(), history.snapshot.columns.map(columnShape).sort());

    // Replay is read-only: leaving returns to the unchanged live board.
    await machine.getByRole('button', { name: 'Back to live' }).click();
    await ben.page.getByTestId('board').waitFor();
    await card(ben.page, 'Written offline').waitFor();
  });

  await step('tenant isolation: switching branch swaps data and presence', async () => {
    await cara.page.getByRole('button', { name: /^Branch: Mumbai/ }).click();
    await cara.page.getByRole('button', { name: /^Berlin/ }).click();
    await card(cara.page, 'Update EORI records').waitFor();
    assert.equal(await card(cara.page, 'Written offline').count(), 0);

    await ben.page.waitForFunction(() => document.querySelectorAll('[data-testid=presence] .avatar').length === 1, null, { timeout: 3000 });

    await column(ben.page, 'Backlog').getByRole('button', { name: 'Add task' }).click();
    await ben.page.getByLabel('New task title').fill('Mumbai only');
    await ben.page.keyboard.press('Enter');
    await ben.page.keyboard.press('Escape');
    await inColumn(ben.page, 'Backlog', 'Mumbai only').waitFor();
    await cara.page.waitForTimeout(500);
    assert.equal(await card(cara.page, 'Mumbai only').count(), 0);
    assert.ok(!(await cara.page.locator('body').innerText()).includes('Mumbai only'));
  });

  await step('organization isolation: another org sees none of it', async () => {
    const hank = await signIn(browser, baseUrl, 'hank@globex.test');
    await card(hank.page, 'Sign the signage contract').waitFor();
    const text = await hank.page.locator('body').innerText();
    for (const secret of ['Acme', 'Mumbai', 'Warehouse rollout']) assert.ok(!text.includes(secret), secret);
    await hank.context.close();
  });

  await step('removing a member takes effect on their open session', async () => {
    const dan = await signIn(browser, baseUrl, 'dan@acme.test');
    await card(dan.page, 'Update EORI records').waitFor();
    await dan.page.getByRole('button', { name: 'Settings' }).click();
    await dan.page.getByRole('button', { name: 'Remove Cara Lindqvist' }).click();
    await cara.page.getByTestId('toast').filter({ hasText: /no longer have access/ }).waitFor({ timeout: 3000 });
    await card(cara.page, 'Pilot scanning: Cara').waitFor({ timeout: 5000 });
    assert.equal(await card(cara.page, 'Update EORI records').count(), 0);
    await dan.context.close();
  });

  await step('layout: narrow screens and dark mode', async () => {
    const phone = await signIn(browser, baseUrl, 'ben@acme.test', { viewport: { width: 390, height: 780 }, hasTouch: true });
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no horizontal page scroll');
    await phone.page.screenshot({ path: join(SHOTS, '07-phone.png') });
    await card(phone.page, 'Mumbai only').click();
    await phone.page.getByTestId('task-panel').waitFor();
    await phone.page.waitForTimeout(300);
    await phone.page.screenshot({ path: join(SHOTS, '08-phone-panel.png') });
    await phone.context.close();
    const dark = await signIn(browser, baseUrl, 'ben@acme.test', { colorScheme: 'dark' });
    await dark.page.screenshot({ path: join(SHOTS, '09-dark.png') });
    await dark.context.close();
  });

  await step('no uncaught errors in any browser session', async () => {
    assert.deepEqual(pageErrors, []);
  });
} finally {
  await browser.close();
  await node.stop();
  await pool.end();
  await database.stop().catch(() => {});
  await rm(dbDir, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
