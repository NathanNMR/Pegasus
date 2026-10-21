import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { encodePegasus } from '../public/cipher.js';

async function serverFor(dir) {
  const child=spawn(process.execPath,['server.mjs'],{
    cwd:path.resolve(import.meta.dirname,'..'),
    env:{...process.env,PEGASUS_DATA_DIR:dir,NODE_ENV:'test',PORT:'0',HOST:'127.0.0.1'},
    stdio:['ignore','pipe','pipe'],
  });
  return new Promise((resolve,reject)=>{
    let logs='';
    const timer=setTimeout(()=>reject(new Error('Timeout '+logs)),12000);
    child.stdout.on('data',data=>{
      logs+=data.toString();
      const match=logs.match(/PEGASUS_READY (http:\/\/[^\s]+)/);
      if (match) {clearTimeout(timer);resolve({child,base:match[1]});}
    });
    child.stderr.on('data',data=>logs+=data.toString());
    child.on('exit',code=>{clearTimeout(timer);reject(new Error('Saiu '+code+' '+logs));});
  });
}
function client(base) {
  let cookie='';
  return async function req(url,method='GET',body) {
    const result=await fetch(base+url,{
      method,headers:{...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},
      ...(body!==undefined?{body:JSON.stringify(body)}:{}),
    });
    if (result.headers.get('set-cookie')) cookie=result.headers.get('set-cookie').split(';')[0];
    return {status:result.status,data:await result.json()};
  };
}
const tinyPng='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2m0n4AAAAASUVORK5CYII=';

test('perfil editável e privacidade restrita exigem aceitação para e-mail e código', {timeout:45000}, async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'pegasus-v4-'));
  let running;
  try {
    running=await serverFor(dir);
    const alice=client(running.base),bruno=client(running.base),carla=client(running.base), stranger=client(running.base);
    const aliceReg=await alice('/api/register','POST',{name:'Alice',email:'alice@teste.org',password:'12345678A!'});
    const brunoReg=await bruno('/api/register','POST',{name:'Bruno',email:'bruno@teste.org',password:'12345678B!'});
    await carla('/api/register','POST',{name:'Carla',email:'carla@teste.org',password:'12345678C!'});
    assert.equal(aliceReg.status,200);
    assert.equal(brunoReg.status,200);
    assert.match(aliceReg.data.user.friendCode,/^[A-Z0-9]{6}$/);
    assert.equal((await alice('/api/profile','PUT',{bio:'quero conversar',privacyMode:'approval',avatar:tinyPng})).status,200);
    const profile=(await alice('/api/me')).data.user;
    assert.equal(profile.bio,'quero conversar');
    assert.equal(profile.privacyMode,'approval');
    assert.ok(profile.avatar.startsWith('data:image/png'));
    assert.equal((await alice('/api/profile','PUT',{bio:'x'.repeat(241),privacyMode:'open'})).status,400);
    assert.equal((await stranger('/api/chat-requests')).status,401);

    const started=await bruno('/api/conversations','POST',{email:'alice@teste.org'});
    assert.equal(started.status,202);
    assert.equal(started.data.status,'pending');
    assert.equal((await bruno('/api/conversations')).data.conversations.length,0);
    assert.equal((await bruno('/api/conversations','POST',{friendCode:aliceReg.data.user.friendCode})).data.status,'pending');
    const aliceReqs=(await alice('/api/chat-requests')).data.incoming;
    assert.equal(aliceReqs.length,1);
    assert.equal(aliceReqs[0].name,'Bruno');
    assert.equal((await bruno('/api/chat-requests/'+aliceReqs[0].id+'/accept','POST',{})).status,404);

    const approved=await alice('/api/chat-requests/'+aliceReqs[0].id+'/accept','POST',{});
    assert.equal(approved.status,200);
    assert.ok(approved.data.conversationId>0);
    const conversationId=approved.data.conversationId;
    assert.equal((await bruno('/api/conversations')).data.conversations[0].partner.bio,'quero conversar');
    assert.equal((await bruno('/api/conversations/'+conversationId+'/messages','POST',{kind:'text',ciphertext:encodePegasus('oi!')})).status,201);

    const carlaRequest=await carla('/api/conversations','POST',{friendCode:aliceReg.data.user.friendCode});
    assert.equal(carlaRequest.status,202);
    const rejectId=(await alice('/api/chat-requests')).data.incoming[0].id;
    assert.equal((await alice('/api/chat-requests/'+rejectId+'/decline','POST',{})).status,200);
    assert.equal((await carla('/api/conversations','POST',{email:'alice@teste.org'})).status,403);
    assert.equal((await alice('/api/chat-requests')).data.incoming.length,0);

    // Alternar restrita -> aberta não invalida conversa aprovada, mas abre novas conversas.
    assert.equal((await alice('/api/profile','PUT',{bio:'nova bio',privacyMode:'open',avatar:''})).status,200);
    assert.equal((await bruno('/api/conversations','POST',{friendCode:aliceReg.data.user.friendCode})).data.conversationId,conversationId);
    assert.equal((await (await carla('/api/conversations','POST',{email:'bruno@teste.org'})).status),200);
    const openResult=await stranger('/api/register','POST',{name:'Daniel',email:'daniel@teste.org',password:'12345678D!'});
    assert.equal(openResult.status,200);
    const connection=await stranger('/api/conversations','POST',{email:'alice@teste.org'});
    assert.equal(connection.status,200);
    assert.ok(connection.data.conversationId>0);
    assert.equal((await stranger('/api/profile','PUT',{bio:'demo',privacyMode:'approval',avatar:'data:text/html;base64,PGh0bWw+'})).status,400);
  } finally {
    if(running?.child && running.child.exitCode===null){running.child.kill('SIGTERM');await once(running.child,'exit');}
    await rm(dir,{recursive:true,force:true});
  }
});
