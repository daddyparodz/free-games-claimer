import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const source = await readFile(new URL('../docker-entrypoint.sh', import.meta.url), 'utf8');
for (const password of ['', 'two words * literal']) {
  test(`VNC arguments preserve the configured password: ${password ? 'spaces and glob' : 'empty'}`, () => {
    const block = source
      .slice(source.indexOf('if [ -z "$VNC_PASSWORD" ]'), source.indexOf('echo "VNC is running'))
      .replace('2>/dev/null 1>&2', '');
    const result = spawnSync('bash', ['-c', 'x11vnc() { printf "<%s>\\n" "$@" >&2; };\n' + block], {
      encoding: 'utf8',
      env: { ...process.env, DISPLAY: ':1', VNC_PORT: '5900', VNC_PASSWORD: password },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = result.stderr.trim().split('\n');
    assert.deepEqual(args, [
      '<-display>',
      '<:1>',
      '<-forever>',
      '<-shared>',
      '<-rfbport>',
      '<5900>',
      '<-bg>',
      ...(password ? ['<-passwd>', `<${password}>`] : ['<-nopw>']),
    ]);
  });
}
