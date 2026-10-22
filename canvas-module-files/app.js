'use strict';
const C = CanvasFilesCore;
const I = CanvasI18n, t = (key, values) => I.t(key, values);
const $ = id => document.getElementById(id);
const appVersion = chrome.runtime.getManifest().version;
$('appVersion').textContent = `v${appVersion}`;
const params = new URLSearchParams(location.search);
const config = { tabId: Number(params.get('tab')), origin: params.get('origin'), courseId: params.get('course') };
const courseKey = `${config.origin}:${config.courseId}`;
function fitDownloadPanel() {
  const panel = document.querySelector('.download-settings');
  if (!panel?.getBoundingClientRect) return;
  panel.style.setProperty('--panel-space', `${Math.max(240, window.innerHeight - Math.max(100, panel.getBoundingClientRect().top) - 16)}px`);
}
window.addEventListener?.('scroll', fitDownloadPanel, { passive: true });
window.addEventListener?.('resize', fitDownloadPanel);
let result = null, selected = new Set(), selectedExternal = new Set(), format = '', chapter = '', jobs = [], runId = '', busy = false;
let directory = null, directoryRootId = '', directoryJobs = [], latestBatchId = '', refreshPending = false, renderTimer = null;
let zipJobs = [];
let controlRequest = 0, holdingRowControl = false, deferredRows = false, foregroundRowsDirty = false;
function holdRowControl(event) { if (event.target.closest?.('.job-controls')) holdingRowControl = true; }
function releaseRowControl() {
  if (!holdingRowControl) return;
  // The click is dispatched after pointerup/keyup; retain its target until then.
  setTimeout(() => { holdingRowControl = false; if (deferredRows) { deferredRows = false; renderRows(); } }, 0);
}
document.addEventListener?.('pointerdown', holdRowControl);
document.addEventListener?.('pointerup', releaseRowControl);
document.addEventListener?.('pointercancel', releaseRowControl);
document.addEventListener?.('keydown', event => { if (['Enter', ' '].includes(event.key)) holdRowControl(event); });
document.addEventListener?.('keyup', releaseRowControl);
window.addEventListener?.('blur', releaseRowControl);
function foregroundUpdate(job) {
  if (job?.engine !== 'zip') foregroundRowsDirty = true;
  if (renderTimer == null) renderTimer = setTimeout(() => {
    renderTimer = null;
    if (foregroundRowsDirty) { foregroundRowsDirty = false; renderRows(); }
    else { renderProgress(); updateSelection(); }
  }, 100);
}
const directoryDownloads = CanvasDirectoryDownloads.create({ onUpdate: () => {
  foregroundUpdate();
}});
async function temporaryDirectory() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  const temp = await (await navigator.storage.getDirectory()).getDirectoryHandle('canvas-zip-temp', { create: true });
  for await (const [name, handle] of temp.entries()) {
    if (handle.kind !== 'file') continue;
    const file = await handle.getFile();
    if (Date.now() - file.lastModified > 86400000) await temp.removeEntry(name);
  }
  return temp;
}
async function saveZipBlob(blob, job) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: job.name, saveAs: true, conflictAction: 'uniquify' });
    job.downloadId = id;
    if (job.state === 'cancelled') await chrome.downloads.cancel(id);
    else if (job.state === 'paused') await chrome.downloads.pause(id);
    return await new Promise((resolve, reject) => {
      let checking = false;
      const check = async () => {
        if (checking) return; checking = true;
        try {
          const [item] = await chrome.downloads.search({ id });
          if (item?.state === 'complete') { cleanup(); resolve(item.filename); }
          else if (!item || item.state === 'interrupted') { cleanup(); reject(new Error(item?.error || t("ZIP save cancelled"))); }
        } catch (error) { cleanup(); reject(error); }
        finally { checking = false; }
      };
      const listener = delta => { if (delta.id === id) check(); };
      const timer = setInterval(check, 1000);
      function cleanup() { clearInterval(timer); chrome.downloads.onChanged.removeListener(listener); }
      chrome.downloads.onChanged.addListener(listener); check();
    });
  } finally { URL.revokeObjectURL(url); }
}
const zipDownloads = CanvasZipDownloads.create({ onUpdate: foregroundUpdate, getTempDirectory: temporaryDirectory, saveBlob: saveZipBlob,
  controlSave: (action, job) => chrome.downloads[action === 'stop' ? 'cancel' : action](job.downloadId).catch(error => setStatus(I.message(error.message), true)) });
