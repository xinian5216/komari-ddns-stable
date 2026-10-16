const test=require('node:test');const assert=require('node:assert/strict');const host=require('./host.cjs');const path=require('node:path');
const record={record_name:'home.example.test',record_type:'A',zone_id:'test-zone',source_node:['node'],ttl:300,proxied:false};
async function setup(options={}){const h=host({config:{api_token:'synthetic-token',interval:5},...options});await h.load();h.setFile('records.json',[record]);return h;}
test('TTL-only changes update DNS and matching TTL does not',async()=>{
 for(const [actual,expected]of[[120,1],[300,0]]){
  const h=await setup({fetch:async()=>({json:async()=>({success:true,result:[{id:'record',content:'203.0.113.17',proxied:false,ttl:actual}]})})});
  await h.request('POST','/cf-ddns/sync',undefined,true);
  assert.equal(h.external.filter(x=>x.method==='PUT').length,expected);
  if(expected)assert.equal(JSON.parse(h.external.find(x=>x.method==='PUT').body).ttl,300);
 }
});
test('proxied records use Cloudflare automatic TTL without repeated updates',async()=>{
 const h=await setup({fetch:async()=>({json:async()=>({success:true,result:[{id:'record',content:'203.0.113.17',proxied:true,ttl:1}]})})});
 h.setFile('records.json',[{...record,proxied:true}]);await h.request('POST','/cf-ddns/sync',undefined,true);assert.equal(h.external.filter(x=>x.method==='PUT').length,0);
});
test('an interrupted record write leaves existing records intact',async()=>{
 const h=await setup({failRecordsWrite:true});let result;try{result=await h.request('PUT','/cf-ddns/records',[{...record,ttl:600}],true);}catch{}
 assert.deepEqual(h.getFile('records.json'),[record]);assert.equal(result.status,500);
});
test('failed atomic replacement leaves existing records intact',async()=>{
 const h=await setup({failRename:true});const result=await h.request('PUT','/cf-ddns/records',[{...record,ttl:600}],true);
 assert.equal(result.status,500);assert.deepEqual(h.getFile('records.json'),[record]);
});
test('successful record saves replace a temporary file and preserve masked token',async()=>{
 const h=await setup();h.setFile('records.json',[{...record,api_token:'synthetic-record-token'}]);
 const result=await h.request('PUT','/cf-ddns/records',[{...record,ttl:600,api_token:'***SET***'}],true);
 assert.equal(result.status,200);assert.equal(h.getFile('records.json')[0].api_token,'synthetic-record-token');
 assert(h.renames.some(([from,to])=>from===path.join(h.storage,'records.json.tmp')&&to===path.join(h.storage,'records.json')));
});
test('overlapping manual sync requests share one operation and release the lock',async()=>{
 let enter;const entered=new Promise(resolve=>{enter=resolve;});let finish;const gate=new Promise(resolve=>{finish=resolve;});let waits=true;
 const h=await setup({fetch:async(url,init)=>{if(!init.method&&waits){enter();await gate;}return {json:async()=>({success:true,result:init.method==='PUT'?{}:[{id:'record',content:'198.51.100.3',proxied:false,ttl:300}]})};}});
 const first=h.request('POST','/cf-ddns/sync',undefined,true);await entered;
 const second=h.request('POST','/cf-ddns/sync',undefined,true);await new Promise(resolve=>setImmediate(resolve));finish();
 const results=await Promise.all([first,second]);assert(results.every(r=>r.data.ok));assert.equal(h.external.length,2);
 waits=false;await h.request('POST','/cf-ddns/sync',undefined,true);assert.equal(h.external.length,4);
});
test('sync becomes available again after a Cloudflare failure',async()=>{
 let fail=true;const h=await setup({fetch:async()=>{if(fail){fail=false;throw Error('simulated network failure');}return {json:async()=>({success:true,result:[{id:'record',content:'203.0.113.17',proxied:false,ttl:300}]})};}});
 assert.equal((await h.request('POST','/cf-ddns/sync',undefined,true)).data.ok,false);
 assert.equal((await h.request('POST','/cf-ddns/sync',undefined,true)).data.ok,true);
});
