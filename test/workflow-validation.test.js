import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

test('lint retains automatic validation without exposing write credentials', () => {
  const source = readFileSync(new URL('../.github/workflows/lint.yml', import.meta.url), 'utf8');
  assert.match(source, /runs-on: \[self-hosted, Linux, X64\]/);
  assert.match(source, /container: node:24-bookworm/);
  assert.match(source, /pull_request:/);
  assert.doesNotMatch(source, /\/home\/runner\/work/);
  assert.match(source, /fetch-depth: 0/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /contents: read/);
  assert.doesNotMatch(source, /statuses: write|secrets\.GITHUB_TOKEN|secrets\.SONAR_TOKEN/);
  assert.match(source, /unset GITHUB_TOKEN GH_TOKEN/);
  assert.match(source, /MULTI_STATUS: 'false'/);
  assert.match(source, /ESLINT_USE_FLAT_CONFIG: 'false'/);
  const validators = [...source.matchAll(/^\s+(VALIDATE_\w+):\s*([^\n#]+)/gm)];
  // No true allowlist: every other default validator remains enabled.
  assert.deepEqual(
    validators.map(([, key, value]) => [key, value.trim().replaceAll(/['"]/g, '')]),
    [['VALIDATE_JAVASCRIPT_STANDARD', 'false']],
  );
  assert.doesNotMatch(source, /FILTER_REGEX_EXCLUDE|DISABLE_ERRORS|JAVASCRIPT_ES_CONFIG_FILE|JSCPD_CONFIG_FILE/);
  assert.match(source, /super-linter\/super-linter\/slim@47984f49b4e87383eed97890fe2dca6063bbd9c3/);
});

test('retired upstream Sonar integration has no workflow or orphaned project configuration', () => {
  assert.equal(existsSync(new URL('../.github/workflows/sonar.yml', import.meta.url)), false);
  assert.equal(existsSync(new URL('../sonar-project.properties', import.meta.url)), false);
});
