import { firefox } from 'playwright-firefox'; // stealth plugin needs no outdated playwright-extra
import { authenticator } from 'otplib';
import chalk from 'chalk';
import { resolve, jsonDb, datetime, stealth, filenamify, prompt, confirm, notify, html_game_list, handleSIGINT } from './src/util.js';
import { cfg } from './src/config.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'prime-gaming', ...a);

// const URL_LOGIN = 'https://www.amazon.de/ap/signin'; // wrong. needs some session args to be valid?
const URL_CLAIM = 'https://gaming.amazon.com/home';

const offerUrl = (href, baseUrl = URL_CLAIM) => {
  if (!href) throw new Error('Prime Gaming offer link is missing an href');
  const base = new URL(baseUrl);
  const url = new URL(href, baseUrl);
  if (base.hostname.startsWith('luna.amazon.') && url.hostname == 'gaming.amazon.com') {
    url.protocol = base.protocol;
    url.hostname = base.hostname;
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/^\/claims\/claims(?=\/)/, '/claims');
  const isLunaItemPath = (/\/dp\/amzn1\.pg\.item\./).test(url.pathname);
  if (url.hostname.startsWith('luna.amazon.') && isLunaItemPath && !url.pathname.startsWith('/claims/')) {
    url.pathname = `/claims${url.pathname}`;
  }
  return url.href;
};

const throwIfPrimeErrorPage = async page => {
  const error = page.locator('[data-a-target="prime-error-main-text"], h1:has-text("(404)")').first();
  if (await error.count()) {
    const message = await error.innerText().catch(_ => 'Prime Gaming error page');
    throw new Error(`${message.replace(/\s+/g, ' ')}: ${page.url()}`);
  }
};

