// Isolated worker-restart/storage simulation. Never connects to a real browser.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../canvas-module-files'), C = require(root + '/core.js');
const source = fs.readFileSync(root + '/background.js', 'utf8');
const version = JSON.parse(fs.readFileSync(root + '/manifest.json', 'utf8')).version;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(test) { for (let i = 0; i < 100; i++) { if (test()) return; await tick(); } throw new Error('condition not reached'); }
function scan(count = 5) {
  return { courseName: 'Same course name', scannedAt: new Date().toISOString(), files: Array.from({ length: count }, (_, i) => ({ key: 'f' + i, name: 'file' + i + '.pdf', canvas: true, downloadable: true, category: 'PDF', downloadUrl: 'https://canvas.invalid/files/' + i, sources: [{ moduleName: 'Week 1', pageTitle: 'Lectorial' }] })) };
}
function fixture({ blockAt = 0, early = true, createRecord = true } = {}) {
  const store = { downloadJobs: [], scanResults: { course: scan() } }, native = new Map(), actions = [];
  let next = 0, blocked = false, events, context;
  function load() {
    events = {};
    const own = events;
    const chrome = {
      action: { onClicked: { addListener() {} } },
      runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p, getManifest: () => ({ version }), onMessage: { addListener: f => own.message = f }, onStartup: { addListener: f => own.startup = f } },
      storage: { local: { get: async () => structuredClone(store), set: async value => Object.assign(store, structuredClone(value)) } },
      downloads: {
        download: async opts => {
          const id = ++next, item = { id, byExtensionId: 'test', url: opts.url, filename: opts.filename, state: 'in_progress', paused: false, startTime: new Date().toISOString() };
          if (createRecord) native.set(id, item);
          if (early && createRecord) own.created(item);
          if (next === blockAt) { blocked = true; await new Promise(() => {}); }
          return id;
        },
        search: async query => [...native.values()].filter(item => query.id != null ? item.id === query.id : Date.parse(item.startTime) >= Date.parse(query.startedAfter)).map(item => structuredClone(item)),
        pause: async id => { actions.push(['pause', id]); native.get(id).paused = true; },
        resume: async id => { actions.push(['resume', id]); native.get(id).paused = false; },
        cancel: async id => { actions.push(['stop', id]); Object.assign(native.get(id), { state: 'interrupted', error: 'USER_CANCELED' }); },
        onCreated: { addListener: f => own.created = f }, onChanged: { addListener: f => own.changed = f }, onDeterminingFilename: { addListener: f => own.determine = f }
      }
    };
    context = vm.createContext({ chrome, CanvasFilesCore: C, crypto: require('node:crypto').webcrypto, URL, URLSearchParams, console, importScripts() {} });
    vm.runInContext(source, context);
  }
  load();
  return {
    store, native, actions, load, count: () => next, blocked: () => blocked,
    events: () => events,
    flush: async () => { await vm.runInContext('jobWrites', context); await vm.runInContext('chain', context); },
    send: message => new Promise(resolve => events.message({ appVersion: version, ...message }, { id: 'test', url: 'chrome-extension://test/app.html' }, resolve))
  };
}
const start = (f, extra = {}) => f.send({ type: 'START_DOWNLOADS', courseKey: 'course', keys: ['f0', 'f1', 'f2', 'f3', 'f4'], ...extra });

