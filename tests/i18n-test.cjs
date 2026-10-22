const fs=require('node:fs'),assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'../canvas-module-files');
const {create}=require(root+'/i18n.js');
const registry=JSON.parse(fs.readFileSync(root+'/locales/languages.json','utf8'));
const base=JSON.parse(fs.readFileSync(root+'/locales/zh-CN.json','utf8'));
for(const name of ['app.js','app.html']){
  const source=fs.readFileSync(root+'/'+name,'utf8');
  const expressions=name.endsWith('.js')?source.matchAll(/\bt\(\s*(['"])(.*?)\1/g):source.matchAll(/data-i18n(?:-(?:placeholder|aria-label|title))?="([^"]+)"/g);
  for(const match of expressions){const key=name.endsWith('.js')?match[2]:match[1];assert(Object.hasOwn(base,key),'Missing locale key in '+name+': '+key);}
}
async function structuredDiagnostics(){
 const i=create({load:async file=>JSON.parse(fs.readFileSync(root+'/locales/'+file,'utf8'))});
 await i.init('en');assert.equal(i.message({code:'Retry failed only ({v0})',params:{v0:3}}),'Retry failed only (3)');assert.equal(i.message('网络响应超时，请稍后重试'),'Network response timed out. Try again later.');
 await i.init('zh-CN');assert.equal(i.message('Network response timed out. Try again later.'),'网络响应超时，请稍后重试');assert.equal(i.message({code:'Retry failed only ({v0})',params:{v0:2}}),'仅重试失败项（2）');
}
structuredDiagnostics().catch(e=>{console.error(e);process.exitCode=1;});
for(const language of registry){const pack=JSON.parse(fs.readFileSync(root+'/locales/'+language.file,'utf8'));assert.deepEqual(Object.keys(pack).sort(),Object.keys(base).sort());for(const[key,value]of Object.entries(pack)){const slots=s=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();assert.deepEqual(slots(value),slots(base[key]),language.code+': '+key);}}
(async()=>{const calls=[];const i=create({load:async file=>{calls.push(file);return JSON.parse(fs.readFileSync(root+'/locales/'+file,'utf8'));}});await i.init('en');assert.equal(i.t('Select {v0}',{v0:'<a>讲义.pdf</a>'}),'Select <a>讲义.pdf</a>');assert.equal(i.message('收集 4 / 9：notes.pdf'),'Collecting 4 / 9: notes.pdf');assert.equal(i.message('讲义.pdf'),'讲义.pdf');assert.equal(i.message('本版 ZIP 单包上限为 4 GB，请分批勾选'),'This ZIP format supports archives below 4 GB. Select files in smaller batches.');assert.equal(i.t('unknown key'),'unknown key');await i.init('zh-CN');await i.init('en');assert.equal(calls.filter(c=>c==='en.json').length,1);await i.init('missing');assert.equal(i.language,'zh-CN');assert.equal(i.t('Select {v0}',{v0:'notes.pdf'}),'选择 notes.pdf');console.log('PASS '+Object.keys(base).length+' bilingual entries: key parity, interpolation parity, diagnostics, preserved names, fallback and per-session locale loading');})().catch(e=>{console.error(e);process.exitCode=1;});
