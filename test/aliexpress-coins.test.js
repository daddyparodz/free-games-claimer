import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firefox } from 'playwright-firefox';
import { readCoinState, collectDailyCoins, collectAliExpressCoins } from '../src/aliexpress-coins.js';

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

test('recognizes an available Italian mobile reward without confusing it with tomorrow', () =>
  withFixture(
    '<div>3 giorni di sequenza</div><div id="sign-rewards-list"><div>Oggi 20 monete</div></div><button id="signButton">Raccogli</button>',
    async page => {
      const state = await readCoinState(page);
      assert.equal(state.status, 'collectable');
      assert.equal(state.streak, '3 giorni di sequenza');
    },
  ));

test('recognizes Italian mobile check-in cards without claiming again', () =>
  withFixture('<div id="sign-rewards-list"><div>Oggi ✓ +20</div><div>Domani 25</div></div>', async page => {
    assert.equal((await readCoinState(page)).status, 'claimed');
  }));

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
        globalThis.document.querySelector('#root').innerHTML =
          '<div id="sign-rewards-list"><div id="sign-main-card">Today 40 coins</div></div><button id="signButton">Collect</button>';
        globalThis.document.querySelector('#signButton').onclick = () => {
          globalThis.recordClick();
          setTimeout(() => {
            globalThis.document.querySelector('#sign-rewards-list').innerHTML =
              '<div>Today<br>✓<br>+40</div><div>Tomorrow<br>40</div>';
          }, 50);
        };
      }, 50);
    });
    const result = await collectDailyCoins(page, { timeout: 1000 });
    assert.equal(result.status, 'claimed');
    assert.equal(clicks, 1);
  }));

// Captured 2026-11-06 from the official mobile Double11 check-in control.
// Its parent pulses forever; Playwright's normal click never becomes stable.
const animatedCheckIn = `
<style>
@keyframes aecoin-scale-animation-3dUI9 {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(0.9); }
}
#signButton { width: 124px; height: 41px; }
.aecoin-checkInBox-3gGck {
  width: 140px;
  animation: aecoin-scale-animation-3dUI9 1s cubic-bezier(.36,0,.63,1) infinite;
}
</style>
<div id="sign-rewards-list"><div id="sign-main-card">Oggi 30 Valore 0,27€</div></div>
<div class="aecoin-checkInBox-3gGck"><button id="signButton">Raccogli</button></div>`;

test('clicks the captured endlessly pulsing mobile check-in once with normal actionability', () =>
  withFixture('<div id="root"></div>', async page => {
    let clicks = 0;
    await page.exposeFunction('recordClick', () => clicks++);
    await page.evaluate(html => {
      setTimeout(() => {
        globalThis.document.querySelector('#root').innerHTML = html;
        // Fix the phase at each frame so this captured pulse cannot happen to
        // pass Playwright's stability check near a scale turning point.
        const animation = globalThis.document.querySelector('.aecoin-checkInBox-3gGck').getAnimations()[0];
        let frame = 0;
        const advance = () => {
          if (animation.playState !== 'running') return;
          animation.currentTime = frame++ % 2 ? 0 : 500;
          globalThis.requestAnimationFrame(advance);
        };
        globalThis.requestAnimationFrame(advance);
        globalThis.document.querySelector('#signButton').onclick = event => {
          if (!event.isTrusted) throw new Error('Claim must use a real pointer action.');
          globalThis.recordClick();
          globalThis.document.querySelector('#sign-rewards-list').innerHTML =
            '<div>Oggi ✓ +30</div><div>Domani 40</div>';
        };
      }, 50);
    }, animatedCheckIn);
    const result = await collectDailyCoins(page, { timeout: 1500 });
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

test('daily-only mode never enters optional coin missions', () =>
  withFixture(claimed, async page => {
    // A mission inventory access would mean the daily-only boundary was crossed.
    const locator = page.locator.bind(page);
    page.locator = selector => {
      assert.notEqual(selector, '.e2e_normal_task', 'optional missions must not run');
      return locator(selector);
    };
    const result = await collectAliExpressCoins(page, { timeout: 1000, dailyOnly: true });
    assert.equal(result.daily.status, 'already-claimed');
    assert.deepEqual(result.tasks, []);
  }));

test('dry run leaves the daily control untouched', () =>
  withFixture(
    '<div id="sign-rewards-list"><div>Today 40 coins</div></div><button id="signButton">Collect</button>',
    async page => {
      const result = await collectDailyCoins(page, { timeout: 100, dryrun: true });
      assert.equal(result.status, 'dryrun');
      assert.equal(await page.locator('#signButton').count(), 1);
    },
  ));
