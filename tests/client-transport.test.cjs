const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function clientApi(remote, connection) {
  let plugin;
  const source=fs.readFileSync(path.join(__dirname,'../src/client.js'),'utf8').replace("return { name: 'model-channel-manager', inject:", "return { makeLegacyApi, createNonce, inject:");
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:module=>{plugin=module.factory(()=>({}));}}},AbortSignal,Error,console});
  return plugin.makeLegacyApi(remote,connection);
}

test('提供商写入直接到llm-pi-ai，不会误写health；插件配置仅映射实例id',async()=>{
  const calls=[];
  const api=clientApi({settings:{mutate:async(...args)=>{calls.push(args);return {ok:true};},update:async(...args)=>{calls.push(args);return {ok:true};}}},{});
  const ops=[{op:'set',path:['providers','demo'],value:{}}];
  await api.settings.mutate({ns:'llm-pi-ai',ops,expectedRevision:5});
  await api.settings.update({ns:'model-channels',patch:{groups:[]},expectedRevision:6});
  assert.equal(calls[0][0],'llm-pi-ai');assert.equal(calls[0][1],ops);assert.equal(calls[0][2],5);
  assert.equal(calls[1][0],'model-channel-manager');assert.equal(calls[1][2],6);
});

test('状态传输使用Gateway公开信封并传播业务错误',async()=>{
  let call;
  const api=clientApi({}, {rpc:{call:async(...args)=>{call=args;return {ok:true,value:{total:4}};}}});
  assert.equal((await api.runtime('snapshot')).total,4);
  assert.equal(call[0],'/api');assert.equal(call[1],'modelChannels/invoke');assert.equal(call[2].args.method,'snapshot');
  const bad=clientApi({}, {rpc:{call:async()=>({ok:false,error:{code:'BUSY',message:'busy'}})}});
  await assert.rejects(bad.runtime('test'),{code:'BUSY'});
});
