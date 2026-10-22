(function (root) {
  'use strict';
  function create(options = {}) {
    const entries = new Map(), fetcher = options.fetch || fetch;
    const library = options.zip || root.fflate;
    const limit = 0xffff0000;
    function emit(e) { options.onUpdate?.(e.job); }
    function wake(e) { for (const done of e.waiters.splice(0)) done(); }
    async function gate(e) {
      while (e.paused && !e.controller.signal.aborted) await new Promise(done => e.waiters.push(done));
      if (e.controller.signal.aborted) throw new DOMException('已停止', 'AbortError');
    }
    function progress(e, fraction = 0, indeterminate = false) {
      e.job.progressPercent = Math.max(e.job.progressPercent, 95 * (e.job.entriesProcessed + fraction) / Math.max(1, e.targets.length));
      e.job.progressIndeterminate = indeterminate;
    }
    async function yieldUI(e) {
      if (Date.now() - (e.lastYield || 0) < 32) return;
      e.lastYield = Date.now();
      await new Promise(resolve => setTimeout(resolve, 0));
      await gate(e);
    }
    async function run(e) {
      let writer, created, reader, archive, temporary = false, outputHandle;
      const chunks = [], pending = [];
      let archiveBytes = 0, streamError;
      const flush = async () => {
        if (streamError) throw streamError;
        for (const chunk of pending.splice(0)) {
          archiveBytes += chunk.length;
          if (archiveBytes >= limit) throw new Error('本版 ZIP 单包上限为 4 GB，请分批勾选');
          if (writer) await writer.write(chunk); else chunks.push(chunk);
        }
      };
      try {
        if (e.targets.length >= 65534 || e.targets.reduce((n, t) => n + (t.file.size || 0), 0) >= limit) throw new Error('所选内容超出单包上限（4 GB / 65533 个文件），请分批勾选');
        const stagingDirectory = await options.getTempDirectory?.();
        const outputDirectory = e.directory || stagingDirectory;
        temporary = !e.directory && Boolean(outputDirectory);
        if (outputDirectory) {
          let name = e.job.name;
          for (let i = 0; ; i++) {
            name = i ? e.job.name.replace(/\.zip$/i, ` (${i}).zip`) : e.job.name;
            if (temporary) name = `${e.job.jobId}${i ? `-${i}` : ''}.zip`;
            try { await outputDirectory.getFileHandle(name); }
            catch (error) { if (error.name === 'NotFoundError') break; throw error; }
          }
          await gate(e);
          outputHandle = await outputDirectory.getFileHandle(name, { create: true });
          created = { dir: outputDirectory, name };
          writer = await outputHandle.createWritable();
          if (!temporary) e.job.actualFilename = `${e.directory.name}/${name}`;
        }
        archive = new library.Zip((error, data) => { if (error) streamError = error; else pending.push(data); });
        const used = new Set(), manifest = [];
        function unique(path) {
          const original = path; let i = 0;
          while (used.has(path.toLowerCase())) {
            const dot = original.lastIndexOf('.'), slash = original.lastIndexOf('/');
            path = dot > slash ? `${original.slice(0, dot)} (${++i})${original.slice(dot)}` : `${original} (${++i})`;
          }
          used.add(path.toLowerCase()); return path;
        }
        for (const [index, target] of e.targets.entries()) {
          const file = target.file, fileChunks = [];
          let stageWriter, stageFile, staged, response, received = 0;
          try {
            // Finish receiving one file before committing its ZIP entry. A failed
            // stream must not leave a truncated entry with a successful filename.
            try {
              await gate(e); e.job.stage = 'collecting';
              e.job.phase = `收集 ${index + 1} / ${e.targets.length}：${file.name}`;
              progress(e, 0, !(file.size > 0)); emit(e);
              response = await fetcher(file.downloadUrl, { credentials: 'include', signal: e.controller.signal });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              if ((response.headers.get('content-type') || '').includes('text/html') && !/\.html?$/i.test(file.name) && !file.mime?.includes('html')) throw new Error('服务器返回了登录页或普通网页，已跳过此文件');
              if (!response.body) throw new Error('服务器没有返回可读取的文件内容');
              if (stagingDirectory) {
                const name = `${e.job.jobId}-${index}.part`;
                const handle = await stagingDirectory.getFileHandle(name, { create: true });
                stageFile = { dir: stagingDirectory, name, handle };
                stageWriter = await handle.createWritable();
              }
              const size = Number(response.headers.get('content-length')) || file.size || null;
              progress(e, 0, !(size > 0)); emit(e);
              reader = response.body.getReader(); let lastUpdate = 0;
              while (true) {
                await gate(e); const { value, done } = await reader.read(); if (done) break;
                await gate(e); received += value.length; e.job.bytesReceived += value.length;
                if (received >= limit) throw new Error('单个文件超过 ZIP 上限，请改用逐个下载');
                if (stageWriter) await stageWriter.write(value); else fileChunks.push(value);
                progress(e, size > 0 ? .75 * Math.min(1, received / size) : 0, !(size > 0));
                if (Date.now() - lastUpdate >= 100) { emit(e); lastUpdate = Date.now(); }
                await yieldUI(e);
              }
              reader.releaseLock(); reader = null; await gate(e);
              if (stageWriter) { await stageWriter.close(); stageWriter = null; }
              staged = stageFile ? await stageFile.handle.getFile() : new Blob(fileChunks);
              fileChunks.length = 0;
            } catch (error) {
              if (e.controller.signal.aborted) throw error;
              const failure = { path: target.filename, key: file.key || null, name: file.name, category: file.category, bytesReceived: received, sources: file.sources, status: 'failed', error: error.message || String(error) };
              e.job.failures.push(failure); manifest.push(failure);
              e.job.entriesFailed++; e.job.entriesProcessed++;
              progress(e); emit(e); await yieldUI(e); continue;
            } finally {
              if (reader) { try { await reader.cancel(); } catch {} reader = null; }
              else if (response?.body) { try { await response.body.cancel(); } catch {} }
              if (stageWriter) { try { await stageWriter.abort(); } catch {} stageWriter = null; }
            }
            await gate(e); e.job.stage = 'packing';
            e.job.phase = `正在打包 ${index + 1} / ${e.targets.length}：${file.name}`;
            progress(e, .75); emit(e);
            const path = unique(target.filename), entry = new library.ZipPassThrough(path);
            archive.add(entry); await flush();
            reader = staged.stream().getReader(); let packed = 0, lastUpdate = 0;
            while (true) {
              await gate(e); const { value, done } = await reader.read(); if (done) break;
              await gate(e); entry.push(value, false); await flush(); packed += value.length;
              progress(e, .75 + .25 * (staged.size ? packed / staged.size : 1));
              if (Date.now() - lastUpdate >= 100) { emit(e); lastUpdate = Date.now(); }
              await yieldUI(e);
            }
            reader.releaseLock(); reader = null; entry.push(new Uint8Array(), true); await flush();
            manifest.push({ path, name: file.name, category: file.category, bytes: received, sources: file.sources, status: 'complete' });
            e.job.entriesDone++; e.job.entriesProcessed++; progress(e); emit(e);
          } finally {
            if (reader) { try { await reader.cancel(); } catch {} reader = null; }
            if (stageFile) { try { await stageFile.dir.removeEntry(stageFile.name); } catch {} }
            fileChunks.length = 0;
          }
        }
        if (!e.job.entriesDone) { e.job.allFilesFailed = true; throw new Error(`全部文件均下载失败，未生成空压缩包。${e.job.failures[0]?.error || ''}`); }
        await gate(e); e.job.stage = 'finalizing'; e.job.phase = '正在完成 ZIP…'; emit(e);
        const listing = new library.ZipPassThrough(unique('文件来源清单.json'));
        archive.add(listing); listing.push(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), true);
        if (e.job.failures.length) {
          const failures = new library.ZipPassThrough(unique('下载失败清单.json'));
          archive.add(failures); failures.push(new TextEncoder().encode(JSON.stringify(e.job.failures, null, 2)), true);
        }
        archive.end(); await flush(); await gate(e);
        e.job.progressPercent = 97; e.job.progressIndeterminate = false; e.job.archiveBytes = archiveBytes; emit(e);
        if (writer) { await writer.close(); writer = null; await gate(e); if (!temporary) created = null; }
        if (!e.directory) {
          const blob = temporary ? await outputHandle.getFile() : new Blob(chunks, { type: 'application/zip' }); chunks.length = 0;
          e.job.stage = 'saving'; e.job.phase = 'ZIP 已打包，等待 Chrome 保存'; emit(e);
          e.job.actualFilename = await options.saveBlob(blob, e.job);
          await gate(e);
        }
        e.job.state = 'complete'; e.job.stage = 'complete'; e.job.totalBytes = e.job.bytesReceived;
        e.job.progressPercent = 100;
        e.job.phase = e.job.entriesFailed ? `ZIP 已保存 · 成功 ${e.job.entriesDone} 个 · 跳过 ${e.job.entriesFailed} 个失败文件（已附失败清单）` : `ZIP 已保存 · ${e.job.entriesDone} 个文件（含来源清单）`;
      } catch (error) {
        archive?.terminate();
        if (writer) { try { await writer.abort(); } catch {} }
        if (created) { try { await created.dir.removeEntry(created.name); } catch {} }
        if (e.job.state !== 'cancelled') { e.job.state = 'interrupted'; e.job.error = error.message || String(error); }
        e.job.progressIndeterminate = false;
        e.job.phase = e.job.state === 'cancelled' ? '打包已停止，临时数据已释放' : `打包失败：${e.job.error}`;
      } finally {
        if (reader) { try { await reader.cancel(); } catch {} }
        if (created) { try { await created.dir.removeEntry(created.name); } catch {} }
        chunks.length = 0; pending.length = 0; entries.delete(e.job.jobId); emit(e);
      }
    }
    function start(directory, targets, job) {
      if (entries.size) throw new Error('已有 ZIP 正在处理，请完成或停止后再开始');
      Object.assign(job, { engine: 'zip', entriesTotal: targets.length, entriesDone: 0, entriesFailed: 0, entriesProcessed: 0, failures: [], progressPercent: 0, progressIndeterminate: false });
      const e = { directory, targets, job, paused: false, waiters: [], controller: new AbortController() };
      entries.set(job.jobId, e); job.state = 'in_progress'; emit(e); run(e);
    }
    function control(action, jobId) {
      for (const e of entries.values()) {
        if (jobId && e.job.jobId !== jobId) continue;
        if (!['in_progress', 'paused'].includes(e.job.state)) continue;
        if (action === 'pause') { e.paused = true; e.job.state = 'paused'; }
        if (action === 'resume') { e.paused = false; e.job.state = 'in_progress'; wake(e); }
        if (action === 'stop') { e.paused = false; e.job.state = 'cancelled'; e.controller.abort(); wake(e); }
        if (e.job.downloadId != null) options.controlSave?.(action, e.job);
        emit(e);
      }
    }
    return { start, control };
  }
  root.CanvasZipDownloads = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})(globalThis);
