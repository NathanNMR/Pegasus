import { encodePegasus, decodePegasus } from './cipher.js';
import { setupImageEditor } from './editor.js';
import { setupVoiceRecorder } from './voice-recorder.js';

const $ = selector => document.querySelector(selector);
const state = {
  user: null,
  conversations: [],
  selectedId: null,
  messages: [],
  events: null,
  authMode: 'login',
  currentPartner: null,
  currentConversation: null,
  draftImage: null,
  draftAttachment: null,
  addMode: 'email',
  editMessageId: null,
  requests: {incoming:[],outgoing:[]},
  profileAvatarDraft: '',
  selectionMode: false,
  selectedMessageIds: new Set(),
  replyToMessageId: null,
  forwardMessageIds: [],
  theme: 'dark',
  showArchived: false,
  typing: new Map(),
  drafts: new Map(),
  groupDetail: null,
};
const isGroup = conversation => conversation?.kind === 'group';
let toastTimer;
let refreshing = false;
let shouldRefreshAgain = false;
let refreshWaiters = [];

function showToast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
}

// Último ponto tocado/clicado: os popovers de confirmação e reação abrem ao lado dele.
const lastPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
document.addEventListener('pointerdown', event => { lastPointer.x = event.clientX; lastPointer.y = event.clientY; }, true);

