const test=require('node:test');
const assert=require('node:assert/strict');
const host=require('./host.cjs');
const record={record_name:'home.example.test',record_type:'A',zone_id:'test-zone',source_node:['node'],ttl:1,proxied:false,api_token:'synthetic-test-token'};
async function setup(options={}){const h=host({directory:process.env.PLUGIN_TEST_DIRECTORY,config:{api_token:'synthetic-global-token',interval:5},...options});await h.load();h.setFile('records.json',[record]);return h;}
test('status lookup failure cannot trigger any Cloudflare request',async()=>{
 const h=await setup({statusError:true});const result=await h.request('POST','/cf-ddns/sync',undefined,true);
 assert.equal(result.data.ok,false);assert.equal(h.external.length,0);assert.deepEqual(h.getFile('records.json'),[record]);
});
test('offline, missing and malformed online states cannot update DNS',async()=>{
 for(const statuses of[{},{node:{online:false}},{node:{}},{node:{online:'true'}}]){
  const h=await setup({statuses});await h.request('POST','/cf-ddns/sync',undefined,true);assert.equal(h.external.length,0);
 }
});
test('confirmed online nodes still update existing IPv4 and IPv6 records',async()=>{
 for(const [type,expected]of[['A','203.0.113.17'],['AAAA','2001:db8::17']]){
  const h=await setup();h.setFile('records.json',[{...record,record_type:type}]);await h.request('POST','/cf-ddns/sync',undefined,true);
  const update=h.external.find(x=>x.method==='PUT');assert(update);assert.equal(JSON.parse(update.body).content,expected);
 }
});
test('all management routes deny anonymous callers and record tokens are masked',async()=>{
 const h=await setup();for(const key of h.routes.keys()){const i=key.indexOf(' ');assert.equal((await h.request(key.slice(0,i),key.slice(i+1),{})).status,401);}
 assert.equal(h.external.length,0);
 const result=await h.request('GET','/cf-ddns/records',undefined,true);assert.equal(result.data[0].api_token,'***SET***');assert.equal(h.getFile('records.json')[0].api_token,record.api_token);
});
