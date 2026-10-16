// Accessible names survive Epic's generated CSS classes and removed test IDs.
// Exact matching deliberately excludes secondary controls such as Add to Cart.
export const epicPurchaseButton = page => page.getByRole('button', {
  name: /^(Get|In Library|Requires Base Game|Buy Now|Pre-Purchase|Coming Soon|Unavailable|Not Available|Loading(?:\.{3}|…)?)$/i,
}).filter({ visible: true }).first();

export const waitForEpicCheckout = async (page, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await waitForEpicManualChallenge(page);
    // Account redirects can be intermediate SSO hops. Let the bounded checkout
    // wait settle before classifying them as an authentication blocker.
    const checkoutSelector = '#webPurchaseContainer iframe, iframe[title="Checkout"][src^="https://store.epicgames.com/checkout"], iframe[title="Checkout"][src^="/checkout"]';
    if (await page.locator(checkoutSelector).first().isVisible()) {
      return page.frameLocator(checkoutSelector).first();
    }
    await page.waitForTimeout(100);
  }
  const url = new URL(page.url());
  if (url.hostname === 'www.epicgames.com' && url.pathname.startsWith('/id/login')) {
    throw new Error('Epic checkout requires sign-in: the account login page remained after the bounded SSO settle wait; no order was placed. Complete the visible account challenge before retrying.');
  }
  throw new Error('Epic checkout did not appear before timeout; no order was placed.');
};

export const waitForEpicManualChallenge = async (page, timeout = 600000, onChallenge = () => {}) => {
  const challenge = page.locator('iframe[title="hCaptcha challenge"]').filter({ visible: true }).first();
  if (!await challenge.isVisible()) return;
  await onChallenge();
  try {
    await challenge.waitFor({ state: 'hidden', timeout });
  } catch (cause) {
    throw new Error('Epic CAPTCHA still requires manual completion; no challenge interaction was automated.', { cause });
  }
};

export const verifyEpicZeroTotal = async checkout => {
  const text = await checkout.locator('body').innerText();
  const amounts = [...text.matchAll(/(?:[$€£]\s*([\d.,]+)|([\d.,]+)\s*(?:USD|EUR|GBP|€|£))/g)].map(match => match[1] || match[2]);
  if (!amounts.length || amounts.some(amount => !/^0+(?:[.,]0+)?$/.test(amount))) {
    throw new Error('Epic checkout zero total could not be verified; refusing to place order.');
  }
  return true;
};

export const submitEpicFreeOrder = async (page, checkout, { timeout = 60000, manualTimeout = 600000 } = {}) => {
  await waitForEpicManualChallenge(page, manualTimeout);
  const order = checkout.getByRole('button', { name: /^(Add to library|Place Order)$/i }).first();
  await order.waitFor({ state: 'visible', timeout });
  await verifyEpicZeroTotal(checkout);
  await order.click({ timeout, delay: 11 });
  let deadline = Date.now() + timeout;
  let accepted = false;
  while (Date.now() < deadline) {
    const before = Date.now();
    await waitForEpicManualChallenge(page, manualTimeout);
    deadline += Date.now() - before;
    for (const scope of [checkout, page]) {
      if (await scope.getByText(/Thanks for your order!|It's all yours/i).first().isVisible().catch(() => false)) return 'order-confirmation';
    }
    if (await page.getByRole('button', { name: /^In Library$/i }).first().isVisible().catch(() => false)) return 'in-library';
    const accept = checkout.getByRole('button', { name: /^I accept$/i }).first();
    if (!accepted && await accept.isVisible().catch(() => false)) {
      await verifyEpicZeroTotal(checkout);
      await accept.click({ timeout: Math.max(1, deadline - Date.now()) });
      accepted = true;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('Epic order did not reach a verified success state after submission; ownership is not confirmed.');
};

export const waitForPurchaseButton = async page => {
  const button = epicPurchaseButton(page).filter({ hasNotText: /^Loading(?:\.{3}|…)?$/i });
  await button.waitFor({ state: 'visible' });
  return button;
};