function showFloating(popover) {
  // Dentro de uma janela modal só o que está dentro dela recebe cliques; por isso o popover muda para o <dialog> aberto.
  const host = document.querySelector('dialog[open]') || document.body;
  if (popover.parentElement !== host) host.append(popover);
  popover.hidden = false;
  if (typeof popover.showPopover === 'function' && !popover.matches(':popover-open')) popover.showPopover();
}
function hideFloating(popover) {
  if (typeof popover.hidePopover === 'function' && popover.matches(':popover-open')) popover.hidePopover();
  popover.hidden = true;
}
function placePopover(popover, anchor = lastPointer) {
  showFloating(popover);
  const gap = 8;
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const left = Math.max(gap, Math.min(anchor.x, window.innerWidth - width - gap));
  let top = anchor.y + 6;
  if (top + height > window.innerHeight - gap) top = anchor.y - height - 6;
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(gap, top)}px`;
}

// Abre um popover não modal e resolve quando o usuário escolhe, clica fora, aperta Esc ou redimensiona.
function openPopover(popover, onReady) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      hideFloating(popover);
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      resolve(value);
    };
    const onOutside = event => { if (!popover.contains(event.target)) finish(null); };
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); } };
    const onResize = () => finish(null);
    onReady(finish);
    // registra depois do clique atual para não fechar no mesmo gesto que abriu
    setTimeout(() => {
      if (done) return;
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onResize);
    }, 0);
  });
}

async function customConfirm(title, message) {
  const popover = $('#confirmPopover');
  $('#customConfirmTitle').textContent = title;
  $('#customConfirmMessage').textContent = message;
  const result = await openPopover(popover, finish => {
    $('#customConfirmAccept').onclick = () => finish(true);
    $('#customConfirmCancel').onclick = () => finish(false);
    placePopover(popover);
    $('#customConfirmAccept').focus();
  });
  $('#customConfirmAccept').onclick = null;
  $('#customConfirmCancel').onclick = null;
  return result === true;
}

// Resolve: emoji escolhido, '' para remover a reação ou null se cancelar.
async function customReact() {
  const popover = $('#reactionPopover');
  const result = await openPopover(popover, finish => {
    $('#removeReactionButton').onclick = () => finish('');
    $('#reactionGrid').querySelectorAll('button').forEach(btn => { btn.onclick = () => finish(btn.dataset.emoji); });
    placePopover(popover);
    $('#reactionGrid').querySelector('button')?.focus();
  });
  return result;
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
  if (message.kind === 'image') return '🖼️ Imagem';
  if (message.kind === 'audio') return message.file?.voice ? '🎤 Mensagem de voz' : '🎵 Áudio';
  if (message.kind === 'document') return '📄 Documento';
  if (message.kind === 'contact') return `👤 ${message.contact?.name || 'Contato'}`;
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
function applyTheme(theme, persist = true) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  $('#themeToggle').textContent = state.theme === 'dark' ? '☼' : '☾';
  $('#themeToggle').title = state.theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro';
  $('#themeToggle').setAttribute('aria-label', $('#themeToggle').title);
  const themeColor=document.querySelector('meta[name="theme-color"]');
  if(themeColor)themeColor.content=state.theme==='dark'?'#09162f':'#e8f2ff';
  if (persist) { try { localStorage.setItem('pegasus-theme', state.theme); } catch { /* armazenamento opcional */ } }
}
function showIncomingNotification(conversation) {
  if (!conversation?.notificationsEnabled || conversation.id === state.selectedId || !conversation.lastMessage ||
      conversation.lastMessage.senderId === state.user?.id || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const sender = isGroup(conversation) && conversation.lastMessage.senderName ? `${conversation.lastMessage.senderName}: ` : '';
    const notice = new Notification(conversation.partner.name, { body: sender + (conversation.lastMessage.preview || 'Nova mensagem no Pegasus.'), icon: '/favicon.png' });
    notice.onclick = () => { window.focus(); selectConversation(conversation.id); notice.close(); };
  } catch { /* notificações não são essenciais para o chat */ }
}
function applyConversationStatus() {
  const conversation = state.currentConversation;
  const blocked = !!(conversation?.blockedByMe || conversation?.blockedByPartner);
  $('#messageInput').disabled = blocked;
  $('#sendButton').disabled = blocked;
  $('#attachmentButton').disabled = blocked;
  $('#voiceButton').disabled = blocked;
  $('#messageInput').placeholder = conversation?.blockedByMe ? 'Você bloqueou este contato.' : conversation?.blockedByPartner ? 'Este contato bloqueou você.' : 'Escreva sua mensagem...';
  $('#blockContactButton').textContent = conversation?.blockedByMe ? 'Desbloquear contato' : 'Bloquear contato';
}
function enterApp(user) {
  try { applyTheme(localStorage.getItem('pegasus-theme') || 'dark', false); } catch { applyTheme('dark', false); }
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
  state.events.addEventListener('typing', event => {
    try { const data = JSON.parse(event.data); if (data.userId !== state.user?.id) setTyping(data.conversationId, data.userId, data.name); } catch { /* evento inválido */ }
  });
  refreshAll();
  refreshRequests();
}
function signOut(notify = true) {
  hideMessageContextMenu();
  voiceRecorder?.cancel();
  state.events?.close();
  state.events = null;
  state.user = null;
  state.selectedId = null;
  state.currentConversation = null;
  state.currentPartner = null;
  state.messages = [];
  cancelSelection();
  clearReply();
  state.conversations = [];
  state.drafts.clear();
  for (const members of state.typing.values()) for (const entry of members.values()) clearTimeout(entry.timer);
  state.typing.clear();
  document.title = 'Pegasus — Mensagens';
  state.draftImage = null;
  $('#chatView').hidden = true;
  $('#authView').hidden = false;
  $('#messageInput').value = '';
  $('#authForm').reset();
  $('#chatView').classList.remove('chat-open');
  clearDraftImage(false);
  if (notify) showToast('Você saiu do Pegasus.');
}

function showContactContextMenu(conversation, x, y) {
  const menu = $('#messageContextMenu');
  menu.replaceChildren();
  const group = isGroup(conversation);

  function option(label, action, destructive = false) {
    const button = text('button', destructive ? 'destructive' : '', label);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', async () => {
      hideMessageContextMenu();
      try { await action(); } catch (error) { showToast(error.message, true); }
    });
    menu.append(button);
  }

  option(group ? 'Ver informações do grupo' : 'Ver Detalhes do Contato', async () => {
    await selectConversation(conversation.id);
    group ? openGroupInfo() : openContactDetails();
  });
  option(conversation.pinned ? 'Desafixar conversa' : 'Fixar conversa', async () => {
    await api(`/api/conversations/${conversation.id}/preferences`, {method:'PUT',body:JSON.stringify({pinned:!conversation.pinned})});
    await refreshAll();
    showToast(conversation.pinned ? 'Conversa desafixada.' : 'Conversa fixada no topo.');
  });
  option(conversation.archived ? 'Desarquivar Conversa' : 'Arquivar Conversa', async () => {
    await api(`/api/conversations/${conversation.id}/preferences`, {method:'PUT',body:JSON.stringify({archived:!conversation.archived})});
    await refreshAll();
    showToast(conversation.archived ? 'Conversa desarquivada.' : 'Conversa arquivada.');
  });
  if (group) {
    option('Sair do grupo', () => leaveGroup(conversation), true);
  } else {
    option('Excluir Contato', async () => {
      if (!await customConfirm('Excluir contato', `Excluir ${conversation.partner.name} e ocultar conversa?`)) return;
      await api(`/api/conversations/${conversation.id}/contact`, {method:'DELETE'});
      if (state.selectedId === conversation.id) closeConversationView();
      await refreshAll();
      showToast('Contato excluído.');
    }, true);
  }

  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
}
function closeConversationView() {
  state.selectedId = null; state.currentConversation = null; state.currentPartner = null; state.messages = [];
  $('#conversationView').hidden = true; $('#welcomeScreen').hidden = false; $('#chatView').classList.remove('chat-open');
  cancelSelection(); clearReply();
}

async function refreshAll() {
  if (!state.user) return;
  if (refreshing) { shouldRefreshAgain = true; return new Promise(resolve => refreshWaiters.push(resolve)); }
  refreshing = true;
  try {
    const data = await api('/api/conversations');
    const previous = new Map(state.conversations.map(c => [c.id,c.lastMessage?.id || 0]));
    state.conversations = data.conversations;
    for (const conversation of state.conversations) {
      const oldId=previous.get(conversation.id);
      if (previous.has(conversation.id) && conversation.lastMessage?.id > oldId) {
        clearTyping(conversation.id, conversation.lastMessage.senderId);
        showIncomingNotification(conversation);
      }
    }
    renderConversations();
    if (state.selectedId != null) {
      const current = state.conversations.find(item => item.id === state.selectedId);
      if (!current) {
        // saiu do grupo, foi removido ou a conversa deixou de existir
        closeConversationView();
        for (const id of ['#groupInfoDialog', '#contactDialog']) if ($(id).open) $(id).close();
        renderConversations();
      } else {
        state.currentConversation = current;
        state.currentPartner = current.partner;
        renderChatHeader();
        applyConversationStatus();
        await refreshMessages();
      }
    }
  } catch (error) {
    if (state.user) showToast(error.message, true);
  } finally {
    refreshing = false;
    const waiters = refreshWaiters; refreshWaiters = [];
    // quem chamou durante uma atualização só continua depois da atualização seguinte (dados já frescos)
    if (shouldRefreshAgain) { shouldRefreshAgain = false; refreshAll().then(() => waiters.forEach(resolve => resolve())); }
    else waiters.forEach(resolve => resolve());
  }
}
function setConversationAvatar(element, conversation) {
  if (isGroup(conversation) && !conversation.partner.avatar) { element.replaceChildren(); element.textContent = '👥'; }
  else setAvatar(element, conversation.partner);
}
function renderChatHeader() {
  const conversation = state.currentConversation;
  if (!conversation) return;
  $('#partnerName').textContent = conversation.partner.name;
  const typing = typingLabel(conversation);
  $('#partnerEmail').textContent = typing || conversation.partner.bio || conversation.partner.email;
  $('#partnerEmail').classList.toggle('typing-label', !!typing);
  setConversationAvatar($('#partnerAvatar'), conversation);
}
function renderConversations() {
  const query = $('#searchInput').value.trim().toLocaleLowerCase('pt-BR');
  const list = $('#conversationList');
  list.replaceChildren();
  const conversations = state.conversations.filter(c => !!c.archived===state.showArchived && (!query ||
    c.partner.name.toLocaleLowerCase('pt-BR').includes(query) || c.partner.realName?.toLocaleLowerCase('pt-BR').includes(query) || c.partner.email.toLocaleLowerCase('pt-BR').includes(query)));
  $('#chatCount').textContent = String(state.conversations.length).padStart(2, '0');
  const totalUnread = state.conversations.reduce((sum, c) => sum + (c.id === state.selectedId ? 0 : (c.unreadCount || 0)), 0);
  document.title = totalUnread ? `(${totalUnread}) Pegasus — Mensagens` : 'Pegasus — Mensagens';
  if (!conversations.length) {
    list.append(text('p', 'sidebar-placeholder', query ? 'Nenhuma conversa encontrada.' : state.showArchived ? 'Nenhuma conversa arquivada.' : 'Nenhuma conversa ainda. Use o botão + para começar.'));
    return;
  }
  for (const conversation of conversations) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'conversation-item';
    item.classList.toggle('selected', conversation.id === state.selectedId);
    item.addEventListener('click', () => selectConversation(conversation.id));

    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContactContextMenu(conversation, event.clientX, event.clientY);
    });

    const avatar = text('div','contact-avatar','');
    setConversationAvatar(avatar, conversation);
    item.append(avatar);
    const content = text('div', 'conversation-text', '');
    const nameLine = text('div', 'conversation-name-row', '');
    nameLine.append(text('strong', '', conversation.partner.name));
    if(conversation.pinned)nameLine.append(text('span','conversation-pinned-mark','⌖'));
    if(conversation.archived)nameLine.append(text('span','conversation-archived-mark','▣'));
    nameLine.append(text('time', '', conversation.lastMessage ? readableTime(conversation.lastMessage.createdAt) : ''));
    content.append(nameLine);
    const previewRow = text('div', 'conversation-preview-row', '');
    const typing = typingLabel(conversation);
    const draft = conversation.id !== state.selectedId ? state.drafts.get(conversation.id) : '';
    if (typing) previewRow.append(text('span', 'conversation-preview typing-label', typing));
    else if (draft) {
      previewRow.append(text('span', 'conversation-preview', ''));
      previewRow.firstChild.append(text('em', 'draft-tag', 'Rascunho: '), draft.replace(/\s+/g, ' ').slice(0, 80));
    } else {
      let preview = previewMessage(conversation.lastMessage);
      if (isGroup(conversation) && conversation.lastMessage && conversation.lastMessage.kind !== 'system') {
        preview = `${conversation.lastMessage.senderId === state.user.id ? 'Você' : (conversation.lastMessage.senderName || 'Alguém')}: ${preview}`;
      }
      previewRow.append(text('span', 'conversation-preview', preview));
    }
    const unread = conversation.id === state.selectedId ? 0 : (conversation.unreadCount || 0);
    if (unread) previewRow.append(text('span', 'unread-badge', unread > 99 ? '99+' : String(unread)));
    content.append(previewRow);
    item.append(content);
    list.append(item);
  }
}
async function selectConversation(id) {
  voiceRecorder?.cancel();
  hideMessageContextMenu();
  cancelSelection();
  clearReply();
  if (!state.user) return;
  saveDraft();
  state.selectedId = id;
  state.messages = [];
  const conversation = state.conversations.find(item => item.id === id);
  if (!conversation) { renderMessages(); return; }
  state.currentConversation = conversation;
  state.currentPartner = conversation.partner;
  renderMessages();
  restoreDraft(id);
  renderChatHeader();
  $('#welcomeScreen').hidden = true;
  $('#conversationView').hidden = false;
  $('#chatView').classList.add('chat-open');
  applyConversationStatus();
  renderConversations();
  try { await refreshMessages(); }
  catch (error) { showToast(error.message, true); }
  if (!conversation.blockedByMe && !conversation.blockedByPartner) $('#messageInput').focus();
}
async function refreshMessages(aroundId = null) {
  const requested = state.selectedId;
  if (requested == null) return;
  const { messages } = await api(`/api/conversations/${requested}/messages${aroundId ? `?around=${encodeURIComponent(aroundId)}` : ''}`);
  if (state.selectedId !== requested) return;
  const previousSignature = state.messages.map(m => `${m.id}:${m.revision || 0}:${m.isFavorite?1:0}:${m.replyTo?.id||0}:${m.replyTo?.preview||''}:${m.forwarded?1:0}:${m.isPinned?1:0}:${m.readAt||''}:${(m.reactions||[]).map(r=>r.emoji+r.count+r.mine).join(',')}:${m.expiresAt||''}`).join('|');
  const scrollbox = $('#messageList');
  const isNearBottom = scrollbox.scrollHeight - scrollbox.scrollTop - scrollbox.clientHeight < 110;
  state.messages = messages;
  const newSignature = messages.map(m => `${m.id}:${m.revision || 0}:${m.isFavorite?1:0}:${m.replyTo?.id||0}:${m.replyTo?.preview||''}:${m.forwarded?1:0}:${m.isPinned?1:0}:${m.readAt||''}:${(m.reactions||[]).map(r=>r.emoji+r.count+r.mine).join(',')}:${m.expiresAt||''}`).join('|');
  if (previousSignature === newSignature) return;
  renderMessages();
  if (isNearBottom || !previousSignature) requestAnimationFrame(() => { scrollbox.scrollTop = scrollbox.scrollHeight; });
}
function hideMessageContextMenu() { $('#messageContextMenu').hidden = true; }
function messagePreview(message) {
  if (!message) return 'Mensagem indisponível';
  if (message.kind === 'text') return safeDecode(message.ciphertext).replace(/\s+/g,' ').slice(0,180);
  return previewMessage(message).slice(0,180);
}
function setReplyTo(message) {
  state.replyToMessageId=message.id;
  $('#replyComposerName').textContent=message.senderId===state.user.id?'Você':(state.currentPartner?.name||'Contato');
  $('#replyComposerText').textContent=messagePreview(message);
  $('#replyComposer').hidden=false;
  $('#messageInput').focus();
}
function clearReply() {
  state.replyToMessageId=null;
  if ($('#replyComposer')) $('#replyComposer').hidden=true;
}
function updateSelectionToolbar() {
  const toolbar=$('#selectionToolbar');
  toolbar.hidden=!state.selectionMode;
  const count=state.selectedMessageIds.size;
  $('#selectionCount').textContent=`${count} ${count===1?'mensagem selecionada':'mensagens selecionadas'}`;
  const selected=state.messages.filter(m=>state.selectedMessageIds.has(m.id));
  $('#selectionFavorite').textContent=selected.length&&selected.every(m=>m.isFavorite)?'★ Remover favoritos':'☆ Favoritar';
  $('#selectionForward').disabled=count===0;
  $('#selectionFavorite').disabled=count===0;
  $('#selectionDelete').disabled=count===0;
}
function startSelection(messageId) {
  state.selectionMode=true;
  state.selectedMessageIds=new Set([messageId]);
  renderMessages();
  updateSelectionToolbar();
}
function toggleMessageSelection(messageId) {
  if (!state.selectionMode) state.selectionMode=true;
  if (state.selectedMessageIds.has(messageId)) state.selectedMessageIds.delete(messageId);
  else state.selectedMessageIds.add(messageId);
  if (!state.selectedMessageIds.size) state.selectionMode=false;
  renderMessages();
  updateSelectionToolbar();
}
function cancelSelection() {
  state.selectionMode=false;
  state.selectedMessageIds.clear();
  if ($('#selectionToolbar')) updateSelectionToolbar();
}
async function favoriteMessage(message, favorite=!message.isFavorite) {
  await api(`/api/conversations/${message.conversationId}/messages/${message.id}/favorite`,{
    method:'POST',body:JSON.stringify({favorite}),
  });
  await refreshMessages();
  await refreshAll();
  showToast(favorite?'Mensagem adicionada aos favoritos.':'Mensagem removida dos favoritos.');
}
function openForwardDialog(messageIds) {
  state.forwardMessageIds=[...new Set(messageIds.map(Number))].filter(id=>state.messages.some(m=>m.id===id));
  if (!state.forwardMessageIds.length) return;
  $('#forwardCountLabel').textContent=`${state.forwardMessageIds.length} ${state.forwardMessageIds.length===1?'mensagem selecionada':'mensagens selecionadas'}. Escolha o destino.`;
  const list=$('#forwardConversationList');list.replaceChildren();
  const destinations=state.conversations.filter(c=>c.id!==state.selectedId);
  if (!destinations.length) list.append(text('p','empty-panel','Crie outra conversa para encaminhar mensagens.'));
  for (const conversation of destinations) {
    const button=text('button','forward-conversation-item','');button.type='button';
    const avatar=text('div','contact-avatar','');setAvatar(avatar,conversation.partner);
    const info=text('span','',conversation.partner.name);
    button.append(avatar,info);
    button.addEventListener('click',()=>forwardMessagesTo(conversation.id));
    list.append(button);
  }
  $('#forwardDialog').showModal();
}
async function forwardMessagesTo(targetConversationId) {
  const ids=[...state.forwardMessageIds];
  const sourceId=state.selectedId;
  try {
    for (const messageId of ids) {
      await api(`/api/conversations/${sourceId}/messages/${messageId}/forward`,{
        method:'POST',body:JSON.stringify({targetConversationId}),
      });
    }
    $('#forwardDialog').close();
    state.forwardMessageIds=[];
    cancelSelection();
    await refreshAll();
    showToast(ids.length===1?'Mensagem encaminhada.':`${ids.length} mensagens encaminhadas.`);
  } catch(error) { showToast(error.message,true); }
}
async function deleteSelectedMessages() {
  const selected=state.messages.filter(m=>state.selectedMessageIds.has(m.id));
  if (!selected.length) return;
  if (!await customConfirm('Excluir mensagens', `Excluir ${selected.length} mensagem(ns) selecionada(s)? Mensagens suas serão apagadas para todos; as recebidas, só para você.`)) return;
  try {
    for (const message of selected) {
      if (message.senderId===state.user.id) {
        await api(`/api/conversations/${message.conversationId}/messages/${message.id}`,{method:'DELETE'});
      } else {
        await api(`/api/conversations/${message.conversationId}/messages/${message.id}/hide`,{method:'POST',body:'{}'});
      }
    }
    cancelSelection();
    await refreshAll();
    showToast('Mensagens excluídas.');
  } catch(error) { showToast(error.message,true); }
}
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
  option('↩ Responder', () => setReplyTo(message));
  option(message.isPinned ? '⌖ Desafixar mensagem' : '⌖ Fixar mensagem', async () => { await api(`/api/conversations/${message.conversationId}/messages/${message.id}/pin`,{method:'POST',body:JSON.stringify({pinned:!message.isPinned})}); await refreshMessages(); showToast(message.isPinned?'Mensagem desafixada.':'Mensagem fixada.'); });
  option('☺ Reagir…', async () => { 
    const emoji = await customReact(); 
    if(emoji === null) return; 
    const emojiTrimmed = emoji.trim(); 
    await api(`/api/conversations/${message.conversationId}/messages/${message.id}/reaction`,{method:'POST',body:JSON.stringify({emoji: emojiTrimmed})}); 
    await refreshMessages(); 
  });
  option(message.isFavorite ? '★ Remover dos favoritos' : '☆ Adicionar aos favoritos', () => favoriteMessage(message,!message.isFavorite));
  option('➦ Encaminhar', () => openForwardDialog([message.id]));
  option('☷ Selecionar mensagem', () => startSelection(message.id));
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
  } else if (message.kind === 'contact') {
    option('⧉ Copiar código do contato', async () => {
      await navigator.clipboard.writeText(message.contact.friendCode);
      showToast('Código copiado!');
    });
  } else {
    option(message.kind === 'image' ? '↓ Salvar imagem' : '↓ Baixar arquivo', () => {
      const file = message.kind === 'image' ? message.image : message.file;
      const download = document.createElement('a');
      download.href = file.dataUrl;
      download.download = file.name || 'arquivo-pegasus';
      document.body.append(download); download.click(); download.remove();
    });
  }
  if (mine) {
    option('⌫ Apagar para todos', async () => {
      if (!await customConfirm('Apagar para todos', 'Apagar esta mensagem para todos, sem aviso na conversa?')) return;
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
    updateSelectionToolbar();
    return;
  }
  let previousDate = '';
  for (const message of state.messages) {
    const date = readableDay(message.createdAt);
    if (date !== previousDate) {
      list.append(text('div', 'date-divider', date));
      previousDate = date;
    }
    if (message.kind === 'system') {
      const notice = text('div', 'system-notice', message.text);
      notice.id = `message-${message.id}`;
      list.append(notice);
      continue;
    }
    const mine = message.senderId === state.user.id;
    const groupChat = isGroup(state.currentConversation);
    const wrapper = text('div', `message-row ${mine ? 'mine' : 'theirs'}`, '');
    wrapper.dataset.messageId=String(message.id);
    wrapper.id=`message-${message.id}`;
    wrapper.classList.toggle('selected',state.selectedMessageIds.has(message.id));
    const bubble = text('div', `message-bubble ${message.kind === 'image' ? 'image-bubble' : ''}`, '');
    if (groupChat && !mine) {
      const label = text('span', 'message-sender', message.senderName || memberName(message.senderId));
      label.style.color = `hsl(${(message.senderId * 47) % 360} 80% 74%)`;
      bubble.append(label);
    }
    if (message.isPinned) bubble.append(text('span','message-forwarded-tag','⌖ Fixada'));
    if (message.forwarded) bubble.append(text('span','message-forwarded-tag','↗ Encaminhada'));
    if (message.replyTo) {
      const quote=text('button','reply-quote','');quote.type='button';
      quote.append(text('strong','',message.replyTo.senderId===state.user.id?'Você':(groupChat?(message.replyTo.senderName||memberName(message.replyTo.senderId)):(state.currentPartner?.name||'Contato'))),
        text('span','',message.replyTo.preview||'Mensagem respondida'));
      quote.addEventListener('click',event=>{event.stopPropagation();jumpToMessage(message.replyTo.id);});
      bubble.append(quote);
    }

    if (message.kind === 'image') {
      const figure = text('figure', 'message-media', '');
      const img = document.createElement('img');
      img.className = 'message-image';
      img.src = message.image.dataUrl;
      img.alt = message.image?.mime === 'image/gif' ? 'GIF animado na conversa' : 'Imagem enviada na conversa';
      img.loading = 'lazy';
      figure.append(img);
      bubble.append(figure);
    } else if (message.kind === 'audio') {
      if (message.file?.voice) bubble.append(text('span', 'voice-message-tag', '🎤 Mensagem de voz'));
      const sound = document.createElement('audio');
      sound.controls = true;
      sound.preload = 'none';
      sound.src = message.file.dataUrl;
      sound.setAttribute('aria-label', 'Áudio recebido');
      sound.className = 'message-audio';
      bubble.append(sound);
    } else if (message.kind === 'document') {
      const link = document.createElement('a');
      link.className = 'message-document';
      link.href = message.file.dataUrl;
      link.download = message.file.name;
      link.textContent = `📄 ${message.file.name}`;
      bubble.append(link);
    } else if (message.kind === 'contact') {
      const card = text('div','message-contact','');
      card.append(text('strong','',`👤 ${message.contact.name}`));
      card.append(text('small','',`Código ${message.contact.friendCode}`));
      const open = text('button', '', 'Abrir contato');
      open.type = 'button';
      open.addEventListener('click', async () => {
        try {
          const result = await api('/api/conversations', {
            method:'POST',body:JSON.stringify({friendCode:message.contact.friendCode}),
          });
          if (result.conversationId) {
            await refreshAll();
            await selectConversation(result.conversationId);
          } else showToast(result.message || 'Solicitação enviada.');
        } catch (error) { showToast(error.message,true); }
      });
      card.append(open);
      bubble.append(card);
    } else {
      const body = text('p', 'message-body', '');
      body.append(formatText(safeDecode(message.ciphertext)));
      bubble.append(body);
    }

    const details = text('div', 'message-details', '');
    details.append(text('time', '', readableTime(message.createdAt)));
    if(mine && !groupChat) details.append(text('span','message-read-status',message.readAt?'✓✓ Lida':'✓ Enviada'));
    if (message.isFavorite) details.append(text('span','message-favorite-mark','★'));
    bubble.append(details);
    if(message.reactions?.length){
      const reactionRow=text('div','message-reactions','');
      for(const reaction of message.reactions){const chip=text('button','reaction-chip',`${reaction.emoji} ${reaction.count}`);chip.type='button';chip.classList.toggle('mine',reaction.mine);chip.title=reaction.mine?'Remover sua reação':'Reagir com '+reaction.emoji;chip.addEventListener('click',async event=>{event.stopPropagation();await api(`/api/conversations/${message.conversationId}/messages/${message.id}/reaction`,{method:'POST',body:JSON.stringify({emoji:reaction.mine?'':reaction.emoji})});await refreshMessages();});reactionRow.append(chip);}
      bubble.append(reactionRow);
    }
    bubble.tabIndex = 0;
    bubble.setAttribute('aria-label', mine ? 'Sua mensagem. Clique com o botão direito para opções.' : 'Mensagem recebida. Clique com o botão direito para opções.');
    bubble.addEventListener('contextmenu', event => {
      event.preventDefault();
      showMessageContextMenu(message, event.clientX, event.clientY);
    });
    
    bubble.addEventListener('dblclick', event => {
      if (!state.selectionMode && !event.target.closest('audio,a,button')) {
        event.preventDefault();
        setReplyTo(message);
      }
    });

    bubble.addEventListener('click',event=>{
      if (!state.selectionMode || event.target.closest('audio,a,button')) return;
      event.preventDefault();
      toggleMessageSelection(message.id);
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
  updateSelectionToolbar();
}
async function jumpToMessage(messageId) {
  let target=document.getElementById(`message-${messageId}`);
  if (!target) {
    try { await refreshMessages(messageId); }
    catch(error) { showToast(error.message,true); return; }
    target=document.getElementById(`message-${messageId}`);
  }
  if (target) {
    target.scrollIntoView({behavior:'smooth',block:'center'});
    target.classList.add('jump-highlight');
    setTimeout(()=>target.classList.remove('jump-highlight'),1800);
  } else showToast('Essa mensagem não está mais disponível.');
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
  state.draftAttachment = null;
  $('#composerMedia').hidden = true;
  $('#attachmentPreview').replaceChildren('📎');
  $('#selectedImageName').textContent = '';
  if (resetInput) for (const id of ['imageInput','gifInput','audioInput','documentInput']) $('#'+id).value = '';
}
function renderDraftImage() {
  if (!state.draftImage) return clearDraftImage(false);
  state.draftAttachment = null;
  const draft = state.draftImage;
  $('#composerMedia').hidden = false;
  $('#attachmentTitle').textContent = draft.name.toLowerCase().endsWith('.gif') ? 'GIF preparado' : 'Imagem preparada';
  const img = document.createElement('img');
  img.src = draft.dataUrl;
  img.alt = '';
  $('#attachmentPreview').replaceChildren(img);
  $('#selectedImageName').textContent = `${draft.name} · ${Math.max(1, Math.round(draft.size / 1024))} KB`;
}
function renderDraftAttachment() {
  const draft = state.draftAttachment;
  if (!draft) return;
  state.draftImage = null;
  $('#composerMedia').hidden = false;
  $('#attachmentPreview').replaceChildren(draft.kind === 'audio' ? '♫' : draft.kind === 'contact' ? '♧' : '▤');
  $('#attachmentTitle').textContent = draft.kind === 'audio' ? 'Áudio preparado' : draft.kind === 'contact' ? 'Contato preparado' : 'Documento preparado';
  $('#selectedImageName').textContent = draft.kind === 'contact' ? draft.contact.name :
    `${draft.file.name} · ${Math.max(1, Math.round(draft.file.size / 1024))} KB`;
}
function toggleAttachmentMenu(open) {
  $('#attachmentMenu').hidden = !open;
  $('#attachmentButton').setAttribute('aria-expanded', String(open));
  if (!open) { $('#contactPicker').hidden = true; $('#attachmentOptions').hidden = false; }
}
function renderShareContacts() {
  const list = $('#shareContactsList');
  list.replaceChildren();
  const contacts = state.conversations.filter(c => !isGroup(c));
  if (!contacts.length) {
    list.append(text('p','', 'Você ainda não tem contatos em suas conversas.'));
  }
  for (const conversation of contacts) {
    const partner=conversation.partner;
    const button=text('button','', '');
    button.type='button';
    button.append(text('span','',partner.name));
    button.addEventListener('click', () => {
      state.draftAttachment = {kind:'contact',contactId:partner.id,contact:partner};
      renderDraftAttachment();
      toggleAttachmentMenu(false);
      $('#messageInput').focus();
    });
    list.append(button);
  }
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
$('#attachmentButton').addEventListener('click', event => {
  event.stopPropagation();
  toggleAttachmentMenu($('#attachmentMenu').hidden);
});
document.addEventListener('click', event => {
  if (!$('#attachmentMenu').contains(event.target) && !$('#attachmentButton').contains(event.target)) toggleAttachmentMenu(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') toggleAttachmentMenu(false);
});
for (const button of document.querySelectorAll('[data-attach]')) {
  button.addEventListener('click', () => {
    const kind=button.dataset.attach;
    if (kind === 'contact') {
      renderShareContacts();
      $('#contactPicker').hidden=false;
      $('#attachmentOptions').hidden=true;
      return;
    }
    toggleAttachmentMenu(false);
    const id={image:'imageInput',gif:'gifInput',audio:'audioInput',document:'documentInput'}[kind];
    $('#' + id).click();
  });
}
$('#backToAttachments').addEventListener('click', () => {
  $('#contactPicker').hidden=true;
  $('#attachmentOptions').hidden=false;
});
for (const id of ['imageInput', 'gifInput']) {
  $('#'+id).addEventListener('change', async event => {
    const file=event.target.files?.[0];
    if (!file) return;
    try { await editor.open(file); }
    catch (error) { showToast(error.message,true); }
    event.target.value = '';
  });
}
for (const [id,kind] of [['audioInput','audio'],['documentInput','document']]) {
  $('#'+id).addEventListener('change', async event => {
    const file=event.target.files?.[0];
    if (!file) return;
    event.target.value='';
    if (file.size <= 0 || file.size > 4_000_000) return showToast('Arquivo de até 4 MB.',true);
    try {
      const dataUrl=await fileToDataUrl(file);
      state.draftAttachment={kind,file:{name:file.name,size:file.size,dataUrl}};
      renderDraftAttachment();
    } catch(error) {showToast(error.message,true);}
  });
}
$('#removeImageButton').addEventListener('click', () => clearDraftImage());
$('#messageForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.selectedId || !state.user) return;
  const input = $('#messageInput');
  const originalText = input.value;
  const draftImage = state.draftImage;
  const attachment = state.draftAttachment;
  const replyToId = state.replyToMessageId;
  if (!originalText.trim() && !draftImage && !attachment) return;
  const button = $('#sendButton');
  button.disabled = true;
  try {
    if (draftImage) {
      await api(`/api/conversations/${state.selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'image', image: { dataUrl: draftImage.dataUrl, name: draftImage.name }, replyToId }),
      });
      clearDraftImage();
    }
    if (attachment) {
      await api(`/api/conversations/${state.selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify(attachment.kind === 'contact'
          ? {kind:'contact',contactId:attachment.contactId,replyToId}
          : {kind:attachment.kind,file:attachment.file,replyToId}),
      });
      clearDraftImage();
    }
    if (originalText.trim()) {
      const ciphertext = encodePegasus(originalText);
      await api(`/api/conversations/${state.selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'text', ciphertext, replyToId }),
      });
      if (input.value === originalText) input.value = '';
      state.drafts.delete(state.selectedId);
      input.style.height = 'auto';
    }
    if (replyToId===state.replyToMessageId) clearReply();
    await refreshAll();
    $('#messageList').scrollTop = $('#messageList').scrollHeight;
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    applyConversationStatus();
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
  if (event.isTrusted) notifyTyping();
});
const voiceRecorder = setupVoiceRecorder({
  getConversationId: () => state.user ? state.selectedId : null,
  getReplyToId: () => state.replyToMessageId,
  canStart: () => !state.draftImage && !state.draftAttachment,
  onError: message => showToast(message, true),
  onSend: async ({conversationId, file, replyToId}) => {
    await api(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({kind: 'audio', file, replyToId}),
    });
    clearReply();
    await refreshAll();
    $('#messageList').scrollTop = $('#messageList').scrollHeight;
  },
});
window.addEventListener('pagehide', () => voiceRecorder.cancel());

