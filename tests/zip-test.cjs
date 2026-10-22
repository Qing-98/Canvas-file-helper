const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {create}=require('../canvas-module-files/zip-downloader.js');
const zip=require('../canvas-module-files/vendor/fflate.js');
const C=require('../canvas-module-files/core.js');
class Directory {
  constructor(folder){this.folder=folder;this.name=path.basename(folder);}
  async getDirectoryHandle(name,{create=false}={}){const p=path.join(this.folder,name);if(create)await fs.mkdir(p,{recursive:true});return new Directory(p);}
  async getFileHandle(name,{create=false}={}){
    const p=path.join(this.folder,name);
    try{await fs.stat(p);}catch(e){if(!create){e.name='NotFoundError';throw e;}await fs.writeFile(p,'',{flag:'wx'});}
    return {getFile:async()=>new Blob([await fs.readFile(p)]),createWritable:async()=>{
      const temp=p+'.writing-'+Math.random().toString(16).slice(2),h=await fs.open(temp,'wx');
      return {write:async value=>{await h.write(value);},close:async()=>{await h.close();await fs.rename(temp,p);},abort:async()=>{await h.close();await fs.unlink(temp);}};
    }};
  }
  async removeEntry(name){await fs.unlink(path.join(this.folder,name));}
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,label){const end=Date.now()+7000;while(!await test()){if(Date.now()>end)throw new Error('Timeout: '+label);await sleep(10);}}
(async()=>{
 const testRoot=path.resolve(__dirname,'../work');await fs.mkdir(testRoot,{recursive:true});
 const folder=await fs.mkdtemp(path.join(testRoot,'canvas-zip-test-')),directory=new Directory(folder),streams=new Map(),requests=[];
 const server=http.createServer((req,res)=>{
  requests.push(req.url);
  if(req.url.startsWith('/stream')){res.writeHead(200,{'Content-Type':'text/plain','Content-Length':15});res.write('aaaaa');streams.set(req.url,res);}
  else if(req.url.startsWith('/unknown')){res.writeHead(200,{'Content-Type':'text/plain'});res.write('aaaaa');streams.set(req.url,res);}
  else if(req.url==='/denied'){res.writeHead(401,{'Content-Type':'text/plain'});res.end('Unauthorized');}
  else if(req.url==='/broken'){res.writeHead(200,{'Content-Type':'text/plain','Content-Length':100});res.write('partial');setTimeout(()=>res.destroy(),25);}
  else if(req.url==='/login'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>Login</html>');}
  else{res.writeHead(200,{'Content-Type':'text/plain','Content-Length':7});res.end('newfile');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base=`http://127.0.0.1:${server.address().port}`;
 function target(endpoint='/static',filename='Canvas/课程/Week 1/Week 1 - Lectorial/文本/讲义.txt'){
  return {filename,file:{name:'讲义.txt',category:'文本',size:7,downloadUrl:base+endpoint,sources:[{moduleName:'Week 1',pageTitle:'Week 1 - Lectorial'},{moduleName:'Week 2',pageTitle:'Week 2 - Lectorial'}]}};
 }
 let saved=0,archive; const engine=create({zip,fetch:(url,opts)=>{assert.equal(opts.credentials,'include');return fetch(url,opts);},saveBlob:async blob=>{saved++;archive=Buffer.from(await blob.arrayBuffer());return 'Downloads/archive.zip';}});
 function job(id){return {jobId:id,name:'课程.zip',bytesReceived:0,entriesDone:0,state:'queued'};}
 try{
  const a=job('one');engine.start(null,[target(),target()],a);await until(()=>a.state==='complete','blob saved');
  assert.equal(saved,1);const unzipped=zip.unzipSync(archive),names=Object.keys(unzipped);assert.equal(names.length,3);assert(names.some(n=>n.endsWith('讲义 (1).txt')));
  const listing=JSON.parse(new TextDecoder().decode(unzipped['文件来源清单.json']));assert.equal(listing.length,2);assert.equal(listing[0].sources.length,2);assert.equal(new TextDecoder().decode(unzipped[listing[0].path]),'newfile');
  await fs.writeFile(path.join(folder,'blob.zip'),archive);
  console.log('PASS single archive handoff, UTF-8 module/page paths, duplicate suffixes, complete source manifest and file bytes');
  await fs.writeFile(path.join(folder,'课程.zip'),'keep');const direct=job('direct');engine.start(directory,[target()],direct);await until(()=>direct.state==='complete','direct zip saved');assert.equal(await fs.readFile(path.join(folder,'课程.zip'),'utf8'),'keep');assert(direct.actualFilename.endsWith('课程 (1).zip'));assert.equal(saved,1);
  const tempFolder=await fs.mkdtemp(path.join(folder,'temp-')),temp=new Directory(tempFolder);const tempEngine=create({zip,getTempDirectory:async()=>temp,saveBlob:async blob=>{assert(Object.keys(zip.unzipSync(new Uint8Array(await blob.arrayBuffer()))).length===2);return 'Downloads/archive.zip';}});
  const tmp=job('temp');tempEngine.start(null,[target()],tmp);await until(()=>tmp.state==='complete','temporary file complete');assert.deepEqual(await fs.readdir(tempFolder),[]);
  console.log('PASS direct folder archive writes, existing ZIP preserved, disk-backed temporary archive cleaned after final save');
  const paused=job('pause');engine.start(directory,[target('/stream-pause')],paused);await until(()=>paused.bytesReceived===5,'first chunk');engine.control('pause');streams.get('/stream-pause').write('bbbbb');await sleep(50);assert.equal(paused.bytesReceived,5);engine.control('resume');await until(()=>paused.bytesReceived===10,'resume');streams.get('/stream-pause').end('ccccc');await until(()=>paused.state==='complete','stream complete');
  const stopped=job('stop');engine.start(directory,[target('/stream-stop')],stopped);await until(()=>stopped.bytesReceived===5,'stop first chunk');engine.control('stop');await until(()=>stopped.phase?.includes('临时数据'),'stop cleaned');assert.equal(stopped.state,'cancelled');assert(!(await fs.readdir(folder)).some(n=>n.endsWith('.writing')));
  assert.equal((await fs.readdir(folder)).filter(n=>n.endsWith('.zip')).length,4);
  const denied=job('login');engine.start(directory,[target('/login')],denied);await until(()=>denied.state==='interrupted','login rejected');assert(denied.error.includes('登录页'));assert.equal((await fs.readdir(folder)).filter(n=>n.endsWith('.zip')).length,4);
  const failedSave=create({zip,getTempDirectory:async()=>temp,saveBlob:async()=>{throw new Error('cancelled');}});const failed=job('savefail');failedSave.start(null,[target()],failed);await until(()=>failed.state==='interrupted','save fail');assert.deepEqual(await fs.readdir(tempFolder),[]);
  console.log('PASS ZIP pause/resume, stop cleans partial archive, all-failed batch creates no ZIP, cancelled save releases temporary disk file');
  const updates=[],collecting=create({zip,onUpdate:j=>updates.push({stage:j.stage,percent:j.progressPercent,processed:j.entriesProcessed,unknown:j.progressIndeterminate}),getTempDirectory:async()=>temp,saveBlob:async blob=>{archive=Buffer.from(await blob.arrayBuffer());return 'Downloads/partial.zip';}});
  const mix=job('mixed');const bad=target('/denied','Canvas/Week 1/bad.txt');bad.file.name='bad.txt';
  const broken=target('/broken','Canvas/Week 1/broken.txt');broken.file.name='broken.txt';
  collecting.start(null,[target('/static','Canvas/Week 1/first.txt'),bad,broken,target('/login','Canvas/Week 1/login.pdf'),target('/static','Canvas/Week 2/last.txt')],mix);
  await until(()=>mix.state==='complete','mixed failures continue');
  assert.equal(mix.entriesTotal,5);assert.equal(mix.entriesProcessed,5);assert.equal(mix.entriesDone,2);assert.equal(mix.entriesFailed,3);assert.equal(mix.progressPercent,100);
  const partial=zip.unzipSync(archive);assert(partial['Canvas/Week 1/first.txt']);assert(partial['Canvas/Week 2/last.txt']);assert(!partial['Canvas/Week 1/bad.txt']);assert(!partial['Canvas/Week 1/broken.txt']);assert(!partial['Canvas/Week 1/login.pdf']);
  const errors=JSON.parse(new TextDecoder().decode(partial['下载失败清单.json']));assert.equal(errors.length,3);assert.equal(errors[0].error,'HTTP 401');assert.equal(errors[0].sources.length,2);assert(errors.some(e=>e.bytesReceived>0));
  const mixedSources=JSON.parse(new TextDecoder().decode(partial['文件来源清单.json']));assert.equal(mixedSources.length,5);assert.equal(mixedSources.filter(s=>s.status==='failed').length,3);
  assert.deepEqual(await fs.readdir(tempFolder),[]);assert(updates.some(u=>u.stage==='packing'&&u.percent>0&&u.percent<95));assert(updates.every((u,i)=>!i||u.percent>=updates[i-1].percent));
  await fs.writeFile(path.join(folder,'partial-failures.zip'),archive);
  console.log('PASS HTTP 401, midstream failure and login HTML are skipped; later good files saved; no truncated entries; both reports retain sources; temporary files cleaned');
  const progressJob=job('progress'),firstUnknown=target('/stream-progress','first.txt');firstUnknown.file.size=null;
  collecting.start(null,[firstUnknown,target('/static','last.txt')],progressJob);await until(()=>progressJob.bytesReceived===5,'progress first chunk');
  assert(C.progressSummary([progressJob]).percent>0);assert.equal(C.progressSummary([progressJob]).total,null);streams.get('/stream-progress').end('bbbbbccccc');await until(()=>progressJob.state==='complete','progress saved');
  const unknownJob=job('unknown'),unknown=target('/unknown-first','first.txt'),unknown2=target('/unknown-second','second.txt');unknown.file.size=null;unknown2.file.size=null;
  collecting.start(null,[unknown,unknown2],unknownJob);await until(()=>unknownJob.bytesReceived===5,'unknown first bytes');assert.equal(unknownJob.progressIndeterminate,true);
  streams.get('/unknown-first').end('bbbbb');await until(()=>streams.has('/unknown-second'),'unknown second request');assert.equal(unknownJob.entriesProcessed,1);assert(C.progressSummary([unknownJob]).percent>0);assert.equal(unknownJob.progressIndeterminate,true);
  collecting.control('stop');await until(async()=>unknownJob.state==='cancelled'&&(await fs.readdir(tempFolder)).length===0,'unknown stop cleanup');
  const allDenied=job('all-denied'),callsBefore=requests.length;collecting.start(null,[bad,bad],allDenied);await until(()=>allDenied.state==='interrupted','all failures attempted');assert.equal(allDenied.entriesFailed,2);assert.equal(requests.length-callsBefore,2);assert(allDenied.error.includes('未生成空压缩包'));
  console.log('PASS known response bytes move progress despite unknown metadata; unknown-length responses use activity state and processed count; stop cleans staging; all failed files are attempted');
  const scan=(date,extra='')=>({scannedAt:date,extra}); const now=Date.now(),recent=new Date(now).toISOString();
  const scans=C.trimScans({old:scan(new Date(now-31*86400000).toISOString()),...Object.fromEntries([1,2,3,4].map(i=>['c'+i,scan(new Date(now-i*1000).toISOString())]))},now);
  assert.equal(Object.keys(scans).length,3);assert(!scans.old);assert(!scans.c4);assert.deepEqual(C.trimScans({huge:scan(recent,'x'.repeat(2*1024*1024))}),{});
  const jobs=C.trimJobs([...Array.from({length:130},(_,i)=>({jobId:i,state:'complete'})),{jobId:'active',state:'paused'}]);assert.equal(jobs.length,101);assert(jobs.some(j=>j.jobId==='active'));
  console.log('PASS course cache max 3 / 30 days / 2 MiB, terminal history max 100, active/paused jobs always retained');
  console.log('Archive evidence: '+folder);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
