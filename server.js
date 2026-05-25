const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 50070;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;
const AUTH_SECRET = process.env.AUTH_SECRET || ADMIN_PASSWORD || 'change-this-secret';
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const startedAt = new Date();

let pool;
let mailer;
const eventClients = new Map();

app.use(express.json({ limit: '8mb' }));

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function base64Url(input) {
    return Buffer.from(input).toString('base64url');
}

function sign(value) {
    return crypto.createHmac('sha256', AUTH_SECRET).update(value).digest('base64url');
}

function createToken(user) {
    const payload = base64Url(JSON.stringify({
        id: user.id,
        username: user.username,
        exp: Date.now() + 1000 * 60 * 60 * 24 * 30,
    }));
    return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
    if (!token || !token.includes('.')) return null;
    const [payload, signature] = token.split('.');
    if (sign(payload) !== signature) return null;

    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data.exp || data.exp < Date.now()) return null;
        return data;
    } catch {
        return null;
    }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
    const [salt] = String(storedHash).split(':');
    return hashPassword(password, salt) === storedHash;
}

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function cleanDisplayName(displayName, username) {
    return String(displayName || username).trim().slice(0, 60);
}

function cleanEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function cleanMessage(body) {
    return String(body || '').trim().slice(0, 4000);
}

function getMailer() {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) return null;
    if (!mailer) {
        mailer = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_PORT === 465,
            auth: {
                user: SMTP_USER,
                pass: SMTP_PASSWORD,
            },
        });
    }
    return mailer;
}

async function sendMail({ to, subject, text }) {
    const transport = getMailer();
    if (!transport) return false;

    await transport.sendMail({
        from: SMTP_FROM,
        to,
        subject,
        text,
    });
    return true;
}

function parseImageAttachment(attachment) {
    if (!attachment) return null;

    const mimeType = String(attachment.mimeType || '').toLowerCase();
    const fileName = String(attachment.fileName || 'bild').replace(/[^\w.\- ]/g, '').slice(0, 120) || 'bild';
    const dataBase64 = String(attachment.dataBase64 || '');

    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) {
        const error = new Error('Nur JPEG, PNG, WebP und GIF sind erlaubt');
        error.statusCode = 400;
        throw error;
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
        const error = new Error('Bild muss kleiner als 5 MB sein');
        error.statusCode = 400;
        throw error;
    }

    return {
        fileName,
        mimeType,
        sizeBytes: buffer.length,
        data: buffer,
    };
}

function formatDuration(totalSeconds) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function getDatabasePool() {
    if (!DATABASE_URL) return null;
    if (!pool) {
        pool = new Pool({
            connectionString: DATABASE_URL,
            ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
        });
    }
    return pool;
}

async function query(sql, params = []) {
    const dbPool = getDatabasePool();
    if (!dbPool) {
        const error = new Error('DATABASE_URL ist nicht gesetzt');
        error.statusCode = 503;
        throw error;
    }
    return dbPool.query(sql, params);
}

async function initDatabase() {
    const dbPool = getDatabasePool();
    if (!dbPool) return;

    await dbPool.query(`
        create table if not exists users (
            id bigserial primary key,
            username text not null unique,
            display_name text not null,
            email text,
            password_hash text not null,
            about text not null default '',
            avatar_color text not null default '#2563eb',
            created_at timestamptz not null default now(),
            last_seen_at timestamptz
        );

        create table if not exists conversations (
            id bigserial primary key,
            user_one_id bigint not null references users(id) on delete cascade,
            user_two_id bigint not null references users(id) on delete cascade,
            created_at timestamptz not null default now(),
            unique(user_one_id, user_two_id),
            check(user_one_id <> user_two_id)
        );

        create table if not exists messages (
            id bigserial primary key,
            conversation_id bigint not null references conversations(id) on delete cascade,
            sender_id bigint not null references users(id) on delete cascade,
            body text not null,
            created_at timestamptz not null default now(),
            read_at timestamptz
        );

        create table if not exists message_attachments (
            id bigserial primary key,
            message_id bigint not null references messages(id) on delete cascade,
            file_name text not null,
            mime_type text not null,
            size_bytes integer not null,
            data bytea not null,
            created_at timestamptz not null default now()
        );

        create table if not exists admin_audit_logs (
            id bigserial primary key,
            admin_user text not null,
            action text not null,
            ip_address text,
            created_at timestamptz not null default now()
        );

        alter table users add column if not exists email text;
        alter table users add column if not exists email_verified_at timestamptz;

        create unique index if not exists idx_users_email_unique
            on users(email)
            where email is not null and email <> '';
        create index if not exists idx_messages_conversation_created
            on messages(conversation_id, created_at);
        create index if not exists idx_conversations_user_one
            on conversations(user_one_id);
        create index if not exists idx_conversations_user_two
            on conversations(user_two_id);
    `);
}

