import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';
import js from '@eslint/js';

test('formatter compatibility preserves recommended semantic rules and scoped globals', async () => {
  const eslint = new ESLint();
  for (const file of ['aliexpress.js', 'src/epic-login-common.js', 'test/epic-submit.test.js']) {
    const config = await eslint.calculateConfigForFile(file);
    for (const [rule, setting] of Object.entries(js.configs.recommended.rules)) {
      assert.equal(config.rules[rule][0], setting === 'error' ? 2 : setting, `${file}: ${rule}`);
    }
    for (const rule of [
      'no-extra-parens',
      'implicit-arrow-linebreak',
      'function-paren-newline',
      'nonblock-statement-body-position',
      'wrap-regex',
    ]) {
      assert.equal(config.rules[`@stylistic/js/${rule}`][0], 0, rule);
    }
    assert.equal(config.rules['@stylistic/js/quotes'][1], 'single');
    assert.equal(config.rules['@stylistic/js/quotes'][2].avoidEscape, true);
    assert.equal('document' in config.languageOptions.globals, file !== 'src/epic-login-common.js');
  }
  const [result] = await eslint.lintText('unknownApplicationGlobal();', { filePath: 'src/epic-login-common.js' });
  assert.ok(result.messages.some(message => message.ruleId === 'no-undef'));
});
