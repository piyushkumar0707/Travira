// Allows at most `limit` uses of a key in each time window. Counts live in
// memory: they reset on restart and are not shared between server instances.
function createRateLimiter({ limit, windowMs }) {
  const windows = new Map();
  const current = (key) => {
    const window = windows.get(key);
    return window && window.resetAt > Date.now() ? window : null;
  };

  // Forget finished windows so the map does not keep growing.
  setInterval(() => {
    for (const key of windows.keys()) if (!current(key)) windows.delete(key);
  }, windowMs).unref();

  return {
    take(key) {
      let window = current(key);
      if (!window) {
        window = { used: 0, resetAt: Date.now() + windowMs };
        windows.set(key, window);
      }
      if (window.used >= limit) {
        return { allowed: false, retryAfterSeconds: Math.ceil((window.resetAt - Date.now()) / 1000) };
      }
      window.used += 1;
      return { allowed: true };
    },
    // Give back one use, for example when the limited action did not happen.
    refund(key) {
      const window = current(key);
      if (window && window.used > 0) window.used -= 1;
    },
    reset(key) {
      windows.delete(key);
    },
  };
}

module.exports = { createRateLimiter };
