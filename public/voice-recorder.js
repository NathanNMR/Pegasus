/** Gravação local de mensagens de voz com o MediaRecorder do navegador. */
export const VOICE_LIMIT_MS = 120_000;
export const VOICE_LIMIT_BYTES = 4_000_000;

const RECORDING_MIMES = [
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/ogg',
];

export function chooseVoiceMime(isSupported) {
  return RECORDING_MIMES.find(value => isSupported(value)) || '';
}
export function fileExtensionForMime(mime) {
  const plain = String(mime).split(';')[0].trim().toLowerCase();
  if (plain === 'audio/webm') return 'webm';
  if (plain === 'audio/mp4') return 'm4a';
  if (plain === 'audio/ogg') return 'ogg';
  return null;
}
export function formatRecordingDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function setupVoiceRecorder({ getConversationId, canStart, onSend, onError }) {
  const pick = id => document.getElementById(id);
  const panel = pick('voicePanel');
  const trigger = pick('voiceButton');
  const indicator = pick('voiceIndicator');
  const label = pick('voiceStatus');
  const duration = pick('voiceTimer');
  const player = pick('voicePreview');
  const stopButton = pick('voiceStopButton');
  const cancelButton = pick('voiceDiscardButton');
  const sendButton = pick('voiceSendButton');

  let recorder = null;
  let stream = null;
  let timer = null;
  let recorded = null;
  let previewUrl = '';
  let recordingConversationId = null;
  let startTime = 0;
  let operation = 0;
  let pending = false;
  let sending = false;
  let canceling = false;
  let tooLarge = false;
  let chunks = [];
  let chunkBytes = 0;

  function stopStream() {
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  function clearPreview() {
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    recorded = null;
  }
  function showState(mode) {
    panel.hidden = mode === 'idle';
    trigger.classList.toggle('is-recording', mode === 'recording');
    trigger.disabled = pending || sending || mode === 'recording';
    trigger.setAttribute('aria-pressed', String(mode === 'recording'));
    indicator.hidden = mode !== 'recording';
    stopButton.hidden = mode !== 'recording';
    player.hidden = mode !== 'preview';
    sendButton.hidden = mode !== 'preview';
    cancelButton.disabled = sending;
    sendButton.disabled = sending;
    label.textContent = mode === 'recording' ? 'Gravando mensagem de voz' : mode === 'preview' ? 'Ouça antes de enviar' : '';
  }
  function cancel() {
    operation++;
    canceling = true;
    stopTimer();
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* dispositivo encerrado */ }
    }
    recorder = null;
    stopStream();
    clearPreview();
    chunks = [];
    chunkBytes = 0;
    pending = false;
    sending = false;
    tooLarge = false;
    recordingConversationId = null;
    showState('idle');
  }
  function finishRecording() {
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
    stopTimer();
    stopButton.disabled = true;
    label.textContent = 'Finalizando gravação...';
  }
  async function start() {
    if (pending || sending || (recorder && recorder.state !== 'inactive')) return;
    if (!getConversationId()) return onError('Abra uma conversa antes de gravar.');
    if (!canStart()) return onError('Envie ou remova o anexo já preparado antes de gravar.');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return onError('Para gravar, use um navegador compatível em HTTPS ou localhost.');
    }
    const mime = chooseVoiceMime(value => MediaRecorder.isTypeSupported(value));
    if (!mime) return onError('O navegador não suporta gravação de áudio WEBM, M4A ou OGG.');

    cancel();
    canceling = false;
    const myOperation = ++operation;
    recordingConversationId = getConversationId();
    pending = true;
    panel.hidden = false;
    trigger.disabled = true;
    label.textContent = 'Solicitando acesso ao microfone...';
    duration.textContent = '00:00';
    indicator.hidden = true;
    stopButton.hidden = true;
    player.hidden = true;
    sendButton.hidden = true;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
      if (myOperation !== operation || getConversationId() !== recordingConversationId) {
        media.getTracks().forEach(track => track.stop());
        return;
      }
      stream = media;
      recorder = new MediaRecorder(media, { mimeType: mime, audioBitsPerSecond: 64000 });
      chunks = [];
      chunkBytes = 0;
      tooLarge = false;
      const activeRecorder = recorder;
      activeRecorder.addEventListener('dataavailable', event => {
        if (myOperation !== operation || !event.data?.size) return;
        chunks.push(event.data);
        chunkBytes += event.data.size;
        if (chunkBytes > VOICE_LIMIT_BYTES) {
          tooLarge = true;
          finishRecording();
        }
      });
      activeRecorder.addEventListener('error', () => {
        if (myOperation === operation) {
          cancel();
          onError('Ocorreu um erro ao gravar áudio.');
        }
      });
      activeRecorder.addEventListener('stop', () => {
        if (myOperation !== operation || canceling) return;
        stopStream();
        stopTimer();
        const rawMime = activeRecorder.mimeType || mime;
        const outputMime = rawMime.split(';')[0].toLowerCase();
        const extension = fileExtensionForMime(outputMime);
        const blob = new Blob(chunks, {type: outputMime});
        recorder = null;
        chunks = [];
        chunkBytes = 0;
        if (!extension || !blob.size || blob.size > VOICE_LIMIT_BYTES || tooLarge) {
          cancel();
          return onError('Áudio inválido ou maior que 4 MB. Grave uma mensagem mais curta.');
        }
        recorded = {blob, mime: outputMime, extension};
        previewUrl = URL.createObjectURL(blob);
        player.src = previewUrl;
        pending = false;
        showState('preview');
      });
      for (const track of media.getAudioTracks()) {
        track.addEventListener('ended', () => {
          if (myOperation === operation && recorder?.state === 'recording') finishRecording();
        }, {once: true});
      }
      pending = false;
      startTime = Date.now();
      duration.textContent = '00:00';
      activeRecorder.start(500);
      stopButton.disabled = false;
      showState('recording');
      timer = setInterval(() => {
        duration.textContent = formatRecordingDuration(Date.now() - startTime);
        if (Date.now() - startTime >= VOICE_LIMIT_MS) finishRecording();
      }, 250);
    } catch (error) {
      if (myOperation !== operation) return;
      cancel();
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        onError('Permissão do microfone negada. Libere o microfone nas configurações do navegador.');
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        onError('Nenhum microfone foi encontrado neste dispositivo.');
      } else {
        onError('Não foi possível iniciar a gravação de áudio.');
      }
    }
  }
  async function send() {
    if (!recorded || sending || !recordingConversationId) return;
    if (getConversationId() !== recordingConversationId) {
      cancel();
      return onError('A conversa foi alterada. Grave novamente.');
    }
    sending = true;
    showState('preview');
    label.textContent = 'Enviando mensagem de voz...';
    const savedOperation = operation;
    const {blob, mime, extension} = recorded;
    const name = `voz-${Date.now()}.${extension}`;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Não foi possível preparar o áudio.'));
        reader.readAsDataURL(new Blob([blob], {type: mime}));
      });
      if (savedOperation !== operation) return;
      await onSend({conversationId: recordingConversationId, file: {name, dataUrl, voice: true}});
      if (savedOperation !== operation) return;
      cancel();
    } catch (error) {
      if (savedOperation !== operation) return;
      sending = false;
      showState('preview');
      onError(error.message || 'Não foi possível enviar a mensagem de voz.');
    }
  }
  trigger.addEventListener('click', start);
  stopButton.addEventListener('click', finishRecording);
  cancelButton.addEventListener('click', cancel);
  sendButton.addEventListener('click', send);
  showState('idle');
  return {cancel, start};
}
