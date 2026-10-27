import test from 'node:test';
import assert from 'node:assert/strict';
import { withEpicPage } from '../src/browser-page.js';

for (const outcome of ['success', 'already-owned', 'error', 'timeout', 'viewport']) {
  test(`Epic run page is closed after ${outcome}, not during the operation`, async () => {
    const failure = Error(outcome);
    let closed = false;
    const page = {
      url: () => 'about:blank',
      setViewportSize: async () => {
        if (outcome === 'viewport') throw failure;
      },
      close: async () => {
        closed = true;
      },
    };
    const result = withEpicPage({ pages: () => [page] }, { width: 800, height: 600 }, async selected => {
      assert.equal(selected, page);
      assert.equal(closed, false, 'active login/checkout remains available until callback settles');
      if (['error', 'timeout'].includes(outcome)) throw failure;
      return outcome;
    });
    if (['error', 'timeout', 'viewport'].includes(outcome)) await assert.rejects(result, error => error === failure);
    else assert.equal(await result, outcome);
    assert.equal(closed, true);
  });
}

test('Epic page close failure does not mask checkout failure or expose its URL', async t => {
  const failure = Error('checkout failed');
  const logs = [];
  t.mock.method(console, 'error', message => logs.push(message));
  const page = {
    url: () => 'about:blank',
    setViewportSize: async () => {},
    close: async () => {
      throw Error('sensitive signed URL');
    },
  };
  await assert.rejects(
    withEpicPage({ pages: () => [page] }, {}, async () => {
      throw failure;
    }),
    error => error === failure,
  );
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('sensitive'));
});

test('Epic page allocation never navigates or closes existing nonblank pages', async () => {
  const sentinel = { url: () => 'https://store.epicgames.com/p/manual' };
  let closed = false;
  const created = {
    setViewportSize: async () => {},
    close: async () => {
      closed = true;
    },
  };
  await withEpicPage({ pages: () => [sentinel], newPage: async () => created }, {}, async page => {
    assert.equal(page, created);
  });
  assert.equal(closed, true);
});