function allJobs() { return [...jobs, ...directoryJobs, ...zipJobs].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')); }
function renderProgress() {
  const courseJobs = allJobs().filter(j => j.courseKey === courseKey);
  $('downloadPanel').hidden = !courseJobs.length;
  $('zipFailurePanel').hidden = true;
  if (!courseJobs.length) return;
  const batchId = latestBatchId || courseJobs.at(-1).batchId;
  const batch = courseJobs.filter(j => j.batchId === batchId), p = C.progressSummary(batch);
  $('totalProgress').value = p.percent;
  const paused = batch.filter(j => j.state === 'paused').length, stopped = batch.filter(j => j.state === 'cancelled').length, failed = batch.filter(j => j.state === 'interrupted').length;
  $('totalProgressText').textContent = t("Completed {v0} / {v1} files · {v2}{v3}{v4}{v5}{v6}", {v0: p.completed, v1: batch.length, v2: bytes(p.received), v3: p.total != null ? ` / ${bytes(p.total)} (${p.percent.toFixed(1)}%)` : t(" · Some file sizes are unknown"), v4: paused ? t(" · {v0} paused", {v0: paused}) : '', v5: stopped ? t(" · {v0} stopped", {v0: stopped}) : '', v6: failed ? t(" · {v0} failed", {v0: failed}) : ''});
  if (batch[0]?.engine === 'zip') {
    const zip = batch[0], indeterminate = zip.progressIndeterminate && zip.state === 'in_progress';
    if (indeterminate) $('totalProgress').removeAttribute('value');
    const phase = zip.state === 'interrupted' ? zip.allFilesFailed ? t('All files failed; no empty archive was created.') : t('ZIP packing failed: {v0}', {v0: I.message(zip.error || '')}) : I.message(zip.phase) || t("Preparing ZIP");
    $('totalProgressText').textContent = `${phase} · ${t('Received {v0}', {v0: bytes(p.received)})} · ${indeterminate ? t('Size unknown; receiving data…') : p.percent.toFixed(1) + '%'}${paused ? t(" · Paused") : ''}`;
    if (zip.entriesTotal) $('totalProgressText').textContent += ` · ${t('Processed {v0} / {v1} · Saved {v2} · Skipped {v3}', {v0: zip.entriesProcessed || 0, v1: zip.entriesTotal, v2: zip.entriesDone || 0, v3: zip.entriesFailed || 0})}`;
    $('zipFailurePanel').hidden = !zip.failures?.length;
    $('zipFailureSummary').textContent = t('Skipped {v0} failed files', {v0: zip.failures?.length || 0});
    $('zipFailures').replaceChildren(...(zip.failures || []).map(failure => el('li', `${failure.name} · ${I.message(failure.error)}${failure.sources?.length ? ' · ' + [...new Set(failure.sources.map(source => [source.moduleName, source.pageTitle].filter(Boolean).join(' / ')))].join('; ') : ''}`)));
  }
  $('pauseAll').disabled = !courseJobs.some(j => ['queued', 'in_progress'].includes(j.state));
  $('resumeAll').disabled = !courseJobs.some(j => j.state === 'paused');
  $('stopAll').disabled = !courseJobs.some(j => ['queued', 'in_progress', 'paused'].includes(j.state));
}
async function controlDownloads(action, job) {
  const request = ++controlRequest;
  setStatus(t('Sending download control…'));
  try {
    if (!job || job.engine === 'directory') directoryDownloads.control(action, job?.jobId);
    if (!job || job.engine === 'zip') zipDownloads.control(action, job?.jobId);
    if (!job || !['directory', 'zip'].includes(job.engine)) {
      const response = await chrome.runtime.sendMessage({ type: 'CONTROL_DOWNLOADS', courseKey, action, jobId: job?.jobId });
      if (!response.ok) throw new Error(response.error);
      jobs = response.jobs;
      if (response.controlErrors?.length) throw new Error(response.controlErrors.map(item => `${item.name || ''}: ${I.message(item.error)}`).join('; '));
    }
    if (request === controlRequest) setStatus(job && allJobs().find(item => item.jobId === job.jobId)?.state === 'complete'
      ? t('This file has already completed.') : t((job
      ? { pause: 'This file is paused. Other tasks are unaffected.', resume: 'This file has resumed.', stop: 'This file is stopped. Other tasks are unaffected.' }
      : { pause: 'Pause applied to unfinished tasks.', resume: 'Resume applied to paused tasks.', stop: 'Stopped unfinished tasks. Saved files are kept.' })[action]));
    renderRows();
  } catch (error) { if (request === controlRequest) setStatus(t("Download action failed: {v0}", {v0: I.message(error.message)}), true); renderRows(); }
}
function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
function bytes(size) { if (size == null) return t("Unknown"); if (size < 1024) return `${size} B`; const n = Math.floor(Math.log(size) / Math.log(1024)); return `${(size / 1024 ** n).toFixed(n > 1 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][Math.min(n,4)]}`; }
function setStatus(text, error = false) { $('status').textContent = I.message(text); $('status').classList.toggle('error', error); }
function updateFolderHint() {
  const parts = ['Canvas', t("Course")];
  if ($('groupByModule').checked) parts.push('Module');
  if ($('groupByPage').checked) parts.push(t("Source page"));
  $('folderHint').textContent = [...parts, t("Format"), t("Filename")].join(' / ');
  $('sharedFileMode').disabled = !$('groupByModule').checked && !$('groupByPage').checked;
}
function updateDestination() {
  const zipped = $('downloadMode').value === 'zip';
  $('chooseDirectory').textContent = directory ? t('Change local folder… ↗') : t('Choose local folder… ↗');
  $('defaultDirectory').hidden = !directory;
  if (directory) {
    $('destinationName').textContent = t("Selected folder: {v0}", {v0: directory.name});
    $('destinationMode').textContent = t("Local folder");
    $('destinationHelp').textContent = zipped ? t("The ZIP will be written here, with the folder structure shown below inside it.") : t("Files will be written here using the folder structure below.");
  } else {
    $('destinationName').textContent = zipped ? t("Choose a location when saving ZIP") : t("Chrome default download folder");
    $('destinationMode').textContent = zipped ? t("Choose when saving") : t("Default folder");
    $('destinationHelp').textContent = zipped ? t("When the ZIP is ready, a save dialog will open with one download record. You can also choose a local folder now.") : t("To save elsewhere, choose a local folder before downloading.");
  }
}
function filtered(external = false) {
  const q = $('search').value.trim().toLowerCase();
  return (result?.files || []).filter(f => (f.canvas === false) === external && (!format || f.category === format) && (!chapter || f.sources.some(s => s.moduleId === chapter)) && (!q || [f.name, ...f.sources.flatMap(s => [s.moduleName, s.pageTitle])].join(' ').toLowerCase().includes(q)));
}
function renderFilters() {
  $('formats').replaceChildren(); $('chapters').replaceChildren();
  function filterButton(parent, name, count, active, handler) {
    const b = el('button', null, active ? 'active' : ''); b.append(el('span', name), el('span', String(count), 'count')); b.onclick = handler; $(parent).append(b);
  }
  const attachments = result.files.filter(f => f.canvas !== false);
  filterButton('formats', t("All formats"), attachments.length, !format, () => { format = ''; render(); });
  const counts = new Map(); for (const f of attachments) counts.set(f.category, (counts.get(f.category) || 0) + 1);
  for (const [name,count] of counts) filterButton('formats', I.message(name), count, format === name, () => { format = name; render(); });
  filterButton('chapters', t("All modules"), result.modules.length, !chapter, () => { chapter = ''; render(); });
  for (const m of result.modules) filterButton('chapters', m.name, m.files, chapter === m.id, () => { chapter = m.id; render(); });
}
function updateSelection() {
  const visible = filtered().filter(f => f.downloadable);
  const count = visible.filter(f => selected.has(f.key)).length;
  $('selectVisible').checked = visible.length > 0 && count === visible.length;
  $('selectVisible').indeterminate = count > 0 && count < visible.length;
  $('selectVisible').disabled = !visible.length || busy;
  const external = filtered(true).filter(f => f.downloadable), externalCount = external.filter(f => selectedExternal.has(f.key)).length;
  $('selectExternalVisible').checked = external.length > 0 && externalCount === external.length;
  $('selectExternalVisible').indeterminate = externalCount > 0 && externalCount < external.length;
  $('selectExternalVisible').disabled = !external.length || busy;
  $('externalSelectionCount').textContent = t("External selected: {v0}", {v0: selectedExternal.size});
  const total = selected.size + selectedExternal.size;
  $('selectedTotal').textContent = String(total);
  $('selectionSummary').textContent = total ? t("{v0} selected", {v0: total}) : t("Nothing selected");
  $('selectionCount').textContent = t("Attachments: {v0} · External: {v1}", {v0: selected.size, v1: selectedExternal.size});
  $('download').disabled = busy || !total || ($('downloadMode').value === 'zip' && zipJobs.some(j => ['queued', 'in_progress', 'paused'].includes(j.state)));
  $('download').textContent = `${$('downloadMode').value === 'zip' ? t("Download ZIP") : t("Download selected files")}${total ? ` (${total})` : ''}`;
}
function renderFileRows(visible, targetId, selection) {
  $(targetId).replaceChildren();
  for (const file of visible) {
    const tr = el('tr'); tr.dataset.key = file.key;
    const checkCell = el('td'), check = el('input'); check.type = 'checkbox'; check.checked = selection.has(file.key); check.disabled = !file.downloadable || busy; check.setAttribute('aria-label', t("Select {v0}", {v0: file.name}));
    check.onchange = () => { check.checked ? selection.add(file.key) : selection.delete(file.key); updateSelection(); }; checkCell.append(check);
    const name = el('td'), title = el('div', null, 'file-title');
    const mark = el('span', (file.extension || file.category || 'FILE').toUpperCase().slice(0, 4), 'file-format-mark'); mark.dataset.format = file.category;
    title.append(mark, el('div', file.name, 'file-name')); name.append(title);
    const sourceLinks = new Map(file.sources.map(s => [s.pageUrl, s.pageTitle]));
    let moreSources = null, sourceIndex = 0;
    for (const [url,sourceTitle] of sourceLinks) {
      const a = el('a', sourceTitle || t("Open source"), 'file-source'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      if (sourceIndex++ === 0) name.append(a);
      else {
        if (!moreSources) { moreSources = el('details', null, 'file-origins'); moreSources.append(el('summary', t("{v0} more sources", {v0: sourceLinks.size - 1}))); name.append(moreSources); }
        moreSources.append(a);
      }
    }
    if (file.note) name.append(el('span', I.message(file.note), 'file-source note'));
    const type = el('td'); type.append(el('span', file.extension ? file.extension.toUpperCase() : I.message(file.category), 'chip'));
    const chapters = el('td', null, 'chapters-cell'); for (const title of new Set(file.sources.map(s => s.moduleName))) chapters.append(el('span', title));
    const fileJobs = allJobs().filter(j => j.fileKey === file.key && j.courseKey === courseKey), job = fileJobs.at(-1);
    const batchJobs = job ? fileJobs.filter(j => j.batchId === job.batchId) : [];
    const labels = { queued: t("Queued"), in_progress: t("Downloading"), paused: t("Paused"), cancelled: t("Stopped"), complete: t("Completed"), interrupted: t("Download failed") };
    const state = el('td', null, 'download-state ' + (job?.state || ''));
    state.append(el('div', job ? batchJobs.length > 1 ? t("{v0} copies in this batch · {v1} completed", {v0: batchJobs.length, v1: batchJobs.filter(j => j.state === 'complete').length}) : labels[job.state] || job.state : file.downloadable ? (file.access === 'unknown' ? t("Try downloading") : t("Ready")) : t("Locked by Canvas"), 'state-label'));
    if (job?.controlError) state.append(el('div', I.message(job.controlError), 'note control-error'));
    for (const target of batchJobs) {
      const progress = C.progressSummary([target]), progressWrap = el('div', null, 'job-progress'), bar = el('progress');
      bar.max = 100; bar.value = progress.percent; bar.setAttribute('aria-label', t("Download progress for {v0}", {v0: file.name}));
      if (progress.total == null && target.state === 'in_progress') bar.removeAttribute('value');
      progressWrap.append(bar, el('small', `${bytes(progress.received)}${progress.total != null ? ` / ${bytes(progress.total)} · ${progress.percent.toFixed(1)}%` : t(" · Size unknown")}`));
      state.append(progressWrap);
      if (['queued', 'in_progress', 'paused'].includes(target.state)) {
        const controls = el('div', null, 'job-controls');
        const action = target.state === 'paused' ? 'resume' : 'pause';
        const pause = el('button', action === 'resume' ? t("Resume") : t("Pause")), stop = el('button', t("Stop"));
        pause.title = t(action === 'resume' ? 'Resume this file' : 'Pause this file'); stop.title = t('Stop this file');
        pause.onclick = () => controlDownloads(action, target); stop.onclick = () => controlDownloads('stop', target);
        controls.append(pause, stop); state.append(controls);
      }
      const detail = el('details', null, 'saved-location');
      detail.append(el('summary', batchJobs.length > 1 ? `${target.moduleName || target.pageTitle || t("Source")} · ${labels[target.state] || target.state}` : t("Show save location")));
      detail.append(el('div', t("Planned: {v0}", {v0: target.filename})));
      if (target.actualFilename) detail.append(el('div', t("Actual: {v0}", {v0: target.actualFilename})));
      else detail.append(el('div', target.state === 'queued' ? t("Actual location: waiting to download") : t("Actual location: not yet returned by Chrome")));
      if (target.pathWarning && target.state === 'complete') {
        detail.open = true; detail.append(el('div', I.message(target.pathWarning), 'note')); state.classList.add('interrupted');
      }
      if (target.error) detail.append(el('div', I.message(target.error), 'note'));
      if (target.state === 'complete' && target.downloadId != null) {
        const show = el('button', t("Show in folder"));
        show.onclick = async () => {
          try {
            const response = await chrome.runtime.sendMessage({ type: 'SHOW_DOWNLOAD', jobId: target.jobId });
            if (!response.ok) throw new Error(response.error);
          } catch (error) { setStatus(t("Cannot open download location: {v0}", {v0: I.message(error.message)}), true); }
        };
        detail.append(show);
      }
      state.append(detail);
    }
    if (job?.error) state.title = job.error;
    tr.append(checkCell, name, type, chapters, el('td', bytes(file.size)), state); $(targetId).append(tr);
  }
}
function renderRows() {
  if (holdingRowControl) { deferredRows = true; return; }
  const visible = filtered(), attachments = (result?.files || []).filter(f => f.canvas !== false);
  $('empty').hidden = visible.length > 0; $('fileTable').hidden = !visible.length;
  $('emptyTitle').textContent = attachments.length ? t("No matching attachments") : t("No course attachments yet");
  $('emptyDescription').textContent = attachments.length ? t("Try another keyword or reset the filters.") : t("Scan all Modules using the button above. External file links appear separately below.");
  renderFileRows(visible, 'files', selected);
  const external = filtered(true), allExternal = (result?.files || []).filter(f => f.canvas === false);
  $('directPanel').hidden = !allExternal.length;
  $('directCount').textContent = t("Showing {v0} / {v1} · Unselected by default", {v0: external.length, v1: allExternal.length});
  $('directEmpty').hidden = external.length > 0; $('directTable').hidden = !external.length;
  renderFileRows(external, 'directFiles', selectedExternal);
  $('visibleCount').textContent = t("Showing {v0} / {v1} course attachments", {v0: visible.length, v1: attachments.length});
  updateSelection();
  renderProgress();
  window.requestAnimationFrame?.(fitDownloadPanel);
}
function renderReports() {
  $('coverage').replaceChildren();
  for (const m of result.modules) {
    const moduleFiles = result.files.filter(f => f.sources.some(s => s.moduleId === m.id));
    const directCount = moduleFiles.filter(f => f.canvas === false).length;
    const row = el('div', null, 'coverage-row'); row.append(el('span', m.name), el('span', t("{v0} items · {v1} attachments{v2}{v3}", {v0: m.items, v1: moduleFiles.length - directCount, v2: directCount ? t(" · {v0} direct links", {v0: directCount}) : '', v3: m.errors ? t(" · {v0} issues", {v0: m.errors}) : ''}))); $('coverage').append(row);
  }
  $('coverageCount').textContent = t("{v0} Modules · {v1} items · {v2} page reads{v3}", {v0: result.modules.length, v1: result.stats.items, v2: result.stats.pages, v3: result.scanVersion >= 2 ? t(" · {v0} inline images excluded · {v1} duplicate references merged", {v0: result.stats.ignoredImages, v1: result.stats.mergedReferences}) : t(" · Older results: scan again to apply current filters")});
  $('warningPanel').hidden = !result.warnings.length; $('warningCount').textContent = String(result.warnings.length); $('warnings').replaceChildren();
  for (const w of result.warnings) $('warnings').append(el('li', `${w.moduleName} / ${w.title}：${I.message(w.message)}`));
  $('externalPanel').hidden = !result.externalLinks.length; $('externalCount').textContent = String(result.externalLinks.length); $('external').replaceChildren();
  for (const item of result.externalLinks) { const li = el('li'), a = el('a', item.title); a.href = item.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a, el('span', ` — ${[...new Set(item.sources.map(s => s.moduleName))].join('、')}`)); $('external').append(li); }
}
function render() {
  if (!result) return;
  $('courseName').textContent = result.courseName;
  $('courseInfo').textContent = t("{v0} · Last scanned {v1}", {v0: result.origin, v1: new Date(result.scannedAt).toLocaleString(I.language)});
  const attachments = result.files.filter(f => f.canvas !== false);
  $('moduleCount').textContent = result.modules.length; $('fileCount').textContent = attachments.length;
  $('formatCount').textContent = new Set(attachments.map(f => f.category)).size;
  $('sizeCount').textContent = bytes(attachments.reduce((n, f) => n + (f.size || 0), 0));
  $('scanBadge').textContent = result.complete ? t("Scan complete") : t("Scan has incomplete items"); $('scanBadge').className = `badge ${result.complete ? 'success' : 'warning'}`;
  renderFilters(); renderRows(); renderReports();
}
$('search').oninput = renderRows;
$('clearFilters').onclick = () => { chapter = ''; format = ''; $('search').value = ''; render(); };
$('clearSelection').onclick = () => { selected.clear(); selectedExternal.clear(); renderRows(); };
async function saveDownloadOptions() {
  updateFolderHint();
  try { await chrome.storage.local.set({ groupByModule: $('groupByModule').checked, groupByPage: $('groupByPage').checked, sharedFileMode: $('sharedFileMode').value }); }
  catch (error) { setStatus(t("Options changed, but preferences could not be saved: {v0}", {v0: I.message(error.message)}), true); }
}
$('groupByModule').onchange = saveDownloadOptions;
$('groupByPage').onchange = saveDownloadOptions;
$('sharedFileMode').onchange = saveDownloadOptions;
$('selectVisible').onchange = () => { for (const f of filtered().filter(f => f.downloadable)) $('selectVisible').checked ? selected.add(f.key) : selected.delete(f.key); renderRows(); };
$('selectExternalVisible').onchange = () => { for (const f of filtered(true).filter(f => f.downloadable)) $('selectExternalVisible').checked ? selectedExternal.add(f.key) : selectedExternal.delete(f.key); renderRows(); };
$('pauseAll').onclick = () => controlDownloads('pause');
$('resumeAll').onclick = () => controlDownloads('resume');
$('stopAll').onclick = () => controlDownloads('stop');
$('languageSelect').onchange = async () => {
  const picker = $('languageSelect'); picker.disabled = true;
  try {
    await I.init(picker.value); await chrome.storage.local.set({ uiLanguage: I.language });
    I.apply(document); updateDestination(); updateFolderHint();
    if (result) render(); else renderRows();
    await updateStorageInfo(); setStatus(t('Language changed.'));
  } catch (error) { setStatus(I.message(error.message), true); }
  finally { picker.value = I.language; picker.disabled = false; }
};
$('downloadMode').onchange = async () => {
  $('zipHint').hidden = $('downloadMode').value !== 'zip';
  updateDestination(); updateSelection(); await chrome.storage.local.set({ downloadMode: $('downloadMode').value });
};
$('clearData').onclick = async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_DATA' });
    if (!response.ok) throw new Error(response.error);
    jobs = response.jobs; directoryJobs = C.trimJobs(directoryJobs).filter(j => ['queued', 'in_progress', 'paused'].includes(j.state));
    zipJobs = zipJobs.filter(j => ['queued', 'in_progress', 'paused'].includes(j.state));
    result = null; selected.clear(); selectedExternal.clear();
    $('courseName').textContent = t("Local lists cleared"); $('courseInfo').textContent = t("Scan again to get course files. Your download options have been kept.");
    for (const id of ['moduleCount', 'fileCount', 'formatCount', 'sizeCount']) $(id).textContent = '—';
    for (const id of ['formats', 'chapters', 'coverage', 'warnings', 'external']) $(id).replaceChildren();
    for (const id of ['warningPanel', 'externalPanel']) $(id).hidden = true;
    $('scanBadge').textContent = t("Waiting to scan"); $('scanBadge').className = 'badge';
    renderRows(); await temporaryDirectory(); await updateStorageInfo();
    setStatus(t("Cleared scan lists and finished task records. Settings, active tasks and downloaded files have been kept."));
  } catch (error) { setStatus(t("Cleanup failed: {v0}", {v0: I.message(error.message)}), true); }
};
async function updateStorageInfo() {
  const size = await chrome.storage.local.getBytesInUse?.(null);
  $('storageInfo').textContent = t("Local lists and records{v0} · No attachment content cache", {v0: size != null ? ` ${bytes(size)}` : ''});
}
$('chooseDirectory').onclick = async () => {
  try {
    if (typeof window.showDirectoryPicker !== 'function') throw new Error(t("This browser cannot choose a local folder. Use the Chrome default download folder."));
    directory = await window.showDirectoryPicker({ mode: 'readwrite', id: 'canvas-files-output' });
    directoryRootId = crypto.randomUUID();
    $('destinationName').textContent = t("Selected folder: {v0}", {v0: directory.name}); $('defaultDirectory').hidden = false;
    $('destinationMode').textContent = t("Local folder");
    $('destinationHelp').textContent = t("Files will be written here using the folder structure below.");
    $('chooseDirectory').textContent = t("Change local folder… ↗");
    updateDestination();
  } catch (error) { if (error.name !== 'AbortError') setStatus(t("No save location selected: {v0}", {v0: I.message(error.message)}), true); }
};
$('defaultDirectory').onclick = () => {
  directory = null; directoryRootId = ''; $('destinationName').textContent = t("Chrome default download folder"); $('defaultDirectory').hidden = true;
  $('destinationMode').textContent = t("Default folder"); $('destinationHelp').textContent = t("To save elsewhere, choose a local folder before downloading."); $('chooseDirectory').textContent = t("Choose local folder… ↗");
  updateDestination();
};
$('source').onclick = async () => { if (config.tabId) { try { await chrome.tabs.update(config.tabId, { active: true }); return; } catch {} } if (config.origin && config.courseId) await chrome.tabs.create({ url: `${config.origin}/courses/${config.courseId}/modules` }); };
$('scan').onclick = async () => {
  if (!config.tabId || !config.origin || !config.courseId) { setStatus(t("Open a signed-in Canvas course and click the Canvas File Assistant extension icon."), true); return; }
  busy = true; let failed = false; $('scan').disabled = true; runId = crypto.randomUUID(); updateSelection();
  $('scan').textContent = t("Scanning…");
  $('scanBadge').textContent = t("Scan in progress…"); $('scanBadge').className = 'badge';
  setStatus(t("Connecting to the course…"));
  try {
    const tab = await chrome.tabs.get(config.tabId);
    if (!tab.url?.startsWith(`${config.origin}/courses/${config.courseId}`)) throw new Error(t("The course tab has changed. Click the extension icon again in the intended course."));
    await chrome.scripting.executeScript({ target: { tabId: config.tabId }, files: ['core.js', 'scanner.js'] });
    const [{ result: scanned }] = await chrome.scripting.executeScript({ target: { tabId: config.tabId }, func: opts => globalThis.CanvasFilesScanner.scan(opts), args: [{ origin: config.origin, courseId: config.courseId, runId }] });
    if (!scanned) throw new Error(t("No scan results received. Keep the course tab open."));
    result = scanned; selected.clear(); selectedExternal.clear();
    const saved = await chrome.runtime.sendMessage({ type: 'SAVE_SCAN', courseKey, result });
    if (!saved.ok) throw new Error(saved.error);
    await updateStorageInfo();
    const directCount = result.files.filter(f => f.canvas === false).length;
    setStatus(t("{v0}: {v1} Modules, {v2} items, {v3} course attachments, {v4} external direct links (select separately).", {v0: result.complete ? t("Scan complete") : t("Scan finished with issues to review"), v1: result.modules.length, v2: result.stats.items, v3: result.files.length - directCount, v4: directCount}), !result.complete);
  } catch (error) { failed = true; setStatus(t("Scan incomplete: {v0}{v1}", {v0: I.message(error.message), v1: result ? t(". The list still shows the previous scan.") : ''}), true); }
  finally { busy = false; $('scan').disabled = false; $('scan').textContent = t("↻ Scan all Modules"); render(); updateSelection(); if (failed) { $('scanBadge').textContent = t("This scan failed"); $('scanBadge').className = 'badge warning'; } }
};
$('download').onclick = async () => {
  $('download').disabled = true;
  try {
    const selectionCount = selected.size + selectedExternal.size;
    const downloadOptions = { groupByModule: $('groupByModule').checked, groupByPage: $('groupByPage').checked, sharedFileMode: $('sharedFileMode').value };
    if ($('downloadMode').value === 'zip') {
      const keys = new Set([...selected, ...selectedExternal]);
      const files = result.files.filter(f => keys.has(f.key) && f.downloadable);
      const origins = [...new Set(files.map(f => new URL(f.downloadUrl).origin + '/*'))];
      const outputDirectory = directory;
      if (origins.length && !await chrome.permissions.request({ origins })) throw new Error(t("Permission to read file sources was not granted. ZIP packing did not start; try individual downloads."));
      const targets = files.flatMap(file => C.downloadTargets(result.courseName, file, downloadOptions).map(target => ({ ...target, file })));
      const job = { jobId: crypto.randomUUID(), batchId: crypto.randomUUID(), courseKey, engine: 'zip', name: `${C.safeSegment(result.courseName)}_${new Date().toISOString().slice(0,10)}.zip`, bytesReceived: 0, totalBytes: targets.every(t => t.file.size > 0) ? targets.reduce((n,t) => n + t.file.size, 0) : null, entriesDone: 0, state: 'queued', createdAt: new Date().toISOString() };
      zipDownloads.start(outputDirectory, targets, job); zipJobs = C.trimJobs([...zipJobs, job]); latestBatchId = job.batchId;
      selected.clear(); selectedExternal.clear(); renderRows();
      setStatus(outputDirectory ? t("Packing {v0} files into a ZIP in “{v1}”. Keep this assistant tab open.", {v0: targets.length, v1: outputDirectory.name}) : t("Packing {v0} files into one ZIP. A save dialog will open when ready. Keep this assistant tab open.", {v0: targets.length}));
      return;
    }
    if (directory) {
      const selectedKeys = new Set([...selected, ...selectedExternal]);
      const files = result.files.filter(f => selectedKeys.has(f.key) && f.downloadable);
      const origins = [...new Set(files.map(f => new URL(f.downloadUrl).origin + '/*'))];
      const outputDirectory = directory, rootId = directoryRootId;
      if (origins.length && !await chrome.permissions.request({ origins })) throw new Error(t("Permission to read file sources was not granted. Downloading did not start; use the default download folder."));
      const batchId = crypto.randomUUID(), newJobs = [];
      for (const file of files) for (const target of C.downloadTargets(result.courseName, file, downloadOptions)) {
        if (directoryJobs.some(j => j.rootId === rootId && j.fileKey === file.key && j.filename === target.filename && ['queued', 'in_progress', 'paused'].includes(j.state))) continue;
        newJobs.push({ ...target, jobId: crypto.randomUUID(), batchId, courseKey, rootId, engine: 'directory', fileKey: file.key, name: file.name, mime: file.mime || '', url: file.downloadUrl, expectedBytes: file.size || null, totalBytes: file.size || null, bytesReceived: 0, state: 'queued', createdAt: new Date().toISOString() });
      }
      directoryJobs = C.trimJobs([...directoryJobs, ...newJobs]); if (newJobs.length) latestBatchId = batchId;
      directoryDownloads.start(outputDirectory, newJobs);
      selected.clear(); selectedExternal.clear(); renderRows();
      setStatus(t("Started {v0} save tasks in “{v1}”. Keep this assistant tab open; pause, resume or stop at any time.", {v0: newJobs.length, v1: outputDirectory.name}));
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: 'START_DOWNLOADS', appVersion, courseKey, keys: [...selected, ...selectedExternal], explicitExternalKeys: [...selectedExternal], ...downloadOptions });
    if (!response.ok) throw new Error(response.error);
    jobs = response.jobs; if (response.batchId && response.addedCount > 0) latestBatchId = response.batchId; setStatus(t("Queued {v0} save tasks from {v1} selected files. Up to 3 run at once. See “Show save location” for actual paths. Existing active targets are not queued again.", {v0: response.addedCount, v1: selectionCount})); selected.clear(); selectedExternal.clear(); renderRows();
  } catch (error) { setStatus(t("Download failed: {v0}", {v0: I.message(error.message)}), true); }
  finally { updateSelection(); }
};
chrome.runtime.onMessage.addListener(message => { if (message.type === 'SCAN_PROGRESS' && message.runId === runId) setStatus(t("{v0} · {v1} files found", {v0: I.message(message.text), v1: message.files})); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.downloadJobs) { jobs = changes.downloadJobs.newValue || []; if (result) renderRows(); updateStorageInfo().catch(() => {}); } });
(async () => {
  await chrome.runtime.sendMessage({ type: 'MAINTAIN_DATA' });
  const stored = await chrome.storage.local.get(['scanResults', 'downloadJobs', 'groupByModule', 'groupByPage', 'sharedFileMode', 'downloadMode', 'uiLanguage']); result = stored.scanResults?.[courseKey] || null; jobs = stored.downloadJobs || [];
  await I.init(stored.uiLanguage || 'zh-CN');
  $('languageSelect').replaceChildren(...I.languages.map(language => { const option = el('option', language.label); option.value = language.code; return option; }));
  $('languageSelect').value = I.language; I.apply(document);
  $('downloadMode').value = stored.downloadMode === 'files' ? 'files' : 'zip'; $('zipHint').hidden = $('downloadMode').value !== 'zip';
  updateDestination();
  $('groupByModule').checked = stored.groupByModule !== false;
  $('groupByPage').checked = stored.groupByPage !== false;
  $('sharedFileMode').value = stored.sharedFileMode === 'each-source' ? 'each-source' : 'once';
  updateFolderHint();
  if (result) { render(); setStatus(result.scanVersion >= 2 ? t("Loaded the last scan. Click “Scan all Modules” to refresh the file list.") : t("These are older scan results. Scan all Modules again to exclude inline images and merge duplicate references.")); }
  await chrome.runtime.sendMessage({ type: 'REFRESH_DOWNLOADS' });
  await updateStorageInfo();
  temporaryDirectory().catch(() => {});
})();
setInterval(async () => {
  if (refreshPending || !jobs.some(j => j.courseKey === courseKey && ['queued', 'in_progress', 'paused'].includes(j.state))) return;
  refreshPending = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'REFRESH_DOWNLOADS' });
    if (response?.ok) { jobs = response.jobs; renderRows(); }
  } catch (error) { setStatus(t("Progress refresh failed: {v0}", {v0: I.message(error.message)}), true); }
  finally { refreshPending = false; }
}, 1000);
