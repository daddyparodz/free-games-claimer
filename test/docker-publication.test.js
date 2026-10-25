import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/docker.yml', import.meta.url), 'utf8');

test('image validation builds without registry publication or credentials', () => {
  assert.match(workflow, /^name: Build Docker image$/m);
  assert.match(workflow, /name: Build image\n        uses: docker\/build-push-action@v6\n        with:/);
  assert.match(workflow, /^          push: false$/m);
  assert.match(workflow, /^          context: \.$/m);
  assert.match(workflow, /^          platforms: linux\/amd64$/m);
  assert.doesNotMatch(workflow, /docker\/login-action|secrets\.|packages:|ghcr\.io|DOCKERHUB|continue-on-error/);
  assert.match(workflow, /persist-credentials: false/);
});