import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import chalk from 'chalk';
import path from 'path';
import { existsSync, writeFileSync } from 'fs';
import { resolve, jsonDb, datetime, filenamify, prompt, notify, html_game_list, handleSIGINT } from './src/util.js';
import { cfg } from './src/config.js';

import { epicErrorKeepOpenSeconds, retainEpicFailure } from './src/epic-error-retention.js';
import { waitForPurchaseButton, waitForEpicCheckout, submitEpicFreeOrder, epicCheckoutAuthError } from './src/epic-purchase.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'epic-games', ...a);

const STORE_HOST = 'https://store.epicgames.com';
const URL_CLAIM = `${STORE_HOST}/free-games?lang=en-US`;
const URL_LOGIN = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=' + encodeURIComponent(URL_CLAIM);

const waitForEpicNavigation = async page => {
  try {
    await page.locator('egs-navigation').waitFor({ state: 'attached', timeout: Math.min(cfg.timeout, 15_000) });
  } catch {
    const body = await page.locator('body').innerText({ timeout: 3000 }).catch(_ => '');
    const compactBody = body.replace(/\s+/g, ' ').trim();
    const cloudflare = (/Enable JavaScript and cookies to continue|checking if the site connection is secure|one more step|security check to continue|session id|cloudflare|challenge/i).test(`${page.url()} ${compactBody}`);
    if (cloudflare) {
      if (!cfg.headless) {
        console.error(`Epic security check detected. Waiting up to ${cfg.login_timeout / 1000} seconds for it to be completed in the browser.`);
        await notify('epic-games: security check detected. Complete it in the visible browser.').catch(_ => { });
        const navigation = page.locator('egs-navigation');
        if (await navigation.waitFor({ state: 'attached', timeout: cfg.login_timeout }).then(() => true).catch(_ => false)) return;
      }
      throw new Error(`Epic Store security check did not clear. Open the browser with SHOW=1, complete the check, then retry. URL: ${page.url()}`);
    }
    throw new Error(`Epic Store navigation did not load. URL: ${page.url()}. Page text: ${compactBody.slice(0, 500)}`);
  }
};

const getLoginState = async page => {
  await waitForEpicNavigation(page);
  const nav = page.locator('egs-navigation').first();
  return {
    isLoggedIn: await nav.getAttribute('isloggedin') == 'true',
    displayName: await nav.getAttribute('displayname'),
  };
};

const clickIfVisible = async (locator, options = {}) => {
  const first = locator.first();
  if (!await first.isVisible().catch(_ => false)) return false;
  await first.click(options);
  return true;
};

const clickFirstVisible = async (page, selectors, options = {}) => {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(_ => false)) {
      await locator.click(options);
      return;
    }
  }
  throw new Error(`None of these selectors were visible: ${selectors.join(', ')}`);
};

