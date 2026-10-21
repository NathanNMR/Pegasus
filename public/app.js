import { encodePegasus, decodePegasus } from './cipher.js';
import { setupImageEditor } from './editor.js';

const $ = selector => document.querySelector(selector);
const state = {
  user: null,
  conversations: [],
  selectedId: null,
  messages: [],
  events: null,
  authMode: 'login',
  currentPartner: null,
  draftImage: null,
  addMode: 'email',
  editMessageId: null,
  requests: {incoming:[],outgoing:[]},
  profileAvatarDraft: '',
};
let toastTimer;
let refreshing = false;
let shouldRefreshAgain = false;

function showToast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
}
function initials(name) {
  return String(name || 'P').trim().split(/\s+/).slice(0, 2).map(word => word[0]?.toUpperCase() || '').join('');
}
function setAvatar(element, user) {
  element.replaceChildren();
  if (user?.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = '';
    img.className = 'avatar-photo';
    element.append(img);
  } else {
    element.textContent = initials(user?.name);
  }
}
function readableTime(value) {
  return new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function readableDay(value) {
  return new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}
function text(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = content;
  return element;
}
function safeDecode(ciphertext) {
  try { return decodePegasus(ciphertext); }
  catch { return 'Não foi possível interpretar esta mensagem.'; }
}
function previewMessage(message) {
  if (!message) return 'Diga olá! ✨';
  if (message.preview) return message.preview;
  if (message.kind === 'image') return `🖼️ ${message.image?.name || 'Imagem'}`;
  return safeDecode(message.ciphertext).replace(/\s+/g, ' ');
}
async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch {
    throw new Error('Não foi possível conectar ao servidor Pegasus.');
  }
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.user && !['/api/login', '/api/register'].includes(url)) signOut(false);
    throw new Error(payload.error || 'Ocorreu um erro.');
  }
  return payload;
}
function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  $('#loginTab').classList.toggle('active', !register);
  $('#registerTab').classList.toggle('active', register);
  $('#loginTab').setAttribute('aria-selected', String(!register));
  $('#registerTab').setAttribute('aria-selected', String(register));
  $('#nameGroup').hidden = !register;
  $('#nameInput').required = register;
  $('#passwordInput').autocomplete = register ? 'new-password' : 'current-password';
  $('#authTitle').textContent = register ? 'Crie seu céu particular.' : 'Entre no seu universo.';
  $('#authSubtitle').textContent = register ? 'Comece uma nova história, com mensagens e imagens.' : 'Entre com sua conta para continuar suas conversas.';
  $('#authSubmit').firstElementChild.textContent = register ? 'Criar minha conta' : 'Entrar no Pegasus';
}
function enterApp(user) {
  state.user = user;
  $('#authView').hidden = true;
  $('#chatView').hidden = false;
  $('#myName').textContent = user.name;
  $('#myEmail').textContent = user.email;
  setAvatar($('#myAvatar'),user);
  $('#myCode').textContent = user.friendCode || '······';
  if (state.events) state.events.close();
  state.events = new EventSource('/api/events');
  state.events.addEventListener('refresh', () => { refreshAll(); refreshRequests(); });
  refreshAll();
  refreshRequests();
}
function signOut(notify = true) {
  hideMessageContextMenu();
  state.events?.close();
  state.events = null;
  state.user = null;
  state.selectedId = null;
  state.messages = [];
  state.conversations = [];
  state.draftImage = null;
  $('#chatView').hidden = true;
  $('#authView').hidden = false;
  $('#messageInput').value = '';
  $('#authForm').reset();
  $('#chatView').classList.remove('chat-open');
  clearDraftImage(false);
  if (notify) showToast('Você saiu do Pegasus.');
}
async function refreshAll() {
  if (!state.user) return;
  if (refreshing) { shouldRefreshAgain = true; return; }
  refreshing = true;
  try {
    const data = await api('/api/conversations');
    state.conversations = data.conversations;
    renderConversations();
    if (state.selectedId != null) await refreshMessages();
  } catch (error) {
    if (state.user) showToast(error.message, true);
  } finally {
    refreshing = false;
    if (shouldRefreshAgain) { shouldRefreshAgain = false; refreshAll(); }
  }
}
function renderConversations() {
  const query = $('#searchInput').value.trim().toLocaleLowerCase('pt-BR');
  const list = $('#conversationList');
  list.replaceChildren();
  const conversations = state.conversations.filter(c => !query ||
    c.partner.name.toLocaleLowerCase('pt-BR').includes(query) || c.partner.email.toLocaleLowerCase('pt-BR').includes(query));
  $('#chatCount').textContent = String(state.conversations.length).padStart(2, '0');
  if (!conversations.length) {
    list.append(text('p', 'sidebar-placeholder', query ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa ainda. Use o botão + para começar.'));
    return;
  }
  for (const conversation of conversations) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'conversation-item';
    item.classList.toggle('selected', conversation.id === state.selectedId);
    item.addEventListener('click', () => selectConversation(conversation.id));
    const avatar = text('div','contact-avatar','');
    setAvatar(avatar, conversation.partner);
    item.append(avatar);
    const content = text('div', 'conversation-text', '');
    const nameLine = text('div', 'conversation-name-row', '');
    nameLine.append(text('strong', '', conversation.partner.name));
    nameLine.append(text('time', '', conversation.lastMessage ? readableTime(conversation.lastMessage.createdAt) : ''));
    content.append(nameLine);
    content.append(text('span', 'conversation-preview', previewMessage(conversation.lastMessage)));
    item.append(content);
    list.append(item);
  }
}
async function selectConversation(id) {
  hideMessageContextMenu();
  if (!state.user) return;
  state.selectedId = id;
  state.messages = [];
  renderMessages();
  const conversation = state.conversations.find(item => item.id === id);
  if (!conversation) return;
  state.currentPartner = conversation.partner;
  $('#partnerName').textContent = conversation.partner.name;
  $('#partnerEmail').textContent = conversation.partner.bio || conversation.partner.email;
  setAvatar($('#partnerAvatar'),conversation.partner);
  $('#welcomeScreen').hidden = true;
  $('#conversationView').hidden = false;
  $('#chatView').classList.add('chat-open');
  renderConversations();
  try { await refreshMessages(); }
  catch (error) { showToast(error.message, true); }
  $('#messageInput').focus();
}
async function refreshMessages() {
  const requested = state.selectedId;
  if (requested == null) return;
  const { messages } = await api(`/api/conversations/${requested}/messages`);
  if (state.selectedId !== requested) return;
  const previousSignature = state.messages.map(m => `${m.id}:${m.revision || 0}`).join('|');
  const scrollbox = $('#messageList');
  const isNearBottom = scrollbox.scrollHeight - scrollbox.scrollTop - scrollbox.clientHeight < 110;
  state.messages = messages;
  const newSignature = messages.map(m => `${m.id}:${m.revision || 0}`).join('|');
  if (previousSignature === newSignature) return;
  renderMessages();
  if (isNearBottom || !previousSignature) requestAnimationFrame(() => { scrollbox.scrollTop = scrollbox.scrollHeight; });
}
function hideMessageContextMenu() { $('#messageContextMenu').hidden = true; }
function showMessageContextMenu(message, x, y) {
  const menu = $('#messageContextMenu');
  menu.replaceChildren();
  const mine = message.senderId === state.user?.id;
  function option(label, action, destructive = false) {
    const button = text('button', destructive ? 'destructive' : '', label);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', async () => {
      hideMessageContextMenu();
      try { await action(); }
      catch (error) { showToast(error.message, true); }
    });
    menu.append(button);
  }
  if (mine && message.kind === 'text') {
    option('✎ Editar mensagem', () => {
      state.editMessageId = message.id;
      $('#editMessageInput').value = safeDecode(message.ciphertext);
      $('#editMessageDialog').showModal();
      $('#editMessageInput').focus();
    });
  }
  if (message.kind === 'text') {
    option('⧉ Copiar texto', async () => {
      await navigator.clipboard.writeText(safeDecode(message.ciphertext));
      showToast('Texto copiado!');
    });
  } else {
    option('↓ Salvar imagem', () => {
      const download = document.createElement('a');
      download.href = message.image.dataUrl;
      download.download = message.image.name || 'imagem-pegasus.png';
      document.body.append(download);
      download.click();
      download.remove();
    });
  }
  if (mine) {
    option('⌫ Apagar para todos', async () => {
      if (!window.confirm('Apagar esta mensagem para todos, sem aviso na conversa?')) return;
      await api(`/api/conversations/${message.conversationId}/messages/${message.id}`, { method: 'DELETE' });
      await refreshAll();
    }, true);
  } else {
    option('⌫ Apagar só para mim', async () => {
      await api(`/api/conversations/${message.conversationId}/messages/${message.id}/hide`, {
        method: 'POST', body: '{}',
      });
      await refreshAll();
    }, true);
  }
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('button')?.focus();
}
document.addEventListener('pointerdown', event => {
  if (!$('#messageContextMenu').contains(event.target)) hideMessageContextMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') hideMessageContextMenu();
});
window.addEventListener('resize', hideMessageContextMenu);
document.addEventListener('scroll', hideMessageContextMenu, true);

