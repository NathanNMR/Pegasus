import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {chooseVoiceMime,fileExtensionForMime,formatRecordingDuration,VOICE_LIMIT_BYTES,VOICE_LIMIT_MS} from '../public/voice-recorder.js';

const project = path.resolve(import.meta.dirname,'..');
function launch(dir) {
  const child=spawn(process.execPath,['server.mjs'],{
    cwd:project,
    env:{...process.env,PORT:'0',HOST:'127.0.0.1',PEGASUS_DATA_DIR:dir,NODE_ENV:'test'},
    stdio:['ignore','pipe','pipe'],
  });
  return new Promise((resolve,reject)=>{
    let logs=''; const timer=setTimeout(()=>reject(new Error(logs)),12000);
    child.stdout.on('data',buf=>{
      logs+=String(buf);
      const found=logs.match(/PEGASUS_READY (http:\/\/[^\s]+)/);
      if(found){clearTimeout(timer);resolve({child,base:found[1]});}
    });
    child.stderr.on('data',buf=>logs+=String(buf));
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Servidor encerrou: '+code+' '+logs));});
  });
}
function client(base) {
  let cookie='';
  return async (route,method='GET',data)=>{
    const response=await fetch(base+route,{
      method,
      headers:{...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},
      body:data?JSON.stringify(data):undefined,
    });
    const setCookie=response.headers.get('set-cookie');
    if(setCookie)cookie=setCookie.split(';')[0];
    return {status:response.status, data:await response.json()};
  };
}

test('escolha de formato compatível para gravações de voz',()=>{
  assert.equal(chooseVoiceMime(v=>v==='audio/webm;codecs=opus'),'audio/webm;codecs=opus');
  assert.equal(chooseVoiceMime(v=>v==='audio/mp4'),'audio/mp4');
  assert.equal(chooseVoiceMime(()=>false),'');
  assert.equal(fileExtensionForMime('audio/webm;codecs=opus'),'webm');
  assert.equal(fileExtensionForMime('audio/mp4'),'m4a');
  assert.equal(fileExtensionForMime('audio/ogg;codecs=opus'),'ogg');
  assert.equal(fileExtensionForMime('audio/unsupported'),null);
  assert.equal(formatRecordingDuration(0),'00:00');
  assert.equal(formatRecordingDuration(62005),'01:02');
  assert.equal(VOICE_LIMIT_MS,120000);
  assert.equal(VOICE_LIMIT_BYTES,4000000);
});

test('mensagem de voz no mesmo histórico: autenticação, destinatário e segurança', {timeout:45000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'pegasus-voice-'));
  let server;
  try {
    server=await launch(dir);
    const a=client(server.base),b=client(server.base),stranger=client(server.base);
    assert.equal((await a('/api/register','POST',{name:'Ana',email:'ana@local.test',password:'senha-segura-123'})).status,200);
    assert.equal((await b('/api/register','POST',{name:'Beto',email:'beto@local.test',password:'senha-segura-456'})).status,200);
    await stranger('/api/register','POST',{name:'Carla',email:'carla@local.test',password:'senha-segura-789'});
    const conversation=(await a('/api/conversations','POST',{email:'beto@local.test'})).data.conversationId;
    const wav=Buffer.alloc(44);wav.write('RIFF',0);wav.write('WAVE',8);
    const dataUrl=`data:audio/wav;base64,${wav.toString('base64')}`;
    const sent=await a(`/api/conversations/${conversation}/messages`,'POST',{
      kind:'audio',file:{name:'voz-um.wav',dataUrl,voice:true},
    });
    assert.equal(sent.status,201);
    assert.equal(sent.data.message.file.voice,true);
    assert.equal(sent.data.message.preview,'Mensagem de voz');
    const received=await b(`/api/conversations/${conversation}/messages`);
    assert.equal(received.status,200);
    assert.equal(received.data.messages.length,1);
    assert.equal(received.data.messages[0].file.voice,true);
    assert.equal(received.data.messages[0].file.dataUrl,dataUrl);
    assert.equal((await b('/api/conversations')).data.conversations[0].lastMessage.preview,'Mensagem de voz');
    assert.equal((await stranger(`/api/conversations/${conversation}/messages`)).status,404);
    const invalid=await a(`/api/conversations/${conversation}/messages`,'POST',{
      kind:'audio',file:{name:'voz-invalida.webm',dataUrl,voice:true},
    });
    assert.equal(invalid.status,400);
    const voiceModule=await fetch(server.base+'/voice-recorder.js');
    assert.equal(voiceModule.status,200);
    assert.match(await voiceModule.text(),/MediaRecorder/);
    const page=await (await fetch(server.base)).text();
    for(const id of ['voiceButton','voiceStopButton','voiceDiscardButton']) assert.ok(page.includes(`id="${id}"`));
    assert.ok(!page.includes('voicePreview'));
    assert.ok(!page.includes('voiceSendButton'));
    assert.match(page,/Parar e enviar/);
  }finally{
    if(server?.child&&server.child.exitCode===null){server.child.kill('SIGTERM');await once(server.child,'exit');}
    await rm(dir,{recursive:true,force:true});
  }
});
