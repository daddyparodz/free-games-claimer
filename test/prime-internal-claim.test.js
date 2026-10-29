import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { firefox } from 'playwright-firefox';
import * as state from '../src/page-state.js';

// Exercise the CLI's actual function without starting other providers or loading credentials.
const source = await readFile(new URL('../prime-gaming.js', import.meta.url), 'utf8');
const body = source.match(/const claimInternalOffer = ([\s\S]*?);\r?\n\r?\nconst isAccountLinkingRequired/)[1];
const names = [...Object.keys(state), 'cfg', 'throwIfPrimeErrorPage'];
const claim = new Function(...names, `return ${body}`)(...Object.values(state), { timeout: 1000 }, async () => {});
let browser;
let page;
before(async () => {
  browser = await firefox.launch({ headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(1000);
});
after(async () => {
  await browser?.close();
});

const offer = async (html, hydration) => {
  await page.route('https://prime.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: `<main id="offer">${html}</main><script>setTimeout(() => { ${hydration} }, 500)</script>`,
  }));
};

test('Kiborg claim waits for the buy box to hydrate before deciding no action exists', async () => {
  await offer('', `
    document.querySelector('#offer').innerHTML = '<button data-a-target="buy-box_call-to-action">Get game</button>';
    document.querySelector('button').onclick = () => {
      document.querySelector('#offer').innerHTML = '<p>Sent to your Amazon Games library</p>';
    };
  `);
  assert.equal(await claim(page, 'https://prime.test/kiborg'), 'claimed');
  assert.equal(await state.isPrimeInternalClaimSuccess(page), true);
  await page.unrouteAll();
});

test('hydrated ownership is read back without clicking a claim', async () => {
  await offer('', 'document.querySelector(\'#offer\').innerHTML = \'<p>You collected this on October 29, 2026</p>\'');
  assert.equal(await claim(page, 'https://prime.test/kiborg-owned'), 'existed');
  await page.unrouteAll();
});

test('a hydrated action without a confirmation is not a successful claim', async () => {
  await offer('<button data-a-target="buy-box_call-to-action">Get game</button>', '');
  assert.equal(await claim(page, 'https://prime.test/kiborg-unconfirmed'), 'failed');
  await page.unrouteAll();
});
