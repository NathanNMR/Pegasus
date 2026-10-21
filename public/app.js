import { encodePegasus, decodePegasus } from './cipher.js';

const $ = selector => document.querySelector(selector);
const state = { user: null, conversations: [], selectedId: null, messages: [], events: null, authMode: 'login', currentPartner: null };
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
  try { return decodePegasus(ciphertext); } catch { return 'Não foi possível interpretar esta mensagem.'; }
}
async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch { throw new Error('Não foi possível conectar ao servidor Pegasus.'); }
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
  $('#authTitle').textContent = register ? 'Crie seu espaço.' : 'Entre no seu universo.';
  $('#authSubtitle').textContent = register ? 'Comece uma nova história, uma mensagem de cada vez.' : 'Entre com sua conta para continuar suas conversas.';
  $('#authSubmit').firstElementChild.textContent = register ? 'Criar minha conta' : 'Entrar no Pegasus';
}
function enterApp(user) {
  state.user = user;
  $('#authView').hidden = true;
  $('#chatView').hidden = false;
  $('#myName').textContent = user.name;
  $('#myEmail').textContent = user.email;
  $('#myAvatar').textContent = initials(user.name);
  if (state.events) state.events.close();
  state.events = new EventSource('/api/events');
  state.events.addEventListener('refresh', () => refreshAll());
  state.events.addEventListener('error', () => { /* EventSource reconecta automaticamente */ });
  refreshAll();
}
function signOut(notify = true) {
  state.events?.close();
  state.events = null;
  state.user = null;
  state.selectedId = null;
  state.messages = [];
  state.conversations = [];
  $('#chatView').hidden = true;
  $('#authView').hidden = false;
  $('#messageInput').value = '';
  $('#authForm').reset();
  $('#chatView').classList.remove('chat-open');
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
    item.type = 'button'; item.className = 'conversation-item';
    item.classList.toggle('selected', conversation.id === state.selectedId);
    item.addEventListener('click', () => selectConversation(conversation.id));
    item.append(text('div', 'contact-avatar', initials(conversation.partner.name)));
    const content = text('div', 'conversation-text', '');
    const nameLine = text('div', 'conversation-name-row', '');
    nameLine.append(text('strong', '', conversation.partner.name));
    nameLine.append(text('time', '', conversation.lastMessage ? readableTime(conversation.lastMessage.createdAt) : ''));
    content.append(nameLine);
    const last = conversation.lastMessage ? safeDecode(conversation.lastMessage.ciphertext).replace(/\s+/g, ' ') : 'Diga olá! ✨';
    content.append(text('span', 'conversation-preview', last));
    item.append(content);
    list.append(item);
  }
}
async function selectConversation(id) {
  if (!state.user) return;
  state.selectedId = id;
  state.messages = [];
  renderMessages();
  const conversation = state.conversations.find(item => item.id === id);
  if (!conversation) return;
  state.currentPartner = conversation.partner;
  $('#partnerName').textContent = conversation.partner.name;
  $('#partnerEmail').textContent = conversation.partner.email;
  $('#partnerAvatar').textContent = initials(conversation.partner.name);
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
  const previousCount = state.messages.length;
  const previousLast = state.messages.at(-1)?.id;
  const scrollbox = $('#messageList');
  const isNearBottom = scrollbox.scrollHeight - scrollbox.scrollTop - scrollbox.clientHeight < 110;
  state.messages = messages;
  if (previousCount === messages.length && previousLast === messages.at(-1)?.id) return;
  renderMessages();
  if (isNearBottom || previousCount === 0) requestAnimationFrame(() => { scrollbox.scrollTop = scrollbox.scrollHeight; });
}
function renderMessages() {
  const list = $('#messageList');
  list.replaceChildren();
  if (!state.messages.length) {
    const empty = text('div', 'messages-empty', '');
    empty.append(text('div', 'messages-empty-icon', '✧'));
    empty.append(text('h3', '', 'Uma conversa só de vocês.'));
    empty.append(text('p', '', 'Envie a primeira mensagem para começar a história.'));
    list.append(empty);
    return;
  }
  let previousDate = '';
  for (const message of state.messages) {
    const date = readableDay(message.createdAt);
    if (date !== previousDate) { list.append(text('div', 'date-divider', date)); previousDate = date; }
    const mine = message.senderId === state.user.id;
    const wrapper = text('div', `message-row ${mine ? 'mine' : 'theirs'}`, '');
    const bubble = text('div', 'message-bubble', '');
    bubble.append(text('p', 'message-body', safeDecode(message.ciphertext)));
    const details = text('div', 'message-details', '');
    details.append(text('time', '', readableTime(message.createdAt)));
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'cipher-toggle';
    toggle.textContent = 'Ver código PG1';
    toggle.setAttribute('aria-label', 'Mostrar ou ocultar código Pegasus da mensagem');
    const code = text('pre', 'cipher-output', message.ciphertext);
    code.hidden = true;
    toggle.addEventListener('click', () => {
      code.hidden = !code.hidden;
      toggle.textContent = code.hidden ? 'Ver código PG1' : 'Ocultar código';
    });
    details.append(toggle);
    bubble.append(details, code);
    wrapper.append(bubble);
    list.append(wrapper);
  }
}
function openNewChat() {
  const dialog = $('#newChatDialog');
  $('#newChatForm').reset();
  dialog.showModal();
  $('#contactEmail').focus();
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
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});
$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); }
  catch (error) { showToast(error.message, true); }
  signOut();
});
$('#searchInput').addEventListener('input', renderConversations);
$('#newChatButton').addEventListener('click', openNewChat);
$('#welcomeNewChat').addEventListener('click', openNewChat);
$('#closeDialog').addEventListener('click', () => $('#newChatDialog').close());
$('#newChatDialog').addEventListener('click', event => {
  if (event.target === $('#newChatDialog')) $('#newChatDialog').close();
});
$('#newChatForm').addEventListener('submit', async event => {
  event.preventDefault();
  const email = $('#contactEmail').value.trim();
  const button = $('#createChatSubmit'); button.disabled = true;
  try {
    const { conversationId } = await api('/api/conversations', {
      method: 'POST', body: JSON.stringify({ email }),
    });
    $('#newChatDialog').close();
    await refreshAll();
    await selectConversation(conversationId);
    showToast('Conversa pronta!');
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});
$('#messageForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.selectedId || !state.user) return;
  const input = $('#messageInput');
  const originalText = input.value;
  if (!originalText.trim()) return;
  const button = $('#sendButton'); button.disabled = true;
  const conversationId = state.selectedId;
  try {
    const ciphertext = encodePegasus(originalText);
    await api(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ ciphertext }),
    });
    if (input.value === originalText) input.value = '';
    input.style.height = 'auto';
    await refreshAll();
    $('#messageList').scrollTop = $('#messageList').scrollHeight;
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; input.focus(); }
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
