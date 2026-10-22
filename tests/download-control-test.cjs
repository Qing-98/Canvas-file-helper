// Isolated in-memory simulation. Does not connect to or control any browser.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'../canvas-module-files'),C=require(root+'/core.js');
const version=JSON.parse(fs.readFileSync(root+'/manifest.json','utf8')).version;
const tick=()=>new Promise(r=>setImmediate(r));
async function until(test){for(let i=0;i<100;i++){if(test())return;await tick();}throw new Error('condition not reached');}
function fixture({early='created'}={}){
 const events={},native=new Map(),actions=[];let next=0,blocked=false,release;
 const store={downloadJobs:[],scanResults:{course:{courseName:'Course',files:[0,1,2,3].map(i=>({key:'f'+i,name:'f'+i+'.pdf',downloadable:true,category:'PDF',downloadUrl:'https://example.invalid/files/'+i+'/download',sources:[{moduleName:'Week 1'}]}))}}};
 const chrome={action:{onClicked:{addListener:()=>{}}},runtime:{id:'test',getURL:p=>'test-extension://test/'+p,getManifest:()=>({version}),onMessage:{addListener:f=>events.message=f},onStartup:{addListener:()=>{}}},storage:{local:{get:async()=>structuredClone(store),set:async value=>Object.assign(store,structuredClone(value))}},downloads:{
  download:async opts=>{const id=++next;native.set(id,{id,state:'in_progress',paused:false,filename:opts.filename,url:opts.url,byExtensionId:'test'});if(early==='created')events.created?.(native.get(id));if(early==='filename')events.determine?.(native.get(id),()=>{});if(next===2){blocked=true;await new Promise(r=>release=r);}return id;},
  search:async({id})=>native.has(id)?[structuredClone(native.get(id))]:[],
  pause:async id=>{actions.push(['pause',id]);native.get(id).paused=true;},resume:async id=>{actions.push(['resume',id]);native.get(id).paused=false;},cancel:async id=>{actions.push(['stop',id]);native.get(id).state='interrupted';native.get(id).error='USER_CANCELED';},
  onCreated:{addListener:f=>events.created=f},onChanged:{addListener:f=>events.changed=f},onDeterminingFilename:{addListener:f=>events.determine=f}}};
 const context={chrome,crypto:require('node:crypto').webcrypto,URL,URLSearchParams,console,importScripts:()=>{},CanvasFilesCore:C};vm.createContext(context);vm.runInContext(fs.readFileSync(root+'/background.js','utf8'),context);
 const send=message=>new Promise(r=>events.message({appVersion:version,...message},{id:'test',url:'test-extension://test/app.html'},r));
 return {events,native,actions,store,chrome,context,send,blocked:()=>blocked,release:()=>release(),count:()=>next};
}
(async()=>{
 for(const action of ['pause','stop']){
  const f=fixture();const start=f.send({type:'START_DOWNLOADS',courseKey:'course',keys:['f0','f1','f2','f3']});await until(f.blocked);
  const control=f.send({type:'CONTROL_DOWNLOADS',courseKey:'course',action});for(let i=0;i<5;i++)await tick();
  const responded=f.actions.some(a=>a[0]===action&&a[1]===1);
  f.release();await Promise.all([start,control]);
  assert(responded,action+' did not reach an existing download while a later start was waiting');
  assert.equal(f.count(),2,'a later queued task started after '+action);
  assert([...f.native.values()].every(j=>action==='pause'?j.paused:j.state==='interrupted'));
 }
 console.log('PASS pause/stop reach active and just-created downloads while another start promise is blocked; no later queued start');
 const f=fixture();const start=f.send({type:'START_DOWNLOADS',courseKey:'course',keys:['f0','f1']});await until(f.blocked);f.release();await start;
 f.chrome.downloads.pause=async()=>{throw new Error('PAUSE_TEST_REJECTED');};
 const response=await f.send({type:'CONTROL_DOWNLOADS',courseKey:'course',action:'pause'});
 assert(response.controlErrors?.some(e=>e.error.includes('PAUSE_TEST_REJECTED')),'Control errors were silently hidden');
 assert(response.jobs.every(j=>j.state==='in_progress'));
 console.log('PASS control rejection reported to UI; jobs remain in their actual running state');
 for(const early of ['filename','none']){
  const g=fixture({early});const start=g.send({type:'START_DOWNLOADS',courseKey:'course',keys:['f0','f1','f2','f3']});await until(g.blocked);
  const stop=g.send({type:'CONTROL_DOWNLOADS',courseKey:'course',action:'stop'});await until(()=>g.actions.some(a=>a[0]==='stop'&&a[1]===1));g.release();await Promise.all([start,stop]);
  assert.equal(g.count(),2);assert([...g.native.values()].every(j=>j.state==='interrupted'));
 }
 console.log('PASS filename-event ID and delayed ID are both cancelled; later queued files never start');
 const g=fixture();const gs=g.send({type:'START_DOWNLOADS',courseKey:'course',keys:['f0','f1']});await until(g.blocked);g.release();await gs;
 g.native.set(999,{id:999,state:'in_progress',paused:false});
 g.chrome.downloads.cancel=async()=>{};
 const unconfirmed=await g.send({type:'CONTROL_DOWNLOADS',courseKey:'course',action:'stop'});
 assert.equal(unconfirmed.controlErrors.length,2);assert(unconfirmed.jobs.every(j=>j.state==='in_progress'));assert.equal(g.native.get(999).state,'in_progress');
 console.log('PASS resolved-but-ineffective cancel is reported as failure, actual running state retained, unrelated downloads untouched');
 const h=fixture();const hs=h.send({type:'START_DOWNLOADS',courseKey:'course',keys:['f0','f1']});await until(h.blocked);h.release();await hs;
 const first=h.store.downloadJobs[0];await h.send({type:'CONTROL_DOWNLOADS',courseKey:'course',jobId:first.jobId,action:'pause'});
 assert.equal(h.native.get(1).paused,true);assert.equal(h.native.get(2).paused,false);
 await h.send({type:'CONTROL_DOWNLOADS',courseKey:'course',jobId:first.jobId,action:'resume'});assert.equal(h.native.get(1).paused,false);
 h.native.get(1).state='complete';const finished=await h.send({type:'CONTROL_DOWNLOADS',courseKey:'course',jobId:first.jobId,action:'stop'});
 assert.equal(finished.jobs.find(j=>j.jobId===first.jobId).state,'complete');assert.equal(finished.controlErrors.length,0);
 console.log('PASS individual pause/resume only affects its own ID; already completed file remains completed');
 const wrong=fixture();const ws=wrong.send({type:'START_DOWNLOADS',courseKey:'course',keys:['f0','f1']});await until(wrong.blocked);
 const pendingId=wrong.store.downloadJobs[1].jobId;
 const unrelated=wrong.send({type:'CONTROL_DOWNLOADS',courseKey:'another-course',jobId:pendingId,action:'stop'});
 wrong.release();await Promise.all([ws,unrelated]);assert(wrong.native.get(2).state==='in_progress');assert.equal(wrong.actions.length,0);
 console.log('PASS a stale row pointing to a different course cannot cancel its pending native download');
})().catch(e=>{console.error(e);process.exitCode=1;});
