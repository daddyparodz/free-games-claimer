import {test} from 'node:test';
import assert from 'node:assert/strict';
import {epicCheckoutAuthError} from '../src/epic-purchase.js';

test('Epic checkout auth notification states the concrete failure and action',()=>{
 assert.equal(epicCheckoutAuthError(), 'Epic was signed in on the store page, but checkout redirected to the Epic login page. No game was claimed. Sign in in the visible Epic browser, then retry.');
});
