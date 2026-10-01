/** Isolated visual harness: real runtime RPC, React, and the shipped client module. */
const fs=require('node:fs'),path=require('node:path');
const {fixture}=require('../helpers/profile.cjs');
const {build}=require('esbuild');
(async()=>{
 const now=Date.now();
 const events=[
  {ts:now-60000,provider:'fixture',model:'deepseek-v4.1',ok:true,ttftMs:1450,latencyMs:8420,inputTokens:18200,outputTokens:960,cacheReadTokens:42000},
  {ts:now-90000,provider:'fixture',model:'deepseek-v4.1',ok:true,ttftMs:1080,latencyMs:7210,inputTokens:14200,outputTokens:650,cacheReadTokens:33000},
  {ts:now-120000,provider:'backup',model:'claude-sonnet',ok:false,ttftMs:null,latencyMs:6000,code:'RATE_LIMIT',inputTokens:5200},
  {ts:now-3600000,provider:'backup',model:'claude-sonnet',ok:true,ttftMs:920,latencyMs:4950,inputTokens:8800,outputTokens:420},
 ];
 const f=await fixture({health:{records:{fixture:events}}});
 await f.rpc('snapshot');
 const domPath=require.resolve('react-dom/client');
 const reactPath=require.resolve('react',{paths:[path.dirname(domPath)]});
 const runtime=await build({stdin:{contents:`import React from ${JSON.stringify(reactPath)};import {createRoot} from ${JSON.stringify(domPath)};window.React=React;window.mount=c=>createRoot(document.getElementById('root')).render(c);`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser'});
 const providers={fixture:{baseURL:'https://example.test/v1',models:[{id:'deepseek-v4.1',name:'DeepSeek v4.1',input:['text'],contextWindow:128000,maxTokens:8192},{id:'unused-model',name:'尚未调用',input:['text']}]},backup:{models:[{id:'claude-sonnet',input:['text']}]}};
 const client=fs.readFileSync(path.resolve('src/client.js'),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>模型渠道管理 · 验证环境</title>
 <style>:root{--dsw-alias-label-primary:#263445;--dsw-alias-label-secondary:#5b6879;--dsw-alias-label-tertiary:#7a8796;--dsw-alias-label-dimmed:#8893a3;--dsw-alias-bg-base:#f7f8fa;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f3f5f8;--dsw-alias-border-l1:#e5e8ee;--dsw-alias-border-l2:#dce1e8;--dsw-alias-border-l3:#c9d0dc;--dsw-alias-brand-primary:#4d6bfe;--dsw-alias-button-primary-fill:#4d6bfe;--dsw-alias-button-primary-hover:#405be6;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-state-success-primary:#139e80;--dsw-alias-state-error-primary:#d34b52;--dsw-alias-state-warn-primary:#ce9231;--dsw-alias-interactive-bg-hover:#eef2f7;--ds-font-family-code:ui-monospace,monospace}*{box-sizing:border-box}body{margin:0;font-family:'Noto Sans CJK SC',sans-serif}#root{height:100vh}body.dark{--dsw-alias-label-primary:#e5eaf2;--dsw-alias-label-secondary:#b0bccd;--dsw-alias-label-tertiary:#8390a3;--dsw-alias-bg-base:#141820;--dsw-alias-bg-layer-1:#1d2430;--dsw-alias-bg-layer-2:#222c3a;--dsw-alias-border-l1:#303b4b;--dsw-alias-border-l2:#3e4b5f;--dsw-alias-interactive-bg-hover:#283346}</style><div id="root"></div>
 <script>${runtime.outputFiles[0].text}</script>
 <script>
 window.testState={configReads:0,writes:[],rpcCalls:[],providers:${JSON.stringify(providers)},groups:[],revision:1,failHealth:false};
 const state=window.testState;
 const remote={settings:{describe:async()=>{state.configReads++;return {ok:true,value:{namespaces:[{ns:'llm-pi-ai',revision:state.revision,value:{providers:state.providers},user:{providers:state.providers}},{ns:'model-channel-manager',revision:state.revision,value:{groups:state.groups,providerOrder:Object.keys(state.providers)}}]}}},mutate:async(...args)=>{state.writes.push(args);return {ok:true}},update:async(...args)=>{state.writes.push(args);return {ok:true}}},credentials:{describe:async()=>({ok:true,value:{}}),set:async()=>({ok:true})},llm:{discoverModels:async()=>({ok:true,value:[]})}};
 const connection={rpc:{call:async(channel,endpoint,payload,signal)=>{state.rpcCalls.push(payload.args.method);if(state.failHealth&&payload.args.method==='snapshot')throw Error('模拟断线');const r=await fetch(channel+'/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},signal,body:JSON.stringify({type:'client-request',rpcId:'browser',method:endpoint,payload})});if(!r.ok)throw Error('HTTP '+r.status);return (await r.json()).result}}};
 window.__ModuleLoader__={load(module){const p=module.factory(name=>{if(name==='react')return React;throw Error(name)});const effects=[];const slots={inject:(name,fn)=>fn(),register:(meta,view)=>window.mount(view({}))};const ctx={remote,connection,inject:(deps,fn)=>fn({...ctx,effect:ctx.effect}),effect:fn=>{const d=fn();effects.push(d);return d},get:key=>key==='slots'?slots:undefined};p.apply(ctx);}};
 </script><script>${client}</script></html>`;
 f.ctx.get('webServer').register({path:'/',kind:'prefix',handler:(req,res)=>{if(!f.ctx.connection.authorizeIndex(req,res))return;res.writeHead(200,{'content-type':'text/html'});res.end(html);}});
 const url=f.ctx.connection.authenticatedUrl(f.origin+'/');
 fs.writeFileSync(process.env.MCM_PREVIEW_FILE || '/tmp/mcm-preview-url',url,{mode:0o600});
 console.log('Preview ready');
 const stop=async()=>{await f.close();process.exit(0)};process.on('SIGINT',stop);process.on('SIGTERM',stop);
})().catch(e=>{console.error(e);process.exit(1)});
