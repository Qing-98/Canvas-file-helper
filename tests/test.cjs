const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const dir = require('node:path').resolve(__dirname,'../canvas-module-files');
const version = JSON.parse(fs.readFileSync(dir+'/manifest.json','utf8')).version;
const C = require(dir + '/core.js');
global.CanvasFilesCore = C;
require(dir + '/scanner.js');
const origin = 'https://canvas.example.edu', base = origin + '/api/v1/courses/42';
function documentOf(html) { return parseHTML('<html><body>' + html + '</body></html>').document; }
async function fixture(moduleCount, broken = false) {
  const calls = [];
  const modules = Array.from({ length: moduleCount }, (_, i) => ({ id: i + 1, name: `Chapter ${i + 1}`, position: i + 1 }));
  const fetcher = async url => {
    calls.push(url);
    const u = new URL(url), page = Number(u.searchParams.get('page') || 1);
    const path = u.pathname;
    let data, next;
    if (path === '/api/v1/courses/42') data = { name: 'A course' };
    else if (path === '/api/v1/courses/42/modules') { data = modules.slice((page-1)*100,page*100); if (page*100 < modules.length) next = `${base}/modules?per_page=100&page=${page+1}`; }
    else if (/\/modules\/\d+\/items$/.test(path)) {
      const id = Number(path.match(/\/modules\/(\d+)/)[1]);
      if (broken && id === moduleCount) return new Response('{}', { status: 403 });
      const items = id === 1 ? [
        ...Array.from({ length: 100 }, (_,i)=>({id:i+1,type:'SubHeader',title:'Heading'})),
        {id:101,type:'File',content_id:1,title:'Alias'},
        {id:102,type:'Page',page_url:'main',title:'Main page'},
        {id:103,type:'Page',page_url:'locked',title:'Locked page'},
        {id:104,type:'ExternalUrl',title:'External player',external_url:'https://player.example.com/watch/8'},
        {id:105,type:'ExternalUrl',title:'External deck',external_url:'https://files.example.com/slide.pptx'},
        {id:106,type:'Assignment',content_id:8,title:'Assignment attachments'}
      ] : [{id:1000+id,type:'File',content_id:1,title:'Repeated'}, {id:2000+id,type:'File',content_id:id+10,title:'Unique'}];
      data = items.slice((page-1)*100,page*100); if(page*100<items.length) next=`${base}/modules/${id}/items?per_page=100&page=${page+1}`;
    } else if (path.endsWith('/pages/main')) data = { body: `
      <a href="/courses/42/files/2?wrap=1">friendly label</a>
      <a href="/courses/42/files/2/download?download_frd=1#download">Download</a>
      <a href="/courses/42/pages/child?module_item_id=9#topic">child</a>
      <iframe src="https://player.example.com/video"></iframe>
      <iframe src="https://player.example.com/player.html"></iframe>
      <iframe src="/courses/42/files/2/preview"></iframe>
      <a href="https://example.com/file.zip?signature=ok">zip</a>
      <a href="https://example.com/file.zip?utm_source=canvas&amp;signature=ok&amp;download=1#download">same zip</a>
      <img src="/courses/42/files/7/preview" alt="School logo">
      <a href="/courses/42/files/8/download"><img src="/courses/42/files/8/preview" alt="Download diagram"></a>
      <a href="https://example.com/help.html" title="Help.pdf">Help page</a>
      <a href="https://example.com/index.php">Website</a>
      <script src="https://example.com/widget.js"></script><link rel="stylesheet" href="https://example.com/style.css">
      <video src="https://example.com/stream.m3u8"></video>
      <a href="javascript:alert(1)">skip</a>
      ${Array.from({length:16},(_,i)=>`<img src="/courses/99/files/${200+i}/preview" alt="Navigation decoration">`).join('')}
    `, html_url: origin+'/courses/42/pages/main?module_item_id=102#top' };
    else if(path.endsWith('/pages/child')) data = { body: '<a href="/courses/42/files/3">unknown</a><a href="/courses/42/pages/main">cycle</a>',title:'Child'};
    else if(path.endsWith('/pages/locked')) data = broken ? {locked_for_user:true,lock_explanation:'Locked'} : {body:'No attachments'};
    else if(path.endsWith('/assignments/8')) data = {description:'<a href="/courses/42/files/4">data</a>',attachments:[{id:5,display_name:'a.txt'}]};
    else if(/\/files\/\d+$/.test(path)) {
      const id=Number(path.match(/\/files\/(\d+)/)[1]);
      if (broken && id === 5) return new Response('{}', {status:403});
      data={id,filename:({1:'lecture.pdf',2:'demo.psimsch',3:'demo.xml',4:'data.txt',5:'a.txt',7:'logo.png',8:'chart.png'})[id]||`unique-${id}.pdf`,size:100+id,'content-type':'application/octet-stream',hidden:true,hidden_for_user:true,locked_for_user:broken&&id===3,url:`${origin}/files/${id}/download?download_frd=1`};
    } else throw new Error('Unexpected URL '+url);
    return new Response(JSON.stringify(data),{headers:next?{Link:`<${next}>; rel="next", <${base}>; rel="current"`}:{}});
  };
  return {result:await CanvasFilesScanner.scan({origin,courseId:42},{fetch:fetcher,parse:documentOf,progress:()=>{}}),calls};
}
(async()=>{
  assert.equal(C.category('demo.psimsch'),'PSIM'); assert.equal(C.category('demo.smv.setting.xml'),'XML');
  assert.equal(C.category('no-extension','video/mp4'),'视频'); assert.equal(C.category('novel.abc'),'其他');
  assert.equal(C.safeSegment('../CON.txt'),'.._CON.txt'); assert.equal(C.safeSegment('CON.txt'),'_CON.txt');
  assert(!C.downloadPath('../Course',{name:'../../bad.txt',category:'文本',sources:[{moduleName:'A/B'}]}).includes('/../'));
  assert.equal(C.fileId('https://a.edu/api/v1/courses/42/files/123/download'),'123');
  assert.equal(C.nextLink('<https://a/2>; rel="next", <https://a/1>; rel="prev"'),'https://a/2');
  const actualFile = {id:'55091263',originalUrl:'https://rmit.instructure.com/courses/157729/files/55091263',downloadable:false};
  C.applyFileMetadata(actualFile,{id:55091263,display_name:'EEET2386_2026_safety.pdf','content-type':'application/pdf',size:1219319,hidden:true,hidden_for_user:true,locked:false,locked_for_user:false,url:'https://rmit.instructure.com/files/55091263/download?download_frd=1'});
  assert.equal(actualFile.downloadable,true); assert.equal(actualFile.category,'PDF');assert.equal(actualFile.downloadUrl,'https://rmit.instructure.com/files/55091263/download?download_frd=1');
  console.log('PASS real Canvas metadata regression: hidden_for_user=true + locked_for_user=false remains selectable');
  const sourceUrl = C.canvasDownloadUrl(origin+'/courses/42/files/9?wrap=1&verifier=test-link',origin,9);
  assert(new URL(sourceUrl).searchParams.get('verifier')==='test-link'); assert(!new URL(sourceUrl).searchParams.has('wrap'));
  const authorized = {id:'9',originalUrl:sourceUrl,sourceDownloadUrl:sourceUrl};
  C.applyFileMetadata(authorized,{filename:'a.pdf',locked_for_user:false,url:origin+'/files/9/download'});
  assert.equal(new URL(authorized.downloadUrl).searchParams.get('verifier'),'test-link');
  C.applyFileMetadata(authorized,{filename:'a.pdf',locked_for_user:true,hidden_for_user:false,lock_explanation:'Unavailable until tomorrow'});
  assert.equal(authorized.downloadable,false);assert.equal(authorized.note,'Unavailable until tomorrow');
  console.log('PASS source authorization retained, official download URL preferred, actual user lock still enforced');
  const directKey = raw => C.directFileKey(new URL(raw));
  assert.equal(directKey(origin+'/note.pdf?b=2&a=1#top'),directKey(origin+'/note.pdf?a=1&b=2&utm_source=canvas&wrap=1&download_frd=1'));
  assert.notEqual(directKey(origin+'/note.pdf?version=1'),directKey(origin+'/note.pdf?version=2'));
  assert.notEqual(directKey(origin+'/download?file=a.pdf'),directKey(origin+'/download?file=b.pdf'));
  assert.notEqual(directKey(origin+'/note.pdf?verifier=a'),directKey(origin+'/note.pdf?verifier=b'));
  assert(!C.directFileLink(null,new URL(origin+'/help.html')));
  assert(!C.directFileLink(null,new URL(origin+'/file.php')));
  assert(!C.directFileLink(null,new URL(origin+'/stream.m3u8')));
  assert(C.directFileLink(null,new URL(origin+'/download?filename=notes.pdf')));
  assert(C.directFileLink(documentOf('<a href="https://a/custom.xyz" download="data.xyz">Download</a>').querySelector('a'),new URL('https://a/custom.xyz')));
  assert.equal(C.sourcePageUrl(origin+'/courses/42/pages/main?module_item_id=1#x'),C.sourcePageUrl(origin+'/courses/42/pages/main?module_item_id=2'));
  console.log('PASS URL variants merge; identity, version and authorization are preserved; ordinary webpages are excluded');
  for(const count of [1,7,137]) {
    const {result:r,calls}=await fixture(count);
    assert.equal(r.modules.length,count); assert.equal(r.complete,true); assert.equal(r.warnings.length,0);
    assert.equal(r.files.find(f=>f.id==='1').sources.length,count);
    assert.equal(r.files.filter(f=>f.id==='2').length,1);
    assert.equal(r.files.find(f=>f.id==='2').category,'PSIM');
    assert(r.files.every(f=>f.downloadable));
    assert.equal(r.files.find(f=>f.id==='1').downloadUrl,origin+'/files/1/download?download_frd=1');
    assert.equal(r.files.find(f=>f.id==='3').category,'XML');
    assert.equal(r.files.find(f=>f.id==='7'),undefined);
    assert.equal(r.files.find(f=>f.id==='8').category,'图片');
    assert.equal(r.files.find(f=>f.id==='2').sources.length,1);
    assert(!calls.some(u=>/\/files\/(?:7|2\d\d)$/.test(new URL(u).pathname)));
    assert.equal(r.stats.ignoredImages,18);
    assert(r.stats.mergedReferences>=3);
    assert(!r.files.some(f=>/help\.html|index\.php|widget\.js|style\.css|stream\.m3u8|player\.html/.test(f.downloadUrl)));
    assert(r.files.some(f=>f.category==='压缩包')); assert(r.files.some(f=>f.category==='PPT'));
    assert.equal(r.files.length,8+Math.max(0,count-1));
    assert.equal(r.files.filter(f=>f.downloadUrl.startsWith('https://example.com/file.zip')).length,1);
    assert(calls.some(u=>u.includes('/modules/1/items?')&&u.includes('page=2')));
    if(count>100) assert(calls.some(u=>u.includes('/modules?')&&u.includes('page=2')));
    assert.equal(calls.filter(u=>u.endsWith('/files/1')).length,1);
    console.log(`PASS dynamic ${count} modules, pagination, nested-page cycle, dedup, names, categories, embedded file and attachments`);
  }
  const {result:bad}=await fixture(3,true); assert.equal(bad.complete,false); assert(bad.warnings.length>=2); assert(!bad.files.find(f=>f.id==='3').downloadable); assert(bad.modules.find(m=>m.id==='3').errors);
  assert.equal(bad.files.find(f=>f.id==='5').access,'unknown'); assert.equal(bad.files.find(f=>f.id==='5').downloadable,true);
  console.log('PASS metadata HTTP 403 remains an unverified source download, not an account-permission denial');
  console.log('PASS locked resources and failed module are visible as incomplete');
  const events={}, states=new Map(), suggestions=[],shown=[]; let storage={downloadJobs:[],scanResults:{test:{courseName:'A course',files:Array.from({length:7},(_,i)=>({key:`f${i}`,name:`file${i}.txt`,downloadable:i!==6,category:'文本',downloadUrl:`${origin}/file${i}.txt`,sources:[{moduleId:'1',moduleName:'Week 1',pageTitle:'Week 1 - Lectorial',pageUrl:origin+'/pages/week1'},{moduleId:'2',moduleName:'Week 2',pageTitle:'Week 2 - Lectorial',pageUrl:origin+'/pages/week2'}]}))}}}; let did=0;
  const chrome={action:{onClicked:{addListener:fn=>events.action=fn}},runtime:{id:'id',getURL:p=>'chrome-extension://id/'+p,getManifest:()=>({version}),onMessage:{addListener:fn=>events.message=fn},onStartup:{addListener:fn=>events.startup=fn}},storage:{local:{get:async keys=>structuredClone(storage),set:async v=>{Object.assign(storage,structuredClone(v));}}},downloads:{download:async opts=>{const id=++did;states.set(id,{id,state:'in_progress',...opts});events.determine({id,byExtensionId:'id',url:opts.url},s=>suggestions.push(s));return id;},search:async({id})=>states.has(id)?[{...states.get(id),filename:'D:\\Downloads\\'+states.get(id).filename.replace(/\//g,'\\')}]:[],show:async id=>shown.push(id),onChanged:{addListener:fn=>events.changed=fn},onDeterminingFilename:{addListener:fn=>events.determine=fn}}};
  const context={chrome,crypto:require('node:crypto').webcrypto,URL,URLSearchParams,console,importScripts:()=>{},CanvasFilesCore:C}; vm.createContext(context);vm.runInContext(fs.readFileSync(dir+'/background.js','utf8'),context);
  const send=message=>new Promise(resolve=>events.message({appVersion:version,...message},{id:'id',url:'chrome-extension://id/app.html'},resolve));
  await send({type:'START_DOWNLOADS',courseKey:'test',keys:['f0','f1','f2','f3','f4','f6']});
  assert.equal(did,3);assert.equal(storage.downloadJobs.length,5);assert.equal(storage.downloadJobs.filter(j=>j.state==='queued').length,2);
  const first=storage.downloadJobs[0];states.get(first.downloadId).state='complete'; events.changed({id:first.downloadId,state:{current:'complete'}});await vm.runInContext('chain',context);
  assert.equal(did,4);assert.equal(storage.downloadJobs.find(j=>j.fileKey==='f0').state,'complete');assert(!storage.downloadJobs.some(j=>j.fileKey==='f5'||j.fileKey==='f6'));
  const second=storage.downloadJobs[1];states.get(second.downloadId).state='interrupted';states.get(second.downloadId).error='NETWORK_FAILED';events.changed({id:second.downloadId,state:{current:'interrupted'},error:{current:'NETWORK_FAILED'}});await vm.runInContext('chain',context);
  assert.equal(did,5); assert.equal(storage.downloadJobs[1].error,'NETWORK_FAILED');assert.equal(storage.downloadJobs[1].state,'interrupted');
  assert([...states.values()].every(s=>s.filename.startsWith('Canvas/A course/Week 1/文本/')));
  console.log('PASS selected-only batch, 3 concurrent downloads, automatic queue continuation, error status, chapter paths');
  const previousPaths=storage.downloadJobs.map(j=>[j.jobId,j.filename]);
  await send({type:'START_DOWNLOADS',courseKey:'test',keys:['f5'],groupByModule:false});
  const flatJob=storage.downloadJobs.find(j=>j.fileKey==='f5');
  assert.equal(flatJob.filename,'Canvas/A course/文本/file5.txt');
  assert.equal(flatJob.state,'queued');
  for(const [jobId,filename] of previousPaths) assert.equal(storage.downloadJobs.find(j=>j.jobId===jobId).filename,filename);
  const finishing=storage.downloadJobs.find(j=>j.state==='in_progress');
  states.get(finishing.downloadId).state='complete';events.changed({id:finishing.downloadId,state:{current:'complete'}});await vm.runInContext('chain',context);
  assert.equal(states.get(storage.downloadJobs.find(j=>j.fileKey==='f5').downloadId).filename,'Canvas/A course/文本/file5.txt');
  const moduleFile={name:'lecture.pdf',category:'PDF',sources:[{moduleName:'Week 1'},{moduleName:'Week 2'}]};
  assert.equal(C.downloadPath('A course',moduleFile,true),'Canvas/A course/Week 1/PDF/lecture.pdf');
  assert.equal(C.downloadPath('A course',moduleFile,false),'Canvas/A course/PDF/lecture.pdf');
  console.log('PASS per-batch Module folders on/off, original queued paths retained, selected layout reaches Chrome download API');
  assert.equal(suggestions.length,did);assert(suggestions.every(s=>s.filename.startsWith('Canvas/A course/')));
  let foreignSuggestion='not-called';events.determine({id:999,byExtensionId:'another-extension',url:origin+'/other.pdf'},s=>foreignSuggestion=s);assert.equal(foreignSuggestion,undefined);
  assert.equal(storage.downloadJobs.find(j=>j.fileKey==='f0').pathVerified,true);
  const saved={filename:'Canvas/A course/Week 1/文本/file0.txt'};
  C.checkSavedPath(saved,'D:\\Downloads\\Canvas\\A course\\Week 1\\文本\\file0 (1).txt');assert.equal(saved.pathVerified,true);
  C.checkSavedPath(saved,'D:\\Downloads\\file0.txt');assert.equal(saved.pathVerified,false);assert(saved.pathWarning);
  const oldVersion=await send({type:'START_DOWNLOADS',courseKey:'test',keys:['f0'],appVersion:'1.0.3'});assert.equal(oldVersion.ok,false);assert(oldVersion.error.includes('旧版本'));
  const once=C.downloadTargets('A course',storage.scanResults.test.files[0],{groupByModule:true,groupByPage:true,sharedFileMode:'once'});
  assert.equal(once.length,1);assert.equal(once[0].filename,'Canvas/A course/Week 1/Week 1 - Lectorial/文本/file0.txt');
  const copies=C.downloadTargets('A course',storage.scanResults.test.files[0],{groupByModule:true,groupByPage:true,sharedFileMode:'each-source'});assert.equal(copies.length,2);
  assert.equal(C.downloadTargets('A course',storage.scanResults.test.files[0],{groupByModule:false,groupByPage:false,sharedFileMode:'each-source'}).length,1);
  const copyResponse=await send({type:'START_DOWNLOADS',courseKey:'test',keys:['f0'],groupByModule:true,groupByPage:true,sharedFileMode:'each-source'});assert.equal(copyResponse.addedCount,2);
  const copyBatch=copyResponse.jobs.at(-1).batchId;
  const copyJobs=storage.downloadJobs.filter(j=>j.fileKey==='f0'&&j.batchId===copyBatch);assert.equal(copyJobs.length,2);assert(copyJobs.some(j=>j.filename.includes('/Week 2/Week 2 - Lectorial/')));
  const duplicateResponse=await send({type:'START_DOWNLOADS',courseKey:'test',keys:['f0'],groupByModule:true,groupByPage:true,sharedFileMode:'each-source'});assert.equal(duplicateResponse.addedCount,0);
  const showResponse=await send({type:'SHOW_DOWNLOAD',jobId:first.jobId});assert.equal(showResponse.ok,true);assert.equal(shown.at(-1),first.downloadId);
  console.log('PASS filename-determination race, no effect on other downloads, actual-folder verification, old UI rejection, page titles, shared source copies and folder reveal');
  storage.scanResults.test.files.push({...storage.scanResults.test.files[0],key:'external',canvas:false,downloadUrl:'https://external.test/notes.pdf'});
  const previousJobCount=storage.downloadJobs.length;
  const implicitExternal=await send({type:'START_DOWNLOADS',courseKey:'test',keys:['external']});
  assert.equal(implicitExternal.ok,false);assert(implicitExternal.error.includes('额外勾选'));assert.equal(storage.downloadJobs.length,previousJobCount);
  const explicitExternal=await send({type:'START_DOWNLOADS',courseKey:'test',keys:['external'],explicitExternalKeys:['external']});
  assert.equal(explicitExternal.ok,true);assert.equal(explicitExternal.addedCount,1);
  console.log('PASS external direct downloads require a separate explicit selection at queue entry');
  const actions=[];
  chrome.downloads.pause=async id=>{actions.push(['pause',id]);states.get(id).paused=true;};
  chrome.downloads.resume=async id=>{actions.push(['resume',id]);states.get(id).paused=false;};
  chrome.downloads.cancel=async id=>{actions.push(['stop',id]);states.get(id).state='interrupted';states.get(id).error='USER_CANCELED';};
  const activeJob=storage.downloadJobs.find(j=>j.state==='in_progress');
  Object.assign(states.get(activeJob.downloadId),{bytesReceived:50,totalBytes:100});
  await send({type:'REFRESH_DOWNLOADS'});
  assert.equal(storage.downloadJobs.find(j=>j.jobId===activeJob.jobId).bytesReceived,50);
  assert.equal(C.progressSummary([storage.downloadJobs.find(j=>j.jobId===activeJob.jobId)]).percent,50);
  const startedBeforePause=did;
  await send({type:'CONTROL_DOWNLOADS',courseKey:'test',action:'pause'});
  assert(storage.downloadJobs.filter(j=>['queued','in_progress','paused'].includes(j.state)).every(j=>j.state==='paused'));
  await send({type:'REFRESH_DOWNLOADS'});assert.equal(did,startedBeforePause);
  await send({type:'CONTROL_DOWNLOADS',courseKey:'test',action:'resume'});
  assert(storage.downloadJobs.some(j=>j.state==='in_progress'));assert(actions.some(a=>a[0]==='resume'));
  await send({type:'CONTROL_DOWNLOADS',courseKey:'test',action:'pause'});
  const pausedQueue=storage.downloadJobs.find(j=>j.state==='paused'&&j.downloadId==null);
  const pausedNetwork=storage.downloadJobs.find(j=>j.state==='paused'&&j.downloadId!=null);
  await send({type:'CONTROL_DOWNLOADS',courseKey:'test',action:'resume',jobId:pausedQueue.jobId});
  await send({type:'CONTROL_DOWNLOADS',courseKey:'test',action:'stop',jobId:pausedNetwork.jobId});
  assert.equal(storage.downloadJobs.find(j=>j.jobId===pausedNetwork.jobId).state,'cancelled');
  assert.equal(storage.downloadJobs.find(j=>j.jobId===pausedQueue.jobId).state,'in_progress');
  const completedBeforeStop=storage.downloadJobs.filter(j=>j.state==='complete').map(j=>j.jobId),startedBeforeStop=did;
  await send({type:'CONTROL_DOWNLOADS',courseKey:'test',action:'stop'});
  assert(!storage.downloadJobs.some(j=>['queued','in_progress','paused'].includes(j.state)));
  assert(completedBeforeStop.every(id=>storage.downloadJobs.find(j=>j.jobId===id).state==='complete'));
  await send({type:'REFRESH_DOWNLOADS'});assert.equal(did,startedBeforeStop);
  const unknown=C.progressSummary([{state:'in_progress',bytesReceived:20},{state:'complete',bytesReceived:10}]);assert.equal(unknown.total,null);assert.equal(unknown.completed,1);assert.equal(unknown.percent,50);
  console.log('PASS native byte progress, course/per-file pause-resume-stop, paused queue stays paused, stopped queue never restarts, completed files retained');
})().catch(e=>{console.error(e);process.exitCode=1;});
