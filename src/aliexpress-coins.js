import { collectIncentivizedMissions } from './aliexpress-missions.js';

export const coinPageUrl = 'https://m.it.aliexpress.com/p/coin-index/index.html?allowPromotion=1';

export async function collectAliExpressCoins(page, options = {}) {
  const timeout = options.timeout ?? 60000;
  if (options.signal?.aborted) throw options.signal.reason || new Error('AliExpress tasks aborted.');
  const state = await waitForCoinState(page, timeout, ['claimed', 'collectable', 'app-gated']);
  if (state.status === 'app-gated') return { daily: state, tasks: [{ task: 'coins', status: 'skipped', reason: 'app-only' }] };
  const daily = await collectDailyCoins(page, { ...options, timeout });
  // Do not return early for an already-collected main check-in.
  const tasks = await collectFreeCoinTasks(page, { ...options, timeout });
  const missions = await collectIncentivizedMissions(page, { ...options, timeout });
  return { daily, tasks: [...tasks.filter(task => !missions.some(mission => mission.task === task.task)), ...missions] };
}

// Only explicitly recognized free mission controls are eligible. Never click products.
export async function collectFreeCoinTasks(page, { timeout = 60000, dryrun = false, signal } = {}) {
  const deadline = Date.now() + timeout;
  const remainingTime = () => {
    if (signal?.aborted) throw signal.reason || new Error('AliExpress tasks aborted.');
    const time = deadline - Date.now();
    if (time <= 0) throw new Error('AliExpress free task time limit reached.');
    return time;
  };
  const reload = async () => {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: remainingTime() });
    const state = await waitForCoinState(page, remainingTime(), ['claimed', 'collectable', 'app-gated']);
    if (state.status === 'unknown') throw new Error('AliExpress coin page did not finish loading.');
  };
  const results = [];
  await readCoinState(page);
  // This panel claims matured coins; it never enters the delivery confirmation flow.
  const orderTitle = page.getByText(/^(?:Dalla realizzazione di ordini|From completed orders)$/i);
  if (await orderTitle.count() === 1) {
    let panel = orderTitle.locator('..');
    for (let depth = 0; depth < 3; depth++, panel = panel.locator('..')) {
      const text = (await panel.innerText({ timeout: remainingTime() })).replace(/\s+/g, ' ').trim();
      if (/confirm|conferma|consegna|delivery|boost|spend|acquista/i.test(text)) break;
      const claim = panel.getByText(/^(?:Richiedi|Claim)$/i, { exact: true });
      if (!(await claim.count())) continue;
      if (await claim.count() !== 1 || !/\+\d+\s*(?:monete|coins)\b/i.test(text)) break;
      if (dryrun) results.push({ task: 'order-coins', status: 'dryrun' });
      else {
        await claim.click({ timeout: remainingTime() });
        await reload();
        const complete = !(await orderTitle.count());
        results.push({ task: 'order-coins', status: complete ? 'completed' : 'unconfirmed' });
        if (!complete) return results;
      }
      break;
    }
  }
  const attempted = new Set();
  for (;;) {
    remainingTime();
    const state = await readCoinState(page); // Challenges and sign-in always take precedence.
    if (state.status === 'app-gated') return [{ task: 'coins', status: 'skipped', reason: 'app-only' }];
    const rows = page.locator('.e2e_normal_task');
    let selected;
    for (let i = 0; i < await rows.count(); i++) {
      const row = rows.nth(i);
      const title = (await row.locator('.e2e_normal_task_content_title').innerText({ timeout: remainingTime() })).trim();
      if (attempted.has(title)) continue;
      attempted.add(title);
      const button = row.locator('.e2e_normal_task_right_btn');
      const action = (await button.innerText({ timeout: remainingTime() })).trim();
      const text = await row.innerText({ timeout: remainingTime() });
      const reason = /sponsor|surprise|sorpresa|adclick/i.test(text) || await row.locator('[href*="adclick.html"]').count() ? 'advertising'
        : /boost|spend|purchase|acquista|install|referral|review/i.test(text) ? 'unsafe-task'
          : /Annaffia|water|farm|Credito shopping|shopping credit/i.test(title) ? 'app-only'
            : /Cerca|search/i.test(title) ? 'requires-genuine-user-search' : 'unsupported-task';
      if (['advertising', 'unsafe-task'].includes(reason) || !/^(?:Daily check-in|Check-in giornaliero|Sfoglia articoli visti di recente|Browse recently viewed items|Visualizza i Super sconti|View Super discounts|Partecipa al quiz sulle monete)$/i.test(title)) {
        results.push({ task: title, status: 'skipped', reason });
        continue;
      }
      if (/^(?:Done|Completed|Completato)$/i.test(action)) {
        results.push({ task: title, status: 'already-completed' });
        continue;
      }
      if (!/^(?:Go|Vai)$/i.test(action) || !(await button.isVisible()) || !(await button.isEnabled()) || await button.getAttribute('aria-disabled') === 'true') {
        results.push({ task: title, status: 'skipped', reason: 'unavailable-control' });
        continue;
      }
      if (dryrun) {
        results.push({ task: title, status: 'dryrun' });
        continue;
      }
      selected = { row, button, title };
      break;
    }
    if (!selected) return results;
    const quiz = /quiz/i.test(selected.title);
    const superDiscounts = /Super/i.test(selected.title);
    if (superDiscounts && remainingTime() < 17000) {
      results.push({ task: selected.title, status: 'skipped', reason: 'insufficient-viewing-time' });
      continue;
    }
    const before = new Set(page.context().pages());
    const home = page.url();
    let opened;
    const onPopup = tab => {
      opened = tab;
    };
    page.on('popup', onPopup);
    try {
      await selected.button.click({ timeout: remainingTime() });
      if (/recent|Super|quiz/i.test(selected.title)) {
        const until = Date.now() + (superDiscounts || quiz ? 3000 : 200);
        while (!opened && page.url() === home && Date.now() < until) {
          remainingTime();
          await page.waitForTimeout(50);
        }
      }
      const visit = opened || page;
      await visit.waitForURL(url => url.href !== 'about:blank', { timeout: remainingTime() });
      await visit.waitForLoadState('domcontentloaded', { timeout: remainingTime() });
      await visit.locator('body').waitFor({ timeout: remainingTime() });
      if (quiz) {
        await readCoinState(visit);
        const text = (await visit.locator('body').innerText({ timeout: remainingTime() })).replace(/\s+/g, ' ').trim();
        // This full question/options combination has a verified correct UI result.
        // Never extrapolate "all answers" to other questions or translated options.
        const verified = /^https:\/\/m\.(?:it\.)?aliexpress\.com\/p\/coin-index\/coinquest\.html(?:\?|$)/i.test(visit.url()) && [
          'Q : Quali affermazioni sulle monete sono corrette?',
          'Le monete possono essere usate alla cassa per risparmiare di più',
          'Le monete possono essere combinate con altri sconti',
          'Visita ogni giorno il canale monete per ottenere monete gratis',
        ].every(value => text.includes(value));
        if (!verified) {
          results.push({ task: selected.title, status: 'skipped', reason: 'unverified-quiz' });
          if (page.url() !== home) await page.goto(home, { waitUntil: 'domcontentloaded', timeout: remainingTime() });
          return results;
        }
        await visit.getByText('Tutte le risposte sono corrette', { exact: true }).click({ timeout: remainingTime() });
        await visit.getByText('Risposta corretta: Tutte le risposte sono corrette', { exact: true }).waitFor({ timeout: remainingTime() });
      }
      if (superDiscounts) {
        if (!/^https:\/\/m\.(?:it\.)?aliexpress\.com\/p\/coin-index\/hotsale\.html(?:\?|$)/i.test(visit.url()))
          throw new Error('AliExpress Super discounts destination is unrecognized; stopping.');
        const until = Date.now() + 15000;
        while (Date.now() < until) {
          remainingTime();
          await visit.waitForTimeout(Math.min(250, until - Date.now()));
          await readCoinState(visit);
        }
      }
      if (page.url() !== home) await page.goto(home, { waitUntil: 'domcontentloaded', timeout: remainingTime() });
      await reload();
    } finally {
      page.off('popup', onPopup);
      for (const tab of page.context().pages()) if (!before.has(tab)) await tab.close();
    }
    await readCoinState(page);
    const remaining = page.locator('.e2e_normal_task').filter({ has: page.locator('.e2e_normal_task_content_title', { hasText: selected.title }) });
    const complete = !(await remaining.count()) || /^(?:Done|Completed|Completato)$/i.test((await remaining.locator('.e2e_normal_task_right_btn').innerText()).trim());
    results.push({ task: selected.title, status: complete ? 'completed' : 'unconfirmed' });
    if (!complete) return results; // An uncertain action must never be retried.
  }
}

