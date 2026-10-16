import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lifecycle from '../src/epic-error-retention.js';

test('captures evidence before bounded error retention and close', async () => {
  const events = [];
  await lifecycle.retainEpicFailure({ capture: async () => events.push('capture'), wait: async ms => events.push(ms), close: async () => events.push('close'), seconds: 600 });
  assert.deepEqual(events, ['capture', 600000, 'close']);
});
test('capture failure cannot prevent graceful close', async () => {
  const events = [];
  await lifecycle.retainEpicFailure({ capture: async () => {
    throw Error('capture');
  },
  wait: async ms => events.push(ms),
  close: async () => events.push('close'),
  seconds: 0 });
  assert.deepEqual(events, ['close']);
});
test('finished failures close by default; diagnostic retention is opt-in', async () => {
  assert.equal(lifecycle.epicErrorKeepOpenSeconds(undefined), 0);
  assert.equal(lifecycle.epicErrorKeepOpenSeconds(''), 0);
  const events = [];
  await lifecycle.retainEpicFailure({ capture: async () => events.push('capture'), wait: async () => events.push('wait'), close: async () => events.push('close') });
  assert.deepEqual(events, ['capture', 'close']);
});
test('retention rejects unbounded or invalid configuration', () => {
  for (const value of ['Infinity', '-1', 'bad'])assert.equal(lifecycle.epicErrorKeepOpenSeconds(value), 0);
  assert.equal(lifecycle.epicErrorKeepOpenSeconds('0'), 0);
  assert.equal(lifecycle.epicErrorKeepOpenSeconds('999999'), 1800);
});
