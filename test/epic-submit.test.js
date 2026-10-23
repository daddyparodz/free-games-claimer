import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'patchright';
import * as epic from '../src/epic-purchase.js';

test('actual automation clicks Add to library then delayed EU I accept and verifies success', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe title="Checkout"></iframe>');
    const frame = page.frames()[1];
    await frame.setContent('<p>Bad Cheese €0.00</p><button>Add to library</button>');
    await frame.evaluate(() => {
      document.querySelector('button').onclick = () =>
        setTimeout(() => {
          const accept = document.createElement('button');
          accept.textContent = 'I accept';
          accept.onclick = () => {
            document.body.innerHTML = 'Thanks for your order!';
          };
          document.body.append(accept);
        }, 100);
    });
    const result = await epic.submitEpicFreeOrder(page, page.frameLocator('iframe'), {
      timeout: 2000,
      manualTimeout: 1000,
    });
    assert.equal(result, 'order-confirmation');
  } finally {
    await browser.close();
  }
});

test('automation resumes after human CAPTCHA completion before Add to library', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe title="hCaptcha challenge"></iframe><iframe title="Checkout"></iframe>');
    await page
      .frames()[2]
      .setContent(
        '<p>€0.00</p><button onclick="document.body.innerHTML=\'Thanks for your order!\'">Add to library</button>',
      );
    await page.evaluate(() =>
      setTimeout(() => document.querySelector('iframe[title="hCaptcha challenge"]').remove(), 150),
    );
    assert.equal(
      await epic.submitEpicFreeOrder(page, page.frameLocator('iframe[title="Checkout"]'), {
        timeout: 2000,
        manualTimeout: 1000,
      }),
      'order-confirmation',
    );
  } finally {
    await browser.close();
  }
});
