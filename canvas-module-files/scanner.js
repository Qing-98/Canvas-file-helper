(function (root) {
  'use strict';
  const C = root.CanvasFilesCore;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function scan(options, deps = {}) {
    const origin = options.origin;
    const courseId = String(options.courseId);
    const base = `${origin}/api/v1/courses/${courseId}`;
    const fetcher = deps.fetch || fetch;
    const parse = deps.parse || (html => new DOMParser().parseFromString(html, 'text/html'));
    const progress = deps.progress || (data => chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', runId: options.runId, ...data }).catch(() => {}));
    const files = new Map(), cache = new Map(), warnings = [], external = new Map(), moduleResults = [];
    let requests = 0, pageCount = 0, itemCount = 0, ignoredImages = 0, mergedReferences = 0;
    function report(text) { progress({ text, modules: moduleResults.length, files: files.size, pages: pageCount, requests }); }
    async function request(path, kind = 'json') {
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new Error('拒绝向其他网站发送 Canvas 登录请求');
      for (let attempt = 0; ; attempt++) {
        requests++;
        const response = await fetcher(url.href, { credentials: 'same-origin', headers: { Accept: kind === 'json' ? 'application/json' : 'text/html' }, signal: AbortSignal.timeout(45000) });
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await delay(Math.min(10000, Number(response.headers.get('Retry-After') || 1) * 1000) * (attempt + 1));
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}：${url.pathname}`);
        if (new URL(response.url || url.href).origin !== origin) throw new Error('登录已失效，请回到课程页面重新登录');
        if (kind === 'text') return { data: await response.text(), next: null };
        let data;
        try { data = await response.json(); } catch { throw new Error('未收到 Canvas 数据，请确认课程仍处于登录状态'); }
        return { data, next: C.nextLink(response.headers.get('Link') || '') };
      }
    }
    async function list(path) {
      let next = new URL(path, origin); next.searchParams.set('per_page', '100'); next = next.href;
      const rows = [], visited = new Set();
      while (next) {
        if (visited.has(next)) throw new Error('Canvas 返回了重复分页，扫描未完成');
        visited.add(next);
        const result = await request(next);
        if (!Array.isArray(result.data)) throw new Error('Canvas 列表格式异常');
        rows.push(...result.data); next = result.next;
      }
      return rows;
    }
    function cached(path) {
      if (!cache.has(path)) cache.set(path, request(path).then(r => r.data));
      return cache.get(path);
    }
    function sourceFor(mod, item, pageUrl, pageTitle) {
      return { moduleId: String(mod.id), moduleName: mod.name, itemId: String(item.id), pageTitle: pageTitle || item.title, pageUrl: C.sourcePageUrl(pageUrl || item.html_url || `${origin}/courses/${courseId}/modules/items/${item.id}`) };
    }
    function addSource(record, source) {
      if (!record.sources.some(s => s.moduleId === source.moduleId && s.pageUrl === source.pageUrl)) record.sources.push(source);
    }
    function addCanvas(id, source, label = '', sourceUrl = '') {
      const key = `canvas:${origin}:${id}`;
      const linkedUrl = C.canvasDownloadUrl(sourceUrl, origin, id);
      if (files.has(key)) mergedReferences++;
      if (!files.has(key)) files.set(key, { key, id: String(id), name: label || `文件 ${id}`, category: C.category(label), extension: C.extension(label), size: null, mime: '', canvas: true, access: 'unknown', downloadable: true, sources: [], downloadUrl: linkedUrl || `${origin}/courses/${courseId}/files/${id}/download?download_frd=1`, originalUrl: sourceUrl || `${origin}/courses/${courseId}/files/${id}` });
      const file = files.get(key);
      if (linkedUrl) {
        // Retain link authorization parameters if they appear on a later source.
        const candidate = new URL(linkedUrl), current = new URL(file.downloadUrl);
        if (!file.sourceDownloadUrl || (!current.searchParams.has('verifier') && candidate.searchParams.has('verifier'))) {
          file.downloadUrl = linkedUrl; file.sourceDownloadUrl = linkedUrl; file.originalUrl = sourceUrl;
        }
      }
      addSource(file, source);
    }
    function addDirect(url, source, label = '') {
      url.hash = '';
      const key = C.directFileKey(url);
      if (files.has(key)) mergedReferences++;
      let name;
      try { name = decodeURIComponent(url.pathname.split('/').pop() || '') || label; } catch { name = label; }
      if (!C.extension(name) && C.extension(label)) name = label;
      if (!files.has(key)) files.set(key, { key, name: name || '外部文件', extension: C.extension(name), category: C.category(name), size: null, mime: '', canvas: false, downloadable: true, sources: [], downloadUrl: url.href, originalUrl: url.href, note: '外部直链，下载可用性由原网站决定' });
      addSource(files.get(key), source);
    }
    function addExternal(url, source, label) {
      if (!external.has(url.href)) external.set(url.href, { url: url.href, title: label || url.hostname, sources: [] });
      addSource(external.get(url.href), source);
    }
    function warning(mod, item, error, phase) {
      warnings.push({ moduleId: String(mod.id), moduleName: mod.name, title: item?.title || mod.name, phase, message: error.message || String(error) });
    }
    const course = await cached(base);
    report('正在读取全部章节，包括后续分页…');
    const modules = (await list(`${base}/modules`)).sort((a, b) => a.position - b.position);
    for (const mod of modules) {
      const beforeWarnings = warnings.length;
      let items = [];
      report(`正在扫描 ${mod.name}`);
      try { items = await list(`${base}/modules/${mod.id}/items`); }
      catch (error) { warning(mod, null, error, '章节目录'); }
      const seenPages = new Set();
      for (const item of items) {
        itemCount++;
        const source = sourceFor(mod, item);
        try {
          if (item.type === 'File') { addCanvas(item.content_id, source, item.title); continue; }
          let body = '', startUrl = source.pageUrl;
          if (item.type === 'Page') {
            const page = await cached(`${base}/pages/${encodeURIComponent(item.page_url)}`);
            if (page.locked_for_user) throw new Error(page.lock_explanation || '页面已锁定');
            body = page.body || ''; startUrl = page.html_url || `${origin}/courses/${courseId}/pages/${item.page_url}`;
            seenPages.add(startUrl.split('?')[0]); pageCount++;
          } else if (['Assignment', 'Discussion', 'Quiz'].includes(item.type)) {
            const resource = { Assignment: 'assignments', Discussion: 'discussion_topics', Quiz: 'quizzes' }[item.type];
            const data = await cached(`${base}/${resource}/${item.content_id}`);
            if (data.locked_for_user) throw new Error(data.lock_explanation || '内容已锁定');
            body = data.description || data.message || ''; startUrl = data.html_url || startUrl; pageCount++;
            for (const attachment of data.attachments || []) {
              if (attachment.id) addCanvas(attachment.id, source, attachment.display_name || attachment.filename);
            }
          } else if (['ExternalUrl', 'ExternalTool'].includes(item.type)) {
            const raw = item.external_url || item.html_url;
            if (raw) {
              const url = new URL(raw, origin);
              if (url.origin === origin && C.fileId(url.href)) addCanvas(C.fileId(url.href), source, item.title, url.href);
              else if (C.directFileLink(null, url)) addDirect(url, source, item.title);
              else addExternal(url, source, item.title);
            }
            continue;
          } else continue;
          const queue = [{ body, url: startUrl, title: item.title }];
          while (queue.length) {
            const page = queue.shift();
            const doc = parse(page.body);
            ignoredImages += doc.querySelectorAll('img[src]').length;
            // Inline images are page content, not downloadable attachments.
            // An image explicitly linked via <a href> is still collected below.
            for (const el of doc.querySelectorAll('a[href], iframe[src], video[src], audio[src], source[src], object[data], embed[src]')) {
              const raw = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data');
              if (!raw || raw.startsWith('#')) continue;
              let url;
              try { url = new URL(raw, page.url); } catch { continue; }
              if (!['https:', 'http:'].includes(url.protocol)) continue;
              const label = el.getAttribute('title') || el.textContent.trim();
              const actualSource = sourceFor(mod, item, page.url, page.title);
              const id = url.origin === origin ? C.fileId(url.href) : null;
              if (id) { addCanvas(id, actualSource, label, url.href); continue; }
              const linkedPage = url.origin === origin && url.pathname.match(new RegExp(`^/courses/${courseId}/pages/([^/]+)$`));
              if (linkedPage) {
                const canonical = `${origin}${url.pathname}`;
                if (!seenPages.has(canonical)) {
                  seenPages.add(canonical);
                  try {
                    const child = await cached(`${base}/pages/${linkedPage[1]}`);
                    if (child.locked_for_user) throw new Error(child.lock_explanation || '关联页面已锁定');
                    queue.push({ body: child.body || '', url: canonical, title: child.title || label }); pageCount++;
                  } catch (error) { warning(mod, { title: label || canonical }, error, '关联页面'); }
                }
              } else if (C.directFileLink(el, url)) {
                addDirect(url, actualSource, el.getAttribute('download') || label);
              } else if (url.origin !== origin || /^(IFRAME|VIDEO|AUDIO|SOURCE|OBJECT|EMBED)$/.test(el.tagName)) addExternal(url, actualSource, label);
            }
          }
        } catch (error) { warning(mod, item, error, '内容读取'); }
      }
      moduleResults.push({ id: String(mod.id), name: mod.name, position: mod.position, items: items.length, files: 0, errors: warnings.length - beforeWarnings });
    }
    report('正在核对真实文件名、格式和下载权限…');
    const pending = Array.from(files.values()).filter(f => f.canvas);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (cursor < pending.length) {
        const file = pending[cursor++];
        try {
          const data = await cached(`${base}/files/${file.id}`);
          C.applyFileMetadata(file, data);
        } catch (error) {
          file.note = `文件信息未核实，可尝试浏览器下载：${error.message}`;
          for (const s of file.sources) warning({ id: s.moduleId, name: s.moduleName }, { title: file.name }, error, '文件信息');
        }
        report(`已核对 ${Math.min(cursor, pending.length)} / ${pending.length} 个 Canvas 文件`);
      }
    }));
    for (const mod of moduleResults) {
      mod.files = Array.from(files.values()).filter(f => f.sources.some(s => s.moduleId === mod.id)).length;
      mod.errors = warnings.filter(w => w.moduleId === mod.id).length;
    }
    return { scanVersion: 2, courseId, origin, courseName: course.name || course.course_code || `课程 ${courseId}`, scannedAt: new Date().toISOString(), complete: warnings.length === 0, modules: moduleResults, files: Array.from(files.values()), externalLinks: Array.from(external.values()), warnings, stats: { modules: modules.length, items: itemCount, pages: pageCount, requests, ignoredImages, mergedReferences } };
  }
  root.CanvasFilesScanner = { scan };
})(globalThis);
