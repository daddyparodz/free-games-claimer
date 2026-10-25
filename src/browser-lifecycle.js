import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, readFile, writeFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { assertProfileAvailable } from './browser-profile-lock.js';

const identity = async profile => {
  await mkdir(profile, { recursive: true });
  let canonical = await realpath(profile);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const key = createHash('sha256').update(canonical).digest('hex');
  return {
    key,
    port: 20000 + (parseInt(key.slice(0, 8), 16) % 40000),
    pipe: process.platform === 'win32' ? `\\\\.\\pipe\\fgc-browser-${key}` : undefined,
    file: path.join(canonical, '.fgc-session.json'),
  };
};
const readOwner = async file => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const requestStop = (id, owner) =>
  new Promise((resolve, reject) => {
    if (!owner || owner.key !== id.key || typeof owner.token !== 'string') {
      reject(Error('Profile is busy; no verified claimer owner. Nothing was closed.'));
      return;
    }
    const request = http.request(
      {
        host: '127.0.0.1',
        port: id.port,
        socketPath: id.pipe,
        method: 'POST',
        path: '/stop',
        headers: { connection: 'close', authorization: `Bearer ${owner.token}`, 'x-fgc-profile': id.key },
        agent: false,
        timeout: 30000,
      },
      response => {
        response.resume();
        response.on('end', () =>
          response.statusCode === 200
            ? resolve(true)
            : reject(Error('Browser owner changed or port belongs to another service; refusing cleanup.')),
        );
      },
    );
    request.on('timeout', () => request.destroy(Error('Browser cleanup timed out; refusing concurrent launch.')));
    request.on('error', error => (['ECONNREFUSED', 'ENOENT'].includes(error.code) ? resolve(false) : reject(error)));
    request.end();
  });

// Only an authenticated cooperative owner is stopped. Never kill a PID/name,
// delete browser locks/cookies, or attach to an arbitrary debugging port.
export const stopBrowser = async profile => {
  const id = await identity(profile);
  const owner = await readOwner(id.file);
  return owner ? requestStop(id, owner) : false;
};

export const withBrowser = async (browserType, profile, options, run) => {
  const id = await identity(profile);
  // Snapshot BEFORE competing for the lock. A loser must not stop a new winner.
  const previous = await readOwner(id.file);
  const owner = { key: id.key, token: randomUUID() };
  let context;
  let launching;
  let closing;
  let cancelled = false;
  let registered = false;
  const release = async () => {
    if (registered) {
      const current = await readOwner(id.file);
      if (current?.token === owner.token) await unlink(id.file);
      registered = false;
    }
    server.close();
  };
  const close = () =>
    (closing ||= (async () => {
      if (launching) await launching.catch(() => {});
      if (context) await context.close();
      await release();
    })().catch(error => {
      // Keep the authenticated owner/lock if close failed; a relaunch can retry,
      // but may never assume that a rejected close freed the browser profile.
      closing = undefined;
      throw error;
    }));
  const server = http.createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/stop' ||
      request.headers.origin ||
      request.headers.authorization !== `Bearer ${owner.token}` ||
      request.headers['x-fgc-profile'] !== id.key
    ) {
      response.writeHead(403).end();
      return;
    }
    cancelled = true;
    try {
      await close();
      response.writeHead(200).end();
    } catch {
      response.writeHead(500).end();
    }
  });
  const listen = () =>
    new Promise((resolve, reject) => {
      const failed = error => {
        server.off('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.off('error', failed);
        resolve();
      };
      server.once('error', failed).once('listening', ready);
      server.listen(
        id.pipe ? { path: id.pipe, exclusive: true } : { host: '127.0.0.1', port: id.port, exclusive: true },
      );
    });
  try {
    await listen();
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    await requestStop(id, previous);
    // Drain the acknowledged owner's pipe connection, without ever stopping a
    // newer owner. A competing winner remains protected by the kernel listener.
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await listen();
        break;
      } catch (retryError) {
        if (retryError.code !== 'EADDRINUSE' || Date.now() >= deadline) throw retryError;
        await delay(50);
      }
    }
  }
  try {
    await writeFile(id.file, JSON.stringify(owner), { mode: 0o600 });
    registered = true;
    await assertProfileAvailable(profile);
    if (cancelled) throw Error('Browser session superseded before launch.');
    launching = browserType.launchPersistentContext(profile, options);
    context = await launching;
    if (cancelled) throw Error('Browser session superseded by a new invocation.');
    return await run(context);
  } finally {
    await close();
  }
};
