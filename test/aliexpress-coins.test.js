/* global document */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firefox } from 'playwright-firefox';
import { readCoinState, collectDailyCoins } from '../src/aliexpress-coins.js';

test('recognizes the checked Today card separately from the Tomorrow reward', async () => {
  const browser = await firefox.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div>63<br>days streak</div><div id="sign-rewards-list"><div id="sign-other-card">Today<br>✓<br>+40</div><div id="sign-main-card">Tomorrow<br>40<br>Worth 0.37</div></div>',
    );
    assert.deepEqual(await readCoinState(page), {
      status: 'claimed',
      today: 'Today ✓ +40',
      tomorrow: 'Tomorrow 40 Worth 0.37',
      streak: '63 days streak',
    });
  } finally {
    await browser.close();
  }
});

const claimed =
  '<div>63 days streak</div><div id="sign-rewards-list"><div>Today<br>✓<br>+40</div><div id="sign-main-card">Tomorrow<br>40</div></div>';
async function withFixture(html, run) {
  const browser = await firefox.launch();
  try {
    const page = await browser.newPage();
    let navigations = 0;
    await page.route('**/*', route =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: navigations++ ? claimed : html }),
    );
    await page.goto('https://fixture.invalid/coins');
    await run(page);
  } finally {
    await browser.close();
  }
}

test('fresh navigation verifies an already checked daily reward without clicking', () =>
  withFixture(claimed, async page => {
    const result = await collectDailyCoins(page, { timeout: 1000 });
    assert.equal(result.status, 'already-claimed');
    assert.equal(result.today, 'Today ✓ +40');
  }));

test('waits for a delayed daily card then clicks only its Collect control once', () =>
  withFixture('<div id="root"></div><button onclick="throw Error(\'unrelated\')">Collect</button>', async page => {
    let clicks = 0;
    await page.exposeFunction('recordClick', () => {
      clicks++;
    });
    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector('#root').innerHTML =
          '<div id="sign-rewards-list"><div id="sign-main-card">Today 40 coins</div></div><button id="signButton">Collect</button>';
        document.querySelector('#signButton').onclick = () => {
          globalThis.recordClick();
          setTimeout(() => {
            document.querySelector('#sign-rewards-list').innerHTML =
              '<div>Today<br>✓<br>+40</div><div>Tomorrow<br>40</div>';
          }, 50);
        };
      }, 50);
    });
    const result = await collectDailyCoins(page, { timeout: 1000 });
    assert.equal(result.status, 'claimed');
    assert.equal(clicks, 1);
  }));

for (const [name, html] of [
  [
    'disabled control',
    '<div id="sign-rewards-list"><div>Today 40 coins</div></div><button id="signButton" disabled>Collect</button>',
  ],
  ['unrelated collect', '<button>Collect</button>'],
  ['tomorrow alone', '<div id="sign-rewards-list"><div>Tomorrow 40</div></div>'],
  ['unchecked today', '<div id="sign-rewards-list"><div>Today 40</div><div>Tomorrow 40</div></div>'],
]) {
  test(`does not report success for ${name}`, () =>
    withFixture(html, async page => {
      await assert.rejects(collectDailyCoins(page, { timeout: 100 }), /unrecognized/);
    }));
}

test('security challenge takes priority over stale checked cards', () =>
  withFixture(claimed + '<div role="dialog">Please complete the security verification</div>', async page => {
    await assert.rejects(collectDailyCoins(page, { timeout: 100 }), /security|challenge/i);
  }));

test('does not retry a click whose success is uncertain', () =>
  withFixture(
    '<div id="sign-rewards-list"><div>Today 40 coins</div></div><button id="signButton">Collect</button>',
    async page => {
      let clicks = 0;
      await page.exposeFunction('recordClick', () => {
        clicks++;
      });
      await page.locator('#signButton').evaluate(button => {
        button.onclick = () => globalThis.recordClick();
      });
      await assert.rejects(collectDailyCoins(page, { timeout: 1000 }), /not confirmed/);
      assert.equal(clicks, 1);
    },
  ));

test('dry run leaves the daily control untouched', () =>
  withFixture(
    '<div id="sign-rewards-list"><div>Today 40 coins</div></div><button id="signButton">Collect</button>',
    async page => {
      const result = await collectDailyCoins(page, { timeout: 100, dryrun: true });
      assert.equal(result.status, 'dryrun');
      assert.equal(await page.locator('#signButton').count(), 1);
    },
  ));