export async function collectDailyCoins(page, { timeout = 15000, dryrun = false } = {}) {
  const state = await waitForCoinState(page, timeout);
  if (state.status === 'collectable' && dryrun) return { ...state, status: 'dryrun' };
  if (state.status === 'collectable') {
    await page.locator('#signButton').click({ timeout });
    const after = await waitForCoinState(page, timeout, ['claimed']);
    if (after.status !== 'claimed')
      throw new Error('AliExpress daily reward click was not confirmed; no retry was attempted.');
  } else if (state.status !== 'claimed') {
    throw new Error('AliExpress daily reward state is unrecognized.');
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  const verified = await waitForCoinState(page, timeout, ['claimed']);
  if (verified.status !== 'claimed') throw new Error('AliExpress daily reward could not be verified after navigation.');
  return { ...verified, status: state.status === 'claimed' ? 'already-claimed' : 'claimed' };
}

async function waitForCoinState(page, timeout, accepted = ['claimed', 'collectable']) {
  const deadline = Date.now() + timeout;
  let state;
  do {
    state = await readCoinState(page);
    if (accepted.includes(state.status)) return state;
    await page.waitForTimeout(Math.min(100, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return state;
}
export async function readCoinState(page) {
  return page.evaluate(() => {
    const clean = value => (value || '').replace(/\s+/g, ' ').trim();
    const body = clean(globalThis.document.body.innerText);
    if (/security verification|verify (?:that )?you are human|slide to verify|captcha/i.test(body))
      throw new Error('AliExpress security challenge requires manual completion.');
    if (globalThis.document.querySelector('input[type="password"]')) throw new Error('AliExpress sign-in is required.');
    if (!globalThis.document.querySelector('#sign-rewards-list') && /Download the AliExpress app|Install App|Scarica l.app/i.test(body))
      return { status: 'app-gated', today: '', tomorrow: '', streak: '' };
    const cards = [...globalThis.document.querySelectorAll('#sign-rewards-list > div')].map(e => clean(e.innerText));
    const today = cards.find(text => /^(?:Today|Oggi)\b/i.test(text)) || '';
    const tomorrow = cards.find(text => /^(?:Tomorrow|Domani)\b/i.test(text)) || '';
    const streak = clean(globalThis.document.body.innerText).match(/\b\d+\s+(?:days?\s+streak|giorni di sequenza)\b/i)?.[0] || '';
    const button = globalThis.document.querySelector('#signButton');
    const collectable =
      today &&
      button &&
      !button.disabled &&
      button.getClientRects().length &&
      /^(?:Collect(?:\s+\d+\s+coins)?|Raccogli(?:\s+\d+\s+monete)?)$/i.test(clean(button.innerText));
    const status =
      /^(?:Today|Oggi)\s+✓\s*\+\d+\b/i.test(today) && tomorrow ? 'claimed' : collectable ? 'collectable' : 'unknown';
    return { status, today, tomorrow, streak };
  });
}
