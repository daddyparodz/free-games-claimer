import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('image validation accepts dependency branch names containing slashes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fgc-image-tag-'));
  try {
    const output = join(directory, 'env');
    const script = workflow.match(/ {10}if \[\[.*? {10}fi/s)[0];
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, BRANCH: 'dependabot/npm_and_yarn/proxy-addr-2.0.8', GITHUB_ENV: output },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const tag = readFileSync(output, 'utf8').trim().split('=')[1];
    assert.match(tag, /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
