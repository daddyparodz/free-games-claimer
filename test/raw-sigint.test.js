import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { onRawSIGINT } from '../src/raw-sigint.js';

test('raw SIGINT enables input and separates Ctrl-C from ordinary data', () => {
  const stdin = new EventEmitter();
  const calls = [];
  stdin.setRawMode = value => calls.push(['raw', value]);
  stdin.resume = () => calls.push(['resume']);
  const stdout = { write: key => calls.push(['write', key]) };
  onRawSIGINT(() => calls.push(['interrupt']), { stdin, stdout });
  stdin.emit('data', Buffer.from('hello'));
  stdin.emit('data', Buffer.from('\u0003'));
  assert.deepEqual(calls, [['raw', true], ['resume'], ['write', 'hello'], ['interrupt']]);
});
