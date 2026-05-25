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
const IMAGE_UPDATE_WEBHOOK_URL = process.env.IMAGE_UPDATE_WEBHOOK_URL || '';
const IMAGE_UPDATE_WEBHOOK_TOKEN = process.env.IMAGE_UPDATE_WEBHOOK_TOKEN || '';
const FORBIDDEN_WORDS = (process.env.FORBIDDEN_WORDS || 'admin,administrator,moderator,system,support,root')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
const startedAt = new Date();

let pool;
let mailer;
const eventClients = new Map();
let imageUpdateState = {
    configured: Boolean(IMAGE_UPDATE_WEBHOOK_URL),
    status: IMAGE_UPDATE_WEBHOOK_URL ? 'idle' : 'not_configured',
    requestedAt: null,
    finishedAt: null,
    message: IMAGE_UPDATE_WEBHOOK_URL
        ? 'Bereit, ein neues Container-Image anzufordern.'
        : 'IMAGE_UPDATE_WEBHOOK_URL ist nicht konfiguriert.',
};

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

function validateCleanName(value, fieldName) {
    const lowered = String(value || '').toLowerCase();
    const forbidden = FORBIDDEN_WORDS.find((word) => lowered.includes(word));
    if (forbidden) {
        const error = new Error(`${fieldName} enthält ein nicht erlaubtes Wort`);
        error.statusCode = 400;
        throw error;
    }
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

async function dispatchImageUpdate() {
    const requestedAt = new Date().toISOString();
    imageUpdateState = {
        configured: true,
        status: 'running',
        requestedAt,
        finishedAt: null,
        message: 'Update-Anfrage wird im Hintergrund gesendet.',
    };

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (IMAGE_UPDATE_WEBHOOK_TOKEN) {
            headers.Authorization = `Bearer ${IMAGE_UPDATE_WEBHOOK_TOKEN}`;
        }
        const response = await fetch(IMAGE_UPDATE_WEBHOOK_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                event: 'image_update_requested',
                app: process.env.APP_NAME || 'JustChat',
                imageTag: 'latest',
                requestedAt,
            }),
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
            throw new Error(`Update-Webhook antwortet mit HTTP ${response.status}`);
        }

        imageUpdateState = {
            configured: true,
            status: 'requested',
            requestedAt,
            finishedAt: new Date().toISOString(),
            message: 'Image-Update wurde angefordert. Die App kann beim Neustart kurz offline sein.',
        };
    } catch (error) {
        imageUpdateState = {
            configured: true,
            status: 'failed',
            requestedAt,
            finishedAt: new Date().toISOString(),
            message: error.message || 'Image-Update konnte nicht angefordert werden.',
        };
    }
}

function parseAttachment(attachment) {
    if (!attachment) return null;

    const mimeType = String(attachment.mimeType || 'application/octet-stream').toLowerCase().slice(0, 120);
    const fileName = String(attachment.fileName || 'datei').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').slice(0, 120) || 'datei';
    const dataBase64 = String(attachment.dataBase64 || '');

    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) {
        const error = new Error('Ungültiger Dateityp');
        error.statusCode = 400;
        throw error;
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
        const error = new Error('Datei muss kleiner als 5 MB sein');
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

function parseImageAttachment(attachment) {
    const parsed = parseAttachment(attachment);
    if (!parsed) return null;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(parsed.mimeType)) {
        const error = new Error('Nur JPEG, PNG, WebP und GIF sind erlaubt');
        error.statusCode = 400;
        throw error;
    }
    return parsed;
}

function parseNotificationSoundAttachment(attachment) {
    const parsed = parseAttachment(attachment);
    if (!parsed) return null;
    if (!['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/x-wav', 'audio/aac', 'audio/x-m4a'].includes(parsed.mimeType)) {
        const error = new Error('Nur MP3, OGG, WAV, WebM, M4A und AAC sind erlaubt');
        error.statusCode = 400;
        throw error;
    }
    return parsed;
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
        const error = new Error('Für 2FA ist eine E-Mail-Adresse erforderlich');
        error.statusCode = 400;
        throw error;
    }
    if (!getMailer()) {
        const error = new Error('2FA braucht vollständige SMTP-Konfiguration');
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
        text: `Dein JustChat Login-Code lautet: ${code}\n\nDer Code ist 10 Minuten gültig.`,
    });
}

