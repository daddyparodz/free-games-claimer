/* eslint-env es2021 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getGogSession } from '../src/page-state.js';

function mockClock(t) {
  let now = Date.UTC(2026, 9, 21);
  const delays = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    delays.push(delay);
    now += delay;
    callback();
  });
  return delays;
}

const response = (status, headers = {}) => ({
  ok: () => status === 200,
  status: () => status,
  headers: () => headers,
  json: async () => ({ isLoggedIn: true, username: 'fixture-user' }),
  dispose: async () => {},
});

test('disposal rejection preserves HTTP 503 and permits bounded recovery', async () => {
  let calls = 0;
  const context = {
    request: {
      get: async () => {
        calls++;
        return {
          ...response(calls < 3 ? 503 : 200, { 'retry-after': '0' }),
          dispose: async () => {
            throw new Error('cleanup failed');
          },
        };
      },
    },
  };
  assert.equal((await getGogSession(context)).isLoggedIn, true);
  assert.equal(calls, 3);
  calls = 0;
  context.request.get = async () => {
    calls++;
    return {
      ...response(503, { 'retry-after': '0' }),
      dispose: async () => {
        throw new Error('cleanup failed');
      },
    };
  };
  await assert.rejects(getGogSession(context), /GOG userData.json returned HTTP 503/);
  assert.equal(calls, 3);
});

for (const overshoot of [100, 101]) {
  test(`timer reaching the deadline by ${overshoot} ms preserves HTTP 503 without another GET`, async t => {
    let now = 0;
    let calls = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'setTimeout', callback => {
      now += overshoot;
      callback();
    });
    const context = {
      request: {
        get: async () => {
          calls++;
          if (calls > 1) throw new Error('unexpected late GET');
          return response(503, { 'retry-after': '0' });
        },
      },
    };
    await assert.rejects(getGogSession(context, 100), /GOG userData.json returned HTTP 503/);
    assert.equal(calls, 1);
  });
}

for (const retryAfter of [
  undefined,
  '-1',
  '0.5',
  '1.5',
  '01/02/2000',
  '2026-10-21',
  'garbage',
  'Mon, 30 Feb 2026 00:00:00 GMT',
  'Monday, 30-Feb-26 00:00:00 GMT',
  'Mon Feb 30 00:00:00 2026',
  'Sun, 29 Feb 2026 00:00:00 GMT',
  'Sunday, 29-Feb-26 00:00:00 GMT',
  'Sun Feb 29 00:00:00 2026',
  'Wed, 00 Oct 2026 00:00:00 GMT',
  'Wednesday, 32-Oct-26 00:00:00 GMT',
  'Wed Oct 32 00:00:00 2026',
  'Wed, 21 Oct 2026 24:00:00 GMT',
  'Wednesday, 21-Oct-26 00:60:00 GMT',
  'Wed Oct 21 00:00:60 2026',
]) {
  test(`invalid or missing Retry-After uses fallback: ${retryAfter}`, async t => {
    const delays = mockClock(t);
    let calls = 0;
    const context = { request: { get: async () => response(++calls < 3 ? 503 : 200, { 'retry-after': retryAfter }) } };
    await getGogSession(context, 5000);
    assert.deepEqual(delays, [1000, 2000]);
    assert.equal(calls, 3);
  });
}

for (const retryAfter of [
  '0',
  '000',
  'Wed, 21 Oct 2026 00:00:00 GMT',
  'Wednesday, 21-Oct-26 00:00:00 GMT',
  'Wed Oct 21 00:00:00 2026',
]) {
  test(`valid zero or past HTTP-date retries immediately: ${retryAfter}`, async t => {
    t.mock.method(Date, 'now', () => Date.UTC(2026, 9, 22));
    const delays = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
      delays.push(delay);
      callback();
    });
    let calls = 0;
    const context = {
      request: { get: async () => response(++calls === 1 ? 503 : 200, { 'retry-after': retryAfter }) },
    };
    await getGogSession(context, 100);
    assert.deepEqual(delays, [0]);
    assert.equal(calls, 2);
  });
}

for (const retryAfter of [
  'Wed, 21 Oct 2026 00:00:02 GMT',
  'Wednesday, 21-Oct-26 00:00:02 GMT',
  'Wed Oct 21 00:00:02 2026',
]) {
  test(`future HTTP-date waits two UTC seconds under Europe/Rome: ${retryAfter}`, async t => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Europe/Rome';
    t.after(() => {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    });
    const delays = mockClock(t);
    let calls = 0;
    const context = {
      request: { get: async () => response(++calls === 1 ? 503 : 200, { 'retry-after': retryAfter }) },
    };
    await getGogSession(context, 5000);
    assert.deepEqual(delays, [2000]);
    assert.equal(calls, 2);
  });
}

for (const retryAfter of ['9'.repeat(400), '1']) {
  test(`Retry-After at or beyond budget never sleeps: ${retryAfter.length}`, async t => {
    t.mock.method(Date, 'now', () => 0);
    t.mock.method(globalThis, 'setTimeout', () => assert.fail('must not sleep'));
    let calls = 0;
    const context = {
      request: {
        get: async () => {
          calls++;
          return response(503, { 'retry-after': retryAfter });
        },
      },
    };
    await assert.rejects(getGogSession(context, 1000), /HTTP 503/);
    assert.equal(calls, 1);
  });
}

for (const after503 of [false, true]) {
  test(`network exceptions are not retried, after503=${after503}`, async () => {
    let calls = 0;
    const cause = new Error('fixture network failure');
    const context = {
      request: {
        get: async () => {
          calls++;
          if (after503 && calls === 1) return response(503, { 'retry-after': '0' });
          throw cause;
        },
      },
    };
    await assert.rejects(
      getGogSession(context),
      error => error.message === 'Could not read GOG login state from userData.json' && error.cause === cause,
    );
    assert.equal(calls, after503 ? 2 : 1);
  });
}

test('non-503 disposal failure retains HTTP status without retry', async () => {
  let calls = 0;
  const context = {
    request: {
      get: async () => {
        calls++;
        return {
          ...response(403),
          dispose: async () => {
            throw new Error('cleanup');
          },
        };
      },
    },
  };
  await assert.rejects(getGogSession(context), /HTTP 403/);
  assert.equal(calls, 1);
});

test('initial GOG session read recovers from the observed HTTP 503 without entering login or claim', async () => {
  const calls = [];
  const context = {
    request: {
      get: async (url, options) => {
        calls.push({ url, options });
        return response(calls.length === 1 ? 503 : 200, { 'retry-after': '0' });
      },
    },
  };
  assert.deepEqual(await getGogSession(context), { isLoggedIn: true, username: 'fixture-user' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url === 'https://www.gog.com/userData.json'));
  assert.ok(calls.every(call => call.options.headers['Cache-Control'] === 'no-cache'));
});

for (const status of [401, 403, 429, 500]) {
  test(`GOG HTTP ${status} is not retried or interpreted as signed out`, async () => {
    let calls = 0;
    const context = {
      request: {
        get: async () => {
          calls++;
          return response(status);
        },
      },
    };
    await assert.rejects(getGogSession(context), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  });
}

test('persistent GOG 503 remains an error after exactly three reads and releases responses', async () => {
  let calls = 0;
  let disposed = 0;
  const context = {
    request: {
      get: async () => {
        calls++;
        return {
          ...response(503, { 'retry-after': '0' }),
          dispose: async () => {
            disposed++;
          },
        };
      },
    },
  };
  await assert.rejects(getGogSession(context), /GOG userData.json returned HTTP 503/);
  assert.equal(calls, 3);
  assert.equal(disposed, 3);
});

for (const retryAfter of ['60', new Date(Date.now() + 60_000).toUTCString()]) {
  test(`Retry-After beyond the request budget fails rather than retrying early: ${retryAfter}`, async () => {
    let calls = 0;
    const context = {
      request: {
        get: async () => {
          calls++;
          return response(503, { 'retry-after': retryAfter });
        },
      },
    };
    await assert.rejects(getGogSession(context, 100), /HTTP 503/);
    assert.equal(calls, 1);
  });
}

test('missing Retry-After uses backoff and retains the shared request budget', async () => {
  const timeouts = [];
  const started = Date.now();
  const context = {
    request: {
      get: async (_, options) => {
        timeouts.push(options.timeout);
        return response(timeouts.length === 1 ? 503 : 200);
      },
    },
  };
  await getGogSession(context, 2000);
  assert.equal(timeouts.length, 2);
  assert.ok(Date.now() - started >= 950);
  assert.ok(timeouts[1] < timeouts[0] - 900);
});

test('signed out and invalid JSON preserve their original meanings without retry', async () => {
  let calls = 0;
  const context = {
    request: {
      get: async () => {
        calls++;
        return { ...response(200), json: async () => ({ isLoggedIn: false }) };
      },
    },
  };
  assert.equal((await getGogSession(context)).isLoggedIn, false);
  assert.equal(calls, 1);
  context.request.get = async () => ({
    ...response(200),
    json: async () => {
      throw new Error('invalid');
    },
  });
  await assert.rejects(getGogSession(context), /returned invalid JSON/);
});
