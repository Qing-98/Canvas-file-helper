(function (root) {
  'use strict';
  function create(options = {}) {
    const fetcher = options.fetch || fetch;
    const entries = new Map(), reservations = new Set();
    let active = 0;
    function emit(entry) { options.onUpdate?.(entry.job); }
    function wake(entry) { for (const resolve of entry.waiters.splice(0)) resolve(); }
    async function gate(entry) {
      while (entry.paused && !entry.controller.signal.aborted) await new Promise(resolve => entry.waiters.push(resolve));
      if (entry.controller.signal.aborted) throw new DOMException('已停止', 'AbortError');
    }
    async function allocate(entry) {
      const parts = entry.job.filename.split('/');
      let dir = entry.directory;
      for (const part of parts.slice(0, -1)) {
        await gate(entry); dir = await dir.getDirectoryHandle(part, { create: true });
      }
      const original = parts.at(-1), dot = original.lastIndexOf('.');
      const stem = dot > 0 ? original.slice(0, dot) : original, ext = dot > 0 ? original.slice(dot) : '';
      for (let index = 0; ; index++) {
        const name = index ? `${stem} (${index})${ext}` : original;
        const key = entry.directory.name + '/' + [...parts.slice(0, -1), name].join('/');
        if (reservations.has(key)) continue;
        reservations.add(key);
        try { await dir.getFileHandle(name); reservations.delete(key); continue; }
        catch (error) { if (error.name !== 'NotFoundError') { reservations.delete(key); throw error; } }
        entry.reservation = key;
        await gate(entry);
        const handle = await dir.getFileHandle(name, { create: true });
        entry.created = { dir, name };
        entry.job.actualFilename = key;
        return handle;
      }
    }
    async function run(entry) {
      let writer, reader;
      try {
        await gate(entry);
        const response = await fetcher(entry.job.url, { credentials: 'include', signal: entry.controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}，请确认课程登录与文件访问权限`);
        const mime = response.headers.get('content-type') || '';
        if (mime.includes('text/html') && !/\.html?$/i.test(entry.job.name) && !entry.job.mime?.includes('html')) throw new Error('服务器返回了网页而不是文件，可能需要重新登录');
        const length = Number(response.headers.get('content-length'));
        entry.job.totalBytes = length > 0 ? length : entry.job.expectedBytes || null;
        await gate(entry);
        const handle = await allocate(entry);
        writer = await handle.createWritable();
        if (!response.body) throw new Error('服务器没有返回可读取的文件内容');
        reader = response.body.getReader();
        let lastUpdate = 0;
        while (true) {
          await gate(entry);
          const { value, done } = await reader.read();
          if (done) break;
          await gate(entry);
          await writer.write(value);
          entry.job.bytesReceived += value.byteLength;
          if (Date.now() - lastUpdate >= 150) { emit(entry); lastUpdate = Date.now(); }
        }
        await gate(entry);
        await writer.close(); writer = null;
        entry.job.state = 'complete'; entry.job.pathVerified = true;
        entry.job.totalBytes = entry.job.bytesReceived;
      } catch (error) {
        if (writer) { try { await writer.abort(); } catch {} }
        if (entry.created) { try { await entry.created.dir.removeEntry(entry.created.name); } catch {} }
        if (entry.job.state !== 'cancelled') {
          entry.job.state = 'interrupted';
          entry.job.error = error.name === 'TypeError' ? `无法读取文件内容，请确认网站授权和登录状态，或切换默认下载目录：${error.message}` : error.message || String(error);
        }
      } finally {
        if (reader) { try { await reader.cancel(); } catch {} }
        reservations.delete(entry.reservation); entries.delete(entry.job.jobId); emit(entry); active--; pump();
      }
    }
    function pump() {
      for (const entry of entries.values()) {
        if (active >= 3) break;
        if (entry.job.state !== 'queued' || entry.started) continue;
        entry.started = true; entry.job.state = 'in_progress'; active++;
        emit(entry); run(entry);
      }
    }
    function start(directory, jobs) {
      for (const job of jobs) entries.set(job.jobId, { directory, job, controller: new AbortController(), waiters: [], paused: false, started: false });
      pump();
    }
    function control(action, jobId) {
      for (const entry of entries.values()) {
        if (jobId && entry.job.jobId !== jobId) continue;
        if (!['queued', 'in_progress', 'paused'].includes(entry.job.state)) continue;
        if (action === 'pause') { entry.paused = true; entry.job.state = 'paused'; }
        else if (action === 'resume' && entry.paused) { entry.paused = false; entry.job.state = entry.started ? 'in_progress' : 'queued'; wake(entry); }
        else if (action === 'stop') { entry.job.state = 'cancelled'; entry.paused = false; entry.controller.abort(); wake(entry); }
        emit(entry);
      }
      pump();
    }
    return { start, control };
  }
  root.CanvasDirectoryDownloads = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})(globalThis);
