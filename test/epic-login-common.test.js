import test from 'node:test';
import assert from 'node:assert/strict';
import { epicConsentCookie, prepareLogin, submitEpicMfa, watchEpicMfa } from '../src/epic-login-common.js';

test('Epic consent preserves domain, path and five-day timestamp', () => {
  const cookie = epicConsentCookie(432000001);
  assert.deepEqual(cookie, {
    name: 'OptanonAlertBoxClosed',
    value: new Date(1).toISOString(),
    domain: '.epicgames.com',
    path: '/',
  });
});

test('login preparation preserves debug timeout and optional viewer message', () => {
  const calls = [];
  const context = { setDefaultTimeout: value => calls.push(value) };
  const logger = { error: value => calls.push(value), info: value => calls.push(value) };
  prepareLogin(context, { debug: true, login_timeout: 5000 }, logger);
  assert.equal(calls.length, 2);
  prepareLogin(context, { debug: false, login_timeout: 5000, novnc_port: 6080 }, logger);
  assert.equal(calls[4], 5000);
  assert.match(calls[3], /6080/);
});

test('MFA preserves leading zeroes and submits after typing', async () => {
  const calls = [];
  const page = {
    locator: selector => ({ pressSequentially: async code => calls.push([selector, code]) }),
    click: async selector => calls.push(selector),
  };
  await submitEpicMfa(
    page,
    {},
    () => assert.fail('unexpected generator'),
    async options => {
      assert.equal(options.type, 'text');
      assert.equal(options.validate('012345'), true);
      assert.equal(typeof options.validate('123'), 'string');
      return '012345';
    },
    { log() {} },
  );
  assert.deepEqual(calls, [['input[name="code-input-0"]', '012345'], 'button[type="submit"]']);
});

test('MFA generated code bypasses prompting and failures propagate', async () => {
  let generated;
  await assert.rejects(
    submitEpicMfa(
      {
        locator: () => ({
          pressSequentially: async code => {
            assert.equal(code, '000123');
            throw new Error('typing failed');
          },
        }),
      },
      { eg_otpkey: 'fixture-key' },
      key => {
        generated = key;
        return '000123';
      },
      () => assert.fail('unexpected prompt'),
      { log() {} },
    ),
    /typing failed/,
  );
  assert.equal(generated, 'fixture-key');
});

test('MFA watcher preserves the URL and ignores closed-page rejection', async () => {
  const page = {
    waitForURL: async url => {
      assert.equal(url, '**/id/login/mfa**');
      throw new Error('page closed');
    },
  };
  await watchEpicMfa(
    page,
    {},
    () => assert.fail('unexpected generation'),
    () => assert.fail('unexpected prompt'),
  );
});
