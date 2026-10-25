/* global document */
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
    const body = clean(document.body.innerText);
    if (/security verification|verify (?:that )?you are human|slide to verify|captcha/i.test(body))
      throw new Error('AliExpress security challenge requires manual completion.');
    if (document.querySelector('input[type="password"]')) throw new Error('AliExpress sign-in is required.');
    const cards = [...document.querySelectorAll('#sign-rewards-list > div')].map(e => clean(e.innerText));
    const today = cards.find(text => /^Today\b/i.test(text)) || '';
    const tomorrow = cards.find(text => /^Tomorrow\b/i.test(text)) || '';
    const streak = clean(document.body.innerText).match(/\b\d+\s+days?\s+streak\b/i)?.[0] || '';
    const button = document.querySelector('#signButton');
    const collectable =
      today &&
      button &&
      !button.disabled &&
      button.getClientRects().length &&
      /^Collect(?:\s+\d+\s+coins)?$/i.test(clean(button.innerText));
    const status =
      /^Today\s+✓\s*\+\d+\b/i.test(today) && tomorrow ? 'claimed' : collectable ? 'collectable' : 'unknown';
    return { status, today, tomorrow, streak };
  });
}
