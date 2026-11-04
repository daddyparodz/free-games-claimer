// These are disclosed, capped platform missions, not ordinary advertisement clicks.
const missions = [
  {
    title: 'Scopri gli articoli sponsorizzati',
    group: '2458001',
    cap: 6,
    path: '/p/coin-index/recommends.html',
    kind: 'visit',
  },
  { title: 'Sfoglia articoli sorpresa', group: '2462001', cap: 2, path: '/p/coin-index/adclick.html' },
];

export async function collectIncentivizedMissions(page, { timeout = 60000, dryrun = false, signal } = {}) {
  const deadline = Date.now() + timeout;
  const time = () => {
    if (signal?.aborted) throw signal.reason || new Error('AliExpress missions aborted.');
    if (Date.now() >= deadline) throw new Error('AliExpress mission time limit reached.');
    return deadline - Date.now();
  };
  const check = async target => {
    const text = await target.locator('body').innerText({ timeout: time() });
    if (/captcha|security verification|slide to verify|verify (?:that )?you are human/i.test(text))
      throw new Error('AliExpress security challenge requires manual completion.');
    if (await target.locator('input[type="password"]').count()) throw new Error('AliExpress sign-in is required.');
    return text;
  };
  const results = [];
  for (const mission of missions) {
    const home = page.url();
    const rows = () => page.locator('.e2e_normal_task').filter({ has: page.getByText(mission.title, { exact: true }) });
    const progress = async () => {
      const row = rows();
      if ((await row.count()) !== 1) return null;
      if ((await row.locator(`.e2e_normal_task_right[data-groupid="${mission.group}"]`).count()) !== 1) return null;
      const text = (await row.innerText({ timeout: time() })).replace(/\s+/g, ' ');
      const count = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
      if (!count || Number(count[2]) !== mission.cap || Number(count[1]) > mission.cap || !/\+5\b/.test(text))
        return null;
      return Number(count[1]);
    };
    await check(page);
    let current = await progress();
    if (current === null) continue; // No exact platform task/cap: no advertising navigation.
    if (current === mission.cap) {
      results.push({ task: mission.title, status: 'already-completed' });
      continue;
    }
    if (dryrun) {
      results.push({ task: mission.title, status: 'dryrun' });
      continue;
    }
    const initial = current;
    let status = 'unconfirmed';
    // The original remaining count is the hard upper bound, even if UI state changes.
    for (let round = 0; round < mission.cap - initial; round++) {
      const before = new Set(page.context().pages());
      let opened;
      const onPopup = tab => {
        opened = tab;
      };
      page.on('popup', onPopup);
      try {
        const action = rows().locator('.e2e_normal_task_right_btn');
        if (!/^(?:Vai|Go)$/i.test((await action.innerText({ timeout: time() })).trim()) || !(await action.isEnabled()))
          break;
        await action.click({ timeout: time() });
        const until = Date.now() + 3000;
        while (!opened && page.url() === home && Date.now() < until) {
          await page.waitForTimeout(50);
          time();
        }
        const visit = opened || page;
        await visit.waitForURL(url => url.href !== 'about:blank', { timeout: time() });
        await visit.locator('body').waitFor({ timeout: time() });
        const url = new URL(visit.url());
        if (!/^m\.(?:it\.)?aliexpress\.com$/.test(url.hostname) || url.pathname !== mission.path) break;
        if (mission.kind === 'visit') {
          // The main mission offers +5 per capped visit; it does not request product clicks.
          const text = await check(visit);
          if (!text.includes('Utilizza le monete per gli sconti') || !text.includes('Sponsorizzato')) break;
          const viewedUntil = Date.now() + 2000;
          while (Date.now() < viewedUntil) {
            await visit.waitForTimeout(100);
            time();
          }
        } else {
          const header = visit.locator('[class*="aecoin-productClick-"]');
          await header.waitFor({ timeout: time() });
          const instruction = (await header.innerText({ timeout: time() })).replace(/\s+/g, ' ').trim();
          if (
            !instruction.includes('Tocca 3 articoli in questa pagina per guadagnare monete') ||
            !/\+5\b/.test(instruction)
          ) {
            status = 'skipped';
            break;
          }
          const counter = async () => {
            await check(visit);
            const match = (await header.innerText({ timeout: time() }))
              .replace(/\s+/g, ' ')
              .match(/\b([0-3])\s*\/\s*3\b/);
            return match ? Number(match[1]) : null;
          };
          let count = await counter();
          if (count === null || count === 3) break; // No reset or forced reward replay.
          for (let item = count; item < 3; item++) {
            const productBefore = new Set(page.context().pages());
            const missionUrl = visit.url();
            // Only cards inside this explicitly incentivized mission are eligible.
            await visit
              .locator('.product-list .feeds-discount-card .product-click')
              .nth(item)
              .click({ timeout: time() });
            if (visit.url() !== missionUrl) {
              await visit.locator('body').waitFor({ timeout: time() });
              await check(visit);
              await visit.goBack({ waitUntil: 'domcontentloaded', timeout: time() });
            }
            const finish = Date.now() + Math.min(10000, time());
            while ((await counter()) !== item + 1 && Date.now() < finish) {
              await visit.waitForTimeout(250);
              time();
            }
            count = await counter();
            for (const tab of page.context().pages()) {
              if (!productBefore.has(tab)) {
                await tab.locator('body').waitFor({ timeout: time() });
                await check(tab);
                await tab.close();
              }
            }
            if (visit.url() !== missionUrl) await visit.goBack({ waitUntil: 'domcontentloaded', timeout: time() });
            if (count !== item + 1) break; // Uncertain click: never retry or choose extra products.
          }
          if (count !== 3) break;
        }
        if (page.url() !== home) await page.goto(home, { waitUntil: 'domcontentloaded', timeout: time() });
        else await page.reload({ waitUntil: 'domcontentloaded', timeout: time() });
        await page.locator('.e2e_normal_task').first().waitFor({ timeout: time() });
        await check(page);
        let after = await progress();
        const settleUntil = Date.now() + Math.min(10000, time());
        while (after !== current + 1 && Date.now() < settleUntil) {
          await page.waitForTimeout(100);
          await check(page);
          after = await progress();
        }
        if (after === null && current === mission.cap - 1 && !(await rows().count())) after = mission.cap;
        if (after === null || after !== current + 1) break;
        current = after;
        status = current === mission.cap ? 'completed' : 'progressed';
      } finally {
        page.off('popup', onPopup);
        for (const tab of page.context().pages()) if (!before.has(tab)) await tab.close();
        if (page.url() !== home) await page.goto(home, { waitUntil: 'domcontentloaded', timeout: time() });
      }
      if (status !== 'progressed') break;
    }
    results.push({
      task: mission.title,
      status,
      progress: `${current}/${mission.cap}`,
      ...(status === 'skipped' ? { reason: 'no-explicit-incentive-instruction' } : {}),
    });
  }
  return results;
}
