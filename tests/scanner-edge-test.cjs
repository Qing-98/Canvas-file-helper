// Isolated Canvas API fixtures. This test never opens a real course or downloads
// user files; it exercises the scanner with local in-memory responses only.
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
global.CanvasFilesCore = require('../canvas-module-files/core.js');
require('../canvas-module-files/scanner.js');
const origin = 'https://canvas.fixture.test';
const base = '/api/v1/courses/42';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const file = (id, title = `File ${id}`) => ({ id: id + 1000, type: 'File', content_id: id, title });
const page = (slug = 'main', id = 100) => ({ id, type: 'Page', page_url: slug, title: `Page ${slug}` });
async function run({ items = [page()], routes = {}, modules, timeout = 30 } = {}) {
  const calls = [], waits = [], reports = [], counts = new Map();
  const fetch = async (raw, options) => {
    const url = new URL(raw), path = url.pathname;
    const count = (counts.get(path) || 0) + 1; counts.set(path, count);
    calls.push({ url: raw, credentials: options.credentials });
    assert.equal(options.credentials, 'same-origin');
    assert.equal(url.origin, origin);
    if (routes[path]) return routes[path]({ url, count, signal: options.signal });
    if (path === base) return json({ id: 42, name: 'Scanner edge course' });
    if (path === base + '/modules') return json(modules || [{ id: 1, name: 'Week 1', position: 1 }, { id: 2, name: 'Week 2', position: 2 }]);
    if (path === base + '/modules/1/items') return json(items);
    if (path === base + '/modules/2/items') return json([file(90)]);
    if (path === base + '/pages/main') return json({ title: 'Main', body: '<a href="/courses/42/files/1">notes</a>' });
    const matched = path.match(/\/files\/(\d+)$/);
    if (matched) return json({ id: Number(matched[1]), filename: `file-${matched[1]}.pdf`, size: 32, locked_for_user: false });
    throw new Error('Unexpected fixture URL: ' + raw);
  };
  const result = await CanvasFilesScanner.scan({ origin, courseId: 42 }, {
    fetch, parse: html => parseHTML(`<html><body>${html}</body></html>`).document,
    delay: async ms => waits.push(ms), now: () => Date.UTC(2026, 9, 22, 0, 0, 0),
    requestTimeoutMs: timeout, progress: data => reports.push(data)
  });
  return { result, calls, waits, reports, counts };
}
const has = (result, id) => result.files.find(entry => entry.id === String(id));

