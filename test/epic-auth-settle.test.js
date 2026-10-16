import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'patchright';
import { waitForEpicCheckout } from '../src/epic-purchase.js';

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

test('checkout waits for a transient /id/login hop instead of immediately rejecting the saved session', async () => {
  const page = await browser.newPage();
  try {
    await page.route('https://www.epicgames.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<h1>Signing in</h1><script>setTimeout(() => { history.replaceState(null, "", "/purchase"); document.body.innerHTML = \'<div id="webPurchaseContainer"><iframe></iframe></div>\'; }, 250)</script>',
    }));
    await page.goto('https://www.epicgames.com/id/login');
    assert.ok(await waitForEpicCheckout(page, 1500));
  } finally {
    await page.close();
  }
});

test('checkout does not return an outer checkout iframe while its embedded auth remains signed out', async () => {
  const page = await browser.newPage();
  try {
    await page.route('https://www.epicgames.com/id/login', route => route.fulfill({
      contentType: 'text/html', body: '<h1>Sign in to Epic Games</h1><input type="password">',
    }));
    await page.setContent('<div id="webPurchaseContainer"><iframe src="https://www.epicgames.com/id/login"></iframe></div>');
    const started = Date.now();
    await assert.rejects(waitForEpicCheckout(page, 500), /Epic checkout redirected to Epic login/);
    assert.ok(Date.now() - started >= 450, 'must allow the bounded auth settle interval');
  } finally {
    await page.close();
  }
});
