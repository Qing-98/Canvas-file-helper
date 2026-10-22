// Exercise the real app save function together with the real background listener.
// Chrome ignores download({filename}) when onDeterminingFilename is registered.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const C=require('../canvas-module-files/core.js'),root=path.resolve(__dirname,'../canvas-module-files');
const background=fs.readFileSync(path.join(root,'background.js'),'utf8'),app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const saveCode=app.slice(app.indexOf('async function saveZipBlob('),app.indexOf('const zipDownloads ='));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const version=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8')).version;
const base='chrome-extension://extension-id/',session={},events={},downloads=new Map(),revoked=[],listeners=new Set();
let next=0,blobId=0,failRegistration=false,failSave=false;
const chrome={
  runtime:{id:'extension-id',getURL:p=>base+p,getManifest:()=>({version}),onMessage:{addListener:f=>events.message=f},onStartup:{addListener:()=>{}}},
  action:{onClicked:{addListener:()=>{}}},
  storage:{local:{get:async()=>({downloadJobs:[]})},session:{
    get:async key=>({[key]:session[key]}),
    set:async value=>{if(failRegistration)throw new Error('SESSION_WRITE_FAILED');Object.assign(session,value);},
    remove:async key=>{delete session[key];}
  }},
  downloads:{onCreated:{addListener:f=>events.created=f},onDeterminingFilename:{addListener:f=>events.determine=f},
    onChanged:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)},
    search:async({id})=>downloads.has(id)?[downloads.get(id)]:[],
    download:async opts=>{
      if(failSave)throw new Error('SAVE_CANCELLED');
      const id=++next,item={id,url:opts.url,byExtensionId:'extension-id',filename:'random-blob-id',state:'in_progress'};
      assert(opts.saveAs);assert.equal(opts.conflictAction,'uniquify');
      const suggestion=await new Promise(resolve=>events.determine(item,resolve));
      // Deliberately DO NOT use opts.filename, matching Chrome's documented rule.
      item.filename='Downloads/'+(suggestion?.filename||item.filename);
      item.state='complete';downloads.set(id,item);return id;
    }
  }
};
function loadWorker(){const c={chrome,CanvasFilesCore:C,URL,URLSearchParams,console,crypto:require('node:crypto').webcrypto,importScripts:()=>{}};vm.createContext(c);vm.runInContext(background,c);return c;}
const sender={id:'extension-id',url:base+'app.html'};
const send=(message,from=sender)=>new Promise(resolve=>events.message(message,from,resolve));
chrome.runtime.sendMessage=send;
loadWorker();
const context={chrome,URL:{createObjectURL:()=>`blob:${base}${++blobId}`,revokeObjectURL:url=>revoked.push(url)},t:key=>key,setInterval:()=>0,clearInterval:()=>{}};
vm.createContext(context);vm.runInContext(saveCode,context);
const save=(name,state='in_progress')=>context.saveZipBlob({}, {name,state});
(async()=>{
  const previousTZ=process.env.TZ;process.env.TZ='Australia/Sydney';
  try{
    const time=new Date('2026-10-22T00:05:06+11:00');
    assert.equal(C.zipFilename('Switched Mode Power Supplies (2650)','资料',time),'Switched Mode Power Supplies (2650)_资料_2026-10-22_00-05-06.zip');
    assert.equal(C.zipFilename('电力/电子:实验','Files',time),'电力_电子_实验_Files_2026-10-22_00-05-06.zip');
    assert(C.zipFilename('CON','Files',time).startsWith('_CON_'));
    assert(C.zipFilename('', 'Files',time).startsWith('Canvas_Files_'));
    assert(C.zipFilename('课'.repeat(300),'资料',time).endsWith('_资料_2026-10-22_00-05-06.zip'));
  }finally{if(previousTZ===undefined)delete process.env.TZ;else process.env.TZ=previousTZ;}
  console.log('PASS readable ZIP names preserve course, Chinese/English label and local date/time, with valid filename characters and .zip suffix');
  const unregistered=await new Promise(resolve=>events.determine({id:99,url:'blob:'+base+'unknown',byExtensionId:'extension-id'},resolve));
  assert.equal(unregistered,undefined);
  const names=['课程_资料_2026-10-22_22-01-02.zip','Course_Files_2026-10-22_22-01-03.zip'];
  const saved=await Promise.all(names.map(name=>save(name)));
  assert.deepEqual(saved,names.map(name=>'Downloads/'+name));assert.equal(Object.keys(session).length,0);assert.equal(revoked.length,2);
  console.log('PASS app-to-background ZIP filename integration despite ignored download filename option; concurrent archives keep separate names and clean session mappings');
  const url='blob:'+base+'waiting-dialog',name=names[0];
  assert.equal((await send({type:'REGISTER_ZIP_FILENAME',url,filename:name})).ok,true);
  loadWorker();
  const suggestion=await new Promise(resolve=>events.determine({id:100,url,byExtensionId:'extension-id'},resolve));
  assert.equal(suggestion.filename,name);assert.equal(suggestion.conflictAction,'uniquify');
  let foreign;events.determine({id:101,url,byExtensionId:'other-extension'},value=>foreign=value);assert.equal(foreign,undefined);
  await send({type:'RELEASE_ZIP_FILENAME',url});assert.equal(Object.keys(session).length,0);
  console.log('PASS saved ZIP name survives service-worker restart while save dialog is pending; other extensions are unaffected');
  // Registration must not queue behind an unrelated native download start.
  const blockedWorker=loadWorker();vm.runInContext('chain = new Promise(() => {})',blockedWorker);
  assert.equal((await send({type:'REGISTER_ZIP_FILENAME',url,filename:name})).ok,true);
  await send({type:'RELEASE_ZIP_FILENAME',url});loadWorker();
  failRegistration=true;const before=next;await assert.rejects(save(name),/SESSION_WRITE_FAILED/);failRegistration=false;assert.equal(next,before);assert.equal(Object.keys(session).length,0);
  failSave=true;await assert.rejects(save(name),/SAVE_CANCELLED/);failSave=false;assert.equal(Object.keys(session).length,0);
  await assert.rejects(save(name,'cancelled'),/ZIP save cancelled/);assert.equal(next,before);assert.equal(Object.keys(session).length,0);
  assert.equal(revoked.length,5);
  console.log('PASS filename registration bypasses native start queue; preparation failure or cancellation starts no download and releases temporary mappings/URLs');
  assert.equal((await send({type:'REGISTER_ZIP_FILENAME',url:'https://example.test/file.zip',filename:name})).ok,false);
  assert.equal((await send({type:'REGISTER_ZIP_FILENAME',url,filename:'../bad.zip'})).ok,false);
  let called=false;events.message({type:'REGISTER_ZIP_FILENAME',url,filename:name},{id:'other',url:'https://example.test/'},()=>called=true);await tick();assert.equal(called,false);assert.equal(Object.keys(session).length,0);
  console.log('PASS filename registration is limited to extension-owned blob downloads and safe ZIP names');
})().catch(error=>{console.error(error);process.exitCode=1;});