function renderMessages() {
  const list = $('#messageList');
  list.replaceChildren();
  if (!state.messages.length) {
    const empty = text('div', 'messages-empty', '');
    empty.append(text('div', 'messages-empty-icon', '✧'));
    empty.append(text('h3', '', 'Uma conversa só de vocês.'));
    empty.append(text('p', '', 'Envie a primeira mensagem ou compartilhe uma imagem para começar a história.'));
    list.append(empty);
    return;
  }
  let previousDate = '';
  for (const message of state.messages) {
    const date = readableDay(message.createdAt);
    if (date !== previousDate) {
      list.append(text('div', 'date-divider', date));
      previousDate = date;
    }
    const mine = message.senderId === state.user.id;
    const wrapper = text('div', `message-row ${mine ? 'mine' : 'theirs'}`, '');
    const bubble = text('div', `message-bubble ${message.kind === 'image' ? 'image-bubble' : ''}`, '');

    if (message.kind === 'image') {
      const figure = text('figure', 'message-media', '');
      const img = document.createElement('img');
      img.className = 'message-image';
      img.src = message.image.dataUrl;
      img.alt = message.image?.mime === 'image/gif' ? 'GIF animado na conversa' : 'Imagem enviada na conversa';
      img.loading = 'lazy';
      figure.append(img);
      bubble.append(figure);
    } else {
      bubble.append(text('p', 'message-body', safeDecode(message.ciphertext)));
    }

    const details = text('div', 'message-details', '');
    details.append(text('time', '', readableTime(message.createdAt)));
    // Exibe apenas o conteúdo interpretado; a transformação matemática não é mostrada na conversa.
    bubble.append(details);
    bubble.tabIndex = 0;
    bubble.setAttribute('aria-label', mine ? 'Sua mensagem. Clique com o botão direito para opções.' : 'Mensagem recebida. Clique com o botão direito para opções.');
    bubble.addEventListener('contextmenu', event => {
      event.preventDefault();
      showMessageContextMenu(message, event.clientX, event.clientY);
    });
    bubble.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        const rect = bubble.getBoundingClientRect();
        showMessageContextMenu(message, rect.left + Math.min(rect.width, 150), rect.bottom);
      }
    });
    let touchTimer;
    bubble.addEventListener('touchstart', event => {
      const point = event.touches[0];
      const x = point.clientX, y = point.clientY;
      clearTimeout(touchTimer);
      touchTimer = setTimeout(() => showMessageContextMenu(message, x, y), 600);
    }, { passive: true });
    for (const name of ['touchend', 'touchmove', 'touchcancel']) {
      bubble.addEventListener(name, () => clearTimeout(touchTimer), { passive: true });
    }
    wrapper.append(bubble);
    list.append(wrapper);
  }
}
function setAddMode(next) {
  state.addMode = next;
  const byCode = next === 'code';
  $('#modeEmail').classList.toggle('active', !byCode);
  $('#modeCode').classList.toggle('active', byCode);
  $('#contactEmailGroup').hidden = byCode;
  $('#contactCodeGroup').hidden = !byCode;
  $('#contactEmail').required = !byCode;
  $('#contactCode').required = byCode;
}
function openNewChat() {
  setAddMode('email');
  const dialog = $('#newChatDialog');
  $('#newChatForm').reset();
  dialog.showModal();
  $('#contactEmail').focus();
}
function clearDraftImage(resetInput = true) {
  state.draftImage = null;
  $('#composerMedia').hidden = true;
  $('#selectedImagePreview').src = '';
  $('#selectedImageName').textContent = '';
  if (resetInput) $('#imageInput').value = '';
}
function renderDraftImage() {
  const draft = state.draftImage;
  if (!draft) return clearDraftImage(false);
  $('#composerMedia').hidden = false;
  $('#selectedImagePreview').src = draft.dataUrl;
  $('#selectedImageName').textContent = `${draft.name} · ${Math.max(1, Math.round(draft.size / 1024))} KB`;
}
async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem selecionada.'));
    reader.readAsDataURL(file);
  });
}

