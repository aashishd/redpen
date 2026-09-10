import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupAfter, stopChild } from '../test-support/browser.mjs';

function registeredCleanup() {
  let run;
  const add = cleanupAfter({ after(callback) { run = callback; } });
  return { add, run: () => run() };
}

test('browser cleanup waits for consumers before removing their files', async () => {
  const cleanup = registeredCleanup();
  const order = [];
  cleanup.add(() => order.push('remove profile'));
  cleanup.add(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    order.push('browser exited');
  });
  cleanup.add(() => order.push('connection closed'));
  await cleanup.run();
  assert.deepEqual(order, ['connection closed', 'browser exited', 'remove profile']);
});

test('browser cleanup releases every resource and reports cleanup failures', async () => {
  const cleanup = registeredCleanup();
  const order = [];
  const failure = new Error('Connection cleanup failed');
  cleanup.add(() => order.push('remove profile'));
  cleanup.add(() => order.push('stop browser'));
  cleanup.add(() => { order.push('close connection'); throw failure; });
  await assert.rejects(cleanup.run(), (error) => error instanceof AggregateError && error.errors[0] === failure);
  assert.deepEqual(order, ['close connection', 'stop browser', 'remove profile']);
});

test('stopping a child waits for its output streams to close', async () => {
  const events = [];
  let resolveClose;
  const closed = new Promise((resolve) => { resolveClose = resolve; });
  const child = { exitCode: null, signalCode: null, kill() { events.push('signal'); } };
  const stopped = stopChild(child, closed).then(() => events.push('stopped'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['signal']);
  resolveClose();
  await stopped;
  assert.deepEqual(events, ['signal', 'stopped']);
});
