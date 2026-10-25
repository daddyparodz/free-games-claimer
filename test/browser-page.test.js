import test from 'node:test';
import assert from 'node:assert/strict';
import { initialBrowserPage, logRecordedVideo } from '../src/browser-page.js';

test('initial page preserves an existing page and applies the configured viewport', async () => {
  const sizes = [];
  const page = { setViewportSize: async size => sizes.push(size) };
  assert.equal(await initialBrowserPage({ pages: () => [page] }, { width: 10, height: 20 }), page);
  assert.deepEqual(sizes, [{ width: 10, height: 20 }]);
});

test('initial page creates a page only when the context has none', async () => {
  const page = { setViewportSize: async () => {} };
  assert.equal(
    await initialBrowserPage({ pages: () => [], newPage: async () => page }, { width: 10, height: 20 }),
    page,
  );
});

test('initial page propagates viewport failure', async () => {
  const error = new Error('viewport failed');
  await assert.rejects(
    initialBrowserPage(
      {
        pages: () => [
          {
            setViewportSize: async () => {
              throw error;
            },
          },
        ],
      },
      {},
    ),
    e => e === error,
  );
});

test('recording absence does not request a path', async () => {
  await logRecordedVideo({ video: () => null });
});

test('recording path errors remain visible to the caller', async () => {
  const error = new Error('recording failed');
  await assert.rejects(
    logRecordedVideo({
      video: () => ({
        path: async () => {
          throw error;
        },
      }),
    }),
    e => e === error,
  );
});
