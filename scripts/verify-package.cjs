/** Boot the exact packed host entry with real runtime RPC and isolated storage. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcm-packed-'));
 try{
  execFileSync('tar',['-xzf',path.resolve('dist/arcaneorion-dsh-model-channel-manager-0.4.0.tgz'),'-C',dir]);
  fs.symlinkSync(path.resolve('node_modules'),path.join(dir,'node_modules'),'dir');
  const f=await require('../tests/helpers/profile.cjs').fixture({pluginPath:path.join(dir,'package/src/index.js')});
  try{
   const before=f.readPatch();
   assert.equal((await f.rpc('snapshot')).value.storage.mode,'persistent');
   await f.rpc('test',{nonce:'packed',provider:'fixture',model:'model'});
   assert.equal((await f.settled('packed')).text,'测试成功');
   assert.equal(f.readPatch(),before);
   assert.ok(fs.readFileSync(path.join(dir,'package/src/client.js'),'utf8').includes('modelChannels/invoke'));
   console.log('Packed 0.4.0: boot, Gateway, model task, persistence and unchanged config passed');
  }finally{await f.close()}
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
