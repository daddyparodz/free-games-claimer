import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { firefox } from 'playwright-firefox';
import {
  getGogSession,
  isPrimeInternalClaimSuccess,
  waitForEpicClaimSuccess,
  waitForGogSession,
  waitForPrimeInternalClaimSuccess,
} from '../src/page-state.js';

let browser;
let page;

before(async () => {
  browser = await firefox.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

for (const [name, html, expected] of [
  ['classic confirmation', '<p>Thanks for your order!</p>', 'order-confirmation'],
  ['library button', '<button data-testid="purchase-cta-button">In Library</button>', 'in-library'],
  ['semantic library button', '<button><span>In Library</span></button>', 'in-library'],
  ['launcher prompt', '<div>Is Epic Games Launcher installed?</div>', 'launcher-prompt'],
]) {
  test(`recognizes Epic ${name} as success`, async () => {
    await page.setContent(html);
    assert.equal(await waitForEpicClaimSuccess(page, 10_000), expected);
  });
}

test('Epic timeout reports a descriptive error instead of AggregateError', async () => {
  await page.setContent('<p>Checkout is still loading</p>');
  await assert.rejects(waitForEpicClaimSuccess(page, 25), /Epic did not show a successful claim state within/);
});

test('recognizes a hydrated Prime internal claim confirmation', async () => {
  await page.setContent('<p>Success, Havendock will be available to play from your Amazon Games library.</p>');
  assert.equal(await isPrimeInternalClaimSuccess(page), true);
  assert.equal(await waitForPrimeInternalClaimSuccess(page, 25), true);
});

test('waits for Prime internal claim confirmation to hydrate', async () => {
  await page.setContent('<main>Loading</main>');
  setTimeout(() => page.setContent('<p>Sent to your Amazon Games library</p>'), 25);
  assert.equal(await waitForPrimeInternalClaimSuccess(page, 500), true);
});

const response = (data, status = 200) => ({
  json: async () => data,
  ok: () => status >= 200 && status < 300,
  status: () => status,
});

test('reads explicit GOG session state', async () => {
  const context = { request: { get: async () => response({ isLoggedIn: true, username: 'Davide' }) } };
  assert.deepEqual(await getGogSession(context), { isLoggedIn: true, username: 'Davide' });
});

test('polls until GOG reports the user signed in', async () => {
  let attempts = 0;
  const context = { request: { get: async () => response({ isLoggedIn: ++attempts >= 3, username: 'Davide' }) } };
  assert.deepEqual(await waitForGogSession(context, 1000, 1), { isLoggedIn: true, username: 'Davide' });
  assert.equal(attempts, 3);
});

test('GOG timeout reports a descriptive error instead of AggregateError', async () => {
  const context = { request: { get: async () => response({ isLoggedIn: false }) } };
  await assert.rejects(waitForGogSession(context, 25, 1), /GOG did not report a signed-in session within/);
});
