// Keeps the service worker awake while one long request is on its way (an AI answer can take minutes,
// and the browser stops a worker that makes no extension calls for 30 seconds).

/**
 * Call `ping` every `everyMs` until the returned stop() is called, or `maxMs` have passed (a request that
 * never ends must not keep the worker awake for ever). `timers` and `now` are for tests.
 */
export function keepAlive({ ping, everyMs = 20000, maxMs = 10 * 60 * 1000, timers = globalThis, now = Date.now } = {}) {
  let stopped = false;
  const started = now();
  let timer = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(timer);
  };
  timer = timers.setInterval(() => {
    if (now() - started >= maxMs) {
      stop();
      return;
    }
    try { ping(); } catch { /* the ping is only a nudge */ }
  }, everyMs);
  return stop;
}

/** Run `work()` with the keepalive on; it stops when the work settles, whether it succeeded or failed. */
export async function withKeepAlive(work, options) {
  const stop = keepAlive(options);
  try {
    return await work();
  } finally {
    stop();
  }
}