(async () => {
  {
    const { result, calls } = await run({ items: [
      { id: 1, type: 'Discussion', content_id: 7, title: 'Week 1 discussion' },
      { id: 2, type: 'Quiz', content_id: 8, title: 'Practice quiz' },
      { id: 3, type: 'ExternalTool', external_url: origin + '/courses/42/files/15/download?verifier=lti', title: 'File tool' },
      { id: 4, type: 'ExternalTool', external_url: 'https://tool.fixture.test/launch', title: 'External classroom' },
      { id: 5, type: 'ExternalUrl', external_url: origin + '/courses/42/pages/nested/?module_item_id=5', title: 'Week 1 - Lectorial' },
      { id: 6, type: 'ExternalTool', external_url: 'javascript:alert(1)', title: 'Invalid link' }
    ], routes: {
      [base + '/discussion_topics/7']: () => json({
        message: '<a href="/courses/42/files/11">topic notes</a>', html_url: origin + '/courses/42/discussion_topics/7',
        attachments: [
          { url: '/courses/42/files/12/download?verifier=topic', filename: 'attachment.pdf' },
          { url: 'https://cdn.fixture.test/artifact?id=44', display_name: 'handout.pdf' },
          { url: 'javascript:alert(1)', filename: 'unsafe.pdf' }
        ], attachment: { id: 13, filename: 'legacy.pdf' }
      }),
      [base + '/quizzes/8']: () => json({ description: '<a href="/courses/42/files/14">Formula sheet</a>', html_url: origin + '/courses/42/quizzes/8' }),
      [base + '/pages/nested']: () => json({ body: '<a href="/courses/42/files/16">Lectorial</a>' })
    } });
    for (const id of [11, 12, 13, 14, 15, 16, 90]) assert(has(result, id), `Missing ${id}`);
    assert.equal(has(result, 12).downloadUrl, origin + '/courses/42/files/12/download?verifier=topic&download_frd=1');
    assert.equal(has(result, 12).sources[0].pageUrl, origin + '/courses/42/discussion_topics/7');
    assert.equal(has(result, 16).sources[0].pageTitle, 'Week 1 - Lectorial');
    assert.equal(result.files.find(entry => !entry.canvas).name, 'handout.pdf');
    assert.equal(result.externalLinks.length, 1);
    assert.equal(result.externalLinks[0].url, 'https://tool.fixture.test/launch');
    assert(!calls.some(call => call.url.includes('tool.fixture.test')));
    assert(result.complete);
    console.log('PASS Discussion URL-only/singular attachments, Quiz description, ExternalTool file/link and same-course page');
  }
  for (const [status, retryAfter, expected] of [
    [429, '2', 2000], [429, 'Thu, 22 Oct 2026 00:00:04 GMT', 4000],
    [503, 'invalid', 1000], [429, '3600', 30000], [503, '-2', 0]
  ]) {
    const { result, counts, waits, reports } = await run({ routes: {
      [base + '/pages/main']: ({ count }) => count === 1 ? json({}, status, { 'Retry-After': retryAfter }) : json({ body: '<a href="/courses/42/files/1">ok</a>' })
    } });
    assert(result.complete); assert.equal(counts.get(base + '/pages/main'), 2);
    assert.deepEqual(waits, [expected]); assert(reports.some(data => data.text.includes('重试')));
  }
  console.log('PASS bounded 429/5xx retries, Retry-After seconds/date and invalid/capped/negative values');
  {
    const { result, counts, waits } = await run({ routes: {
      [base + '/pages/main']: () => json({}, 503)
    } });
    assert.equal(counts.get(base + '/pages/main'), 3); assert.deepEqual(waits, [1000, 2000]);
    assert.equal(result.complete, false); assert(has(result, 90));
    assert(result.warnings.some(w => w.message.includes('HTTP 503')));
  }
  {
    const { result, counts, waits } = await run({ routes: {
      [base + '/pages/main']: () => { throw new TypeError('Network unavailable'); }
    } });
    assert.equal(counts.get(base + '/pages/main'), 3); assert.deepEqual(waits, [1000, 2000]);
    assert.equal(result.complete, false); assert(has(result, 90));
  }
  for (const stage of ['headers', 'body']) {
    let aborted = 0;
    const { result, counts } = await run({ timeout: 5, routes: {
      [base + '/pages/main']: ({ signal }) => {
        const blocked = () => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
        if (stage === 'headers') return blocked();
        return { ok: true, status: 200, headers: new Headers(), url: origin + base + '/pages/main', json: blocked };
      }
    } });
    assert.equal(aborted, 3); assert.equal(counts.get(base + '/pages/main'), 3);
    assert.equal(result.complete, false); assert(has(result, 90));
    assert(result.warnings.some(w => w.message.includes('请求超时')));
  }
  console.log('PASS exhausted server/network/header/body timeouts continue later modules with visible warnings');
  {
    const { result, counts } = await run({ items: [page(), { id: 8, type: 'Quiz', content_id: 8, title: 'Locked quiz' }, file(2)], routes: {
      [base + '/pages/main']: () => new Response('<html>Sign in</html>'),
      [base + '/quizzes/8']: () => json({ locked_for_user: true, lock_explanation: 'Not available yet' }),
      [base + '/files/2']: () => json({}, 403)
    } });
    assert.equal(counts.get(base + '/pages/main'), 1); assert.equal(counts.get(base + '/files/2'), 1);
    assert.equal(result.complete, false); assert(has(result, 90));
    assert.equal(has(result, 2).downloadable, true); assert.equal(has(result, 2).access, 'unknown');
    assert(result.warnings.some(w => w.message.includes('未收到 Canvas 数据')));
    assert(result.warnings.some(w => w.message === 'Not available yet'));
  }
  {
    const { result, counts } = await run({ routes: {
      [base + '/pages/main']: () => ({ ok: true, status: 200, url: 'https://sso.fixture.test/login', headers: new Headers() })
    } });
    assert.equal(counts.get(base + '/pages/main'), 1); assert.equal(result.complete, false);
    assert(result.warnings.some(w => w.message.includes('登录已失效')));
  }
  console.log('PASS malformed JSON, login redirect, locked Quiz and metadata 403 remain visible without false permission denial');
  {
    const { result, counts } = await run({ routes: {
      [base + '/modules']: ({ url }) => json([{ id: 1, name: 'Week 1', position: 1 }], 200, { Link: `<${origin}${base}/modules?per_page=100>; rel="next"` })
    } });
    assert.equal(counts.get(base + '/modules'), 1); assert.equal(result.modules.length, 1);
    assert(has(result, 1)); assert.equal(result.complete, false);
    assert(result.warnings.some(w => w.phase === '章节目录' && w.message.includes('重复分页')));
  }
  for (const failure of ['cycle', 'forbidden', 'malformed', 'foreign']) {
    const { result, counts, calls } = await run({ routes: {
      [base + '/modules/1/items']: ({ url }) => {
        if (!url.searchParams.has('page')) return json([file(2)], 200, { Link: `<${origin}${base}/modules/1/items?page=2&per_page=100>; rel="next"` });
        if (failure === 'forbidden') return json({}, 403);
        if (failure === 'malformed') return json({ errors: [] });
        const next = failure === 'foreign' ? 'https://foreign.fixture.test/items' : `${origin}${base}/modules/1/items?per_page=100&page=2#reordered`;
        return json([file(2), file(3)], 200, { Link: `<${next}>; rel="next"` });
      }
    } });
    assert.equal(counts.get(base + '/modules/1/items'), 2);
    assert.equal(result.complete, false); assert(has(result, 2)); assert(has(result, 90));
    assert.equal(result.files.filter(entry => entry.id === '2').length, 1);
    assert.equal(result.modules.find(mod => mod.id === '1').items, ['cycle', 'foreign'].includes(failure) ? 2 : 1);
    assert(!calls.some(call => call.url.includes('foreign.fixture.test')));
  }
  console.log('PASS partial modules/items survive pagination cycles, reordered queries, 403, malformed lists and offsite next links');
  {
    const { result, counts } = await run({ routes: {
      [base + '/modules/1/items']: ({ count }) => json([file(2)], 200, { Link: `<${origin}${base}/modules/1/items?page=${count + 1}&per_page=100>; rel="next"` })
    } });
    assert.equal(counts.get(base + '/modules/1/items'), 2);
    assert.equal(result.complete, false); assert(has(result, 2)); assert(has(result, 90));
    assert(result.warnings.some(w => w.message.includes('重复分页')));
  }
  console.log('PASS repeated page rows stop even when the server changes the next-page URL forever');
  {
    const { result, counts } = await run({ items: [page()], routes: {
      [base + '/modules/2/items']: () => json([page('main')]),
      [base + '/pages/main']: () => json({ body: '<a href="/courses/42/pages/child/?module_item_id=2#top">Child</a>' }),
      [base + '/pages/child']: () => json({ title: 'Child lecture', body: '<a href="/courses/42/pages/main/?module_item_id=1#top">Main</a><a href="/courses/42/files/3">notes</a>' })
    } });
    assert.equal(result.complete, true); assert.equal(counts.get(base + '/pages/main'), 1);
    assert.equal(counts.get(base + '/pages/child'), 1);
    assert.equal(has(result, 3).sources.length, 2);
    assert(has(result, 3).sources.every(source => source.pageTitle === 'Child lecture'));
  }
  console.log('PASS cyclic linked pages terminate and shared nested-page files retain every module source');
})().catch(error => { console.error(error); process.exitCode = 1; });
