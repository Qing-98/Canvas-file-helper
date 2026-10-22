// Development-only browser fixture. Run from the project root:
//   node tests/browser-fixture-server.cjs
// Bind only loopback; no Canvas credentials, real course data or Chrome downloads.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const source = path.resolve(__dirname, '../canvas-module-files');
const fixtureScript = path.join(__dirname, 'browser-fixture.js');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const checks = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Canvas browser internal checks</title><style>body{font:16px system-ui;max-width:900px;margin:36px auto;padding:0 20px;color:#163c2b;background:#f4f8f4}button{padding:12px 24px;font:inherit}progress{width:100%}li{margin:12px 0;overflow-wrap:anywhere}#summary{font-weight:700}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Canvas browser internal checks</h1><p>Test-only local streams. Uses real browser fetch, File System Access / OPFS and ZIP code. All temporary browser files are removed after each run; no Chrome download history entries are created.</p><button id="runChecks">Run checks</button><p id="summary" role="status">Ready</p><progress id="checkProgress" value="0" max="100"></progress><ol id="checkResults"></ol><pre id="checkDetails"></pre><script src="/core.js"></script><script src="/transfer.js"></script><script src="/vendor/fflate.js"></script><script src="/zip-downloader.js"></script><script src="/browser-fixture.js"></script></html>`;
const layout = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Canvas responsive and keyboard checks</title><style>body{font:15px system-ui;margin:20px;background:#f4f8f4;color:#163c2b}button{padding:9px 14px;margin:3px;font:inherit}#layoutSummary,#focusSummary{font-weight:700}iframe{display:block;height:900px;border:1px solid #99b5a3;background:white}#frameContainer{overflow:auto;max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Canvas responsive and keyboard checks</h1><p>The embedded app receives an independent viewport. This does not resize the browser window.</p><p id="layoutSummary" role="status">Loading…</p><button id="prepareFocus">Focus first checkbox and expand sources</button><button id="refreshTask">Refresh task progress</button><p id="focusSummary" role="status">Focus a file checkbox, then refresh to check focus and expanded details.</p><div id="frameContainer"><iframe id="fixtureFrame" title="Canvas File Assistant responsive fixture"></iframe></div><pre id="layoutDetails"></pre><script src="/browser-fixture.js"></script></html>`;
let base;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/') { res.writeHead(302, { Location: `/app.html?tab=1&origin=${encodeURIComponent(base)}&course=42` }); res.end(); return; }
    if (url.pathname === '/checks') { res.writeHead(200, { 'Content-Type': mime['.html'] }); res.end(checks); return; }
    if (url.pathname === '/layout') { res.writeHead(200, { 'Content-Type': mime['.html'] }); res.end(layout); return; }
    if (url.pathname === '/fixture/redirect') { res.writeHead(302, { Location: '/fixture/data?bytes=4096' }); res.end(); return; }
    if (url.pathname === '/fixture/login-redirect') { res.writeHead(302, { Location: '/fixture/login' }); res.end(); return; }
    if (url.pathname === '/fixture/login') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><h1>Fixture sign in required</h1></html>'); return; }
    if (url.pathname === '/fixture/denied') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Fixture unauthorized'); return; }
    if (url.pathname === '/fixture/stall') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.write(new Uint8Array([0, 1, 2])); return; }
    if (url.pathname === '/fixture/data') {
      const length = Math.min(16 * 1024 * 1024, Math.max(1, Number(url.searchParams.get('bytes')) || 65536));
      const delay = Math.min(100, Math.max(0, Number(url.searchParams.get('delay')) || 0));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...(url.searchParams.has('unknown') ? {} : { 'Content-Length': length }) });
      let offset = 0, timer, closed = false;
      res.on('close', () => { closed = true; clearTimeout(timer); });
      const write = () => {
        if (closed) return;
        if (offset >= length) { res.end(); return; }
        const chunk = Buffer.alloc(Math.min(65536, length - offset));
        for (let i = 0; i < chunk.length; i++) chunk[i] = (offset + i) % 251;
        offset += chunk.length;
        if (res.write(chunk)) timer = setTimeout(write, delay);
        else res.once('drain', () => { if (!closed) timer = setTimeout(write, delay); });
      };
      write(); return;
    }
    if (url.pathname === '/browser-fixture.js') { res.writeHead(200, { 'Content-Type': mime['.js'] }); res.end(await fs.readFile(fixtureScript)); return; }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(source, relative);
    if (!target.startsWith(source + path.sep) || !mime[path.extname(target)]) { res.writeHead(404); res.end(); return; }
    let body = await fs.readFile(target);
    if (relative === 'app.html') body = body.toString().replace('<script src="app.js"></script>', '<script src="/browser-fixture.js"></script><script src="app.js"></script>');
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] }); res.end(body);
  } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Fixture error'); }
});
server.listen(Number(process.env.CANVAS_FIXTURE_PORT) || 0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`UI: ${base}/app.html?tab=1&origin=${encodeURIComponent(base)}&course=42`);
  console.log(`English UI: ${base}/app.html?tab=1&origin=${encodeURIComponent(base)}&course=42&lang=en`);
  console.log(`Browser checks: ${base}/checks`);
  console.log(`Responsive checks: ${base}/layout?width=390&lang=en`);
});
function shutdown() { server.closeAllConnections(); server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
