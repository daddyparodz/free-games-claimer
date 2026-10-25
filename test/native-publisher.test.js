import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('publisher builds natively and keeps pull requests publication-free', () => {
  const source = readFileSync(new URL('../.github/workflows/docker.yml', import.meta.url), 'utf8');
  assert.match(source, /runs-on: \[self-hosted, Linux, X64\]/);
  assert.match(source, /image: ubuntu:24\.04/);
  assert.match(source, /docker-ce-cli docker-buildx-plugin/);
  assert.match(source, /builder: default/);
  assert.match(source, /platforms: linux\/amd64\r?\n/);
  assert.doesNotMatch(source, /arm64|qemu|setup-buildx|privileged|cache-to:|cache-from:/i);
  assert.match(source, /pull_request:/);
  assert.match(source, /push: false/);
  assert.doesNotMatch(source, /docker\/login-action|DOCKERHUB_USERNAME|DOCKERHUB_TOKEN|packages: write/);
  assert.match(source, /persist-credentials: false/);
  assert.doesNotMatch(source, /!\.github\/depend|!\.github\/workflows/);
  for (const arg of ['COMMIT', 'BRANCH', 'NOW']) assert.match(source, new RegExp(`${arg}=\\$\\{\\{`));
  assert.match(source, /tags: free-games-claimer:\$\{\{ env\.IMAGE_TAG \}\}/);
});
