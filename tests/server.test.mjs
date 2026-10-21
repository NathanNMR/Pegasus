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
      if (match) { clearTimeout(timer); child.stdout.off('data', onData); resolve({ child, base: match[1] }); }
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
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, data: await response.json() };
  }
  return { req, get cookie() { return cookie; } };
}

// Teste ponta a ponta da lógica de autenticação e entrega, sem navegador ou bibliotecas externas.
test('cadastra 2 usuários, inicia conversa, cifra mensagem e preserva persistência', { timeout: 45000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pegasus-test-'));
  let first, second;
  try {
    first = await launch(dataDir);
    const a = client(first.base);
    const b = client(first.base);
    assert.equal((await a.req('/api/health')).data.ok, true);
    const landing = await fetch(first.base);
    assert.equal(landing.status, 200);
    assert.ok((await landing.text()).includes('Liquid Glass') === false);
    assert.ok((await (await fetch(first.base + '/styles.css')).text()).includes('backdrop-filter'));
    assert.equal((await a.req('/api/register', 'POST', { name: 'Alice', email: 'alice@example.test', password: 'SecretPass#123' })).status, 200);
    assert.equal((await b.req('/api/register', 'POST', { name: 'Bruno', email: 'bruno@example.test', password: 'SecretPass#987' })).status, 200);
    assert.equal((await a.req('/api/register', 'POST', { name: 'Duplicado', email: 'alice@example.test', password: 'SecretPass#123' })).status, 409);
    const unauth = client(first.base);
    assert.equal((await unauth.req('/api/conversations')).status, 401);
    assert.equal((await a.req('/api/conversations', 'POST', { email: 'alice@example.test' })).status, 400);
    const newConversation = await a.req('/api/conversations', 'POST', { email: 'bruno@example.test' });
    assert.equal(newConversation.status, 200);
    const conversationId = newConversation.data.conversationId;
    assert.equal((await b.req('/api/conversations')).data.conversations[0].id, conversationId);
    // Testa que o navegador da pessoa destinatária recebe um evento imediatamente.
    const eventController = new AbortController();
    const eventResponse = await fetch(first.base + '/api/events', {
      headers: { Cookie: b.cookie }, signal: eventController.signal,
    });
    assert.equal(eventResponse.status, 200);
    const eventReader = eventResponse.body.getReader();
    await eventReader.read(); // comentário inicial SSE
    const incoming = eventReader.read();
    const secret = 'Olá, Bruno! 1234567890 😃🪽🐎';
    const ciphertext = encodePegasus(secret);
    const sent = await a.req(`/api/conversations/${conversationId}/messages`, 'POST', { ciphertext });
    assert.equal(sent.status, 201);
    const event = await Promise.race([incoming, new Promise((_, reject) => setTimeout(() => reject(new Error('Evento SSE não chegou.')), 3500))]);
    assert.match(new TextDecoder().decode(event.value), /event: refresh/);
    eventController.abort();
    const inbox = await b.req(`/api/conversations/${conversationId}/messages`);
    assert.equal(inbox.status, 200);
    assert.equal(decodePegasus(inbox.data.messages[0].ciphertext), secret);
    assert.equal((await unauth.req(`/api/conversations/${conversationId}/messages`)).status, 401);
    assert.equal((await a.req(`/api/conversations/${conversationId}/messages`, 'POST', { ciphertext: 'OLA123' })).status, 400);
    // Reiniciar: verificar DB e histórico, chaves locais intactas
    first.child.kill('SIGTERM');
    await once(first.child, 'exit');
    first = null;
    second = await launch(dataDir);
    const loggedAgain = client(second.base);
    assert.equal((await loggedAgain.req('/api/login', 'POST', { email: 'bruno@example.test', password: 'SecretPass#987' })).status, 200);
    const history = await loggedAgain.req(`/api/conversations/${conversationId}/messages`);
    assert.equal(decodePegasus(history.data.messages[0].ciphertext), secret);
    assert.equal((await loggedAgain.req('/api/logout', 'POST', {})).status, 200);
    assert.equal((await loggedAgain.req('/api/me')).status, 401);
  } finally {
    if (first?.child && first.child.exitCode === null) { first.child.kill('SIGTERM'); await once(first.child, 'exit'); }
    if (second?.child && second.child.exitCode === null) { second.child.kill('SIGTERM'); await once(second.child, 'exit'); }
    await rm(dataDir, { recursive: true, force: true });
  }
});
