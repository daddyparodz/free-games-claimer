import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firefox } from 'playwright-firefox';

async function fixture(run, { completed = false, explicit = true } = {}) {
  const browser = await firefox.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let rounds = completed ? 2 : 0;
    let productClicks = 0;
    await context.exposeFunction('recordProduct', () => {
      productClicks++;
    });
    await context.exposeFunction('finishRound', () => {
      rounds++;
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      let body;
      if (url.pathname.endsWith('/adclick.html'))
        body = `<div class="aecoin-productClick-test">Sfoglia articoli sorpresa<br>${explicit ? 'Tocca 3 articoli in questa pagina per guadagnare monete' : 'Sponsored recommendations'}<br>+5 <span id="progress">0 / 3</span></div><div class="product-list">${[1, 2, 3, 4].map(i => `<div class="feeds-discount-card" style="position:relative;height:60px"><p class="product-title-name">Product ${i}</p><button class="product-click" style="position:absolute;inset:0;width:100%;height:100%" onclick="recordProduct(); const p=document.getElementById('progress'); const n=Number(p.innerText.split('/')[0])+1; p.innerText=n+' / 3'; if(n===3)finishRound(); globalThis.open('/item/${i}.html')">Product ${i}</button></div>`).join('')}</div><button onclick="throw Error('ordinary advertising')">Ordinary advertisement</button>`;
      else if (url.pathname.includes('/item/'))
        body = '<h1>Product details</h1><button>Buy now</button><button>Add to cart</button>';
      else
        body = `<div class="e2e_normal_task"><div class="e2e_normal_task_content_title">Sfoglia articoli sorpresa</div><div>+5</div><div class="e2e_normal_task_right" data-groupid="2462001"><div class="statusText">${!completed && rounds > 0 ? rounds - 1 : rounds}/2</div><button class="e2e_normal_task_right_btn" onclick="globalThis.open('/p/coin-index/adclick.html')">${rounds === 2 ? 'Completato' : 'Vai'}</button></div></div>`;
      if (!url.pathname.endsWith('/adclick.html') && !url.pathname.includes('/item/'))
        body += `<script>setTimeout(()=>document.querySelector('.statusText').innerText='${rounds}/2',200)</script>`;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    await page.goto('https://m.it.aliexpress.com/p/coin-index/index.html?allowPromotion=1');
    await run(page, () => ({ rounds, productClicks }));
  } finally {
    await browser.close();
  }
}

test('sponsored platform visit mission respects the remaining displayed cap without product clicks', async () => {
  const browser = await firefox.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let count = 4;
    let productClicks = 0;
    await context.exposeFunction('visitMission', () => {
      count++;
    });
    await context.exposeFunction('ordinaryAd', () => {
      productClicks++;
    });
    await context.route('**/*', route =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: route.request().url().includes('recommends.html')
          ? '<div>Utilizza le monete per gli sconti</div><div>Sponsorizzato</div><button onclick="ordinaryAd()">Product</button>'
          : `<div class="e2e_normal_task"><div class="e2e_normal_task_content_title">Scopri gli articoli sponsorizzati</div><div>+5</div><div class="e2e_normal_task_right" data-groupid="2458001"><div class="statusText">${count}/6</div><button class="e2e_normal_task_right_btn" onclick="visitMission();globalThis.open('/p/coin-index/recommends.html')">${count === 6 ? 'Completato' : 'Vai'}</button></div></div>`,
      }),
    );
    await page.goto('https://m.it.aliexpress.com/p/coin-index/index.html?allowPromotion=1');
    const module = await import('../src/aliexpress-missions.js');
    const results = await module.collectIncentivizedMissions(page, { timeout: 15000 });
    assert.equal(results[0]?.status, 'completed');
    assert.equal(count, 6);
    assert.equal(productClicks, 0);
    await module.collectIncentivizedMissions(page, { timeout: 1000 });
    assert.equal(count, 6);
  } finally {
    await browser.close();
  }
});

test('explicit rewarded product mission stops at its displayed two rounds of three products', () =>
  fixture(async (page, state) => {
    const module = await import('../src/aliexpress-missions.js').catch(() => ({}));
    assert.equal(typeof module.collectIncentivizedMissions, 'function');
    const result = await module.collectIncentivizedMissions(page, { timeout: 15000 });
    assert.equal(result[0].status, 'completed');
    assert.deepEqual(state(), { rounds: 2, productClicks: 6 });
    await module.collectIncentivizedMissions(page, { timeout: 1000 });
    assert.deepEqual(state(), { rounds: 2, productClicks: 6 });
    assert.equal(page.context().pages().length, 1);
  }));

for (const options of [{ completed: true }, { explicit: false }]) {
  test(`no advertising clicks for ${options.completed ? 'completed missions' : 'ordinary ads without an explicit incentive instruction'}`, () =>
    fixture(async (page, state) => {
      const module = await import('../src/aliexpress-missions.js').catch(() => ({}));
      assert.equal(typeof module.collectIncentivizedMissions, 'function');
      await module.collectIncentivizedMissions(page, { timeout: 10000 });
      assert.equal(state().productClicks, 0);
    }, options));
}