$('#backButton').addEventListener('click', () => {
  voiceRecorder.cancel();
  cancelSelection();
  clearReply();
  $('#chatView').classList.remove('chat-open');
});

$('#themeToggle').addEventListener('click',()=>applyTheme(state.theme==='dark'?'light':'dark'));
$('#selectionCancel').addEventListener('click',cancelSelection);
$('#selectionForward').addEventListener('click',()=>openForwardDialog([...state.selectedMessageIds]));
$('#selectionFavorite').addEventListener('click',async()=>{
  const selected=state.messages.filter(m=>state.selectedMessageIds.has(m.id));
  if(!selected.length)return;
  const favorite=!selected.every(m=>m.isFavorite);
  try{
    for(const message of selected) await api(`/api/conversations/${message.conversationId}/messages/${message.id}/favorite`,{method:'POST',body:JSON.stringify({favorite})});
    cancelSelection();await refreshMessages();await refreshAll();showToast(favorite?'Mensagens adicionadas aos favoritos.':'Mensagens removidas dos favoritos.');
  }catch(error){showToast(error.message,true);}
});
$('#selectionDelete').addEventListener('click',deleteSelectedMessages);
$('#cancelReplyButton').addEventListener('click',clearReply);
$('#closeForwardDialog').addEventListener('click',()=>$('#forwardDialog').close());
$('#cancelForwardButton').addEventListener('click',()=>$('#forwardDialog').close());
$('#favoritesButton').addEventListener('click',async()=>{
  const list=$('#favoritesList');list.replaceChildren();
  try{
    const {favorites}=await api('/api/favorites');
    if(!favorites.length)list.append(text('p','empty-panel','Você ainda não favoritou mensagens. Use o botão direito em uma mensagem para salvá-la aqui.'));
    for(const favorite of favorites){
      const button=text('button','favorite-item','');button.type='button';
      button.append(text('strong','',favorite.partner.name),text('span','',favorite.message.kind==='text'?safeDecode(favorite.message.ciphertext):messagePreview(favorite.message)),text('small','',`${readableDay(favorite.message.createdAt)} · ${readableTime(favorite.message.createdAt)}`));
      button.addEventListener('click',async()=>{
        try{
          let convo=state.conversations.find(c=>c.id===favorite.conversationId);
          if(!convo){await api('/api/conversations',{method:'POST',body:JSON.stringify({email:favorite.partner.email})});await refreshAll();convo=state.conversations.find(c=>c.id===favorite.conversationId);}
          $('#favoritesDialog').close();
          if(convo){await selectConversation(convo.id);await jumpToMessage(favorite.message.id);}
        }catch(error){showToast(error.message,true);}
      });
      list.append(button);
    }
    $('#favoritesDialog').showModal();
  }catch(error){showToast(error.message,true);}
});
$('#closeFavoritesDialog').addEventListener('click',()=>$('#favoritesDialog').close());

