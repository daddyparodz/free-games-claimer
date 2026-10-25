import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
test('optional image has a digest-pinned base and explicit nonroot runtime', () => {
  assert.match(dockerfile, /^FROM ubuntu:jammy@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^USER 1000:1000$/m);
  assert.match(dockerfile, /^ENV PLAYWRIGHT_BROWSERS_PATH=\/opt\/playwright$/m);
  assert.match(dockerfile, /mkdir -p \/fgc\/data \/tmp\/.X11-unix/);
});
test('optional image readiness checks display and configured VNC transports', () => {
  assert.match(dockerfile, /^HEALTHCHECK .+test -S \/tmp\/.X11-unix\/X1.+VNC_PORT.+NOVNC_PORT/m);
  assert.doesNotMatch(dockerfile, /HEALTHCHECK NONE|checkov:skip|hadolint ignore/);
});
test('optional image preserves sequential claim commands in exec-form CMD', () => {
  assert.match(dockerfile, /^CMD \["\/bin\/bash", "-c", "node epic-games; node prime-gaming; node gog"\]$/m);
  assert.doesNotMatch(dockerfile, /^ENV \w+ [^=]/m);
  assert.match(dockerfile, /pip install --no-cache-dir apprise==2\.0\.1/);
});
