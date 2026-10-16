import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'patchright';
import {resumeEpicCheckoutLogin} from '../src/epic-purchase.js';

test('resumes checkout login by clicking visible Google sign-in and returns to product',async()=>{
 const b=await chromium.launch({headless:true});
 try{
  const p=await b.newPage();
  await p.setContent('<button aria-label="Google">Continue with Google</button>');
  await p.evaluate(()=>document.querySelector('button').onclick=()=>{});
  let clicked = false;
  await p.getByRole('button', { name: /google/i }).evaluate(button => { button.onclick = () => { button.dataset.clicked = 'true'; }; });
  const result = await resumeEpicCheckoutLogin(p,'https://store.epicgames.com/p/bad-cheese',1000);
  clicked = await p.getByRole('button', { name: /google/i }).getAttribute('data-clicked') === 'true';
  assert.equal(result,'google');
  assert.equal(clicked,true);
 }finally{await b.close();}
});

test('does not claim Google login was used when no Google button exists',async()=>{
 const b=await chromium.launch({headless:true});
 try{const p=await b.newPage();await p.setContent('<h1>Sign in</h1>');assert.equal(await resumeEpicCheckoutLogin(p,'https://store.epicgames.com/p/x',100),'none');}finally{await b.close();}
});
