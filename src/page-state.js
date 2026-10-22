const epicSuccessStates = page => [
  { name: 'order-confirmation', locator: page.getByText(/It's all yours/i) },
  { name: 'order-confirmation', locator: page.getByText(/Thanks for your order!/i) },
  { name: 'in-library', locator: page.getByRole('button', { name: /^In Library$/i }) },
  { name: 'launcher-prompt', locator: page.getByText(/Is Epic Games Launcher installed\?/i) },
];

export const waitForEpicClaimSuccess = async (page, timeout) => {
  const states = epicSuccessStates(page);
  const success = states
    .slice(1)
    .reduce((locator, state) => locator.or(state.locator), states[0].locator)
    .first();
  try {
    await success.waitFor({ state: 'visible', timeout });
  } catch (cause) {
    throw new Error(`Epic did not show a successful claim state within ${timeout / 1000} seconds`, { cause });
  }

  for (const state of states) {
    if (
      await state.locator
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return state.name;
    }
  }
  throw new Error('Epic claim success state disappeared before it could be verified');
};

const primeInternalSuccess = page => {
  return page
    .getByText(
      /will be available to play from your .* library|you collected this on|sent to your .* library|collected on/i,
    )
    .first();
};

export const isPrimeInternalClaimSuccess = async page => {
  return await primeInternalSuccess(page)
    .isVisible()
    .catch(() => false);
};

export const waitForPrimeInternalClaimSuccess = async (page, timeout = 15_000) => {
  if (await isPrimeInternalClaimSuccess(page)) return true;
  return await primeInternalSuccess(page)
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
};

const parseHttpDate = (value, now) => {
  let match = value.match(
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/,
  );
  let obsolete = false;
  if (!match) {
    match = value.match(
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/,
    );
    obsolete = !!match;
  }
  if (!match) {
    const asctime = value.match(
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/,
    );
    if (!asctime) return NaN;
    match = [asctime[0], asctime[1], asctime[3], asctime[2], asctime[7], asctime[4], asctime[5], asctime[6]];
  }
  const [, weekday, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(monthText);
  const [day, hour, minute, second] = [dayText, hourText, minuteText, secondText].map(Number);
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return NaN;
  let year = Number(yearText);
  const date = new Date(0);
  if (obsolete) {
    const limit = new Date(now);
    limit.setUTCFullYear(limit.getUTCFullYear() + 50);
    year += Math.floor(limit.getUTCFullYear() / 100) * 100;
    date.setUTCFullYear(year, month, day);
    date.setUTCHours(hour, minute, second, 0);
    if (date.getTime() > limit.getTime()) year -= 100;
  }
  // UTC setters avoid local-time parsing and Date.UTC's special treatment of years 00-99.
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()] !== weekday.slice(0, 3)
  ) {
    return NaN;
  }
  return date.getTime();
};

export const getGogSession = async (context, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  let response;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (attempt > 0 && remaining <= 0) throw lastError;
    try {
      response = await context.request.get('https://www.gog.com/userData.json', {
        headers: { 'Cache-Control': 'no-cache' },
        timeout: Math.max(1, remaining),
      });
    } catch (cause) {
      throw new Error('Could not read GOG login state from userData.json', { cause });
    }
    if (response.ok()) break;
    const status = response.status();
    const error = new Error(`GOG userData.json returned HTTP ${status}`);
    lastError = error;
    // Only retry the read-only session GET, never a giveaway claim or login.
    let delay = 1000 * 2 ** attempt;
    if (status === 503 && attempt < 2) {
      const retryAfter = response.headers()['retry-after'];
      if (retryAfter && retryAfter.match(/^\d+$/)) delay = Number(retryAfter) * 1000;
      else if (retryAfter) {
        const now = Date.now();
        const retryAt = parseHttpDate(retryAfter, now);
        if (Number.isFinite(retryAt)) delay = Math.max(0, retryAt - now);
      }
    }
    try {
      await response.dispose?.();
    } catch {
      // Cleanup must not replace the HTTP error or prevent an eligible retry.
    }
    if (status !== 503 || attempt === 2 || delay >= deadline - Date.now()) throw error;
    console.warn(`GOG userData.json returned HTTP 503; retrying session read (${attempt + 2}/3) in ${delay} ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  let data;
  try {
    data = await response.json();
  } catch (cause) {
    throw new Error('GOG userData.json returned invalid JSON', { cause });
  }
  return {
    isLoggedIn: data.isLoggedIn === true,
    username: typeof data.username === 'string' && data.username.trim() ? data.username.trim() : undefined,
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
