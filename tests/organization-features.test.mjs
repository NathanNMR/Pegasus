import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { encodePegasus, decodePegasus } from '../public/cipher.js';
const project=path.resolve(import.meta.dirname,'..');
function launch(dir){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['server.mjs'],{cwd:project,env:{...process.env,PORT:'0',HOST:'127.0.0.1',PEGASUS_DATA_DIR:dir,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});let logs='';const timer=setTimeout(()=>reject(new Error(logs||'Timeout')),12000);child.stdout.on('data',b=>{logs+=String(b);const m=logs.match(/PEGASUS_READY (http:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve({child,base:m[1]});}});child.stderr.on('data',b=>logs+=String(b));child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Servidor parou ${code}: ${logs}`));});});}
function client(base){let cookie='';return async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};}
test('busca, fixação, reações, arquivamento, expiração e confirmação de leitura', {timeout:50000}, async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pegasus-v09-features-'));let server;
 try{
  server=await launch(dir);const alice=client(server.base),bob=client(server.base);
  await alice('/api/register','POST',{name:'Alice',email:'alice@v09.test',password:'Alice-password-123'});
  await bob('/api/register','POST',{name:'Bob',email:'bob@v09.test',password:'Bob-password-123'});
  const conversationId=(await alice('/api/conversations','POST',{email:'bob@v09.test'})).data.conversationId;
  const sent=await alice(`/api/conversations/${conversationId}/messages`,'POST',{kind:'text',ciphertext:encodePegasus('O cometa azul chegou hoje')});
  assert.equal(sent.status,201);const messageId=sent.data.message.id;
  const search=await alice('/api/search?q=cometa');assert.equal(search.status,200);assert.equal(search.data.results.length,1);assert.equal(decodePegasus(search.data.results[0].message.ciphertext),'O cometa azul chegou hoje');
  assert.equal((await alice(`/api/conversations/${conversationId}/messages/${messageId}/pin`,'POST',{pinned:true})).status,200);
  const pins=await alice(`/api/conversations/${conversationId}/pins`);assert.equal(pins.data.messages.length,1);assert.equal(pins.data.messages[0].isPinned,true);
  assert.equal((await bob(`/api/conversations/${conversationId}/messages/${messageId}/reaction`,'POST',{emoji:'🔥'})).status,200);
  const inbox=await alice(`/api/conversations/${conversationId}/messages`);assert.equal(inbox.data.messages[0].reactions[0].emoji,'🔥');assert.equal(inbox.data.messages[0].reactions[0].count,1);
  await alice(`/api/conversations/${conversationId}/preferences`,'PUT',{archived:true});
  const convo=(await alice('/api/conversations')).data.conversations[0];assert.equal(convo.archived,true);
  await alice(`/api/conversations/${conversationId}/preferences`,'PUT',{archived:false,disappearingSeconds:3600});
  const ephemeral=await alice(`/api/conversations/${conversationId}/messages`,'POST',{kind:'text',ciphertext:encodePegasus('Esta mensagem terá prazo')});
  assert.ok(ephemeral.data.message.expiresAt);assert.ok(Date.parse(ephemeral.data.message.expiresAt)>Date.now());
  await bob(`/api/conversations/${conversationId}/messages`);
  const read=await alice(`/api/conversations/${conversationId}/messages`);assert.ok(read.data.messages.find(m=>m.id===messageId).readAt);
  assert.equal((await alice(`/api/conversations/${conversationId}/preferences`,'PUT',{disappearingSeconds:999})).status,400);
 } finally {if(server){server.child.kill('SIGTERM');await new Promise(r=>server.child.once('exit',r));}await rm(dir,{recursive:true,force:true});}
});
