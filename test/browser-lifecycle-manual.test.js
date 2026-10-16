import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'patchright';
import { firefox } from 'playwright-firefox';
import { withBrowser, stopBrowser } from '../src/browser-lifecycle.js';

for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
  test(`${name}: manual browser in the configured profile survives stale cleanup and relaunch`, { timeout: 60000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fgc-manual-browser-'));
    let stale;
    let manual;
    try {
      await withBrowser(engine, dir, { headless: true }, async () => {
        stale = await readFile(path.join(dir, '.fgc-session.json'), 'utf8');
      });
      // Not registered with the lifecycle manager: represents a user-opened browser.
      manual = await engine.launchPersistentContext(dir, { headless: true });
      const page = manual.pages()[0] || await manual.newPage();
      await page.goto('about:blank');
      await writeFile(path.join(dir, '.fgc-session.json'), stale);
      assert.equal(await stopBrowser(dir), false, 'stale registration must not authorize closing a manual browser');
      assert.equal(await page.evaluate(() => 17), 17);
      let entered = false;
      await assert.rejects(withBrowser(engine, dir, { headless: true, timeout: 3000 }, async () => {
        entered = true;
      }));
      assert.equal(entered, false, 'profile conflict must fail closed');
      assert.equal(await page.evaluate(() => 23), 23, 'manual browser must still be alive');
      assert.equal(await stopBrowser(dir), false);
      assert.equal(await page.evaluate(() => 31), 31);
    } finally {
      // Only the test's own manually-created instance, never system browsers.
      await manual?.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
}
