import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepAlive, withKeepAlive } from '../extension/lib/keepalive.js';

/** A clock and timers the test moves by hand. */
function fakeTime() {
  let now = 0;
  const live = new Map(); // id -> { every, next, fn }
  let ids = 0;
  return {
    now: () => now,
    timers: {
      setInterval: (fn, every) => { live.set(++ids, { every, next: now + every, fn }); return ids; },
      clearInterval: (id) => { live.delete(id); },
    },
    running: () => live.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...live.values()].filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.every;
        due.fn();
      }
      now = end;
    },
  };
}

test('keepAlive pings every 20 seconds until it is stopped', () => {
  const time = fakeTime();
  let pings = 0;
  const stop = keepAlive({ ping: () => { pings++; }, timers: time.timers, now: time.now });
  time.advance(19999);
  assert.equal(pings, 0);
  time.advance(1);
  assert.equal(pings, 1);
  time.advance(60000);
  assert.equal(pings, 4);
  stop();
  assert.equal(time.running(), 0, 'the timer is gone');
  time.advance(600000);
  assert.equal(pings, 4, 'not one more ping after the stop');
  stop(); // twice is harmless
});

test('withKeepAlive stops when the work succeeds', async () => {
  const time = fakeTime();
  let pings = 0;
  let finish;
  const work = withKeepAlive(() => new Promise((r) => { finish = r; }), { ping: () => { pings++; }, timers: time.timers, now: time.now });
  assert.equal(time.running(), 1, 'on while the request is out');
  time.advance(45000);
  assert.equal(pings, 2);
  finish('answer');
  assert.equal(await work, 'answer');
  assert.equal(time.running(), 0);
  time.advance(120000);
  assert.equal(pings, 2);
});

test('withKeepAlive stops when the work fails, and passes the failure on', async () => {
  const time = fakeTime();
  let pings = 0;
  await assert.rejects(withKeepAlive(async () => { throw new Error('AI response was cut off'); }, { ping: () => { pings++; }, timers: time.timers, now: time.now }),
    /AI response was cut off/);
  assert.equal(time.running(), 0);
  time.advance(120000);
  assert.equal(pings, 0);
  // A function that throws before returning a promise is covered too.
  await assert.rejects(withKeepAlive(() => { throw new Error('no key'); }, { ping() {}, timers: time.timers, now: time.now }), /no key/);
  assert.equal(time.running(), 0);
});

test('a request that never ends does not keep the worker awake for ever', () => {
  const time = fakeTime();
  let pings = 0;
  withKeepAlive(() => new Promise(() => {}), { ping: () => { pings++; }, timers: time.timers, now: time.now, everyMs: 20000, maxMs: 100000 });
  time.advance(99999);
  assert.equal(pings, 4);
  assert.equal(time.running(), 1);
  time.advance(1); // the tick at 100 s finds the time is up
  assert.equal(time.running(), 0);
  time.advance(3600000);
  assert.equal(pings, 4);
});

test('a ping that throws does not stop the keepalive or reach the caller', async () => {
  const time = fakeTime();
  let pings = 0;
  let finish;
  const work = withKeepAlive(() => new Promise((r) => { finish = r; }), { ping: () => { pings++; throw new Error('worker going away'); }, timers: time.timers, now: time.now });
  time.advance(40000);
  assert.equal(pings, 2);
  finish(1);
  assert.equal(await work, 1);
});
