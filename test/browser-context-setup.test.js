import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as util from '../src/util.js';

for (const debug of [false, true]) {
  test(`browser setup preserves SIGINT and default timeout behavior, debug=${debug}`, () => {
    const before = process.listeners('SIGINT');
    const timeouts = [];
    try {
      util.configureBrowserContext({ setDefaultTimeout: value => timeouts.push(value) }, { debug, timeout: 1234 });
      assert.equal(process.listeners('SIGINT').length, before.length + 1);
      assert.deepEqual(timeouts, debug ? [] : [1234]);
    } finally {
      for (const listener of process.listeners('SIGINT')) {
        if (!before.includes(listener)) process.removeListener('SIGINT', listener);
      }
    }
  });
}
