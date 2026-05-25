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
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
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

function parseId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function createLoginCode() {
    return String(crypto.randomInt(100000, 1000000));
}

async function sendTwoFactorCode(user) {
    if (!user.email) {
        const error = new Error('Fuer 2FA ist eine E-Mail-Adresse erforderlich');
        error.statusCode = 400;
        throw error;
    }
    if (!getMailer()) {
        const error = new Error('2FA braucht vollstaendige SMTP-Konfiguration');
        error.statusCode = 503;
        throw error;
    }

    const code = createLoginCode();
    await query(
        `insert into login_codes (user_id, code_hash, expires_at)
         values ($1, $2, now() + interval '10 minutes')`,
        [user.id, hashPassword(code)],
    );
    await sendMail({
        to: user.email,
        subject: 'Dein JustChat Login-Code',
        text: `Dein JustChat Login-Code lautet: ${code}\n\nDer Code ist 10 Minuten gueltig.`,
    });
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
            google_id text,
            avatar_asset_id bigint,
            password_hash text not null,
            two_factor_enabled boolean not null default false,
            about text not null default '',
            avatar_color text not null default '#2563eb',
            created_at timestamptz not null default now(),
            last_seen_at timestamptz
        );

        create table if not exists avatar_assets (
            id bigserial primary key,
            name text not null,
            mime_type text not null,
            size_bytes integer not null,
            data bytea not null,
            is_active boolean not null default true,
            created_at timestamptz not null default now()
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

        create table if not exists login_codes (
            id bigserial primary key,
            user_id bigint not null references users(id) on delete cascade,
            code_hash text not null,
            expires_at timestamptz not null,
            used_at timestamptz,
            created_at timestamptz not null default now()
        );

        alter table users add column if not exists email text;
        alter table users add column if not exists google_id text;
        alter table users add column if not exists email_verified_at timestamptz;
        alter table users add column if not exists avatar_asset_id bigint references avatar_assets(id);
        alter table users add column if not exists two_factor_enabled boolean not null default false;

        create unique index if not exists idx_users_email_unique
            on users(email)
            where email is not null and email <> '';
        create unique index if not exists idx_users_google_unique
            on users(google_id)
            where google_id is not null and google_id <> '';
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
        `select u.id, u.username, u.display_name, u.email, u.about, u.avatar_color, u.avatar_asset_id,
            u.two_factor_enabled,
            u.created_at, u.last_seen_at,
            case when aa.id is null then null else 'data:' || aa.mime_type || ';base64,' || encode(aa.data, 'base64') end as avatar_url
         from users u
         left join avatar_assets aa on aa.id = u.avatar_asset_id and aa.is_active = true
         where u.id = $1`,
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
            --bg: #f4f7fb;
            --panel: #ffffff;
            --text: #172033;
            --muted: #667085;
            --line: #d9e1ec;
            --accent: #2563eb;
            --accent-dark: #1d4ed8;
            --ok: #138a45;
            --warn: #9a6700;
            --error: #c62828;
        }
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; font-family: Arial, sans-serif; background: var(--bg); color: var(--text); }
        main { width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0; }
        header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
        h1, h2, p { margin: 0; }
        h1 { font-size: clamp(28px, 4vw, 44px); letter-spacing: 0; }
        h2 { font-size: 18px; margin-bottom: 16px; }
        .muted { color: var(--muted); margin-top: 8px; }
        .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
        .two { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr); gap: 16px; align-items: start; }
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
        button, input, select { font: inherit; }
        button, .button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 12px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
        button:hover, .button:hover { background: var(--accent-dark); }
        .secondary { background: #eef2ff; color: var(--accent); }
        .secondary:hover { background: #dfe7ff; }
        .danger { background: #fee4e2; color: var(--error); }
        .danger:hover { background: #fecdca; }
        .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
        .field { display: grid; gap: 6px; margin-bottom: 12px; }
        .field label { font-size: 13px; color: var(--muted); font-weight: 700; }
        input, select { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: #fff; color: var(--text); }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px 8px; border-bottom: 1px solid #edf1f6; text-align: left; vertical-align: middle; }
        th { color: var(--muted); font-size: 12px; text-transform: uppercase; }
        .avatar-preview { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: #eef2f7; border: 1px solid var(--line); }
        .avatar-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 12px; }
        .avatar-card { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fff; display: grid; gap: 8px; justify-items: center; text-align: center; }
        .avatar-card img { width: 58px; height: 58px; border-radius: 50%; object-fit: cover; }
        .notice { border: 1px solid #fedf89; background: #fffaeb; color: #7a4f01; border-radius: 8px; padding: 12px; margin-top: 16px; }
        @media (max-width: 820px) {
            header { align-items: flex-start; flex-direction: column; }
            .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .two { grid-template-columns: 1fr; }
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
                <p class="muted">Betrieb, Nutzerverwaltung, Avatar-Bibliothek und Sicherheits-Export.</p>
            </div>
            <div class="toolbar">
                <button id="refreshButton" type="button">Aktualisieren</button>
                <a class="button secondary" href="/">Web-App</a>
                <span class="status ${dbStatus}">Datenbank: ${statusText(data.database.online)}</span>
            </div>
        </header>
        <section class="grid" aria-label="Server Kennzahlen">
            <div class="metric"><span>Nutzer</span><strong id="statUsers">-</strong></div>
            <div class="metric"><span>Chats</span><strong id="statConversations">-</strong></div>
            <div class="metric"><span>Nachrichten</span><strong id="statMessages">-</strong></div>
            <div class="metric"><span>Live-Verbindungen</span><strong>${escapeHtml(data.onlineEventClients)}</strong></div>
        </section>
        <div class="two">
            <section class="panel">
                <h2>Nutzer</h2>
                <div class="field">
                    <label for="userFilter">Nutzer fuer Export auswaehlen</label>
                    <select id="userFilter">
                        <option value="">Alle Nutzer</option>
                    </select>
                </div>
                <div class="toolbar">
                    <a id="downloadExport" class="button" href="/admin/export">Export herunterladen</a>
                    <button id="downloadSelected" class="secondary" type="button">Auswahl exportieren</button>
                </div>
                <div style="overflow:auto; margin-top: 16px;">
                    <table>
                        <thead><tr><th>Avatar</th><th>Nutzer</th><th>E-Mail</th><th>Chats</th><th>Nachrichten</th></tr></thead>
                        <tbody id="userRows"></tbody>
                    </table>
                </div>
            </section>

            <aside>
                <section class="panel">
                    <h2>System</h2>
                    <dl>
                        <dt>Umgebung</dt><dd>${escapeHtml(data.environment)}</dd>
                        <dt>Uptime</dt><dd>${escapeHtml(data.uptime)}</dd>
                        <dt>Speicher</dt><dd>${escapeHtml(data.memoryMb)} MB</dd>
                        <dt>Node.js</dt><dd>${escapeHtml(data.nodeVersion)}</dd>
                        <dt>Port</dt><dd>${escapeHtml(data.port)}</dd>
                        <dt>Datenbank</dt><dd>${escapeHtml(data.database.message)}</dd>
                    </dl>
                </section>

                <section class="panel">
                    <h2>Update</h2>
                    <p class="muted">Der Button aktualisiert diese Ansicht. Container-Updates laufen sauber ueber GitHub Actions und TrueNAS App-Update/Neustart.</p>
                    <div class="toolbar" style="margin-top: 12px;">
                        <button id="updateButton" type="button">Status neu laden</button>
                    </div>
                </section>
            </aside>
        </div>

        <section class="panel">
            <h2>Profilbilder</h2>
            <p class="muted">Hier laedst du erlaubte Profilbilder hoch. Nutzer koennen nur diese Bilder auswaehlen, keine eigenen Uploads.</p>
            <div class="toolbar" style="margin-top: 12px;">
                <input id="avatarName" placeholder="Name des Profilbilds">
                <input id="avatarFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
                <button id="uploadAvatar" type="button">Profilbild hochladen</button>
            </div>
            <div id="avatarGrid" class="avatar-grid" style="margin-top: 16px;"></div>
        </section>

        <section class="panel">
            <h2>Audit</h2>
            <div style="overflow:auto;">
                <table>
                    <thead><tr><th>Zeit</th><th>Admin</th><th>Aktion</th><th>IP</th></tr></thead>
                    <tbody id="auditRows"></tbody>
                </table>
            </div>
        </section>

        <div class="notice">Hinweis: Exporte enthalten private Chatdaten und Bildanhaenge. Verwende sie nur mit berechtigtem Zweck und bewahre Downloads geschuetzt auf.</div>

        <script>
            const state = { users: [], avatars: [], audit: [] };
            const el = (id) => document.getElementById(id);
            const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[char]));

            function initials(name) {
                return String(name || '?').slice(0, 1).toUpperCase() || '?';
            }

            async function readFileBase64(file) {
                if (!file) throw new Error('Bitte ein Bild auswaehlen');
                if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
                    throw new Error('Nur JPEG, PNG, WebP und GIF sind erlaubt');
                }
                if (file.size > 5 * 1024 * 1024) throw new Error('Bild muss kleiner als 5 MB sein');

                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const dataUrl = String(reader.result);
                        resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
                    };
                    reader.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
                    reader.readAsDataURL(file);
                });
            }

            async function adminApi(path, options = {}) {
                const response = await fetch(path, {
                    ...options,
                    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || 'Admin-Anfrage fehlgeschlagen');
                return data;
            }

            function render() {
                el('statUsers').textContent = state.summary.users;
                el('statConversations').textContent = state.summary.conversations;
                el('statMessages').textContent = state.summary.messages;
                el('userFilter').innerHTML = '<option value="">Alle Nutzer</option>' + state.users.map((user) =>
                    '<option value="' + user.id + '">' + escapeText(user.display_name) + ' (@' + escapeText(user.username) + ')</option>'
                ).join('');
                el('userRows').innerHTML = state.users.map((user) => {
                    const avatar = user.avatar_url
                        ? '<img class="avatar-preview" src="' + user.avatar_url + '" alt="">'
                        : '<div class="avatar-preview" style="display:grid;place-items:center;background:' + user.avatar_color + ';color:#fff;font-weight:800;">' + initials(user.display_name) + '</div>';
                    return '<tr><td>' + avatar + '</td><td><strong>' + escapeText(user.display_name) + '</strong><br><span class="muted">@' + escapeText(user.username) + '</span></td><td>' + escapeText(user.email || '-') + '</td><td>' + user.conversation_count + '</td><td>' + user.message_count + '</td></tr>';
                }).join('');
                el('avatarGrid').innerHTML = state.avatars.length ? state.avatars.map((avatar) =>
                    '<div class="avatar-card"><img src="' + avatar.data_url + '" alt=""><strong>' + escapeText(avatar.name) + '</strong><span class="muted">' + Math.round(avatar.size_bytes / 1024) + ' KB</span></div>'
                ).join('') : '<p class="muted">Noch keine Profilbilder hochgeladen.</p>';
                el('auditRows').innerHTML = state.audit.map((row) =>
                    '<tr><td>' + new Date(row.created_at).toLocaleString() + '</td><td>' + escapeText(row.admin_user) + '</td><td>' + escapeText(row.action) + '</td><td>' + escapeText(row.ip_address || '-') + '</td></tr>'
                ).join('');
            }

            async function loadAdmin() {
                const data = await adminApi('/admin/api/overview');
                state.summary = data.summary;
                state.users = data.users;
                state.avatars = data.avatars;
                state.audit = data.audit;
                render();
            }

            el('refreshButton').addEventListener('click', loadAdmin);
            el('updateButton').addEventListener('click', loadAdmin);
            el('downloadSelected').addEventListener('click', () => {
                const userId = el('userFilter').value;
                window.location.href = userId ? '/admin/export?userId=' + encodeURIComponent(userId) : '/admin/export';
            });
            el('userFilter').addEventListener('change', () => {
                const userId = el('userFilter').value;
                el('downloadExport').href = userId ? '/admin/export?userId=' + encodeURIComponent(userId) : '/admin/export';
            });
            el('uploadAvatar').addEventListener('click', async () => {
                try {
                    const file = el('avatarFile').files[0];
                    const dataBase64 = await readFileBase64(file);
                    await adminApi('/admin/api/avatar-assets', {
                        method: 'POST',
                        body: JSON.stringify({
                            name: el('avatarName').value || file.name,
                            attachment: { fileName: file.name, mimeType: file.type, dataBase64 },
                        }),
                    });
                    el('avatarName').value = '';
                    el('avatarFile').value = '';
                    await loadAdmin();
                } catch (error) {
                    alert(error.message);
                }
            });

            loadAdmin();
        </script>
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
        .auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: linear-gradient(135deg, #f7fbff 0%, #edf7f4 100%); }
        .auth-card { width: min(460px, 100%); background: rgba(255,255,255,.96); border: 1px solid var(--line); border-radius: 8px; padding: 26px; box-shadow: 0 18px 50px rgba(15, 23, 42, .12); }
        .auth-card h1 { margin: 0 0 6px; font-size: 36px; letter-spacing: 0; }
        .muted { color: var(--muted); }
        .stack { display: grid; gap: 12px; }
        .field { display: grid; gap: 6px; }
        .field label { color: var(--muted); font-size: 13px; font-weight: 700; }
        .field input, .field textarea {
            width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 11px 12px; outline: none; background: #fff;
        }
        .field input:focus, .field textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(15, 118, 110, .12); }
        .avatar-picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(66px, 1fr)); gap: 8px; }
        .avatar-option { border: 2px solid var(--line); background: #fff; border-radius: 8px; padding: 6px; min-height: 74px; display: grid; place-items: center; }
        .avatar-option.selected { border-color: var(--accent); background: #eef8f6; }
        .avatar-option img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; }
        .primary { background: var(--accent); color: #fff; border-radius: 8px; padding: 11px 14px; font-weight: 700; }
        .primary:hover { background: var(--accent-strong); }
        .ghost { background: transparent; color: var(--accent); font-weight: 700; padding: 8px; }
        .error { color: var(--danger); min-height: 20px; }
        .app { height: 100vh; display: grid; grid-template-columns: 360px 1fr; }
        .sidebar { background: var(--sidebar); border-right: 1px solid var(--line); display: grid; grid-template-rows: auto auto 1fr; min-width: 0; }
        .topbar { padding: 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .me-box { display: grid; grid-template-columns: 44px 1fr; gap: 10px; align-items: center; min-width: 0; }
        .brand { min-width: 0; }
        .brand strong { display: block; font-size: 20px; overflow-wrap: anywhere; }
        .brand span { display: block; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
        .search { padding: 12px 16px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
        .search input { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; width: 100%; }
        .list { overflow: auto; }
        .row { width: 100%; background: transparent; display: grid; grid-template-columns: 44px 1fr; gap: 12px; padding: 12px 16px; text-align: left; border-bottom: 1px solid #edf1f6; }
        .row:hover, .row.active { background: #eef8f6; }
        .avatar { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 800; object-fit: cover; }
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
        .modal { position: fixed; inset: 0; background: rgba(15, 23, 42, .42); display: grid; place-items: center; padding: 18px; z-index: 20; }
        .modal-card { width: min(560px, 100%); max-height: min(760px, 100%); overflow: auto; background: #fff; border-radius: 8px; border: 1px solid var(--line); padding: 20px; box-shadow: 0 24px 80px rgba(15, 23, 42, .22); }
        .modal-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
        .segmented { display: flex; gap: 8px; flex-wrap: wrap; }
        .small { font-size: 13px; }
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
            <div class="field register-only hidden">
                <label>Profilbild</label>
                <div id="avatarPicker" class="avatar-picker"></div>
                <p class="muted">Profilbilder werden vom Admin freigegeben.</p>
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
            <a id="googleLogin" class="primary hidden" style="text-align:center;text-decoration:none;" href="/auth/google">Mit Google fortfahren</a>
            <button id="toggleAuth" class="ghost" type="button">Neues Konto erstellen</button>
        </form>
    </div>

    <div id="messenger" class="app hidden">
        <aside id="sidebar" class="sidebar">
            <div class="topbar">
                <button id="accountButton" class="me-box ghost" type="button">
                    <div id="meAvatar" class="avatar">J</div>
                    <div class="brand">
                        <strong id="meName">JustChat</strong>
                        <span id="meUsername"></span>
                    </div>
                </button>
                <button id="addPerson" class="primary" type="button">+</button>
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

    <div id="accountModal" class="modal hidden">
        <form id="profileForm" class="modal-card stack">
            <div class="modal-head">
                <h2>Mein Account</h2>
                <button id="closeAccount" class="ghost" type="button">Schliessen</button>
            </div>
            <div class="field">
                <label for="profileDisplayName">Anzeigename</label>
                <input id="profileDisplayName" maxlength="60">
            </div>
            <div class="field">
                <label for="profileEmail">E-Mail</label>
                <input id="profileEmail" type="email" maxlength="160">
            </div>
            <div class="field">
                <label for="profileAbout">Info</label>
                <textarea id="profileAbout" maxlength="180"></textarea>
            </div>
            <div class="field">
                <label>Profilbild</label>
                <div id="profileAvatarPicker" class="avatar-picker"></div>
            </div>
            <label class="segmented">
                <input id="profile2fa" type="checkbox" style="width:auto;">
                <span>2FA per E-Mail-Code aktivieren</span>
            </label>
            <p class="muted small">Bei aktivierter 2FA wird beim Login ein Code an deine E-Mail gesendet.</p>
            <div id="profileError" class="error"></div>
            <button class="primary" type="submit">Profil speichern</button>
            <button id="logout" class="ghost" type="button">Logout</button>
        </form>
    </div>

    <div id="addModal" class="modal hidden">
        <form id="addForm" class="modal-card stack">
            <div class="modal-head">
                <h2>Person adden</h2>
                <button id="closeAdd" class="ghost" type="button">Schliessen</button>
            </div>
            <div class="field">
                <label for="addUsername">@name</label>
                <input id="addUsername" placeholder="@benutzername" maxlength="41">
            </div>
            <div id="addError" class="error"></div>
            <button class="primary" type="submit">Chat starten</button>
        </form>
    </div>

    <script>
        const state = {
            token: localStorage.getItem('justchat_token'),
            me: null,
            conversations: [],
            activeConversation: null,
            eventSource: null,
            registerMode: false,
            pendingTwoFactorUserId: null,
            avatars: [],
            selectedAvatarId: null,
            profileAvatarId: null,
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

        function avatarMarkup(entity) {
            if (entity.avatar_url) {
                return '<img class="avatar" src="' + entity.avatar_url + '" alt="">';
            }
            return '<div class="avatar" style="background:' + entity.avatar_color + '">' + initials(entity.display_name) + '</div>';
        }

        function showAuth() {
            $('auth').classList.remove('hidden');
            $('messenger').classList.add('hidden');
            fetch('/api/config').then((res) => res.json()).then((config) => {
                $('googleLogin').classList.toggle('hidden', !config.googleEnabled);
            }).catch(() => {});
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
            if (registerMode) loadAvatars();
        }

        async function loadAvatars() {
            try {
                const data = await api('/api/avatars');
                state.avatars = data.avatars || [];
                if (!state.selectedAvatarId && state.avatars.length) state.selectedAvatarId = state.avatars[0].id;
                renderAvatarPicker();
            } catch {
                $('avatarPicker').innerHTML = '<span class="muted">Keine Profilbilder verfuegbar.</span>';
            }
        }

        function renderAvatarPicker() {
            if (!state.avatars.length) {
                $('avatarPicker').innerHTML = '<span class="muted">Noch keine Profilbilder verfuegbar.</span>';
                return;
            }
            $('avatarPicker').innerHTML = state.avatars.map((avatar) =>
                '<button type="button" class="avatar-option ' + (Number(state.selectedAvatarId) === Number(avatar.id) ? 'selected' : '') + '" data-avatar="' + avatar.id + '">' +
                '<img src="' + avatar.data_url + '" alt="' + escapeText(avatar.name) + '"></button>'
            ).join('');
        }

        function renderProfileAvatarPicker() {
            if (!state.avatars.length) {
                $('profileAvatarPicker').innerHTML = '<span class="muted">Noch keine Profilbilder verfuegbar.</span>';
                return;
            }
            $('profileAvatarPicker').innerHTML = state.avatars.map((avatar) =>
                '<button type="button" class="avatar-option ' + (Number(state.profileAvatarId) === Number(avatar.id) ? 'selected' : '') + '" data-profile-avatar="' + avatar.id + '">' +
                '<img src="' + avatar.data_url + '" alt="' + escapeText(avatar.name) + '"></button>'
            ).join('');
        }

        function renderConversationList() {
            $('conversationList').innerHTML = state.conversations.map((chat) => {
                const active = state.activeConversation && state.activeConversation.id === chat.id ? ' active' : '';
                const preview = chat.last_message || (chat.has_attachment ? 'Bild' : 'Noch keine Nachrichten');
                const time = chat.last_message_at ? new Date(chat.last_message_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                return '<button class="row' + active + '" data-chat="' + chat.id + '">' +
                    avatarMarkup(chat) +
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
            state.profileAvatarId = state.me.avatar_asset_id;
            $('meName').textContent = state.me.display_name;
            $('meUsername').textContent = '@' + state.me.username;
            $('meAvatar').outerHTML = avatarMarkup(state.me).replace('class="avatar"', 'id="meAvatar" class="avatar"');
        }

        async function openAccount() {
            await loadAvatars();
            $('profileDisplayName').value = state.me.display_name || '';
            $('profileEmail').value = state.me.email || '';
            $('profileAbout').value = state.me.about || '';
            $('profile2fa').checked = Boolean(state.me.two_factor_enabled);
            state.profileAvatarId = state.me.avatar_asset_id;
            renderProfileAvatarPicker();
            $('accountModal').classList.remove('hidden');
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
            if (data.conversation.avatar_url) {
                $('chatAvatar').outerHTML = '<img id="chatAvatar" class="avatar" src="' + data.conversation.avatar_url + '" alt="">';
            } else {
                $('chatAvatar').outerHTML = '<div id="chatAvatar" class="avatar" style="background:' + data.conversation.avatar_color + '">' + initials(data.conversation.display_name) + '</div>';
            }
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
                avatarAssetId: state.selectedAvatarId,
            };
            try {
                const endpoint = state.registerMode ? '/api/auth/register' : '/api/auth/login';
                const data = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
                if (data.twoFactorRequired) {
                    const code = prompt('2FA-Code aus deiner E-Mail eingeben');
                    if (!code) return;
                    const verified = await api('/api/auth/verify-2fa', {
                        method: 'POST',
                        body: JSON.stringify({ userId: data.userId, code }),
                    });
                    state.token = verified.token;
                    localStorage.setItem('justchat_token', state.token);
                    await boot();
                    return;
                }
                state.token = data.token;
                localStorage.setItem('justchat_token', state.token);
                await boot();
            } catch (error) {
                $('authError').textContent = error.message;
            }
        });

        $('toggleAuth').addEventListener('click', () => setAuthMode(!state.registerMode));
        $('accountButton').addEventListener('click', openAccount);
        $('closeAccount').addEventListener('click', () => $('accountModal').classList.add('hidden'));
        $('addPerson').addEventListener('click', () => $('addModal').classList.remove('hidden'));
        $('closeAdd').addEventListener('click', () => $('addModal').classList.add('hidden'));
        $('avatarPicker').addEventListener('click', (event) => {
            const button = event.target.closest('[data-avatar]');
            if (!button) return;
            state.selectedAvatarId = button.dataset.avatar;
            renderAvatarPicker();
        });
        $('profileAvatarPicker').addEventListener('click', (event) => {
            const button = event.target.closest('[data-profile-avatar]');
            if (!button) return;
            state.profileAvatarId = button.dataset.profileAvatar;
            renderProfileAvatarPicker();
        });
        $('profileForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            $('profileError').textContent = '';
            try {
                await api('/api/me', {
                    method: 'PATCH',
                    body: JSON.stringify({
                        displayName: $('profileDisplayName').value,
                        email: $('profileEmail').value,
                        about: $('profileAbout').value,
                        avatarAssetId: state.profileAvatarId,
                        twoFactorEnabled: $('profile2fa').checked,
                    }),
                });
                await loadMe();
                $('accountModal').classList.add('hidden');
            } catch (error) {
                $('profileError').textContent = error.message;
            }
        });
        $('addForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            $('addError').textContent = '';
            const username = $('addUsername').value.trim().replace(/^@/, '');
            try {
                const data = await api('/api/conversations/by-username', {
                    method: 'POST',
                    body: JSON.stringify({ username }),
                });
                $('addUsername').value = '';
                $('addModal').classList.add('hidden');
                await loadConversations();
                await openConversation(data.conversation.id);
            } catch (error) {
                $('addError').textContent = error.message;
            }
        });
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
                avatarMarkup(user) +
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

app.get('/api/config', (req, res) => {
    res.json({
        googleEnabled: Boolean(PUBLIC_BASE_URL && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    });
});

app.get('/admin', requireAdminAuth, async (req, res) => {
    const data = await getDashboardData();
    res.send(renderDashboard(data));
});

app.get('/admin/api/overview', requireAdminAuth, async (req, res, next) => {
    try {
        const summary = await query(`
            select
                (select count(*)::int from users) as users,
                (select count(*)::int from conversations) as conversations,
                (select count(*)::int from messages) as messages,
                (select count(*)::int from message_attachments) as attachments
        `);
        const users = await query(`
            select u.id, u.username, u.display_name, u.email, u.avatar_color, u.avatar_asset_id,
                case when aa.id is null then null else 'data:' || aa.mime_type || ';base64,' || encode(aa.data, 'base64') end as avatar_url,
                count(distinct c.id)::int as conversation_count,
                count(distinct m.id)::int as message_count
            from users u
            left join avatar_assets aa on aa.id = u.avatar_asset_id and aa.is_active = true
            left join conversations c on u.id in (c.user_one_id, c.user_two_id)
            left join messages m on m.sender_id = u.id
            group by u.id, aa.id
            order by u.created_at desc
            limit 200
        `);
        const avatars = await query(`
            select id, name, mime_type, size_bytes, is_active, created_at,
                'data:' || mime_type || ';base64,' || encode(data, 'base64') as data_url
            from avatar_assets
            order by created_at desc
        `);
        const audit = await query(`
            select admin_user, action, ip_address, created_at
            from admin_audit_logs
            order by created_at desc
            limit 50
        `);

        return res.json({
            summary: summary.rows[0],
            users: users.rows,
            avatars: avatars.rows,
            audit: audit.rows,
        });
    } catch (error) {
        return next(error);
    }
});

app.post('/admin/api/avatar-assets', requireAdminAuth, async (req, res, next) => {
    try {
        const attachment = parseImageAttachment(req.body.attachment);
        if (!attachment) return res.status(400).json({ error: 'Bitte ein Profilbild hochladen' });
        const name = String(req.body.name || attachment.fileName).trim().slice(0, 80) || attachment.fileName;

        const result = await query(
            `insert into avatar_assets (name, mime_type, size_bytes, data)
             values ($1, $2, $3, $4)
             returning id, name, mime_type, size_bytes, is_active, created_at`,
            [name, attachment.mimeType, attachment.sizeBytes, attachment.data],
        );
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, 'avatar_upload', req.ip],
        );

        return res.status(201).json({ avatar: result.rows[0] });
    } catch (error) {
        return next(error);
    }
});

app.get('/admin/export', requireAdminAuth, async (req, res, next) => {
    try {
        const userId = parseId(req.query.userId);
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, userId ? `chat_export_user_${userId}` : 'chat_export_all', req.ip],
        );

        const users = await query(
            `select id, username, display_name, email, about, avatar_color, created_at, last_seen_at
             from users
             where ($1::bigint is null or id = $1)
             order by id`,
            [userId],
        );
        const conversations = await query(
            `select id, user_one_id, user_two_id, created_at
             from conversations
             where ($1::bigint is null or $1 in (user_one_id, user_two_id))
             order by id`,
            [userId],
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
             join conversations c on c.id = m.conversation_id
             where ($1::bigint is null or $1 in (c.user_one_id, c.user_two_id))
             group by m.id
             order by m.conversation_id, m.created_at`,
            [userId],
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
        const avatarAssetId = parseId(req.body.avatarAssetId);
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
            `insert into users (username, display_name, email, avatar_asset_id, password_hash, avatar_color)
             values ($1, $2, $3, $4, $5, $6)
             returning id, username, display_name, email, avatar_asset_id, about, avatar_color, created_at, last_seen_at`,
            [username, displayName, email, avatarAssetId, hashPassword(password), avatarColor],
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
        if (user.two_factor_enabled) {
            await sendTwoFactorCode(user);
            return res.json({ twoFactorRequired: true, userId: user.id });
        }

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

app.post('/api/auth/verify-2fa', async (req, res, next) => {
    try {
        const userId = parseId(req.body.userId);
        const code = String(req.body.code || '').trim();
        if (!userId || !/^\d{6}$/.test(code)) {
            return res.status(400).json({ error: 'Ungueltiger 2FA-Code' });
        }

        const result = await query(
            `select lc.*, u.id as user_id, u.username, u.display_name, u.email, u.about, u.avatar_color,
                u.avatar_asset_id, u.two_factor_enabled, u.created_at, u.last_seen_at
             from login_codes lc
             join users u on u.id = lc.user_id
             where lc.user_id = $1 and lc.used_at is null and lc.expires_at > now()
             order by lc.created_at desc
             limit 1`,
            [userId],
        );
        const row = result.rows[0];
        if (!row || !verifyPassword(code, row.code_hash)) {
            return res.status(401).json({ error: '2FA-Code ist falsch oder abgelaufen' });
        }

        await query('update login_codes set used_at = now() where id = $1', [row.id]);
        const user = {
            id: row.user_id,
            username: row.username,
            display_name: row.display_name,
            email: row.email,
            about: row.about,
            avatar_color: row.avatar_color,
            avatar_asset_id: row.avatar_asset_id,
            two_factor_enabled: row.two_factor_enabled,
            created_at: row.created_at,
            last_seen_at: row.last_seen_at,
        };
        return res.json({ token: createToken(user), user });
    } catch (error) {
        return next(error);
    }
});

app.get('/auth/google', (req, res) => {
    if (!PUBLIC_BASE_URL || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return res.status(503).send('Google Login ist noch nicht konfiguriert');
    }

    const redirectUri = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/auth/google/callback`;
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        prompt: 'select_account',
    });
    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/auth/google/callback', async (req, res, next) => {
    try {
        if (!PUBLIC_BASE_URL || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
            return res.status(503).send('Google Login ist noch nicht konfiguriert');
        }

        const code = String(req.query.code || '');
        if (!code) return res.status(400).send('Google Code fehlt');

        const redirectUri = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/auth/google/callback`;
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }),
        });
        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok) throw new Error(tokenData.error_description || 'Google Token fehlgeschlagen');

        const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const profile = await profileResponse.json();
        if (!profileResponse.ok || !profile.sub || !profile.email) {
            throw new Error('Google Profil konnte nicht geladen werden');
        }

        const usernameBase = normalizeUsername(profile.email.split('@')[0]).replace(/[^a-z0-9_]/g, '_').slice(0, 30) || 'google';
        const existing = await query('select * from users where google_id = $1 or email = $2 limit 1', [profile.sub, cleanEmail(profile.email)]);
        let user = existing.rows[0];

        if (!user) {
            const passwordHash = hashPassword(crypto.randomBytes(24).toString('hex'));
            const username = `${usernameBase}_${crypto.randomInt(1000, 9999)}`;
            const inserted = await query(
                `insert into users (username, display_name, email, google_id, password_hash, avatar_color, email_verified_at)
                 values ($1, $2, $3, $4, $5, $6, now())
                 returning *`,
                [username, String(profile.name || username).slice(0, 60), cleanEmail(profile.email), profile.sub, passwordHash, '#0f766e'],
            );
            user = inserted.rows[0];
        } else if (!user.google_id) {
            const updated = await query('update users set google_id = $1, email_verified_at = now() where id = $2 returning *', [profile.sub, user.id]);
            user = updated.rows[0];
        }

        const token = createToken(user);
        return res.send(`<!doctype html><html><body><script>
            localStorage.setItem('justchat_token', ${JSON.stringify(token)});
            location.href = '/';
        </script></body></html>`);
    } catch (error) {
        return next(error);
    }
});

app.get('/api/avatars', async (req, res, next) => {
    try {
        const result = await query(
            `select id, name, mime_type, size_bytes,
                'data:' || mime_type || ';base64,' || encode(data, 'base64') as data_url
             from avatar_assets
             where is_active = true
             order by created_at desc
             limit 60`,
        );
        return res.json({ avatars: result.rows });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

app.patch('/api/me', requireAuth, async (req, res, next) => {
    try {
        const displayName = cleanDisplayName(req.body.displayName, req.user.username);
        const email = cleanEmail(req.body.email);
        const about = String(req.body.about || '').trim().slice(0, 180);
        const avatarAssetId = parseId(req.body.avatarAssetId);
        const twoFactorEnabled = Boolean(req.body.twoFactorEnabled);

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Bitte gib eine gueltige E-Mail-Adresse ein' });
        }
        if (twoFactorEnabled && !getMailer()) {
            return res.status(400).json({ error: '2FA braucht vollstaendige SMTP-Konfiguration' });
        }

        const result = await query(
            `update users
             set display_name = $1, email = $2, about = $3, avatar_asset_id = $4, two_factor_enabled = $5
             where id = $6
             returning id`,
            [displayName, email, about, avatarAssetId, twoFactorEnabled, req.user.id],
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

        const user = await getUserById(req.user.id);
        return res.json({ user });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'E-Mail ist bereits vergeben' });
        return next(error);
    }
});

app.get('/api/users', requireAuth, async (req, res, next) => {
    try {
        const search = String(req.query.search || '').trim().toLowerCase();
        if (search.length < 2) return res.json({ users: [] });

        const result = await query(
            `select u.id, u.username, u.display_name, u.about, u.avatar_color, u.last_seen_at,
                case when aa.id is null then null else 'data:' || aa.mime_type || ';base64,' || encode(aa.data, 'base64') end as avatar_url
             from users u
             left join avatar_assets aa on aa.id = u.avatar_asset_id and aa.is_active = true
             where u.id <> $1 and (u.username like $2 or lower(u.display_name) like $2)
             order by u.username
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
                case when aa.id is null then null else 'data:' || aa.mime_type || ';base64,' || encode(aa.data, 'base64') end as avatar_url,
                latest.body as last_message,
                latest.has_attachment as has_attachment,
                latest.created_at as last_message_at,
                latest.sender_id as last_sender_id,
                unread.count as unread_count
             from conversations c
             join users other_user
                on other_user.id = case when c.user_one_id = $1 then c.user_two_id else c.user_one_id end
             left join avatar_assets aa on aa.id = other_user.avatar_asset_id and aa.is_active = true
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

app.post('/api/conversations/by-username', requireAuth, async (req, res, next) => {
    try {
        const username = normalizeUsername(req.body.username);
        if (!username) return res.status(400).json({ error: 'Bitte @name eingeben' });

        const result = await query('select id from users where username = $1 and id <> $2', [username, req.user.id]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

        const [userOneId, userTwoId] = conversationPair(req.user.id, user.id);
        const conversation = await query(
            `insert into conversations (user_one_id, user_two_id)
             values ($1, $2)
             on conflict (user_one_id, user_two_id) do update set user_one_id = excluded.user_one_id
             returning id`,
            [userOneId, userTwoId],
        );

        return res.status(201).json({ conversation: { id: conversation.rows[0].id } });
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
                avatar_url: otherUser.avatar_url,
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
