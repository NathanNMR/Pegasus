import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { encodePegasus } from '../public/cipher.js';

test('logo nova, ausência de PG1 visível e exclusão local de mensagem recebida', {timeout: 40000}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(),'pegasus-context-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve(import.meta.dirname,'..'),
    env: {...process.env, PORT:'0',HOST:'127.0.0.1',PEGASUS_DATA_DIR:dataDir, NODE_ENV:'test'},
    stdio: ['ignore','pipe','pipe'],
  });
  try {
    const base = await new Promise((resolve,reject) => {
      let log = '';
      const timeout = setTimeout(() => reject(new Error(log || 'Timeout')), 10000);
      child.stdout.on('data', chunk => {
        log += chunk.toString();
        const match=log.match(/PEGASUS_READY (http:\/\/[^\s]+)/);
        if (match) {clearTimeout(timeout);resolve(match[1]);}
      });
      child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Exit ' + code + log));});
    });
    const landing = await (await fetch(base)).text();
    assert.ok(landing.includes('/pegasus-logo.png'));
    assert.ok(landing.includes('id="messageContextMenu"'));
    assert.ok(!landing.includes('BETA · 04'));
    assert.ok(!landing.includes('Ver código PG1'));
    const logo = await fetch(base+'/pegasus-logo.png');
    assert.equal(logo.status,200);
    assert.match(logo.headers.get('content-type'),/image\/png/);
    const script = await (await fetch(base+'/app.js')).text();
    assert.ok(script.includes('contextmenu'));
    assert.ok(!script.includes('Ver código PG1'));
    assert.ok(!script.includes('message-options-panel'));
    const users = [];
    for (const [name,email] of [['Alice','alice@sample.test'],['Bruno','bruno@sample.test']]) {
      const response=await fetch(base+'/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,email,password:'B3tterPassword!123'})});
      assert.equal(response.status,200);
      users.push(response.headers.get('set-cookie').split(';')[0]);
    }
    const send = async (cookie,url,method,body) => {
      const r=await fetch(base+url,{method,headers:{Cookie:cookie,...(body ? {'Content-Type':'application/json'} : {})},body:body?JSON.stringify(body):undefined});
      return {status:r.status,body:await r.json()};
    };
    const newConvo=await send(users[0],'/api/conversations','POST',{email:'bruno@sample.test'});
    assert.equal(newConvo.status,200);
    const id=newConvo.body.conversationId;
    const posted=await send(users[0],`/api/conversations/${id}/messages`,'POST',{ciphertext:encodePegasus('Mensagem que só Bruno vai ocultar!')});
    assert.equal(posted.status,201);
    const mid=posted.body.message.id;
    const before=await send(users[1],`/api/conversations/${id}/messages`,'GET');
    assert.equal(before.body.messages.length,1);
    const hidden=await send(users[1],`/api/conversations/${id}/messages/${mid}/hide`,'POST',{});
    assert.equal(hidden.status,200);
    const after=await send(users[1],`/api/conversations/${id}/messages`,'GET');
    assert.equal(after.body.messages.length,0);
    const sender=await send(users[0],`/api/conversations/${id}/messages`,'GET');
    assert.equal(sender.body.messages.length,1);
    const inbox=await send(users[1],'/api/conversations','GET');
    assert.equal(inbox.body.conversations[0].lastMessage,null);
    const unauthed=await send('',`/api/conversations/${id}/messages/${mid}/hide`,'POST',{});
    assert.equal(unauthed.status,401);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve=>{if (child.exitCode !== null) resolve(); else child.once('exit',resolve);});
    await rm(dataDir,{recursive:true,force:true});
  }
});
