import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epicCheckoutAuthError } from '../src/epic-purchase.js';
import { readFile } from 'node:fs/promises';

test('Epic errors omit redundant reassurance and auth architecture explanations', async () => {
  const source = await readFile(new URL('../src/epic-purchase.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /no order was placed|The listing session is separate|no challenge interaction was automated|ownership is not confirmed/i);
});

test('Epic checkout auth notification states the concrete failure and action', () => {
  assert.equal(epicCheckoutAuthError(), 'Complete Epic sign-in in the browser.');
});
