import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { encodePegasus, decodePegasus } from '../public/cipher.js';

const project=path.resolve(import.meta.dirname,'..');
function launch(dir){
  const child=spawn(process.execPath,['server.mjs'],{cwd:project,env:{...process.env,PORT:'0',HOST:'127.0.0.1',PEGASUS_DATA_DIR:dir,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    let logs='';const timer=setTimeout(()=>reject(new Error(logs||'Timeout')),12000);
    child.stdout.on('data',b=>{logs+=String(b);const m=logs.match(/PEGASUS_READY (http:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve({child,base:m[1]});}});
    child.stderr.on('data',b=>logs+=String(b));
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Servidor parou ${code}: ${logs}`));});
  });
}
function client(base){
  let cookie='';
  return async(route,method='GET',body)=>{
    const r=await fetch(base+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
    return {status:r.status,data:await r.json()};
  };
}
const sendText=(api,conversationId,value,replyToId)=>api(`/api/conversations/${conversationId}/messages`,'POST',{kind:'text',ciphertext:encodePegasus(value),...(replyToId?{replyToId}:{})});

test('respostas, favoritos, encaminhamento, apelidos, limpar/bloquear/excluir conversa', {timeout:50000}, async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'pegasus-messaging-features-'));
  let server;
  try{
    server=await launch(dir);
    const alice=client(server.base),bob=client(server.base),carol=client(server.base);
    const a=await alice('/api/register','POST',{name:'Alice',email:'alice@features.test',password:'Alice-password-123'});
    await bob('/api/register','POST',{name:'Bob',email:'bob@features.test',password:'Bob-password-123'});
    await carol('/api/register','POST',{name:'Carla',email:'carla@features.test',password:'Carla-password-123'});
    const ab=(await alice('/api/conversations','POST',{email:'bob@features.test'})).data.conversationId;
    const ac=(await alice('/api/conversations','POST',{email:'carla@features.test'})).data.conversationId;
    assert.ok(ab>0&&ac>0);

    const original=await sendText(alice,ab,'Mensagem original para responder');
    assert.equal(original.status,201);
    const reply=await sendText(bob,ab,'Resposta com referência',original.data.message.id);
    assert.equal(reply.status,201);
    const aliceInbox=await alice(`/api/conversations/${ab}/messages`);
    assert.equal(aliceInbox.data.messages[1].replyTo.id,original.data.message.id);
    assert.equal(aliceInbox.data.messages[1].replyTo.preview,'Mensagem original para responder');
    const invalidReply=await sendText(bob,ab,'Resposta inválida',999999);
    assert.equal(invalidReply.status,400);

    assert.equal((await bob(`/api/conversations/${ab}/messages/${original.data.message.id}/favorite`,'POST',{favorite:true})).status,200);
    const favorites=await bob('/api/favorites');
    assert.equal(favorites.status,200);
    assert.equal(favorites.data.favorites.length,1);
    assert.equal(favorites.data.favorites[0].message.isFavorite,true);
    assert.equal((await alice(`/api/conversations/${ab}/messages`)).data.messages[0].isFavorite,false);
    assert.equal((await bob(`/api/conversations/${ab}/messages/${original.data.message.id}/favorite`,'POST',{favorite:false})).status,200);
    assert.equal((await bob('/api/favorites')).data.favorites.length,0);

    const forward=await alice(`/api/conversations/${ab}/messages/${original.data.message.id}/forward`,'POST',{targetConversationId:ac});
    assert.equal(forward.status,201);
    const carolInbox=await carol(`/api/conversations/${ac}/messages`);
    assert.equal(carolInbox.data.messages.length,1);
    assert.equal(carolInbox.data.messages[0].forwarded,true);
    assert.equal(decodePegasus(carolInbox.data.messages[0].ciphertext),'Mensagem original para responder');
    assert.equal((await alice(`/api/conversations/${ab}/messages/${original.data.message.id}/forward`,'POST',{targetConversationId:ab})).status,400);

    assert.equal((await alice(`/api/conversations/${ab}/preferences`,'PUT',{alias:'Bobby',notificationsEnabled:false})).status,200);
    const conversations=(await alice('/api/conversations')).data.conversations;
    const renamed=conversations.find(c=>c.id===ab);
    assert.equal(renamed.partner.name,'Bobby');
    assert.equal(renamed.partner.realName,'Bob');
    assert.equal(renamed.notificationsEnabled,false);
    assert.equal(renamed.partner.email,'bob@features.test');
    assert.ok(renamed.partner.friendCode);
    assert.equal((await alice(`/api/conversations/${ab}/preferences`,'PUT',{alias:'x'.repeat(41),notificationsEnabled:true})).status,400);

    assert.equal((await alice(`/api/conversations/${ab}/clear`,'POST',{})).status,200);
    assert.equal((await alice(`/api/conversations/${ab}/messages`)).data.messages.length,0);
    assert.equal((await bob(`/api/conversations/${ab}/messages`)).data.messages.length,2);

    assert.equal((await alice(`/api/conversations/${ab}/block`,'POST',{})).status,200);
    assert.equal((await alice(`/api/conversations/${ab}/messages`,'POST',{ciphertext:encodePegasus('não pode enviar')})).status,403);
    assert.equal((await bob(`/api/conversations/${ab}/messages`,'POST',{ciphertext:encodePegasus('também não pode')})).status,403);
    const blockedList=(await bob('/api/conversations')).data.conversations.find(c=>c.id===ab);
    assert.equal(blockedList.blockedByPartner,true);
    assert.equal((await alice(`/api/conversations/${ab}/unblock`,'POST',{})).status,200);
    const unblockedMessage=await sendText(alice,ab,'Agora pode enviar');
    assert.equal(unblockedMessage.status,201);

    assert.equal((await alice(`/api/conversations/${ab}/contact`,'DELETE')).status,200);
    assert.ok(!(await alice('/api/conversations')).data.conversations.some(c=>c.id===ab));
    assert.ok((await bob('/api/conversations')).data.conversations.some(c=>c.id===ab));
    assert.equal((await alice('/api/conversations','POST',{email:'bob@features.test'})).data.conversationId,ab);
    assert.ok((await alice('/api/conversations')).data.conversations.some(c=>c.id===ab));

    const around=await alice(`/api/conversations/${ab}/messages?around=${unblockedMessage.data.message.id}`);
    assert.equal(around.status,200);
    assert.ok(around.data.messages.some(m=>m.id===unblockedMessage.data.message.id));
    const page=await (await fetch(server.base)).text();
    for(const id of ['selectionToolbar','contactDialog','forwardDialog','favoritesDialog','replyComposer','themeToggle']) assert.ok(page.includes(`id="${id}"`));
    const script=await (await fetch(server.base+'/app.js')).text();
    for(const feature of ['jumpToMessage','openForwardDialog','favoriteMessage','openContactDetails','applyTheme']) assert.ok(script.includes(feature));
    const recorder=await (await fetch(server.base+'/voice-recorder.js')).text();
    assert.ok(!recorder.includes('Pré-escutar'));
    assert.ok(!page.includes('voicePreview'));
  }finally{
    if(server?.child&&server.child.exitCode===null){server.child.kill('SIGTERM');await once(server.child,'exit');}
    await rm(dir,{recursive:true,force:true});
  }
});
