import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('normal installation excludes the removed stealth dependency tree', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  const removed = ['puppeteer-extra-plugin-stealth', 'puppeteer-extra-plugin-user-preferences', 'deepmerge'];
  for (const name of removed) {
    assert.equal(manifest.dependencies[name], undefined, name);
    assert.equal(Object.keys(lock.packages).some(key => key.endsWith(`node_modules/${name}`)), false, name);
  }
});

test('Prime and Unreal use their existing Firefox engine without stealth injection', async () => {
  for (const file of ['prime-gaming.js', 'unrealengine.js']) {
    const source = await read(file);
    assert.match(source, /import \{ firefox \} from 'playwright-firefox'/);
    assert.doesNotMatch(source, /\bstealth\b/);
  }
  assert.doesNotMatch(await read('src/util.js'), /puppeteer-extra-plugin-stealth|export const stealth/);
});
