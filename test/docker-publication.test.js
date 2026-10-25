import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/docker.yml', import.meta.url), 'utf8');

test('image validation builds without registry publication or credentials', () => {
  assert.match(workflow, /^name: Build Docker image$/m);
  assert.match(workflow, /name: Build image\n {8}uses: docker\/build-push-action@v6\n {8}with:/);
  assert.match(workflow, /^ {10}push: false$/m);
  assert.match(workflow, /^ {10}context: \.$/m);
  assert.match(workflow, /^ {10}platforms: linux\/amd64$/m);
  assert.doesNotMatch(workflow, /docker\/login-action|secrets\.|packages:|ghcr\.io|DOCKERHUB|continue-on-error/);
  assert.match(workflow, /persist-credentials: false/);
});
