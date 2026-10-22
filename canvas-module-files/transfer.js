(function (root) {
  'use strict';
  // Each network attempt owns its abort signal and idle clock. File-system
  // operations never use the network clock, so a slow disk is not retried.
  function create(entry, options = {}) {
    const controller = new AbortController(), clocks = new Set();
    const timeout = options.idleTimeoutMs ?? 45000;
    const stopped = () => new DOMException('已停止', 'AbortError');
    const abort = () => controller.abort(entry.controller.signal.reason || stopped());
    entry.controller.signal.addEventListener('abort', abort, { once: true });
    if (entry.controller.signal.aborted) abort();
    function clock(ms, expire) {
      let remaining = ms, timer, began;
      const item = {
        pause() { if (timer) { clearTimeout(timer); timer = null; remaining = Math.max(0, remaining - (Date.now() - began)); } },
        resume() { if (!timer && !entry.paused) { began = Date.now(); timer = setTimeout(expire, remaining); } },
        clear() { item.pause(); clocks.delete(item); }
      };
      clocks.add(item); item.resume(); return item;
    }
    async function network(operation) {
      if (controller.signal.aborted) throw controller.signal.reason || stopped();
      let watch, onAbort;
      try {
        return await Promise.race([
          Promise.resolve().then(operation).catch(error => { if (error && typeof error === 'object' && error.name !== 'AbortError') error.retryable = true; throw error; }),
          new Promise((resolve, reject) => {
            onAbort = () => reject(controller.signal.reason || stopped());
            controller.signal.addEventListener('abort', onAbort, { once: true });
            watch = clock(timeout, () => {
              const error = Object.assign(new Error('网络响应超时，请稍后重试'), { name: 'TimeoutError', retryable: true });
              reject(error); controller.abort(error);
            });
          })
        ]);
      } finally { watch?.clear(); controller.signal.removeEventListener('abort', onAbort); }
    }
    function wait(ms) {
      if (controller.signal.aborted) return Promise.reject(controller.signal.reason || stopped());
      return new Promise((resolve, reject) => {
        let watch;
        const cleanup = () => { watch?.clear(); controller.signal.removeEventListener('abort', onAbort); };
        const onAbort = () => { cleanup(); reject(controller.signal.reason || stopped()); };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        watch = clock(ms, () => { cleanup(); resolve(); });
      });
    }
    return {
      signal: controller.signal,
      network, wait,
      pause() { clocks.forEach(c => c.pause()); },
      resume() { clocks.forEach(c => c.resume()); },
      dispose() { entry.controller.signal.removeEventListener('abort', abort); clocks.forEach(c => c.clear()); controller.abort(); }
    };
  }
  function responseError(response, message = `HTTP ${response.status}`) {
    const retryAfter = response.headers.get('retry-after');
    const parsed = retryAfter && (/^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
    return Object.assign(new Error(message), { retryable: response.status === 408 || response.status === 429 || response.status >= 500 && response.status <= 599, retryAfterMs: Number.isFinite(parsed) ? Math.max(0, Math.min(30000, parsed)) : 0 });
  }
  function canRetry(error, attempt, options = {}) { return Boolean(error?.retryable) && attempt < (options.maxRetries ?? 2); }
  function retryDelay(error, attempt, options = {}) { return Math.max(error.retryAfterMs || 0, Math.min(5000, (options.retryDelayMs ?? 600) * 2 ** attempt)); }
  root.CanvasTransfers = { create, responseError, canRetry, retryDelay };
  if (typeof module !== 'undefined') module.exports = root.CanvasTransfers;
})(globalThis);
