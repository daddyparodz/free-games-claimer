import {test} from 'node:test';
import assert from 'node:assert/strict';
import {epicCheckoutAuthError} from '../src/epic-purchase.js';

test('Epic checkout auth notification states the concrete failure and action',()=>{
 assert.equal(epicCheckoutAuthError(), 'Epic checkout redirected to Epic login and did not return before timeout. No order was placed for this game. The store listing signed-in status does not authenticate checkout. Complete the Epic sign-in shown in the visible browser, then retry.');
});
