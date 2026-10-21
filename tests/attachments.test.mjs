import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const project=path.resolve(import.meta.dirname,'..');
function launch(dataDir) {
  const child=spawn(process.execPath,['server.mjs'],{
    cwd:project,env:{...process.env,PORT:'0',HOST:'127.0.0.1',PEGASUS_DATA_DIR:dataDir,NODE_ENV:'test'},
    stdio:['ignore','pipe','pipe'],
  });
  return new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error(output)),12000);
    child.stdout.on('data',buffer=>{
      output+=String(buffer);
      const match=/PEGASUS_READY (http:\/\/\S+)/.exec(output);
      if(match){clearTimeout(timer);resolve({child,base:match[1]});}
    });
    child.stderr.on('data',buffer=>output+=String(buffer));
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Servidor parou ${code} ${output}`));});
  });
}
function client(base) {
  let cookie='';
  return async (route,method='GET',body)=>{
    const resp=await fetch(base+route,{
      method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined,
    });
    if(resp.headers.get('set-cookie'))cookie=resp.headers.get('set-cookie').split(';')[0];
    return {status:resp.status,data:await resp.json()};
  };
}
const encoded=(mime,bytes)=>`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

test('áudio, documento e compartilhamento de contato com restrições e histórico', {timeout:45000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'pegasus-attach-'));
  let server;
  try {
    server=await launch(dir);
    const alice=client(server.base),bob=client(server.base),carla=client(server.base),outsider=client(server.base);
    const a=await alice('/api/register','POST',{name:'Alice',email:'alice@exemplo.test',password:'Alice-super-secret-123'});
    await bob('/api/register','POST',{name:'Bob',email:'bob@exemplo.test',password:'Bob-super-secret-123'});
    const c=await carla('/api/register','POST',{name:'Carla',email:'carla@exemplo.test',password:'Carla-super-secret-123'});
    const outsiderReg=await outsider('/api/register','POST',{name:'Davi',email:'davi@exemplo.test',password:'Davi-super-secret-123'});
    assert.equal(a.status,200);
    assert.equal(outsiderReg.status,200);
    const ab=(await alice('/api/conversations','POST',{email:'bob@exemplo.test'})).data.conversationId;
    const ac=(await alice('/api/conversations','POST',{email:'carla@exemplo.test'})).data.conversationId;
    assert.ok(ab>0&&ac>0);
    const sampleWav=Buffer.alloc(44);sampleWav.write('RIFF',0);sampleWav.write('WAVE',8);
    const wav=encoded('audio/wav',sampleWav);
    const pdf=encoded('application/pdf','%PDF-1.4\n1 0 obj\nendobj\n%%EOF\n');
    const s1=await alice(`/api/conversations/${ab}/messages`,'POST',{kind:'audio',file:{name:'som.wav',dataUrl:wav}});
    assert.equal(s1.status,201);
    assert.equal(s1.data.message.kind,'audio');
    const s2=await alice(`/api/conversations/${ab}/messages`,'POST',{kind:'document',file:{name:'material.pdf',dataUrl:pdf}});
    assert.equal(s2.status,201);
    assert.equal(s2.data.message.kind,'document');
    const s3=await alice(`/api/conversations/${ab}/messages`,'POST',{kind:'contact',contactId:c.data.user.id});
    assert.equal(s3.status,201);
    assert.equal(s3.data.message.contact.friendCode,c.data.user.friendCode);
    assert.ok(!('email' in s3.data.message.contact));
    assert.equal((await alice(`/api/conversations/${ab}/messages`,'POST',{kind:'contact',contactId:outsiderReg.data.user.id})).status,403);
    assert.equal((await outsider(`/api/conversations/${ab}/messages`,'POST',{kind:'audio',file:{name:'som.wav',dataUrl:wav}})).status,404);
    assert.equal((await alice(`/api/conversations/${ab}/messages`,'POST',{kind:'audio',file:{name:'som.mp3',dataUrl:wav}})).status,400);
    assert.equal((await alice(`/api/conversations/${ab}/messages`,'POST',{kind:'document',file:{name:'arquivo.html',dataUrl:encoded('text/html','<script>hi</script>')}})).status,400);
    const inbox=await bob(`/api/conversations/${ab}/messages`);
    assert.deepEqual(inbox.data.messages.map(m=>m.kind),['audio','document','contact']);
    assert.match(inbox.data.messages[0].file.dataUrl,/^data:audio\/wav;base64,/);
    assert.equal(inbox.data.messages[1].file.name,'material.pdf');
    assert.equal(inbox.data.messages[2].contact.friendCode,c.data.user.friendCode);
    const page=await (await fetch(server.base)).text();
    assert.ok(page.includes('id="attachmentMenu"'));
    assert.ok(page.includes('Contato de alguém'));
    assert.ok(!page.includes('Imagens até 2,5 MB'));
    const svg=await (await fetch(server.base+'/pegasus-constellation.svg')).text();
    assert.ok(!svg.includes('<text'));
    const favicon=await (await fetch(server.base+'/favicon.png')).arrayBuffer();
    assert.ok(favicon.byteLength>1000);
    const apiHealth=await fetch(server.base+'/api/health');
    assert.equal(apiHealth.status,200);
  } finally {
    if(server?.child&&server.child.exitCode===null){server.child.kill('SIGTERM');await once(server.child,'exit');}
    await rm(dir,{recursive:true,force:true});
  }
});
