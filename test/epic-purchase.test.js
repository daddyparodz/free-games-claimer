import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'patchright';

let browser;
let page;
let waitForPurchaseButton;
let waitForEpicCheckout;
test('finds current Checkout iframe outside the removed purchase container after manual CAPTCHA completion', async () => {
  await page.setContent('<div id="h_captcha_challenge_egs_quick_purchase_prod"><iframe title="hCaptcha challenge"></iframe></div>');
  await page.evaluate(() => setTimeout(() => {
    document.querySelector('#h_captcha_challenge_egs_quick_purchase_prod').remove();
    document.body.insertAdjacentHTML('beforeend', '<iframe title="Checkout" src="/checkout"></iframe>');
  }, 150));
  const { waitForEpicCheckout } = await import('../src/epic-purchase.js');
  assert.ok(await waitForEpicCheckout(page, 1000));
});

test('refuses checkout unless every displayed monetary amount is zero', async () => {
  const { verifyEpicZeroTotal } = await import('../src/epic-purchase.js');
  for (const text of ['Checkout Bad Cheese €0.00 This is free. Add to library', 'Order Total $0.00']) {
    await page.setContent(`<main>${text}</main>`);
    assert.equal(await verifyEpicZeroTotal(page), true);
  }
  for (const text of ['Checkout Add to library', 'Total €9.99', 'Subtotal €0.00 Total €1.00']) {
    await page.setContent(`<main>${text}</main>`);
    await assert.rejects(verifyEpicZeroTotal(page), /zero/);
  }
});

test('waits for user-completed CAPTCHA without interacting with the challenge', async () => {
 const { waitForEpicManualChallenge } = await import('../src/epic-purchase.js');
 await page.setContent('<iframe title="hCaptcha challenge"></iframe>');
 let notified=0;
 await waitForEpicManualChallenge(page,1000,async()=>{
   notified++;
   await page.locator('iframe[title="hCaptcha challenge"]').evaluate(frame => frame.remove());
 });
 assert.equal(notified,1);
});

test('claim records require fresh independent library readback', async () => {
 const source=await readFile(new URL('../epic-games.js',import.meta.url),'utf8');
 assert.ok(source.replace(/\r\n/g,'\n').replace(/\n[ \t]*/g, '\n').includes("await page.goto(url);\nawait page.getByRole('button', { name: /^In Library$/i }).waitFor"));
});

test('allows a transient Epic SSO redirect to settle into checkout', async () => {
  await page.route('https://www.epicgames.com/id/redirect**', route => route.fulfill({ body: '<script>setTimeout(() => { document.body.innerHTML = \'<div id="webPurchaseContainer"><iframe></iframe></div>\'; history.replaceState(null, "", "/purchase"); }, 150)</script>' }));
  await page.goto('https://www.epicgames.com/id/redirect');
  const { waitForEpicCheckout } = await import('../src/epic-purchase.js');
  assert.ok(await waitForEpicCheckout(page, 1000));
});
test('reports checkout sign-in redirect instead of timing out on missing iframe', async () => {
  await page.route('https://www.epicgames.com/id/login**', route => route.fulfill({ body: '<h1>Sign in to Epic Games</h1>' }));
  await page.goto('https://www.epicgames.com/id/login');
  const helper = await import('../src/epic-purchase.js');
  waitForEpicCheckout = helper.waitForEpicCheckout;
  assert.equal(typeof waitForEpicCheckout, 'function');
  await assert.rejects(waitForEpicCheckout(page, 500), /Complete Epic sign-in in the browser/);
});
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(500);
  // Exercise the current production implementation without starting the claimer.
  const source = await readFile(new URL('../epic-games.js', import.meta.url), 'utf8');
  ({ waitForPurchaseButton } = await import('../src/epic-purchase.js'));
  assert.match(source, /import \{[^}]*waitForPurchaseButton[^}]*\} from '\.\/src\/epic-purchase.js'/);
});
after(async () => {
  await browser?.close();
});

for (const state of ['In Library', 'Requires Base Game', 'Buy Now', 'Pre-Purchase', 'Coming Soon', 'Unavailable', 'Not Available']) {
  test(`recognizes ${state} even when disabled`, async () => {
    await page.setContent(`<button>Add to Cart</button><button disabled>${state}</button>`);
    assert.equal(await (await waitForPurchaseButton(page)).innerText(), state);
  });
}

test('waits through Loading until the CTA hydrates', async () => {
  await page.setContent('<button disabled>Loading</button>');
  await page.evaluate(() => {
    setTimeout(() => {
      // eslint-disable-next-line no-undef
      document.querySelector('button').textContent = 'Get';
    }, 100);
  });
  assert.equal(await (await waitForPurchaseButton(page)).innerText(), 'Get');
});

test('does not accept secondary cart controls or partial names', async () => {
  await page.setContent('<button>Add to Cart</button><button>Get Help</button>');
  await assert.rejects(waitForPurchaseButton(page), /Timeout/);
});

test('bundle title extraction no longer depends on the removed purchase test id', async () => {
  const source = await readFile(new URL('../epic-games.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /purchase-cta-button/);
});

test('finds the visible semantic Get CTA without a test id, not DLC Add to Cart', async () => {
  await page.setContent('<button style="display:none">Get</button><button>Add to Cart</button><button class="_sidebarBuyButton_96vuv_33"><span>Get</span></button>');
  const button = await waitForPurchaseButton(page);
  assert.equal(await button.innerText(), 'Get');
  assert.equal(await button.isVisible(), true);
});