function renderContactMedia(){
  const list=$('#contactMediaList');list.replaceChildren();
  const media=state.messages.filter(m=>['image','audio','document'].includes(m.kind));
  $('#contactMediaCount').textContent=`${media.length} ${media.length===1?'arquivo':'arquivos'}`;
  if(!media.length){list.append(text('p','empty-panel','Ainda não há imagens, áudios ou documentos nesta conversa.'));return;}
  for(const message of [...media].reverse()){
    const button=text('button','contact-media-item','');button.type='button';
    if(message.kind==='image'){
      const img=document.createElement('img');img.src=message.image.dataUrl;img.alt='';button.append(img);
    }else button.append(text('strong','',message.kind==='audio'?'♫':'▤'));
    const info=text('span','',message.kind==='image'?(message.image.mime==='image/gif'?'GIF':'Imagem'):message.file.name|| (message.kind==='audio'?'Áudio':'Documento'));
    info.append(text('small','',`${message.senderId===state.user.id?'Enviado por você':'Recebido'} · ${readableDay(message.createdAt)}`));
    button.append(info);
    button.addEventListener('click',()=>{
      const file=message.kind==='image'?message.image:message.file;
      const a=document.createElement('a');a.href=file.dataUrl;a.download=file.name||`${message.kind}-pegasus`;document.body.append(a);a.click();a.remove();
    });
    list.append(button);
  }
}
function openContactDetails(){
  const conversation=state.currentConversation;
  if(!conversation)return;
  const partner=conversation.partner;
  $('#contactDetailTitle').textContent=partner.realName||partner.name;
  $('#contactDetailBio').textContent=partner.bio||'Sem texto de perfil.';
  $('#contactDetailEmail').textContent=partner.email||'—';
  $('#contactDetailCode').textContent=partner.friendCode||'—';
  $('#contactDetailStarted').textContent=readableDay(conversation.createdAt);
  $('#contactAliasInput').value=partner.alias||'';
  $('#contactNotificationsEnabled').checked=conversation.notificationsEnabled!==false;
  $('#disappearingSeconds').value=String(conversation.disappearingSeconds||0);
  $('#archiveContactButton').textContent=conversation.archived?'Desarquivar conversa':'Arquivar conversa';
  setAvatar($('#contactDetailAvatar'),partner);
  applyConversationStatus();
  renderContactMedia();
  if (!$('#contactDialog').open) $('#contactDialog').showModal();
}
$('#contactDetailsButton').addEventListener('click',()=>isGroup(state.currentConversation)?openGroupInfo():openContactDetails());
$('#closeContactDialog').addEventListener('click',()=>$('#contactDialog').close());
$('#copyContactEmail').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(state.currentPartner.email);showToast('E-mail copiado.');}catch{showToast(state.currentPartner.email);}});
$('#copyContactCode').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(state.currentPartner.friendCode);showToast('Código copiado.');}catch{showToast(state.currentPartner.friendCode);}});
$('#saveContactPreferences').addEventListener('click',async()=>{
  const conversation=state.currentConversation;if(!conversation)return;
  const notificationsEnabled=$('#contactNotificationsEnabled').checked;
  try{
    if(notificationsEnabled&&'Notification' in window&&Notification.permission==='default') await Notification.requestPermission();
    await api(`/api/conversations/${conversation.id}/preferences`,{method:'PUT',body:JSON.stringify({alias:$('#contactAliasInput').value,notificationsEnabled,disappearingSeconds:Number($('#disappearingSeconds').value)})});
    $('#contactDialog').close();await refreshAll();showToast('Preferências do contato salvas.');
  }catch(error){showToast(error.message,true);}
});
$('#clearConversationButton').addEventListener('click',async()=>{
  const conversation=state.currentConversation;if(!conversation)return;
  if(!await customConfirm('Limpar conversa', 'Limpar esta conversa apenas para você? A outra pessoa manterá o histórico dela.'))return;
  try{await api(`/api/conversations/${conversation.id}/clear`,{method:'POST',body:'{}'});cancelSelection();$('#contactDialog').close();await refreshAll();showToast('Conversa limpa para você.');}
  catch(error){showToast(error.message,true);}
});
$('#blockContactButton').addEventListener('click',async()=>{
  const conversation=state.currentConversation;if(!conversation)return;
  const action=conversation.blockedByMe?'unblock':'block';
  if(action==='block'&&!await customConfirm('Bloquear contato', `Bloquear ${conversation.partner.name}? Nenhum dos dois poderá enviar mensagens enquanto o bloqueio estiver ativo.`))return;
  try{await api(`/api/conversations/${conversation.id}/${action}`,{method:'POST',body:'{}'});await refreshAll();openContactDetails();showToast(action==='block'?'Contato bloqueado.':'Contato desbloqueado.');}
  catch(error){showToast(error.message,true);}
});
$('#deleteContactButton').addEventListener('click',async()=>{
  const conversation=state.currentConversation;if(!conversation)return;
  if(!await customConfirm('Excluir contato', `Excluir ${conversation.partner.name} da sua lista e ocultar esta conversa para você? A outra pessoa manterá o próprio histórico.`))return;
  try{
    await api(`/api/conversations/${conversation.id}/contact`,{method:'DELETE'});
    $('#contactDialog').close();state.selectedId=null;state.currentConversation=null;state.currentPartner=null;state.messages=[];
    $('#conversationView').hidden=true;$('#welcomeScreen').hidden=false;$('#chatView').classList.remove('chat-open');cancelSelection();clearReply();await refreshAll();showToast('Contato excluído da sua lista.');
  }catch(error){showToast(error.message,true);}
});

