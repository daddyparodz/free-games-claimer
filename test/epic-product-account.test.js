import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'patchright';
import { readFile } from 'node:fs/promises';
import * as purchase from '../src/epic-purchase.js';

test('claim runner verifies the product identity before reading ownership or writing the account database', async () => {
  const source = await readFile(new URL('../epic-games.js', import.meta.url), 'utf8');
  const loop = source.slice(source.indexOf('for (const url of urls)'));
  const auth = loop.indexOf('await ensureEpicProductAccount(page, { displayName: user, loginTimeout: cfg.login_timeout });');
  assert.ok(auth >= 0, 'runner must call the product account guard');
  assert.ok(auth < loop.indexOf('await waitForPurchaseButton(page)'));
  assert.ok(auth < loop.indexOf('db.data[user][game_id]'));
});

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

for (const scenario of [
  { name: 'valid existing product account does not start login', body: { id: 'account-1', displayName: 'FixtureUser' } },
  { name: 'HTTP 200 without identity is not authenticated', body: { authenticated: true }, error: /did not contain an authenticated identity/ },
  { name: 'another product account must not receive the listing account claims', body: { id: 'account-2', displayName: 'OtherUser' }, error: /differs from the listing account/ },
]) {
  test(scenario.name, async () => {
    const page = await browser.newPage();
    let loginVisits = 0;
    try {
      await page.route('https://store.epicgames.com/**', route => new URL(route.request().url()).pathname === '/proxy/api/account'
        ? route.fulfill({ json: scenario.body })
        : route.fulfill({ contentType: 'text/html', body: '<button>In Library</button>' }));
      await page.route('https://www.epicgames.com/**', route => {
        loginVisits++; return route.abort();
      });
      await page.goto('https://store.epicgames.com/p/fixture');
      const result = purchase.ensureEpicProductAccount(page, { displayName: 'FixtureUser', loginTimeout: 500 });
      if (scenario.error) await assert.rejects(result, scenario.error);
      else assert.deepEqual(await result, scenario.body);
      assert.equal(loginVisits, 0);
    } finally {
      await page.close();
    }
  });
}

test('uncompleted Epic MFA is preserved and never classified as an authenticated product', async () => {
  const page = await browser.newPage();
  try {
    await page.route('https://store.epicgames.com/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/proxy/api/account') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
      if (path === '/login') return route.fulfill({ contentType: 'text/html', body: '<script>location.href="https://www.epicgames.com/id/login/mfa"</script>' });
      return route.fulfill({ contentType: 'text/html', body: '<egs-navigation signinlinkhref="/login?state=fixture"></egs-navigation><button>Get</button>' });
    });
    await page.route('https://www.epicgames.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Enter security code</h1><input name="code">' }));
    await page.goto('https://store.epicgames.com/p/fixture');
    await assert.rejects(purchase.ensureEpicProductAccount(page, { displayName: 'FixtureUser', loginTimeout: 300 }), /sign-in or MFA/);
    assert.equal(await page.locator('h1').innerText(), 'Enter security code');
    assert.equal(await page.locator('input').inputValue(), '');
  } finally {
    await page.close();
  }
});

test('listing identity cannot authenticate product; resume the product session before returning its identity', async () => {
  const page = await browser.newPage();
  let authenticated = false;
  let loginVisits = 0;
  const product = 'https://store.epicgames.com/p/fixture';
  try {
    await page.route('https://store.epicgames.com/**', route => {
      if (new URL(route.request().url()).pathname === '/proxy/api/account') {
        return route.fulfill({ status: authenticated ? 200 : 401, json: authenticated ? { id: 'account-1', displayName: 'FixtureUser' } : { error: 'unauthorized' } });
      }
      if (new URL(route.request().url()).pathname === '/login') {
        return route.fulfill({ contentType: 'text/html', body: `<script>location.href = 'https://www.epicgames.com/id/login?redirect_uri=${encodeURIComponent(product)}'</script>` });
      }
      return route.fulfill({ contentType: 'text/html', body: '<egs-navigation isloggedin="true" displayname="FixtureUser" signinlinkhref="/login?state=fixture"></egs-navigation><button>Get</button>' });
    });
    await page.route('https://www.epicgames.com/id/login**', route => {
      loginVisits++;
      authenticated = true;
      assert.equal(new URL(route.request().url()).searchParams.get('redirect_uri'), product);
      return route.fulfill({ contentType: 'text/html', body: `<script>setTimeout(() => location.href = ${JSON.stringify(product)}, 50)</script>` });
    });
    await page.goto(product);
    assert.equal(typeof purchase.ensureEpicProductAccount, 'function', 'product account boundary must be implemented');
    const account = await purchase.ensureEpicProductAccount(page, { displayName: 'FixtureUser', loginTimeout: 2000 });
    assert.equal(account.id, 'account-1');
    assert.equal(loginVisits, 1);
    assert.equal(page.url(), product);
  } finally {
    await page.close();
  }
});
