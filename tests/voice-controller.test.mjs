import test from 'node:test';
import assert from 'node:assert/strict';
import { setupVoiceRecorder } from '../public/voice-recorder.js';

class Element {
  hidden = false;
  disabled = false;
  src = '';
  textContent = '';
  listeners = new Map();
  attributes = new Map();
  classList = { toggle: () => {} };
  addEventListener(name,cb){this.listeners.set(name,cb);}
  setAttribute(name,value){this.attributes.set(name,value);}
  removeAttribute(name){this.attributes.delete(name);}
  pause() {}
  load() {}
  click(){return this.listeners.get('click')?.();}
}

class FakeRecorder {
  static isTypeSupported(value){return value==='audio/webm;codecs=opus';}
  constructor(stream,{mimeType}) {this.mimeType=mimeType;this.stream=stream;this.listeners=new Map();this.state='inactive';}
  addEventListener(name,cb){this.listeners.set(name,cb);}
  start() {this.state='recording';}
  stop() {
    this.state='inactive';
    const blob=new Blob([Buffer.from([0x1a,0x45,0xdf,0xa3,0x00,0x11,0x22,0x33])],{type:'audio/webm'});
    this.listeners.get('dataavailable')?.({data:blob});
    this.listeners.get('stop')?.();
  }
}

class FakeReader {
  result='';
  async readAsDataURL(blob){
    const bytes=Buffer.from(await blob.arrayBuffer());
    this.result=`data:${blob.type};base64,${bytes.toString('base64')}`;
    this.onload?.();
  }
}

test('fluxo completo de gravar > parar > pré-escutar > enviar e descartar (simulação do microfone)', async()=>{
  const original={document:globalThis.document,window:globalThis.window,navigator:globalThis.navigator,MediaRecorder:globalThis.MediaRecorder,FileReader:globalThis.FileReader};
  const ids=['voicePanel','voiceButton','voiceIndicator','voiceStatus','voiceTimer','voicePreview','voiceStopButton','voiceDiscardButton','voiceSendButton'];
  const elements=Object.fromEntries(ids.map(id=>[id,new Element()]));
  let microphoneStopped=0;
  const stream={getTracks:()=>[{stop:()=>{microphoneStopped++},addEventListener:()=>{}}],getAudioTracks:()=>[]};
  const sent=[];
  const errors=[];
  try {
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>stream}}});
    globalThis.document={getElementById:id=>elements[id]};
    globalThis.window={isSecureContext:true,MediaRecorder:FakeRecorder};
    globalThis.MediaRecorder=FakeRecorder;
    globalThis.FileReader=FakeReader;
    const voice=setupVoiceRecorder({
      getConversationId:()=>17,canStart:()=>true,
      onSend:async message=>{sent.push(message)},onError:message=>errors.push(message),
    });
    assert.equal(elements.voicePanel.hidden,true);
    await elements.voiceButton.click();
    assert.equal(elements.voicePanel.hidden,false);
    assert.equal(elements.voiceStopButton.hidden,false);
    assert.equal(elements.voiceIndicator.hidden,false);
    elements.voiceStopButton.click();
    assert.equal(elements.voiceSendButton.hidden,false);
    assert.equal(elements.voicePreview.hidden,false);
    assert.match(elements.voicePreview.src,/^blob:/);
    await elements.voiceSendButton.click();
    assert.equal(sent.length,1);
    assert.equal(sent[0].conversationId,17);
    assert.equal(sent[0].file.voice,true);
    assert.match(sent[0].file.name,/^voz-\d+\.webm$/);
    assert.match(sent[0].file.dataUrl,/^data:audio\/webm;base64,/);
    assert.equal(elements.voicePanel.hidden,true);
    await elements.voiceButton.click();
    elements.voiceDiscardButton.click();
    assert.equal(sent.length,1);
    assert.equal(elements.voicePanel.hidden,true);
    assert.equal(errors.length,0);
    assert.ok(microphoneStopped>=2);
    voice.cancel();
  } finally {
    for(const [name,value] of Object.entries(original)) {
      if(name==='navigator') Object.defineProperty(globalThis,name,{configurable:true,value});
      else globalThis[name]=value;
    }
  }
});