$('#archiveToggle').addEventListener('click',()=>{state.showArchived=!state.showArchived;$('#archiveToggle').classList.toggle('active',state.showArchived);$('#archiveToggle').title=state.showArchived?'Voltar às conversas':'Conversas arquivadas';renderConversations();});
$('#archiveContactButton').addEventListener('click',async()=>{const conversation=state.currentConversation;if(!conversation)return;try{await api(`/api/conversations/${conversation.id}/preferences`,{method:'PUT',body:JSON.stringify({archived:!conversation.archived})});$('#contactDialog').close();await refreshAll();renderConversations();showToast(conversation.archived?'Conversa desarquivada.':'Conversa arquivada.');}catch(error){showToast(error.message,true);}});
$('#searchMessagesButton').addEventListener('click',()=>{$('#searchMessagesDialog').showModal();$('#searchMessagesInput').focus();});
$('#closeSearchMessages').addEventListener('click',()=>$('#searchMessagesDialog').close());
$('#searchMessagesForm').addEventListener('submit',async event=>{event.preventDefault();const query=$('#searchMessagesInput').value.trim();if(query.length<2)return;const list=$('#searchMessagesResults');list.replaceChildren();list.append(text('p','empty-panel','Buscando…'));try{const {results}=await api(`/api/search?q=${encodeURIComponent(query)}`);list.replaceChildren();if(!results.length){list.append(text('p','empty-panel','Nenhuma mensagem encontrada.'));return;}for(const result of results){const button=text('button','favorite-item','');button.type='button';button.append(text('strong','',result.partner.name),text('span','',result.match),text('small','',`${readableDay(result.message.createdAt)} · ${readableTime(result.message.createdAt)}`));button.addEventListener('click',async()=>{$('#searchMessagesDialog').close();let convo=state.conversations.find(c=>c.id===result.conversationId);if(!convo){await refreshAll();convo=state.conversations.find(c=>c.id===result.conversationId);}if(convo){if(convo.archived){state.showArchived=true;renderConversations();}await selectConversation(convo.id);await jumpToMessage(result.message.id);}});list.append(button);}}catch(error){list.replaceChildren();list.append(text('p','empty-panel',error.message));}});
$('#pinnedMessagesButton').addEventListener('click',async()=>{if(!state.selectedId)return;const list=$('#pinnedMessagesList');list.replaceChildren();try{const {messages}=await api(`/api/conversations/${state.selectedId}/pins`);if(!messages.length)list.append(text('p','empty-panel','Nenhuma mensagem fixada nesta conversa.'));for(const message of messages){const button=text('button','favorite-item','');button.type='button';button.append(text('strong','',message.senderId===state.user.id?'Você':state.currentPartner?.name||'Contato'),text('span','',messagePreview(message)),text('small','',`${readableDay(message.createdAt)} · ${readableTime(message.createdAt)}`));button.addEventListener('click',async()=>{$('#pinnedMessagesDialog').close();await jumpToMessage(message.id);});list.append(button);}$('#pinnedMessagesDialog').showModal();}catch(error){showToast(error.message,true);}});
$('#closePinnedMessages').addEventListener('click',()=>$('#pinnedMessagesDialog').close());

