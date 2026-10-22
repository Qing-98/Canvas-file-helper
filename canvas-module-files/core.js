(function (root) {
  'use strict';
  const groups = {
    PDF: ['pdf'], PPT: ['ppt', 'pptx', 'pps', 'ppsx', 'odp'],
    Word: ['doc', 'docx', 'odt', 'rtf'], Excel: ['xls', 'xlsx', 'ods', 'csv', 'tsv'],
    视频: ['mp4', 'm4v', 'mov', 'webm', 'avi', 'mkv', 'wmv', 'mpeg', 'mpg'],
    音频: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'],
    压缩包: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
    图片: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic'],
    PSIM: ['psimsch', 'psim', 'sch', 'smv'], 文本: ['txt', 'md', 'log'],
    XML: ['xml'], 代码与数据: ['m', 'mlx', 'slx', 'mat', 'py', 'ipynb', 'c', 'h', 'cpp', 'v', 'sv', 'json', 'yaml', 'yml', 'dat', 'asc', 'cir', 'sp', 'spice']
  };
  function extension(name = '') {
    return String(name).split(/[?#]/)[0].match(/\.([a-z0-9]{1,12})$/i)?.[1].toLowerCase() || '';
  }
  function category(name, mime = '') {
    const ext = extension(name);
    for (const [group, exts] of Object.entries(groups)) if (exts.includes(ext)) return group;
    if (mime.includes('pdf')) return 'PDF';
    if (/presentation|powerpoint/.test(mime)) return 'PPT';
    if (/wordprocessing|msword/.test(mime)) return 'Word';
    if (/spreadsheet|excel/.test(mime)) return 'Excel';
    if (mime.startsWith('video/')) return '视频';
    if (mime.startsWith('audio/')) return '音频';
    if (mime.startsWith('image/')) return '图片';
    return '其他';
  }
  function knownFileName(name) {
    const ext = extension(name);
    return Object.values(groups).some(exts => exts.includes(ext));
  }
  function directFileLink(element, url) {
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    if (element?.tagName === 'A' && element.hasAttribute('download')) return true;
    if (knownFileName(url.pathname)) return true;
    // A title such as "Website.com" or "Read notes.pdf" does not establish
    // that an ordinary webpage URL is a file. Require a download endpoint.
    if (/(?:^|\/)downloads?(?:\/|$)/i.test(url.pathname) || url.searchParams.has('download')) {
      return ['filename', 'file_name', 'file', 'name'].some(key => knownFileName(url.searchParams.get(key) || ''));
    }
    return false;
  }
  function directFileKey(url) {
    const key = new URL(url.href); key.hash = '';
    for (const [name, value] of [...key.searchParams]) {
      if (/^utm_/i.test(name) || /^(fbclid|gclid|msclkid|_ga)$/i.test(name)
        || (/^(wrap|download_frd|download|inline|preview)$/i.test(name) && /^(1|0|true|false)?$/i.test(value))) key.searchParams.delete(name);
    }
    // Keep identity, version, and authorization parameters; only their order
    // changes here. Different files must never merge just because names match.
    key.searchParams.sort(); return `url:${key.href}`;
  }
  function sourcePageUrl(raw) {
    try {
      const url = new URL(raw); url.hash = ''; url.searchParams.delete('module_item_id'); url.searchParams.sort(); return url.href;
    } catch { return raw; }
  }
  function safeSegment(value, fallback = '未命名') {
    let s = String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').trim().replace(/[. ]+$/g, '');
    if (!s || /^\.+$/.test(s)) s = fallback;
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)) s = '_' + s;
    if (s.length > 110) {
      const ext = extension(s);
      s = s.slice(0, ext ? 108 - ext.length : 110) + (ext ? '.' + ext : '');
    }
    return s;
  }
  function downloadPath(course, file, groupByModule = true, groupByPage = false, source = file.sources[0]) {
    const chapter = source?.moduleName || '未分章';
    const parts = ['Canvas', safeSegment(course)];
    if (groupByModule) parts.push(safeSegment(chapter));
    if (groupByPage) parts.push(safeSegment(source?.pageTitle, '直接附件'));
    return [...parts, safeSegment(file.category), safeSegment(file.name)].join('/');
  }
  function downloadTargets(course, file, options = {}) {
    const groupByModule = options.groupByModule !== false;
    const groupByPage = options.groupByPage === true;
    const sources = options.sharedFileMode === 'each-source' && (groupByModule || groupByPage) ? file.sources : file.sources.slice(0, 1);
    const targets = new Map();
    for (const source of sources.length ? sources : [null]) {
      const filename = downloadPath(course, file, groupByModule, groupByPage, source);
      if (!targets.has(filename)) targets.set(filename, { filename, moduleName: source?.moduleName || '', pageTitle: source?.pageTitle || '', pageUrl: source?.pageUrl || '' });
    }
    return [...targets.values()];
  }
  function checkSavedPath(job, actualFilename) {
    job.actualFilename = actualFilename;
    const actual = actualFilename.replace(/\\/g, '/'), requestedFolder = job.filename.split('/').slice(0, -1).join('/');
    const actualFolder = actual.slice(0, actual.lastIndexOf('/'));
    const normalize = path => /^[a-z]:\//i.test(actual) ? path.toLowerCase() : path;
    job.pathVerified = normalize(actualFolder).endsWith('/' + normalize(requestedFolder));
    job.pathWarning = job.pathVerified ? '' : '实际保存目录与下载选项不符，请查看实际位置';
  }
  function progressSummary(jobs) {
    const active = jobs.filter(j => ['queued', 'in_progress', 'paused'].includes(j.state));
    const completed = jobs.filter(j => j.state === 'complete').length;
    let received = 0, total = 0, allKnown = jobs.length > 0;
    for (const job of jobs) {
      const size = job.totalBytes > 0 ? job.totalBytes : job.expectedBytes > 0 ? job.expectedBytes : null;
      if (size == null) allKnown = false;
      total += size || 0;
      received += job.state === 'complete' ? size || job.bytesReceived || 0 : Math.max(0, job.bytesReceived || 0);
    }
    const zipProgress = jobs.length === 1 && jobs[0].engine === 'zip' && Number.isFinite(jobs[0].progressPercent) ? jobs[0].progressPercent / 100 : null;
    const fraction = zipProgress ?? (allKnown && total > 0 ? received / total : jobs.length ? completed / jobs.length : 0);
    return { completed, active: active.length, received, total: allKnown ? total : null, percent: Math.min(completed === jobs.length ? 100 : 99.9, fraction * 100), allKnown };
  }
  function fileId(url) {
    try { return new URL(url).pathname.match(/\/(?:files)\/(\d+)(?:\/|$)/)?.[1] || null; } catch { return null; }
  }
  function canvasDownloadUrl(raw, origin, id) {
    try {
      const url = new URL(raw, origin);
      if (url.origin !== origin || fileId(url.href) !== String(id)) return null;
      url.pathname = url.pathname.replace(/(\/files\/\d+)(?:\/.*)?$/, '$1/download');
      url.hash = ''; url.searchParams.delete('wrap'); url.searchParams.set('download_frd', '1');
      return url.href;
    } catch { return null; }
  }
  function applyFileMetadata(file, data) {
    file.name = extension(data.display_name) ? data.display_name : data.filename || data.display_name || file.name;
    file.mime = data['content-type'] || data.content_type || '';
    file.category = category(file.name, file.mime); file.extension = extension(file.name);
    file.size = data.size ?? null;
    // Hidden files may be intentionally shared through pages/modules. Only the
    // explicit per-user lock flag is a prohibition on access.
    file.downloadable = data.locked_for_user !== true;
    file.access = file.downloadable ? 'available' : 'locked';
    file.note = file.downloadable ? '' : data.lock_explanation || 'Canvas 将此文件标记为已锁定';
    if (data.url) {
      try {
        const url = new URL(data.url, file.originalUrl);
        if (['https:', 'http:'].includes(url.protocol)) {
          const source = file.sourceDownloadUrl && new URL(file.sourceDownloadUrl);
          const authorizedSource = source && [...source.searchParams.keys()].some(key => /verifier/i.test(key));
          const authorizedApi = [...url.searchParams.keys()].some(key => /verifier/i.test(key));
          file.downloadUrl = authorizedSource && !authorizedApi ? source.href : url.href;
        }
      } catch { /* Keep the source link when Canvas supplies no usable URL. */ }
    }
    return file;
  }
  function nextLink(header = '') {
    for (const part of header.split(/,(?=\s*<)/)) {
      if (/\brel\s*=\s*["']?next\b/i.test(part)) return part.match(/<([^>]+)>/)?.[1] || null;
    }
    return null;
  }
  function trimScans(scans, now = Date.now()) {
    const kept = {}; let size = 0;
    for (const [key, value] of Object.entries(scans).sort((a,b) => String(b[1].scannedAt).localeCompare(String(a[1].scannedAt)))) {
      if (Object.keys(kept).length >= 3 || !(now - Date.parse(value.scannedAt) < 30 * 86400000)) continue;
      const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
      if (size + bytes > 2 * 1024 * 1024) continue;
      kept[key] = value; size += bytes;
    }
    return kept;
  }
  function trimJobs(jobs) {
    const active = jobs.filter(j => ['queued', 'in_progress', 'paused'].includes(j.state));
    const ended = jobs.filter(j => !['queued', 'in_progress', 'paused'].includes(j.state)).slice(-100).map(({ url, ...job }) => job);
    return [...ended, ...active];
  }
  const api = { trimScans, trimJobs, groups, extension, category, knownFileName, directFileLink, directFileKey, sourcePageUrl, safeSegment, downloadPath, downloadTargets, checkSavedPath, progressSummary, fileId, canvasDownloadUrl, applyFileMetadata, nextLink };
  root.CanvasFilesCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
