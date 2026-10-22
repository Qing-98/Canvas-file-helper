const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {create}=require('../canvas-module-files/directory-downloader.js');
const root=path.resolve(__dirname,'../work');
class Directory {
  constructor(folder){this.folder=folder;this.name=path.basename(folder);}
  async getDirectoryHandle(name,{create=false}={}){const p=path.join(this.folder,name);if(create)await fs.mkdir(p,{recursive:true});return new Directory(p);}
  async getFileHandle(name,{create=false}={}){
    const p=path.join(this.folder,name);
    try{await fs.stat(p);}catch(e){if(!create){e.name='NotFoundError';throw e;}await fs.writeFile(p,'',{flag:'wx'});}
    return {createWritable:async()=>{
      const temp=p+'.writing-'+Math.random().toString(16).slice(2),h=await fs.open(temp,'wx');
      return {write:async value=>{await h.write(value);},close:async()=>{await h.close();await fs.rename(temp,p);},abort:async()=>{await h.close();await fs.unlink(temp);}};
    }};
  }
  async removeEntry(name){await fs.unlink(path.join(this.folder,name));}
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,label){const end=Date.now()+6000;while(!test()){if(Date.now()>end)throw new Error('Timeout: '+label);await sleep(10);}}
async function untilAsync(test,label){const end=Date.now()+6000;while(!await test()){if(Date.now()>end)throw new Error('Timeout: '+label);await sleep(10);}}
(async()=>{
  await fs.mkdir(root,{recursive:true});
  const folder=await fs.mkdtemp(path.join(root,'directory-download-test-')),directory=new Directory(folder),streams=new Map(),calls=[];
  const server=http.createServer((req,res)=>{
    calls.push(req.url);
    if(req.url.startsWith('/stream')||req.url.startsWith('/block')){res.writeHead(200,{'Content-Type':'text/plain','Content-Length':'15'});res.write('aaaaa');streams.set(req.url,res);}
    else if(req.url==='/login'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>Sign in</html>');}
    else {res.writeHead(200,{'Content-Type':'text/plain','Content-Length':'7'});res.end('newfile');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  let tick=0;const engine=create({onUpdate:()=>tick++});
  function job(id,endpoint=id,filename=`Canvas/Course/Week 1/Week 1 - Lectorial/文本/${id}.txt`){return {jobId:id,name:filename.split('/').at(-1),filename,url:base+'/'+endpoint,state:'queued',bytesReceived:0,expectedBytes:15};}
  try{
    const first=job('first','stream-first');engine.start(directory,[first]);
    await until(()=>first.bytesReceived===5,'first received chunk');
    engine.control('pause',first.jobId);streams.get('/stream-first').write('bbbbb');await sleep(40);assert.equal(first.state,'paused');assert.equal(first.bytesReceived,5);
    engine.control('resume',first.jobId);await until(()=>first.bytesReceived===10,'resume next chunk');streams.get('/stream-first').end('ccccc');await until(()=>first.state==='complete','complete');
    assert.equal(await fs.readFile(path.join(folder,first.filename),'utf8'),'aaaaabbbbbccccc');assert.equal(first.bytesReceived,15);assert.equal(first.pathVerified,true);
    const stopped=job('stop','stream-stop');engine.start(directory,[stopped]);await until(()=>stopped.bytesReceived===5,'stop first chunk');engine.control('stop',stopped.jobId);await untilAsync(async()=>{try{await fs.stat(path.join(folder,stopped.filename));return false;}catch(e){return e.code==='ENOENT';}},'partial file removed');
    assert.equal(stopped.state,'cancelled');await assert.rejects(fs.stat(path.join(folder,stopped.filename)),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(folder,first.filename),'utf8'),'aaaaabbbbbccccc');
    console.log('PASS actual nested-directory writes, stream byte progress, pause/resume, stop cleans partial file and preserves completed file');
    const duplicatePath='Canvas/Course/Week 1/Week 1 - Lectorial/文本/duplicate.txt';await fs.writeFile(path.join(folder,duplicatePath),'keep');
    const a=job('dup-a','static',duplicatePath),b=job('dup-b','static',duplicatePath);engine.start(directory,[a,b]);await until(()=>a.state==='complete'&&b.state==='complete','collision completion');
    assert.equal(await fs.readFile(path.join(folder,duplicatePath),'utf8'),'keep');assert.notEqual(a.actualFilename,b.actualFilename);assert.deepEqual([a.actualFilename.split('/').at(-1),b.actualFilename.split('/').at(-1)].sort(),['duplicate (1).txt','duplicate (2).txt']);
    const login=job('notes','login','Canvas/Course/notes.pdf');engine.start(directory,[login]);await until(()=>login.state==='interrupted','HTML login rejected');assert(login.error.includes('网页'));
    console.log('PASS existing files retained, parallel collision suffixes, HTML login page rejected before creating a PDF');
    const queued=Array.from({length:5},(_,i)=>job('q'+i,'block'+i));engine.start(directory,queued);await until(()=>calls.filter(s=>s.startsWith('/block')).length===3,'three initial workers');
    engine.control('pause');assert(queued.every(j=>j.state==='paused'));
    engine.control('stop');await sleep(40);assert(queued.every(j=>j.state==='cancelled'));assert.equal(calls.filter(s=>s.startsWith('/block')).length,3);assert(tick>0);
    console.log('PASS 3-worker limit, pause includes queued work, stop never starts remaining jobs');
    console.log('Filesystem evidence: '+folder);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