// ===== Digitando, rascunhos e formatação de texto =====
function setTyping(conversationId, userId, name) {
  let members = state.typing.get(conversationId);
  if (!members) { members = new Map(); state.typing.set(conversationId, members); }
  clearTimeout(members.get(userId)?.timer);
  const timer = setTimeout(() => clearTyping(conversationId, userId), 5000);
  members.set(userId, { name, timer });
  updateTypingUi();
}
function clearTyping(conversationId, userId) {
  const members = state.typing.get(conversationId);
  if (!members?.has(userId)) return;
  clearTimeout(members.get(userId).timer);
  members.delete(userId);
  if (!members.size) state.typing.delete(conversationId);
  updateTypingUi();
}
function typingLabel(conversation) {
  const members = state.typing.get(conversation?.id);
  if (!members?.size) return '';
  const names = [...members.values()].map(entry => entry.name);
  if (!isGroup(conversation)) return 'digitando…';
  return names.length === 1 ? `${names[0]} está digitando…` : `${names.slice(0, 2).join(' e ')} estão digitando…`;
}
function updateTypingUi() { if (state.user) { renderConversations(); renderChatHeader(); } }
let lastTypingSent = 0;
function notifyTyping() {
  if (!state.selectedId || !$('#messageInput').value.trim()) return;
  const now = Date.now();
  if (now - lastTypingSent < 3000) return;
  lastTypingSent = now;
  api(`/api/conversations/${state.selectedId}/typing`, { method: 'POST', body: '{}' }).catch(() => {});
}
function saveDraft() {
  if (state.selectedId == null) return;
  const value = $('#messageInput').value;
  if (value.trim()) state.drafts.set(state.selectedId, value); else state.drafts.delete(state.selectedId);
}
function restoreDraft(id) {
  const input = $('#messageInput');
  input.value = state.drafts.get(id) || '';
  input.style.height = 'auto';
  if (input.value) input.style.height = `${Math.min(140, input.scrollHeight)}px`;
}
function memberName(userId) {
  if (userId === state.user?.id) return 'Você';
  return state.currentConversation?.group?.members?.find(member => member.id === userId)?.name || 'Ex-participante';
}

