import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOrNewPage, waitUntilStable } from '../src/page-navigation.js';

test('same URL reuses the existing page without navigation', async () => {
  const page = { url: () => 'same' };
  assert.deepEqual(await sameOrNewPage({}, page, 'same'), [page, false]);
});

test('new URL creates and navigates a page before returning it', async () => {
  const calls = [];
  const next = { goto: async (...args) => calls.push(args) };
  const context = { newPage: async () => next };
  assert.deepEqual(await sameOrNewPage(context, { url: () => 'old' }, 'new'), [next, true]);
  assert.deepEqual(calls, [['new', { waitUntil: 'domcontentloaded' }]]);
});

test('new-page creation rejection reaches the caller', async () => {
  const failure = new Error('creation failed');
  await assert.rejects(
    sameOrNewPage(
      {
        newPage: async () => {
          throw failure;
        },
      },
      { url: () => 'old' },
      'new',
    ),
    error => error === failure,
  );
});

test('navigation rejection reaches the caller', async () => {
  const failure = new Error('navigation failed');
  const context = {
    newPage: async () => ({
      goto: async () => {
        throw failure;
      },
    }),
  };
  await assert.rejects(sameOrNewPage(context, { url: () => 'old' }, 'new'), error => error === failure);
});

test('stability polling acts only between changed readings', async () => {
  const values = [1, 2, 2];
  let actions = 0;
  await waitUntilStable(
    async () => values.shift(),
    async () => {
      actions++;
    },
  );
  assert.equal(actions, 2);
  assert.deepEqual(values, []);
});

test('stability polling propagates read and action failures', async () => {
  const failure = new Error('poll failed');
  await assert.rejects(
    waitUntilStable(
      async () => {
        throw failure;
      },
      async () => {},
    ),
    error => error === failure,
  );
  await assert.rejects(
    waitUntilStable(
      async () => 1,
      async () => {
        throw failure;
      },
    ),
    error => error === failure,
  );
});
