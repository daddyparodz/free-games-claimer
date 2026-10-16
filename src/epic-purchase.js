// Accessible names survive Epic's generated CSS classes and removed test IDs.
// Exact matching deliberately excludes secondary controls such as Add to Cart.
export const epicPurchaseButton = page => page.getByRole('button', {
  name: /^(Get|In Library|Requires Base Game|Buy Now|Pre-Purchase|Coming Soon|Unavailable|Not Available|Loading(?:\.{3}|…)?)$/i,
}).filter({ visible: true }).first();

export const epicCheckoutAuthError = () => 'Epic checkout redirected to Epic login and did not return before timeout. No order was placed for this game. The store listing signed-in status does not authenticate checkout. Complete the Epic sign-in shown in the visible browser, then retry.';

// The legacy listing uses EPIC_EG1; the current product app uses EPIC_AUTH_*.
// A signed-in listing (or wallet response) is not evidence for this boundary.
export const ensureEpicProductAccount = async (page, { displayName, loginTimeout = 180000 } = {}) => {
  const productUrl = new URL(page.url());
  if (productUrl.origin !== 'https://store.epicgames.com' || !productUrl.pathname.includes('/p/')) {
    throw new Error('Epic product authentication must be checked on a product page.');
  }
  const readAccount = () => page.evaluate(async () => {
    const response = await fetch('/proxy/api/account', { credentials: 'include', cache: 'no-store' });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error(`Epic product account request failed: HTTP ${response.status}`);
    const account = await response.json();
    if (typeof account.id !== 'string' || !account.id || typeof account.displayName !== 'string' || !account.displayName) {
      throw new Error('Epic product account response did not contain an authenticated identity.');
    }
    return { id: account.id, displayName: account.displayName };
  });
  let account = await readAccount();
  if (!account) {
    // Let Epic resume its own SSO session, or keep its MFA/login visible. Never
    // copy legacy tokens into the product cookie or automate an identity provider.
    const href = await page.locator('egs-navigation').first().getAttribute('signinlinkhref');
    const login = href && new URL(href, productUrl);
    if (!login || login.origin !== productUrl.origin || login.pathname !== '/login') {
      throw new Error('Epic product sign-in link is missing or unexpected; no order was placed.');
    }
    try {
      // Use the product app's own client/state, not the legacy listing login URL.
      await page.goto(login.href, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(url => url.origin === productUrl.origin && url.pathname === productUrl.pathname, { timeout: loginTimeout });
    } catch {
      throw new Error('Epic product session requires completion of the sign-in or MFA shown in the browser. The listing session is separate; no order was placed.');
    }
    account = await readAccount();
    if (!account) throw new Error('Epic returned to the product without an authenticated product account; no order was placed.');
  }
  if (displayName && account.displayName !== displayName) {
    throw new Error('Epic product account differs from the listing account; refusing to claim or update ownership.');
  }
  return account;
};

export const isEpicLoginRedirect = page => {
  return page.frames().some(frame => {
    try { const url = new URL(frame.url()); return url.hostname === 'www.epicgames.com' && url.pathname.startsWith('/id/login'); } catch { return false; }
  });
};

export const waitForEpicCheckout = async (page, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await waitForEpicManualChallenge(page);
    // Account redirects can be intermediate SSO hops. Let the bounded checkout
    // wait settle before classifying them as an authentication blocker.
    if (isEpicLoginRedirect(page)) {
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
      continue;
    }
    const checkoutSelector = '#webPurchaseContainer iframe, iframe[title="Checkout"][src^="https://store.epicgames.com/checkout"], iframe[title="Checkout"][src^="/checkout"]';
    if (await page.locator(checkoutSelector).first().isVisible()) {
      return page.frameLocator(checkoutSelector).first();
    }
    await page.waitForTimeout(100);
  }
  if (isEpicLoginRedirect(page)) {
    throw new Error(epicCheckoutAuthError());
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
