import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dataDir} from '../src/util.js';
import {cfg} from '../src/config.js';
test('Epic entry points default to isolated Chromium profile and preserve overrides',()=>{
 const previous=process.env.BROWSER_DIR;
 try {
  delete process.env.BROWSER_DIR;
  assert.equal(cfg.epic_browser_dir,dataDir('browser-epic-chromium'));
  process.env.BROWSER_DIR='D:/explicit-epic-profile';
  assert.equal(cfg.epic_browser_dir,'D:/explicit-epic-profile');
 } finally {if(previous===undefined)delete process.env.BROWSER_DIR;else process.env.BROWSER_DIR=previous;}
});
