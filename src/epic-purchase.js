// Accessible names survive Epic's generated CSS classes and removed test IDs.
// Exact matching deliberately excludes secondary controls such as Add to Cart.
export const epicPurchaseButton = page => page.getByRole('button', {
  name: /^(Get|In Library|Requires Base Game|Buy Now|Pre-Purchase|Coming Soon|Unavailable|Not Available|Loading(?:\.{3}|…)?)$/i,
}).filter({ visible: true }).first();

export const waitForEpicCheckout = async (page, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // Account redirects can be intermediate SSO hops. Let the bounded checkout
    // wait settle before classifying them as an authentication blocker.
    if (await page.locator('#webPurchaseContainer iframe').isVisible()) {
      return page.frameLocator('#webPurchaseContainer iframe');
    }
    await page.waitForTimeout(100);
  }
  const url = new URL(page.url());
  if (url.hostname === 'www.epicgames.com' && url.pathname.startsWith('/id/login')) {
    throw new Error('Epic checkout requires sign-in: the account login page remained after the bounded SSO settle wait; no order was placed. Complete the visible account challenge before retrying.');
  }
  throw new Error('Epic checkout did not appear before timeout; no order was placed.');
};

export const waitForPurchaseButton = async page => {
  const button = epicPurchaseButton(page).filter({ hasNotText: /^Loading(?:\.{3}|…)?$/i });
  await button.waitFor({ state: 'visible' });
  return button;
};
