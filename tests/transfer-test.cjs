// Local HTTP sockets and in-memory file handles: no Canvas credentials or browser downloads.
const assert = require('node:assert/strict');
const http = require('node:http');
const zip = require('../canvas-module-files/vendor/fflate.js');
const zipEngine = require('../canvas-module-files/zip-downloader.js');
const directoryEngine = require('../canvas-module-files/directory-downloader.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(test, label) { const end = Date.now() + 6000; while (!test()) { if (Date.now() > end) throw new Error('Timeout: ' + label); await sleep(5); } }
class Directory {
  constructor(options = {}) { this.name = 'Test'; this.files = new Map(); this.options = options; this.writers = 0; }
  async getDirectoryHandle() { return this; }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name)) { if (!create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); this.files.set(name, new Uint8Array()); }
    return {
      getFile: async () => new Blob([this.files.get(name)]),
      createWritable: async () => {
        await this.options.createWritable?.(name);
        this.writers++; let closed = false; const parts = [];
        const release = () => { if (!closed) { closed = true; this.writers--; } };
        return {
          write: async value => { await this.options.write?.(name, value); parts.push(value.slice()); },
          close: async () => { await this.options.close?.(name); this.files.set(name, new Uint8Array(await new Blob(parts).arrayBuffer())); release(); },
          abort: async () => release()
        };
      }
    };
  }
  async removeEntry(name) { this.files.delete(name); }
}
let serial = 0;
function fixture(kind, url, options = {}) {
  const id = kind + (++serial), temp = options.temp || new Directory(), output = options.output || new Directory(), updates = [], saved = [];
  const file = { key: id, name: 'notes.txt', downloadUrl: url, category: 'Text', sources: [{ moduleName: 'Week 1', pageTitle: 'Week 1 - Lectorial' }] };
  const job = { jobId: id, state: 'queued', name: kind === 'zip' ? id + '.zip' : file.name, filename: file.name, fileKey: file.key, sources: file.sources, url, bytesReceived: 0 };
  const config = { idleTimeoutMs: 70, retryDelayMs: 5, zip, getTempDirectory: async () => temp, onUpdate: j => updates.push(structuredClone(j)), saveBlob: async blob => { saved.push(new Uint8Array(await blob.arrayBuffer())); return 'test.zip'; }, ...options };
  const engine = (kind === 'zip' ? zipEngine : directoryEngine).create(config);
  return {
    kind, job, file, engine, temp, output, updates, saved,
    start() { if (kind === 'zip') engine.start(null, [{ filename: file.name, file }], job); else engine.start(output, [job]); },
    async settled() { await until(() => updates.some(j => ['complete', 'interrupted'].includes(j.state) || j.state === 'cancelled' && (kind !== 'zip' || j.phase?.includes('临时数据'))), id + ' settled'); await sleep(10); },
    bytes() { return kind === 'zip' ? zip.unzipSync(saved[0])[file.name] : output.files.get(file.name); }
  };
}
(async () => {
  const calls = new Map(), pending = new Map(), closed = new Map();
  const server = http.createServer((req, res) => {
    const endpoint = req.url.split('?')[0], count = (calls.get(req.url) || 0) + 1; calls.set(req.url, count);
    res.on('close', () => closed.set(req.url, (closed.get(req.url) || 0) + 1));
    if (endpoint === '/headers') { pending.set(req.url, res); return; }
    if (endpoint === '/stall') { res.writeHead(200, { 'Content-Length': '20' }); res.write('first'); pending.set(req.url, res); return; }
    if (endpoint === '/recover' && count === 1) { res.writeHead(200, { 'Content-Length': '20' }); res.write('bad-partial'); setTimeout(() => res.destroy(), 5); return; }
    if (endpoint === '/429' && count < 3) { res.writeHead(429, { 'Retry-After': '0.01' }); res.end('wait'); return; }
    if (endpoint === '/429-body') { res.writeHead(429); res.write('unfinished error body'); return; }
    if (endpoint === '/500') { res.writeHead(503); res.end('down'); return; }
    if (endpoint === '/401' || endpoint === '/403') { res.writeHead(Number(endpoint.slice(1))); res.end('denied'); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '7' }); res.end('payload');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const kind of ['directory', 'zip']) {
      for (const endpoint of ['/headers', '/stall']) {
        const url = `${endpoint}?${kind}`, f = fixture(kind, base + url); f.start(); await f.settled();
        assert.equal(f.job.state, 'interrupted'); assert.equal(calls.get(url), 3); assert.match(f.job.error, /网络响应超时/);
        assert.equal(f.output.files.size, 0); assert.equal(f.temp.files.size, 0); assert.equal(f.output.writers + f.temp.writers, 0);
        assert.equal(f.job.failures[0].key, f.file.key); assert.equal(f.job.failures[0].sources[0].pageTitle, 'Week 1 - Lectorial');
      }
      console.log(`PASS ${kind}: live connections with missing headers or stalled bodies time out, retry only twice, retain failed sources and release all files`);
      for (const endpoint of ['/recover', '/429']) {
        const url = `${endpoint}?${kind}`, f = fixture(kind, base + url); f.start(); await f.settled();
        assert.equal(f.job.state, 'complete'); assert.equal(calls.get(url), endpoint === '/recover' ? 2 : 3);
        assert.equal(new TextDecoder().decode(f.bytes()), 'payload'); assert.equal(f.job.bytesReceived, 7);
        assert.equal(f.temp.files.size, 0); assert.equal(f.output.writers + f.temp.writers, 0);
        if (kind === 'zip') { assert.equal(f.job.entriesDone, 1); assert.equal(f.job.entriesFailed, 0); assert.equal(Object.keys(zip.unzipSync(f.saved[0])).length, 2); }
      }
      console.log(`PASS ${kind}: broken stream and HTTP 429 recover without duplicate entries, partial content or inflated byte counts`);
      for (const endpoint of ['/401', '/403', '/500']) {
        const url = `${endpoint}?${kind}`, f = fixture(kind, base + url); f.start(); await f.settled();
        assert.equal(f.job.state, 'interrupted'); assert.equal(calls.get(url), endpoint === '/500' ? 3 : 1);
        assert.equal(f.output.files.size + f.temp.files.size, 0);
      }
      console.log(`PASS ${kind}: permission failures are immediate; server failures have a finite retry bound`);
      const bodyUrl = `/429-body?${kind}`, pendingError = fixture(kind, base + bodyUrl); pendingError.start(); await pendingError.settled();
      await until(() => closed.get(bodyUrl) === 3, 'cancel unfinished error response bodies');
      assert.equal(pendingError.job.state, 'interrupted'); assert.equal(calls.get(bodyUrl), 3); assert.equal(pendingError.temp.files.size + pendingError.output.files.size, 0);
      console.log(`PASS ${kind}: every rejected HTTP response body is cancelled before retry, including never-ending error streams`);
      for (const endpoint of ['/headers', '/stall']) {
        const url = `${endpoint}?pause-${kind}`, f = fixture(kind, base + url, { idleTimeoutMs: 90 }); f.start();
        await until(() => endpoint === '/headers' ? pending.has(url) : f.job.bytesReceived > 0, 'pending ' + kind + endpoint);
        f.engine.control('pause'); await sleep(220);
        assert.equal(f.job.state, 'paused'); assert.equal(calls.get(url), 1); assert.equal(f.job.retryAttempt || 0, 0);
        const response = pending.get(url); endpoint === '/headers' ? response.end('payload') : response.end('123456789012345');
        await sleep(25); assert.equal(f.job.state, 'paused');
        f.engine.control('resume'); await f.settled(); assert.equal(f.job.state, 'complete'); assert.equal(calls.get(url), 1);
      }
      console.log(`PASS ${kind}: pause longer than idle timeout suspends both response-header and body clocks until resumed`);
      const stopUrl = `/500?stop-${kind}`, f = fixture(kind, base + stopUrl, { retryDelayMs: 300 }); f.start();
      await until(() => f.job.retryAttempt === 1, 'retry waiting'); f.engine.control('stop'); f.engine.control('resume'); await f.settled(); await sleep(320);
      assert.equal(f.job.state, 'cancelled'); assert.equal(calls.get(stopUrl), 1); assert.equal(f.output.files.size + f.temp.files.size, 0);
      console.log(`PASS ${kind}: stop cancels retry backoff and cannot be undone by a late resume`);
    }
    for (const action of ['pause', 'stop']) {
      const closing = deferred(), release = deferred(), output = new Directory({ close: async () => { closing.resolve(); await release.promise; } });
      const f = fixture('directory', base + '/good', { output }); f.start(); await closing.promise;
      f.engine.control(action); if (action === 'stop') f.engine.control('resume'); release.resolve(); await sleep(30);
      if (action === 'pause') { assert.equal(f.job.state, 'paused'); assert(!f.updates.some(j => j.state === 'complete')); f.engine.control('resume'); }
      await f.settled(); assert.equal(f.job.state, action === 'stop' ? 'cancelled' : 'complete'); assert.equal(output.files.size, action === 'stop' ? 0 : 1); assert.equal(output.writers, 0);
    }
    console.log('PASS directory: pause and stop during final filesystem close preserve intent and remove cancelled committed files');
    for (const kind of ['directory', 'zip']) {
      for (const operation of ['createWritable', 'write', 'close']) {
        let fetches = 0;
        const directory = new Directory({ [operation]: async name => { if (kind === 'directory' || name.endsWith('.part')) throw new DOMException('Quota exhausted', 'QuotaExceededError'); } });
        const f = fixture(kind, base + '/good', { ...(kind === 'zip' ? { temp: directory } : { output: directory }), fetch: (...args) => { fetches++; return fetch(...args); } });
        f.start(); await f.settled(); assert.equal(f.job.state, 'interrupted'); assert.equal(fetches, 1); assert.equal(directory.files.size, 0); assert.equal(directory.writers, 0);
      }
    }
    console.log('PASS directory and ZIP: staging allocation/write/commit quota failures do not retry network and clean every created file');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