async function waitForDatabase() {
    if (!DATABASE_URL) return;
    let lastError;

    for (let attempt = 1; attempt <= 30; attempt += 1) {
        try {
            await initDatabase();
            console.log('Datenbank bereit');
            return;
        } catch (error) {
            lastError = error;
            console.log(`Warte auf Datenbank (${attempt}/30): ${error.message}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    throw lastError;
}

async function getUserById(userId) {
    const result = await query(
        'select id, username, display_name, email, about, avatar_color, created_at, last_seen_at from users where id = $1',
        [userId],
    );
    return result.rows[0] || null;
}

async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    const session = verifyToken(token);

    if (!session) {
        return res.status(401).json({ error: 'Nicht angemeldet' });
    }

    try {
        const user = await getUserById(session.id);
        if (!user) return res.status(401).json({ error: 'Benutzer nicht gefunden' });

        req.user = user;
        await query('update users set last_seen_at = now() where id = $1', [user.id]);
        return next();
    } catch (error) {
        return next(error);
    }
}

function addEventClient(userId, res) {
    const key = String(userId);
    const clients = eventClients.get(key) || new Set();
    clients.add(res);
    eventClients.set(key, clients);

    res.on('close', () => {
        clients.delete(res);
        if (clients.size === 0) eventClients.delete(key);
    });
}

function sendEvent(userId, event, payload) {
    const clients = eventClients.get(String(userId));
    if (!clients) return;

    for (const client of clients) {
        client.write(`event: ${event}\n`);
        client.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
}

async function getConversationForUser(conversationId, userId) {
    const result = await query(
        `select c.*,
            case when c.user_one_id = $2 then c.user_two_id else c.user_one_id end as other_user_id
         from conversations c
         where c.id = $1 and ($2 in (c.user_one_id, c.user_two_id))`,
        [conversationId, userId],
    );
    return result.rows[0] || null;
}

function conversationPair(userA, userB) {
    const first = Math.min(Number(userA), Number(userB));
    const second = Math.max(Number(userA), Number(userB));
    return [first, second];
}

async function getDashboardData() {
    const dbPool = getDatabasePool();
    const data = {
        appName: process.env.APP_NAME || 'JustChat',
        environment: process.env.NODE_ENV || 'development',
        port: PORT,
        uptime: formatDuration(Math.floor(process.uptime())),
        startedAt: startedAt.toISOString(),
        nodeVersion: process.version,
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        database: {
            configured: Boolean(DATABASE_URL),
            online: null,
            latencyMs: null,
            message: DATABASE_URL ? 'Noch nicht geprueft' : 'DATABASE_URL ist nicht gesetzt',
        },
        authConfigured: Boolean(ADMIN_PASSWORD),
        onlineEventClients: Array.from(eventClients.values()).reduce((sum, clients) => sum + clients.size, 0),
    };

    if (dbPool) {
        const before = Date.now();
        try {
            await dbPool.query('select 1');
            data.database.online = true;
            data.database.latencyMs = Date.now() - before;
            data.database.message = 'Verbindung erfolgreich';
        } catch (error) {
            data.database.online = false;
            data.database.message = error.message;
        }
    }

    return data;
}

function requireAdminAuth(req, res, next) {
    if (!ADMIN_PASSWORD) {
        return res.status(503).send(renderAdminLayout(`
            <header>
                <div>
                    <h1>Admin Dashboard</h1>
                    <p class="muted">Die Admin-Anmeldung ist noch nicht konfiguriert.</p>
                </div>
                <span class="status warn">Setup erforderlich</span>
            </header>
            <section class="panel">
                <h2>Naechster Schritt</h2>
                <p>Setze <code>ADMIN_PASSWORD</code> als Umgebungsvariable und starte den Server neu.</p>
            </section>
        `));
    }

    const authHeader = req.headers.authorization || '';
    const [scheme, encoded] = authHeader.split(' ');

    if (scheme === 'Basic' && encoded) {
        const credentials = Buffer.from(encoded, 'base64').toString('utf8');
        const separatorIndex = credentials.indexOf(':');

        if (separatorIndex >= 0) {
            const user = credentials.slice(0, separatorIndex);
            const password = credentials.slice(separatorIndex + 1);

            if (user === ADMIN_USER && password === ADMIN_PASSWORD) {
                return next();
            }
        }
    }

    res.set('WWW-Authenticate', 'Basic realm="JustChat Admin"');
    return res.status(401).send('Admin login erforderlich');
}

function statusClass(value) {
    if (value === true) return 'ok';
    if (value === false) return 'error';
    return 'warn';
}

function statusText(value) {
    if (value === true) return 'Online';
    if (value === false) return 'Fehler';
    return 'Nicht konfiguriert';
}

function renderAdminLayout(content) {
    return `<!doctype html>
<html lang="de">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>JustChat Admin</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #eef2f7;
            --panel: #ffffff;
            --text: #172033;
            --muted: #667085;
            --line: #d9e1ec;
            --accent: #2563eb;
            --ok: #138a45;
            --warn: #9a6700;
            --error: #c62828;
        }
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; font-family: Arial, sans-serif; background: var(--bg); color: var(--text); }
        main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0; }
        header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
        h1, h2, p { margin: 0; }
        h1 { font-size: clamp(28px, 4vw, 44px); letter-spacing: 0; }
        h2 { font-size: 18px; margin-bottom: 16px; }
        .muted { color: var(--muted); margin-top: 8px; }
        .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
        .panel, .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 20px; }
        .panel { margin-top: 16px; }
        .metric span { display: block; color: var(--muted); font-size: 13px; margin-bottom: 10px; }
        .metric strong { display: block; font-size: 24px; line-height: 1.15; overflow-wrap: anywhere; }
        .status { display: inline-flex; align-items: center; border-radius: 999px; border: 1px solid currentColor; padding: 6px 10px; font-size: 13px; font-weight: 700; }
        .ok { color: var(--ok); }
        .warn { color: var(--warn); }
        .error { color: var(--error); }
        dl { display: grid; grid-template-columns: 180px 1fr; gap: 12px 18px; margin: 0; }
        dt { color: var(--muted); }
        dd { margin: 0; overflow-wrap: anywhere; }
        code { background: #f5f7fb; border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
        a { color: var(--accent); font-weight: 700; text-decoration: none; }
        @media (max-width: 820px) {
            header { align-items: flex-start; flex-direction: column; }
            .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            dl { grid-template-columns: 1fr; }
        }
        @media (max-width: 520px) {
            .grid { grid-template-columns: 1fr; }
            main { width: min(100% - 24px, 1120px); padding: 20px 0; }
            .panel, .metric { padding: 16px; }
        }
    </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

function renderDashboard(data) {
    const dbStatus = statusClass(data.database.online);

    return renderAdminLayout(`
        <header>
            <div>
                <h1>${escapeHtml(data.appName)} Admin</h1>
                <p class="muted">Betrieb, Datenbank und Messenger-Status.</p>
            </div>
            <span class="status ${dbStatus}">Datenbank: ${statusText(data.database.online)}</span>
        </header>
        <section class="grid" aria-label="Server Kennzahlen">
            <div class="metric"><span>Umgebung</span><strong>${escapeHtml(data.environment)}</strong></div>
            <div class="metric"><span>Uptime</span><strong>${escapeHtml(data.uptime)}</strong></div>
            <div class="metric"><span>Speicher</span><strong>${escapeHtml(data.memoryMb)} MB</strong></div>
            <div class="metric"><span>Live-Verbindungen</span><strong>${escapeHtml(data.onlineEventClients)}</strong></div>
        </section>
        <section class="panel">
            <h2>System</h2>
            <dl>
                <dt>Gestartet</dt><dd>${escapeHtml(data.startedAt)}</dd>
                <dt>Node.js</dt><dd>${escapeHtml(data.nodeVersion)}</dd>
                <dt>Port</dt><dd>${escapeHtml(data.port)}</dd>
                <dt>Admin Login</dt><dd>${data.authConfigured ? 'Konfiguriert' : 'Nicht konfiguriert'}</dd>
            </dl>
        </section>
        <section class="panel">
            <h2>Datenbank</h2>
            <dl>
                <dt>Status</dt><dd><span class="status ${dbStatus}">${statusText(data.database.online)}</span></dd>
                <dt>Konfiguriert</dt><dd>${data.database.configured ? 'Ja' : 'Nein'}</dd>
                <dt>Latenz</dt><dd>${data.database.latencyMs === null ? '-' : `${data.database.latencyMs} ms`}</dd>
                <dt>Meldung</dt><dd>${escapeHtml(data.database.message)}</dd>
            </dl>
        </section>
        <section class="panel">
            <h2>Sicherheits-Export</h2>
            <p>Exportiert Benutzer, 1:1-Chats, Nachrichten und Bildanhaenge als JSON-Datei fuer berechtigte Pruefungen.</p>
            <p class="muted"><a href="/admin/export">Chatverlauf herunterladen</a></p>
        </section>
    `);
}

function renderMessengerApp() {
    return `<!doctype html>
<html lang="de">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>JustChat</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #f0f4f8;
            --sidebar: #ffffff;
            --panel: #ffffff;
            --text: #162033;
            --muted: #64748b;
            --line: #d8e0ea;
            --accent: #0f766e;
            --accent-strong: #115e59;
            --message-me: #d7f8ed;
            --message-other: #ffffff;
            --danger: #b42318;
        }
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; font-family: Arial, sans-serif; background: var(--bg); color: var(--text); }
        button, input, textarea { font: inherit; }
        button { cursor: pointer; border: 0; }
        .auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
        .auth-card { width: min(420px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 24px; }
        .auth-card h1 { margin: 0 0 6px; font-size: 32px; letter-spacing: 0; }
        .muted { color: var(--muted); }
        .stack { display: grid; gap: 12px; }
        .field { display: grid; gap: 6px; }
        .field label { color: var(--muted); font-size: 13px; font-weight: 700; }
        .field input, .field textarea {
            width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 11px 12px; outline: none; background: #fff;
        }
        .field input:focus, .field textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(15, 118, 110, .12); }
        .primary { background: var(--accent); color: #fff; border-radius: 8px; padding: 11px 14px; font-weight: 700; }
        .primary:hover { background: var(--accent-strong); }
        .ghost { background: transparent; color: var(--accent); font-weight: 700; padding: 8px; }
        .error { color: var(--danger); min-height: 20px; }
        .app { height: 100vh; display: grid; grid-template-columns: 360px 1fr; }
        .sidebar { background: var(--sidebar); border-right: 1px solid var(--line); display: grid; grid-template-rows: auto auto 1fr; min-width: 0; }
        .topbar { padding: 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .brand { min-width: 0; }
        .brand strong { display: block; font-size: 20px; overflow-wrap: anywhere; }
        .brand span { display: block; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
        .search { padding: 12px 16px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
        .search input { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; width: 100%; }
        .list { overflow: auto; }
        .row { width: 100%; background: transparent; display: grid; grid-template-columns: 44px 1fr; gap: 12px; padding: 12px 16px; text-align: left; border-bottom: 1px solid #edf1f6; }
        .row:hover, .row.active { background: #eef8f6; }
        .avatar { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 800; }
        .row-main { min-width: 0; }
        .row-title { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
        .row-title strong, .preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .preview { color: var(--muted); font-size: 13px; margin-top: 4px; }
        .chat { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
        .chat-head { background: var(--panel); border-bottom: 1px solid var(--line); padding: 14px 18px; display: flex; align-items: center; gap: 12px; min-width: 0; }
        .messages { padding: 18px; overflow: auto; display: flex; flex-direction: column; gap: 8px; background: #e9f0f4; }
        .bubble { max-width: min(680px, 82%); border: 1px solid rgba(15, 23, 42, .08); border-radius: 8px; padding: 9px 11px; background: var(--message-other); align-self: flex-start; overflow-wrap: anywhere; }
        .bubble.me { background: var(--message-me); align-self: flex-end; }
        .bubble img { display: block; max-width: min(420px, 100%); border-radius: 8px; margin-bottom: 8px; }
        .meta { display: block; color: var(--muted); font-size: 11px; margin-top: 5px; text-align: right; }
        .composer { background: var(--panel); border-top: 1px solid var(--line); padding: 12px; display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: end; }
        .composer textarea { min-height: 44px; max-height: 120px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
        .file-button { border: 1px solid var(--line); border-radius: 8px; min-width: 44px; min-height: 44px; display: grid; place-items: center; font-weight: 800; color: var(--accent); background: #fff; }
        .file-button input { display: none; }
        .empty { height: 100%; display: grid; place-items: center; text-align: center; color: var(--muted); padding: 24px; }
        .hidden { display: none !important; }
        @media (max-width: 780px) {
            .app { grid-template-columns: 1fr; }
            .sidebar.chat-open { display: none; }
            .chat:not(.chat-open) { display: none; }
            .chat-head { padding: 12px; }
            .messages { padding: 12px; }
        }
    </style>
</head>
<body>
    <div id="auth" class="auth-shell">
        <form id="authForm" class="auth-card stack">
            <div>
                <h1>JustChat</h1>
                <p id="authHint" class="muted">Melde dich an, um deine Chats zu sehen.</p>
            </div>
            <div class="field register-only hidden">
                <label for="displayName">Anzeigename</label>
                <input id="displayName" autocomplete="name" maxlength="60">
            </div>
            <div class="field register-only hidden">
                <label for="email">E-Mail</label>
                <input id="email" type="email" autocomplete="email" maxlength="160">
            </div>
            <div class="field">
                <label for="username">Benutzername</label>
                <input id="username" autocomplete="username" required maxlength="40">
            </div>
            <div class="field">
                <label for="password">Passwort</label>
                <input id="password" type="password" autocomplete="current-password" required minlength="6">
            </div>
            <div id="authError" class="error"></div>
            <button id="authSubmit" class="primary" type="submit">Anmelden</button>
            <button id="toggleAuth" class="ghost" type="button">Neues Konto erstellen</button>
        </form>
    </div>

    <div id="messenger" class="app hidden">
        <aside id="sidebar" class="sidebar">
            <div class="topbar">
                <div class="brand">
                    <strong id="meName">JustChat</strong>
                    <span id="meUsername"></span>
                </div>
                <button id="logout" class="ghost" type="button">Logout</button>
            </div>
            <div class="search">
                <input id="search" placeholder="Nutzer suchen">
                <div id="searchResults"></div>
            </div>
            <div id="conversationList" class="list"></div>
        </aside>
        <section id="chat" class="chat">
            <div id="chatEmpty" class="empty">Waehle einen Chat aus oder suche einen Nutzer.</div>
            <div id="chatPane" class="hidden" style="display: contents;">
                <div class="chat-head">
                    <button id="back" class="ghost" type="button">Zurueck</button>
                    <div id="chatAvatar" class="avatar">?</div>
                    <div class="brand">
                        <strong id="chatName"></strong>
                        <span id="chatUser"></span>
                    </div>
                </div>
                <div id="messages" class="messages"></div>
                <form id="composer" class="composer">
                    <label class="file-button" title="Bild anhaengen">
                        +
                        <input id="imageInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
                    </label>
                    <textarea id="messageInput" placeholder="Nachricht schreiben" maxlength="4000"></textarea>
                    <button class="primary" type="submit">Senden</button>
                </form>
            </div>
        </section>
    </div>

    <script>
        const state = {
            token: localStorage.getItem('justchat_token'),
            me: null,
            conversations: [],
            activeConversation: null,
            eventSource: null,
            registerMode: false,
        };

        const $ = (id) => document.getElementById(id);

        function api(path, options = {}) {
            const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
            if (state.token) headers.Authorization = 'Bearer ' + state.token;
            return fetch(path, { ...options, headers }).then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || 'Anfrage fehlgeschlagen');
                return data;
            });
        }

        function initials(name) {
            return String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
        }

        function showAuth() {
            $('auth').classList.remove('hidden');
            $('messenger').classList.add('hidden');
        }

        function showApp() {
            $('auth').classList.add('hidden');
            $('messenger').classList.remove('hidden');
        }

        function setAuthMode(registerMode) {
            state.registerMode = registerMode;
            document.querySelectorAll('.register-only').forEach((el) => el.classList.toggle('hidden', !registerMode));
            $('authSubmit').textContent = registerMode ? 'Konto erstellen' : 'Anmelden';
            $('toggleAuth').textContent = registerMode ? 'Schon ein Konto? Anmelden' : 'Neues Konto erstellen';
            $('authHint').textContent = registerMode ? 'Erstelle dein JustChat-Konto.' : 'Melde dich an, um deine Chats zu sehen.';
            $('authError').textContent = '';
        }

        function renderConversationList() {
            $('conversationList').innerHTML = state.conversations.map((chat) => {
                const active = state.activeConversation && state.activeConversation.id === chat.id ? ' active' : '';
                const preview = chat.last_message || (chat.has_attachment ? 'Bild' : 'Noch keine Nachrichten');
                const time = chat.last_message_at ? new Date(chat.last_message_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                return '<button class="row' + active + '" data-chat="' + chat.id + '">' +
                    '<div class="avatar" style="background:' + chat.avatar_color + '">' + initials(chat.display_name) + '</div>' +
                    '<div class="row-main"><div class="row-title"><strong>' + escapeText(chat.display_name) + '</strong><span class="muted">' + time + '</span></div>' +
                    '<div class="preview">' + escapeText(preview) + '</div></div></button>';
            }).join('');
        }

        function escapeText(value) {
            return String(value ?? '').replace(/[&<>"']/g, (char) => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            }[char]));
        }

        function renderMessages(messages) {
            $('messages').innerHTML = messages.map((message) => {
                const mine = Number(message.sender_id) === Number(state.me.id);
                const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const read = mine && message.read_at ? ' - gelesen' : '';
                const attachment = message.attachment
                    ? '<img src="' + message.attachment.data_url + '" alt="' + escapeText(message.attachment.file_name) + '">'
                    : '';
                const text = message.body ? escapeText(message.body) : '';
                return '<div class="bubble ' + (mine ? 'me' : '') + '">' +
                    attachment + text + '<span class="meta">' + time + read + '</span></div>';
            }).join('');
            $('messages').scrollTop = $('messages').scrollHeight;
        }

        function readSelectedImage() {
            const file = $('imageInput').files[0];
            if (!file) return Promise.resolve(null);
            if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
                return Promise.reject(new Error('Nur Bilder sind erlaubt'));
            }
            if (file.size > 5 * 1024 * 1024) {
                return Promise.reject(new Error('Bild muss kleiner als 5 MB sein'));
            }

            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const dataUrl = String(reader.result);
                    resolve({
                        fileName: file.name,
                        mimeType: file.type,
                        dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
                    });
                };
                reader.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
                reader.readAsDataURL(file);
            });
        }

        async function loadMe() {
            const data = await api('/api/me');
            state.me = data.user;
            $('meName').textContent = state.me.display_name;
            $('meUsername').textContent = '@' + state.me.username;
        }

        async function loadConversations() {
            const data = await api('/api/conversations');
            state.conversations = data.conversations;
            renderConversationList();
        }

        async function openConversation(id) {
            const data = await api('/api/conversations/' + id + '/messages');
            state.activeConversation = data.conversation;
            $('chatEmpty').classList.add('hidden');
            $('chatPane').classList.remove('hidden');
            $('sidebar').classList.add('chat-open');
            $('chat').classList.add('chat-open');
            $('chatName').textContent = data.conversation.display_name;
            $('chatUser').textContent = '@' + data.conversation.username;
            $('chatAvatar').textContent = initials(data.conversation.display_name);
            $('chatAvatar').style.background = data.conversation.avatar_color;
            renderMessages(data.messages);
            renderConversationList();
            await api('/api/conversations/' + id + '/read', { method: 'POST', body: '{}' });
        }

        function connectEvents() {
            if (state.eventSource) state.eventSource.close();
            state.eventSource = new EventSource('/api/events?token=' + encodeURIComponent(state.token));
            state.eventSource.addEventListener('message:new', async (event) => {
                const payload = JSON.parse(event.data);
                await loadConversations();
                if (state.activeConversation && Number(state.activeConversation.id) === Number(payload.conversationId)) {
                    await openConversation(payload.conversationId);
                }
            });
        }

        async function boot() {
            if (!state.token) return showAuth();
            try {
                await loadMe();
                await loadConversations();
                showApp();
                connectEvents();
            } catch {
                localStorage.removeItem('justchat_token');
                state.token = null;
                showAuth();
            }
        }

        $('authForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            $('authError').textContent = '';
            const body = {
                username: $('username').value,
                password: $('password').value,
                displayName: $('displayName').value,
                email: $('email').value,
            };
            try {
                const endpoint = state.registerMode ? '/api/auth/register' : '/api/auth/login';
                const data = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
                state.token = data.token;
                localStorage.setItem('justchat_token', state.token);
                await boot();
            } catch (error) {
                $('authError').textContent = error.message;
            }
        });

        $('toggleAuth').addEventListener('click', () => setAuthMode(!state.registerMode));
        $('logout').addEventListener('click', () => {
            localStorage.removeItem('justchat_token');
            if (state.eventSource) state.eventSource.close();
            location.reload();
        });
        $('back').addEventListener('click', () => {
            $('sidebar').classList.remove('chat-open');
            $('chat').classList.remove('chat-open');
        });
        $('conversationList').addEventListener('click', (event) => {
            const row = event.target.closest('[data-chat]');
            if (row) openConversation(row.dataset.chat);
        });
        $('search').addEventListener('input', async (event) => {
            const q = event.target.value.trim();
            if (q.length < 2) {
                $('searchResults').innerHTML = '';
                return;
            }
            const data = await api('/api/users?search=' + encodeURIComponent(q));
            $('searchResults').innerHTML = data.users.map((user) =>
                '<button class="row" data-user="' + user.id + '">' +
                '<div class="avatar" style="background:' + user.avatar_color + '">' + initials(user.display_name) + '</div>' +
                '<div class="row-main"><div class="row-title"><strong>' + escapeText(user.display_name) + '</strong></div>' +
                '<div class="preview">@' + escapeText(user.username) + '</div></div></button>'
            ).join('');
        });
        $('searchResults').addEventListener('click', async (event) => {
            const row = event.target.closest('[data-user]');
            if (!row) return;
            const data = await api('/api/conversations', {
                method: 'POST',
                body: JSON.stringify({ userId: row.dataset.user }),
            });
            $('search').value = '';
            $('searchResults').innerHTML = '';
            await loadConversations();
            await openConversation(data.conversation.id);
        });
        $('composer').addEventListener('submit', async (event) => {
            event.preventDefault();
            const body = $('messageInput').value.trim();
            const attachment = await readSelectedImage();
            if ((!body && !attachment) || !state.activeConversation) return;
            $('messageInput').value = '';
            $('imageInput').value = '';
            await api('/api/conversations/' + state.activeConversation.id + '/messages', {
                method: 'POST',
                body: JSON.stringify({ body, attachment }),
            });
            await openConversation(state.activeConversation.id);
            await loadConversations();
        });

        boot();
    </script>
</body>
</html>`;
}

app.get('/', (req, res) => {
    if (!DATABASE_URL) {
        return res.status(503).send(renderAdminLayout(`
            <header>
                <div>
                    <h1>JustChat</h1>
                    <p class="muted">Messenger ist noch nicht konfiguriert.</p>
                </div>
                <span class="status warn">Datenbank fehlt</span>
            </header>
            <section class="panel">
                <h2>Setup</h2>
                <p>Setze <code>DATABASE_URL</code>, damit Benutzer, Chats und Nachrichten gespeichert werden koennen.</p>
            </section>
        `));
    }

    return res.send(renderMessengerApp());
});

app.get('/health', async (req, res) => {
    const data = await getDashboardData();
    res.status(data.database.configured && data.database.online === false ? 503 : 200).json({
        ok: data.database.online !== false,
        uptime: data.uptime,
        database: data.database,
    });
});

app.get('/admin', requireAdminAuth, async (req, res) => {
    const data = await getDashboardData();
    res.send(renderDashboard(data));
});

app.get('/admin/export', requireAdminAuth, async (req, res, next) => {
    try {
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, 'chat_export', req.ip],
        );

        const users = await query(
            `select id, username, display_name, email, about, avatar_color, created_at, last_seen_at
             from users
             order by id`,
        );
        const conversations = await query(
            `select id, user_one_id, user_two_id, created_at
             from conversations
             order by id`,
        );
        const messages = await query(
            `select m.id, m.conversation_id, m.sender_id, m.body, m.created_at, m.read_at,
                json_agg(
                    json_build_object(
                        'id', a.id,
                        'file_name', a.file_name,
                        'mime_type', a.mime_type,
                        'size_bytes', a.size_bytes,
                        'data_base64', encode(a.data, 'base64'),
                        'created_at', a.created_at
                    )
                ) filter (where a.id is not null) as attachments
             from messages m
             left join message_attachments a on a.message_id = m.id
             group by m.id
             order by m.conversation_id, m.created_at`,
        );
        const exportedAt = new Date().toISOString();

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="justchat-export-${exportedAt.slice(0, 10)}.json"`);
        return res.json({
            exported_at: exportedAt,
            purpose: 'Sicherheits- und Moderationspruefung durch berechtigte Administratoren',
            users: users.rows,
            conversations: conversations.rows,
            messages: messages.rows,
        });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/auth/register', async (req, res, next) => {
    try {
        const username = normalizeUsername(req.body.username);
        const email = cleanEmail(req.body.email);
        const password = String(req.body.password || '');
        const displayName = cleanDisplayName(req.body.displayName, username);
        const colors = ['#0f766e', '#2563eb', '#7c3aed', '#c2410c', '#be123c', '#047857'];
        const avatarColor = colors[Math.floor(Math.random() * colors.length)];

        if (!/^[a-z0-9_]{3,40}$/.test(username)) {
            return res.status(400).json({ error: 'Benutzername: 3-40 Zeichen, nur a-z, 0-9 und _' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Bitte gib eine gueltige E-Mail-Adresse ein' });
        }

        const result = await query(
            `insert into users (username, display_name, email, password_hash, avatar_color)
             values ($1, $2, $3, $4, $5)
             returning id, username, display_name, email, about, avatar_color, created_at, last_seen_at`,
            [username, displayName, email, hashPassword(password), avatarColor],
        );
        const user = result.rows[0];

        sendMail({
            to: email,
            subject: 'Willkommen bei JustChat',
            text: `Hallo ${displayName},\n\n dein JustChat-Konto wurde erstellt.\n\nBenutzername: ${username}\n\nViele Gruesse\nJustChat`,
        }).catch((error) => console.error('E-Mail konnte nicht gesendet werden:', error.message));

        return res.status(201).json({ token: createToken(user), user });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Benutzername oder E-Mail ist bereits vergeben' });
        return next(error);
    }
});

app.post('/api/auth/login', async (req, res, next) => {
    try {
        const username = normalizeUsername(req.body.username);
        const password = String(req.body.password || '');
        const result = await query('select * from users where username = $1', [username]);
        const user = result.rows[0];

        if (!user || !verifyPassword(password, user.password_hash)) {
            return res.status(401).json({ error: 'Login fehlgeschlagen' });
        }

        await query('update users set last_seen_at = now() where id = $1', [user.id]);
        return res.json({
            token: createToken(user),
            user: {
                id: user.id,
                username: user.username,
                display_name: user.display_name,
                email: user.email,
                about: user.about,
                avatar_color: user.avatar_color,
                created_at: user.created_at,
                last_seen_at: user.last_seen_at,
            },
        });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

app.get('/api/users', requireAuth, async (req, res, next) => {
    try {
        const search = String(req.query.search || '').trim().toLowerCase();
        if (search.length < 2) return res.json({ users: [] });

        const result = await query(
            `select id, username, display_name, about, avatar_color, last_seen_at
             from users
             where id <> $1 and (username like $2 or lower(display_name) like $2)
             order by username
             limit 20`,
            [req.user.id, `%${search}%`],
        );
        return res.json({ users: result.rows });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/conversations', requireAuth, async (req, res, next) => {
    try {
        const result = await query(
            `select c.id,
                other_user.id as user_id,
                other_user.username,
                other_user.display_name,
                other_user.avatar_color,
                other_user.last_seen_at,
                latest.body as last_message,
                latest.has_attachment as has_attachment,
                latest.created_at as last_message_at,
                latest.sender_id as last_sender_id,
                unread.count as unread_count
             from conversations c
             join users other_user
                on other_user.id = case when c.user_one_id = $1 then c.user_two_id else c.user_one_id end
             left join lateral (
                select m.body, m.created_at, m.sender_id, exists(
                    select 1 from message_attachments a where a.message_id = m.id
                ) as has_attachment
                from messages m
                where m.conversation_id = c.id
                order by m.created_at desc
                limit 1
             ) latest on true
             left join lateral (
                select count(*)::int
                from messages
                where conversation_id = c.id and sender_id <> $1 and read_at is null
             ) unread on true
             where $1 in (c.user_one_id, c.user_two_id)
             order by latest.created_at desc nulls last, c.created_at desc`,
            [req.user.id],
        );
        return res.json({ conversations: result.rows });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/conversations', requireAuth, async (req, res, next) => {
    try {
        const otherUserId = Number(req.body.userId);
        if (!otherUserId || otherUserId === Number(req.user.id)) {
            return res.status(400).json({ error: 'Ungueltiger Benutzer' });
        }

        const otherUser = await getUserById(otherUserId);
        if (!otherUser) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

        const [userOneId, userTwoId] = conversationPair(req.user.id, otherUserId);
        const result = await query(
            `insert into conversations (user_one_id, user_two_id)
             values ($1, $2)
             on conflict (user_one_id, user_two_id) do update set user_one_id = excluded.user_one_id
             returning id`,
            [userOneId, userTwoId],
        );

        return res.status(201).json({ conversation: { id: result.rows[0].id } });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Chat nicht gefunden' });

        const otherUser = await getUserById(conversation.other_user_id);
        const messages = await query(
            `select id, conversation_id, sender_id, body, created_at, read_at
             from messages
             where conversation_id = $1
             order by created_at asc
             limit 200`,
            [conversation.id],
        );
        const messageRows = messages.rows;
        const messageIds = messageRows.map((message) => message.id);

        if (messageIds.length > 0) {
            const attachments = await query(
                `select id, message_id, file_name, mime_type, size_bytes, encode(data, 'base64') as data_base64
                 from message_attachments
                 where message_id = any($1::bigint[])`,
                [messageIds],
            );
            const attachmentsByMessage = new Map(attachments.rows.map((attachment) => [
                String(attachment.message_id),
                {
                    id: attachment.id,
                    file_name: attachment.file_name,
                    mime_type: attachment.mime_type,
                    size_bytes: attachment.size_bytes,
                    data_url: `data:${attachment.mime_type};base64,${attachment.data_base64}`,
                },
            ]));

            for (const message of messageRows) {
                message.attachment = attachmentsByMessage.get(String(message.id)) || null;
            }
        }

        return res.json({
            conversation: {
                id: conversation.id,
                user_id: otherUser.id,
                username: otherUser.username,
                display_name: otherUser.display_name,
                avatar_color: otherUser.avatar_color,
                last_seen_at: otherUser.last_seen_at,
            },
            messages: messageRows,
        });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res, next) => {
    try {
        const body = cleanMessage(req.body.body);
        const attachment = parseImageAttachment(req.body.attachment);
        if (!body && !attachment) return res.status(400).json({ error: 'Nachricht ist leer' });

        const conversation = await getConversationForUser(req.params.id, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Chat nicht gefunden' });

        const result = await query(
            `insert into messages (conversation_id, sender_id, body)
             values ($1, $2, $3)
             returning id, conversation_id, sender_id, body, created_at, read_at`,
            [conversation.id, req.user.id, body],
        );
        const message = result.rows[0];

        if (attachment) {
            const attachmentResult = await query(
                `insert into message_attachments (message_id, file_name, mime_type, size_bytes, data)
                 values ($1, $2, $3, $4, $5)
                 returning id, file_name, mime_type, size_bytes, encode(data, 'base64') as data_base64`,
                [message.id, attachment.fileName, attachment.mimeType, attachment.sizeBytes, attachment.data],
            );
            const storedAttachment = attachmentResult.rows[0];
            message.attachment = {
                id: storedAttachment.id,
                file_name: storedAttachment.file_name,
                mime_type: storedAttachment.mime_type,
                size_bytes: storedAttachment.size_bytes,
                data_url: `data:${storedAttachment.mime_type};base64,${storedAttachment.data_base64}`,
            };
        } else {
            message.attachment = null;
        }

        sendEvent(conversation.other_user_id, 'message:new', {
            conversationId: conversation.id,
            message,
        });
        sendEvent(req.user.id, 'message:new', {
            conversationId: conversation.id,
            message,
        });

        return res.status(201).json({ message });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/conversations/:id/read', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Chat nicht gefunden' });

        await query(
            `update messages
             set read_at = coalesce(read_at, now())
             where conversation_id = $1 and sender_id <> $2 and read_at is null`,
            [conversation.id, req.user.id],
        );
        sendEvent(conversation.other_user_id, 'message:read', { conversationId: conversation.id });
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/events', requireAuth, (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.write('event: ready\ndata: {"ok":true}\n\n');
    addEventClient(req.user.id, res);
});

app.use((error, req, res, next) => {
    console.error(error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ error: statusCode === 500 ? 'Serverfehler' : error.message });
});

waitForDatabase()
    .then(() => {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`JustChat laeuft auf Port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error('Datenbank konnte nicht initialisiert werden:', error);
        process.exit(1);
    });
