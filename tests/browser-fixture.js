(function () {
  'use strict';
  // This shim is loaded by the development fixture server only. Production
  // extension files do not reference it, and release packages exclude tests/.
  if (location.pathname === '/checks') { installChecks(); return; }
  if (location.pathname === '/layout') { installLayout(); return; }
  const origin = location.origin, courseKey = `${origin}:42`;
  const sources = [
    { moduleId: '1', moduleName: 'Week 1 — Lectorial 开关电源基本原理与实际电路的分析方法', pageTitle: 'Week 1 - Lectorial: Fundamental principles and practical design considerations', pageUrl: origin + '/courses/42/pages/lectorial-1' },
    { moduleId: '2', moduleName: 'Week 2 — Laboratory preparation and detailed measurement instructions', pageTitle: 'Week 2 - Laboratory preparation — 测量方法与注意事项', pageUrl: origin + '/courses/42/pages/lectorial-2' },
    { moduleId: '3', moduleName: 'Week 3 — Feedback control, stability and transient response', pageTitle: 'Feedback control: extended reading and worked examples', pageUrl: origin + '/courses/42/pages/lectorial-3' }
  ];
  const names = [
    'EEET2386_2026_Week_01_Lectorial_开关电源基础与工作模式完整讲义.pdf',
    'Week_02_Laboratory_Preparation_Detailed_Measurement_Instructions_and_Examples.pptx',
    '设计报告模板_实验记录与测量结果说明.docx',
    'Feedback_loop_compensation_and_transient_response_worked_examples.pdf',
    'Buck_converter_design_and_measurement_results_2026.xlsx', 'Sim03_电源设计与瞬态分析.psimsch'
  ];
  const files = names.map((name, i) => ({ key: `fixture-${i}`, id: String(i + 1), name, canvas: true, downloadable: true,
    category: ['PDF', 'PPT', 'Word', 'PDF', 'Excel', 'PSIM'][i], size: 1024 * (i + 1), access: 'available', mime: '',
    downloadUrl: origin + '/fixture/data?bytes=1024', sources: i === 0 ? sources.slice(0, 2) : [sources[i % sources.length]] }));
  files.push({ ...files[0], key: 'external-fixture', canvas: false, name: 'External_reference_materials_and_supporting_documentation.pdf', downloadUrl: origin + '/fixture/data?bytes=2048' });
  const scan = { scanVersion: 2, origin, courseId: '42', courseName: 'Switched Mode Power Supplies (2650) — 开关电源课程资料与实验说明', scannedAt: new Date().toISOString(), complete: true,
    modules: sources.map((source, i) => ({ id: source.moduleId, name: source.moduleName, position: i + 1, items: 3, files: 2, errors: 0 })),
    files, warnings: [], externalLinks: [], stats: { modules: 3, items: 9, pages: 6, requests: 18, ignoredImages: 5, mergedReferences: 1 } };
  const jobs = files.slice(0, 3).map((file, i) => ({ jobId: `fixture-job-${i}`, batchId: 'fixture-batch', courseKey, fileKey: file.key, name: file.name,
    filename: `Canvas/${scan.courseName}/${file.sources[0].moduleName}/${file.name}`, expectedBytes: file.size, totalBytes: file.size, bytesReceived: i ? 0 : file.size,
    state: i ? 'interrupted' : 'complete', error: i ? 'NETWORK_FAILED' : '', createdAt: new Date().toISOString() }));
  const store = { scanResults: { [courseKey]: scan }, downloadJobs: jobs, uiLanguage: new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh-CN', groupByModule: true, groupByPage: true, sharedFileMode: 'once', downloadMode: 'files' };
  const listeners = [];
  async function set(values) {
    const changes = {};
    for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: store[key], newValue: value }; store[key] = value; }
    for (const listener of listeners) listener(changes, 'local');
  }
  globalThis.CanvasBrowserFixture = { refreshTaskProgress: async () => {
    const updated = store.downloadJobs.map((job, index) => index === 1 ? { ...job, bytesReceived: Math.min(job.totalBytes, (job.bytesReceived || 0) + 1) } : { ...job });
    await set({ downloadJobs: updated });
  } };
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '1.0.0' }), onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type === 'RETRY_DOWNLOADS') {
        const batchId = crypto.randomUUID();
        const retried = store.downloadJobs.filter(job => message.jobIds.includes(job.jobId)).map(job => ({ ...job, jobId: crypto.randomUUID(), batchId, state: 'complete', error: '', bytesReceived: job.totalBytes, createdAt: new Date().toISOString() }));
        await set({ downloadJobs: [...store.downloadJobs, ...retried] });
        return { ok: true, jobs: structuredClone(store.downloadJobs), batchId, addedCount: retried.length };
      }
      if (message.type === 'SAVE_SCAN') await set({ scanResults: { [courseKey]: scan } });
      if (message.type === 'CLEAR_DATA') await set({ scanResults: {}, downloadJobs: [] });
      return { ok: true, jobs: structuredClone(store.downloadJobs), addedCount: 0, saved: true };
    } },
    storage: { local: { get: async () => structuredClone(store), set, getBytesInUse: async () => new TextEncoder().encode(JSON.stringify(store)).length }, onChanged: { addListener: listener => listeners.push(listener) } },
    tabs: { get: async () => ({ id: 1, url: origin + '/courses/42/modules' }), update: async () => {}, create: async () => {} },
    scripting: { executeScript: async args => args.func ? [{ result: structuredClone(scan) }] : [] },
    permissions: { request: async () => false }
  };
  const banner = document.createElement('p');
  banner.textContent = '内部测试页面 / Internal UI fixture — all files and Chrome task states shown here are simulated.';
  banner.style.cssText = 'margin:0;padding:10px 20px;background:#fff4d8;color:#644800;text-align:center;font:13px system-ui;overflow-wrap:anywhere';
  document.body.prepend(banner);

  function installLayout() {
    const byId = id => document.getElementById(id), params = new URLSearchParams(location.search);
    const width = Math.max(320, Math.min(1600, Number(params.get('width')) || 390));
    const lang = params.get('lang') === 'en' ? 'en' : 'zh-CN';
    const frame = byId('fixtureFrame'); frame.style.width = width + 'px';
    const describeFocus = doc => {
      const element = doc.activeElement, row = element?.closest('tr[data-key]');
      return row ? { row: row.dataset.key, tag: element.tagName, type: element.type || '', checked: element.type === 'checkbox' ? element.checked : null } : null;
    };
    const expanded = doc => Array.from(doc.querySelectorAll('#files tr, #directFiles tr'), row => [row.dataset.key, Array.from(row.querySelectorAll('details'), detail => detail.open)]);
    function measure() {
      const doc = frame.contentDocument;
      if (!doc?.querySelector('#files tr')) return false;
      const viewport = doc.documentElement.clientWidth, scroll = doc.documentElement.scrollWidth;
      const ok = scroll <= viewport;
      byId('layoutSummary').textContent = `${ok ? 'PASS' : 'FAIL'} — ${lang}, iframe ${width}px; viewport ${viewport}px, document scrollWidth ${scroll}px ${ok ? '(no horizontal page overflow)' : '(horizontal page overflow)'}`;
      byId('layoutSummary').dataset.result = ok ? 'pass' : 'fail';
      byId('layoutDetails').textContent = JSON.stringify({ viewport, scrollWidth: scroll, language: doc.documentElement.lang, filenameRows: doc.querySelectorAll('#files tr').length,
        tables: Array.from(doc.querySelectorAll('.table-wrap'), wrap => ({ clientWidth: wrap.clientWidth, scrollWidth: wrap.scrollWidth })) }, null, 2);
      return true;
    }
    frame.onload = () => {
      const started = Date.now();
      const timer = setInterval(() => { if (measure() || Date.now() - started > 10000) clearInterval(timer); }, 100);
    };
    frame.src = `/app.html?tab=1&origin=${encodeURIComponent(location.origin)}&course=42&lang=${lang}`;
    byId('prepareFocus').onclick = () => {
      const doc = frame.contentDocument, row = doc.querySelector('#files tr');
      if (!row) return;
      const details = row.querySelector('details'); if (details) details.open = true;
      row.querySelector('input[type="checkbox"]')?.focus();
      byId('focusSummary').textContent = 'Ready — first file checkbox focused and source details expanded. Press Space to test keyboard selection, then refresh.';
      measure();
    };
    // Prevent a mouse click on the test control from replacing the iframe's
    // keyboard target before the production app processes the storage update.
    byId('refreshTask').onpointerdown = event => event.preventDefault();
    byId('refreshTask').onclick = async () => {
      const doc = frame.contentDocument, before = describeFocus(doc), opened = expanded(doc);
      await frame.contentWindow.CanvasBrowserFixture.refreshTaskProgress();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const after = describeFocus(doc), kept = JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(opened) === JSON.stringify(expanded(doc));
      byId('focusSummary').textContent = before ? `${kept ? 'PASS' : 'FAIL'} — focused checkbox/checked state and expanded source details ${kept ? 'preserved' : 'changed'} after task progress refresh.` : 'READY — focus a file checkbox before refreshing.';
      byId('focusSummary').dataset.result = before ? kept ? 'pass' : 'fail' : 'ready';
      measure();
    };
  }

  function installChecks() {
    const byId = id => document.getElementById(id), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const list = async dir => { const names = []; for await (const [name] of dir.entries()) names.push(name); return names; };
    async function until(check, label, timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await sleep(20); }
    }
    const terminal = job => ['complete', 'interrupted', 'cancelled'].includes(job.state);
    const target = (endpoint, filename, size = null) => ({ filename, file: { key: filename, name: filename.split('/').pop(), category: '代码与数据', size, downloadUrl: location.origin + endpoint, sources: [{ moduleId: '1', moduleName: 'Week 1', pageTitle: 'Week 1 - Lectorial' }] } });
    const job = id => ({ jobId: id, name: 'Browser_internal_checks.zip', bytesReceived: 0, state: 'queued' });
    const checkPattern = (bytes, expected) => { assert(bytes?.length === expected, `Wrong content length: ${bytes?.length} / ${expected}`); for (let i = 0; i < bytes.length; i++) if (bytes[i] !== i % 251) throw new Error('ZIP content mismatch at byte ' + i); };
    function passed(message) { const li = document.createElement('li'); li.textContent = 'PASS — ' + message; byId('checkResults').append(li); }
    byId('runChecks').onclick = async () => {
      byId('runChecks').disabled = true; byId('checkResults').replaceChildren(); byId('checkDetails').textContent = ''; byId('summary').textContent = 'Running browser checks…';
      let root, name, working;
      const active = [];
      try {
        assert(navigator.storage?.getDirectory, 'Browser OPFS unavailable');
        root = await navigator.storage.getDirectory(); name = `canvas-browser-check-${crypto.randomUUID()}`;
        working = await root.getDirectoryHandle(name, { create: true });
        const temp = await working.getDirectoryHandle('temp', { create: true });
        const updates = []; let verified = false;
        const engine = CanvasZipDownloads.create({ getTempDirectory: async () => temp, idleTimeoutMs: 2000, maxRetries: 0,
          onUpdate: state => { updates.push({ stage: state.stage, bytes: state.bytesReceived, percent: state.progressPercent }); byId('checkProgress').value = state.progressPercent || 0; },
          saveBlob: async blob => {
            const archive = fflate.unzipSync(new Uint8Array(await blob.arrayBuffer()));
            checkPattern(archive['Canvas/Week 1/large.bin'], 16 * 1024 * 1024);
            checkPattern(archive['Canvas/Week 1/redirect.bin'], 4096);
            checkPattern(archive['Canvas/Week 1/unknown.bin'], 65536);
            assert(!archive['Canvas/Week 1/denied.bin'] && !archive['Canvas/Week 1/login.bin'], 'Failed file entered ZIP');
            const errors = JSON.parse(new TextDecoder().decode(archive['下载失败清单.json']));
            assert(errors.length === 2 && errors.some(error => error.error === 'HTTP 401'), 'Failure manifest missing');
            assert(errors.every(error => error.sources[0].pageTitle === 'Week 1 - Lectorial'), 'Sources missing from failure manifest');
            verified = true; return 'Browser memory validation';
          } });
        active.push(engine); const main = job('browser-large');
        engine.start(null, [target('/fixture/data?bytes=16777216&delay=2', 'Canvas/Week 1/large.bin', 16777216), target('/fixture/redirect', 'Canvas/Week 1/redirect.bin'), target('/fixture/data?bytes=65536&unknown=1', 'Canvas/Week 1/unknown.bin'), target('/fixture/denied', 'Canvas/Week 1/denied.bin'), target('/fixture/login-redirect', 'Canvas/Week 1/login.bin')], main);
        await until(() => terminal(main), '16 MiB ZIP'); assert(main.state === 'complete', main.error || main.phase);
        await until(async () => (await list(temp)).length === 0, 'ZIP temporary cleanup');
        assert(verified && main.entriesDone === 3 && main.entriesFailed === 2, 'Unexpected ZIP result');
        assert(updates.some(update => update.stage === 'collecting' && update.percent > 0 && update.percent < 95), 'No receiving progress');
        assert(updates.some(update => update.stage === 'packing'), 'No packing progress');
        passed('16 MiB real streamed response, HTTP redirect, unknown length, 401 and login redirect; complete ZIP bytes and source reports verified; OPFS staging/output cleaned');

        let paused = false, pausedBytes, pauseVerified = false;
        const pauseEngine = CanvasZipDownloads.create({ getTempDirectory: async () => temp, idleTimeoutMs: 2000, maxRetries: 0,
          onUpdate: state => { if (!paused && state.bytesReceived > 0 && state.stage === 'collecting') { paused = true; pausedBytes = state.bytesReceived; pauseEngine.control('pause'); } },
          saveBlob: async blob => { const contents = fflate.unzipSync(new Uint8Array(await blob.arrayBuffer())); checkPattern(contents['pause.bin'], 2 * 1024 * 1024); return 'Browser memory validation'; } });
        active.push(pauseEngine); const pausing = job('browser-pause');
        pauseEngine.start(null, [target('/fixture/data?bytes=2097152&delay=15', 'pause.bin', 2097152)], pausing);
        await until(() => pausing.state === 'paused', 'pause starts'); await sleep(150);
        assert(pausing.bytesReceived === pausedBytes, 'Paused receiving counter changed'); pauseVerified = true; pauseEngine.control('resume');
        await until(() => terminal(pausing), 'resumed ZIP'); assert(pausing.state === 'complete' && pauseVerified, pausing.error || 'Resume failed');
        await until(async () => (await list(temp)).length === 0, 'pause cleanup');
        passed('Pause holds received progress; resume finishes a valid ZIP and releases OPFS files');

        let stopped = false;
        const stopEngine = CanvasZipDownloads.create({ getTempDirectory: async () => temp, onUpdate: state => { if (!stopped && state.bytesReceived > 0) { stopped = true; stopEngine.control('stop'); } }, saveBlob: async () => { throw new Error('Stopped ZIP was saved'); } });
        active.push(stopEngine); const stopping = job('browser-stop'); stopEngine.start(null, [target('/fixture/data?bytes=2097152&delay=20', 'stop.bin')], stopping);
        await until(() => stopping.phase?.includes('临时数据'), 'stop settled');
        assert(stopping.state === 'cancelled', 'Stop state overwritten'); assert((await list(temp)).length === 0, 'Stopped files not cleaned');
        passed('Stop aborts real network input and removes unfinished OPFS files');

        let timeoutVerified = false;
        const timeoutEngine = CanvasZipDownloads.create({ getTempDirectory: async () => temp, idleTimeoutMs: 150, maxRetries: 0, saveBlob: async blob => {
          const contents = fflate.unzipSync(new Uint8Array(await blob.arrayBuffer())); checkPattern(contents['after-timeout.bin'], 4096);
          const failures = JSON.parse(new TextDecoder().decode(contents['下载失败清单.json']));
          assert(failures.length === 1 && failures[0].error.includes('超时'), 'Missing timeout failure'); timeoutVerified = true; return 'Browser memory validation';
        } });
        active.push(timeoutEngine); const timing = job('browser-timeout'); timeoutEngine.start(null, [target('/fixture/stall', 'stalled.bin'), target('/fixture/data?bytes=4096', 'after-timeout.bin')], timing);
        await until(() => terminal(timing), 'idle timeout'); assert(timing.state === 'complete' && timeoutVerified, timing.error || 'Timeout skip failed');
        await until(async () => (await list(temp)).length === 0, 'timeout cleanup');
        passed('Idle network timeout skips a stalled body, keeps later files and cleans temporary data');

        const tooLarge = job('browser-limit'); const limitEngine = CanvasZipDownloads.create({ getTempDirectory: async () => temp, saveBlob: async () => { throw new Error('Oversized batch saved'); } });
        active.push(limitEngine); limitEngine.start(null, [target('/fixture/data', 'too-large.bin', 0xffff0000)], tooLarge);
        await until(() => terminal(tooLarge), 'ZIP32 limit'); assert(tooLarge.state === 'interrupted' && tooLarge.error.includes('4 GB'), 'ZIP32 size check missing'); assert((await list(temp)).length === 0, 'ZIP32 rejection left files');
        passed('4 GB boundary is rejected before downloading or allocating a large file');
        await root.removeEntry(name, { recursive: true }); name = null;
        byId('summary').textContent = 'PASS — 5 browser check groups completed; all temporary OPFS files removed.';
        byId('summary').dataset.result = 'pass'; byId('checkProgress').value = 100;
        byId('checkDetails').textContent = JSON.stringify({ userAgent: navigator.userAgent, testBytes: 16777216, source: 'Local fixtures only; no real Canvas login or native Chrome download manager exercised', completedAt: new Date().toISOString() }, null, 2);
      } catch (error) {
        byId('summary').textContent = 'FAIL — ' + error.message; byId('summary').dataset.result = 'fail'; byId('checkDetails').textContent = error.stack || String(error);
      } finally {
        for (const engine of active) engine.control('stop');
        if (name && root) { await sleep(100); try { await root.removeEntry(name, { recursive: true }); } catch (error) { byId('checkDetails').textContent += '\nCleanup: ' + error.message; } }
        byId('runChecks').disabled = false;
      }
    };
  }
})();
