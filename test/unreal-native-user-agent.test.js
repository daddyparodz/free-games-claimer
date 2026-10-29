import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('Unreal Firefox launcher leaves user agent to the native engine', async () => {
  const source = await readFile(new URL('../unrealengine.js', import.meta.url), 'utf8');
  const start = source.indexOf('firefox.launchPersistentContext(');
  const end = source.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start);
  let options;
  await vm.runInNewContext(source.slice(start, end + 4), {
    firefox: { launchPersistentContext: async (_profile, value) => {
      options = value;
    } },
    cfg: { dir: { browser: 'owned-profile' }, width: 1280, height: 720, record: false },
  });
  assert.equal(Object.hasOwn(options, 'userAgent'), false);
  assert.equal(options.locale, 'en-US');
});
