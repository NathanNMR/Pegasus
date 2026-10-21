import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { encodePegasus, decodePegasus } from '../public/cipher.js';

async function launch(dataDir) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', PEGASUS_DATA_DIR: dataDir, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Servidor não iniciou: ' + logs)), 12000);
    const onData = buf => {
      logs += buf.toString();
      const match = logs.match(/PEGASUS_READY (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve({ child, base: match[1] });
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', code => { clearTimeout(timer); reject(new Error('Servidor encerrou: ' + code + ', ' + logs)); });
    child.stderr.on('data', buf => { logs += buf.toString(); });
  });
}
function client(base) {
  let cookie = '';
  async function req(url, method = 'GET', body = undefined) {
    const response = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, data: await response.json() };
  }
  return { req, get cookie() { return cookie; } };
}

const tinyGif = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2m0n4AAAAASUVORK5CYII=';

test('cadastra 2 usuários, envia texto e imagem e preserva histórico após reiniciar', { timeout: 45000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pegasus-test-'));
  let first, second;
  try {
    first = await launch(dataDir);
    const a = client(first.base);
    const b = client(first.base);
    assert.equal((await a.req('/api/health')).data.ok, true);
    const landing = await fetch(first.base);
    assert.equal(landing.status, 200);
    assert.ok((await (await fetch(first.base + '/styles.css')).text()).includes('backdrop-filter'));
    const registeredAlice = await a.req('/api/register', 'POST', { name: 'Alice', email: 'alice@example.test', password: 'SecretPass#123' });
    assert.equal(registeredAlice.status, 200);
    assert.match(registeredAlice.data.user.friendCode, /^[A-Z0-9]{6}$/);
    const registeredBruno = await b.req('/api/register', 'POST', { name: 'Bruno', email: 'bruno@example.test', password: 'SecretPass#987' });
    assert.equal(registeredBruno.status, 200);
    assert.match(registeredBruno.data.user.friendCode, /^[A-Z0-9]{6}$/);
    assert.notEqual(registeredBruno.data.user.friendCode, registeredAlice.data.user.friendCode);
    assert.equal((await a.req('/api/register', 'POST', { name: 'Duplicado', email: 'alice@example.test', password: 'SecretPass#123' })).status, 409);

    const unauth = client(first.base);
    assert.equal((await unauth.req('/api/conversations')).status, 401);
    assert.equal((await a.req('/api/conversations', 'POST', { email: 'alice@example.test' })).status, 400);

    const newConversation = await a.req('/api/conversations', 'POST', { friendCode: registeredBruno.data.user.friendCode.toLowerCase() });
    assert.equal(newConversation.status, 200);
    const conversationId = newConversation.data.conversationId;
    assert.equal((await a.req('/api/conversations', 'POST', { email: 'bruno@example.test' })).data.conversationId, conversationId);
    assert.equal((await a.req('/api/conversations', 'POST', { friendCode: 'XXXXXX' })).status, 404);
    assert.equal((await b.req('/api/conversations')).data.conversations[0].id, conversationId);

    const eventController = new AbortController();
    const eventResponse = await fetch(first.base + '/api/events', { headers: { Cookie: b.cookie }, signal: eventController.signal });
    assert.equal(eventResponse.status, 200);
    const eventReader = eventResponse.body.getReader();
    await eventReader.read();
    const incoming = eventReader.read();

    const secret = 'Olá, Bruno! 1234567890 😃🪽🐎';
    const ciphertext = encodePegasus(secret);
    const sentText = await a.req(`/api/conversations/${conversationId}/messages`, 'POST', { kind: 'text', ciphertext });
    assert.equal(sentText.status, 201);

    const sentImage = await a.req(`/api/conversations/${conversationId}/messages`, 'POST', {
      kind: 'image',
      image: { dataUrl: tinyPng, name: 'estrela.png' },
    });
    assert.equal(sentImage.status, 201);
    assert.equal(sentImage.data.message.kind, 'image');

    const sentGif = await a.req(`/api/conversations/${conversationId}/messages`, 'POST', {
      kind: 'image', image: { dataUrl: tinyGif, name: 'estrela.gif' },
    });
    assert.equal(sentGif.status, 201);
    assert.equal(sentGif.data.message.image.mime, 'image/gif');

    const event = await Promise.race([
      incoming,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Evento SSE não chegou.')), 3500)),
    ]);
    assert.match(new TextDecoder().decode(event.value), /event: refresh/);
    eventController.abort();

    const inbox = await b.req(`/api/conversations/${conversationId}/messages`);
    assert.equal(inbox.status, 200);
    assert.equal(inbox.data.messages.length, 3);
    assert.equal(inbox.data.messages[0].kind, 'text');
    assert.equal(decodePegasus(inbox.data.messages[0].ciphertext), secret);
    assert.equal(inbox.data.messages[1].kind, 'image');
    assert.equal(inbox.data.messages[1].image.name, 'estrela.png');
    assert.equal(inbox.data.messages[1].image.mime, 'image/png');
    assert.equal(inbox.data.messages[2].image.mime, 'image/gif');
    assert.match(inbox.data.messages[1].image.dataUrl, /^data:image\/png;base64,/);

    const conversations = await b.req('/api/conversations');
    assert.equal(conversations.data.conversations[0].lastMessage.kind, 'image');
    assert.match(conversations.data.conversations[0].lastMessage.preview, /GIF/);
    assert.doesNotMatch(conversations.data.conversations[0].lastMessage.preview, /estrela/);

    assert.equal((await unauth.req(`/api/conversations/${conversationId}/messages`)).status, 401);
    assert.equal((await a.req(`/api/conversations/${conversationId}/messages`, 'POST', { kind: 'text', ciphertext: 'OLA123' })).status, 400);
    assert.equal((await a.req(`/api/conversations/${conversationId}/messages`, 'POST', { kind: 'image', image: { dataUrl: 'data:text/plain;base64,SGVsbG8=', name: 'x.txt' } })).status, 400);

    // Apenas o próprio autor pode editar/apagar; mudanças não deixam mensagens de aviso.
    const textId = inbox.data.messages[0].id;
    const imageId = inbox.data.messages[1].id;
    assert.equal((await b.req(`/api/conversations/${conversationId}/messages/${textId}`, 'PATCH', { ciphertext: encodePegasus('intruso') })).status, 403);
    assert.equal((await b.req(`/api/conversations/${conversationId}/messages/${imageId}`, 'DELETE')).status, 403);
    assert.equal((await a.req(`/api/conversations/${conversationId}/messages/${imageId}`, 'PATCH', { ciphertext: encodePegasus('imagem alterada') })).status, 400);
    const updatedText = 'Mensagem corrigida discretamente! 🪽';
    assert.equal((await a.req(`/api/conversations/${conversationId}/messages/${textId}`, 'PATCH', { ciphertext: encodePegasus(updatedText) })).status, 200);
    const amended = await b.req(`/api/conversations/${conversationId}/messages`);
    assert.equal(decodePegasus(amended.data.messages[0].ciphertext), updatedText);
    assert.equal(amended.data.messages[0].revision, 1);
    assert.ok(!amended.data.messages.some(m => m.kind === 'notice'));

    first.child.kill('SIGTERM');
    await once(first.child, 'exit');
    first = null;

    second = await launch(dataDir);
    const loggedAgain = client(second.base);
    assert.equal((await loggedAgain.req('/api/login', 'POST', { email: 'bruno@example.test', password: 'SecretPass#987' })).status, 200);
    const history = await loggedAgain.req(`/api/conversations/${conversationId}/messages`);
    assert.equal(decodePegasus(history.data.messages[0].ciphertext), 'Mensagem corrigida discretamente! 🪽');
    assert.equal(history.data.messages[1].image.name, 'estrela.png');
    assert.equal(history.data.messages[2].image.mime, 'image/gif');
    assert.equal((await loggedAgain.req('/api/me')).data.user.friendCode, registeredBruno.data.user.friendCode);
    const loggedAlice = client(second.base);
    assert.equal((await loggedAlice.req('/api/login', 'POST', { email: 'alice@example.test', password: 'SecretPass#123' })).status, 200);
    assert.equal((await loggedAlice.req(`/api/conversations/${conversationId}/messages/${history.data.messages[1].id}`, 'DELETE')).status, 200);
    const afterDelete = await loggedAgain.req(`/api/conversations/${conversationId}/messages`);
    assert.equal(afterDelete.data.messages.length, 2);
    assert.ok(!afterDelete.data.messages.some(m => m.preview?.includes('apagada') || m.kind === 'notice'));
    assert.equal((await loggedAgain.req('/api/logout', 'POST', {})).status, 200);
    assert.equal((await loggedAgain.req('/api/me')).status, 401);
  } finally {
    if (first?.child && first.child.exitCode === null) { first.child.kill('SIGTERM'); await once(first.child, 'exit'); }
    if (second?.child && second.child.exitCode === null) { second.child.kill('SIGTERM'); await once(second.child, 'exit'); }
    await rm(dataDir, { recursive: true, force: true });
  }
});
