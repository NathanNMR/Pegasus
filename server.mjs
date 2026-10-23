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
const MAX_OTHER_FILE_BYTES = 4_000_000;
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
    user_a INTEGER REFERENCES users(id),
    user_b INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'direct' CHECK(kind IN ('direct','group')),
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    CHECK((kind='direct' AND user_a IS NOT NULL AND user_b IS NOT NULL AND user_a < user_b)
       OR (kind='group' AND user_a IS NULL AND user_b IS NULL)),
    UNIQUE(user_a, user_b)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    encrypted_body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT,
    expires_at TEXT
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
if (!messageCols.includes('reply_to_id')) db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL');
if (!messageCols.includes('forwarded_from')) db.exec('ALTER TABLE messages ADD COLUMN forwarded_from INTEGER REFERENCES messages(id) ON DELETE SET NULL');
if (!messageCols.includes('read_at')) db.exec('ALTER TABLE messages ADD COLUMN read_at TEXT');
if (!messageCols.includes('expires_at')) db.exec('ALTER TABLE messages ADD COLUMN expires_at TEXT');
// Mensagens recebidas podem ser ocultadas pelo destinatário sem alterar o histórico alheio.
db.exec(`CREATE TABLE IF NOT EXISTS message_hides (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, message_id)
) STRICT;
CREATE INDEX IF NOT EXISTS message_hides_message_id ON message_hides(message_id);
CREATE TABLE IF NOT EXISTS message_favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, message_id)
) STRICT;
CREATE INDEX IF NOT EXISTS message_favorites_by_user ON message_favorites(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS conversation_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  alias TEXT NOT NULL DEFAULT '',
  notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK(notifications_enabled IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  disappearing_seconds INTEGER NOT NULL DEFAULT 0 CHECK(disappearing_seconds IN (0,3600,86400,604800)),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, conversation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS blocked_contacts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, contact_id),
  CHECK(user_id <> contact_id)
) STRICT;
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(message_id,user_id)
) STRICT;
CREATE TABLE IF NOT EXISTS pinned_messages (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id,message_id)
) STRICT;
CREATE INDEX IF NOT EXISTS message_reactions_by_message ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS pinned_messages_by_conversation ON pinned_messages(conversation_id,created_at DESC);`);
const preferenceCols = db.prepare('PRAGMA table_info(conversation_preferences)').all().map(c => c.name);
if (!preferenceCols.includes('archived')) db.exec('ALTER TABLE conversation_preferences ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))');
if (!preferenceCols.includes('disappearing_seconds')) db.exec('ALTER TABLE conversation_preferences ADD COLUMN disappearing_seconds INTEGER NOT NULL DEFAULT 0 CHECK(disappearing_seconds IN (0,3600,86400,604800))');
// v1.0 — grupos. Bancos antigos têm CHECK(user_a < user_b) e NOT NULL: a tabela é reconstruída
// (copiando todos os dados) para aceitar conversas de grupo. Mensagens e preferências são mantidas.
const conversationCols = db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
if (!conversationCols.includes('kind')) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE conversations_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_a INTEGER REFERENCES users(id),
      user_b INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'direct' CHECK(kind IN ('direct','group')),
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      CHECK((kind='direct' AND user_a IS NOT NULL AND user_b IS NOT NULL AND user_a < user_b)
         OR (kind='group' AND user_a IS NULL AND user_b IS NULL)),
      UNIQUE(user_a, user_b)
    ) STRICT;
    INSERT INTO conversations_new(id,user_a,user_b,created_at) SELECT id,user_a,user_b,created_at FROM conversations;
    DROP TABLE conversations;
    ALTER TABLE conversations_new RENAME TO conversations;`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys = ON'); }
}
db.exec(`CREATE TABLE IF NOT EXISTS group_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
  joined_at TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(conversation_id,user_id)
) STRICT;
CREATE INDEX IF NOT EXISTS group_members_by_user ON group_members(user_id)`);
if (!db.prepare('PRAGMA table_info(conversation_preferences)').all().some(c => c.name === 'pinned')) {
  db.exec('ALTER TABLE conversation_preferences ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1))');
}
const MAX_GROUP_MEMBERS = 50;
const MAX_PINNED_CONVERSATIONS = 5;
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
    if (parsed && parsed.version === 2 && ['audio', 'document'].includes(parsed.kind)
        && typeof parsed.file?.dataUrl === 'string') {
      return { kind: parsed.kind, file: parsed.file };
    }
    if (parsed && parsed.version === 2 && parsed.kind === 'system' && typeof parsed.text === 'string') {
      return { kind: 'system', text: parsed.text };
    }
    if (parsed && parsed.version === 2 && parsed.kind === 'contact' && parsed.contact?.friendCode) {
      return { kind: 'contact', contact: parsed.contact };
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
  if (message.kind === 'audio') return message.file?.voice ? '🎤 Mensagem de voz' : '🎵 Áudio';
  if (message.kind === 'document') return '📄 Documento';
  if (message.kind === 'contact') return `👤 ${message.contact.name}`;
  if (message.kind === 'system') return message.text;
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

const AUDIO_BY_EXTENSION = Object.freeze({
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', webm: 'audio/webm', flac: 'audio/flac',
});
const DOCUMENT_BY_EXTENSION = Object.freeze({
  pdf: 'application/pdf', txt: 'text/plain',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
});
function validateFilePayload(input, kind) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Arquivo inválido.'), {status: 400});
  }
  const name = String(input.name || '').replace(/[\/\\\x00-\x1f]/g, '').trim().normalize('NFC').slice(0, 120);
  const extension = name.split('.').at(-1)?.toLowerCase();
  const expected = (kind === 'audio' ? AUDIO_BY_EXTENSION : DOCUMENT_BY_EXTENSION)[extension];
  if (!name || !expected) throw Object.assign(new Error('Formato de arquivo não permitido.'), {status: 400});
  const dataUrl = input.dataUrl;
  if (typeof dataUrl !== 'string' || dataUrl.length > 5_500_000) {
    throw Object.assign(new Error('Arquivo muito grande.'), {status: 413});
  }
  const matched = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!matched) throw Object.assign(new Error('Codificação de arquivo inválida.'), {status: 400});
  const [, mime, base64] = matched;
  // O tipo MIME é definido a partir da extensão, não fornecido pelo navegador.
  const acceptedMimes = [expected, 'application/octet-stream'];
  if (expected === 'audio/wav') acceptedMimes.push('audio/x-wav', 'audio/wave');
  if (expected === 'audio/mp4') acceptedMimes.push('audio/x-m4a');
  if (expected === 'audio/mpeg') acceptedMimes.push('audio/mp3');
  if (!acceptedMimes.includes(mime)) throw Object.assign(new Error('O arquivo e o formato não correspondem.'), {status: 400});
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_OTHER_FILE_BYTES || bytes.toString('base64') !== base64) {
    throw Object.assign(new Error('Arquivo inválido ou maior que 4 MB.'), {status: 413});
  }
  const signature = {
    mp3: () => bytes.toString('ascii',0,3)==='ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0)===0xe0),
    wav: () => bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WAVE',
    ogg: () => bytes.toString('ascii',0,4)==='OggS',
    m4a: () => bytes.toString('ascii',4,8)==='ftyp',
    webm: () => bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])),
    flac: () => bytes.toString('ascii',0,4)==='fLaC',
    pdf: () => bytes.toString('ascii',0,5)==='%PDF-',
    txt: () => !bytes.includes(0) && (() => { try { new TextDecoder('utf-8',{fatal:true}).decode(bytes); return true; } catch {return false;} })(),
    doc: () => bytes.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])),
    xls: () => bytes.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])),
    ppt: () => bytes.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])),
    docx: () => bytes.toString('ascii',0,2)==='PK', xlsx: () => bytes.toString('ascii',0,2)==='PK',
    pptx: () => bytes.toString('ascii',0,2)==='PK', odt: () => bytes.toString('ascii',0,2)==='PK',
    ods: () => bytes.toString('ascii',0,2)==='PK',
  }[extension];
  if (!signature()) throw Object.assign(new Error('Assinatura do arquivo inválida.'), {status: 400});
  return { name, mime: expected, dataUrl: `data:${expected};base64,${base64}`, size: bytes.length,
    ...(kind === 'audio' && input.voice === true ? {voice: true} : {}) };
}
function validateSharedContact(userId, contactId) {
  if (!Number.isSafeInteger(contactId) || contactId <= 0) {
    throw Object.assign(new Error('Contato inválido.'), {status: 400});
  }
  const contact = db.prepare(`SELECT id,name,friend_code,avatar FROM users WHERE id=? AND
    (id=? OR EXISTS (SELECT 1 FROM conversations WHERE
      (user_a=? AND user_b=users.id) OR (user_b=? AND user_a=users.id)))`).get(contactId,userId,userId,userId);
  if (!contact) throw Object.assign(new Error('Compartilhe apenas contatos de suas conversas.'), {status: 403});
  return { id: contact.id, name:contact.name, friendCode:contact.friend_code, avatar:contact.avatar || '' };
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
  return db.prepare("SELECT id FROM conversations WHERE kind='direct' AND user_a=? AND user_b=?").get(x,y);
}
function createConversation(a,b) {
  const [x,y] = [a,b].sort((i,j)=>i-j);
  if (!findConversation(x,y)) db.prepare("INSERT INTO conversations(user_a,user_b,created_at,kind) VALUES(?,?,?,'direct')").run(x,y,new Date().toISOString());
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
  return !!db.prepare(`SELECT c.id FROM conversations c WHERE c.id = ? AND (
      (c.kind = 'direct' AND (c.user_a = ? OR c.user_b = ?))
      OR (c.kind = 'group' AND EXISTS(SELECT 1 FROM group_members g WHERE g.conversation_id = c.id AND g.user_id = ?)))`)
    .get(id, userId, userId, userId);
}
function conversationInfo(id) {
  return db.prepare('SELECT id,kind,user_a,user_b,title,description,avatar,created_by,created_at FROM conversations WHERE id=?').get(id);
}
function memberIds(conversationId) {
  const c = conversationInfo(conversationId);
  if (!c) return [];
  if (c.kind === 'group') return db.prepare('SELECT user_id FROM group_members WHERE conversation_id=?').all(conversationId).map(r => r.user_id);
  return [c.user_a, c.user_b];
}
function broadcastConversation(conversationId, payload = {}, exceptUserId = null) {
  for (const id of memberIds(conversationId)) if (id !== exceptUserId) broadcast(id, { conversationId, ...payload });
}
function groupRole(userId, conversationId) {
  return db.prepare('SELECT role FROM group_members WHERE conversation_id=? AND user_id=?').get(conversationId, userId)?.role || null;
}
function addSystemMessage(conversationId, actorId, textValue) {
  db.prepare('INSERT INTO messages(conversation_id,sender_id,encrypted_body,created_at) VALUES(?,?,?,?)')
    .run(conversationId, actorId, packStoredMessage({ kind: 'system', text: String(textValue).slice(0, 300) }), new Date().toISOString());
}
function userName(id) { return db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name || 'Alguém'; }
// Só é possível adicionar a grupos pessoas que já são contatos (conversa direta ativa) e sem bloqueio.
function assertAddableContacts(userId, ids) {
  const unique = [...new Set(ids.map(Number))];
  for (const id of unique) {
    if (!Number.isSafeInteger(id) || id <= 0 || id === userId) throw Object.assign(new Error('Participante inválido.'), { status: 400 });
    const [a, b] = [userId, id].sort((x, y) => x - y);
    const direct = db.prepare("SELECT id FROM conversations WHERE kind='direct' AND user_a=? AND user_b=?").get(a, b);
    const hidden = direct && db.prepare('SELECT is_deleted FROM conversation_preferences WHERE user_id=? AND conversation_id=?').get(userId, direct.id)?.is_deleted;
    const blocked = db.prepare('SELECT 1 FROM blocked_contacts WHERE (user_id=? AND contact_id=?) OR (user_id=? AND contact_id=?)').get(userId, id, id, userId);
    if (!direct || hidden || blocked) throw Object.assign(new Error('Só é possível adicionar contatos com quem você conversa e que não estejam bloqueados.'), { status: 403 });
  }
  return unique;
}
function groupDetails(conversationId, viewerId) {
  const c = conversationInfo(conversationId);
  const members = db.prepare(`SELECT u.id,u.name,u.friend_code,u.avatar,u.bio,g.role,g.joined_at FROM group_members g JOIN users u ON u.id=g.user_id
    WHERE g.conversation_id=? ORDER BY CASE g.role WHEN 'admin' THEN 0 ELSE 1 END, g.joined_at, u.id`).all(conversationId);
  return {
    id: c.id, title: c.title, description: c.description, avatar: c.avatar || '', createdBy: c.created_by, createdAt: c.created_at,
    myRole: members.find(m => m.id === viewerId)?.role || null,
    members: members.map(m => ({ id: m.id, name: m.name, friendCode: m.friend_code, avatar: m.avatar || '', bio: m.bio || '', role: m.role })),
  };
}
function groupFields(data, { partial = false } = {}) {
  const out = {};
  if (!partial || data.title !== undefined) {
    const title = String(data.title ?? '').trim().normalize('NFC');
    if (!title || [...title].length > 60) throw Object.assign(new Error('O nome do grupo deve ter de 1 a 60 caracteres.'), { status: 400 });
    out.title = title;
  }
  if (!partial || data.description !== undefined) {
    const description = String(data.description ?? '').trim().normalize('NFC');
    if ([...description].length > 200) throw Object.assign(new Error('A descrição deve ter até 200 caracteres.'), { status: 400 });
    out.description = description;
  }
  if (data.avatar !== undefined) out.avatar = profileAvatar(data.avatar);
  return out;
}
function toMessage(row, userId) {
  const message = unpackStoredMessage(row.encrypted_body);
  let replyTo = null;
  if (row.reply_to_id) {
    const source = db.prepare(`SELECT id,conversation_id,sender_id,encrypted_body FROM messages WHERE id=?
      AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM message_hides h WHERE h.message_id=messages.id AND h.user_id=?))`).get(row.reply_to_id,userId ?? null,userId ?? null);
    if (source && source.conversation_id === row.conversation_id) {
      const original = unpackStoredMessage(source.encrypted_body);
      replyTo = { id: source.id, senderId: source.sender_id, senderName: userName(source.sender_id), kind: original.kind, preview: previewMessage(original).slice(0, 180) };
    }
  }
  const isFavorite = Number.isSafeInteger(userId)
    ? !!db.prepare('SELECT 1 FROM message_favorites WHERE user_id=? AND message_id=?').get(userId, row.id)
    : false;
  const reactions = db.prepare(`SELECT emoji,COUNT(*) AS count,MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine
    FROM message_reactions WHERE message_id=? GROUP BY emoji ORDER BY count DESC`).all(userId ?? -1,row.id);
  const isPinned = !!db.prepare('SELECT 1 FROM pinned_messages WHERE conversation_id=? AND message_id=?').get(row.conversation_id,row.id);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: userName(row.sender_id),
    kind: message.kind,
    ...(message.kind === 'text' ? {ciphertext:message.ciphertext} :
      message.kind === 'image' ? {image:message.image} :
      message.kind === 'contact' ? {contact:message.contact} :
      message.kind === 'system' ? {text:message.text} : {file:message.file}),
    preview: previewMessage(message),
    createdAt: row.created_at,
    revision: row.revision,
    replyTo,
    forwarded: !!row.forwarded_from,
    isFavorite,
    reactions: reactions.map(r=>({emoji:r.emoji,count:r.count,mine:!!r.mine})),
    isPinned, readAt: row.read_at || null, expiresAt: row.expires_at || null,
  };
}
const streams = new Map();
function broadcast(userId, payload, event = 'refresh') {
  for (const res of streams.get(userId) || []) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* cliente desconectado */ }
  }
}
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/voice-recorder.js', ['voice-recorder.js', 'text/javascript; charset=utf-8']],
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
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' data:; object-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
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
      if (method === 'GET' && url.pathname === '/api/favorites') {
        const rows = db.prepare(`SELECT m.*, f.created_at AS favorite_created_at, c.created_at AS conversation_created_at,
            c.kind AS c_kind, c.title AS c_title, c.avatar AS c_avatar,
            u.id AS partner_id, u.name AS partner_name, u.email AS partner_email, u.friend_code AS partner_code,
            u.avatar AS partner_avatar, u.bio AS partner_bio, COALESCE(cp.alias,'') AS contact_alias
          FROM message_favorites f
          JOIN messages m ON m.id=f.message_id
          JOIN conversations c ON c.id=m.conversation_id
          LEFT JOIN users u ON u.id=CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END
          LEFT JOIN conversation_preferences cp ON cp.user_id=? AND cp.conversation_id=c.id
          WHERE f.user_id=? AND ((c.kind='direct' AND (c.user_a=? OR c.user_b=?))
            OR (c.kind='group' AND EXISTS(SELECT 1 FROM group_members g WHERE g.conversation_id=c.id AND g.user_id=?)))
          ORDER BY f.created_at DESC LIMIT 100`).all(user.id,user.id,user.id,user.id,user.id,user.id);
        return json(res,200,{favorites:rows.map(row=>({
          message:toMessage(row,user.id), savedAt:row.favorite_created_at, conversationId:row.conversation_id,
          partner:row.c_kind==='group'
            ? {id:null,name:row.c_title,realName:row.c_title,email:'',friendCode:'',avatar:row.c_avatar||'',bio:''}
            : {id:row.partner_id,name:row.contact_alias||row.partner_name,realName:row.partner_name,email:row.partner_email,
              friendCode:row.partner_code,avatar:row.partner_avatar||'',bio:row.partner_bio||''},
        }))});
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
      // Indicador "digitando…": evento efêmero, nada é gravado.
      const typingMatch = url.pathname.match(/^\/api\/conversations\/(\d+)\/typing$/);
      if (typingMatch && method === 'POST') {
        const conversationId = Number(typingMatch[1]);
        if (!canReadConversation(user.id, conversationId)) return fail(res, 404, 'Conversa não encontrada.');
        const info = conversationInfo(conversationId);
        const targets = memberIds(conversationId).filter(id => id !== user.id);
        const blocked = info.kind === 'direct' && db.prepare('SELECT 1 FROM blocked_contacts WHERE (user_id=? AND contact_id=?) OR (user_id=? AND contact_id=?)').get(user.id, targets[0], targets[0], user.id);
        if (!blocked) for (const id of targets) broadcast(id, { conversationId, userId: user.id, name: user.name.split(/\s+/)[0] }, 'typing');
        return json(res, 200, { ok: true });
      }

      // ---- Grupos ----
      if (method === 'POST' && url.pathname === '/api/groups') {
        const data = await readJson(req);
        const fields = groupFields(data);
        const ids = assertAddableContacts(user.id, Array.isArray(data.memberIds) ? data.memberIds : []);
        if (!ids.length) return fail(res, 400, 'Escolha ao menos um participante.');
        if (ids.length + 1 > MAX_GROUP_MEMBERS) return fail(res, 400, `O grupo pode ter até ${MAX_GROUP_MEMBERS} participantes.`);
        const now = new Date().toISOString();
        let conversationId;
        db.exec('BEGIN');
        try {
          conversationId = Number(db.prepare(`INSERT INTO conversations(user_a,user_b,created_at,kind,title,description,avatar,created_by)
            VALUES(NULL,NULL,?,'group',?,?,?,?)`).run(now, fields.title, fields.description, fields.avatar || '', user.id).lastInsertRowid);
          db.prepare("INSERT INTO group_members(conversation_id,user_id,role,joined_at) VALUES(?,?,'admin',?)").run(conversationId, user.id, now);
          for (const id of ids) db.prepare("INSERT INTO group_members(conversation_id,user_id,role,joined_at) VALUES(?,?,'member',?)").run(conversationId, id, now);
          addSystemMessage(conversationId, user.id, `${user.name} criou o grupo “${fields.title}”`);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        broadcastConversation(conversationId);
        return json(res, 201, { conversationId });
      }
      const groupMatch = url.pathname.match(/^\/api\/groups\/(\d+)$/);
      if (groupMatch && ['GET', 'PATCH'].includes(method)) {
        const conversationId = Number(groupMatch[1]);
        if (!canReadConversation(user.id, conversationId) || conversationInfo(conversationId).kind !== 'group') return fail(res, 404, 'Grupo não encontrado.');
        if (method === 'GET') return json(res, 200, { group: groupDetails(conversationId, user.id) });
        if (groupRole(user.id, conversationId) !== 'admin') return fail(res, 403, 'Apenas administradores podem editar o grupo.');
        const data = await readJson(req);
        const fields = groupFields(data, { partial: true });
        const before = conversationInfo(conversationId);
        const next = { title: fields.title ?? before.title, description: fields.description ?? before.description, avatar: fields.avatar ?? before.avatar };
        db.prepare('UPDATE conversations SET title=?,description=?,avatar=? WHERE id=?').run(next.title, next.description, next.avatar, conversationId);
        if (next.title !== before.title) addSystemMessage(conversationId, user.id, `${user.name} alterou o nome do grupo para “${next.title}”`);
        if (next.avatar !== before.avatar) addSystemMessage(conversationId, user.id, next.avatar ? `${user.name} alterou a foto do grupo` : `${user.name} removeu a foto do grupo`);
        broadcastConversation(conversationId, { groupUpdated: true });
        return json(res, 200, { group: groupDetails(conversationId, user.id) });
      }
      const groupMembersMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/members$/);
      if (groupMembersMatch && method === 'POST') {
        const conversationId = Number(groupMembersMatch[1]);
        if (!canReadConversation(user.id, conversationId) || conversationInfo(conversationId).kind !== 'group') return fail(res, 404, 'Grupo não encontrado.');
        if (groupRole(user.id, conversationId) !== 'admin') return fail(res, 403, 'Apenas administradores podem adicionar participantes.');
        const data = await readJson(req);
        const ids = assertAddableContacts(user.id, Array.isArray(data.memberIds) ? data.memberIds : []).filter(id => !groupRole(id, conversationId));
        if (!ids.length) return fail(res, 400, 'Escolha contatos que ainda não estão no grupo.');
        if (memberIds(conversationId).length + ids.length > MAX_GROUP_MEMBERS) return fail(res, 400, `O grupo pode ter até ${MAX_GROUP_MEMBERS} participantes.`);
        const now = new Date().toISOString();
        db.exec('BEGIN');
        try {
          for (const id of ids) {
            // Quem entra não vê o histórico anterior.
            db.prepare('INSERT OR IGNORE INTO message_hides(user_id,message_id) SELECT ?,id FROM messages WHERE conversation_id=?').run(id, conversationId);
            db.prepare("INSERT INTO group_members(conversation_id,user_id,role,joined_at) VALUES(?,?,'member',?)").run(conversationId, id, now);
            db.prepare('DELETE FROM conversation_preferences WHERE user_id=? AND conversation_id=?').run(id, conversationId);
          }
          addSystemMessage(conversationId, user.id, `${user.name} adicionou ${ids.map(userName).join(', ')}`);
          db.prepare('UPDATE group_members SET last_read_id=(SELECT MAX(id) FROM messages WHERE conversation_id=?) WHERE conversation_id=? AND user_id IN (' + ids.map(() => '?').join(',') + ')').run(conversationId, conversationId, ...ids);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        broadcastConversation(conversationId, { groupUpdated: true });
        return json(res, 200, { group: groupDetails(conversationId, user.id) });
      }
      const groupMemberMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/members\/(\d+)(\/role)?$/);
      if (groupMemberMatch) {
        const conversationId = Number(groupMemberMatch[1]), targetId = Number(groupMemberMatch[2]);
        if (!canReadConversation(user.id, conversationId) || conversationInfo(conversationId).kind !== 'group') return fail(res, 404, 'Grupo não encontrado.');
        const myRole = groupRole(user.id, conversationId);
        const targetRole = groupRole(targetId, conversationId);
        if (!targetRole) return fail(res, 404, 'Participante não encontrado.');
        if (groupMemberMatch[3] && method === 'POST') {
          if (myRole !== 'admin') return fail(res, 403, 'Apenas administradores podem alterar funções.');
          const { role } = await readJson(req);
          if (!['admin', 'member'].includes(role)) return fail(res, 400, 'Função inválida.');
          if (targetId === user.id && role === 'member' && db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE conversation_id=? AND role='admin'").get(conversationId).n < 2) {
            return fail(res, 400, 'O grupo precisa de ao menos um administrador.');
          }
          if (role !== targetRole) {
            db.prepare('UPDATE group_members SET role=? WHERE conversation_id=? AND user_id=?').run(role, conversationId, targetId);
            addSystemMessage(conversationId, user.id, role === 'admin' ? `${user.name} tornou ${userName(targetId)} administrador` : `${user.name} removeu ${userName(targetId)} dos administradores`);
          }
          broadcastConversation(conversationId, { groupUpdated: true });
          return json(res, 200, { group: groupDetails(conversationId, user.id) });
        }
        if (!groupMemberMatch[3] && method === 'DELETE') {
          const leaving = targetId === user.id;
          if (!leaving) {
            if (myRole !== 'admin') return fail(res, 403, 'Apenas administradores podem remover participantes.');
            if (targetRole === 'admin') return fail(res, 403, 'Remova o status de administrador antes de remover esta pessoa.');
          }
          const recipients = memberIds(conversationId);
          db.exec('BEGIN');
          try {
            addSystemMessage(conversationId, user.id, leaving ? `${user.name} saiu do grupo` : `${user.name} removeu ${userName(targetId)}`);
            db.prepare('DELETE FROM group_members WHERE conversation_id=? AND user_id=?').run(conversationId, targetId);
            db.prepare('DELETE FROM conversation_preferences WHERE user_id=? AND conversation_id=?').run(targetId, conversationId);
            const remaining = db.prepare('SELECT user_id,role FROM group_members WHERE conversation_id=? ORDER BY joined_at,user_id').all(conversationId);
            if (!remaining.length) {
              db.prepare('DELETE FROM messages WHERE conversation_id=?').run(conversationId);
              db.prepare('DELETE FROM conversations WHERE id=?').run(conversationId);
            } else if (!remaining.some(r => r.role === 'admin')) {
              db.prepare("UPDATE group_members SET role='admin' WHERE conversation_id=? AND user_id=?").run(conversationId, remaining[0].user_id);
            }
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          for (const id of recipients) broadcast(id, { conversationId, groupUpdated: true });
          return json(res, 200, { ok: true });
        }
      }

      const preferenceMatch = url.pathname.match(/^\/api\/conversations\/(\d+)\/preferences$/);
      if (preferenceMatch && method === 'PUT') {
        const conversationId=Number(preferenceMatch[1]);
        if (!canReadConversation(user.id,conversationId)) return fail(res,404,'Conversa não encontrada.');
        const data=await readJson(req);
        const current=db.prepare('SELECT * FROM conversation_preferences WHERE user_id=? AND conversation_id=?').get(user.id,conversationId);
        const alias=String(data.alias??current?.alias??'').trim().normalize('NFC');
        const notificationsEnabled=typeof data.notificationsEnabled==='boolean'?data.notificationsEnabled:!!(current?.notifications_enabled??1);
        const archived=typeof data.archived==='boolean'?data.archived:!!(current?.archived??0);
        const pinned=typeof data.pinned==='boolean'?data.pinned:!!(current?.pinned??0);
        if (pinned && !current?.pinned && db.prepare('SELECT COUNT(*) AS n FROM conversation_preferences WHERE user_id=? AND pinned=1').get(user.id).n>=MAX_PINNED_CONVERSATIONS) return fail(res,400,`Você pode fixar até ${MAX_PINNED_CONVERSATIONS} conversas.`);
        const disappearingSeconds=data.disappearingSeconds===undefined?Number(current?.disappearing_seconds??0):Number(data.disappearingSeconds);
        if ([...alias].length>40) return fail(res,400,'O apelido deve ter até 40 caracteres.');
        if (![0,3600,86400,604800].includes(disappearingSeconds)) return fail(res,400,'Tempo de expiração inválido.');
        const now=new Date().toISOString();
        db.prepare(`INSERT INTO conversation_preferences(user_id,conversation_id,alias,notifications_enabled,archived,disappearing_seconds,pinned,is_deleted,updated_at)
          VALUES(?,?,?,?,?,?,?,0,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET alias=excluded.alias,
          notifications_enabled=excluded.notifications_enabled,archived=excluded.archived,disappearing_seconds=excluded.disappearing_seconds,pinned=excluded.pinned,is_deleted=0,updated_at=excluded.updated_at`)
          .run(user.id,conversationId,alias,notificationsEnabled?1:0,archived?1:0,disappearingSeconds,pinned?1:0,now);
        broadcast(user.id,{conversationId,preferencesUpdated:true});
        return json(res,200,{ok:true,alias,notificationsEnabled,archived,disappearingSeconds,pinned});
      }
      if (method==='GET' && url.pathname==='/api/search') {
        const query=String(url.searchParams.get('q')||'').trim().toLocaleLowerCase('pt-BR');
        if (query.length<2) return json(res,200,{results:[]});
        if (query.length>100) return fail(res,400,'A busca deve ter até 100 caracteres.');
        const rows=db.prepare(`SELECT m.*,c.kind AS c_kind,c.title AS c_title,u.id AS partner_id,u.name AS partner_name,u.email AS partner_email,COALESCE(cp.alias,'') AS contact_alias
          FROM messages m JOIN conversations c ON c.id=m.conversation_id
          LEFT JOIN users u ON u.id=CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END
          LEFT JOIN conversation_preferences cp ON cp.user_id=? AND cp.conversation_id=c.id
          WHERE ((c.kind='direct' AND (c.user_a=? OR c.user_b=?)) OR (c.kind='group' AND EXISTS(SELECT 1 FROM group_members g WHERE g.conversation_id=c.id AND g.user_id=?)))
          AND COALESCE(cp.is_deleted,0)=0
          AND NOT EXISTS(SELECT 1 FROM message_hides h WHERE h.user_id=? AND h.message_id=m.id)
          AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY m.id DESC LIMIT 300`).all(user.id,user.id,user.id,user.id,user.id,user.id,new Date().toISOString());
        const results=[];
        for(const row of rows){const msg=unpackStoredMessage(row.encrypted_body);if(msg.kind==='system')continue;const body=msg.kind==='text'?decodePegasus(msg.ciphertext):previewMessage(msg);
          if(body.toLocaleLowerCase('pt-BR').includes(query))results.push({conversationId:row.conversation_id,partner:row.c_kind==='group'?{id:null,name:row.c_title,email:''}:{id:row.partner_id,name:row.contact_alias||row.partner_name,email:row.partner_email},message:toMessage(row,user.id),match:body.slice(0,220)});
          if(results.length>=50)break;}
        return json(res,200,{results});
      }
      const pinListMatch=url.pathname.match(/^\/api\/conversations\/(\d+)\/pins$/);
      if(pinListMatch&&method==='GET'){
        const conversationId=Number(pinListMatch[1]);if(!canReadConversation(user.id,conversationId))return fail(res,404,'Conversa não encontrada.');
        const rows=db.prepare(`SELECT m.* FROM pinned_messages p JOIN messages m ON m.id=p.message_id WHERE p.conversation_id=?
          AND (m.expires_at IS NULL OR m.expires_at>?) AND NOT EXISTS(SELECT 1 FROM message_hides h WHERE h.user_id=? AND h.message_id=m.id) ORDER BY p.created_at DESC`).all(conversationId,new Date().toISOString(),user.id);
        return json(res,200,{messages:rows.map(row=>toMessage(row,user.id))});
      }
      const pinMatch=url.pathname.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)\/pin$/);
      if(pinMatch&&method==='POST'){
        const conversationId=Number(pinMatch[1]),messageId=Number(pinMatch[2]);if(!canReadConversation(user.id,conversationId))return fail(res,404,'Conversa não encontrada.');
        if(!db.prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?').get(messageId,conversationId))return fail(res,404,'Mensagem não encontrada.');
        const data=await readJson(req);if(typeof data.pinned!=='boolean')return fail(res,400,'Informe se a mensagem ficará fixada.');
        if(data.pinned)db.prepare('INSERT OR IGNORE INTO pinned_messages(conversation_id,message_id,pinned_by,created_at) VALUES(?,?,?,?)').run(conversationId,messageId,user.id,new Date().toISOString());
        else db.prepare('DELETE FROM pinned_messages WHERE conversation_id=? AND message_id=?').run(conversationId,messageId);
        broadcastConversation(conversationId,{pinsUpdated:true});
        return json(res,200,{ok:true,pinned:data.pinned});
      }
      const reactionMatch=url.pathname.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)\/reaction$/);
      if(reactionMatch&&method==='POST'){
        const conversationId=Number(reactionMatch[1]),messageId=Number(reactionMatch[2]);if(!canReadConversation(user.id,conversationId))return fail(res,404,'Conversa não encontrada.');
        if(!db.prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?').get(messageId,conversationId))return fail(res,404,'Mensagem não encontrada.');
        const data=await readJson(req),emoji=String(data.emoji||''),allowed=['👍','❤️','😂','😮','😢','🔥','👏','🙏'];
        if(emoji&&!allowed.includes(emoji))return fail(res,400,'Reação não permitida.');
        if(!emoji)db.prepare('DELETE FROM message_reactions WHERE message_id=? AND user_id=?').run(messageId,user.id);
        else db.prepare('INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji,created_at=excluded.created_at').run(messageId,user.id,emoji,new Date().toISOString());
        broadcastConversation(conversationId,{reactionsUpdated:true});
        return json(res,200,{ok:true,emoji:emoji||null});
      }
      const clearConversationMatch=url.pathname.match(/^\/api\/conversations\/(\d+)\/clear$/);
      if (clearConversationMatch && method==='POST') {
        const conversationId=Number(clearConversationMatch[1]);
        if (!canReadConversation(user.id,conversationId)) return fail(res,404,'Conversa não encontrada.');
        db.prepare(`INSERT OR IGNORE INTO message_hides(user_id,message_id)
          SELECT ?,id FROM messages WHERE conversation_id=?`).run(user.id,conversationId);
        broadcast(user.id,{conversationId,conversationCleared:true});
        return json(res,200,{ok:true});
      }
      const blockMatch=url.pathname.match(/^\/api\/conversations\/(\d+)\/(block|unblock)$/);
      if (blockMatch && method==='POST') {
        const conversationId=Number(blockMatch[1]);
        const conversation=db.prepare('SELECT user_a,user_b FROM conversations WHERE id=? AND (user_a=? OR user_b=?)').get(conversationId,user.id,user.id);
        if (!conversation) return fail(res,404,'Conversa não encontrada.');
        const partnerId=conversation.user_a===user.id?conversation.user_b:conversation.user_a;
        if (blockMatch[2]==='block') db.prepare('INSERT OR IGNORE INTO blocked_contacts(user_id,contact_id,created_at) VALUES(?,?,?)').run(user.id,partnerId,new Date().toISOString());
        else db.prepare('DELETE FROM blocked_contacts WHERE user_id=? AND contact_id=?').run(user.id,partnerId);
        broadcast(user.id,{conversationId,blockUpdated:true});broadcast(partnerId,{conversationId,blockUpdated:true});
        return json(res,200,{ok:true,blocked:blockMatch[2]==='block'});
      }
      const deleteContactMatch=url.pathname.match(/^\/api\/conversations\/(\d+)\/contact$/);
      if (deleteContactMatch && method==='DELETE') {
        const conversationId=Number(deleteContactMatch[1]);
        if (!canReadConversation(user.id,conversationId)) return fail(res,404,'Conversa não encontrada.');
        db.prepare(`INSERT INTO conversation_preferences(user_id,conversation_id,alias,notifications_enabled,is_deleted,updated_at)
          VALUES(?,?, '',1,1,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET is_deleted=1,updated_at=excluded.updated_at`)
          .run(user.id,conversationId,new Date().toISOString());
        broadcast(user.id,{conversationId,contactDeleted:true});
        return json(res,200,{ok:true});
      }
      if (method === 'GET' && url.pathname === '/api/conversations') {
        const nowIso = new Date().toISOString();
        db.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at<=?').run(nowIso);
        const lastMessageOf = (conversationId) => db.prepare(`SELECT * FROM messages WHERE conversation_id = ?
          AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = messages.id AND h.user_id = ?) ORDER BY id DESC LIMIT 1`).get(conversationId, user.id);
        const shapeLast = (row, withSender) => {
          if (!row) return null;
          const parsed = unpackStoredMessage(row.encrypted_body);
          return { id: row.id, senderId: row.sender_id, kind: parsed.kind,
            ...(parsed.kind === 'text' ? { ciphertext: parsed.ciphertext } : {}),
            preview: previewMessage(parsed), createdAt: row.created_at,
            ...(withSender ? { senderName: userName(row.sender_id).split(/\s+/)[0] } : {}) };
        };
        const directRows = db.prepare(`SELECT c.id, c.created_at, u.id AS partner_id, u.name AS partner_name,
           u.email AS partner_email, u.friend_code AS partner_code, u.avatar AS partner_avatar, u.bio AS partner_bio,
           COALESCE(cp.alias,'') AS contact_alias, COALESCE(cp.notifications_enabled,1) AS notifications_enabled, COALESCE(cp.archived,0) AS archived, COALESCE(cp.disappearing_seconds,0) AS disappearing_seconds, COALESCE(cp.pinned,0) AS pinned,
           EXISTS(SELECT 1 FROM blocked_contacts b WHERE b.user_id=? AND b.contact_id=u.id) AS blocked_by_me,
           EXISTS(SELECT 1 FROM blocked_contacts b WHERE b.user_id=u.id AND b.contact_id=?) AS blocked_by_partner
           FROM conversations c
           JOIN users u ON u.id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END
           LEFT JOIN conversation_preferences cp ON cp.conversation_id=c.id AND cp.user_id=?
           WHERE c.kind='direct' AND (c.user_a = ? OR c.user_b = ?) AND COALESCE(cp.is_deleted,0)=0`).all(user.id,user.id,user.id,user.id,user.id,user.id);
        const unreadDirect = db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.conversation_id=? AND m.sender_id<>? AND m.read_at IS NULL
          AND (m.expires_at IS NULL OR m.expires_at>?) AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id=m.id AND h.user_id=?)`);
        const conversations = directRows.map(row => {
          const last = lastMessageOf(row.id);
          return {
            kind: 'direct', id: row.id, createdAt: row.created_at,
            notificationsEnabled: !!row.notifications_enabled, archived: !!row.archived, pinned: !!row.pinned,
            disappearingSeconds: row.disappearing_seconds,
            unreadCount: unreadDirect.get(row.id, user.id, nowIso, user.id).n,
            blockedByMe: !!row.blocked_by_me, blockedByPartner: !!row.blocked_by_partner,
            partner: { id: row.partner_id, name: row.contact_alias || row.partner_name, realName: row.partner_name,
              alias: row.contact_alias || '', email: row.partner_email, friendCode: row.partner_code || '',
              avatar: row.partner_avatar || '', bio: row.partner_bio || '' },
            lastMessage: shapeLast(last, false),
            _sort: last?.id || 0,
          };
        });
        const groupRows = db.prepare(`SELECT c.id,c.created_at,c.title,c.description,c.avatar,c.created_by,g.role,g.last_read_id,
           COALESCE(cp.notifications_enabled,1) AS notifications_enabled, COALESCE(cp.archived,0) AS archived,
           COALESCE(cp.disappearing_seconds,0) AS disappearing_seconds, COALESCE(cp.pinned,0) AS pinned
           FROM conversations c JOIN group_members g ON g.conversation_id=c.id AND g.user_id=?
           LEFT JOIN conversation_preferences cp ON cp.conversation_id=c.id AND cp.user_id=?
           WHERE c.kind='group' AND COALESCE(cp.is_deleted,0)=0`).all(user.id,user.id);
        const unreadGroup = db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.conversation_id=? AND m.id>? AND m.sender_id<>?
          AND (m.expires_at IS NULL OR m.expires_at>?) AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id=m.id AND h.user_id=?)`);
        const memberRows = db.prepare('SELECT u.id,u.name,g.role FROM group_members g JOIN users u ON u.id=g.user_id WHERE g.conversation_id=? ORDER BY g.joined_at,u.id');
        for (const row of groupRows) {
          const last = lastMessageOf(row.id);
          const members = memberRows.all(row.id).map(m => ({ id: m.id, name: m.name, role: m.role }));
          conversations.push({
            kind: 'group', id: row.id, createdAt: row.created_at,
            notificationsEnabled: !!row.notifications_enabled, archived: !!row.archived, pinned: !!row.pinned,
            disappearingSeconds: row.disappearing_seconds,
            unreadCount: unreadGroup.get(row.id, row.last_read_id, user.id, nowIso, user.id).n,
            blockedByMe: false, blockedByPartner: false,
            // "partner" descreve o grupo para telas que só conhecem contatos (lista, cabeçalho, encaminhar).
            partner: { id: null, name: row.title, realName: row.title, alias: '', email: '', friendCode: '',
              avatar: row.avatar || '', bio: members.map(m => m.id === user.id ? 'Você' : m.name.split(/\s+/)[0]).join(', ') },
            group: { title: row.title, description: row.description, createdBy: row.created_by, myRole: row.role, members },
            lastMessage: shapeLast(last, true),
            _sort: last?.id || 0,
          });
        }
        conversations.sort((x, y) => (Number(y.pinned) - Number(x.pinned)) || (y._sort - x._sort) || (y.id - x.id));
        for (const conversation of conversations) delete conversation._sort;
        return json(res, 200, { conversations });
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
        if (existing) {
          db.prepare('UPDATE conversation_preferences SET is_deleted=0,updated_at=? WHERE user_id=? AND conversation_id=?')
            .run(new Date().toISOString(),user.id,existing.id);
          return json(res,200,{conversationId:existing.id,status:'connected'});
        }
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
          const nowIso=new Date().toISOString();
          db.prepare('DELETE FROM messages WHERE conversation_id=? AND expires_at IS NOT NULL AND expires_at<=?').run(conversationId,nowIso);
          if (conversationInfo(conversationId).kind === 'group') {
            // Grupos não têm "lida" individual: guardamos até onde cada participante leu, para o contador de não lidas.
            db.prepare('UPDATE group_members SET last_read_id=(SELECT COALESCE(MAX(id),0) FROM messages WHERE conversation_id=?) WHERE conversation_id=? AND user_id=?').run(conversationId,conversationId,user.id);
          } else {
            const readResult=db.prepare('UPDATE messages SET read_at=? WHERE conversation_id=? AND sender_id<>? AND read_at IS NULL AND (expires_at IS NULL OR expires_at>?)').run(nowIso,conversationId,user.id,nowIso);
            if(readResult.changes) broadcastConversation(conversationId,{readUpdated:true},user.id);
          }
          const around=Number(url.searchParams.get('around'));
          let rows;
          if (Number.isSafeInteger(around)&&around>0) {
            const target=db.prepare(`SELECT id FROM messages WHERE id=? AND conversation_id=?
              AND NOT EXISTS(SELECT 1 FROM message_hides h WHERE h.message_id=messages.id AND h.user_id=?)`).get(around,conversationId,user.id);
            if (!target) return fail(res,404,'Mensagem não encontrada nesta conversa.');
            const before=db.prepare(`SELECT * FROM messages WHERE conversation_id=? AND id<=?
              AND (expires_at IS NULL OR expires_at>?) AND NOT EXISTS(SELECT 1 FROM message_hides h WHERE h.message_id=messages.id AND h.user_id=?)
              ORDER BY id DESC LIMIT 50`).all(conversationId,around,new Date().toISOString(),user.id);
            const after=db.prepare(`SELECT * FROM messages WHERE conversation_id=? AND id>?
              AND (expires_at IS NULL OR expires_at>?) AND NOT EXISTS(SELECT 1 FROM message_hides h WHERE h.message_id=messages.id AND h.user_id=?)
              ORDER BY id ASC LIMIT 50`).all(conversationId,around,new Date().toISOString(),user.id);
            rows=[...before.reverse(),...after];
          } else {
            rows = db.prepare(`SELECT * FROM (
              SELECT * FROM messages WHERE conversation_id = ?
                AND (expires_at IS NULL OR expires_at>?) AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = messages.id AND h.user_id = ?)
              ORDER BY id DESC LIMIT 100
            ) ORDER BY id ASC`).all(conversationId, new Date().toISOString(), user.id);
          }
          return json(res, 200, { messages: rows.map(row => toMessage(row,user.id)) });
        }
        if (method === 'POST') {
          const payload = await readJson(req);
          const others = memberIds(conversationId).filter(id => id !== user.id);
          if (conversationInfo(conversationId).kind === 'direct') {
            const blocked = db.prepare('SELECT 1 FROM blocked_contacts WHERE (user_id=? AND contact_id=?) OR (user_id=? AND contact_id=?)')
              .get(user.id,others[0],others[0],user.id);
            if (blocked) return fail(res,403,'Esta conversa está bloqueada. Desbloqueie o contato para enviar mensagens.');
          }
          const kind = ['image','audio','document','contact','text'].includes(payload.kind) ? payload.kind : payload.kind == null ? 'text' : null;
          if (!kind) return fail(res, 400, 'Tipo de mensagem inválido.');
          let message;
          if (kind === 'image') {
            const image = validateImagePayload(payload.image);
            message = { kind: 'image', image };
          } else if (kind === 'audio' || kind === 'document') {
            message = { kind, file: validateFilePayload(payload.file, kind) };
          } else if (kind === 'contact') {
            message = { kind: 'contact', contact:validateSharedContact(user.id, Number(payload.contactId)) };
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
          let replyToId = null;
          if (payload.replyToId !== undefined && payload.replyToId !== null && payload.replyToId !== '') {
            replyToId = Number(payload.replyToId);
            if (!Number.isSafeInteger(replyToId) || !db.prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?').get(replyToId,conversationId)) {
              return fail(res,400,'A mensagem respondida não existe mais nesta conversa.');
            }
          }
          const encrypted = packStoredMessage(message);
          const createdAt = new Date().toISOString();
          const disappearingSeconds=Number(db.prepare('SELECT disappearing_seconds FROM conversation_preferences WHERE user_id=? AND conversation_id=?').get(user.id,conversationId)?.disappearing_seconds||0);
          const expiresAt=disappearingSeconds?new Date(Date.now()+disappearingSeconds*1000).toISOString():null;
          const result = db.prepare(`INSERT INTO messages (conversation_id,sender_id,encrypted_body,created_at,reply_to_id,expires_at)
            VALUES (?,?,?,?,?,?)`).run(conversationId, user.id, encrypted, createdAt, replyToId, expiresAt);
          for (const otherId of others) {
            db.prepare('UPDATE conversation_preferences SET is_deleted=0,updated_at=? WHERE user_id=? AND conversation_id=?')
              .run(createdAt,otherId,conversationId);
          }
          broadcastConversation(conversationId);
          return json(res, 201, {
            message: {
              id: Number(result.lastInsertRowid),
              conversationId,
              senderId: user.id,
              senderName: user.name,
              kind: message.kind,
              ...(message.kind === 'text' ? {ciphertext:message.ciphertext} :
      message.kind === 'image' ? {image:message.image} :
      message.kind === 'contact' ? {contact:message.contact} : {file:message.file}),
              preview: previewMessage(message),
              createdAt,
              revision: 0,
              replyToId,
              replyTo: replyToId ? (() => { const source=db.prepare('SELECT id,sender_id,encrypted_body FROM messages WHERE id=?').get(replyToId); const original=unpackStoredMessage(source.encrypted_body); return {id:source.id,senderId:source.sender_id,senderName:user.name,kind:original.kind,preview:previewMessage(original).slice(0,180)}; })() : null,
              forwarded: false,
              isFavorite: false, reactions: [], isPinned: false, readAt: null, expiresAt,
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
      const favoriteMatch=url.pathname.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)\/favorite$/);
      if (favoriteMatch && method==='POST') {
        const conversationId=Number(favoriteMatch[1]),messageId=Number(favoriteMatch[2]);
        if (!canReadConversation(user.id,conversationId)) return fail(res,404,'Conversa não encontrada.');
        if (!db.prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?').get(messageId,conversationId)) return fail(res,404,'Mensagem não encontrada.');
        const data=await readJson(req);
        if (typeof data.favorite!=='boolean') return fail(res,400,'Informe se a mensagem será favorita.');
        if (data.favorite) db.prepare('INSERT OR IGNORE INTO message_favorites(user_id,message_id,created_at) VALUES(?,?,?)').run(user.id,messageId,new Date().toISOString());
        else db.prepare('DELETE FROM message_favorites WHERE user_id=? AND message_id=?').run(user.id,messageId);
        broadcast(user.id,{conversationId,favoritesUpdated:true});
        return json(res,200,{ok:true,favorite:data.favorite});
      }
      const forwardMatch=url.pathname.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)\/forward$/);
      if (forwardMatch && method==='POST') {
        const sourceConversationId=Number(forwardMatch[1]),messageId=Number(forwardMatch[2]);
        if (!canReadConversation(user.id,sourceConversationId)) return fail(res,404,'Conversa original não encontrada.');
        const data=await readJson(req);const targetConversationId=Number(data.targetConversationId);
        if (!Number.isSafeInteger(targetConversationId)||!canReadConversation(user.id,targetConversationId)) return fail(res,404,'Conversa de destino não encontrada.');
        if (targetConversationId===sourceConversationId) return fail(res,400,'Escolha outra conversa para encaminhar.');
        const original=db.prepare('SELECT * FROM messages WHERE id=? AND conversation_id=?').get(messageId,sourceConversationId);
        if (!original) return fail(res,404,'Mensagem original não encontrada.');
        if (unpackStoredMessage(original.encrypted_body).kind === 'system') return fail(res,400,'Avisos do grupo não podem ser encaminhados.');
        const targetOthers=memberIds(targetConversationId).filter(id=>id!==user.id);
        if (conversationInfo(targetConversationId).kind==='direct') {
          const blocked=db.prepare('SELECT 1 FROM blocked_contacts WHERE (user_id=? AND contact_id=?) OR (user_id=? AND contact_id=?)')
            .get(user.id,targetOthers[0],targetOthers[0],user.id);
          if (blocked) return fail(res,403,'A conversa de destino está bloqueada.');
        }
        const createdAt=new Date().toISOString();
        const result=db.prepare(`INSERT INTO messages(conversation_id,sender_id,encrypted_body,created_at,revision,reply_to_id,forwarded_from)
          VALUES(?,?,?,?,0,NULL,?)`).run(targetConversationId,user.id,original.encrypted_body,createdAt,messageId);
        for (const otherId of targetOthers) db.prepare('UPDATE conversation_preferences SET is_deleted=0,updated_at=? WHERE user_id=? AND conversation_id=?')
          .run(createdAt,otherId,targetConversationId);
        broadcastConversation(targetConversationId);
        return json(res,201,{ok:true,messageId:Number(result.lastInsertRowid),targetConversationId});
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
        if (unpackStoredMessage(original.encrypted_body).kind === 'system') return fail(res, 403, 'Avisos do grupo não podem ser alterados.');
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
        broadcastConversation(conversationId);
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
