import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

for (const name of ['lint', 'sonar']) {
  test(`${name} retains automatic validation on the required execution target`, () => {
    const source = readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    assert.match(source, /runs-on: \[self-hosted, Linux, X64\]/);
    assert.match(source, /container: node:24-bookworm/);
    assert.match(source, /pull_request:/);
    assert.doesNotMatch(source, /\/home\/runner\/work/);
    assert.match(source, /fetch-depth: 0/);
    if (name === 'lint') {
      assert.match(source, /ESLINT_USE_FLAT_CONFIG: 'false'/);
      assert.doesNotMatch(source, /VALIDATE_\w+: (?:false|'false')/);
    }
    assert.match(
      source,
      name == 'lint' ? /super-linter\/super-linter\/slim@v7\.4\.0/ : /sonarsource\/sonarcloud-github-action@master/,
    );
  });
}