const claimExternalOffer = async page => {
  const resultSelectors = [
    'div:has-text("Link game account")',
    'div:has-text("Link account")',
    '.thank-you-title:has-text("Success")',
    '[data-a-target="ClaimStateClaimCodeContent"]',
    'input[type="text"]',
  ];
  const actionSelectors = [
    'button[data-a-target="buy-box_call-to-action"]:has-text("Get game")',
    'button[data-a-target="buy-box_call-to-action"]:has-text("Claim game")',
    'button[data-a-target="buy-box_call-to-action"]:has-text("Claim code")',
    'button[data-a-target="buy-box_call-to-action"]:has-text("Get code")',
    'button[data-a-target="buy-box_call-to-action"]:has-text("Reveal code")',
    'button[data-a-target="buy-box_call-to-action"]:has-text("Complete Claim")',
    'button[data-a-target="buy-box_call-to-action"]:has-text("Claim")',
    '[data-a-target="buy-box"] .tw-button:has-text("Get game")',
    '[data-a-target="buy-box"] .tw-button:has-text("Claim code")',
    '[data-a-target="buy-box"] .tw-button:has-text("Get code")',
    '[data-a-target="buy-box"] .tw-button:has-text("Reveal code")',
    '[data-a-target="buy-box"] .tw-button:has-text("Claim")',
    '.tw-button:has-text("Complete Claim")',
    'button:has-text("Claim code")',
    'button:has-text("Get code")',
    'button:has-text("Reveal code")',
  ];
  const hasResult = async () => (await Promise.all(resultSelectors.map(async selector => await page.locator(selector).first().isVisible().catch(_ => false)))).some(Boolean);
  const clickAction = async () => {
    for (const selector of actionSelectors) {
      const action = page.locator(selector).first();
      if (await action.isVisible().catch(_ => false)) {
        await action.click();
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < 3 && !await hasResult(); ++i) {
    if (!await clickAction()) break;
    await page.waitForLoadState('networkidle').catch(_ => { });
    await page.waitForTimeout(1000);
  }
  if (!await hasResult()) {
    await Promise.any([
      ...resultSelectors.map(selector => page.waitForSelector(selector)),
      page.waitForTimeout(5000),
    ]);
  }
};

const redeem = {
  // 'origin': 'https://www.origin.com/redeem', // TODO still needed or now only via account linking?
  'gog.com': 'https://www.gog.com/redeem',
  'microsoft store': 'https://account.microsoft.com/billing/redeem',
  xbox: 'https://account.microsoft.com/billing/redeem',
  'legacy games': 'https://www.legacygames.com/primedeal',
};

const isAlreadyRedeemed = status => ['claimed and redeemed', 'claimed and redeemed?'].includes(status);

const isGenericLegacyRedeemUrl = redeem_url => {
  if (!redeem_url) return true;
  const url = new URL(redeem_url, 'https://www.legacygames.com');
  return url.hostname == 'www.legacygames.com' && ['/', '/primedeal', '/primedeal/'].includes(url.pathname);
};

const getLegacyRedeemUrl = async page => {
  const legacyLink = page.locator([
    'li:has-text("Click here") a',
    'a[href*="promo.legacygames.com"]',
    'a[href*="legacygames.com"]:has-text("Click here")',
    'a[href*="legacygames.com"]:has-text("redeem")',
  ].join(', ')).first();
  return await legacyLink.getAttribute('href').catch(_ => undefined);
};

const storeFromItemDetails = item_text => item_text.toLowerCase().replace(/.* on /, '').slice(0, -1);

const redeemStatus = action => {
  if (action == 'redeemed' || action == 'already redeemed') return 'claimed and redeemed';
  if (action == 'redeemed?') return 'claimed and redeemed?';
  if (action == 'redeem (not found)') return 'failed: code not found';
  if (action == 'redeem (missing legacy URL)') return 'failed: missing legacy redeem URL';
  if (action == 'redeem (legacy page not found)') return 'failed: legacy page unavailable';
  if (action == 'redeem (legacy form missing)') return 'failed: legacy form missing';
  return 'claimed';
};

const isTerminalRedeemStatus = status => isAlreadyRedeemed(status) || status?.startsWith('failed:');

const notifyGogCaptchaNeeded = async title => {
  const suffix = title ? ` for ${title}` : '';
  const action = cfg.headless
    ? 'Run with SHOW=1 and PG_REDEEM=1 to complete it.'
    : `Complete it in the visible browser within ${cfg.login_timeout / 1000} seconds.`;
  await notify(`prime-gaming: GOG captcha needed${suffix}. ${action}`).catch(_ => { });
};

const waitForGogManualRedeem = async page => {
  let action;
  let validCodeSeen = false;
  let clickedRedeem = false;
  const handleResponse = async response => {
    const request = response.request();
    if (!response.url().startsWith('https://redeem.gog.com/')) return;
    let body = '';
    try { body = await response.text(); } catch { }
    let json;
    try { json = JSON.parse(body); } catch { }
    const reason = json?.reason;
    if (request.method() == 'GET') {
      if (reason?.includes('captcha')) return;
      if (reason == 'code_used') action = 'already redeemed';
      else if (reason == 'code_not_found') action = 'redeem (not found)';
      else if (response.status() >= 200 && response.status() < 300) validCodeSeen = true;
    } else if (request.method() == 'POST') {
      if (body == '{}') action = 'redeemed';
      else if (reason?.includes('captcha')) action = 'redeem (got captcha)';
      else if (reason == 'code_used') action = 'already redeemed';
      else if (reason == 'code_not_found') action = 'redeem (not found)';
      else action = 'redeemed?';
    }
  };

  page.on('response', handleResponse);
  try {
    console.log(`  Waiting up to ${cfg.login_timeout / 1000} seconds for manual GOG captcha/redeem completion.`);
    console.log('  Use the visible browser: solve captcha if shown, click Continue, then leave the browser open.');
    await page.bringToFront();
    const deadline = Date.now() + cfg.login_timeout;
    while (!action && Date.now() < deadline) {
      if (validCodeSeen && !clickedRedeem) {
        const submit = page.locator('button[type="submit"], [type="submit"]').first();
        if (await submit.isVisible().catch(_ => false)) {
          clickedRedeem = true;
          await submit.click().catch(error => console.error('  Auto redeem click failed:', error.message));
        }
      }
      const body = await page.locator('body').innerText().catch(_ => '');
      if (/successfully redeemed|has been redeemed|added to your account/i.test(body)) action = 'redeemed';
      await page.waitForTimeout(1000);
    }
  } finally {
    page.off('response', handleResponse);
  }
  return action;
};

const redeemCode = async (context, store, code, redeem_url = redeem[store], title) => {
  let redeem_action = 'redeem';
  console.log(`  Trying to redeem ${code} on ${store} (need to be logged in)!`);
  if (store == 'legacy games' && isGenericLegacyRedeemUrl(redeem_url)) {
    redeem_action = 'redeem (missing legacy URL)';
    console.error('  Missing game-specific Legacy Games redeem URL; skipping generic legacygames.com page.');
    return { action: redeem_action, status: redeemStatus(redeem_action), redeem_url };
  }
  const page2 = await context.newPage();
  try {
    await page2.goto(redeem_url, { waitUntil: 'domcontentloaded' });
    if (store == 'gog.com') {
      // await page.goto(`https://redeem.gog.com/v1/bonusCodes/${code}`); // {"reason":"Invalid or no captcha"}
      await page2.fill('#codeInput', code);
      // wait for responses before clicking on Continue and then Redeem
      // first there are requests with OPTIONS and GET to https://redeem.gog.com/v1/bonusCodes/XYZ?language=de-DE
      const r1 = page2.waitForResponse(r => r.request().method() == 'GET' && r.url().startsWith('https://redeem.gog.com/'));
      await page2.click('[type="submit"]'); // click Continue
      // console.log(await page2.locator('.warning-message').innerText()); // does not exist if there is no warning
      const r1t = await (await r1).text();
      const reason = JSON.parse(r1t).reason;
      // {"reason":"Invalid or no captcha"}
      // {"reason":"code_used"}
      // {"reason":"code_not_found"}
      if (reason?.includes('captcha')) {
        redeem_action = 'redeem (got captcha)';
        console.error('  Got captcha; could not redeem!');
        await notifyGogCaptchaNeeded(title);
        if (!cfg.headless) redeem_action = await waitForGogManualRedeem(page2) || redeem_action;
      } else if (reason == 'code_used') {
        redeem_action = 'already redeemed';
        console.log('  Code was already used!');
      } else if (reason == 'code_not_found') {
        redeem_action = 'redeem (not found)';
        console.error('  Code was not found!');
      } else { // TODO not logged in? need valid unused code to test.
        redeem_action = 'redeemed?';
        // console.log('  Redeemed successfully? Please report your Responses (if new) in https://github.com/vogler/free-games-claimer/issues/5');
        console.debug(`  Response 1: ${r1t}`);
        // then after the click on Redeem there is a POST request which should return {} if claimed successfully
        const r2 = page2.waitForResponse(r => r.request().method() == 'POST' && r.url().startsWith('https://redeem.gog.com/'));
        await page2.click('[type="submit"]'); // click Redeem
        const r2t = await (await r2).text();
        const reason2 = JSON.parse(r2t).reason;
        if (r2t == '{}') {
          redeem_action = 'redeemed';
          console.log('  Redeemed successfully.');
        } else if (reason2?.includes('captcha')) {
          redeem_action = 'redeem (got captcha)';
          console.error('  Got captcha; could not redeem!');
          await notifyGogCaptchaNeeded(title);
          if (!cfg.headless) redeem_action = await waitForGogManualRedeem(page2) || redeem_action;
        } else {
          console.debug(`  Response 2: ${r2t}`);
          console.log('  Unknown Response 2 - please report in https://github.com/vogler/free-games-claimer/issues/5');
        }
      }
    } else if (store == 'microsoft store' || store == 'xbox') {
      console.error(`  Redeem on ${store} is experimental!`);
      // await page2.pause();
      if (page2.url().startsWith('https://login.')) {
        console.error('  Not logged in! Please redeem the code above manually. You can now login in the browser for next time. Waiting for 60s.');
        await page2.waitForTimeout(60 * 1000);
        redeem_action = 'redeem (login)';
      } else {
        const iframe = page2.frameLocator('#redeem-iframe');
        const input = iframe.locator('[name=tokenString]');
        await input.waitFor();
        await input.fill(code);
        const r = page2.waitForResponse(r => r.url().startsWith('https://cart.production.store-web.dynamics.com/v1.0/Redeem/PrepareRedeem'));
        // console.log(await page2.locator('.redeem_code_error').innerText());
        const rt = await (await r).text();
        // {"code":"NotFound","data":[],"details":[],"innererror":{"code":"TokenNotFound",...
        const j = JSON.parse(rt);
        const reason = j?.events?.cart.length && j.events.cart[0]?.data?.reason;
        if (reason == 'TokenNotFound') {
          redeem_action = 'redeem (not found)';
          console.error('  Code was not found!');
        } else if (j?.productInfos?.length && j.productInfos[0]?.redeemable) {
          await iframe.locator('button:has-text("Next")').click();
          await iframe.locator('button:has-text("Confirm")').click();
          const r = page2.waitForResponse(r => r.url().startsWith('https://cart.production.store-web.dynamics.com/v1.0/Redeem/RedeemToken'));
          const j = JSON.parse(await (await r).text());
          if (j?.events?.cart.length && j.events.cart[0]?.data?.reason == 'UserAlreadyOwnsContent') {
            redeem_action = 'already redeemed';
            console.error('  error: UserAlreadyOwnsContent');
          } else if (true) { // TODO what's returned on success?
            redeem_action = 'redeemed';
            console.log('  Redeemed successfully? Please report if not in https://github.com/vogler/free-games-claimer/issues/5');
          }
        } else { // TODO find out other responses
          redeem_action = 'unknown';
          console.debug(`  Response: ${rt}`);
          console.log('  Redeemed successfully? Please report your Response from above (if it is new) in https://github.com/vogler/free-games-claimer/issues/5');
        }
      }
    } else if (store == 'legacy games') {
      // await page2.pause();
      const coupon = page2.locator('[name=coupon_code]').first();
      if (!await coupon.isVisible().catch(_ => false)) {
        const body = await page2.locator('body').innerText().catch(_ => '');
        redeem_action = /404|couldn.t be found|page.*not found/i.test(body) ? 'redeem (legacy page not found)' : 'redeem (legacy form missing)';
        console.error(`  Legacy Games redeem form unavailable: ${redeem_action}`);
        return { action: redeem_action, status: redeemStatus(redeem_action), redeem_url };
      }
      await coupon.fill(code);
      if (await page2.locator('[name=email]').count()) {
        if (!cfg.lg_email) {
          console.error('  Legacy Games redemption requires LG_EMAIL, PG_EMAIL, or EMAIL to be configured.');
          await notify(`prime-gaming: Legacy Games redemption for ${title} needs LG_EMAIL, PG_EMAIL, or EMAIL because the promo form still asks for an email.`).catch(_ => { });
          redeem_action = 'redeem (missing email)';
          return { action: redeem_action, status: redeemStatus(redeem_action), redeem_url };
        }
        await page2.fill('[name=email]', cfg.lg_email);
        await page2.fill('[name=email_validate]', cfg.lg_email);
      }
      await page2.uncheck('[name=newsletter_sub]').catch(_ => { });
      await page2.click('[type="submit"]');
      try {
        // await page2.waitForResponse(r => r.url().startsWith('https://promo.legacygames.com/promotion-processing/order-management.php')); // status code 302
        await Promise.race([
          page2.waitForSelector('h2:has-text("Thanks for redeeming")'),
          page2.waitForTimeout(15000),
        ]);
        const body = await page2.locator('body').innerText().catch(_ => '');
        if (await page2.locator('h2:has-text("Thanks for redeeming")').count()) {
          redeem_action = 'redeemed';
        } else if (/already.*redeem|already.*used/i.test(body)) {
          redeem_action = 'already redeemed';
          console.log('  Code was already used!');
        } else if (/404|couldn.t be found|page.*not found/i.test(body)) {
          redeem_action = 'redeem (legacy page not found)';
          console.error('  Legacy Games promo page returned 404 after submit.');
        } else {
          redeem_action = 'redeemed?';
          console.log('  Redeemed successfully? Please report problems in https://github.com/vogler/free-games-claimer/issues/5');
        }
      } catch (error) {
        console.error('  Got error', error);
        redeem_action = 'redeemed?';
        console.log('  Redeemed successfully? Please report problems in https://github.com/vogler/free-games-claimer/issues/5');
      }
    } else {
      console.error(`  Redeem on ${store} not yet implemented!`);
    }
  } finally {
    if (cfg.debug) await page2.pause();
    await page2.close();
  }
  return { action: redeem_action, status: redeemStatus(redeem_action), redeem_url };
};

console.log(datetime(), 'started checking prime-gaming');

const db = await jsonDb('prime-gaming.json', {});

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await firefox.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/pg-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
});