const getCurrentFreeGameUrlsFromApi = async () => {
  const params = new URLSearchParams({ locale: 'en-US', country: cfg.eg_country, allowCountries: cfg.eg_country });
  const response = await fetch(`https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?${params}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const body = await response.json();
  const now = new Date();
  const slug = ({ catalogNs, offerMappings, productSlug, urlSlug }) => catalogNs?.mappings?.find(m => m.pageType == 'productHome')?.pageSlug ?? catalogNs?.mappings?.[0]?.pageSlug
    ?? offerMappings?.find(m => m.pageType == 'productHome')?.pageSlug ?? offerMappings?.[0]?.pageSlug
    ?? productSlug?.replace(/\/home$/, '')
    ?? urlSlug;
  const urls = (body.data?.Catalog?.searchStore?.elements ?? [])
    .filter(e => e.promotions?.promotionalOffers?.some(({ promotionalOffers }) => promotionalOffers?.some(({ startDate, endDate, discountSetting }) => discountSetting?.discountPercentage == 0 && new Date(startDate) <= now && now <= new Date(endDate))))
    .map(slug)
    .filter(Boolean)
    .map(s => `${STORE_HOST}/p/${s}`);
  return [...new Set(urls)];
};

const getCurrentFreeGameUrlsFromPage = async page => {
  const game_loc = page.locator('a:has(span:text-is("Free Now"))');
  await game_loc.last().waitFor().catch(_ => {
    // rarely there are no free games available -> catch Timeout
    // TODO would be better to wait for alternative like 'coming soon' instead of waiting for timeout
    // see https://github.com/vogler/free-games-claimer/issues/210#issuecomment-1727420943
    console.error('Seems like currently there are no free games available in your region...');
  });
  const urlSlugs = await Promise.all((await game_loc.elementHandles()).map(a => a.getAttribute('href')));
  return [...new Set(urlSlugs.filter(Boolean).map(s => new URL(s, STORE_HOST).href))];
};

const getCurrentFreeGameUrls = async page => {
  try {
    const urls = await getCurrentFreeGameUrlsFromApi();
    if (urls.length) return urls;
    console.error(`Epic promotions API returned no current free games for country ${cfg.eg_country}; falling back to page UI.`);
  } catch (error) {
    console.error(`Failed to read Epic promotions API for country ${cfg.eg_country}:`, error.message);
  }
  return getCurrentFreeGameUrlsFromPage(page);
};

console.log(datetime(), 'started checking epic-games');

const db = await jsonDb('epic-games.json', {});

if (cfg.time) console.time('startup');

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await chromium.launchPersistentContext(cfg.epic_browser_dir, {
  // Epic fingerprints regular Playwright and headless browsers. Patchright's
  // headed Chromium is the upstream project's current mitigation.
  headless: false,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/eg-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
  args: [
    '--hide-crash-restore-bubble',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
  ],
});

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it

// some debug info about the page (screen dimensions, user agent, platform)
// eslint-disable-next-line no-undef
if (cfg.debug) console.debug(await page.evaluate(() => [(({ width, height, availWidth, availHeight }) => ({ width, height, availWidth, availHeight }))(window.screen), navigator.userAgent, navigator.platform, navigator.vendor])); // deconstruct screen needed since `window.screen` prints {}, `window.screen.toString()` '[object Screen]', and can't use some pick function without defining it on `page`
if (cfg.debug_network) {
  // const filter = _ => true;
  const filter = r => r.url().includes('store.epicgames.com');
  page.on('request', request => filter(request) && console.log('>>', request.method(), request.url()));
  page.on('response', response => filter(response) && console.log('<<', response.status(), response.url()));
}

const notify_games = [];
let user;
let epicFailure = false;

try {
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' }, // Accept cookies to get rid of banner to save space on screen. Set accept time to 5 days ago.
    { name: 'HasAcceptedAgeGates', value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18', domain: 'store.epicgames.com', path: '/' }, // gets rid of 'To continue, please provide your date of birth', https://github.com/vogler/free-games-claimer/issues/275, USK number doesn't seem to matter, cookie from 'Fallout 3: Game of the Year Edition'
  ]);

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // 'domcontentloaded' faster than default 'load' https://playwright.dev/docs/api/class-page#page-goto

  if (cfg.time) console.timeEnd('startup');
  if (cfg.time) console.time('login');

  // page.click('button:has-text("Accept All Cookies")').catch(_ => { }); // Not needed anymore since we set the cookie above. Clicking this did not always work since the message was animated in too slowly.
  await clickIfVisible(page.locator('button:has-text("Continue")')); // accept updated Epic privacy policy if shown

  let loginState = await getLoginState(page);
  while (!loginState.isLoggedIn) {
    console.error('Not signed in anymore. Please login in the browser or here in the terminal.');
    if (cfg.novnc_port) console.info(`Open http://localhost:${cfg.novnc_port} to login inside the docker container.`);
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    if (cfg.eg_browser_login) {
      console.info('Complete the one-time Epic sign-in in the visible Chromium window.');
      await notify('epic-games: one-time Chromium sign-in is required in the visible browser.').catch(_ => { });
      await page.waitForURL('**/free-games**', { timeout: cfg.login_timeout });
      if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
      loginState = await getLoginState(page);
      continue;
    }
    if (cfg.eg_email && cfg.eg_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const notifyBrowserLogin = async () => {
      console.log('Waiting for you to login in the browser.');
      await notify('epic-games: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node epic-games` to login in the opened browser.');
        await context.close(); // finishes potential recording
        process.exit(1);
      }
    };
    const email = cfg.eg_email || await prompt({ message: 'Enter email' });
    if (!email) await notifyBrowserLogin();
    else {
      // await page.click('text=Sign in with Epic Games');
      page.waitForSelector('.h_captcha_challenge iframe').then(async () => {
        console.error('Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours.');
        await notify('epic-games: got captcha during login. Please check.');
      }).catch(_ => { });
      page.waitForSelector('p:has-text("Incorrect response.")').then(async () => {
        console.error('Incorrect response for captcha!');
      }).catch(_ => { });
      await page.fill('#email', email);
      await clickIfVisible(page.locator('button#continue')); // current login is two-step; older one-page login skips this
      const password = email && (cfg.eg_password || await prompt({ type: 'password', message: 'Enter password' }));
      if (!password) await notifyBrowserLogin();
      else {
        await page.locator('#password').waitFor({ state: 'visible' }).catch(_ => { });
        await page.fill('#password', password);
        await clickFirstVisible(page, ['button#sign-in', 'button[type="submit"]']);
      }
      const error = page.locator('#form-error-message');
      error.waitFor().then(async () => {
        console.error('Login error:', await error.innerText());
        console.log('Please login in the browser!');
      }).catch(_ => { });
      // handle MFA, but don't await it
      page.waitForURL('**/id/login/mfa**').then(async () => {
        console.log('Enter the security code to continue - This appears to be a new device, browser or location. A security code has been sent to your email address at ...');
        // TODO locator for text (email or app?)
        const otp = cfg.eg_otpkey && authenticator.generate(cfg.eg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await page.locator('input[name="code-input-0"]').pressSequentially(otp.toString());
        await page.click('button[type="submit"]');
      }).catch(_ => { });
    }
    await page.waitForURL('**/free-games**');
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
    loginState = await getLoginState(page);
  }
  user = loginState.displayName; // 'null' if !isloggedin
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};
  if (cfg.time) console.timeEnd('login');
  if (cfg.time) console.time('claim all games');

  // Prefer Epic's promotion API; fall back to the current page cards if it changes or is unavailable.
  const urls = await getCurrentFreeGameUrls(page);
  console.log('Free games:', urls);

  for (const url of urls) {
    if (cfg.time) console.time('claim game');
    await page.goto(url); // , { waitUntil: 'domcontentloaded' });
    const purchaseBtn = await waitForPurchaseButton(page);
    const btnText = (await purchaseBtn.innerText()).toLowerCase(); // barrier to block until page is loaded

    // click Continue if 'This game contains mature content recommended only for ages 18+'
    if (await page.locator('button:has-text("Continue")').count() > 0) {
      console.log('  This game contains mature content recommended only for ages 18+');
      if (await page.locator('[data-testid="AgeSelect"]').count()) {
        console.error('  Got "To continue, please provide your date of birth" - This shouldn\'t happen due to cookie set above. Please report to https://github.com/vogler/free-games-claimer/issues/275');
        await page.locator('#month_toggle').click();
        await page.locator('#month_menu li:has-text("01")').click();
        await page.locator('#day_toggle').click();
        await page.locator('#day_menu li:has-text("01")').click();
        await page.locator('#year_toggle').click();
        await page.locator('#year_menu li:has-text("1987")').click();
      }
      await page.click('button:has-text("Continue")', { delay: 111 });
      await page.waitForTimeout(2000);
    }

    let title;
    let bundle_includes;
    if (await page.locator('span:text-is("About Bundle")').count()) {
      title = await page.locator('h1').first().innerText();
      // h1 first didn't exist for bundles but now it does... However h1 would e.g. be 'Fallout® Classic Collection' instead of 'Fallout Classic Collection'
      try {
        bundle_includes = await Promise.all((await page.locator('.product-card-top-row h5').all()).map(b => b.innerText()));
      } catch (e) {
        console.error('Failed to get "Bundle Includes":', e);
      }
    } else {
      title = await page.locator('h1').first().innerText();
    }
    const game_id = page.url().split('/').pop();
    const existedInDb = db.data[user][game_id];
    db.data[user][game_id] ||= { title, time: datetime(), url: page.url() }; // this will be set on the initial run only!
    console.log('Current free game:', chalk.blue(title));
    if (bundle_includes) console.log('  This bundle includes:', bundle_includes);
    const notify_game = { title, url, status: 'failed' };
    notify_games.push(notify_game); // status is updated below

    if (btnText == 'in library') {
      console.log('  Already in library! Nothing to claim.');
      if (!existedInDb) await notify(`Game already in library: ${url}`);
      notify_game.status = 'existed';
      db.data[user][game_id].status ||= 'existed'; // does not overwrite claimed or failed
      if (db.data[user][game_id].status.startsWith('failed')) db.data[user][game_id].status = 'manual'; // was failed but now it's claimed
    } else if (btnText == 'requires base game') {
      console.log('  Requires base game! Nothing to claim.');
      notify_game.status = 'requires base game';
      db.data[user][game_id].status ||= 'failed:requires-base-game';
      // TODO claim base game if it is free
      const baseUrl = 'https://store.epicgames.com' + await page.locator('a:has-text("Overview")').getAttribute('href');
      console.log('  Base game:', baseUrl);
      // await page.click('a:has-text("Overview")');
      // TODO handle this via function call for base game above since this will never terminate if DRYRUN=1
      urls.push(baseUrl); // add base game to the list of games to claim
      urls.push(url); // add add-on itself again
    } else { // GET
      console.log('  Not in library yet! Click', btnText);
      await purchaseBtn.click({ delay: 11 }); // got stuck here without delay (or mouse move), see #75, 1ms was also enough

      // click Continue if 'Device not supported. This product is not compatible with your current device.' - avoided by Windows userAgent?
      page.click('button:has-text("Continue")').catch(_ => { }); // needed since change from Chromium to Firefox?

      // click 'Yes, buy now' if 'This edition contains something you already have. Still interested?'
      page.click('button:has-text("Yes, buy now")').catch(_ => { });

      // Accept End User License Agreement (only needed once)
      page.locator(':has-text("end user license agreement")').waitFor().then(async () => {
        console.log('  Accept End User License Agreement (only needed once)');
        console.log(page.innerHTML);
        console.log('Please report the HTML above here: https://github.com/vogler/free-games-claimer/issues/371');
        await page.locator('input#agree').check(); // TODO Bundle: got stuck here; likely unrelated to bundle and locator just changed: https://github.com/vogler/free-games-claimer/issues/371
        await page.locator('button:has-text("Accept")').click();
      }).catch(_ => { });

      // it then creates an iframe for the purchase
      const iframe = await waitForEpicCheckout(page, cfg.timeout);
      // skip game if unavailable in region, https://github.com/vogler/free-games-claimer/issues/46 TODO check games for account's region
      if (await iframe.locator(':has-text("unavailable in your region")').count() > 0) {
        console.error('  This product is unavailable in your region!');
        db.data[user][game_id].status = notify_game.status = 'unavailable-in-region';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      iframe.locator('.payment-pin-code').waitFor().then(async () => {
        if (!cfg.eg_parentalpin) {
          console.error('  EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
          notify('epic-games: EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
        }
        await iframe.locator('input.payment-pin-code__input').first().pressSequentially(cfg.eg_parentalpin);
        await iframe.locator('button:has-text("Continue")').click({ delay: 11 });
      }).catch(_ => { });

      if (cfg.debug) await page.pause();
      if (cfg.dryrun) {
        console.log('  DRYRUN=1 -> Skip order!');
        notify_game.status = 'skipped';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      // One awaited order flow handles the current checkout and EU confirmation.
      // It resumes after human CAPTCHA completion without clicking the challenge.
      try {
        // context.setDefaultTimeout(100 * 1000); // give time to solve captcha, iframe goes blank after 60s?
        const captcha = iframe.locator('#h_captcha_challenge_checkout_free_prod iframe');
        captcha.waitFor().then(async () => { // don't await, since element may not be shown
          // console.info('  Got hcaptcha challenge! NopeCHA extension will likely solve it.')
          console.error('  Got hcaptcha challenge! Lost trust due to too many login attempts? You can solve the captcha in the browser or get a new IP address.');
          // await notify(`epic-games: got captcha challenge right before claim of <a href="${url}">${title}</a>. Use VNC to solve it manually.`); // TODO not all apprise services understand HTML: https://github.com/vogler/free-games-claimer/pull/417
          await notify(`epic-games: got captcha challenge for.\nGame link: ${url}`);
          // TODO could even create purchase URL, see https://github.com/vogler/free-games-claimer/pull/130
          // await page.waitForTimeout(2000);
          // const p = path.resolve(cfg.dir.screenshots, 'epic-games', 'captcha', `${filenamify(datetime())}.png`);
          // await captcha.screenshot({ path: p });
          // console.info('  Saved a screenshot of hcaptcha challenge to', p);
          // console.error('  Got hcaptcha challenge. To avoid it, get a link from https://www.hcaptcha.com/accessibility'); // TODO save this link in config and visit it daily to set accessibility cookie to avoid captcha challenge?
        }).catch(_ => { }); // may time out if not shown
        iframe.locator('.payment__errors:has-text("Failed to challenge captcha, please try again later.")').waitFor().then(async () => {
          console.error('  Failed to challenge captcha, please try again later.');
          await notify('epic-games: failed to challenge captcha. Please check.');
        }).catch(_ => { });
        const successState = await submitEpicFreeOrder(page, iframe, { timeout: cfg.timeout, manualTimeout: 600000 });
        await page.goto(url);
        await page.getByRole('button', { name: /^In Library$/i }).waitFor({ state: 'visible', timeout: cfg.timeout });
        db.data[user][game_id].status = 'claimed';
        db.data[user][game_id].time = datetime(); // claimed time overwrites failed/dryrun time
        console.log(`  Claimed successfully! (${successState})`);
        // context.setDefaultTimeout(cfg.timeout);
      } catch (e) {
        epicFailure = true;
        process.exitCode ||= 1;
        console.log(e);
        // console.error('  Failed to claim! Try again if NopeCHA timed out. Click the extension to see if you ran out of credits (refill after 24h). To avoid captchas try to get a new IP or set a cookie from https://www.hcaptcha.com/accessibility');
        console.error('  Failed to claim! To avoid captchas try to get a new IP address.');
        const p = screenshot('failed', `${game_id}_${filenamify(datetime())}.png`);
        await page.screenshot({ path: p, fullPage: true });
        db.data[user][game_id].status = 'failed';
      }
      notify_game.status = db.data[user][game_id].status; // claimed or failed

      const p = screenshot(`${game_id}.png`);
      if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false }); // fullPage is quite long...
    }
    if (cfg.time) console.timeEnd('claim game');
  }
  if (cfg.time) console.timeEnd('claim all games');
} catch (error) {
  epicFailure = true;
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error); // .toString()?
  if (error.message && process.exitCode != 130) await notify(`epic-games failed: ${error.message.split('\n')[0]}`);
} finally {
  try {
    await db.write(); // write out json db
    if (notify_games.filter(g => g.status == 'claimed' || g.status == 'failed').length) {
      await notify(`epic-games (${user}):<br>${html_game_list(notify_games)}`);
    }
  } catch (error) {
    epicFailure = true;
    process.exitCode ||= 1;
    console.error('Epic result persistence/notification failed:', error.message);
  }
}
if (cfg.debug) writeFileSync(path.resolve(cfg.dir.browser, 'cookies.json'), JSON.stringify(await context.cookies()));
if (page.video()) console.log('Recorded video:', await page.video().path());
if (epicFailure && process.exitCode != 130) {
  const seconds = epicErrorKeepOpenSeconds(process.env.EG_ERROR_KEEP_OPEN_SECONDS);
  console.error(`Epic failed: capturing evidence; browser stays open for ${seconds} seconds (EG_ERROR_KEEP_OPEN_SECONDS, max 1800). Action timeout unchanged; no automatic order retry.`);
  await retainEpicFailure({
    seconds,
    capture: async () => {
      const stamp = filenamify(datetime());
      await page.screenshot({ path: screenshot('failed', `error-${stamp}.png`), timeout: 10000 }).catch(() => {});
      const safeUrl = value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return 'unknown'; } };
      const evidence = [];
      for (const frame of page.frames()) {
        evidence.push({ url: safeUrl(frame.url()), buttons: await frame.locator('button').evaluateAll(elements => elements.map(element => ({ text: element.textContent.trim().replace(/\s+/g, ' ').slice(0, 100), disabled: element.disabled, visible: !!element.getClientRects().length }))).catch(() => []) });
      }
      writeFileSync(screenshot('failed', `error-${stamp}.json`), JSON.stringify(evidence, null, 2));
    },
    wait: ms => new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      context.once('close', () => { clearTimeout(timer); resolve(); });
    }),
    close: () => context.close(),
  });
} else await context.close();
