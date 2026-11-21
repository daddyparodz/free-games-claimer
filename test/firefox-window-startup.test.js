import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright-firefox';
import { withBrowser } from '../src/browser-lifecycle.js';

const windows = process.platform === 'win32';

for (const [name, engineName, options, expected] of [
  ['viewport dimensions', 'firefox', { headless: false, viewport: { width: 1920, height: 1080 } }, ['-width', '1920', '-height', '1080']],
  ['default dimensions', 'firefox', { headless: false }, ['-width', '1280', '-height', '720']],
  ['existing arguments', 'firefox', { headless: false, args: ['-width', '900', '--height=600', '-private-window'] }, ['-width', '900', '--height=600', '-private-window']],
  ['one explicit dimension', 'firefox', { headless: false, args: ['--width=900'] }, ['--width=900', '-height', '720']],
  ['custom preferences', 'firefox', { headless: false, firefoxUserPrefs: { 'browser.startup.page': 0 } }, ['-width', '1280', '-height', '720']],
  ['explicit occlusion preference', 'firefox', { headless: false, firefoxUserPrefs: { 'widget.windows.window_occlusion_tracking.enabled': true } }, ['-width', '1280', '-height', '720']],
  ['headless unchanged', 'firefox', { headless: true }, undefined],
  ['chromium unchanged', 'chromium', { headless: false }, undefined],
]) {
  test(`persistent browser startup: ${name}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fgc-window-options-'));
    const original = structuredClone(options);
    let actual;
    try {
      await withBrowser({
        name: () => engineName,
        async launchPersistentContext(_profile, launchOptions) {
          actual = launchOptions;
          return { async close() {} };
        },
      }, dir, options, async () => {});
      assert.deepEqual(actual.args, windows ? expected : original.args);
      assert.deepEqual(options, original, 'caller options must not be mutated');
      const headedFirefox = windows && engineName === 'firefox' && original.headless === false;
      assert.deepEqual(actual.firefoxUserPrefs, headedFirefox ? {
        'widget.windows.window_occlusion_tracking.enabled': false,
        ...original.firefoxUserPrefs,
      } : original.firefoxUserPrefs);
      for (const [key, value] of Object.entries(original)) {
        if (key !== 'args' && key !== 'firefoxUserPrefs') assert.deepEqual(actual[key], value);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('headed Firefox opens a persistent profile with saved window geometry', {
  skip: !windows || process.env.FGC_TEST_HEADED !== '1',
  timeout: 60000,
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fgc-window-geometry-'));
  try {
    await writeFile(path.join(dir, 'xulstore.json'), JSON.stringify({
      'chrome://browser/content/browser.xhtml': {
        'main-window': { width: '1280', height: '805', screenX: '0', screenY: '0', sizemode: 'normal' },
      },
    }));
    await withBrowser(firefox, dir, { headless: false, timeout: 10000 }, async context => {
      assert.ok(context.pages().length > 0);
      assert.equal(context.pages()[0].url(), 'about:blank');
      const page = context.pages()[0];
      await page.setContent('<button onclick="this.textContent = \'clicked\'">ready</button>');
      await page.getByRole('button', { name: 'ready' }).click({ timeout: 5000 });
      assert.equal(await page.locator('button').innerText(), 'clicked');
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 500 });
  }
});
