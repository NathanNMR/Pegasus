import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { encodePegasus, decodePegasus } from '../public/cipher.js';

const key = 'a'.repeat(64);
function encryptLegacy(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const result = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), result].map(b => b.toString('base64url')).join('.');
}

test('migrar banco 0.2 mantendo texto antigo e atribuindo código estável', { timeout: 25_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pegasus-migrate-'));
  let processServer;
  try {
    const db = new DatabaseSync(path.join(dataDir, 'pegasus.sqlite'));
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE conversations(id INTEGER PRIMARY KEY AUTOINCREMENT,user_a INTEGER NOT NULL REFERENCES users(id),user_b INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,CHECK(user_a < user_b),UNIQUE(user_a,user_b)) STRICT;
      CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id INTEGER NOT NULL REFERENCES conversations(id),sender_id INTEGER NOT NULL REFERENCES users(id),encrypted_body TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
    `);
    const password = 'Password-Old-2026';
    const salt = randomBytes(16).toString('hex');
    const digest = scryptSync(password, salt, 64, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    const passhash = `scrypt-v1:${salt}:${digest.toString('hex')}`;
    const date = new Date().toISOString();
    db.prepare('INSERT INTO users(name,email,password_hash,created_at) VALUES (?,?,?,?)').run('Antigo', 'antigo@example.test', passhash, date);
    db.prepare('INSERT INTO users(name,email,password_hash,created_at) VALUES (?,?,?,?)').run('Contato', 'contato@example.test', passhash, date);
    db.prepare('INSERT INTO conversations(user_a,user_b,created_at) VALUES (?,?,?)').run(1,2,date);
    db.prepare('INSERT INTO messages(conversation_id,sender_id,encrypted_body,created_at) VALUES (?,?,?,?)')
      .run(1,1,encryptLegacy(encodePegasus('Mensagem antiga intacta.')),date);
    db.close();
    const serverDir = path.resolve(import.meta.dirname, '..');
    processServer = spawn(process.execPath, ['server.mjs'], { cwd:serverDir, env:{ ...process.env,PORT:'0',HOST:'127.0.0.1', NODE_ENV:'test', PEGASUS_DATA_DIR:dataDir, PEGASUS_MESSAGE_KEY:key }, stdio:['ignore','pipe','pipe'] });
    let logs='';
    const ready = await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Timeout servidor '+logs)),10000);
      processServer.stdout.on('data', data=>{ logs+=data.toString(); const m=logs.match(/PEGASUS_READY (http:\/\/[^\s]+)/);if(m){ clearTimeout(timer);resolve(m[1]); } });
      processServer.stderr.on('data',data=>{logs+=data.toString();});
      processServer.on('exit', code=>reject(new Error('Servidor terminou '+code+' '+logs)));
    });
    let cookie='';
    const login=await fetch(ready+'/api/login',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'antigo@example.test',password}) });
    assert.equal(login.status,200);
    cookie=login.headers.get('set-cookie').split(';')[0];
    const {user}=await login.json();
    assert.match(user.friendCode,/^[A-Z0-9]{6}$/);
    const msgs=await fetch(ready+'/api/conversations/1/messages',{headers:{Cookie:cookie}});
    assert.equal(msgs.status,200);
    const {messages}=await msgs.json();
    assert.equal(decodePegasus(messages[0].ciphertext),'Mensagem antiga intacta.');
    assert.equal(messages[0].revision,0);
    const update=await fetch(ready+`/api/conversations/1/messages/${messages[0].id}`,{method:'PATCH',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({ciphertext:encodePegasus('Nova versão')})});
    assert.equal(update.status,200);
    const updated=await (await fetch(ready+'/api/conversations/1/messages',{headers:{Cookie:cookie}})).json();
    assert.equal(decodePegasus(updated.messages[0].ciphertext),'Nova versão');
  } finally {
    if(processServer && processServer.exitCode===null){processServer.kill('SIGTERM');await once(processServer,'exit');}
    await rm(dataDir,{recursive:true,force:true});
  }
});
