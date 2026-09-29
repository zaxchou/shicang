// Review-only probes. Temporary fixtures, fake AI; no real network or source writes.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
for(const k of Object.keys(process.env)) if(/^(AI_|MIMO_)/.test(k)) delete process.env[k];
const imp=(p:string)=>import(pathToFileURL(path.join(process.cwd(),p)).href);
const {LibraryService}=await imp('server/services/library.ts');
const {createFixture}=await imp('tests/helpers/fixture.ts');
const fx=createFixture('myinfobase-review-0930-');
for(let i=0;i<4;i++)fx.writeNote({id:`review-${i}`,title:`zzqvx-${i}`,tags:[],images:0});
process.env.AI_CLASSIFY_API_KEY='fake-only';process.env.AI_CLASSIFY_BASE_URL='https://invalid.example/v1';process.env.AI_CLASSIFY_MAX_PER_REFRESH='2';
let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'invalid'}}]}));}) as typeof fetch;
const svc=new LibraryService({app:'review',vaultRoot:fx.root.replace(/\\/g,'/'),collections:[{id:'rednote',name:'test',root:'RedNote/Bookmarks',type:'rednote'}],groups:[],host:'127.0.0.1',port:0,timezone:'Asia/Shanghai',publicOrigin:'',extraAllowedOrigins:[],dataDir:fx.dataDir,backupDir:fx.backupDir,exportDir:fx.exportDir,exportAfterRefresh:false,autoRefreshOnBoot:true,logDir:path.join(fx.root,'logs'),isProduction:false,version:'review'});
await svc.init();const initial={calls,added:svc.libraryInfo().lastScan.added};
const job=svc.startBootRefresh();
while(svc.getRefreshJob(job.jobId).state==='running')await new Promise(r=>setTimeout(r,10));
const afterBoot={calls,added:svc.libraryInfo().lastScan.added};
assert.equal(initial.calls,2);assert.equal(afterBoot.calls,4);
console.log('BOOT='+JSON.stringify({maxPerScan:2,initial,afterBoot}));
// Execute the actual polling effect bodies in a minimal scheduler (not browser E2E).
const source=fs.readFileSync('src/App.tsx','utf8');
const section=source.slice(source.indexOf('  const bootPollsRef'),source.indexOf('  /**',source.indexOf('  const bootPollsRef')));
const effects=[...section.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)].map(m=>m[1]);assert.equal(effects.length,2);
let interval:(()=>void)|undefined;let cleanup:(()=>void)|undefined;let requests=0;let reloads=0;
const polls={current:0},prev={current:null};const library={indexStatus:'scanning'};
const win={setInterval:(fn:()=>void)=>{interval=fn;return 1;},clearInterval:()=>{interval=undefined;}};
const params=['library','libraryError','bootPollsRef','prevIndexStatusRef','window','loadLibrary','reload','loadTags'];
const fns=effects.map(s=>new Function(...params,s));
function render(){cleanup?.();const args=[library,null,polls,prev,win,()=>requests++,()=>reloads++,()=>{}];cleanup=fns[0](...args);fns[1](...args);}
render();for(let i=0;i<150;i++){assert.ok(interval);interval();render();}
// Server finishes now, but there is no next /library request to learn this.
assert.equal(interval,undefined);assert.equal(library.indexStatus,'scanning');assert.equal(reloads,0);
console.log('POLL='+JSON.stringify({requests,polls:polls.current,hasTimer:!!interval,uiStatus:library.indexStatus,reloads,refreshDisabled:library.indexStatus==='scanning'}));
console.log('Temporary fixture: '+fx.root);
