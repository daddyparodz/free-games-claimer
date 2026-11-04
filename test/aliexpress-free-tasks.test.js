import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firefox } from 'playwright-firefox';
import * as coins from '../src/aliexpress-coins.js';

const row = (title, button = 'Vai', extra = '') => `<div class="e2e_normal_task"><div class="e2e_normal_task_content_title">${title}</div><div class="e2e_normal_task_right" data-groupid="1"><div class="e2e_normal_task_right_btn">${button}</div>${extra}</div></div>`;
async function fixture(html, run) {
  const browser = await firefox.launch();
  try {
    const page = await browser.newPage();
    let done = false;
    await page.context().exposeFunction('completeTask', () => {
      done = true;
    });
    const daily = '<div id="sign-rewards-list"><div>Oggi ✓ +20</div><div>Domani 25</div></div>';
    await page.context().route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: done ? daily : (/Install App/.test(html) ? html : daily + html) }));
    await page.goto('https://m.it.aliexpress.com/p/coin-index/index.html?allowPromotion=1');
    await run(page);
  } finally {
    await browser.close();
  }
}

for (const known of [true, false]) {
  test(`coin quiz ${known ? 'answers only the verified complete question' : 'skips an unverified question without guessing'}`, () =>
    fixture(row('Partecipa al quiz sulle monete'), async page => {
      const question = known ? 'Quali affermazioni sulle monete sono corrette?' : 'Una domanda sconosciuta?';
      await page.context().route('**/coinquest.html', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div>Q : ${question}</div><div>Le monete possono essere usate alla cassa per risparmiare di più</div><div>Le monete possono essere combinate con altri sconti</div><div>Visita ogni giorno il canale monete per ottenere monete gratis</div><button onclick="completeTask(); this.outerHTML='<div>Risposta corretta: Tutte le risposte sono corrette</div>'">Tutte le risposte sono corrette</button>` }));
      await page.locator('.e2e_normal_task_right_btn').evaluate(button => {
        button.onclick = () => globalThis.open('/p/coin-index/coinquest.html');
      });
      const result = await coins.collectFreeCoinTasks(page); // Use the production budget for real popup/navigation work.
      assert.equal(result[0].status, known ? 'completed' : 'skipped');
      if (!known) assert.equal(result[0].reason, 'unverified-quiz');
      assert.equal(page.context().pages().length, 1);
    }));
}

test('every daily execution includes free missions even when check-in was already collected', () =>
  fixture(row('Scopri gli articoli sponsorizzati'), async page => {
    assert.equal(typeof coins.collectAliExpressCoins, 'function');
    const result = await coins.collectAliExpressCoins(page, { timeout: 3000 });
    assert.equal(result.daily.status, 'already-claimed');
    assert.equal(result.tasks[0].reason, 'advertising');
  }));

test('dry run, completed controls and cancellation perform no free mission actions', () =>
  fixture(row('Check-in giornaliero') + row('Sfoglia articoli visti di recente', 'Completato'), async page => {
    let clicks = 0;
    await page.exposeFunction('recordUnsafe', () => {
      clicks++;
    });
    await page.locator('.e2e_normal_task_right_btn').evaluateAll(buttons => buttons.forEach(button => {
      button.onclick = () => globalThis.recordUnsafe();
    }));
    const result = await coins.collectFreeCoinTasks(page, { timeout: 2000, dryrun: true });
    assert.deepEqual(result.map(r => r.status), ['dryrun', 'already-completed']);
    const controller = new AbortController();
    controller.abort(new Error('test cancellation'));
    await assert.rejects(coins.collectFreeCoinTasks(page, { signal: controller.signal }), /test cancellation/);
    assert.equal(clicks, 0);
  }));

test('disabled or unknown mission controls are not mistaken for completed rewards', () =>
  fixture(row('Check-in giornaliero', 'Vai') + row('Sfoglia articoli visti di recente', 'Unknown'), async page => {
    await page.locator('.e2e_normal_task_right_btn').first().evaluate(button => button.setAttribute('aria-disabled', 'true'));
    const result = await coins.collectFreeCoinTasks(page, { timeout: 500 });
    assert.deepEqual(result.map(r => r.status), ['skipped', 'skipped']);
    assert.deepEqual(result.map(r => r.reason), ['unavailable-control', 'unavailable-control']);
  }));

test('a misleading safe title cannot enable sponsored or spending controls', () =>
  fixture(row('Sfoglia articoli visti di recente', 'Vai', '<div>Sponsored products</div>') + row('Check-in giornaliero', 'Vai', '<div>Spend coins</div>'), async page => {
    let clicks = 0;
    await page.exposeFunction('recordUnsafe', () => {
      clicks++;
    });
    await page.locator('.e2e_normal_task_right_btn').evaluateAll(buttons => buttons.forEach(button => {
      button.onclick = () => globalThis.recordUnsafe();
    }));
    const result = await coins.collectFreeCoinTasks(page, { timeout: 3000 });
    assert.equal(clicks, 0);
    assert.equal(result[0].reason, 'advertising');
    assert.equal(result[1].reason, 'unsafe-task');
  }));

test('uncertain mission completion is not retried', () =>
  fixture(row('Check-in giornaliero'), async page => {
    let clicks = 0;
    await page.exposeFunction('recordOnce', () => {
      clicks++;
    });
    await page.locator('.e2e_normal_task_right_btn').evaluate(button => {
      button.onclick = () => globalThis.recordOnce();
    });
    const result = await coins.collectFreeCoinTasks(page, { timeout: 2000 });
    assert.equal(result[0].status, 'unconfirmed');
    assert.equal(clicks, 1);
  }));

test('matured order coins claim never confirms delivery or spends boost', () =>
  fixture('<section><div>Dalla realizzazione di ordini</div><div>+220 monete</div><button>Richiedi</button></section><button>Confirm delivery</button><button>Use boost</button>', async page => {
    let clicks = 0;
    await page.exposeFunction('claimedOrder', () => {
      clicks++;
    });
    await page.getByText('Richiedi', { exact: true }).evaluate(button => {
      button.onclick = () => {
        globalThis.claimedOrder(); globalThis.completeTask();
      };
    });
    const result = await coins.collectFreeCoinTasks(page, { timeout: 2000 });
    assert.equal(result[0].task, 'order-coins');
    assert.equal(result[0].status, 'completed');
    assert.equal(clicks, 1);
  }));

test('super discounts visits its destination and waits the real viewing interval', () =>
  fixture(row('Visualizza i Super sconti'), async page => {
    await page.locator('.e2e_normal_task_right_btn').evaluate(button => {
      button.onclick = () => {
        globalThis.open('/p/coin-index/hotsale.html'); globalThis.completeTask();
      };
    });
    const start = Date.now();
    const result = await coins.collectFreeCoinTasks(page, { timeout: 22000 });
    assert.equal(result[0].status, 'completed');
    assert.ok(Date.now() - start >= 15000);
    assert.equal(page.context().pages().length, 1);
  }));

test('app-only tasks and unsafe missions never click, including sponsored and surprise products', () =>
  fixture(['Scopri gli articoli sponsorizzati', 'Sfoglia articoli sorpresa', 'Annaffia e vinci 0,10 $', 'Usa il boost', 'Acquista ora', 'Cerca ciò che ami'].map(t => row(t)).join(''), async page => {
    let clicks = 0;
    await page.exposeFunction('unsafeClick', () => {
      clicks++;
    });
    await page.locator('.e2e_normal_task_right_btn').evaluateAll(buttons => buttons.forEach(button => {
      button.onclick = () => globalThis.unsafeClick();
    }));
    const result = await coins.collectFreeCoinTasks(page, { timeout: 1000 });
    assert.equal(clicks, 0);
    assert.equal(result[0].reason, 'advertising');
    assert.equal(result[1].reason, 'advertising');
    assert.equal(result[2].reason, 'app-only');
    assert.equal(result[5].reason, 'requires-genuine-user-search');
  }));

test('free task runner recognizes an app gate without claiming or navigating', () =>
  fixture('<div>Download the AliExpress app</div><button>Install App</button>', async page => {
    assert.deepEqual(await coins.collectFreeCoinTasks(page, { timeout: 1000 }), [{ task: 'coins', status: 'skipped', reason: 'app-only' }]);
  }));

test('recent items uses only its normal mission entry and verifies disappearance', () =>
  fixture(row('Sfoglia articoli visti di recente'), async page => {
    await page.locator('.e2e_normal_task_right_btn').evaluate(button => {
      button.onclick = () => globalThis.completeTask();
    });
    const result = await coins.collectFreeCoinTasks(page, { timeout: 1000 });
    assert.equal(result[0].status, 'completed');
  }));

test('free daily check-in is scoped, confirmed after reload and idempotent', () =>
  fixture(row('Check-in giornaliero') + '<button>Buy now</button>', async page => {
    assert.equal(typeof coins.collectFreeCoinTasks, 'function');
    let clicks = 0;
    await page.exposeFunction('clicked', () => {
      clicks++;
    });
    await page.locator('.e2e_normal_task_right_btn').evaluate(button => {
      button.onclick = () => {
        globalThis.clicked(); globalThis.completeTask(); button.closest('.e2e_normal_task').remove();
      };
    });
    const result = await coins.collectFreeCoinTasks(page, { timeout: 1000 });
    assert.equal(result.find(r => r.task === 'Check-in giornaliero').status, 'completed');
    await coins.collectFreeCoinTasks(page, { timeout: 1000 });
    assert.equal(clicks, 1);
  }));