$('#loginTab').addEventListener('click', () => setAuthMode('login'));
$('#registerTab').addEventListener('click', () => setAuthMode('register'));
$('#authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#authSubmit');
  button.disabled = true;
  const route = state.authMode === 'register' ? 'register' : 'login';
  const body = {
    email: $('#emailInput').value.trim(),
    password: $('#passwordInput').value,
    ...(route === 'register' ? { name: $('#nameInput').value.trim() } : {}),
  };
  try {
    const { user } = await api(`/api/${route}`, { method: 'POST', body: JSON.stringify(body) });
    enterApp(user);
    showToast(route === 'register' ? 'Sua conta Pegasus foi criada!' : 'Bem-vindo de volta!');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); }
  catch (error) { showToast(error.message, true); }
  signOut();
});
$('#searchInput').addEventListener('input', renderConversations);
$('#newChatButton').addEventListener('click', openNewChat);
$('#modeEmail').addEventListener('click', () => setAddMode('email'));
$('#modeCode').addEventListener('click', () => setAddMode('code'));
$('#contactCode').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
$('#copyCodeButton').addEventListener('click', async () => {
  if (!state.user?.friendCode) return;
  try { await navigator.clipboard.writeText(state.user.friendCode); showToast('Código Pegasus copiado!'); }
  catch { showToast(`Seu código: ${state.user.friendCode}`); }
});
$('#welcomeNewChat').addEventListener('click', openNewChat);
$('#closeDialog').addEventListener('click', () => $('#newChatDialog').close());
$('#newChatDialog').addEventListener('click', event => {
  if (event.target === $('#newChatDialog')) $('#newChatDialog').close();
});
$('#newChatForm').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = state.addMode === 'code'
    ? { friendCode: $('#contactCode').value.trim().toUpperCase() }
    : { email: $('#contactEmail').value.trim() };
  const button = $('#createChatSubmit');
  button.disabled = true;
  try {
    const result = await api('/api/conversations', { method: 'POST', body: JSON.stringify(payload) });
    $('#newChatDialog').close();
    if (result.status === 'pending') {
      showToast('Solicitação enviada. A conversa começa depois da aprovação.');
      await refreshRequests();
    } else if (result.status === 'incoming') {
      showToast('Você tem uma solicitação desta pessoa. Abra Solicitações.');
      await refreshRequests();
      $('#requestsDialog').showModal();
    } else {
      await refreshAll();
      await selectConversation(result.conversationId);
      showToast('Conversa pronta!');
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
async function refreshRequests() {
  if (!state.user) return;
  try {
    const data = await api('/api/chat-requests');
    state.requests = data;
    const count = data.incoming.length;
    $('#requestsCount').textContent = String(count);
    $('#requestsCount').hidden = count === 0;
    renderRequests();
  } catch (error) { if (state.user) showToast(error.message,true); }
}
function renderRequests() {
  const list = $('#requestsList');
  list.replaceChildren();
  if (!state.requests.incoming.length) {
    list.append(text('p','request-empty','Nenhuma solicitação pendente.'));
  }
  for (const request of state.requests.incoming) {
    const item = text('div','request-item','');
    const avatar=text('div','contact-avatar','');
    setAvatar(avatar,request);
    const info=text('div','request-info','');
    info.append(text('strong','',request.name),text('small','',`${request.friendCode} · ${request.bio || 'Quer conversar com você'}`));
    const actions=text('div','request-actions','');
    for (const [label, action] of [['Aceitar','accept'],['Recusar','decline']]) {
      const button=text('button',action==='accept'?'soft-button accept-request':'soft-button',label);
      button.type='button';
      button.addEventListener('click',async()=>{
        button.disabled=true;
        try {
          const result=await api(`/api/chat-requests/${request.id}/${action}`,{method:'POST',body:'{}'});
          await Promise.all([refreshRequests(),refreshAll()]);
          if (result.conversationId) { $('#requestsDialog').close(); await selectConversation(result.conversationId); }
          showToast(action==='accept'?'Solicitação aceita.':'Solicitação recusada.');
        } catch(error) { showToast(error.message,true); button.disabled=false; }
      });
      actions.append(button);
    }
    item.append(avatar,info,actions);list.append(item);
  }
  const outgoing=state.requests.outgoing;
  $('#requestsOutgoing').textContent=outgoing.length?`Enviadas e aguardando aprovação: ${outgoing.map(r=>r.name).join(', ')}`:'';
}
function openProfile() {
  if (!state.user) return;
  $('#profileName').textContent=state.user.name;
  $('#profileEmail').textContent=state.user.email;
  $('#profileCode').textContent=state.user.friendCode;
  $('#profileBio').value=state.user.bio||'';
  state.profileAvatarDraft=state.user.avatar||'';
  setAvatar($('#profilePreview'),{name:state.user.name,avatar:state.profileAvatarDraft});
  $('#profileForm').elements.privacyMode.value=state.user.privacyMode||'open';
  $('#profileDialog').showModal();
}
$('#profileButton').addEventListener('click',openProfile);
$('#closeProfile').addEventListener('click',()=>$('#profileDialog').close());
$('#requestsButton').addEventListener('click',async()=>{await refreshRequests();$('#requestsDialog').showModal();});
$('#closeRequests').addEventListener('click',()=>$('#requestsDialog').close());
$('#removeProfileAvatar').addEventListener('click',()=>{
  state.profileAvatarDraft='';
  setAvatar($('#profilePreview'),{name:state.user.name});
  $('#profileAvatarInput').value='';
});
$('#profileAvatarInput').addEventListener('change',async event=>{
  const file=event.target.files?.[0];
  if (!file) return;
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) {showToast('Escolha PNG, JPG ou WEBP.',true);return;}
  try {
    const url=await fileToDataUrl(file);
    const img=await new Promise((resolve,reject)=>{
      const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(new Error('Imagem inválida.'));im.src=url;
    });
    const canvas=document.createElement('canvas');
    canvas.width=160;canvas.height=160;
    const ctx=canvas.getContext('2d');
    const side=Math.min(img.naturalWidth,img.naturalHeight);
    ctx.drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,160,160);
    let result=canvas.toDataURL('image/jpeg',.83);
    if (result.length > 320_000) result=canvas.toDataURL('image/jpeg',.6);
    state.profileAvatarDraft=result;
    setAvatar($('#profilePreview'),{name:state.user.name,avatar:result});
  } catch(error) {showToast(error.message,true);}
});
$('#profileForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=$('#saveProfileButton');button.disabled=true;
  try {
    const {user}=await api('/api/profile',{method:'PUT',body:JSON.stringify({
      avatar:state.profileAvatarDraft,
      bio:$('#profileBio').value,
      privacyMode:$('#profileForm').elements.privacyMode.value,
    })});
    state.user=user;
    setAvatar($('#myAvatar'),user);
    $('#profileDialog').close();
    showToast('Perfil salvo!');
    await refreshAll();
  }catch(error){showToast(error.message,true);}
  finally{button.disabled=false;}
});