async function sendPasswordResetCode(user) {
    if (!user.email) {
        const error = new Error('Für Passwort-Reset ist eine E-Mail-Adresse erforderlich');
        error.statusCode = 400;
        throw error;
    }
    if (!getMailer()) {
        const error = new Error('Passwort-Reset braucht vollständige SMTP-Konfiguration');
        error.statusCode = 503;
        throw error;
    }

    const code = createLoginCode();
    await query(
        `insert into password_reset_codes (user_id, code_hash, expires_at)
         values ($1, $2, now() + interval '15 minutes')`,
        [user.id, hashPassword(code)],
    );
    await sendMail({
        to: user.email,
        subject: 'Dein JustChat Passwort-Code',
        text: `Dein Code zum Zurücksetzen des Passworts lautet: ${code}\n\nDer Code ist 15 Minuten gültig.`,
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
            display_name_visibility text not null default 'contacts',
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

        create table if not exists notification_sound_assets (
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

        create table if not exists user_blocks (
            blocker_id bigint not null references users(id) on delete cascade,
            blocked_user_id bigint not null references users(id) on delete cascade,
            created_at timestamptz not null default now(),
            primary key (blocker_id, blocked_user_id),
            check(blocker_id <> blocked_user_id)
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

        create table if not exists password_reset_codes (
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
        alter table users add column if not exists display_name_visibility text not null default 'contacts';
        alter table users add column if not exists notification_sound_asset_id bigint references notification_sound_assets(id);
        alter table conversations add column if not exists hidden_for_user_one boolean not null default false;
        alter table conversations add column if not exists hidden_for_user_two boolean not null default false;

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
            u.two_factor_enabled, u.display_name_visibility, u.notification_sound_asset_id,
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

async function getBlockStatus(userId, otherUserId) {
    const result = await query(
        `select
            exists(select 1 from user_blocks where blocker_id = $1 and blocked_user_id = $2) as blocked_by_me,
            exists(select 1 from user_blocks where blocker_id = $2 and blocked_user_id = $1) as blocked_me`,
        [userId, otherUserId],
    );
    return result.rows[0];
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
            message: DATABASE_URL ? 'Noch nicht geprüft' : 'DATABASE_URL ist nicht gesetzt',
        },
        authConfigured: Boolean(ADMIN_PASSWORD),
        onlineEventClients: Array.from(eventClients.values()).reduce((sum, clients) => sum + clients.size, 0),
        imageUpdate: imageUpdateState,
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
                <h2>Nächster Schritt</h2>
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
        button:disabled { cursor: not-allowed; opacity: .56; }
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
        .asset-card button { width: 100%; }
        .sound-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
        .sound-card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: grid; gap: 10px; background: #fff; }
        .sound-card audio { width: 100%; }
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
                    <label for="userFilter">Nutzer für Export auswählen</label>
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
                    <h2>Container-Image</h2>
                    <p class="muted">Fordert im Hintergrund ein neues <code>latest</code>-Image über den eingerichteten Deployment-Webhook an.</p>
                    <div style="margin-top: 12px;">
                        <span id="imageUpdateStatus" class="status warn">Status wird geladen</span>
                        <p id="imageUpdateMessage" class="muted"></p>
                    </div>
                    <div class="toolbar" style="margin-top: 12px;">
                        <button id="imageUpdateButton" type="button">Image neu laden</button>
                        <button id="updateButton" class="secondary" type="button">Status neu laden</button>
                    </div>
                </section>
            </aside>
        </div>

        <section class="panel">
            <h2>Profilbilder</h2>
            <p class="muted">Hier lädst du erlaubte Profilbilder hoch. Nutzer können nur diese Bilder auswählen, keine eigenen Uploads.</p>
            <div class="toolbar" style="margin-top: 12px;">
                <input id="avatarName" placeholder="Name des Profilbilds">
                <input id="avatarFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
                <button id="uploadAvatar" type="button">Profilbild hochladen</button>
            </div>
            <div id="avatarGrid" class="avatar-grid" style="margin-top: 16px;"></div>
        </section>

        <section class="panel">
            <h2>Benachrichtigungstöne</h2>
            <p class="muted">Lade die Töne hoch, die Nutzer in ihren Einstellungen auswählen dürfen.</p>
            <div class="toolbar" style="margin-top: 12px;">
                <input id="soundName" placeholder="Name des Tons">
                <input id="soundFile" type="file" accept="audio/mpeg,audio/ogg,audio/wav,audio/webm,audio/mp4,audio/aac,audio/x-m4a">
                <button id="uploadSound" type="button">Ton hochladen</button>
            </div>
            <div id="soundGrid" class="sound-grid" style="margin-top: 16px;"></div>
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

        <div class="notice">Hinweis: Exporte enthalten private Chatdaten und Bildanhänge. Verwende sie nur mit berechtigtem Zweck und bewahre Downloads geschützt auf.</div>

        <script>
            const state = { users: [], avatars: [], sounds: [], audit: [], imageUpdate: null };
            const el = (id) => document.getElementById(id);
            const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[char]));

            function initials(name) {
                return String(name || '?').slice(0, 1).toUpperCase() || '?';
            }

            async function readFileBase64(file) {
                if (!file) throw new Error('Bitte ein Bild auswählen');
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

            async function readSoundBase64(file) {
                if (!file) throw new Error('Bitte eine Sounddatei auswählen');
            if (!['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/x-wav', 'audio/aac', 'audio/x-m4a'].includes(file.type)) {
                throw new Error('Nur MP3, OGG, WAV, WebM, M4A und AAC sind erlaubt');
                }
                if (file.size > 5 * 1024 * 1024) throw new Error('Sounddatei muss kleiner als 5 MB sein');
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
                    reader.onerror = () => reject(new Error('Sounddatei konnte nicht gelesen werden'));
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
                    '<div class="avatar-card asset-card"><img src="' + avatar.data_url + '" alt=""><strong>' + escapeText(avatar.name) + '</strong><span class="muted">' + Math.round(avatar.size_bytes / 1024) + ' KB</span><button class="danger" type="button" data-delete-avatar="' + avatar.id + '">Löschen</button></div>'
                ).join('') : '<p class="muted">Noch keine Profilbilder hochgeladen.</p>';
                el('soundGrid').innerHTML = state.sounds.length ? state.sounds.map((sound) =>
                    '<div class="sound-card asset-card"><strong>' + escapeText(sound.name) + '</strong><audio controls preload="none" src="' + sound.data_url + '"></audio><span class="muted">' + Math.round(sound.size_bytes / 1024) + ' KB</span><button class="danger" type="button" data-delete-sound="' + sound.id + '">Löschen</button></div>'
                ).join('') : '<p class="muted">Noch keine Benachrichtigungstöne hochgeladen.</p>';
                el('auditRows').innerHTML = state.audit.map((row) =>
                    '<tr><td>' + new Date(row.created_at).toLocaleString() + '</td><td>' + escapeText(row.admin_user) + '</td><td>' + escapeText(row.action) + '</td><td>' + escapeText(row.ip_address || '-') + '</td></tr>'
                ).join('');
                const update = state.imageUpdate || { configured: false, status: 'not_configured', message: 'Nicht konfiguriert.' };
                const statusNames = {
                    not_configured: 'Nicht konfiguriert',
                    idle: 'Bereit',
                    running: 'Wird angefordert',
                    requested: 'Angefordert',
                    failed: 'Fehlgeschlagen',
                };
                const statusClasses = { idle: 'ok', requested: 'ok', running: 'warn', not_configured: 'warn', failed: 'error' };
                el('imageUpdateStatus').className = 'status ' + (statusClasses[update.status] || 'warn');
                el('imageUpdateStatus').textContent = statusNames[update.status] || update.status;
                el('imageUpdateMessage').textContent = update.message || '';
                el('imageUpdateButton').disabled = !update.configured || update.status === 'running';
            }

            async function loadAdmin() {
                const data = await adminApi('/admin/api/overview');
                state.summary = data.summary;
                state.users = data.users;
                state.avatars = data.avatars;
                state.sounds = data.sounds;
                state.audit = data.audit;
                state.imageUpdate = data.imageUpdate;
                render();
            }

            el('refreshButton').addEventListener('click', loadAdmin);
            el('updateButton').addEventListener('click', loadAdmin);
            el('imageUpdateButton').addEventListener('click', async () => {
                if (!confirm('Neues Container-Image anfordern und einen möglichen Neustart auslösen?')) return;
                try {
                    const data = await adminApi('/admin/api/image-update', { method: 'POST', body: '{}' });
                    state.imageUpdate = data.imageUpdate;
                    render();
                    setTimeout(() => loadAdmin().catch(() => {}), 1500);
                } catch (error) {
                    alert(error.message);
                }
            });
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
            el('avatarGrid').addEventListener('click', async (event) => {
                const button = event.target.closest('[data-delete-avatar]');
                if (!button) return;
                try {
                    await adminApi('/admin/api/avatar-assets/' + button.dataset.deleteAvatar, { method: 'DELETE' });
                    await loadAdmin();
                } catch (error) {
                    alert(error.message);
                }
            });
            el('uploadSound').addEventListener('click', async () => {
                try {
                    const file = el('soundFile').files[0];
                    const dataBase64 = await readSoundBase64(file);
                    await adminApi('/admin/api/notification-sounds', {
                        method: 'POST',
                        body: JSON.stringify({
                            name: el('soundName').value || file.name,
                            attachment: { fileName: file.name, mimeType: file.type, dataBase64 },
                        }),
                    });
                    el('soundName').value = '';
                    el('soundFile').value = '';
                    await loadAdmin();
                } catch (error) {
                    alert(error.message);
                }
            });
            el('soundGrid').addEventListener('click', async (event) => {
                const button = event.target.closest('[data-delete-sound]');
                if (!button) return;
                try {
                    await adminApi('/admin/api/notification-sounds/' + button.dataset.deleteSound, { method: 'DELETE' });
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
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
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
        .field select { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 11px 12px; outline: none; background: #fff; }
        .field input:focus, .field textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(15, 118, 110, .12); }
        .avatar-picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(66px, 1fr)); gap: 8px; }
        .avatar-option { border: 2px solid var(--line); background: #fff; border-radius: 8px; padding: 6px; min-height: 74px; display: grid; place-items: center; }
        .avatar-option.selected { border-color: var(--accent); background: #eef8f6; }
        .avatar-option img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; }
        .primary { background: var(--accent); color: #fff; border-radius: 8px; padding: 11px 14px; font-weight: 700; }
        .primary:hover { background: var(--accent-strong); }
        .ghost { background: transparent; color: var(--accent); font-weight: 700; padding: 8px; }
        .error { color: var(--danger); min-height: 20px; }
        .success { color: var(--accent); min-height: 20px; }
        .inline-panel { border: 1px solid var(--line); border-radius: 8px; background: #f7fbfa; padding: 12px; display: grid; gap: 10px; }
        .app { height: 100vh; height: 100dvh; display: grid; grid-template-columns: 360px 1fr; overflow: hidden; }
        .sidebar { background: var(--sidebar); border-right: 1px solid var(--line); display: grid; grid-template-rows: auto auto 1fr; min-width: 0; min-height: 0; }
        .topbar { padding: 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .me-box { display: grid; grid-template-columns: 44px 1fr; gap: 10px; align-items: center; min-width: 0; }
        .top-actions { display: flex; align-items: center; gap: 6px; }
        .icon-button { width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center; padding: 0; }
        .icon-button svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
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
        .preview-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
        .preview { color: var(--muted); font-size: 13px; margin-top: 4px; }
        .unread-badge { flex: none; min-width: 20px; height: 20px; border-radius: 999px; display: inline-grid; place-items: center; padding: 0 6px; background: #22c55e; color: #fff; font-size: 11px; font-weight: 800; }
        .chat { position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; }
        .chat-head { background: var(--panel); border-bottom: 1px solid var(--line); padding: 14px 18px; display: flex; align-items: center; gap: 12px; min-width: 0; }
        .chat-profile { min-width: 0; display: flex; align-items: center; gap: 12px; background: transparent; padding: 0; text-align: left; }
        .chat-profile:hover .brand strong { color: var(--accent); }
        .typing { color: var(--accent); font-weight: 700; }
        .messages { padding: 18px; overflow: auto; display: flex; flex-direction: column; gap: 8px; background: #e9f0f4; }
        .bubble { max-width: min(680px, 82%); border: 1px solid rgba(15, 23, 42, .08); border-radius: 8px; padding: 9px 11px; background: var(--message-other); align-self: flex-start; overflow-wrap: anywhere; }
        .bubble.me { background: var(--message-me); align-self: flex-end; }
        .bubble img { display: block; max-width: min(420px, 100%); border-radius: 8px; margin-bottom: 8px; }
        .attachment-link { display: flex; align-items: center; gap: 8px; color: var(--accent); font-weight: 700; text-decoration: none; padding: 9px 10px; margin-bottom: 6px; border-radius: 8px; background: rgba(15, 118, 110, .08); }
        .meta { display: block; color: var(--muted); font-size: 11px; margin-top: 5px; text-align: right; }
        .composer { width: 100%; min-width: 0; background: var(--panel); border-top: 1px solid var(--line); padding: 12px; display: grid; grid-template-columns: 48px minmax(0, 1fr) 48px; gap: 10px; align-items: end; }
        .composer textarea { width: 100%; min-width: 0; min-height: 48px; max-height: 120px; resize: vertical; border: 1px solid var(--line); border-radius: 24px; padding: 12px 18px; outline: none; }
        .composer textarea:focus { border-color: var(--accent); }
        .file-button { border: 1px solid var(--line); border-radius: 50%; width: 48px; height: 48px; display: grid; place-items: center; color: var(--accent); background: #fff; cursor: pointer; }
        .file-button svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        .file-button input { display: none; }
        .attachment-preview { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-radius: 8px; background: #eef8f6; color: var(--text); padding: 8px 10px; font-size: 13px; }
        .attachment-preview button { background: transparent; color: var(--danger); font-weight: 700; padding: 3px 6px; }
        .send-button { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; padding: 0; overflow: hidden; }
        .send-button svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; transform: translateX(1px); }
        .composer-error { grid-column: 1 / -1; margin: 0; min-height: 0; }
        .chat.drop-active .messages { outline: 2px dashed var(--accent); outline-offset: -10px; background: #dff1ec; }
        .drop-hint { display: none; position: absolute; inset: 72px 18px 74px; place-items: center; pointer-events: none; z-index: 2; color: var(--accent); font-size: 18px; font-weight: 700; }
        .chat.drop-active .drop-hint { display: grid; }
        .settings-view { grid-row: 1 / -1; overflow: auto; padding: 24px; background: var(--bg); }
        .settings-card { width: min(620px, 100%); margin: 0 auto; background: #fff; border-radius: 8px; border: 1px solid var(--line); padding: 20px; }
        .contact-avatar { width: 88px; height: 88px; font-size: 30px; margin: 0 auto; }
        .contact-heading { text-align: center; display: grid; gap: 4px; }
        .contact-about { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #f7fbfa; min-height: 48px; }
        .danger-button { background: #fff1f0; color: var(--danger); border: 1px solid #f3c6c1; border-radius: 8px; padding: 11px 14px; font-weight: 700; }
        .modal { position: fixed; inset: 0; background: rgba(15, 23, 42, .42); display: grid; place-items: center; padding: 18px; z-index: 20; }
        .modal-card { width: min(560px, 100%); max-height: min(760px, 100%); overflow: auto; background: #fff; border-radius: 8px; border: 1px solid var(--line); padding: 20px; box-shadow: 0 24px 80px rgba(15, 23, 42, .22); }
        .modal-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
        .segmented { display: flex; gap: 8px; flex-wrap: wrap; }
        .small { font-size: 13px; }
        .empty { height: 100%; display: grid; place-items: center; text-align: center; color: var(--muted); padding: 24px; }
        .hidden { display: none !important; }
        @media (max-width: 780px) {
            body { overflow: hidden; }
            .app { grid-template-columns: 1fr; }
            .topbar { padding-top: calc(16px + env(safe-area-inset-top)); }
            .sidebar.chat-open { display: none; }
            .chat:not(.chat-open) { display: none; }
            .chat-head {
                min-height: 64px;
                padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
                background: var(--panel);
                box-shadow: 0 1px 3px rgba(15,23,42,.08);
            }
            .chat {
                height: 100vh;
                height: 100dvh;
            }
            .messages {
                min-height: 0;
                padding: 12px 10px;
                overflow-y: auto;
                overscroll-behavior-y: contain;
            }
            .composer {
                grid-template-columns: 48px minmax(0, 1fr) 48px;
                padding: 10px 10px calc(10px + env(safe-area-inset-bottom));
                gap: 8px;
                background: #f0f2f5;
            }
            .composer textarea {
                border: 0;
                min-height: 48px;
                border-radius: 24px;
                resize: none;
            }
            .settings-view { padding: calc(16px + env(safe-area-inset-top)) 12px calc(16px + env(safe-area-inset-bottom)); }
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
                <input id="username" autocomplete="username" required maxlength="32">
            </div>
            <div class="field">
                <label for="password">Passwort</label>
                <input id="password" type="password" autocomplete="current-password" required minlength="6">
            </div>
            <div class="field register-only hidden">
                <label for="passwordRepeat">Passwort wiederholen</label>
                <input id="passwordRepeat" type="password" autocomplete="new-password" minlength="6">
            </div>
            <label class="segmented register-only hidden">
                <input id="register2fa" type="checkbox" style="width:auto;">
                <span>2FA per E-Mail-Code aktivieren</span>
            </label>
            <div id="authError" class="error"></div>
            <button id="authSubmit" class="primary" type="submit">Anmelden</button>
            <a id="googleLogin" class="primary hidden" style="text-align:center;text-decoration:none;" href="/auth/google">Mit Google fortfahren</a>
            <button id="toggleAuth" class="ghost" type="button">Neues Konto erstellen</button>
            <div class="segmented">
                <button id="forgotUsername" class="ghost" type="button">Benutzername vergessen</button>
                <button id="forgotPassword" class="ghost" type="button">Passwort vergessen</button>
            </div>
            <div id="twoFactorPanel" class="inline-panel hidden">
                <strong>2FA-Bestätigung</strong>
                <p class="muted small">Gib den Code aus deiner E-Mail ein.</p>
                <div class="field">
                    <label for="twoFactorCode">Code</label>
                    <input id="twoFactorCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
                </div>
                <button id="verifyTwoFactor" class="primary" type="button">Code bestätigen</button>
                <button id="cancelTwoFactor" class="ghost" type="button">Zurück zur Anmeldung</button>
            </div>
            <div id="forgotUsernamePanel" class="inline-panel hidden">
                <strong>Benutzername wiederfinden</strong>
                <div class="field">
                    <label for="forgotUsernameEmail">E-Mail-Adresse</label>
                    <input id="forgotUsernameEmail" type="email" autocomplete="email">
                </div>
                <button id="sendUsernameReminder" class="primary" type="button">Benutzername senden</button>
            </div>
            <div id="forgotPasswordPanel" class="inline-panel hidden">
                <strong>Passwort zurücksetzen</strong>
                <div class="field">
                    <label for="resetIdentifier">Benutzername oder E-Mail</label>
                    <input id="resetIdentifier" autocomplete="username">
                </div>
                <button id="requestResetCode" class="primary" type="button">Code anfordern</button>
                <div id="resetFields" class="stack hidden">
                    <div class="field">
                        <label for="resetCode">Code</label>
                        <input id="resetCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
                    </div>
                    <div class="field">
                        <label for="resetPassword">Neues Passwort</label>
                        <input id="resetPassword" type="password" autocomplete="new-password" minlength="6">
                    </div>
                    <div class="field">
                        <label for="resetPasswordRepeat">Passwort wiederholen</label>
                        <input id="resetPasswordRepeat" type="password" autocomplete="new-password" minlength="6">
                    </div>
                    <button id="submitPasswordReset" class="primary" type="button">Passwort speichern</button>
                </div>
            </div>
            <div id="authNotice" class="success"></div>
        </form>
    </div>

    <div id="messenger" class="app hidden">
        <aside id="sidebar" class="sidebar">
            <div class="topbar">
                <div class="me-box">
                    <div id="meAvatar" class="avatar">J</div>
                    <div class="brand">
                        <strong id="meName">JustChat</strong>
                        <span id="meUsername"></span>
                    </div>
                </div>
                <div class="top-actions">
                    <button id="settingsButton" class="ghost icon-button" type="button" aria-label="Einstellungen" title="Einstellungen">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"></path><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.3a2 2 0 1 1-4 0V21a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.1 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.6a2 2 0 1 1 0-4H3a1.7 1.7 0 0 0 1.6-1.1A1.7 1.7 0 0 0 4.2 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6v-.3a2 2 0 1 1 4 0V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.3a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6.9z"></path></svg>
                    </button>
                    <button id="addPerson" class="primary icon-button" type="button" aria-label="Chat hinzufügen" title="Chat hinzufügen">+</button>
                </div>
            </div>
            <div class="search">
                <input id="search" placeholder="Nutzer suchen">
                <div id="searchResults"></div>
            </div>
            <div id="conversationList" class="list"></div>
        </aside>
        <section id="chat" class="chat">
            <div id="chatEmpty" class="empty">Wähle einen Chat aus oder suche einen Nutzer.</div>
            <div id="chatPane" class="hidden" style="display: contents;">
                <div class="chat-head">
                    <button id="back" class="ghost" type="button">Zurück</button>
                    <button id="chatProfileButton" class="chat-profile" type="button" aria-label="Profil anzeigen">
                        <div id="chatAvatar" class="avatar">?</div>
                        <div class="brand">
                            <strong id="chatName"></strong>
                            <span id="chatUser"></span>
                            <span id="chatTyping" class="typing hidden">schreibt gerade...</span>
                        </div>
                    </button>
                </div>
                <div id="messages" class="messages"></div>
                <div class="drop-hint">Datei hier ablegen</div>
                <form id="composer" class="composer">
                    <div id="attachmentPreview" class="attachment-preview hidden"></div>
                    <label class="file-button" title="Datei anhängen">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.4 11.1 12.3 20.2a6 6 0 0 1-8.5-8.5l9.1-9.1a4 4 0 1 1 5.7 5.7l-9.1 9.1a2 2 0 0 1-2.8-2.8l8.5-8.5"></path></svg>
                        <input id="attachmentInput" type="file">
                    </label>
                    <textarea id="messageInput" placeholder="Nachricht schreiben" maxlength="4000"></textarea>
                    <button class="primary send-button" type="submit" aria-label="Senden" title="Senden">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4z"></path></svg>
                    </button>
                    <p id="composerError" class="error composer-error"></p>
                </form>
            </div>
            <div id="accountPanel" class="settings-view hidden">
                <form id="profileForm" class="settings-card stack">
                    <div class="modal-head">
                        <h2>Mein Account</h2>
                        <button id="closeAccount" class="ghost" type="button">Zurück</button>
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
                    <div class="field">
                        <label for="displayNameVisibility">Anzeigename anzeigen</label>
                        <select id="displayNameVisibility">
                            <option value="contacts">Nur Kontakten</option>
                            <option value="everyone">Allen</option>
                        </select>
                    </div>
                    <div class="field">
                        <label for="notificationSound">Benachrichtigungston</label>
                        <select id="notificationSound">
                            <option value="">Kein Ton</option>
                        </select>
                        <button id="previewSound" class="ghost" type="button">Ton anhören</button>
                    </div>
                    <p class="muted small">Bei aktivierter 2FA wird beim Login ein Code an deine E-Mail gesendet.</p>
                    <div id="profileError" class="error"></div>
                    <div id="profileNotice" class="success"></div>
                    <button class="primary" type="submit">Profil speichern</button>
                    <button id="logout" class="ghost" type="button">Logout</button>
                </form>
            </div>
            <div id="contactPanel" class="settings-view hidden">
                <div class="settings-card stack">
                    <div class="modal-head">
                        <h2>Kontaktprofil</h2>
                        <button id="closeContact" class="ghost" type="button">Zurück</button>
                    </div>
                    <div id="contactAvatar" class="avatar contact-avatar">?</div>
                    <div class="contact-heading">
                        <strong id="contactName"></strong>
                        <span id="contactUsername" class="muted"></span>
                    </div>
                    <div class="field">
                        <label>Info</label>
                        <div id="contactAbout" class="contact-about"></div>
                    </div>
                    <div class="field">
                        <label>Zuletzt aktiv</label>
                        <div id="contactLastSeen" class="contact-about"></div>
                    </div>
                    <p id="contactBlockInfo" class="muted small"></p>
                    <div id="contactError" class="error"></div>
                    <button id="toggleBlock" class="danger-button" type="button">Person blockieren</button>
                    <button id="deleteChat" class="danger-button" type="button">Chat bei mir löschen</button>
                </div>
            </div>
        </section>
    </div>

    <div id="addModal" class="modal hidden">
        <form id="addForm" class="modal-card stack">
            <div class="modal-head">
                <h2>Person adden</h2>
                <button id="closeAdd" class="ghost" type="button">Schließen</button>
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
            pendingAttachment: null,
            sounds: [],
            typingSent: false,
            typingLastSentAt: 0,
            typingStopTimer: null,
            remoteTyping: false,
            remoteTypingTimer: null,
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

        function resetAuthPanels() {
            state.pendingTwoFactorUserId = null;
            $('twoFactorPanel').classList.add('hidden');
            $('forgotUsernamePanel').classList.add('hidden');
            $('forgotPasswordPanel').classList.add('hidden');
            $('resetFields').classList.add('hidden');
            $('twoFactorCode').value = '';
            $('authNotice').textContent = '';
        }

        function setAuthMode(registerMode) {
            state.registerMode = registerMode;
            resetAuthPanels();
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
                $('avatarPicker').innerHTML = '<span class="muted">Keine Profilbilder verfügbar.</span>';
            }
        }

        function renderAvatarPicker() {
            if (!state.avatars.length) {
                $('avatarPicker').innerHTML = '<span class="muted">Noch keine Profilbilder verfügbar.</span>';
                return;
            }
            $('avatarPicker').innerHTML = state.avatars.map((avatar) =>
                '<button type="button" class="avatar-option ' + (Number(state.selectedAvatarId) === Number(avatar.id) ? 'selected' : '') + '" data-avatar="' + avatar.id + '">' +
                '<img src="' + avatar.data_url + '" alt="' + escapeText(avatar.name) + '"></button>'
            ).join('');
        }

        function renderProfileAvatarPicker() {
            if (!state.avatars.length) {
                $('profileAvatarPicker').innerHTML = '<span class="muted">Noch keine Profilbilder verfügbar.</span>';
                return;
            }
            $('profileAvatarPicker').innerHTML = state.avatars.map((avatar) =>
                '<button type="button" class="avatar-option ' + (Number(state.profileAvatarId) === Number(avatar.id) ? 'selected' : '') + '" data-profile-avatar="' + avatar.id + '">' +
                '<img src="' + avatar.data_url + '" alt="' + escapeText(avatar.name) + '"></button>'
            ).join('');
        }

        async function loadNotificationSounds() {
            const data = await api('/api/notification-sounds');
            state.sounds = data.sounds || [];
            $('notificationSound').innerHTML = '<option value="">Kein Ton</option>' + state.sounds.map((sound) =>
                '<option value="' + sound.id + '">' + escapeText(sound.name) + '</option>'
            ).join('');
            $('notificationSound').value = state.me && state.me.notification_sound_asset_id
                ? String(state.me.notification_sound_asset_id)
                : '';
        }

        function playNotificationSound(soundId = state.me && state.me.notification_sound_asset_id) {
            if (!soundId) return;
            const sound = state.sounds.find((entry) => Number(entry.id) === Number(soundId));
            if (!sound) return;
            new Audio(sound.data_url).play().catch(() => {});
        }

        function canMessageActiveConversation() {
            return state.activeConversation && !state.activeConversation.blocked_by_me && !state.activeConversation.blocked_me;
        }

        function updateMessageControls() {
            const enabled = Boolean(canMessageActiveConversation());
            $('messageInput').disabled = !enabled;
            $('attachmentInput').disabled = !enabled;
            $('composer').querySelector('button[type="submit"]').disabled = !enabled;
            $('messageInput').placeholder = enabled ? 'Nachricht schreiben' : 'Nachrichten nicht möglich';
            updateChatTypingLine();
        }

        function updateChatTypingLine() {
            const status = $('chatTyping');
            if (!state.activeConversation) {
                status.classList.add('hidden');
                return;
            }
            if (state.activeConversation.blocked_by_me) {
                status.textContent = 'Du hast diese Person blockiert.';
                status.classList.remove('hidden');
                return;
            }
            if (state.activeConversation.blocked_me) {
                status.textContent = 'Nachrichten sind nicht möglich.';
                status.classList.remove('hidden');
                return;
            }
            status.textContent = 'schreibt gerade...';
            status.classList.toggle('hidden', !state.remoteTyping);
        }

        function setRemoteTyping(typing) {
            state.remoteTyping = Boolean(typing);
            if (state.remoteTypingTimer) clearTimeout(state.remoteTypingTimer);
            if (typing) {
                state.remoteTypingTimer = setTimeout(() => {
                    state.remoteTyping = false;
                    updateChatTypingLine();
                }, 2500);
            }
            updateChatTypingLine();
        }

        function sendTyping(typing) {
            if (!state.activeConversation || !canMessageActiveConversation()) return;
            if (!typing && !state.typingSent) return;
            state.typingSent = Boolean(typing);
            state.typingLastSentAt = Date.now();
            api('/api/conversations/' + state.activeConversation.id + '/typing', {
                method: 'POST',
                body: JSON.stringify({ typing: Boolean(typing) }),
            }).catch(() => {});
        }

        function stopTyping() {
            if (state.typingStopTimer) clearTimeout(state.typingStopTimer);
            sendTyping(false);
        }

        function updateTyping() {
            if (!$('messageInput').value.trim() || !canMessageActiveConversation()) {
                stopTyping();
                return;
            }
            if (!state.typingSent || Date.now() - state.typingLastSentAt > 1000) sendTyping(true);
            if (state.typingStopTimer) clearTimeout(state.typingStopTimer);
            state.typingStopTimer = setTimeout(stopTyping, 1800);
        }

        function formatLastSeen(value) {
            if (!value) return 'Keine Aktivität verfügbar';
            return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
        }

        function renderContactProfile() {
            const contact = state.activeConversation;
            if (!contact) return;
            if (contact.avatar_url) {
                $('contactAvatar').outerHTML = '<img id="contactAvatar" class="avatar contact-avatar" src="' + contact.avatar_url + '" alt="">';
            } else {
                $('contactAvatar').outerHTML = '<div id="contactAvatar" class="avatar contact-avatar" style="background:' + contact.avatar_color + '">' + initials(contact.display_name) + '</div>';
            }
            $('contactName').textContent = contact.display_name;
            $('contactUsername').textContent = '@' + contact.username;
            $('contactAbout').textContent = contact.about || 'Keine Info angegeben.';
            $('contactLastSeen').textContent = formatLastSeen(contact.last_seen_at);
            $('contactBlockInfo').textContent = contact.blocked_me
                ? 'Diese Person hat Nachrichten von dir blockiert.'
                : (contact.blocked_by_me ? 'Diese Person ist blockiert und kann dir hier nicht schreiben.' : '');
            $('toggleBlock').textContent = contact.blocked_by_me ? 'Blockierung aufheben' : 'Person blockieren';
            $('contactError').textContent = '';
        }

        function renderConversationList() {
            $('conversationList').innerHTML = state.conversations.map((chat) => {
                const active = state.activeConversation && state.activeConversation.id === chat.id ? ' active' : '';
                const preview = chat.last_message || (chat.has_attachment ? 'Datei' : 'Noch keine Nachrichten');
                const time = chat.last_message_at ? new Date(chat.last_message_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                const unread = Number(chat.unread_count || 0);
                return '<button class="row' + active + '" data-chat="' + chat.id + '">' +
                    avatarMarkup(chat) +
                    '<div class="row-main"><div class="row-title"><strong>' + escapeText(chat.display_name) + '</strong><span class="muted">' + time + '</span></div>' +
                    '<div class="preview-line"><div class="preview">' + escapeText(preview) + '</div>' +
                    (unread ? '<span class="unread-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
                    '</div></div></button>';
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
                    ? (String(message.attachment.mime_type || '').startsWith('image/')
                        ? '<img src="' + message.attachment.data_url + '" alt="' + escapeText(message.attachment.file_name) + '">'
                        : '<a class="attachment-link" href="' + message.attachment.data_url + '" download="' + escapeText(message.attachment.file_name) + '">Datei: ' + escapeText(message.attachment.file_name) + '</a>')
                    : '';
                const text = message.body ? escapeText(message.body) : '';
                return '<div class="bubble ' + (mine ? 'me' : '') + '">' +
                    attachment + text + '<span class="meta">' + time + read + '</span></div>';
            }).join('');
            $('messages').scrollTop = $('messages').scrollHeight;
        }

        function renderPendingAttachment() {
            const preview = $('attachmentPreview');
            if (!state.pendingAttachment) {
                preview.classList.add('hidden');
                preview.innerHTML = '';
                return;
            }
            preview.classList.remove('hidden');
            preview.innerHTML = '<span>Datei: ' + escapeText(state.pendingAttachment.name) + '</span><button id="removeAttachment" type="button">Entfernen</button>';
        }

        function chooseAttachment(file) {
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) {
                $('composerError').textContent = 'Datei muss kleiner als 5 MB sein';
                return;
            }
            $('composerError').textContent = '';
            state.pendingAttachment = file;
            renderPendingAttachment();
        }

        function readSelectedAttachment() {
            const file = state.pendingAttachment || $('attachmentInput').files[0];
            if (!file) return Promise.resolve(null);
            if (file.size > 5 * 1024 * 1024) {
                return Promise.reject(new Error('Datei muss kleiner als 5 MB sein'));
            }

            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const dataUrl = String(reader.result);
                    resolve({
                        fileName: file.name,
                        mimeType: file.type || 'application/octet-stream',
                        dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
                    });
                };
                reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
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

        function openAccount() {
            stopTyping();
            $('profileDisplayName').value = state.me.display_name || '';
            $('profileEmail').value = state.me.email || '';
            $('profileAbout').value = state.me.about || '';
            $('profile2fa').checked = Boolean(state.me.two_factor_enabled);
            $('displayNameVisibility').value = state.me.display_name_visibility || 'contacts';
            $('notificationSound').value = state.me.notification_sound_asset_id ? String(state.me.notification_sound_asset_id) : '';
            state.profileAvatarId = state.me.avatar_asset_id;
            renderProfileAvatarPicker();
            $('profileError').textContent = '';
            $('profileNotice').textContent = '';
            $('chatEmpty').classList.add('hidden');
            $('chatPane').classList.add('hidden');
            $('accountPanel').classList.remove('hidden');
            $('sidebar').classList.add('chat-open');
            $('chat').classList.add('chat-open');
            Promise.all([loadAvatars(), loadNotificationSounds()])
                .then(() => {
                    state.profileAvatarId = state.me.avatar_asset_id;
                    renderProfileAvatarPicker();
                })
                .catch((error) => {
                    $('profileError').textContent = error.message;
                });
        }

        async function closeAccount() {
            $('accountPanel').classList.add('hidden');
            if (state.activeConversation) {
                await openConversation(state.activeConversation.id);
            } else {
                $('chatEmpty').classList.remove('hidden');
                $('sidebar').classList.remove('chat-open');
                $('chat').classList.remove('chat-open');
            }
        }

        async function loadConversations() {
            const data = await api('/api/conversations');
            state.conversations = data.conversations;
            renderConversationList();
        }

        async function openConversation(id) {
            if (state.activeConversation && Number(state.activeConversation.id) !== Number(id)) stopTyping();
            const data = await api('/api/conversations/' + id + '/messages');
            if (!state.activeConversation || Number(state.activeConversation.id) !== Number(data.conversation.id)) {
                state.pendingAttachment = null;
                $('attachmentInput').value = '';
                renderPendingAttachment();
            }
            state.activeConversation = data.conversation;
            setRemoteTyping(false);
            $('accountPanel').classList.add('hidden');
            $('contactPanel').classList.add('hidden');
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
            updateMessageControls();
            renderMessages(data.messages);
            renderConversationList();
            await api('/api/conversations/' + id + '/read', { method: 'POST', body: '{}' });
            await loadConversations();
        }

        function connectEvents() {
            if (state.eventSource) state.eventSource.close();
            state.eventSource = new EventSource('/api/events?token=' + encodeURIComponent(state.token));
            state.eventSource.addEventListener('message:new', async (event) => {
                const payload = JSON.parse(event.data);
                const isActive = state.activeConversation && Number(state.activeConversation.id) === Number(payload.conversationId);
                const isOpen = isActive &&
                    !$('chatPane').classList.contains('hidden');
                if (state.me && Number(payload.message.sender_id) !== Number(state.me.id) && !isOpen) {
                    playNotificationSound();
                }
                if (isOpen) setRemoteTyping(false);
                await loadConversations();
                if (isOpen) {
                    await openConversation(payload.conversationId);
                }
            });
            state.eventSource.addEventListener('typing', (event) => {
                const payload = JSON.parse(event.data);
                if (state.activeConversation && Number(state.activeConversation.id) === Number(payload.conversationId)) {
                    setRemoteTyping(payload.typing);
                }
            });
            state.eventSource.addEventListener('conversation:deleted', async (event) => {
                const payload = JSON.parse(event.data);
                await loadConversations();
                if (state.activeConversation && Number(state.activeConversation.id) === Number(payload.conversationId)) {
                    state.activeConversation = null;
                    $('chatPane').classList.add('hidden');
                    $('contactPanel').classList.add('hidden');
                    $('chatEmpty').classList.remove('hidden');
                    $('sidebar').classList.remove('chat-open');
                    $('chat').classList.remove('chat-open');
                }
            });
            state.eventSource.addEventListener('contact:changed', async (event) => {
                const payload = JSON.parse(event.data);
                if (state.activeConversation && Number(state.activeConversation.user_id) === Number(payload.userId)) {
                    const showingProfile = !$('contactPanel').classList.contains('hidden');
                    await openConversation(state.activeConversation.id);
                    if (showingProfile) {
                        $('chatPane').classList.add('hidden');
                        renderContactProfile();
                        $('contactPanel').classList.remove('hidden');
                    }
                }
            });
        }

        async function boot() {
            if (!state.token) return showAuth();
            try {
                await loadMe();
                await loadNotificationSounds();
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
            if (state.pendingTwoFactorUserId) {
                $('verifyTwoFactor').click();
                return;
            }
            const body = {
                username: $('username').value,
                password: $('password').value,
                passwordRepeat: $('passwordRepeat').value,
                displayName: $('displayName').value,
                email: $('email').value,
                avatarAssetId: state.selectedAvatarId,
                twoFactorEnabled: $('register2fa').checked,
            };
            try {
                const endpoint = state.registerMode ? '/api/auth/register' : '/api/auth/login';
                const data = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
                if (data.twoFactorRequired) {
                    state.pendingTwoFactorUserId = data.userId;
                    $('twoFactorPanel').classList.remove('hidden');
                    $('authNotice').textContent = 'Ein Login-Code wurde an deine E-Mail gesendet.';
                    $('twoFactorCode').focus();
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
        $('settingsButton').addEventListener('click', openAccount);
        $('closeAccount').addEventListener('click', closeAccount);
        $('chatProfileButton').addEventListener('click', () => {
            if (!state.activeConversation) return;
            stopTyping();
            renderContactProfile();
            $('chatPane').classList.add('hidden');
            $('accountPanel').classList.add('hidden');
            $('contactPanel').classList.remove('hidden');
        });
        $('closeContact').addEventListener('click', async () => {
            $('contactPanel').classList.add('hidden');
            if (state.activeConversation) await openConversation(state.activeConversation.id);
        });
        $('toggleBlock').addEventListener('click', async () => {
            if (!state.activeConversation) return;
            $('contactError').textContent = '';
            try {
                const blocked = state.activeConversation.blocked_by_me;
                if (!blocked) stopTyping();
                await api('/api/users/' + state.activeConversation.user_id + '/block', {
                    method: blocked ? 'DELETE' : 'PUT',
                    body: '{}',
                });
                state.activeConversation.blocked_by_me = !blocked;
                renderContactProfile();
                updateMessageControls();
            } catch (error) {
                $('contactError').textContent = error.message;
            }
        });
        $('deleteChat').addEventListener('click', async () => {
            if (!state.activeConversation) return;
            $('contactError').textContent = '';
            try {
                const conversationId = state.activeConversation.id;
                stopTyping();
                await api('/api/conversations/' + conversationId, { method: 'DELETE', body: '{}' });
                state.activeConversation = null;
                $('contactPanel').classList.add('hidden');
                $('chatPane').classList.add('hidden');
                $('chatEmpty').classList.remove('hidden');
                $('sidebar').classList.remove('chat-open');
                $('chat').classList.remove('chat-open');
                await loadConversations();
            } catch (error) {
                $('contactError').textContent = error.message;
            }
        });
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
            $('profileNotice').textContent = '';
            try {
                await api('/api/me', {
                    method: 'PATCH',
                    body: JSON.stringify({
                        displayName: $('profileDisplayName').value,
                        email: $('profileEmail').value,
                        about: $('profileAbout').value,
                        avatarAssetId: state.profileAvatarId,
                        twoFactorEnabled: $('profile2fa').checked,
                        displayNameVisibility: $('displayNameVisibility').value,
                        notificationSoundAssetId: $('notificationSound').value || null,
                    }),
                });
                await loadMe();
                await loadNotificationSounds();
                $('profileNotice').textContent = 'Einstellungen wurden gespeichert.';
            } catch (error) {
                $('profileError').textContent = error.message;
            }
        });
        $('previewSound').addEventListener('click', () => playNotificationSound($('notificationSound').value));
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
        $('verifyTwoFactor').addEventListener('click', async () => {
            $('authError').textContent = '';
            try {
                const code = $('twoFactorCode').value.trim();
                if (!code || !state.pendingTwoFactorUserId) return;
                const verified = await api('/api/auth/verify-2fa', {
                    method: 'POST',
                    body: JSON.stringify({ userId: state.pendingTwoFactorUserId, code }),
                });
                state.token = verified.token;
                localStorage.setItem('justchat_token', state.token);
                await boot();
            } catch (error) {
                $('authError').textContent = error.message;
            }
        });
        $('cancelTwoFactor').addEventListener('click', () => {
            resetAuthPanels();
            $('authError').textContent = '';
        });
        $('forgotUsername').addEventListener('click', () => {
            resetAuthPanels();
            $('forgotUsernamePanel').classList.remove('hidden');
            $('forgotUsernameEmail').focus();
        });
        $('sendUsernameReminder').addEventListener('click', async () => {
            $('authError').textContent = '';
            try {
                await api('/api/auth/forgot-username', {
                    method: 'POST',
                    body: JSON.stringify({ email: $('forgotUsernameEmail').value.trim() }),
                });
                $('authNotice').textContent = 'Falls die E-Mail existiert, wurde der Benutzername versendet.';
            } catch (error) {
                $('authError').textContent = error.message;
            }
        });
        $('forgotPassword').addEventListener('click', () => {
            resetAuthPanels();
            $('forgotPasswordPanel').classList.remove('hidden');
            $('resetIdentifier').focus();
        });
        $('requestResetCode').addEventListener('click', async () => {
            $('authError').textContent = '';
            try {
                const identifier = $('resetIdentifier').value.trim();
                if (!identifier) return;
                await api('/api/auth/request-password-reset', {
                    method: 'POST',
                    body: JSON.stringify({ identifier }),
                });
                $('resetFields').classList.remove('hidden');
                $('authNotice').textContent = 'Falls das Konto existiert, wurde ein Code versendet.';
                $('resetCode').focus();
            } catch (error) {
                $('authError').textContent = error.message;
            }
        });
        $('submitPasswordReset').addEventListener('click', async () => {
            $('authError').textContent = '';
            try {
                await api('/api/auth/reset-password', {
                    method: 'POST',
                    body: JSON.stringify({
                        identifier: $('resetIdentifier').value.trim(),
                        code: $('resetCode').value.trim(),
                        password: $('resetPassword').value,
                        passwordRepeat: $('resetPasswordRepeat').value,
                    }),
                });
                resetAuthPanels();
                $('authNotice').textContent = 'Passwort wurde geändert. Du kannst dich jetzt anmelden.';
            } catch (error) {
                $('authError').textContent = error.message;
            }
        });
        $('logout').addEventListener('click', () => {
            localStorage.removeItem('justchat_token');
            if (state.eventSource) state.eventSource.close();
            location.reload();
        });
        $('back').addEventListener('click', () => {
            stopTyping();
            $('sidebar').classList.remove('chat-open');
            $('chat').classList.remove('chat-open');
        });
        $('messageInput').addEventListener('input', updateTyping);
        $('messageInput').addEventListener('blur', stopTyping);
        $('attachmentInput').addEventListener('change', (event) => chooseAttachment(event.target.files[0]));
        $('attachmentPreview').addEventListener('click', (event) => {
            if (!event.target.closest('#removeAttachment')) return;
            state.pendingAttachment = null;
            $('attachmentInput').value = '';
            renderPendingAttachment();
        });
        let dragDepth = 0;
        $('chat').addEventListener('dragenter', (event) => {
            if (!state.activeConversation || !event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            dragDepth += 1;
            $('chat').classList.add('drop-active');
        });
        $('chat').addEventListener('dragover', (event) => {
            if (!state.activeConversation || !event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        });
        $('chat').addEventListener('dragleave', () => {
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) $('chat').classList.remove('drop-active');
        });
        $('chat').addEventListener('drop', (event) => {
            event.preventDefault();
            dragDepth = 0;
            $('chat').classList.remove('drop-active');
            if (!state.activeConversation) return;
            chooseAttachment(event.dataTransfer.files[0]);
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
            $('composerError').textContent = '';
            try {
                const body = $('messageInput').value.trim();
                const attachment = await readSelectedAttachment();
                if ((!body && !attachment) || !state.activeConversation) return;
                $('messageInput').value = '';
                $('attachmentInput').value = '';
                state.pendingAttachment = null;
                renderPendingAttachment();
                stopTyping();
                await api('/api/conversations/' + state.activeConversation.id + '/messages', {
                    method: 'POST',
                    body: JSON.stringify({ body, attachment }),
                });
                await openConversation(state.activeConversation.id);
                await loadConversations();
            } catch (error) {
                $('composerError').textContent = error.message;
            }
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
                <p>Setze <code>DATABASE_URL</code>, damit Benutzer, Chats und Nachrichten gespeichert werden können.</p>
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
             where is_active = true
             order by created_at desc
        `);
        const sounds = await query(`
            select id, name, mime_type, size_bytes, is_active, created_at,
                'data:' || mime_type || ';base64,' || encode(data, 'base64') as data_url
             from notification_sound_assets
             where is_active = true
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
            sounds: sounds.rows,
            audit: audit.rows,
            imageUpdate: imageUpdateState,
        });
    } catch (error) {
        return next(error);
    }
});

app.post('/admin/api/image-update', requireAdminAuth, async (req, res, next) => {
    try {
        if (!IMAGE_UPDATE_WEBHOOK_URL) {
            return res.status(503).json({ error: 'IMAGE_UPDATE_WEBHOOK_URL ist nicht konfiguriert' });
        }
        if (imageUpdateState.status === 'running') {
            return res.status(409).json({ error: 'Eine Image-Update-Anfrage läuft bereits' });
        }

        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, 'image_update_requested', req.ip],
        );
        const request = dispatchImageUpdate();
        request.catch((error) => console.error('Image-Update fehlgeschlagen:', error));

        return res.status(202).json({
            ok: true,
            imageUpdate: imageUpdateState,
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

app.delete('/admin/api/avatar-assets/:id', requireAdminAuth, async (req, res, next) => {
    try {
        const avatarId = parseId(req.params.id);
        if (!avatarId) return res.status(400).json({ error: 'Ungültiges Profilbild' });

        const result = await query(
            'update avatar_assets set is_active = false where id = $1 and is_active = true returning id',
            [avatarId],
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Profilbild nicht gefunden' });
        await query('update users set avatar_asset_id = null where avatar_asset_id = $1', [avatarId]);
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, `avatar_delete_${avatarId}`, req.ip],
        );
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.post('/admin/api/notification-sounds', requireAdminAuth, async (req, res, next) => {
    try {
        const attachment = parseNotificationSoundAttachment(req.body.attachment);
        if (!attachment) return res.status(400).json({ error: 'Bitte eine Sounddatei hochladen' });
        const name = String(req.body.name || attachment.fileName).trim().slice(0, 80) || attachment.fileName;
        const result = await query(
            `insert into notification_sound_assets (name, mime_type, size_bytes, data)
             values ($1, $2, $3, $4)
             returning id, name, mime_type, size_bytes, is_active, created_at`,
            [name, attachment.mimeType, attachment.sizeBytes, attachment.data],
        );
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, 'notification_sound_upload', req.ip],
        );
        return res.status(201).json({ sound: result.rows[0] });
    } catch (error) {
        return next(error);
    }
});

app.delete('/admin/api/notification-sounds/:id', requireAdminAuth, async (req, res, next) => {
    try {
        const soundId = parseId(req.params.id);
        if (!soundId) return res.status(400).json({ error: 'Ungültiger Sound' });
        const result = await query(
            'update notification_sound_assets set is_active = false where id = $1 and is_active = true returning id',
            [soundId],
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Sound nicht gefunden' });
        await query('update users set notification_sound_asset_id = null where notification_sound_asset_id = $1', [soundId]);
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, `notification_sound_delete_${soundId}`, req.ip],
        );
        return res.json({ ok: true });
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
            purpose: 'Sicherheits- und Moderationsprüfung durch berechtigte Administratoren',
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
        const passwordRepeat = String(req.body.passwordRepeat || '');
        const displayName = cleanDisplayName(req.body.displayName, username);
        const avatarAssetId = parseId(req.body.avatarAssetId);
        const twoFactorEnabled = Boolean(req.body.twoFactorEnabled);
        const colors = ['#0f766e', '#2563eb', '#7c3aed', '#c2410c', '#be123c', '#047857'];
        const avatarColor = colors[Math.floor(Math.random() * colors.length)];

        if (!/^[a-z0-9_]{3,32}$/.test(username)) {
            return res.status(400).json({ error: 'Benutzername: 3-32 Zeichen, nur a-z, 0-9 und _' });
        }
        validateCleanName(username, 'Benutzername');
        validateCleanName(displayName, 'Anzeigename');
        if (password.length < 6) {
            return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
        }
        if (password !== passwordRepeat) {
            return res.status(400).json({ error: 'Passwörter stimmen nicht überein' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein' });
        }
        if (twoFactorEnabled && !getMailer()) {
            return res.status(400).json({ error: '2FA braucht vollständige SMTP-Konfiguration' });
        }

        const result = await query(
            `insert into users (username, display_name, email, avatar_asset_id, password_hash, avatar_color, two_factor_enabled)
             values ($1, $2, $3, $4, $5, $6, $7)
             returning id, username, display_name, email, avatar_asset_id, about, avatar_color, two_factor_enabled, display_name_visibility, created_at, last_seen_at`,
            [username, displayName, email, avatarAssetId, hashPassword(password), avatarColor, twoFactorEnabled],
        );
        const user = result.rows[0];

        sendMail({
            to: email,
            subject: 'Willkommen bei JustChat',
            text: `Hallo ${displayName},\n\n dein JustChat-Konto wurde erstellt.\n\nBenutzername: ${username}\n\nViele Grüße\nJustChat`,
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
            return res.status(400).json({ error: 'Ungültiger 2FA-Code' });
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

app.post('/api/auth/forgot-username', async (req, res, next) => {
    try {
        const email = cleanEmail(req.body.email);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein' });
        }

        const result = await query('select username, display_name, email from users where email = $1 order by created_at asc', [email]);
        if (result.rows.length && getMailer()) {
            const names = result.rows.map((user) => `@${user.username} (${user.display_name})`).join('\n');
            await sendMail({
                to: email,
                subject: 'Dein JustChat Benutzername',
                text: `Zu dieser E-Mail gehören folgende JustChat-Konten:\n\n${names}`,
            });
        }
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/auth/request-password-reset', async (req, res, next) => {
    try {
        const identifier = String(req.body.identifier || '').trim().toLowerCase();
        const result = await query('select * from users where username = $1 or email = $1 limit 1', [identifier]);
        const user = result.rows[0];
        if (user) await sendPasswordResetCode(user);
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/auth/reset-password', async (req, res, next) => {
    try {
        const identifier = String(req.body.identifier || '').trim().toLowerCase();
        const code = String(req.body.code || '').trim();
        const password = String(req.body.password || '');
        const passwordRepeat = String(req.body.passwordRepeat || '');

        if (password.length < 6) return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
        if (password !== passwordRepeat) return res.status(400).json({ error: 'Passwörter stimmen nicht überein' });

        const result = await query(
            `select prc.*, u.id as user_id
             from password_reset_codes prc
             join users u on u.id = prc.user_id
             where (u.username = $1 or u.email = $1)
                and prc.used_at is null
                and prc.expires_at > now()
             order by prc.created_at desc
             limit 1`,
            [identifier],
        );
        const reset = result.rows[0];
        if (!reset || !verifyPassword(code, reset.code_hash)) {
            return res.status(401).json({ error: 'Code ist falsch oder abgelaufen' });
        }

        await query('update users set password_hash = $1 where id = $2', [hashPassword(password), reset.user_id]);
        await query('update password_reset_codes set used_at = now() where id = $1', [reset.id]);
        return res.json({ ok: true });
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

app.get('/api/notification-sounds', requireAuth, async (req, res, next) => {
    try {
        const result = await query(
            `select id, name, mime_type, size_bytes,
                'data:' || mime_type || ';base64,' || encode(data, 'base64') as data_url
             from notification_sound_assets
             where is_active = true
             order by created_at desc
             limit 60`,
        );
        return res.json({ sounds: result.rows });
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
        const displayNameVisibility = req.body.displayNameVisibility === 'everyone' ? 'everyone' : 'contacts';
        const notificationSoundAssetId = parseId(req.body.notificationSoundAssetId);

        validateCleanName(displayName, 'Anzeigename');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein' });
        }
        if (twoFactorEnabled && !getMailer()) {
            return res.status(400).json({ error: '2FA braucht vollständige SMTP-Konfiguration' });
        }
        if (notificationSoundAssetId) {
            const sound = await query(
                'select id from notification_sound_assets where id = $1 and is_active = true',
                [notificationSoundAssetId],
            );
            if (!sound.rows[0]) return res.status(400).json({ error: 'Benachrichtigungston ist nicht verfügbar' });
        }

        const result = await query(
            `update users
             set display_name = $1, email = $2, about = $3, avatar_asset_id = $4, two_factor_enabled = $5,
                 display_name_visibility = $6, notification_sound_asset_id = $7
             where id = $8
             returning id`,
            [displayName, email, about, avatarAssetId, twoFactorEnabled, displayNameVisibility, notificationSoundAssetId, req.user.id],
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
             join conversations c
                on $1 in (c.user_one_id, c.user_two_id)
                and u.id in (c.user_one_id, c.user_two_id)
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

app.put('/api/users/:id/block', requireAuth, async (req, res, next) => {
    try {
        const otherUserId = parseId(req.params.id);
        if (!otherUserId || Number(otherUserId) === Number(req.user.id)) {
            return res.status(400).json({ error: 'Ungültiger Benutzer' });
        }
        const otherUser = await getUserById(otherUserId);
        if (!otherUser) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
        await query(
            `insert into user_blocks (blocker_id, blocked_user_id)
             values ($1, $2)
             on conflict (blocker_id, blocked_user_id) do nothing`,
            [req.user.id, otherUserId],
        );
        sendEvent(otherUserId, 'contact:changed', { userId: req.user.id });
        sendEvent(req.user.id, 'contact:changed', { userId: otherUserId });
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.delete('/api/users/:id/block', requireAuth, async (req, res, next) => {
    try {
        const otherUserId = parseId(req.params.id);
        if (!otherUserId || Number(otherUserId) === Number(req.user.id)) {
            return res.status(400).json({ error: 'Ungültiger Benutzer' });
        }
        await query(
            'delete from user_blocks where blocker_id = $1 and blocked_user_id = $2',
            [req.user.id, otherUserId],
        );
        sendEvent(otherUserId, 'contact:changed', { userId: req.user.id });
        sendEvent(req.user.id, 'contact:changed', { userId: otherUserId });
        return res.json({ ok: true });
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
                and case when c.user_one_id = $1 then not c.hidden_for_user_one else not c.hidden_for_user_two end
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
            return res.status(400).json({ error: 'Ungültiger Benutzer' });
        }

        const otherUser = await getUserById(otherUserId);
        if (!otherUser) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
        const blockStatus = await getBlockStatus(req.user.id, otherUserId);
        if (blockStatus.blocked_by_me || blockStatus.blocked_me) {
            return res.status(403).json({ error: 'Mit blockierten Personen kann kein neuer Chat gestartet werden' });
        }

        const [userOneId, userTwoId] = conversationPair(req.user.id, otherUserId);
        const result = await query(
            `insert into conversations (user_one_id, user_two_id)
             values ($1, $2)
             on conflict (user_one_id, user_two_id) do update set
                hidden_for_user_one = case when conversations.user_one_id = $3 then false else conversations.hidden_for_user_one end,
                hidden_for_user_two = case when conversations.user_two_id = $3 then false else conversations.hidden_for_user_two end
             returning id`,
            [userOneId, userTwoId, req.user.id],
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
        if (!/^[a-z0-9_]{3,32}$/.test(username)) {
            return res.status(400).json({ error: 'Bitte vollständigen @name eingeben' });
        }

        const result = await query('select id from users where username = $1 and id <> $2', [username, req.user.id]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
        const blockStatus = await getBlockStatus(req.user.id, user.id);
        if (blockStatus.blocked_by_me || blockStatus.blocked_me) {
            return res.status(403).json({ error: 'Mit blockierten Personen kann kein neuer Chat gestartet werden' });
        }

        const [userOneId, userTwoId] = conversationPair(req.user.id, user.id);
        const conversation = await query(
            `insert into conversations (user_one_id, user_two_id)
             values ($1, $2)
             on conflict (user_one_id, user_two_id) do update set
                hidden_for_user_one = case when conversations.user_one_id = $3 then false else conversations.hidden_for_user_one end,
                hidden_for_user_two = case when conversations.user_two_id = $3 then false else conversations.hidden_for_user_two end
             returning id`,
            [userOneId, userTwoId, req.user.id],
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
        const blockStatus = await getBlockStatus(req.user.id, conversation.other_user_id);
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
                about: otherUser.about,
                created_at: otherUser.created_at,
                last_seen_at: otherUser.last_seen_at,
                blocked_by_me: blockStatus.blocked_by_me,
                blocked_me: blockStatus.blocked_me,
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
        const attachment = parseAttachment(req.body.attachment);
        if (!body && !attachment) return res.status(400).json({ error: 'Nachricht ist leer' });

        const conversation = await getConversationForUser(req.params.id, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Chat nicht gefunden' });
        const blockStatus = await getBlockStatus(req.user.id, conversation.other_user_id);
        if (blockStatus.blocked_by_me || blockStatus.blocked_me) {
            return res.status(403).json({ error: 'In diesem Chat sind Nachrichten blockiert' });
        }
        await query(
            'update conversations set hidden_for_user_one = false, hidden_for_user_two = false where id = $1',
            [conversation.id],
        );

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

app.post('/api/conversations/:id/typing', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Chat nicht gefunden' });
        const blockStatus = await getBlockStatus(req.user.id, conversation.other_user_id);
        if (blockStatus.blocked_by_me || blockStatus.blocked_me) return res.json({ ok: true });
        sendEvent(conversation.other_user_id, 'typing', {
            conversationId: conversation.id,
            userId: req.user.id,
            typing: Boolean(req.body.typing),
        });
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.delete('/api/conversations/:id', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Chat nicht gefunden' });
        await query(
            `update conversations
             set hidden_for_user_one = case when user_one_id = $2 then true else hidden_for_user_one end,
                 hidden_for_user_two = case when user_two_id = $2 then true else hidden_for_user_two end
             where id = $1`,
            [conversation.id, req.user.id],
        );
        sendEvent(req.user.id, 'conversation:deleted', { conversationId: conversation.id });
        return res.json({ ok: true });
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
            console.log(`JustChat läuft auf Port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error('Datenbank konnte nicht initialisiert werden:', error);
        process.exit(1);
    });
