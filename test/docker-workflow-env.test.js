import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const [branch, tag] of [
  ['main', 'latest'],
  ['dev', 'dev'],
]) {
  test(`Docker metadata preserves ${branch} with a spaced environment path`, () => {
    const workflow = readFileSync(new URL('../.github/workflows/docker.yml', import.meta.url), 'utf8');
    const block = workflow.match(/ {8}run: \|\r?\n((?: {10}.*\r?\n)+)/)?.[1];
    assert.ok(block, 'metadata shell must be present');
    const directory = mkdtempSync(join(tmpdir(), 'fgc-metadata-'));
    try {
      execFileSync('bash', ['-e', '-c', block.replace(/^ {10}/gm, '')], {
        cwd: directory,
        env: { ...process.env, BRANCH: branch, GITHUB_ENV: 'environment file' },
        stdio: 'pipe',
      });
      const result = readFileSync(join(directory, 'environment file'), 'utf8');
      assert.match(result, /^NOW=.+/m);
      assert.ok(result.includes(`IMAGE_TAG=${tag}\n`));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
