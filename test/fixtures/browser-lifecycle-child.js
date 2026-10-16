import { chromium } from 'patchright';
import { firefox } from 'playwright-firefox';
import { withBrowser } from '../../src/browser-lifecycle.js';

const [engine, profile, mode = 'wait'] = process.argv.slice(2);
try {
  await withBrowser(engine === 'firefox' ? firefox : chromium, profile, { headless: true }, async context => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('about:blank');
    const persisted = (await context.cookies('https://lifecycle.invalid')).some(cookie => cookie.name === 'lifecycle' && cookie.value === 'preserved');
    await context.addCookies([{ name: 'lifecycle', value: 'preserved', domain: 'lifecycle.invalid', path: '/', expires: Math.floor(Date.now() / 1000) + 86400 }]);
    process.send({ ready: true, persisted });
    if (mode === 'fail') throw Error('fixture post-launch failure');
    await new Promise(resolve => {
      context.once('close', resolve);
      process.once('message', resolve);
    });
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
