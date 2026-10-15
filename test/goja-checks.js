async function __runMaintainedPluginChecks(){
 await load();
 const fs=require('fs'),path=require('path');
 const record={record_name:'home.example.test',record_type:'A',zone_id:'test-zone',source_node:['node'],ttl:1,proxied:false};
 fs.writeFileSync(path.join(__storageDir__,'records.json'),JSON.stringify([record]));
 __assert((await __request('POST','/cf-ddns/sync',{},false)).status===401,'Anonymous DNS update accepted');
 __testStatus=null;
 const failure=await __request('POST','/cf-ddns/sync',{},true);
 __assert(failure.data.ok===false&&__externalCalls===0,'Status failure changed DNS');
 __testStatus=false;
 await __request('POST','/cf-ddns/sync',{},true);
 __assert(__externalCalls===0,'Missing status changed DNS');
 __testStatus=true;
 const success=await __request('POST','/cf-ddns/sync',{},true);
 __assert(success.data.ok===true&&__externalCalls===2,'Confirmed online node no longer updates DNS');
 return true;
}
