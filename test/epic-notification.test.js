import {test} from 'node:test';
import assert from 'node:assert/strict';
import {epicCheckoutAuthError} from '../src/epic-purchase.js';

test('Epic checkout auth notification states the concrete failure and action',()=>{
 assert.equal(epicCheckoutAuthError(), 'Epic checkout redirected to Epic login after the store page reported you signed in. No game was claimed. The saved Epic session did not authenticate checkout; leave the visible browser open and retry after the session settles.');
});
