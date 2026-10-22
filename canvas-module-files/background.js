importScripts('core.js');
const C = CanvasFilesCore;
chrome.action.onClicked.addListener(async tab => {
  const url = tab.url ? new URL(tab.url) : null;
  const courseId = url?.pathname.match(/^\/courses\/(\d+)(?:\/|$)/)?.[1];
  const params = new URLSearchParams(courseId ? { tab: String(tab.id), origin: url.origin, course: courseId } : {});
  await chrome.tabs.create({ url: chrome.runtime.getURL('app.html') + '?' + params });
});

let chain = Promise.resolve();
let startingJob = null;
let liveJobs = [], controlOrder = 0;
const courseControls = new Map(), jobControls = new Map(), nativeControls = new Map(), controlResults = new Map();
const requestedNames = new Map();
function intentFor(job) {
  const course = courseControls.get(job.courseKey), candidate = jobControls.get(job.jobId);
  const own = candidate?.courseKey === job.courseKey ? candidate : null;
  return !course ? own : !own || course.order > own.order ? course : own;
}
// Browser start requests may wait for a network response or a save dialog.
// Control existing download IDs immediately, outside that serialized start wait.
function controlNative(job) {
  const id = job.downloadId;
  if (id == null) return Promise.resolve(null);
  const task = (nativeControls.get(id) || Promise.resolve()).then(async () => {
    const intent = intentFor(job);
    if (!intent) return null;
    const previous = controlResults.get(job.jobId);
    if (previous?.order === intent.order && previous.id === id) return previous.failure;
    let failure = null;
    try {
      const [before] = await chrome.downloads.search({ id });
      if (before) syncJob(job, before);
      if (before?.state === 'in_progress') {
        if (intent.action === 'pause' && !before.paused) await chrome.downloads.pause(id);
        if (intent.action === 'resume' && before.paused) await chrome.downloads.resume(id);
        if (intent.action === 'stop') await chrome.downloads.cancel(id);
        const [after] = await chrome.downloads.search({ id });
        if (after) syncJob(job, after);
        const active = after?.state === 'in_progress';
        if (intent.action === 'pause' && active && !after.paused) throw new Error('Chrome 未确认暂停，任务仍在下载');
        if (intent.action === 'resume' && active && after.paused) throw new Error('Chrome 未确认继续，任务仍已暂停');
        if (intent.action === 'stop' && active) throw new Error('Chrome 未确认停止，任务仍在下载');
        if (intent.action === 'stop' && after?.state !== 'complete') job.state = 'cancelled';
      } else if (!before) {
        job.state = intent.action === 'stop' ? 'cancelled' : 'interrupted';
        if (intent.action !== 'stop') throw new Error('Chrome 已不再保留此下载记录');
      }
      job.controlError = '';
    } catch (error) {
      job.controlError = job.error = error.message;
      failure = { jobId: job.jobId, name: job.name, error: error.message };
    }
    controlResults.set(job.jobId, { id, order: intent.order, failure });
    return failure;
  });
  nativeControls.set(id, task);
  task.finally(() => { if (nativeControls.get(id) === task) nativeControls.delete(id); });
  return task;
}
function signalControl(message) {
  const intent = { action: message.action, order: ++controlOrder, courseKey: message.courseKey };
  if (message.jobId) jobControls.set(message.jobId, intent);
  else courseControls.set(message.courseKey, intent);
  const matching = liveJobs.filter(j => j.courseKey === message.courseKey && (!message.jobId || j.jobId === message.jobId) && ['queued', 'in_progress', 'paused'].includes(j.state));
  for (const job of matching) {
    jobControls.set(job.jobId, intent);
    if (job.downloadId == null && job !== startingJob) {
      if (message.action === 'pause') job.state = 'paused';
      if (message.action === 'resume' && job.state === 'paused') job.state = 'queued';
      if (message.action === 'stop') job.state = 'cancelled';
    }
  }
  return Promise.all(matching.map(controlNative));
}
chrome.downloads.onCreated?.addListener(item => {
  if (!startingJob || item.byExtensionId !== chrome.runtime.id || item.url !== startingJob.url) return;
  startingJob.downloadId = item.id;
  requestedNames.set(item.id, { filename: startingJob.filename });
  controlNative(startingJob);
});
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id) { suggest(); return; }
  const known = requestedNames.get(item.id) || (startingJob?.url === item.url ? startingJob : null);
  if (known) {
    suggest({ filename: known.filename, conflictAction: 'uniquify' });
    if (known === startingJob) { startingJob.downloadId = item.id; controlNative(startingJob); }
    return;
  }
  chrome.storage.local.get('downloadJobs').then(({ downloadJobs = [] }) => {
    const job = downloadJobs.find(j => j.downloadId === item.id);
    suggest(job ? { filename: job.filename, conflictAction: 'uniquify' } : undefined);
  }, () => suggest());
  return true;
});
function serialized(fn) {
  const task = chain.then(fn); chain = task.catch(() => {}); return task;
}
function syncJob(job, item) {
  job.state = item.state === 'interrupted' && (item.error === 'USER_CANCELED' || job.state === 'cancelled') ? 'cancelled' : item.state === 'in_progress' && item.paused ? 'paused' : item.state;
  job.error = job.controlError || (job.state === 'cancelled' ? '' : item.error || '');
  job.bytesReceived = Math.max(0, item.bytesReceived || 0);
  job.totalBytes = item.totalBytes > 0 ? item.totalBytes : job.expectedBytes || null;
  job.canResume = item.canResume || false;
  if (item.filename) C.checkSavedPath(job, item.filename);
}
async function pump(jobs) {
  jobs = C.trimJobs(jobs);
  liveJobs = jobs;
  const ids = new Set(jobs.map(j => j.jobId));
  for (const id of jobControls.keys()) if (!ids.has(id)) { jobControls.delete(id); controlResults.delete(id); }
  // Reconcile after a service-worker restart before starting more jobs.
  for (const job of jobs.filter(j => (['in_progress', 'paused'].includes(j.state) && j.downloadId != null) || (j.state === 'complete' && !j.actualFilename))) {
    const [item] = await chrome.downloads.search({ id: job.downloadId });
    if (item) syncJob(job, item);
    if (!item) { job.state = 'interrupted'; job.error = 'Chrome 已不再保留此下载记录'; }
    if (item?.filename) C.checkSavedPath(job, item.filename);
  }
  await chrome.storage.local.set({ downloadJobs: jobs });
  const { pausedDownloadCourses = {} } = await chrome.storage.local.get('pausedDownloadCourses');
  let running = jobs.filter(j => ['in_progress', 'paused'].includes(j.state) && j.downloadId != null).length;
  for (const job of jobs) {
    if (running >= 3) break;
    if (job.state !== 'queued') continue;
    const intent = intentFor(job);
    if (intent?.action === 'stop') { job.state = 'cancelled'; continue; }
    if (intent?.action === 'pause') { job.state = 'paused'; continue; }
    if (pausedDownloadCourses[job.courseKey] && !job.resumeIndividually) continue;
    try {
      startingJob = job;
      job.downloadId = await chrome.downloads.download({ url: job.url, filename: job.filename, conflictAction: 'uniquify', saveAs: false });
      requestedNames.set(job.downloadId, { filename: job.filename });
      if (!['paused', 'cancelled', 'complete', 'interrupted'].includes(job.state)) job.state = 'in_progress';
      job.startedAt = new Date().toISOString();
      await controlNative(job);
      if (['in_progress', 'paused'].includes(job.state)) running++;
    } catch (error) { job.state = intentFor(job)?.action === 'stop' ? 'cancelled' : 'interrupted'; job.error = error.message; }
    finally { startingJob = null; }
  }
  await chrome.storage.local.set({ downloadJobs: jobs });
  return jobs;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['START_DOWNLOADS', 'REFRESH_DOWNLOADS', 'SHOW_DOWNLOAD', 'CONTROL_DOWNLOADS', 'MAINTAIN_DATA', 'SAVE_SCAN', 'CLEAR_DATA'].includes(message.type)) return;
  // Only extension pages may create download jobs.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  const immediate = message.type === 'CONTROL_DOWNLOADS' && ['pause', 'resume', 'stop'].includes(message.action) ? signalControl(message) : Promise.resolve([]);
  serialized(async () => {
    const stored = await chrome.storage.local.get(['downloadJobs', 'scanResults']);
    const jobs = C.trimJobs(stored.downloadJobs || []);
    liveJobs = jobs;
    if (['MAINTAIN_DATA', 'SAVE_SCAN', 'CLEAR_DATA'].includes(message.type)) {
      let scans = stored.scanResults || {}, retainedJobs = jobs;
      if (message.type === 'SAVE_SCAN') scans[message.courseKey] = message.result;
      if (message.type === 'CLEAR_DATA') {
        scans = {}; retainedJobs = jobs.filter(j => ['queued', 'in_progress', 'paused'].includes(j.state));
      }
      scans = C.trimScans(scans);
      await chrome.storage.local.set({ scanResults: scans, downloadJobs: retainedJobs });
      return { jobs: retainedJobs, scanResults: scans };
    }
    if (message.type === 'CONTROL_DOWNLOADS') {
      if (!['pause', 'resume', 'stop'].includes(message.action)) throw new Error('未知下载操作');
      const controlErrors = (await immediate).filter(Boolean);
      if (!message.jobId) {
        const { pausedDownloadCourses = {} } = await chrome.storage.local.get('pausedDownloadCourses');
        if (message.action === 'pause') pausedDownloadCourses[message.courseKey] = true;
        else delete pausedDownloadCourses[message.courseKey];
        await chrome.storage.local.set({ pausedDownloadCourses });
      }
      for (const job of jobs.filter(j => j.courseKey === message.courseKey && (!message.jobId || j.jobId === message.jobId) && ['queued', 'in_progress', 'paused'].includes(j.state))) {
        try {
          if (message.action === 'pause' || message.action === 'stop' || !message.jobId) job.resumeIndividually = false;
          if (job.downloadId != null) {
            const failure = await controlNative(job);
            const [item] = await chrome.downloads.search({ id: job.downloadId });
            if (item) syncJob(job, item);
            if (failure) { job.controlError = job.error = failure.error; controlErrors.push(failure); }
          } else if (message.action === 'pause') {
            job.state = 'paused';
          } else if (message.action === 'resume' && job.state === 'paused') {
            job.resumeIndividually = Boolean(message.jobId);
            job.state = 'queued'; job.error = '';
          } else if (message.action === 'stop') {
            job.state = 'cancelled'; job.error = '';
          }
        } catch (error) { job.error = error.message; controlErrors.push({ jobId: job.jobId, name: job.name, error: error.message }); }
      }
      await chrome.storage.local.set({ downloadJobs: jobs });
      return { jobs: await pump(jobs), addedCount: 0, controlErrors: [...new Map(controlErrors.map(e => [e.jobId, e])).values()] };
    }
    if (message.type === 'SHOW_DOWNLOAD') {
      const job = jobs.find(j => j.jobId === message.jobId && j.downloadId != null);
      if (!job) throw new Error('没有找到此文件的 Chrome 下载记录');
      await chrome.downloads.show(job.downloadId);
      return { jobs, addedCount: 0 };
    }
    let addedCount = 0, batchId = null;
    if (message.type === 'START_DOWNLOADS') {
      if (message.appVersion !== chrome.runtime.getManifest().version) throw new Error('文件助手页面仍是旧版本。请关闭此页，回到课程重新点击插件图标。');
      const result = stored.scanResults?.[message.courseKey];
      if (!result) throw new Error('请先扫描课程');
      if (!Array.isArray(message.keys) || !message.keys.length) throw new Error('请先勾选文件');
      if (courseControls.get(message.courseKey)?.action === 'stop') courseControls.delete(message.courseKey);
      batchId = crypto.randomUUID();
      const selected = new Set(message.keys);
      const explicitExternalKeys = new Set(Array.isArray(message.explicitExternalKeys) ? message.explicitExternalKeys : []);
      if (result.files.some(f => f.canvas === false && selected.has(f.key) && !explicitExternalKeys.has(f.key))) throw new Error('外部直链需在独立区域额外勾选后再下载');
      for (const file of result.files.filter(f => selected.has(f.key) && f.downloadable)) {
        const url = new URL(file.downloadUrl);
        if (!['https:', 'http:'].includes(url.protocol)) continue;
        for (const target of C.downloadTargets(result.courseName, file, message)) {
          if (jobs.some(j => j.fileKey === file.key && j.filename === target.filename && ['queued', 'in_progress', 'paused'].includes(j.state))) continue;
          jobs.push({ jobId: crypto.randomUUID(), batchId, courseKey: message.courseKey, fileKey: file.key, name: file.name, url: url.href, ...target, bytesReceived: 0, expectedBytes: file.size || null, state: 'queued', createdAt: new Date().toISOString() });
          addedCount++;
        }
      }
    }
    return { jobs: await pump(jobs), addedCount, batchId };
  }).then(data => respond({ ok: true, ...data }), error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state && !delta.error && !delta.filename && !delta.paused) return;
  serialized(async () => {
    const { downloadJobs = [] } = await chrome.storage.local.get('downloadJobs');
    const job = downloadJobs.find(j => j.downloadId === delta.id);
    if (!job) return;
    if (delta.state && job.state !== 'cancelled') job.state = delta.state.current;
    if (delta.error) job.error = delta.error.current;
    if (delta.filename?.current) C.checkSavedPath(job, delta.filename.current);
    if (job.downloadId != null) {
      const [item] = await chrome.downloads.search({ id: delta.id });
      if (item) syncJob(job, item);
    }
    if (['complete', 'interrupted', 'cancelled'].includes(job.state)) requestedNames.delete(delta.id);
    await pump(downloadJobs);
  });
});
chrome.runtime.onStartup.addListener(() => serialized(async () => {
  const { downloadJobs = [] } = await chrome.storage.local.get('downloadJobs');
  await pump(downloadJobs);
}));
