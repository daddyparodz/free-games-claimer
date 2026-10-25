import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { stopBrowser } from '../src/browser-lifecycle.js';

const start = (engine, profile, mode) => {
  const child = fork(
    new URL('./fixtures/browser-lifecycle-child.js', import.meta.url),
    [engine, profile, ...(mode ? [mode] : [])],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let output = '';
  child.stdout.on('data', data => {
    output += data;
  });
  child.stderr.on('data', data => {
    output += data;
  });
  const exit = once(child, 'exit');
  const ready = Promise.race([
    once(child, 'message').then(([message]) => message),
    exit.then(([code]) => {
      throw Error(`Browser fixture exited before ready (${code}): ${output}`);
    }),
  ]);
  return { child, ready, exit, output: () => output };
};

for (const engine of ['chromium', 'firefox']) {
  test(
    `${engine}: real headless relaunch, independent browser, cookies, normal/error cleanup`,
    { timeout: 90000 },
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'fgc-real-lifecycle-'));
      const profile = path.join(dir, 'persistent');
      const unrelatedProfile = path.join(dir, 'unrelated');
      const children = [];
      const launch = (p, mode) => {
        const child = start(engine, p, mode);
        children.push(child);
        return child;
      };
      try {
        const unrelated = launch(unrelatedProfile);
        await unrelated.ready;
        const first = launch(profile);
        assert.equal((await first.ready).persisted, false);
        const second = launch(profile);
        assert.equal((await second.ready).persisted, true, 'graceful takeover must flush persistent cookies');
        assert.equal((await first.exit)[0], 0, first.output());
        assert.equal(unrelated.child.exitCode, null, 'unrelated browser must remain running');
        assert.equal(second.child.connected, true, `replacement disconnected: ${second.output()}`);
        await new Promise((resolve, reject) =>
          second.child.send('finish', error =>
            error ? reject(Error(`${error.message}: ${second.output()}`)) : resolve(),
          ),
        );
        assert.equal((await second.exit)[0], 0, second.output());
        await assert.rejects(access(path.join(profile, '.fgc-session.json')), { code: 'ENOENT' });
        const crashed = launch(profile);
        await crashed.ready;
        // Kill only this owned fixture Node process; exercise stale session metadata.
        crashed.child.kill();
        await crashed.exit;
        const failed = launch(profile, 'fail');
        assert.equal((await failed.ready).persisted, true);
        assert.equal((await failed.exit)[0], 1);
        const afterFailure = launch(profile);
        assert.equal((await afterFailure.ready).persisted, true);
        assert.equal(await stopBrowser(profile), true);
        assert.equal((await afterFailure.exit)[0], 0, afterFailure.output());
        unrelated.child.send('finish');
        assert.equal((await unrelated.exit)[0], 0, unrelated.output());
      } finally {
        for (const p of [profile, unrelatedProfile]) await stopBrowser(p).catch(() => {});
        for (const item of children) {
          if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill();
          await item.exit;
        }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    },
  );
}
