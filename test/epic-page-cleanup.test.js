import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { chromium } from 'patchright';
import { withEpicPage } from '../src/browser-page.js';

test(
  'Epic operations close their page before persistent shutdown without touching restored or manual pages',
  { timeout: 60000 },
  async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'fgc-epic-tabs-'));
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<h1>Local fake Epic</h1>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const options = { headless: true, channel: 'chromium', args: ['--restore-last-session'] };
    try {
      const seed = await chromium.launchPersistentContext(profile, options);
      try {
        await seed.pages()[0].goto(`${base}/manual-sentinel`);
        await seed.addCookies([{ name: 'fixture_auth', value: 'retained', url: base }]);
      } finally {
        await seed.close();
      }
      for (let run = 0; run < 2; run++) {
        const context = await chromium.launchPersistentContext(profile, options);
        try {
          await context
            .waitForEvent('page', { predicate: p => p.url() === `${base}/manual-sentinel`, timeout: 1000 })
            .catch(() => {});
          const sentinel = context.pages().find(p => p.url() === `${base}/manual-sentinel`);
          assert.ok(sentinel, 'manual sentinel actually restored');
          const operation = async page => {
            await page.goto(`${base}/fake-epic/product`);
            if (run) throw Error('checkout timeout');
            return 'already-owned';
          };
          if (run)
            await assert.rejects(withEpicPage(context, { width: 800, height: 600 }, operation), /checkout timeout/);
          else assert.equal(await withEpicPage(context, { width: 800, height: 600 }, operation), 'already-owned');
          assert.equal(sentinel.isClosed(), false);
          assert.equal(sentinel.url(), `${base}/manual-sentinel`);
          assert.equal(
            context.pages().filter(p => p.url().includes('/fake-epic/')).length,
            0,
            'completed/failed Epic page must not remain to be restored',
          );
          assert.equal(context.pages().length, 1, 'only unrelated sentinel remains on both launches');
          assert.equal((await context.cookies(base)).find(c => c.name === 'fixture_auth')?.value, 'retained');
          if (run) {
            await sentinel.close();
            assert.equal(context.pages().length, 0);
          }
        } finally {
          await context.close();
        }
      }
      const final = await chromium.launchPersistentContext(profile, options);
      try {
        assert.equal(
          (await final.cookies(base)).find(c => c.name === 'fixture_auth')?.value,
          'retained',
          'session authentication survives even when the final run page is closed',
        );
        assert.equal(final.pages().filter(p => p.url().includes('/fake-epic/')).length, 0);
      } finally {
        await final.close();
      }
    } finally {
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);
