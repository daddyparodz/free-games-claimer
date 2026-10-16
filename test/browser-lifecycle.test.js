import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { setTimeout as delay } from 'node:timers/promises';

// The fake launch seam keeps fast ownership tests independent of downloads.
test('failed graceful close retains ownership for a safe retry', async () => {
  const { withBrowser, stopBrowser } = await import('../src/browser-lifecycle.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fgc-close-failure-'));
  let attempts = 0;
  try {
    await assert.rejects(withBrowser({ async launchPersistentContext() {
      return { async close() {
        if (++attempts === 1) throw Error('close failed');
      } };
    } }, dir, {}, async () => {}), /close failed/);
    assert.equal(await stopBrowser(dir), true);
    assert.equal(attempts, 2);
  } finally {
    await stopBrowser(dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('wrong or reused owner token cannot close the current browser', async () => {
  const { withBrowser, stopBrowser } = await import('../src/browser-lifecycle.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fgc-token-'));
  let context;
  let closed = false;
  let ready;
  const started = new Promise(resolve => {
    ready = resolve;
  });
  const running = withBrowser({ async launchPersistentContext() {
    context = new EventEmitter();
    context.close = async () => {
      closed = true; context.emit('close');
    };
    return context;
  } }, dir, {}, ctx => new Promise(resolve => {
    ctx.once('close', resolve); ready();
  }));
  await started;
  const file = path.join(dir, '.fgc-session.json');
  const original = await readFile(file, 'utf8');
  try {
    await delay(30);
    assert.equal(closed, false, 'active manual challenge is not timed out by lifecycle');
    await writeFile(file, JSON.stringify({ ...JSON.parse(original), token: 'stale-token', pid: process.pid }));
    await assert.rejects(stopBrowser(dir), /owner changed/);
    assert.equal(closed, false, 'PID equality or stale metadata is not ownership');
  } finally {
    await writeFile(file, original);
    await stopBrowser(dir);
    await running;
    await rm(dir, { recursive: true, force: true });
  }
});

test('simultaneous first launches do not own the same profile concurrently', async () => {
  const { withBrowser } = await import('../src/browser-lifecycle.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fgc-race-'));
  let active = 0;
  let maxActive = 0;
  const engine = { async launchPersistentContext() {
    active++;
    maxActive = Math.max(maxActive, active);
    return { async close() {
      active--;
    } };
  } };
  try {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => withBrowser(engine, dir, {}, async () => {
      await delay(200);
    })));
    assert.equal(maxActive, 1);
    assert.equal(active, 0);
    assert.ok(results.some(result => result.status === 'fulfilled'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every scheduled claimer scopes all post-launch work for guaranteed cleanup', async () => {
  for (const name of ['epic-games', 'prime-gaming', 'gog', 'aliexpress']) {
    const source = await readFile(new URL(`../${name}.js`, import.meta.url), 'utf8');
    assert.match(source, /await withBrowser\(/, `${name} bypasses lifecycle`);
    assert.ok(source.trimEnd().endsWith('});'), `${name} leaves work outside lifecycle`);
  }
});

test('managed browser closes on success and on an exception', async () => {
  const lifecycle = await import('../src/browser-lifecycle.js').catch(() => ({}));
  assert.equal(typeof lifecycle.withBrowser, 'function', 'missing guaranteed browser lifecycle');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fgc-lifecycle-'));
  let closed = 0;
  const browserType = { async launchPersistentContext(profile) {
    assert.equal(profile, dir);
    const context = new EventEmitter();
    context.close = async () => {
      closed++; context.emit('close');
    };
    return context;
  } };
  try {
    assert.equal(await lifecycle.withBrowser(browserType, dir, {}, async () => 42), 42);
    assert.equal(closed, 1);
    await assert.rejects(lifecycle.withBrowser(browserType, dir, {}, async () => {
      throw Error('claim failed');
    }), /claim failed/);
    assert.equal(closed, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('relaunch closes only the previous same-profile browser before opening', async () => {
  const { withBrowser } = await import('../src/browser-lifecycle.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fgc-relaunch-'));
  const events = [];
  const contexts = [];
  const browserType = { async launchPersistentContext() {
    const id = contexts.length;
    events.push(`open${id}`);
    const context = new EventEmitter();
    let closed = false;
    context.close = async () => {
      if (closed) return;
      closed = true;
      await delay(30); // releasing a real profile is not instantaneous
      events.push(`close${id}`);
      context.emit('close');
    };
    contexts.push(context);
    return context;
  } };
  let ready;
  const started = new Promise(resolve => {
    ready = resolve;
  });
  const first = withBrowser(browserType, dir, {}, context => new Promise(resolve => {
    context.once('close', resolve);
    ready();
  }));
  try {
    await started;
    await withBrowser(browserType, dir, {}, async () => {});
    assert.deepEqual(events, ['open0', 'close0', 'open1', 'close1']);
    await first;
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await first;
    await rm(dir, { recursive: true, force: true });
  }
});
