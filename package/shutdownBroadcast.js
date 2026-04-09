/**
 * broadcastShutdown — notify all connected SSE clients that the daemon is
 * going away, wait for the underlying sockets to actually drain, then resolve.
 *
 * Factored out of server.js so it can be unit-tested without booting a
 * Meteor server. The daemon shutdown path is timing-sensitive — connected
 * CLI clients hang forever if the shutdown event doesn't reach them, so this
 * logic specifically:
 *
 *   1. Wraps each write in try/catch so a bad socket can't abort the loop.
 *   2. Waits for `res.end()` to call back (socket actually flushed), instead
 *      of a fixed-duration setTimeout, which was fragile under load.
 *   3. Enforces a hard upper bound so a hung socket can't delay exit forever.
 *   4. Tolerates being called from an `uncaughtException` handler — the
 *      outer try/catch guarantees the function never throws, so the caller
 *      can always rely on the returned promise settling.
 *
 * @param {Object}   opts
 * @param {Iterable} opts.connections - SSE response objects to notify.
 * @param {string}   opts.reason      - Short reason string, forwarded to clients.
 * @param {number}   [opts.hardTimeoutMs=1000] - Upper bound on drain wait.
 * @param {Function} [opts.logger]    - Optional logger (console.log-compatible).
 * @returns {Promise<{notified: number, drained: number, timedOut: boolean}>}
 */
export function broadcastShutdown({
  connections,
  reason,
  hardTimeoutMs = 1000,
  logger,
}) {
  const conns = Array.from(connections || []);
  const payload = `data: ${JSON.stringify({ type: 'daemon-shutdown', reason })}\n\n`;

  if (conns.length === 0) {
    return Promise.resolve({ notified: 0, drained: 0, timedOut: false });
  }

  return new Promise((resolve) => {
    let pending = conns.length;
    let drained = 0;
    let settled = false;

    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      resolve({ notified: conns.length, drained, timedOut });
    };

    const finishOne = () => {
      drained += 1;
      pending -= 1;
      if (pending <= 0) finish(false);
    };

    for (const res of conns) {
      let handled = false;
      const once = () => {
        if (handled) return;
        handled = true;
        finishOne();
      };

      try {
        res.write(payload);
        // res.end() callback fires once the data is flushed to the OS socket.
        res.end(once);
        // Belt-and-suspenders: if the socket errors or closes first, still
        // count it as drained so we don't wait on a dead connection.
        if (typeof res.once === 'function') {
          res.once('error', once);
          res.once('close', once);
        }
      } catch (e) {
        if (logger) logger(`[daemon] shutdown write failed: ${e && e.message}`);
        once();
      }
    }

    // Hard upper bound so a wedged socket can't delay exit forever.
    const t = setTimeout(() => finish(true), hardTimeoutMs);
    if (typeof t.unref === 'function') t.unref();
  });
}
