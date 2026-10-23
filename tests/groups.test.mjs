import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
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
    child.stdout.on('data', buf => {
      logs += buf.toString();
      const match = logs.match(/PEGASUS_READY (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve({ child, base: match[1] }); }
    });
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
const text = (value) => ({ kind: 'text', ciphertext: encodePegasus(value) });

test('grupos: criar, mensagens, administração, histórico de novos membros e saída', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pegasus-groups-'));
  let server;
  try {
    server = await launch(dataDir);
    const names = ['Alice', 'Bruno', 'Carla', 'Diego'];
    const users = [];
    for (const name of names) {
      const c = client(server.base);
      const r = await c.req('/api/register', 'POST', { name, email: `${name.toLowerCase()}@example.test`, password: 'SecretPass#123' });
      assert.equal(r.status, 200);
      users.push({ c, id: r.data.user.id, code: r.data.user.friendCode, name });
    }
    const [alice, bruno, carla, diego] = users;
    // Alice conversa com Bruno e Carla (contatos); Diego é estranho para ela.
    for (const other of [bruno, carla]) assert.equal((await alice.c.req('/api/conversations', 'POST', { friendCode: other.code })).status, 200);
    assert.equal((await diego.c.req('/api/conversations', 'POST', { friendCode: carla.code })).status, 200);

    // Validações
    assert.equal((await alice.c.req('/api/groups', 'POST', { title: '', memberIds: [bruno.id] })).status, 400);
    assert.equal((await alice.c.req('/api/groups', 'POST', { title: 'Sem ninguém', memberIds: [] })).status, 400);
    assert.equal((await alice.c.req('/api/groups', 'POST', { title: 'Estranho', memberIds: [diego.id] })).status, 403);

    const created = await alice.c.req('/api/groups', 'POST', { title: 'Galáxia', description: 'Time Pegasus', memberIds: [bruno.id, carla.id] });
    assert.equal(created.status, 201);
    const gid = created.data.conversationId;

    // Lista: o grupo aparece para os três, com função correta, e não para Diego
    const aliceList = (await alice.c.req('/api/conversations')).data.conversations;
    const group = aliceList.find(c => c.id === gid);
    assert.equal(group.kind, 'group');
    assert.equal(group.partner.name, 'Galáxia');
    assert.equal(group.group.myRole, 'admin');
    assert.equal(group.group.members.length, 3);
    assert.equal(group.lastMessage.kind, 'system');
    assert.equal((await bruno.c.req('/api/conversations')).data.conversations.find(c => c.id === gid).group.myRole, 'member');
    assert.equal((await diego.c.req('/api/conversations')).data.conversations.some(c => c.id === gid), false);
    assert.equal((await diego.c.req(`/api/conversations/${gid}/messages`)).status, 404);
    assert.equal((await diego.c.req(`/api/groups/${gid}`)).status, 404);

    // Mensagens chegam a todos; contador de não lidas; sem "lida" individual
    assert.equal((await bruno.c.req(`/api/conversations/${gid}/messages`, 'POST', text('Oi, galera!'))).status, 201);
    const carlaGroup = (await carla.c.req('/api/conversations')).data.conversations.find(c => c.id === gid);
    assert.ok(carlaGroup.unreadCount >= 1);
    const carlaMessages = (await carla.c.req(`/api/conversations/${gid}/messages`)).data.messages;
    assert.equal(decodePegasus(carlaMessages.at(-1).ciphertext), 'Oi, galera!');
    assert.equal((await carla.c.req('/api/conversations')).data.conversations.find(c => c.id === gid).unreadCount, 0);

    // Membro comum não administra
    assert.equal((await bruno.c.req(`/api/groups/${gid}`, 'PATCH', { title: 'Hack' })).status, 403);
    assert.equal((await bruno.c.req(`/api/groups/${gid}/members`, 'POST', { memberIds: [diego.id] })).status, 403);
    assert.equal((await bruno.c.req(`/api/groups/${gid}/members/${carla.id}`, 'DELETE')).status, 403);

    // Admin edita e adiciona alguém novo (precisa ser contato)
    assert.equal((await alice.c.req(`/api/groups/${gid}`, 'PATCH', { title: 'Galáxia Pegasus' })).data.group.title, 'Galáxia Pegasus');
    assert.equal((await alice.c.req(`/api/groups/${gid}/members`, 'POST', { memberIds: [diego.id] })).status, 403);
    assert.equal((await alice.c.req('/api/conversations', 'POST', { friendCode: diego.code })).status, 200);
    const added = await alice.c.req(`/api/groups/${gid}/members`, 'POST', { memberIds: [diego.id] });
    assert.equal(added.status, 200);
    assert.equal(added.data.group.members.length, 4);

    // Quem entra não vê mensagens anteriores, só as novas
    const diegoBefore = (await diego.c.req(`/api/conversations/${gid}/messages`)).data.messages;
    assert.ok(!diegoBefore.some(m => m.kind === 'text'));
    await bruno.c.req(`/api/conversations/${gid}/messages`, 'POST', text('Bem-vindo, Diego'));
    const diegoAfter = (await diego.c.req(`/api/conversations/${gid}/messages`)).data.messages;
    assert.deepEqual(diegoAfter.filter(m => m.kind === 'text').map(m => decodePegasus(m.ciphertext)), ['Bem-vindo, Diego']);

    // Promover, rebaixar e proteção do último administrador
    assert.equal((await alice.c.req(`/api/groups/${gid}/members/${bruno.id}/role`, 'POST', { role: 'admin' })).status, 200);
    assert.equal((await alice.c.req(`/api/groups/${gid}/members/${bruno.id}/role`, 'POST', { role: 'member' })).status, 200);
    assert.equal((await alice.c.req(`/api/groups/${gid}/members/${alice.id}/role`, 'POST', { role: 'member' })).status, 400);
    assert.equal((await alice.c.req(`/api/groups/${gid}/members/${bruno.id}/role`, 'POST', { role: 'chefe' })).status, 400);

    // Avisos do sistema não podem ser editados/apagados pelo autor
    const systemMessage = (await alice.c.req(`/api/conversations/${gid}/messages`)).data.messages.find(m => m.kind === 'system');
    assert.equal((await alice.c.req(`/api/conversations/${gid}/messages/${systemMessage.id}`, 'DELETE')).status, 403);

    // Reações e busca funcionam em grupos
    const bruMsg = (await bruno.c.req(`/api/conversations/${gid}/messages`)).data.messages.find(m => m.kind === 'text');
    assert.equal((await carla.c.req(`/api/conversations/${gid}/messages/${bruMsg.id}/reaction`, 'POST', { emoji: '🔥' })).status, 200);
    const found = (await carla.c.req('/api/search?q=galera')).data.results;
    assert.equal(found[0].partner.name, 'Galáxia Pegasus');

    // Admin remove membro; membro sai; o grupo continua com administrador
    assert.equal((await alice.c.req(`/api/groups/${gid}/members/${diego.id}`, 'DELETE')).status, 200);
    assert.equal((await diego.c.req(`/api/conversations/${gid}/messages`)).status, 404);
    assert.equal((await carla.c.req(`/api/groups/${gid}/members/${carla.id}`, 'DELETE')).status, 200);
    assert.equal((await alice.c.req(`/api/groups/${gid}/members/${alice.id}`, 'DELETE')).status, 200);
    const left = (await bruno.c.req(`/api/groups/${gid}`)).data.group;
    assert.equal(left.members.length, 1);
    assert.equal(left.myRole, 'admin');
    // Última pessoa sai: grupo apagado
    assert.equal((await bruno.c.req(`/api/groups/${gid}/members/${bruno.id}`, 'DELETE')).status, 200);
    assert.equal((await bruno.c.req(`/api/groups/${gid}`)).status, 404);
  } finally {
    if (server?.child.exitCode === null) { server.child.kill('SIGTERM'); await once(server.child, 'exit'); }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('conversas fixadas, "digitando" e conversas diretas continuam funcionando', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pegasus-pin-'));
  let server;
  try {
    server = await launch(dataDir);
    const a = client(server.base), b = client(server.base), c = client(server.base);
    const ra = await a.req('/api/register', 'POST', { name: 'Ana', email: 'ana@example.test', password: 'SecretPass#123' });
    const rb = await b.req('/api/register', 'POST', { name: 'Beto', email: 'beto@example.test', password: 'SecretPass#123' });
    const rc = await c.req('/api/register', 'POST', { name: 'Cris', email: 'cris@example.test', password: 'SecretPass#123' });
    const c1 = (await a.req('/api/conversations', 'POST', { friendCode: rb.data.user.friendCode })).data.conversationId;
    const c2 = (await a.req('/api/conversations', 'POST', { friendCode: rc.data.user.friendCode })).data.conversationId;
    await a.req(`/api/conversations/${c2}/messages`, 'POST', text('mais recente'));
    let list = (await a.req('/api/conversations')).data.conversations;
    assert.equal(list[0].id, c2);
    assert.equal(list[0].kind, 'direct');
    // fixar a conversa mais antiga a coloca no topo
    assert.equal((await a.req(`/api/conversations/${c1}/preferences`, 'PUT', { pinned: true })).data.pinned, true);
    list = (await a.req('/api/conversations')).data.conversations;
    assert.equal(list[0].id, c1);
    assert.equal(list[0].pinned, true);
    assert.equal((await a.req(`/api/conversations/${c1}/preferences`, 'PUT', { pinned: false })).status, 200);
    // não lidas em conversa direta
    await b.req(`/api/conversations/${c1}/messages`, 'POST', text('oi Ana'));
    assert.equal((await a.req('/api/conversations')).data.conversations.find(x => x.id === c1).unreadCount, 1);
    await a.req(`/api/conversations/${c1}/messages`);
    assert.equal((await a.req('/api/conversations')).data.conversations.find(x => x.id === c1).unreadCount, 0);
    // digitando: evento chega só ao outro participante
    const controller = new AbortController();
    const stream = await fetch(server.base + '/api/events', { headers: { Cookie: b.cookie }, signal: controller.signal });
    const reader = stream.body.getReader();
    await reader.read();
    assert.equal((await a.req(`/api/conversations/${c1}/typing`, 'POST', {})).status, 200);
    let received = '';
    const decoder = new TextDecoder();
    while (!received.includes('event: typing')) received += decoder.decode((await reader.read()).value);
    controller.abort();
    assert.match(received, /"name":"Ana"/);
    assert.equal((await c.req(`/api/conversations/${c1}/typing`, 'POST', {})).status, 404);
  } finally {
    if (server?.child.exitCode === null) { server.child.kill('SIGTERM'); await once(server.child, 'exit'); }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('migra banco antigo (CHECK user_a<user_b) para aceitar grupos sem perder mensagens', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pegasus-mig-groups-'));
  let server;
  try {
    // 1) cria o banco com o servidor atual e o "rebaixa" para o formato antigo
    server = await launch(dataDir);
    const a = client(server.base), b = client(server.base);
    const ra = await a.req('/api/register', 'POST', { name: 'Ana', email: 'ana@example.test', password: 'SecretPass#123' });
    const rb = await b.req('/api/register', 'POST', { name: 'Beto', email: 'beto@example.test', password: 'SecretPass#123' });
    const cid = (await a.req('/api/conversations', 'POST', { friendCode: rb.data.user.friendCode })).data.conversationId;
    await a.req(`/api/conversations/${cid}/messages`, 'POST', text('mensagem antiga'));
    server.child.kill('SIGTERM'); await once(server.child, 'exit'); server = null;
    const db = new DatabaseSync(path.join(dataDir, 'pegasus.sqlite'));
    db.exec(`PRAGMA foreign_keys=OFF; BEGIN;
      DROP TABLE group_members;
      CREATE TABLE conv_old(id INTEGER PRIMARY KEY AUTOINCREMENT,user_a INTEGER NOT NULL REFERENCES users(id),user_b INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,CHECK(user_a < user_b),UNIQUE(user_a,user_b)) STRICT;
      INSERT INTO conv_old(id,user_a,user_b,created_at) SELECT id,user_a,user_b,created_at FROM conversations;
      DROP TABLE conversations; ALTER TABLE conv_old RENAME TO conversations; COMMIT;`);
    db.close();
    // 2) o servidor novo precisa migrar e funcionar
    server = await launch(dataDir);
    const a2 = client(server.base);
    assert.equal((await a2.req('/api/login', 'POST', { email: 'ana@example.test', password: 'SecretPass#123' })).status, 200);
    const msgs = (await a2.req(`/api/conversations/${cid}/messages`)).data.messages;
    assert.equal(decodePegasus(msgs[0].ciphertext), 'mensagem antiga');
    const g = await a2.req('/api/groups', 'POST', { title: 'Pós-migração', memberIds: [rb.data.user.id] });
    assert.equal(g.status, 201);
  } finally {
    if (server?.child.exitCode === null) { server.child.kill('SIGTERM'); await once(server.child, 'exit'); }
    await rm(dataDir, { recursive: true, force: true });
  }
});
