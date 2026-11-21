import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const sources = Object.fromEntries(
  await Promise.all(
    ['epic-games', 'prime-gaming', 'gog', 'aliexpress'].map(async name => [
      name,
      await readFile(new URL(`../${name}.js`, import.meta.url), 'utf8'),
    ]),
  ),
);

function nativeStatus(body, setup = '', previous = 0) {
  const program = `process.exitCode=${previous}; async function exercise(){
    const error=new Error('controlled exception'); let epicFailure=false;
    const notify=async()=>{}; let redeem_action;
    const db={write:async()=>{},data:{fixture:{fixture:{}}}};
    const user='fixture',title='fixture',url='fixture',store='fixture';
    const notify_games=[],notify_game={},dlc_unlinked={},unlinked_store='fixture';
    ${setup}\n${body}\n}
    exercise().then(()=>console.log('__BODY_COMPLETED__')).catch(e=>{console.error(e);process.exitCode=99});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /__BODY_COMPLETED__/, result.stderr);
  return result.status;
}

function catchAt(source, marker, from = 0) {
  const at = source.indexOf(marker, from);
  assert.ok(at >= 0, `missing catch marker ${marker}`);
  const candidates = [...source.slice(0, at).matchAll(/^( +)} catch \(error\) \{/gm)];
  const match = candidates.at(-1);
  assert.ok(match, `missing catch for ${marker}`);
  const start = match.index + match[0].length;
  const end = source.indexOf(`\n${match[1]}}`, at);
  assert.ok(end > start);
  return { body: source.slice(start, end), at };
}

function blockAt(source, marker, opening, ending) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0);
  const start = source.lastIndexOf(opening, at) + opening.length;
  const end = source.indexOf(ending, at);
  assert.ok(start >= opening.length && end > start);
  return source.slice(start, end);
}

for (const provider of Object.keys(sources)) {
  test(`${provider}: handled top-level exceptions produce a failing native exit`, () => {
    const { body } = catchAt(sources[provider], "console.error('--- Exception:')");
    assert.equal(nativeStatus(body), 1);
    assert.equal(nativeStatus(body, '', 130), 130);
  });
}

test('Prime Gaming: caught redemption and DLC errors remain failures after cleanup', () => {
  const source = sources['prime-gaming'];
  let from = 0;
  for (let index = 0; index < 2; index++) {
    const fragment = catchAt(source, "console.error('  Redeem failed:'", from);
    assert.equal(nativeStatus(fragment.body), 1);
    from = fragment.at + 1;
  }
  assert.equal(nativeStatus(catchAt(source, "console.error('  Got error', error)").body), 1);
  assert.equal(nativeStatus(catchAt(source, 'console.error(error);\n          } finally').body), 1);
});

test('Prime Gaming: unconfirmed claims and required account links fail', () => {
  const source = sources['prime-gaming'];
  assert.equal(
    nativeStatus(
      blockAt(source, "console.error('  Claim was not confirmed", '} else {', '\n        }\n        // const img'),
    ),
    1,
  );
  assert.equal(
    nativeStatus(
      blockAt(
        source,
        "console.error('  Account linking is required",
        'if (await isAccountLinkingRequired(page)) {',
        '\n        } else {',
      ),
    ),
    1,
  );
  assert.equal(
    nativeStatus(
      blockAt(
        source,
        "console.error('  Missing account linking:', unlinked_store",
        'if (unlinked_store) {',
        '\n            } else {',
      ),
    ),
    1,
  );
});

test('Prime Gaming: unresolved redemption outcomes fail without retrying the action', () => {
  const source = sources['prime-gaming'];
  const statusStart = source.indexOf('const redeemStatus =');
  const statusEnd = source.indexOf('\nconst isTerminalRedeemStatus', statusStart);
  const statusFunction = source.slice(statusStart, statusEnd);
  const close = source.indexOf('\n  }\n', source.indexOf('await page2.close();'));
  const end = source.indexOf('\n};\n\nconsole.log(datetime()', close);
  assert.ok(close >= 0 && end > close);
  const tail = source.slice(close + '\n  }\n'.length, end);
  for (const action of [
    'redeemed',
    'already redeemed',
    'redeemed?',
    'redeem (got captcha)',
    'redeem (not found)',
    'redeem',
  ]) {
    const setup = `${statusFunction}\nredeem_action=${JSON.stringify(action)}; const redeem_url='fixture';`;
    assert.equal(nativeStatus(tail, setup), ['redeemed', 'already redeemed'].includes(action) ? 0 : 1, action);
  }
});

test('GOG: failed claim responses fail while expired and already-owned giveaways stay successful', () => {
  const source = sources.gog;
  const start = source.indexOf('        let status;');
  const marker = 'notify_games.push({ title, url, status });';
  const end = source.indexOf(marker, start) + marker.length;
  assert.ok(start >= 0 && end > start);
  const fragment = source.slice(start, end);
  for (const [response, expected] of [
    ['{}', 0],
    ['{"message":"Already claimed"}', 0],
    ['{"message":"Giveaway has ended"}', 0],
    ['{"message":"Unauthorized"}', 1],
    ['{"message":"Unexpected rejection"}', 1],
  ]) {
    assert.equal(nativeStatus(fragment, `const response=${JSON.stringify(response)};`), expected, response);
  }
});

test('AliExpress: unconfirmed structured task outcomes fail without changing normal skips', () => {
  const source = sources.aliexpress;
  const start = source.indexOf('      for (const task of tasks)');
  const end = source.indexOf("      console.log('Streak:'", start);
  assert.ok(start >= 0 && end > start);
  for (const status of ['completed', 'already-completed', 'skipped', 'dryrun', 'unconfirmed', 'failed']) {
    assert.equal(
      nativeStatus(
        source.slice(start, end),
        `const tasks=[{task:'fixture',status:${JSON.stringify(status)}}],info={status:'already-claimed'};`,
      ),
      ['unconfirmed', 'failed'].includes(status) ? 1 : 0,
      status,
    );
  }
});
