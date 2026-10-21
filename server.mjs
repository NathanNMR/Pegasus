import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  randomBytes, createHash, createCipheriv, createDecipheriv,
  scrypt as scryptCallback, timingSafeEqual, randomInt,
} from 'node:crypto';
import { promisify } from 'node:util';
import { decodePegasus, encodePegasus } from './public/cipher.js';

const scrypt = promisify(scryptCallback);
const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.PEGASUS_DATA_DIR || path.join(dir, 'data');
const PORT = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_JSON_BYTES = 7_500_000;
const MAX_IMAGE_BYTES = 2_500_000;
const MAX_GIF_BYTES = 4_000_000;
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

await mkdir(dataDir, { recursive: true, mode: 0o700 });
let messageKey;
if (process.env.PEGASUS_MESSAGE_KEY) {
  if (!/^[0-9a-f]{64}$/i.test(process.env.PEGASUS_MESSAGE_KEY)) {
    throw new Error('PEGASUS_MESSAGE_KEY precisa ter 64 caracteres hexadecimais.');
  }
  messageKey = Buffer.from(process.env.PEGASUS_MESSAGE_KEY, 'hex');
} else if (isProduction) {
  throw new Error('Defina PEGASUS_MESSAGE_KEY para executar em produção.');
} else {
  const secretFile = path.join(dataDir, 'local-secret.key');
  if (!existsSync(secretFile)) {
    try { await writeFile(secretFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const hex = readFileSync(secretFile, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Chave local inválida.');
  messageKey = Buffer.from(hex, 'hex');
}

const db = new DatabaseSync(path.join(dataDir, 'pegasus.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a INTEGER NOT NULL REFERENCES users(id),
    user_b INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    CHECK(user_a < user_b),
    UNIQUE(user_a, user_b)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    encrypted_body TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, id DESC);
  CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);
`);
// Migrações aditivas: mantêm usuários, conversas e mensagens de versões anteriores.
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('friend_code')) db.exec('ALTER TABLE users ADD COLUMN friend_code TEXT');
if (!userCols.includes('bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
if (!userCols.includes('avatar')) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
if (!userCols.includes('privacy_mode')) db.exec("ALTER TABLE users ADD COLUMN privacy_mode TEXT NOT NULL DEFAULT 'open'");
db.exec(`CREATE TABLE IF NOT EXISTS chat_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  recipient_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
  created_at TEXT NOT NULL,
  CHECK(requester_id <> recipient_id),
  UNIQUE(requester_id, recipient_id)
) STRICT;
CREATE INDEX IF NOT EXISTS chat_requests_recipient ON chat_requests(recipient_id,status)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_friend_code ON users(friend_code)');
const messageCols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
if (!messageCols.includes('revision')) db.exec('ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
// Mensagens recebidas podem ser ocultadas pelo destinatário sem alterar o histórico alheio.
db.exec(`CREATE TABLE IF NOT EXISTS message_hides (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, message_id)
) STRICT;
CREATE INDEX IF NOT EXISTS message_hides_message_id ON message_hides(message_id)`);
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function uniqueFriendCode() {
  for (let i = 0; i < 80; i++) {
    const code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    if (!db.prepare('SELECT 1 FROM users WHERE friend_code=?').get(code)) return code;
  }
  throw new Error('Não foi possível gerar um código único.');
}
for (const row of db.prepare('SELECT id FROM users WHERE friend_code IS NULL').all()) {
  db.prepare('UPDATE users SET friend_code=? WHERE id=?').run(uniqueFriendCode(), row.id);
}

function encryptAtRest(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', messageKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
}
function decryptAtRest(stored) {
  const parts = stored.split('.');
  if (parts.length !== 3) throw new Error('Mensagem armazenada inválida.');
  const [iv, tag, data] = parts.map(v => Buffer.from(v, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', messageKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
function packStoredMessage(payload) { return encryptAtRest(JSON.stringify({ version: 2, ...payload })); }
function unpackStoredMessage(stored) {
  const raw = decryptAtRest(stored);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 2 && parsed.kind === 'text' && typeof parsed.ciphertext === 'string') {
      return { kind: 'text', ciphertext: parsed.ciphertext };
    }
    if (parsed && parsed.version === 2 && parsed.kind === 'image' && parsed.image && typeof parsed.image.dataUrl === 'string') {
      return {
        kind: 'image',
        image: {
          dataUrl: parsed.image.dataUrl,
          name: String(parsed.image.name || 'imagem'),
          mime: String(parsed.image.mime || ''),
          size: Number(parsed.image.size || 0),
        },
      };
    }
  } catch {
    // compatibilidade com mensagens da v0.1
  }
  return { kind: 'text', ciphertext: raw };
}
function previewMessage(message) {
  if (!message) return null;
  if (message.kind === 'image') return message.image?.mime === 'image/gif' ? '🎞️ GIF' : '🖼️ Imagem';
  try { return decodePegasus(message.ciphertext).replace(/\s+/g, ' ').trim() || 'Mensagem'; }
  catch { return 'Mensagem'; }
}
function estimateBase64Bytes(base64) {
  const clean = base64.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}
function validateImagePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Imagem inválida.'), { status: 400 });
  const dataUrl = String(input.dataUrl || '');
  const name = String(input.name || 'imagem').trim().normalize('NFC').slice(0, 120) || 'imagem';
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw Object.assign(new Error('Formato de imagem inválido.'), { status: 400 });
  const [, mime, base64] = match;
  if (!ALLOWED_IMAGE_MIME.has(mime)) {
    throw Object.assign(new Error('Use PNG, JPEG, WEBP ou GIF.'), { status: 400 });
  }
  const size = estimateBase64Bytes(base64);
  const limit = mime === 'image/gif' ? MAX_GIF_BYTES : MAX_IMAGE_BYTES;
  if (size <= 0 || size > limit) {
    throw Object.assign(new Error(mime === 'image/gif' ? 'O GIF deve ter até 4 MB.' : 'A imagem deve ter até 2,5 MB.'), { status: 413 });
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length !== size || bytes.toString('base64') !== base64.replace(/\s+/g, '')) {
    throw Object.assign(new Error('Arquivo com codificação inválida.'), { status: 400 });
  }
  const validSignature =
    (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (mime === 'image/jpeg' && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) ||
    (mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') ||
    (mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)));
  if (!validSignature) throw Object.assign(new Error('Os dados não correspondem ao formato da imagem.'), { status: 400 });
  return { dataUrl, name, mime, size };
}

function safeUser(row) {
  return { id: row.id, name: row.name, email: row.email,
    friendCode: row.friend_code ?? row.friendCode,
    bio: row.bio || '', avatar: row.avatar || '', privacyMode: row.privacy_mode || row.privacyMode || 'open' };
}
function profileAvatar(data) {
  if (data === '') return '';
  if (typeof data !== 'string' || data.length > 380_000) throw Object.assign(new Error('Foto de perfil inválida ou muito grande.'), { status: 400 });
  const pic = validateImagePayload({dataUrl:data, name:'perfil'});
  if (pic.mime === 'image/gif' || pic.size > 240_000) throw Object.assign(new Error('Use PNG, JPG ou WEBP de até 240 KB para a foto.'), {status:400});
  return pic.dataUrl;
}
function findConversation(a, b) {
  const [x,y] = [a,b].sort((i,j)=>i-j);
  return db.prepare('SELECT id FROM conversations WHERE user_a=? AND user_b=?').get(x,y);
}
function createConversation(a,b) {
  const [x,y] = [a,b].sort((i,j)=>i-j);
  db.prepare('INSERT OR IGNORE INTO conversations(user_a,user_b,created_at) VALUES(?,?,?)').run(x,y,new Date().toISOString());
  return findConversation(x,y).id;
}
function json(res, code, data, extraHeaders = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}
function fail(res, status, error) { json(res, status, { error }); }
function serverError(res, error) {
  console.error('[Pegasus]', error);
  if (!res.headersSent) fail(res, 500, 'Erro interno do servidor.');
  else res.end();
}
async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    const error = new Error('Envie um JSON.'); error.status = 415; throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      const error = new Error('Mensagem muito grande.'); error.status = 413; throw error;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON inválido.');
    return value;
  } catch {
    const error = new Error('JSON inválido.'); error.status = 400; throw error;
  }
}
function ipFromRequest(req) { return req.socket.remoteAddress || 'unknown'; }
const attempts = new Map();
function limited(req) {
  const key = ipFromRequest(req);
  const now = Date.now();
  const current = (attempts.get(key) || []).filter(time => now - time < 15 * 60_000);
  if (current.length >= 20) return true;
  current.push(now);
  attempts.set(key, current);
  if (attempts.size > 3000) {
    for (const [ip, events] of attempts) {
      if (events.every(t => now - t > 15 * 60_000)) attempts.delete(ip);
    }
  }
  return false;
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(piece => {
    const at = piece.indexOf('=');
    return at === -1 ? [] : [piece.slice(0, at).trim(), piece.slice(at + 1).trim()];
  }).filter(pair => pair.length === 2));
}
function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
function currentUser(req) {
  const token = cookies(req).pegasus_session;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = db.prepare(`SELECT users.id, users.name, users.email, users.friend_code, users.bio, users.avatar, users.privacy_mode
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
    .get(hashToken(token), Date.now());
  return row ? safeUser(row) : null;
}
function sessionCookie(token) {
  return `pegasus_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${isProduction ? '; Secure' : ''}`;
}
function addSession(res, user) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run(hashToken(token), user.id, Date.now() + SESSION_MS);
  json(res, 200, { user }, { 'Set-Cookie': sessionCookie(token) });
}
async function makePasswordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const digest = await scrypt(password, salt, 64, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt-v1:${salt}:${digest.toString('hex')}`;
}
async function checkPassword(password, stored) {
  const [version, salt, hash] = stored.split(':');
  if (version !== 'scrypt-v1' || !salt || !hash) return false;
  const actual = await scrypt(password, salt, 64, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function canReadConversation(userId, id) {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  return !!db.prepare('SELECT id FROM conversations WHERE id = ? AND (user_a = ? OR user_b = ?)')
    .get(id, userId, userId);
}
function toMessage(row) {
  const message = unpackStoredMessage(row.encrypted_body);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind: message.kind,
    ...(message.kind === 'text' ? { ciphertext: message.ciphertext } : { image: message.image }),
    preview: previewMessage(message),
    createdAt: row.created_at,
    revision: row.revision,
  };
}
const streams = new Map();
function broadcast(userId, payload) {
  for (const res of streams.get(userId) || []) {
    try { res.write(`event: refresh\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* cliente desconectado */ }
  }
}
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/cipher.js', ['cipher.js', 'text/javascript; charset=utf-8']],
  ['/editor.js', ['editor.js', 'text/javascript; charset=utf-8']],
  
  ['/favicon.png', ['favicon.png', 'image/png']],
  ['/pegasus-logo.png', ['pegasus-logo.png', 'image/png']],
  ['/pegasus-galaxy.svg', ['pegasus-galaxy.svg', 'image/svg+xml']],
  ['/pegasus-constellation.svg', ['pegasus-constellation.svg', 'image/svg+xml']],
]);

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method.toUpperCase();
    if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return fail(res, 403, 'Origem não autorizada.');
      if (req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'Origem não autorizada.');
    }
    if (method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (method === 'POST' && url.pathname === '/api/register') {
      if (limited(req)) return fail(res, 429, 'Muitas tentativas. Tente mais tarde.');
      const { name, email, password } = await readJson(req);
      const displayName = String(name || '').trim().normalize('NFC');
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (displayName.length < 2 || displayName.length > 60) return fail(res, 400, 'O nome deve ter entre 2 e 60 caracteres.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) return fail(res, 400, 'E-mail inválido.');
      if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 256) {
        return fail(res, 400, 'A senha precisa de 8 a 256 bytes.');
      }
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail)) return fail(res, 409, 'Este e-mail já está cadastrado.');
      const hashed = await makePasswordHash(password);
      const friendCode = uniqueFriendCode();
      let created;
      try {
        created = db.prepare('INSERT INTO users (name,email,password_hash,created_at,friend_code) VALUES (?,?,?,?,?)')
          .run(displayName, normalizedEmail, hashed, new Date().toISOString(), friendCode);
      } catch (error) {
        if (error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) return fail(res, 409, 'Este e-mail já está cadastrado.');
        throw error;
      }
      return addSession(res, { id: Number(created.lastInsertRowid), name: displayName, email: normalizedEmail, friendCode, bio:'', avatar:'', privacyMode:'open' });
    }
    if (method === 'POST' && url.pathname === '/api/login') {
      if (limited(req)) return fail(res, 429, 'Muitas tentativas. Tente mais tarde.');
      const { email, password } = await readJson(req);
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const found = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
      if (!found || typeof password !== 'string' || !(await checkPassword(password, found.password_hash))) {
        return fail(res, 401, 'E-mail ou senha incorretos.');
      }
      return addSession(res, safeUser(found));
    }
    if (method === 'POST' && url.pathname === '/api/logout') {
      const token = cookies(req).pegasus_session;
      if (token && /^[a-f0-9]{64}$/.test(token)) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${sessionCookie('')}; Max-Age=0` });
    }
    if (url.pathname.startsWith('/api/')) {
      const user = currentUser(req);
      if (!user) return fail(res, 401, 'Faça login para continuar.');
      if (method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user });
      if (method === 'PUT' && url.pathname === '/api/profile') {
        const data = await readJson(req);
        if (typeof data.bio !== 'string' || [...data.bio].length > 240) return fail(res,400,'A bio deve ter até 240 caracteres.');
        if (!['open','approval'].includes(data.privacyMode)) return fail(res,400,'Selecione uma opção de privacidade.');
        const avatar = data.avatar === undefined ? user.avatar : profileAvatar(data.avatar);
        db.prepare('UPDATE users SET bio=?, avatar=?, privacy_mode=? WHERE id=?')
          .run(data.bio.trim(), avatar, data.privacyMode, user.id);
        const updated = currentUser(req);
        broadcast(user.id,{profileUpdated:true});
        for (const row of db.prepare('SELECT user_a,user_b FROM conversations WHERE user_a=? OR user_b=?').all(user.id,user.id)) {
          broadcast(row.user_a===user.id ? row.user_b : row.user_a,{profileUpdated:true});
        }
        return json(res,200,{user:updated});
      }
      if (method === 'GET' && url.pathname === '/api/chat-requests') {
        const incoming = db.prepare(`SELECT r.id,r.status,r.created_at, u.id AS userId,u.name,u.friend_code AS friendCode,u.bio,u.avatar
          FROM chat_requests r JOIN users u ON u.id=r.requester_id WHERE r.recipient_id=? AND r.status='pending' ORDER BY r.id DESC`).all(user.id);
        const outgoing = db.prepare(`SELECT r.id,r.status,r.created_at,u.name,u.friend_code AS friendCode
          FROM chat_requests r JOIN users u ON u.id=r.recipient_id WHERE r.requester_id=? AND r.status='pending' ORDER BY r.id DESC`).all(user.id);
        return json(res,200,{incoming,outgoing});
      }
      const decision = url.pathname.match(/^\/api\/chat-requests\/(\d+)\/(accept|decline)$/);
      if (method==='POST' && decision) {
        const requestId = Number(decision[1]);
        const request = db.prepare("SELECT * FROM chat_requests WHERE id=? AND recipient_id=? AND status='pending'").get(requestId,user.id);
        if (!request) return fail(res,404,'Solicitação não encontrada.');
        const approved = decision[2] === 'accept';
        let conversationId = null;
        db.exec('BEGIN IMMEDIATE');
        try {
          const changed = db.prepare("UPDATE chat_requests SET status=? WHERE id=? AND recipient_id=? AND status='pending'")
            .run(approved ? 'accepted' : 'declined',requestId,user.id);
          if (changed.changes !== 1) { db.exec('ROLLBACK'); return fail(res,409,'Solicitação já foi respondida.'); }
          if (approved) conversationId = createConversation(request.requester_id,user.id);
          db.exec('COMMIT');
        } catch(error) { db.exec('ROLLBACK'); throw error; }
        broadcast(user.id,{requestsUpdated:true});
        broadcast(request.requester_id,{requestsUpdated:true});
        return json(res,200,{ok:true,approved,conversationId});
      }

      if (method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': conectado ao Pegasus\n\n');
        const clients = streams.get(user.id) || new Set();
        clients.add(res); streams.set(user.id, clients);
        const timer = setInterval(() => {
          if (!currentUser(req)) { res.end(); return; }
          if (!res.destroyed) res.write(': keep-alive\n\n');
        }, 25000);
        req.on('close', () => {
          clearInterval(timer);
          clients.delete(res);
          if (clients.size === 0) streams.delete(user.id);
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/conversations') {
        const rows = db.prepare(`SELECT c.id, c.created_at, u.id AS partner_id, u.name AS partner_name,
           u.email AS partner_email, u.avatar AS partner_avatar, u.bio AS partner_bio, m.id AS message_id, m.encrypted_body, m.created_at AS last_message_at
           FROM conversations c
           JOIN users u ON u.id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END
           LEFT JOIN messages m ON m.id = (
             SELECT id FROM messages WHERE conversation_id = c.id
               AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = messages.id AND h.user_id = ?)
             ORDER BY id DESC LIMIT 1
           )
           WHERE c.user_a = ? OR c.user_b = ?
           ORDER BY COALESCE(m.id, 0) DESC, c.id DESC`).all(user.id, user.id, user.id, user.id);
        return json(res, 200, {
          conversations: rows.map(row => {
            const parsed = row.message_id ? unpackStoredMessage(row.encrypted_body) : null;
            return {
              id: row.id,
              createdAt: row.created_at,
              partner: { id: row.partner_id, name: row.partner_name, email: row.partner_email, avatar: row.partner_avatar || '', bio: row.partner_bio || '' },
              lastMessage: row.message_id ? {
                id: row.message_id,
                kind: parsed.kind,
                ...(parsed.kind === 'text' ? { ciphertext: parsed.ciphertext } : {}),
                preview: previewMessage(parsed),
                createdAt: row.last_message_at,
              } : null,
            };
          }),
        });
      }
      if (method === 'POST' && url.pathname === '/api/conversations') {
        const { email, friendCode } = await readJson(req);
        const byCode = typeof friendCode === 'string' && friendCode.trim().length > 0;
        const byEmail = typeof email === 'string' && email.trim().length > 0;
        if (byCode === byEmail) return fail(res, 400, 'Informe um e-mail ou código Pegasus.');
        const partner = byCode
          ? db.prepare('SELECT id, privacy_mode FROM users WHERE friend_code = ?').get(friendCode.trim().toUpperCase())
          : db.prepare('SELECT id, privacy_mode FROM users WHERE email = ?').get(email.trim().toLowerCase());
        if (!partner) return fail(res,404,'Usuário não encontrado.');
        if (partner.id === user.id) return fail(res,400,'Você não pode conversar consigo mesmo.');
        const existing = findConversation(user.id,partner.id);
        if (existing) return json(res,200,{conversationId:existing.id,status:'connected'});
        if (partner.privacy_mode === 'approval') {
          // Sem criar conversa nem permitir mensagens antes da aprovação.
          const prior = db.prepare('SELECT id,status FROM chat_requests WHERE requester_id=? AND recipient_id=?').get(user.id,partner.id);
          if (prior?.status === 'declined') return fail(res,403,'Este usuário recusou a solicitação.');
          if (prior?.status === 'pending') return json(res,200,{status:'pending'});
          const reciprocal = db.prepare("SELECT id FROM chat_requests WHERE requester_id=? AND recipient_id=? AND status='pending'").get(partner.id,user.id);
          if (reciprocal) {
            // Se o destinatário já pediu para falar com você, aceitar equivale a uma aprovação explícita.
            return json(res,200,{status:'incoming',message:'Você já recebeu uma solicitação desta pessoa. Aceite-a na sua caixa de solicitações.'});
          }
          db.prepare('INSERT INTO chat_requests(requester_id,recipient_id,status,created_at) VALUES(?,?,?,?)')
            .run(user.id,partner.id,'pending',new Date().toISOString());
          broadcast(partner.id,{requestsUpdated:true});
          return json(res,202,{status:'pending'});
        }
        const conversationId=createConversation(user.id,partner.id);
        db.prepare("UPDATE chat_requests SET status='accepted' WHERE ((requester_id=? AND recipient_id=?) OR (requester_id=? AND recipient_id=?)) AND status='pending'").run(user.id,partner.id,partner.id,user.id);
        broadcast(user.id,{conversationId});broadcast(partner.id,{conversationId});
        return json(res,200,{conversationId,status:'connected'});
      }
      const match = url.pathname.match(/^\/api\/conversations\/(\d+)\/messages$/);
      if (match) {
        const conversationId = Number(match[1]);
        if (!canReadConversation(user.id, conversationId)) return fail(res, 404, 'Conversa não encontrada.');
        if (method === 'GET') {
          const rows = db.prepare(`SELECT * FROM (
            SELECT id, conversation_id, sender_id, encrypted_body, created_at, revision
            FROM messages WHERE conversation_id = ?
              AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = messages.id AND h.user_id = ?)
            ORDER BY id DESC LIMIT 100
          ) ORDER BY id ASC`).all(conversationId, user.id);
          return json(res, 200, { messages: rows.map(toMessage) });
        }
        if (method === 'POST') {
          const payload = await readJson(req);
          const kind = payload.kind === 'image' ? 'image' : payload.kind === 'text' || payload.kind == null ? 'text' : null;
          if (!kind) return fail(res, 400, 'Tipo de mensagem inválido.');
          let message;
          if (kind === 'image') {
            const image = validateImagePayload(payload.image);
            message = { kind: 'image', image };
          } else {
            const { ciphertext } = payload;
            if (typeof ciphertext !== 'string' || Buffer.byteLength(ciphertext) > 240_000) return fail(res, 400, 'Mensagem inválida ou grande demais.');
            let plaintext;
            try {
              plaintext = decodePegasus(ciphertext);
              if (ciphertext !== encodePegasus(plaintext)) throw new Error('PG1 não canônico');
            } catch { return fail(res, 400, 'Formato Pegasus inválido.'); }
            if (!plaintext.trim() || [...plaintext].length > MAX_MESSAGE_LENGTH) {
              return fail(res, 400, 'Digite uma mensagem de até 4.000 caracteres.');
            }
            message = { kind: 'text', ciphertext };
          }
          const encrypted = packStoredMessage(message);
          const createdAt = new Date().toISOString();
          const result = db.prepare(`INSERT INTO messages (conversation_id,sender_id,encrypted_body,created_at)
            VALUES (?,?,?,?)`).run(conversationId, user.id, encrypted, createdAt);
          const members = db.prepare('SELECT user_a,user_b FROM conversations WHERE id = ?').get(conversationId);
          broadcast(members.user_a, { conversationId });
          broadcast(members.user_b, { conversationId });
          return json(res, 201, {
            message: {
              id: Number(result.lastInsertRowid),
              conversationId,
              senderId: user.id,
              kind: message.kind,
              ...(message.kind === 'text' ? { ciphertext: message.ciphertext } : { image: message.image }),
              preview: previewMessage(message),
              createdAt,
              revision: 0,
            },
          });
        }
      }
      // Ocultar uma mensagem apenas para a conta atual. O remetente nunca perde a mensagem.
      const hideMatch = url.pathname.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)\/hide$/);
      if (hideMatch && method === 'POST') {
        const conversationId = Number(hideMatch[1]);
        const messageId = Number(hideMatch[2]);
        if (!canReadConversation(user.id, conversationId)) return fail(res, 404, 'Conversa não encontrada.');
        const original = db.prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?').get(messageId, conversationId);
        if (!original) return fail(res, 404, 'Mensagem não encontrada.');
        db.prepare('INSERT OR IGNORE INTO message_hides(user_id,message_id) VALUES(?,?)').run(user.id,messageId);
        broadcast(user.id,{conversationId});
        return json(res,200,{ok:true});
      }
      // Alterar/apagar somente as próprias mensagens. Sem marcador ou aviso no chat.
      const ownMessageMatch = url.pathname.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)$/);
      if (ownMessageMatch && ['PATCH', 'DELETE'].includes(method)) {
        const conversationId = Number(ownMessageMatch[1]);
        const messageId = Number(ownMessageMatch[2]);
        if (!canReadConversation(user.id, conversationId)) return fail(res, 404, 'Conversa não encontrada.');
        const original = db.prepare('SELECT * FROM messages WHERE id=? AND conversation_id=?').get(messageId, conversationId);
        if (!original) return fail(res, 404, 'Mensagem não encontrada.');
        if (original.sender_id !== user.id) return fail(res, 403, 'Só o autor pode alterar ou apagar esta mensagem.');
        if (method === 'DELETE') {
          db.prepare('DELETE FROM messages WHERE id=? AND conversation_id=?').run(messageId, conversationId);
        } else {
          const previous = unpackStoredMessage(original.encrypted_body);
          if (previous.kind !== 'text') return fail(res, 400, 'Somente mensagens de texto podem ser editadas.');
          const { ciphertext } = await readJson(req);
          if (typeof ciphertext !== 'string' || Buffer.byteLength(ciphertext) > 240_000) return fail(res, 400, 'Mensagem inválida.');
          let plain;
          try {
            plain = decodePegasus(ciphertext);
            if (ciphertext !== encodePegasus(plain)) throw new Error('Código inválido');
          } catch { return fail(res, 400, 'Formato Pegasus inválido.'); }
          if (!plain.trim() || [...plain].length > MAX_MESSAGE_LENGTH) return fail(res, 400, 'A mensagem deve ter até 4.000 caracteres.');
          db.prepare('UPDATE messages SET encrypted_body=?, revision=revision+1 WHERE id=? AND conversation_id=?')
            .run(packStoredMessage({ kind: 'text', ciphertext }), messageId, conversationId);
        }
        const members = db.prepare('SELECT user_a,user_b FROM conversations WHERE id=?').get(conversationId);
        broadcast(members.user_a, { conversationId });
        broadcast(members.user_b, { conversationId });
        return json(res, 200, { ok: true });
      }
      return fail(res, 404, 'Rota não encontrada.');
    }
    if (method === 'GET' && staticFiles.has(url.pathname)) {
      const [filename, mime] = staticFiles.get(url.pathname);
      const buffer = await readFile(path.join(dir, 'public', filename));
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      return res.end(buffer);
    }
    return fail(res, 404, 'Página não encontrada.');
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    serverError(res, error);
  }
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  const addr = server.address();
  console.log(`PEGASUS_READY http://${addr.address}:${addr.port}`);
  if (!isProduction) console.log('Modo local: não publique na internet sem HTTPS e revisão de segurança.');
});

function shutdown() {
  for (const clients of streams.values()) for (const res of clients) res.end();
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
