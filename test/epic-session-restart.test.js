import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'patchright';
import { withBrowser } from '../src/browser-lifecycle.js';

async function checkRestart(restoreSession) {
  const source = await readFile(new URL('../epic-games.js', import.meta.url), 'utf8');
  const literal = source.match(/args:\s*(\[[\s\S]*?\])/)[1];
  const productionArgs = Array.from(vm.runInNewContext(literal));
  assert.ok(productionArgs.includes('--restore-last-session'));
  // Negative control changes only parsed test arguments, never production code.
  const args = restoreSession ? productionArgs : productionArgs.filter(arg => arg !== '--restore-last-session');
  const selection = source.match(/const page = (context\.pages\(\)\.length \? context\.pages\(\)\[0\] : await context\.newPage\(\));/);
  assert.ok(selection, 'exercise production startup page selection');
  let allowSignIn = true;
  let signInRequests = 0;
  let signInIssuances = 0;
  let loginRequests = 0;
  let renewals = 0;
  let initialProductExpiry;
  const profile = await mkdtemp(path.join(os.tmpdir(), 'fgc-epic-session-'));
  const server = http.createServer((req, res) => {
    const cookies = new Set((req.headers.cookie || '').split(/;\s*/));
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/sign-in') {
      signInRequests++;
      if (!allowSignIn) {
        res.writeHead(410);
        return res.end('Sign-in disabled');
      }
      signInIssuances++;
      res.setHeader('Set-Cookie', ['fixture_sso=original-sso; HttpOnly; Path=/', 'fixture_product=initial-product; Max-Age=3; HttpOnly; Path=/']);
      return res.end('Signed in');
    }
    if (req.url === '/inert/first' || req.url === '/inert/second') return res.end('Inert saved tab');
    if (req.url === '/product') {
      if (!cookies.has('fixture_product=renewed-product')) {
        res.writeHead(302, { Location: '/login' }); return res.end();
      }
      return res.end('Authenticated product');
    }
    if (req.url === '/login') {
      loginRequests++;
      if (!cookies.has('fixture_sso=original-sso')) {
        res.writeHead(401);
        return res.end('Sign in required');
      }
      renewals++;
      res.writeHead(302, { Location: '/product', 'Set-Cookie': 'fixture_product=renewed-product; Max-Age=60; HttpOnly; Path=/' });
      return res.end();
    }
    res.writeHead(404);
    res.end('Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await withBrowser(chromium, profile, { headless: true, channel: 'chromium', args }, async context => {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(`${base}/sign-in`);
      const cookies = await context.cookies(base);
      const sso = cookies.find(c => c.name === 'fixture_sso');
      assert.equal(sso?.value, 'original-sso');
      assert.equal(sso.expires, -1);
      const product = cookies.find(c => c.name === 'fixture_product');
      assert.equal(product?.value, 'initial-product');
      assert.ok(Number.isFinite(product.expires) && product.expires > Date.now() / 1000);
      initialProductExpiry = product.expires;
      allowSignIn = false;
      await context.newPage();
      // Saved tabs cannot issue cookies when Chromium restores them.
      await Promise.all(context.pages().map((tab, i) => tab.goto(`${base}/inert/${i === 0 ? 'first' : 'second'}`)));
      assert.equal(context.pages().length, 2);
      assert.ok(context.pages().every(tab => new URL(tab.url()).pathname.startsWith('/inert/')));
      assert.equal(signInIssuances, 1);
      assert.equal(loginRequests, 0);
    }); // withBrowser closes the context gracefully.
    const waitMs = Math.max(0, initialProductExpiry * 1000 - Date.now() + 1100);
    assert.ok(waitMs <= 6000, 'expiry wait must remain bounded');
    await new Promise(resolve => setTimeout(resolve, waitMs));
    assert.ok(Date.now() / 1000 > initialProductExpiry);
    await withBrowser(chromium, profile, { headless: true, channel: 'chromium', args }, async context => {
      // Read BEFORE navigation, so a restored page cannot manufacture success.
      const cookies = await context.cookies(base);
      const sso = cookies.find(c => c.name === 'fixture_sso');
      assert.equal(cookies.find(c => c.name === 'fixture_product'), undefined, 'expired product must be absent before navigation');
      if (restoreSession) {
        assert.equal(sso?.value, 'original-sso', 'original SSO must survive restart');
        assert.equal(sso.expires, -1, 'restored SSO must retain session expiry');
        const deadline = Date.now() + 5000;
        while (context.pages().filter(tab => tab.url().startsWith(`${base}/inert/`)).length < 2 && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(context.pages().filter(tab => tab.url().startsWith(`${base}/inert/`)).length, 2, 'prior tabs must actually restore');
      } else {
        assert.equal(sso, undefined, 'without restore flag session SSO must be lost');
      }
      assert.equal(signInRequests, 1, 'startup must not revisit sign-in');
      assert.equal(signInIssuances, 1, 'sign-in cannot reseed cookies');
      assert.equal(loginRequests, 0, 'startup must not renew cookies before navigation');
      const firstPage = context.pages()[0];
      const pageCount = context.pages().length;
      const page = await vm.runInNewContext(`(async () => (${selection[1]}))()`, { context });
      assert.equal(page, firstPage, 'production selection reuses first existing page');
      assert.equal(context.pages().length, pageCount, 'startup must not create another tab');
      const response = await page.goto(`${base}/product`);
      assert.equal(loginRequests, 1, 'expired product must make exactly one login request');
      assert.equal(renewals, restoreSession ? 1 : 0);
      const finalCookies = await context.cookies(base);
      const product = finalCookies.find(c => c.name === 'fixture_product');
      if (restoreSession) {
        assert.equal(product?.value, 'renewed-product', 'login must issue a distinct replacement cookie');
        assert.ok(Number.isFinite(product.expires) && product.expires > Date.now() / 1000 && product.expires > initialProductExpiry);
        const finalSso = finalCookies.find(c => c.name === 'fixture_sso');
        assert.equal(finalSso?.value, 'original-sso');
        assert.equal(finalSso.expires, -1);
        assert.equal(response.status(), 200);
        assert.equal(await page.locator('body').innerText(), 'Authenticated product');
        assert.equal(new URL(page.url()).pathname, '/product');
      } else {
        assert.equal(product, undefined, 'negative control cannot renew product auth');
        assert.equal(response.status(), 401);
        assert.equal(await page.locator('body').innerText(), 'Sign in required');
        assert.equal(new URL(page.url()).pathname, '/login');
      }
      assert.equal(signInRequests, 1);
      assert.equal(signInIssuances, 1);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
}

test('Epic browser can renew an expired product cookie through retained SSO after restart', { timeout: 30000 }, async () => {
  await checkRestart(true);
});

test('negative control: removing restore flag loses SSO and cannot authenticate after restart', { timeout: 30000 }, async () => {
  await checkRestart(false);
});
