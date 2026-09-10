const epicSuccessStates = page => [
  { name: 'order-confirmation', locator: page.getByText(/It's all yours/i) },
  { name: 'order-confirmation', locator: page.getByText(/Thanks for your order!/i) },
  { name: 'in-library', locator: page.locator('button[data-testid="purchase-cta-button"]:has-text("In Library")') },
  { name: 'launcher-prompt', locator: page.getByText(/Is Epic Games Launcher installed\?/i) },
];

export const waitForEpicClaimSuccess = async (page, timeout) => {
  const states = epicSuccessStates(page);
  const success = states.slice(1).reduce((locator, state) => locator.or(state.locator), states[0].locator).first();
  try {
    await success.waitFor({ state: 'visible', timeout });
  } catch (cause) {
    throw new Error(`Epic did not show a successful claim state within ${timeout / 1000} seconds`, { cause });
  }

  for (const state of states) {
    if (await state.locator.first().isVisible().catch(_ => false)) return state.name;
  }
  throw new Error('Epic claim success state disappeared before it could be verified');
};

export const getGogSession = async (context, timeout = 15_000) => {
  let response;
  try {
    response = await context.request.get('https://www.gog.com/userData.json', {
      headers: { 'Cache-Control': 'no-cache' },
      timeout,
    });
  } catch (cause) {
    throw new Error('Could not read GOG login state from userData.json', { cause });
  }
  if (!response.ok()) throw new Error(`GOG userData.json returned HTTP ${response.status()}`);

  let data;
  try {
    data = await response.json();
  } catch (cause) {
    throw new Error('GOG userData.json returned invalid JSON', { cause });
  }
  return {
    isLoggedIn: data.isLoggedIn === true,
    username: typeof data.username == 'string' && data.username.trim() ? data.username.trim() : undefined,
  };
};

export const waitForGogSession = async (context, timeout, pollInterval = 1000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try {
      const session = await getGogSession(context, Math.min(10_000, Math.max(1, deadline - Date.now())));
      if (session.isLoggedIn) return session;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);

  throw new Error(`GOG did not report a signed-in session within ${timeout / 1000} seconds`, { cause: lastError });
};