handleSIGINT(context);

// TODO test if needed
await stealth(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it
// console.debug('userAgent:', await page.evaluate(() => navigator.userAgent));

const notify_games = [];
const redeemed_codes = new Set();
let user;

try {
  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // default 'load' takes forever
  // need to wait for some elements to exist before checking if signed in or accepting cookies:
  await Promise.any(['button:has-text("Sign in")', '[data-a-target="user-dropdown-first-name-text"]'].map(s => page.waitForSelector(s)));
  page.click('[aria-label="Cookies usage disclaimer banner"] button:has-text("Accept Cookies")').catch(_ => { }); // to not waste screen space when non-headless, TODO does not work reliably, need to wait for something else first?
  while (await page.locator('button:has-text("Sign in")').count() > 0) {
    console.error('Not signed in anymore.');
    await page.click('button:has-text("Sign in")');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    if (cfg.pg_email && cfg.pg_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const email = cfg.pg_email || await prompt({ message: 'Enter email' });
    const password = email && (cfg.pg_password || await prompt({ type: 'password', message: 'Enter password' }));
    if (email && password) {
      await page.fill('[name=email]', email);
      await page.click('input[type="submit"]');
      await page.fill('[name=password]', password);
      // await page.check('[name=rememberMe]'); // no longer exists
      await page.click('input[type="submit"]');
      page.waitForURL('**/ap/signin**').then(async () => { // check for wrong credentials
        const error = await page.locator('.a-alert-content').first().innerText();
        if (!error.trim.length) return;
        console.error('Login error:', error);
        await notify(`prime-gaming: login: ${error}`);
        await context.close(); // finishes potential recording
        process.exit(1);
      });
      // handle MFA, but don't await it
      page.waitForURL('**/ap/mfa**').then(async () => {
        console.log('Two-Step Verification - enter the One Time Password (OTP), e.g. generated by your Authenticator App');
        await page.check('[name=rememberDevice]');
        const otp = cfg.pg_otpkey && authenticator.generate(cfg.pg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await page.locator('input[name=otpCode]').pressSequentially(otp.toString());
        await page.click('input[type="submit"]');
      }).catch(_ => { });
    } else {
      console.log('Waiting for you to login in the browser.');
      await notify('prime-gaming: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node prime-gaming` to login in the opened browser.');
        await context.close(); // finishes potential recording
        process.exit(1);
      }
    }
    await page.waitForURL(/https:\/\/(gaming\.amazon\.com|luna\.amazon\.[^/]+)\/(claims\/)?home.*signedIn=true/);
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await page.locator('[data-a-target="user-dropdown-first-name-text"]').first().innerText();
  console.log(`Signed in as ${user}`);
  // await page.click('button[aria-label="User dropdown and more options"]');
  // const twitch = await page.locator('[data-a-target="TwitchDisplayName"]').first().innerText();
  // console.log(`Twitch user name is ${twitch}`);
  db.data[user] ||= {};

  if (await page.getByRole('button', { name: 'Try Prime' }).count()) {
    console.error('User is currently not an Amazon Prime member, so no games to claim. Exit!');
    await context.close();
    process.exit(1);
  }

  const waitUntilStable = async (f, act) => {
    let v;
    while (true) {
      const v2 = await f();
      console.log('waitUntilStable', v2);
      if (v == v2) break;
      v = v2;
      await act();
    }
  };
  const scrollUntilStable = async f => await waitUntilStable(f, async () => {
    // await page.keyboard.press('End'); // scroll to bottom to show all games
  // loading all games became flaky; see https://github.com/vogler/free-games-claimer/issues/357
    await page.keyboard.press('PageDown'); // scrolling to straight to the bottom started to skip loading some games
    await page.waitForLoadState('networkidle'); // wait for all games to be loaded
    await page.waitForTimeout(3000); // TODO networkidle wasn't enough to load all already collected games
    // do it again since once wasn't enough...
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(3000);
  });

  await page.click('button[data-type="Game"]');
  const games = page.locator('div[data-a-target="offer-list-FGWP_FULL"]');
  await games.waitFor();
  // await scrollUntilStable(() => games.locator('.item-card__action').count()); // number of games
  await scrollUntilStable(() => page.evaluate(() => document.querySelector('.tw-full-width').scrollHeight)); // height may change during loading while number of games is still the same?
  console.log('Number of already claimed games (total):', await games.locator('p:has-text("Collected")').count());
  // can't use .all() since the list of elements via locator will change after click while we iterate over it
  const internal = await games.locator('.item-card__action:has(button[data-a-target="FGWPOffer"])').elementHandles();
  const external = await games.locator('.item-card__action:has(a[data-a-target="FGWPOffer"])').all();
  // bottom to top: oldest to newest games
  internal.reverse();
  external.reverse();
  const sameOrNewPage = async url => new Promise(async (resolve, _reject) => {
    const isNew = page.url() != url;
    let p = page;
    if (isNew) {
      p = await context.newPage();
      await p.goto(url, { waitUntil: 'domcontentloaded' });
    }
    resolve([p, isNew]);
  });
  const skipBasedOnTime = async url => {
    // console.log('  Checking time left for game:', url);
    const [p, isNew] = await sameOrNewPage(url);
    const dueDateOrg = await p.locator('.availability-date .tw-bold').innerText();
    const dueDate = new Date(Date.parse(dueDateOrg + ' 17:00'));
    const daysLeft = (dueDate.getTime() - Date.now())/1000/60/60/24;
    console.log(' ', await p.locator('.availability-date').innerText(), '->', daysLeft.toFixed(2));
    if (isNew) await p.close();
    return daysLeft > cfg.pg_timeLeft;
  }
  console.log('\nNumber of free unclaimed games (Prime Gaming):', internal.length);
  // claim games in internal store
  for (const card of internal) {
    await card.scrollIntoViewIfNeeded();
    const title = await (await card.$('.item-card-details__body__primary')).innerText();
    const slug = await (await card.$('a')).getAttribute('href');
    const url = offerUrl(slug, page.url());
    console.log('Current free game:', chalk.blue(title));
    if (cfg.pg_timeLeft && await skipBasedOnTime(url)) continue;
    if (cfg.dryrun) continue;
    if (cfg.interactive && !await confirm()) continue;
    await (await card.$('.tw-button:has-text("Claim"), .tw-button:has-text("Claim game"), button:has-text("Claim"), button:has-text("Claim game")')).click();
    db.data[user][title] ||= { title, time: datetime(), url, store: 'internal' };
    notify_games.push({ title, status: 'claimed', url });
    // const img = await (await card.$('img.tw-image')).getAttribute('src');
    // console.log('Image:', img);
    await card.screenshot({ path: screenshot('internal', `${filenamify(title)}.png`) });
  }
  console.log('\nNumber of free unclaimed games (external stores):', external.length);
  // claim games in external/linked stores. Linked: origin.com, epicgames.com; Redeem-key: gog.com, legacygames.com, microsoft
  const external_info = [];
  for (const card of external) { // need to get data incl. URLs in this loop and then navigate in another, otherwise .all() would update after coming back and .elementHandles() like above would lead to error due to page navigation: elementHandle.$: Protocol error (Page.adoptNode)
    const title = await card.locator('.item-card-details__body__primary').innerText();
    const slug = await card.locator('a:has-text("Claim")').first().getAttribute('href');
    const url = offerUrl(slug, page.url());
    // await (await card.$('text=Claim')).click(); // goes to URL of game, no need to wait
    external_info.push({ title, url });
  }
  // external_info = [ { title: 'Fallout 76 (XBOX)', url: 'https://gaming.amazon.com/fallout-76-xbox-fgwp/dp/amzn1.pg.item.9fe17d7b-b6c2-4f58-b494-cc4e79528d0b?ingress=amzn&ref_=SM_Fallout76XBOX_S01_FGWP_CRWN' } ];
  for (const { title, url } of external_info) {
    console.log('Current free game:', chalk.blue(title)); // , url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await throwIfPrimeErrorPage(page);
    if (cfg.debug) await page.pause();
    const item_text = await page.innerText('[data-a-target="DescriptionItemDetails"]');
    const store = storeFromItemDetails(item_text);
    console.log('  External store:', store);
    if (cfg.pg_timeLeft && await skipBasedOnTime(url)) continue;
    if (cfg.dryrun) continue;
    if (cfg.interactive && !await confirm()) continue;
    await claimExternalOffer(page);
    db.data[user][title] ||= { title, time: datetime(), url, store };
    db.data[user][title].url = url;
    db.data[user][title].store = store;
    const notify_game = { title, url };
    notify_games.push(notify_game); // status is updated below
    if (await page.locator('div:has-text("Link game account")').count() // TODO still needed? epic games store just has 'Link account' as the button text now.
       || await page.locator('div:has-text("Link account")').count()) {
      console.error('  Account linking is required to claim this offer!');
      notify_game.status = `failed: need account linking for ${store}`;
      db.data[user][title].status = 'failed: need account linking';
      // await page.pause();
      // await page.click('[data-a-target="LinkAccountModal"] [data-a-target="LinkAccountButton"]');
      // TODO login for epic games also needed if already logged in
      // wait for https://www.epicgames.com/id/authorize?redirect_uri=https%3A%2F%2Fservice.link.amazon.gg...
      // await page.click('button[aria-label="Allow"]');
    } else {
      db.data[user][title].status = 'claimed';
      // print code if there is one
      if (store in redeem) { // did not work for linked origin: && !await page.locator('div:has-text("Successfully Claimed")').count()
        const code = await Promise.any([page.inputValue('input[type="text"]'), page.textContent('[data-a-target="ClaimStateClaimCodeContent"]').then(s => s.replace('Your code: ', ''))]); // input: Legacy Games; text: gog.com
        console.log('  Code to redeem game:', chalk.blue(code));
        let redeem_url = db.data[user][title].redeem_url || redeem[store];
        if (store == 'legacy games') { // may be different URL like https://legacygames.com/primeday/puzzleoftheyear/
          redeem_url = await getLegacyRedeemUrl(page) || redeem_url; // full text may be: Click here to enter your redemption code.
        }
        const notify_redeem_url = store == 'gog.com' ? `${redeem_url}/${code}` : redeem_url; // can't use GOG URL for goto below (captcha)
        console.log('  URL to redeem game:', notify_redeem_url);
        db.data[user][title].code = code;
        db.data[user][title].redeem_url = redeem_url;
        await db.write();
        let redeem_action = 'redeem';
        if (cfg.pg_redeem) { // try to redeem keys on external stores
          try {
            const redeemed = await redeemCode(context, store, code, redeem_url, title);
            redeemed_codes.add(code);
            redeem_action = redeemed.action;
            db.data[user][title].status = redeemed.status;
            await db.write();
          } catch (error) {
            redeem_action = 'redeem (failed)';
            console.error('  Redeem failed:', error.message);
            await db.write();
          }
        }
        notify_game.status = `<a href="${notify_redeem_url}">${redeem_action}</a> ${code} on ${store}`;
      } else {
        notify_game.status = `claimed on ${store}`;
        db.data[user][title].status = 'claimed';
      }
      // save screenshot of potential code just in case
      await page.screenshot({ path: screenshot('external', `${filenamify(title)}.png`), fullPage: true });
      // console.info('  Saved a screenshot of page to', p);
    }
    // await page.pause();
  }
  if (cfg.pg_redeem) {
    const pending = Object.values(db.data[user])
      .filter(game => game.code && !redeemed_codes.has(game.code) && game.store in redeem && !isTerminalRedeemStatus(game.status));
    if (pending.length) console.log(`\nTrying to redeem ${pending.length} stored Prime Gaming code(s)...`);
    for (const game of pending) {
      console.log('Stored code:', chalk.blue(game.title), `(${game.store})`);
      if (game.url) game.url = offerUrl(game.url, page.url());
      let redeem_url = game.redeem_url || redeem[game.store];
      if (game.url && (game.store == 'legacy games' && isGenericLegacyRedeemUrl(redeem_url) || !game.store || !(game.store in redeem))) {
        const primePage = await context.newPage();
        try {
          await primePage.goto(game.url, { waitUntil: 'domcontentloaded' });
          await throwIfPrimeErrorPage(primePage);
          const item_text = await primePage.locator('[data-a-target="DescriptionItemDetails"]').innerText().catch(_ => undefined);
          if (item_text) {
            const actualStore = storeFromItemDetails(item_text);
            if (actualStore in redeem && actualStore != game.store) {
              console.log(`  Correcting stored external store from ${game.store} to ${actualStore}.`);
              game.store = actualStore;
              redeem_url = redeem[game.store];
            }
          }
          if (game.store == 'legacy games') redeem_url = await getLegacyRedeemUrl(primePage) || redeem_url;
        } catch (error) {
          console.error('  Could not refresh stored Prime offer page:', error.message);
        } finally {
          await primePage.close();
        }
      }
      game.redeem_url = redeem_url;
      await db.write();
      try {
        const redeemed = await redeemCode(context, game.store, game.code, redeem_url, game.title);
        redeemed_codes.add(game.code);
        game.status = redeemed.status;
        game.redeem_url = redeemed.redeem_url;
        await db.write();
      } catch (error) {
        console.error('  Redeem failed:', error.message);
        await db.write();
      }
    }
  }
  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' });
  await page.click('button[data-type="Game"]', { noWaitAfter: true }).catch(_ => { });
  await games.waitFor().catch(_ => { });

  if (notify_games.length) { // make screenshot of all games if something was claimed
    const p = screenshot(`${filenamify(datetime())}.png`);
    // await page.screenshot({ path: p, fullPage: true }); // fullPage does not make a difference since scroll not on body but on some element
    await scrollUntilStable(() => games.locator('.item-card__action').count());
    const viewportSize = page.viewportSize(); // current viewport size
    await page.setViewportSize({ ...viewportSize, height: 3000 }); // increase height, otherwise element screenshot is cut off at the top and bottom
    await games.screenshot({ path: p }); // screenshot of all claimed games
  }

  // https://github.com/vogler/free-games-claimer/issues/55
  if (cfg.pg_claimdlc) {
    console.log('Trying to claim in-game content...');
    await page.click('button[data-type="InGameLoot"]');
    const loot = page.locator('div[data-a-target="offer-list-IN_GAME_LOOT"]');
    await loot.waitFor();

    process.stdout.write('Loading all DLCs on page...');
    await scrollUntilStable(() => loot.locator('[data-a-target="item-card"]').count())

    console.log('\nNumber of already claimed DLC:', await loot.locator('p:has-text("Collected")').count());

    const cards = await loot.locator('[data-a-target="item-card"]:has(p:text-is("Claim"))').all();
    console.log('Number of unclaimed DLC:', cards.length);
    const dlcs = await Promise.all(cards.map(async card => ({
      game: await card.locator('.item-card-details__body p').innerText(),
      title: await card.locator('.item-card-details__body__primary').innerText(),
      url: offerUrl(await card.locator('a').first().getAttribute('href'), page.url()),
    })));
    // console.log(dlcs);

    const dlc_unlinked = {};
    for (const dlc of dlcs) {
      const title = `${dlc.game} - ${dlc.title}`;
      const url = dlc.url;
      console.log('Current DLC:', title);
      if (cfg.debug) await page.pause();
      if (cfg.dryrun) continue;
      if (cfg.interactive && !await confirm()) continue;
      db.data[user][title] ||= { title, time: datetime(), store: 'DLC', status: 'failed: need account linking' };
      const notify_game = { title, url };
      notify_games.push(notify_game); // status is updated below
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await throwIfPrimeErrorPage(page);
        // most games have a button 'Get in-game content'
        // epic-games: Fall Guys: Claim -> Continue -> Go to Epic Games (despite account linked and logged into epic-games) -> not tied to account but via some cookie?
        await Promise.any([page.click('.tw-button:has-text("Get in-game content")'), page.click('.tw-button:has-text("Claim your gift")'), page.click('.tw-button:has-text("Claim")').then(() => page.click('button:has-text("Continue")'))]);
        page.click('button:has-text("Continue")').catch(_ => { });
        const linkAccountButton = page.locator('[data-a-target="LinkAccountButton"]');
        let unlinked_store;
        if (await linkAccountButton.count()) {
          unlinked_store = await linkAccountButton.first().getAttribute('aria-label');
          console.debug('  LinkAccountButton label:', unlinked_store);
          const match = unlinked_store.match(/Link (.*) account/);
          if (match && match.length == 2) unlinked_store = match[1];
        } else if (await page.locator('text=Link game account').count()) { // epic-games only?
          console.error('  Missing account linking (epic-games specific button?):', await page.locator('button[data-a-target="gms-cta"]').innerText()); // TODO needed?
          unlinked_store = 'epic-games';
        }
        if (unlinked_store) {
          console.error('  Missing account linking:', unlinked_store, url);
          dlc_unlinked[unlinked_store] ??= [];
          dlc_unlinked[unlinked_store].push(title);
        } else {
          const code = await page.inputValue('input[type="text"]').catch(_ => undefined);
          console.log('  Code to redeem game:', chalk.blue(code));
          db.data[user][title].code = code;
          db.data[user][title].status = 'claimed';
          // notify_game.status = `<a href="${redeem[store]}">${redeem_action}</a> ${code} on ${store}`;
        }
        // await page.pause();
      } catch (error) {
        console.error(error);
      } finally {
        await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' });
        await page.click('button[data-type="InGameLoot"]');
      }
    }
    console.log('DLC: Unlinked accounts:', dlc_unlinked);
  }
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error); // .toString()?
  if (error.message && process.exitCode != 130) notify(`prime-gaming failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write(); // write out json db
  if (notify_games.length) { // list should only include claimed games
    notify(`prime-gaming (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