// Formatação estilo WhatsApp/Telegram: *negrito*, _itálico_, ~riscado~, `código`, ```bloco``` e links.
const FORMAT_PATTERN = new RegExp([
  '(?<block>```[\\s\\S]+?```)',
  '(?<code>`[^`\\n]+`)',
  '(?<bold>(?<![\\w*])\\*(?=\\S)[^*\\n]*?\\S\\*(?![\\w*]))',
  '(?<italic>(?<![\\w_])_(?=\\S)[^_\\n]*?\\S_(?![\\w_]))',
  '(?<strike>(?<![\\w~])~(?=\\S)[^~\\n]*?\\S~(?![\\w~]))',
  '(?<url>https?:\\/\\/[^\\s<>"\']+)',
].join('|'), 'gu');
function formatText(value, depth = 0) {
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of value.matchAll(FORMAT_PATTERN)) {
    if (match.index > last) fragment.append(value.slice(last, match.index));
    const token = match[0];
    const kind = Object.entries(match.groups).find(([, v]) => v !== undefined)?.[0];
    if (kind === 'block') {
      fragment.append(text('span', 'message-codeblock', token.slice(3, -3).replace(/^\n/, '')));
    } else if (kind === 'code') {
      fragment.append(text('code', 'message-code', token.slice(1, -1)));
    } else if (kind === 'url') {
      let url = token, trail = '';
      while (/[.,;:!?)\]]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocolo');
        const link = document.createElement('a');
        link.className = 'message-link'; link.href = parsed.href; link.textContent = url;
        link.target = '_blank'; link.rel = 'noopener noreferrer nofollow';
        fragment.append(link, trail);
      } catch { fragment.append(token); }
    } else {
      const element = document.createElement(kind === 'bold' ? 'strong' : kind === 'italic' ? 'em' : 's');
      const inner = token.slice(1, -1);
      if (depth < 2) element.append(formatText(inner, depth + 1)); else element.textContent = inner;
      fragment.append(element);
    }
    last = match.index + token.length;
  }
  if (last < value.length) fragment.append(value.slice(last));
  return fragment;
}

// ===== Grupos =====
function avatarFromFile(file) {
  return new Promise(async (resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return reject(new Error('Escolha PNG, JPG ou WEBP.'));
    try {
      const url = await fileToDataUrl(file);
      const img = await new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => fail(new Error('Imagem inválida.')); im.src = url; });
      const canvas = document.createElement('canvas');
      canvas.width = 160; canvas.height = 160;
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 160, 160);
      let result = canvas.toDataURL('image/jpeg', .83);
      if (result.length > 320_000) result = canvas.toDataURL('image/jpeg', .6);
      resolve(result);
    } catch (error) { reject(error); }
  });
}
function showGroupAvatar(element, avatar) {
  element.replaceChildren();
  if (avatar) setAvatar(element, { name: 'G', avatar }); else element.textContent = '👥';
}
function candidateContacts(excludeUserIds = []) {
  return state.conversations.filter(c => c.kind === 'direct' && !c.blockedByMe && !c.blockedByPartner && !excludeUserIds.includes(c.partner.id));
}
function renderContactPicker(container, contacts, selected, onChange, filter = '') {
  container.replaceChildren();
  const query = filter.trim().toLocaleLowerCase('pt-BR');
  const shown = contacts.filter(c => !query || c.partner.name.toLocaleLowerCase('pt-BR').includes(query));
  if (!shown.length) {
    container.append(text('p', 'empty-panel', contacts.length ? 'Nenhum contato encontrado.' : 'Você ainda não tem contatos disponíveis. Inicie conversas primeiro.'));
    return;
  }
  for (const conversation of shown) {
    const userId = conversation.partner.id;
    const label = text('label', 'group-contact-item', '');
    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = selected.has(userId);
    box.addEventListener('change', () => { if (box.checked) selected.add(userId); else selected.delete(userId); onChange(); });
    const avatar = text('div', 'contact-avatar small', '');
    setAvatar(avatar, conversation.partner);
    label.append(box, avatar, text('span', '', conversation.partner.name));
    container.append(label);
  }
}
const countLabel = n => `${n} ${n === 1 ? 'selecionado' : 'selecionados'}`;

const groupCreate = { avatar: '', selected: new Set() };
function renderGroupCreatePicker() {
  renderContactPicker($('#groupCreateContacts'), candidateContacts(), groupCreate.selected,
    () => { $('#groupCreateCount').textContent = countLabel(groupCreate.selected.size); }, $('#groupCreateFilter').value);
  $('#groupCreateCount').textContent = countLabel(groupCreate.selected.size);
}
function openGroupCreate() {
  if ($('#newChatDialog').open) $('#newChatDialog').close();
  groupCreate.avatar = ''; groupCreate.selected = new Set();
  $('#groupCreateForm').reset();
  showGroupAvatar($('#groupCreatePreview'), '');
  renderGroupCreatePicker();
  $('#groupCreateDialog').showModal();
  $('#groupCreateTitle').focus();
}
$('#openGroupCreate').addEventListener('click', openGroupCreate);
$('#closeGroupCreate').addEventListener('click', () => $('#groupCreateDialog').close());
$('#groupCreateFilter').addEventListener('input', renderGroupCreatePicker);
$('#groupCreateFilter').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
$('#groupCreateAvatarInput').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try { groupCreate.avatar = await avatarFromFile(file); showGroupAvatar($('#groupCreatePreview'), groupCreate.avatar); }
  catch (error) { showToast(error.message, true); }
  event.target.value = '';
});
$('#groupCreateRemoveAvatar').addEventListener('click', () => { groupCreate.avatar = ''; showGroupAvatar($('#groupCreatePreview'), ''); });
$('#groupCreateForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!groupCreate.selected.size) { showToast('Escolha ao menos um participante.', true); return; }
  const button = $('#groupCreateSubmit'); button.disabled = true;
  try {
    const { conversationId } = await api('/api/groups', { method: 'POST', body: JSON.stringify({
      title: $('#groupCreateTitle').value, description: $('#groupCreateDescription').value,
      avatar: groupCreate.avatar, memberIds: [...groupCreate.selected],
    }) });
    $('#groupCreateDialog').close();
    await refreshAll();
    await selectConversation(conversationId);
    showToast('Grupo criado!');
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});