(async () => {
  const large = fixture(), result = scan(1); result.notes = 'x'.repeat(2 * 1024 * 1024);
  assert.equal((await large.send({ type: 'SAVE_SCAN', courseKey: 'course', result })).ok, true);
  assert.equal(large.store.scanResults.course, undefined, 'oversized scan should not consume persistent cache');
  const downloaded = await start(large, { keys: ['f0'], selection: { courseName: result.courseName, files: result.files } });
  assert.equal(downloaded.ok, true); assert.equal(downloaded.addedCount, 1); assert.equal(large.count(), 1);
  assert.equal(large.store.scanResults.course, undefined);
  const external = { ...result.files[0], key: 'external', canvas: false };
  assert.equal((await start(large, { keys: ['external'], selection: { courseName: result.courseName, files: [external] } })).ok, false);
  assert.equal((await start(large, { keys: ['external'], explicitExternalKeys: ['external'], selection: { courseName: result.courseName, files: [external] } })).addedCount, 1);
  console.log('PASS oversized scan remains uncached while current selection downloads; external opt-in remains enforced');

  const concurrent = fixture();
  const responses = await Promise.all([start(concurrent), start(concurrent)]);
  assert.equal(responses.reduce((sum, r) => sum + r.addedCount, 0), 5);
  assert.equal(concurrent.store.downloadJobs.length, 5); assert.equal(concurrent.count(), 3);
  const secondCourse = await start(concurrent, { courseKey: 'other-course', keys: ['f0'], selection: scan(1) });
  assert.equal(secondCourse.addedCount, 1, 'same file/path in another course must remain independent');
  assert.equal(concurrent.count(), 3, 'concurrent helper tabs share the global concurrency limit');
  console.log('PASS concurrent helper requests deduplicate within a course and preserve course ownership/global concurrency');

  const retry = fixture(), shared = scan(1);
  shared.files[0].sources.push({ moduleName: 'Week 2', pageTitle: 'Tutorial' });
  const copies = await start(retry, { keys: ['f0'], selection: shared, sharedFileMode: 'each-source', groupByPage: true });
  assert.equal(copies.addedCount, 2);
  const [good, bad] = copies.jobs;
  retry.native.get(good.downloadId).state = 'complete';
  Object.assign(retry.native.get(bad.downloadId), { state: 'interrupted', error: 'NETWORK_FAILED' });
  await retry.send({ type: 'REFRESH_DOWNLOADS' });
  await retry.send({ type: 'MAINTAIN_DATA' });
  assert.equal(retry.store.downloadJobs.find(j => j.jobId === bad.jobId).url, undefined, 'terminal URLs remain pruned');
  shared.files[0].downloadUrl += '?fresh=1';
  const retried = await retry.send({ type: 'RETRY_DOWNLOADS', courseKey: 'course', jobIds: [good.jobId, bad.jobId], selection: shared });
  assert.equal(retried.addedCount, 1);
  const attempt = retried.jobs.find(j => j.retryOf === bad.jobId);
  assert.equal(attempt.filename, bad.filename); assert(attempt.url.endsWith('?fresh=1')); assert.equal(retry.count(), 3);
  assert.equal((await retry.send({ type: 'RETRY_DOWNLOADS', courseKey: 'other-course', jobIds: [bad.jobId], selection: shared })).addedCount, 0);
  assert.equal((await retry.send({ type: 'RETRY_DOWNLOADS', courseKey: 'course', jobIds: [bad.jobId], selection: shared })).addedCount, 0);
  retry.native.get(attempt.downloadId).state = 'complete'; await retry.send({ type: 'REFRESH_DOWNLOADS' });
  assert.equal((await retry.send({ type: 'RETRY_DOWNLOADS', courseKey: 'course', jobIds: [bad.jobId], selection: shared })).addedCount, 0);
  console.log('PASS retry uses refreshed selection URLs and exact failed source paths, excluding completed copies, active retries and other courses');

  const paused = fixture({ blockAt: 2 }); start(paused);
  await until(paused.blocked);
  paused.send({ type: 'CONTROL_DOWNLOADS', courseKey: 'course', action: 'pause' });
  await until(() => paused.store.downloadJobs.filter(j => j.downloadId != null).length === 2 && paused.store.pausedDownloadCourses?.course && [...paused.native.values()].every(j => j.paused));
  paused.load(); const restored = await paused.send({ type: 'REFRESH_DOWNLOADS' });
  assert.equal(restored.ok, true); assert.equal(paused.count(), 2);
  assert(restored.jobs.every(j => j.state === 'paused'), 'paused queue survives worker loss during pending start');
  const resumed = await paused.send({ type: 'CONTROL_DOWNLOADS', courseKey: 'course', action: 'resume' });
  assert.equal(resumed.ok, true); assert.equal(paused.count(), 3); assert([...paused.native.values()].every(j => !j.paused));
  console.log('PASS early IDs and course pause persist during a blocked start; worker restart does not duplicate or unpause downloads');

  const gap = fixture({ blockAt: 1, early: false }); start(gap, { keys: ['f0'] }); await until(gap.blocked);
  assert(gap.store.downloadJobs[0].startRequestedAt); assert.equal(gap.store.downloadJobs[0].downloadId, undefined);
  gap.native.set(900, { ...gap.native.get(1), id: 900, byExtensionId: 'unrelated-extension' });
  gap.load(); const recovered = await gap.send({ type: 'REFRESH_DOWNLOADS' });
  assert.equal(recovered.jobs[0].downloadId, 1); assert.equal(recovered.jobs[0].state, 'in_progress'); assert.equal(gap.count(), 1);
  gap.native.get(1).state = 'complete'; gap.load(); gap.events().startup(); await gap.flush();
  assert.equal(gap.store.downloadJobs[0].state, 'complete'); assert.equal(gap.count(), 1);
  console.log('PASS restart in the browser-ID gap recovers the extension-owned record; startup reconciles offline completion');

  const wake = fixture({ blockAt: 1, early: false }); start(wake, { keys: ['f0', 'f1'] }); await until(wake.blocked);
  wake.native.get(1).state = 'complete'; wake.load();
  wake.events().changed({ id: 1, state: { current: 'complete' } }); await wake.flush();
  assert.equal(wake.store.downloadJobs.find(j => j.fileKey === 'f0').state, 'complete');
  assert.equal(wake.store.downloadJobs.find(j => j.fileKey === 'f1').state, 'in_progress'); assert.equal(wake.count(), 2);
  console.log('PASS a completion event wakes a fresh worker, recovers its uncommitted ID, and continues the queue without an open helper');

  const uncertain = fixture({ blockAt: 1, early: false, createRecord: false }); start(uncertain, { keys: ['f0'] }); await until(uncertain.blocked);
  uncertain.load(); const unresolved = await uncertain.send({ type: 'REFRESH_DOWNLOADS' });
  assert.equal(unresolved.jobs[0].state, 'interrupted'); assert.match(unresolved.jobs[0].error, /启动未确认/); assert.equal(uncertain.count(), 1);
  const late = { id: 7, byExtensionId: 'test', url: scan(1).files[0].downloadUrl, filename: unresolved.jobs[0].filename, state: 'in_progress', startTime: new Date().toISOString() };
  uncertain.native.set(7, late); uncertain.events().created(late); await uncertain.flush();
  assert.equal(uncertain.store.downloadJobs[0].downloadId, 7); assert.equal(uncertain.store.downloadJobs[0].state, 'in_progress'); assert.equal(uncertain.count(), 1);
  console.log('PASS an uncertain start is not automatically issued twice; a late browser creation event reattaches it');

  const stopped = fixture({ blockAt: 1 }); start(stopped, { keys: ['f0', 'f1'] }); await until(stopped.blocked);
  stopped.send({ type: 'CONTROL_DOWNLOADS', courseKey: 'course', action: 'stop' });
  await until(() => stopped.store.downloadJobs.every(j => j.state === 'cancelled'));
  stopped.load(); const stopRestored = await stopped.send({ type: 'REFRESH_DOWNLOADS' });
  assert(stopRestored.jobs.every(j => j.state === 'cancelled')); assert.equal(stopped.count(), 1);
  stopped.native.clear(); stopped.load();
  assert((await stopped.send({ type: 'REFRESH_DOWNLOADS' })).jobs.every(j => j.state === 'cancelled'), 'deleted Chrome history must not convert intentional stops into retryable failures');
  console.log('PASS stop state survives worker loss during a blocked start and never restarts queued files');
})().catch(error => { console.error(error); process.exitCode = 1; });
