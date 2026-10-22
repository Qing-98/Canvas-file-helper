// Isolated ZIP lifecycle tests: no Canvas account or browser downloads are used.
const assert = require('node:assert/strict');
const {create} = require('../canvas-module-files/zip-downloader.js');
const zip = require('../canvas-module-files/vendor/fflate.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
async function until(test, label) { const end=Date.now()+4000; while (!test()) { if (Date.now()>end) throw new Error('Timeout: '+label); await tick(); } }
class MemoryDirectory {
  constructor(options={}) { this.name='TestFolder'; this.files=new Map(); this.options=options; this.openWriters=0; }
  async getFileHandle(name, {create=false}={}) {
    if (!this.files.has(name)) {
      if (!create) throw Object.assign(new Error('missing'), {name:'NotFoundError'});
      this.files.set(name, new Uint8Array());
    }
    return {
      getFile:async()=>{
        const blob=new Blob([this.files.get(name)]);
        return this.options.readBlob?.(name,blob) || blob;
      },
      createWritable:async()=>{
        this.openWriters++; const parts=[]; let closed=false;
        const release=()=>{if(!closed){closed=true;this.openWriters--;}};
        return {
          write:async data=>{await this.options.write?.(name,data);parts.push(data.slice());},
          close:async()=>{await this.options.close?.(name);this.files.set(name,new Uint8Array(await new Blob(parts).arrayBuffer()));release();},
          abort:async()=>{release();}
        };
      }
    };
  }
  async removeEntry(name) { this.files.delete(name); }
}
const target=(name='notes.txt',url='good',size=null)=>({filename:name,file:{key:url,name,downloadUrl:url,size,category:'文本',sources:[{moduleName:'Week 1',pageTitle:'Week 1 - Lectorial'}]}});
const makeJob=id=>({jobId:id,name:id+'.zip',state:'queued',bytesReceived:0});
const good=()=>new Response('payload',{headers:{'content-type':'text/plain'}});
function fixture(extra={}) {
  const temp=new MemoryDirectory(),updates=[],saved=[];
  const engine=create({zip,getTempDirectory:async()=>temp,fetch:async()=>good(),
    onUpdate:j=>updates.push(structuredClone(j)),saveBlob:async blob=>{saved.push(new Uint8Array(await blob.arrayBuffer()));return 'Downloads/test.zip';},...extra});
  return {engine,temp,updates,saved};
}
async function settled(f,j) { await until(()=>f.updates.some(u=>u.jobId===j.jobId&&['complete','interrupted','cancelled'].includes(u.state)&&u.phase?.includes('临时数据'))||f.updates.some(u=>u.jobId===j.jobId&&['complete','interrupted'].includes(u.state)),j.jobId+' settled'); await tick(); }
const failures=[];
async function test(label,run) {try {await run();console.log('PASS '+label);} catch(error) {failures.push(label);console.error('FAIL '+label+'\n'+error.stack);} }
(async()=>{
  await test('stop while waiting for response headers cancels without adding a failure or starting the next file',async()=>{
    let calls=0;const requested=deferred();
    const f=fixture({fetch:async(url,{signal})=>{calls++;requested.resolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}),j=makeJob('headers');
    f.engine.start(null,[target(),target('later.txt')],j);await requested.promise;f.engine.control('stop');await settled(f,j);
    assert.equal(j.state,'cancelled');assert.equal(j.entriesFailed,0);assert.equal(calls,1);assert.equal(f.temp.files.size,0);assert.equal(f.temp.openWriters,0);assert.equal(f.saved.length,0);
  });
  await test('pause before response arrives prevents staging and holds progress until resumed',async()=>{
    const response=deferred(),requested=deferred();const f=fixture({fetch:()=>{requested.resolve();return response.promise;}}),j=makeJob('paused-headers');
    f.engine.start(null,[target()],j);await requested.promise;f.engine.control('pause');response.resolve(good());await delay(35);
    assert.equal(j.state,'paused');assert.equal(j.bytesReceived,0);assert.equal(j.entriesProcessed,0);assert.equal(f.saved.length,0);
    f.engine.control('resume');await settled(f,j);assert.equal(j.state,'complete');assert.equal(j.entriesDone,1);assert.equal(f.temp.files.size,0);
  });
  await test('stop followed immediately by resume cannot revive a cancelled ZIP batch',async()=>{
    const response=deferred(),requested=deferred();const f=fixture({fetch:()=>{requested.resolve();return response.promise;}}),j=makeJob('terminal');
    f.engine.start(null,[target()],j);await requested.promise;f.engine.control('stop');f.engine.control('resume');f.engine.control('pause');response.resolve(good());await settled(f,j);
    assert.equal(j.state,'cancelled');assert.equal(j.entriesFailed,0);assert.equal(f.saved.length,0);assert.equal(f.temp.files.size,0);
  });
  await test('stopping during ZIP entry writing removes staged and partial output files',async()=>{
    let f,stopped=false;f=fixture({onUpdate:j=>{f.updates.push(structuredClone(j));if(j.stage==='packing'&&!stopped){stopped=true;f.engine.control('stop',j.jobId);}}});const j=makeJob('packing-stop');
    f.engine.start(null,[target()],j);await settled(f,j);assert(stopped);assert.equal(j.state,'cancelled');assert.equal(f.saved.length,0);assert.equal(f.temp.files.size,0);assert.equal(f.temp.openWriters,0);
  });
  await test('archive write failure is fatal, releases writers, and allows the next batch',async()=>{
    let fail=true;const output=new MemoryDirectory({write:()=>{if(fail)throw new Error('DISK_FULL');}}),f=fixture(),j=makeJob('disk-full');
    f.engine.start(output,[target()],j);await settled(f,j);assert.equal(j.state,'interrupted');assert.match(j.error,/DISK_FULL/);assert.equal(j.entriesFailed,0);assert.equal(output.files.size,0);assert.equal(output.openWriters,0);assert.equal(f.temp.files.size,0);
    fail=false;const next=makeJob('after-disk-full');f.engine.start(output,[target()],next);await settled(f,next);assert.equal(next.state,'complete');assert.equal(Object.keys(zip.unzipSync(output.files.get(next.name))).length,2);
  });
  await test('staging write failure skips only that file and continues, with no leaked part files',async()=>{
    const temp=new MemoryDirectory({write:name=>{if(name.endsWith('-0.part'))throw new Error('STAGE_WRITE_FAILED');}}),f=fixture({getTempDirectory:async()=>temp}),j=makeJob('stage-fail');
    f.engine.start(null,[target('bad.txt'),target('good.txt')],j);await settled(f,j);assert.equal(j.state,'complete');assert.equal(j.entriesFailed,1);assert.equal(j.entriesDone,1);
    const contents=zip.unzipSync(f.saved[0]);assert(!contents['bad.txt']);assert(contents['good.txt']);assert.equal(JSON.parse(new TextDecoder().decode(contents['下载失败清单.json']))[0].error,'STAGE_WRITE_FAILED');assert.equal(temp.files.size,0);assert.equal(temp.openWriters,0);
  });
  await test('stop during final filesystem commit is retained after close resolves',async()=>{
    const closing=deferred(),release=deferred();const output=new MemoryDirectory({close:async name=>{if(name.endsWith('.zip')){closing.resolve();await release.promise;}}}),f=fixture(),j=makeJob('commit-stop');
    f.engine.start(output,[target()],j);await closing.promise;f.engine.control('stop');release.resolve();await settled(f,j);
    assert.equal(j.state,'cancelled');assert.equal(output.files.size,0);assert.equal(output.openWriters,0);assert.equal(f.temp.files.size,0);assert(!f.updates.some(u=>u.state==='complete'));
  });
  await test('stop during final browser save is not overwritten by its late completion',async()=>{
    const saving=deferred(),release=deferred();const f=fixture({saveBlob:async()=>{saving.resolve();return release.promise;}}),j=makeJob('save-stop');
    f.engine.start(null,[target()],j);await saving.promise;f.engine.control('stop');release.resolve('Downloads/already-saved.zip');await settled(f,j);
    assert.equal(j.state,'cancelled');assert.equal(f.temp.files.size,0);assert(!f.updates.some(u=>u.state==='complete'));
  });
  await test('pause during packing holds ZIP output until resume without starting later requests',async()=>{
    let f,paused=false,calls=0;f=fixture({fetch:async()=>{calls++;return good();},onUpdate:j=>{f.updates.push(structuredClone(j));if(j.stage==='packing'&&!paused){paused=true;f.engine.control('pause');}}});const j=makeJob('packing-pause');
    f.engine.start(null,[target('first.txt'),target('second.txt')],j);await until(()=>paused,'packing paused');await delay(35);
    assert.equal(j.state,'paused');assert.equal(j.entriesDone,0);assert.equal(calls,1);assert.equal(f.saved.length,0);
    f.engine.control('resume');await settled(f,j);assert.equal(j.state,'complete');assert.equal(j.entriesDone,2);assert.equal(f.temp.files.size,0);
  });
  await test('pause during final filesystem commit delays completion until resumed',async()=>{
    const closing=deferred(),release=deferred();const output=new MemoryDirectory({close:async()=>{closing.resolve();await release.promise;}}),f=fixture(),j=makeJob('commit-pause');
    f.engine.start(output,[target()],j);await closing.promise;f.engine.control('pause');release.resolve();await delay(35);
    assert.equal(j.state,'paused');assert(j.progressPercent<100);assert(!f.updates.some(u=>u.state==='complete'));
    f.engine.control('resume');await settled(f,j);assert.equal(j.state,'complete');assert.equal(output.files.size,1);assert.equal(f.temp.files.size,0);
  });
  await test('failed final archive close leaves no partial archive or open writer',async()=>{
    const output=new MemoryDirectory({close:()=>{throw new Error('COMMIT_FAILED');}}),f=fixture(),j=makeJob('commit-fail');
    f.engine.start(output,[target()],j);await settled(f,j);assert.equal(j.state,'interrupted');assert.match(j.error,/COMMIT_FAILED/);assert.equal(output.files.size,0);assert.equal(output.openWriters,0);assert.equal(f.temp.files.size,0);assert.equal(f.saved.length,0);
  });
  await test('ZIP size and entry-count limits fail before network access or file allocation',async()=>{
    let calls=0;const f=fixture({fetch:async()=>{calls++;return good();}});
    for(const [id,targets] of [['size-limit',[target('large.bin','good',0xffff0000)]],['count-limit',Array(65534).fill(target())]]){
      const j=makeJob(id);f.engine.start(null,targets,j);await settled(f,j);assert.equal(j.state,'interrupted');assert.match(j.error,/上限/);assert.equal(f.temp.files.size,0);
    }
    assert.equal(calls,0);assert.equal(f.saved.length,0);
  });
  await test('final native save receives only matching-job controls, and completed jobs ignore later controls',async()=>{
    const saving=deferred(),release=deferred(),actions=[];const f=fixture({saveBlob:async(blob,j)=>{j.downloadId=77;saving.resolve();return release.promise;},controlSave:(action,j)=>actions.push([action,j.downloadId])}),j=makeJob('native-save');
    f.engine.start(null,[target()],j);await saving.promise;f.engine.control('pause','wrong-id');assert.deepEqual(actions,[]);
    f.engine.control('pause',j.jobId);f.engine.control('resume',j.jobId);assert.deepEqual(actions,[['pause',77],['resume',77]]);
    release.resolve('Downloads/native.zip');await settled(f,j);assert.equal(j.state,'complete');f.engine.control('stop',j.jobId);assert.equal(actions.length,2);assert.equal(j.state,'complete');assert.equal(f.temp.files.size,0);
  });
  await test('zero-byte files, legitimate HTML, case-insensitive collisions and report-name collisions produce a valid ZIP',async()=>{
    const f=fixture({fetch:async url=>url==='empty'?new Response(new Uint8Array()):url==='html'?new Response('<html>Course content</html>',{headers:{'content-type':'text/html'}}):good()}),j=makeJob('names');
    f.engine.start(null,[target('empty.txt','empty'),target('lesson.html','html'),target('A.txt'),target('a.txt'),target('文件来源清单.json')],j);await settled(f,j);
    assert.equal(j.state,'complete');assert.equal(j.entriesDone,5);const files=zip.unzipSync(f.saved[0]);assert.equal(files['empty.txt'].length,0);assert(files['lesson.html']);assert(files['a (1).txt']);assert(files['文件来源清单 (1).json']);assert.equal(Object.keys(files).length,6);assert.equal(f.temp.files.size,0);
  });
  await test('large mixed batch preserves every source, unique output and monotonic progress',async()=>{
    const f=fixture({fetch:async url=>Number(url)%7===0?new Response('denied',{status:403}):good()}),j=makeJob('many'),targets=Array.from({length:160},(_,i)=>target('Canvas/Week '+(i%16)+'/notes.txt',String(i)));
    f.engine.start(null,targets,j);await settled(f,j);assert.equal(j.state,'complete');assert.equal(j.entriesProcessed,160);assert.equal(j.entriesFailed,23);assert.equal(j.entriesDone,137);
    const files=zip.unzipSync(f.saved[0]),manifest=JSON.parse(new TextDecoder().decode(files['文件来源清单.json']));assert.equal(manifest.length,160);assert.equal(Object.keys(files).length,139);assert(manifest.every(item=>item.sources[0].pageTitle==='Week 1 - Lectorial'));
    assert(f.updates.every((u,i)=>!i||u.progressPercent>=f.updates[i-1].progressPercent));assert.equal(j.progressPercent,100);assert.equal(f.temp.files.size,0);assert.equal(f.temp.openWriters,0);
  });
  await test('a second batch is rejected while running; different-job controls are ignored; fresh batch works after failure',async()=>{
    const response=deferred(),requested=deferred();let first=true;const f=fixture({fetch:()=>{if(first){first=false;requested.resolve();return response.promise;}return good();}}),j=makeJob('busy');
    f.engine.start(null,[target()],j);await requested.promise;assert.throws(()=>f.engine.start(null,[target()],makeJob('duplicate')),/已有 ZIP/);
    f.engine.control('stop','unrelated-job');assert.equal(j.state,'in_progress');response.resolve(new Response('denied',{status:401}));await settled(f,j);assert.equal(j.state,'interrupted');assert.equal(f.temp.files.size,0);
    const next=makeJob('fresh');f.engine.start(null,[target()],next);await settled(f,next);assert.equal(next.state,'complete');assert.equal(next.entriesFailed,0);assert.equal(next.failures.length,0);assert.equal(f.saved.length,1);
  });
  assert.deepEqual(failures,[],'ZIP edge regression failures');
})().catch(error=>{console.error(error);process.exitCode=1;});