let groupEditAvatar = null; // null = sem alteração; '' = remover foto
let groupAddSelected = new Set();
async function openGroupInfo() {
  const conversation = state.currentConversation;
  if (!isGroup(conversation)) return;
  try {
    const { group } = await api(`/api/groups/${conversation.id}`);
    state.groupDetail = group;
    groupEditAvatar = null; groupAddSelected = new Set();
    $('#groupEditTitle').value = group.title;
    $('#groupEditDescription').value = group.description;
    showGroupAvatar($('#groupEditPreview'), group.avatar);
    $('#groupNotificationsEnabled').checked = conversation.notificationsEnabled !== false;
    $('#groupDisappearingSeconds').value = String(conversation.disappearingSeconds || 0);
    renderGroupInfo();
    if (!$('#groupInfoDialog').open) $('#groupInfoDialog').showModal();
  } catch (error) { showToast(error.message, true); }
}
function renderGroupInfo() {
  const group = state.groupDetail;
  if (!group) return;
  const admin = group.myRole === 'admin';
  $('#groupInfoTitle').textContent = group.title;
  $('#groupInfoDescription').textContent = group.description || 'Sem descrição.';
  showGroupAvatar($('#groupInfoAvatar'), group.avatar);
  $('#groupAdminEdit').hidden = !admin;
  $('#groupMemberCount').textContent = `${group.members.length} ${group.members.length === 1 ? 'participante' : 'participantes'}`;
  const list = $('#groupMemberList');
  list.replaceChildren();
  for (const member of group.members) {
    const row = text('div', 'group-member', '');
    const avatar = text('div', 'contact-avatar small', '');
    setAvatar(avatar, member);
    const info = text('span', 'group-member-info', '');
    info.append(text('strong', '', member.id === state.user.id ? `${member.name} (você)` : member.name));
    if (member.bio) info.append(text('small', '', member.bio));
    row.append(avatar, info);
    if (member.role === 'admin') row.append(text('span', 'role-badge', 'Admin'));
    if (admin && member.id !== state.user.id) {
      const actions = text('span', 'group-member-actions', '');
      const roleButton = text('button', 'mini-action', member.role === 'admin' ? 'Remover admin' : 'Tornar admin');
      roleButton.type = 'button';
      roleButton.addEventListener('click', () => changeMemberRole(member, member.role === 'admin' ? 'member' : 'admin'));
      actions.append(roleButton);
      if (member.role === 'member') {
        const removeButton = text('button', 'mini-action danger', 'Remover');
        removeButton.type = 'button';
        removeButton.addEventListener('click', () => removeGroupMember(member));
        actions.append(removeButton);
      }
      row.append(actions);
    }
    list.append(row);
  }
  const candidates = candidateContacts(group.members.map(m => m.id));
  $('#groupAddSection').hidden = !admin || group.members.length >= 50;
  renderContactPicker($('#groupAddContacts'), candidates, groupAddSelected,
    () => { $('#groupAddCount').textContent = countLabel(groupAddSelected.size); });
  $('#groupAddCount').textContent = countLabel(groupAddSelected.size);
}
async function changeMemberRole(member, role) {
  try {
    const { group } = await api(`/api/groups/${state.groupDetail.id}/members/${member.id}/role`, { method: 'POST', body: JSON.stringify({ role }) });
    state.groupDetail = group; renderGroupInfo(); await refreshAll();
  } catch (error) { showToast(error.message, true); }
}
async function removeGroupMember(member) {
  if (!await customConfirm('Remover participante', `Remover ${member.name} do grupo?`)) return;
  try {
    await api(`/api/groups/${state.groupDetail.id}/members/${member.id}`, { method: 'DELETE' });
    const { group } = await api(`/api/groups/${state.groupDetail.id}`);
    state.groupDetail = group; renderGroupInfo(); await refreshAll();
    showToast(`${member.name} foi removido.`);
  } catch (error) { showToast(error.message, true); }
}
async function leaveGroup(conversation) {
  if (!await customConfirm('Sair do grupo', `Sair de “${conversation.partner.name}”? Você deixará de receber as mensagens deste grupo.`)) return;
  await api(`/api/groups/${conversation.id}/members/${state.user.id}`, { method: 'DELETE' });
  if ($('#groupInfoDialog').open) $('#groupInfoDialog').close();
  if (state.selectedId === conversation.id) closeConversationView();
  await refreshAll();
  showToast('Você saiu do grupo.');
}
$('#closeGroupInfo').addEventListener('click', () => $('#groupInfoDialog').close());
$('#groupEditAvatarInput').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try { groupEditAvatar = await avatarFromFile(file); showGroupAvatar($('#groupEditPreview'), groupEditAvatar); }
  catch (error) { showToast(error.message, true); }
  event.target.value = '';
});
$('#groupEditRemoveAvatar').addEventListener('click', () => { groupEditAvatar = ''; showGroupAvatar($('#groupEditPreview'), ''); });
$('#groupEditSave').addEventListener('click', async () => {
  const group = state.groupDetail; if (!group) return;
  try {
    const body = { title: $('#groupEditTitle').value, description: $('#groupEditDescription').value };
    if (groupEditAvatar !== null) body.avatar = groupEditAvatar;
    const result = await api(`/api/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    state.groupDetail = result.group; groupEditAvatar = null;
    renderGroupInfo(); await refreshAll();
    showToast('Informações do grupo atualizadas.');
  } catch (error) { showToast(error.message, true); }
});
$('#groupAddSubmit').addEventListener('click', async () => {
  const group = state.groupDetail;
  if (!group || !groupAddSelected.size) { showToast('Escolha quem você quer adicionar.', true); return; }
  try {
    const result = await api(`/api/groups/${group.id}/members`, { method: 'POST', body: JSON.stringify({ memberIds: [...groupAddSelected] }) });
    state.groupDetail = result.group; groupAddSelected = new Set();
    renderGroupInfo(); await refreshAll();
    showToast('Participantes adicionados.');
  } catch (error) { showToast(error.message, true); }
});
$('#groupSavePrefs').addEventListener('click', async () => {
  const conversation = state.currentConversation; if (!isGroup(conversation)) return;
  const notificationsEnabled = $('#groupNotificationsEnabled').checked;
  try {
    if (notificationsEnabled && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    await api(`/api/conversations/${conversation.id}/preferences`, { method: 'PUT', body: JSON.stringify({ notificationsEnabled, disappearingSeconds: Number($('#groupDisappearingSeconds').value) }) });
    $('#groupInfoDialog').close(); await refreshAll();
    showToast('Preferências do grupo salvas.');
  } catch (error) { showToast(error.message, true); }
});
$('#groupClearButton').addEventListener('click', async () => {
  const conversation = state.currentConversation; if (!isGroup(conversation)) return;
  if (!await customConfirm('Limpar conversa', 'Limpar esta conversa apenas para você? Os outros participantes manterão o histórico.')) return;
  try { await api(`/api/conversations/${conversation.id}/clear`, { method: 'POST', body: '{}' }); cancelSelection(); $('#groupInfoDialog').close(); await refreshAll(); showToast('Conversa limpa para você.'); }
  catch (error) { showToast(error.message, true); }
});
$('#groupLeaveButton').addEventListener('click', () => {
  const conversation = state.currentConversation;
  if (isGroup(conversation)) leaveGroup(conversation).catch(error => showToast(error.message, true));
});

try { applyTheme(localStorage.getItem('pegasus-theme') || 'dark', false); } catch { applyTheme('dark', false); }
(async function startup() {
  try {
    const { user } = await api('/api/me');
    enterApp(user);
  } catch {
    // Sem sessão é esperado quando se abre o Pegasus pela primeira vez.
  }
})();