const editor = setupImageEditor({
  onApply(image) { state.draftImage = image; renderDraftImage(); },
  onError(message) { showToast(message, true); },
});
$('#attachImageButton').addEventListener('click', () => $('#imageInput').click());
$('#attachGifButton').addEventListener('click', () => $('#gifInput').click());
for (const id of ['imageInput', 'gifInput']) {
  $( '#' + id ).addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    await editor.open(file);
    event.target.value = '';
  });
}
$('#removeImageButton').addEventListener('click', () => clearDraftImage());
$('#messageForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.selectedId || !state.user) return;
  const input = $('#messageInput');
  const originalText = input.value;
  const draftImage = state.draftImage;
  if (!originalText.trim() && !draftImage) return;
  const button = $('#sendButton');
  button.disabled = true;
  try {
    if (draftImage) {
      await api(`/api/conversations/${state.selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'image', image: { dataUrl: draftImage.dataUrl, name: draftImage.name } }),
      });
      clearDraftImage();
    }
    if (originalText.trim()) {
      const ciphertext = encodePegasus(originalText);
      await api(`/api/conversations/${state.selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'text', ciphertext }),
      });
      if (input.value === originalText) input.value = '';
      input.style.height = 'auto';
    }
    await refreshAll();
    $('#messageList').scrollTop = $('#messageList').scrollHeight;
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    input.focus();
  }
});
$('#editMessageCancel').addEventListener('click', () => $('#editMessageDialog').close());
$('#editMessageForm').addEventListener('submit', async event => {
  event.preventDefault();
  const id = state.editMessageId;
  const value = $('#editMessageInput').value;
  if (!id || !state.selectedId || !value.trim()) return;
  try {
    await api(`/api/conversations/${state.selectedId}/messages/${id}`, {
      method: 'PATCH', body: JSON.stringify({ ciphertext: encodePegasus(value) }),
    });
    $('#editMessageDialog').close();
    state.editMessageId = null;
    await refreshAll();
  } catch (error) { showToast(error.message, true); }
});
$('#messageInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#messageForm').requestSubmit();
  }
});
$('#messageInput').addEventListener('input', event => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(140, event.target.scrollHeight)}px`;
});
$('#backButton').addEventListener('click', () => $('#chatView').classList.remove('chat-open'));

(async function startup() {
  try {
    const { user } = await api('/api/me');
    enterApp(user);
  } catch {
    // Sem sessão é esperado quando se abre o Pegasus pela primeira vez.
  }
})();
