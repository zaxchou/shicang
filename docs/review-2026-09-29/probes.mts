// Review probes: temporary fixtures, fake AI, loopback-only transport.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
for(const k of Object.keys(process.env)) if(/^(AI_|MIMO_)/.test(k)) delete process.env[k];
const imp=(p:string)=>import(pathToFileURL(path.join(process.cwd(),p)).href);
const {LibraryService}=await imp('server/services/library.ts');
const {WebCoverService}=await imp('server/services/web-cover.ts');
const {createFixture}=await imp('tests/helpers/fixture.ts');
const realFetch=globalThis.fetch;
const blocked=(async()=>{throw new Error('Unexpected network');}) as typeof fetch;
globalThis.fetch=blocked;
const cfg=(fx:any,collections=[{id:'rednote',name:'test',root:'RedNote/Bookmarks',type:'rednote'}])=>({app:'review',vaultRoot:fx.root.replace(/\\/g,'/'),collections,groups:[],host:'127.0.0.1',port:0,timezone:'Asia/Shanghai',publicOrigin:'',extraAllowedOrigins:[],dataDir:fx.dataDir,backupDir:fx.backupDir,exportDir:fx.exportDir,exportAfterRefresh:false,logDir:path.join(fx.root,'logs'),isProduction:false,version:'review'});
const result:any={};
{
 const fx=createFixture('myinfobase-review-budget');
 for(let i=0;i<5;i++) fx.writeNote({id:`review-${i}`,title:`zzqvx-${i}`,tags:[],images:0});
 process.env.AI_CLASSIFY_API_KEY='fake-review-only';process.env.AI_CLASSIFY_BASE_URL='https://invalid.example/v1';process.env.AI_CLASSIFY_MAX_PER_REFRESH='2';
 let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'not a category'}}]}),{headers:{'Content-Type':'application/json'}});}) as typeof fetch;
 const svc=new LibraryService(cfg(fx));await svc.init();
 result.aiBudget={configured:2,requests:calls,unclassified:svc.libraryInfo().uncategorized};
 for(const k of Object.keys(process.env))if(/^(AI_|MIMO_)/.test(k))delete process.env[k];globalThis.fetch=blocked;
}
{
 const fx=createFixture('myinfobase-review-rename');fx.writeNote({id:'stable-note-1',title:'Old title',fileName:'old.md',images:0});
 const svc=new LibraryService(cfg(fx));await svc.init();
 fs.renameSync(path.join(fx.sourceRoot,'Bookmarks','old.md'),path.join(fx.sourceRoot,'Bookmarks','new.md'));
 const job=svc.startRefresh();let done;for(let i=0;i<200;i++){done=svc.getRefreshJob(job.jobId);if(done.state!=='running')break;await new Promise(r=>setTimeout(r,20));}
 const rows=JSON.parse(fs.readFileSync(path.join(fx.dataDir,'library-index.json'),'utf8')).notes;
 result.rename={job:done.state,records:rows.map((n:any)=>({id:n.id,path:n.sourceRelativePath,status:n.sourceStatus})),detailPath:svc.detail('stable-note-1').sourceRelativePath,detailStatus:svc.detail('stable-note-1').sourceStatus};
}
{
 const fx=createFixture('myinfobase-review-coverttl');fs.mkdirSync(path.join(fx.root,'Clippings'));
 fs.writeFileSync(path.join(fx.root,'Clippings','n.md'),'---\nsource: https://example.com/n\ntitle: zzqvx\n---\nBody\n');
 const id='Clippings/n.md';fs.writeFileSync(path.join(fx.dataDir,'web-covers.json'),JSON.stringify({schemaVersion:1,revision:1,entries:{[id]:{noteId:id,file:'missing.jpg',contentType:'image/jpeg',durationSec:null,source:'first-image',at:'2020-01-01T00:00:00Z',failedAt:'2020-01-01T00:00:00Z'}}}));
 const svc=new LibraryService(cfg(fx,[{id:'web',name:'web',root:'Clippings',type:'web'}]));await svc.init();
 const n=svc.query({collection:'web',timeField:'published',range:'all',order:'desc',offset:0,limit:10}).items[0];result.coverTTL={failedAt:'2020-01-01',webCover:n.webCover,needProbe:!n.cover&&n.webCover===undefined};
}
{
 let privateHits=0;const server=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:`http://127.0.0.1:${(server.address() as any).port}/private`});res.end();}else{privateHits++;res.writeHead(200,{'Content-Type':'image/png'});res.end(Buffer.from('private-target-test'));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 const fx=createFixture('myinfobase-review-redirect');const svc=new WebCoverService(fx.dataDir,fx.backupDir);await svc.init();let redirectOption:any;
 const adapter=(async(input:any,init:any)=>{if(String(input)!=='https://public.example/image')throw new Error('Unexpected initial URL');redirectOption=init?.redirect??'follow (default)';return realFetch(`http://127.0.0.1:${port}/redirect`,init);}) as typeof fetch;
 const got=await svc.ensure({id:'review-redirect',originalUrl:'',bodyHtml:'<img src="https://public.example/image">'} as any,adapter);
 result.redirect={privateHits,redirectOption,cached:!!got};await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));
}
globalThis.fetch=realFetch;
console.log('REVIEW_RESULTS='+JSON.stringify(result,null,2));