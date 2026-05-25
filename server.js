const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 50070;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_SESSION_COOKIE = 'justchat_admin_session';
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
const IMAGE_UPDATE_WEBHOOK_METHOD = (process.env.IMAGE_UPDATE_WEBHOOK_METHOD || 'POST').trim().toUpperCase();
const FORBIDDEN_WORDS = (process.env.FORBIDDEN_WORDS || 'admin,administrator,moderator,system,support,root')
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
const startedAt = new Date();

let pool;
let mailer;
const eventClients = new Map();
const CHAT_RETENTION_DAYS = 30;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_WIDTH = 1920;
const MAX_IMAGE_HEIGHT = 1080;
let imageUpdateState = {
    configured: Boolean(IMAGE_UPDATE_WEBHOOK_URL),
    status: IMAGE_UPDATE_WEBHOOK_URL ? 'idle' : 'not_configured',
    requestedAt: null,
    finishedAt: null,
    message: IMAGE_UPDATE_WEBHOOK_URL
        ? 'Bereit, ein neues Container-Image anzufordern.'
        : 'IMAGE_UPDATE_WEBHOOK_URL ist nicht konfiguriert.',
};

app.use(express.json({ limit: '30mb' }));

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function zipPathSegment(value) {
    return String(value || 'datei')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'datei';
}

function crc32(buffer) {
    let crc = -1;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ -1) >>> 0;
}

function createZipArchive(files) {
    const localParts = [];
    const directoryParts = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const file of files) {
        const name = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
        const checksum = crc32(data);
        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0x0800, 6);
        localHeader.writeUInt16LE(0, 8);
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(checksum, 14);
        localHeader.writeUInt32LE(data.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(name.length, 26);
        localParts.push(localHeader, name, data);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0x0800, 8);
        centralHeader.writeUInt16LE(0, 10);
        centralHeader.writeUInt16LE(dosTime, 12);
        centralHeader.writeUInt16LE(dosDate, 14);
        centralHeader.writeUInt32LE(checksum, 16);
        centralHeader.writeUInt32LE(data.length, 20);
        centralHeader.writeUInt32LE(data.length, 24);
        centralHeader.writeUInt16LE(name.length, 28);
        centralHeader.writeUInt32LE(offset, 42);
        directoryParts.push(centralHeader, name);
        offset += localHeader.length + name.length + data.length;
    }

    const directory = Buffer.concat(directoryParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, directory, end]);
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

function createAdminSessionToken() {
    const payload = base64Url(JSON.stringify({
        scope: 'admin',
        username: ADMIN_USER,
        exp: Date.now() + 1000 * 60 * 60 * 12,
    }));
    return `${payload}.${sign(payload)}`;
}

function readCookie(req, name) {
    const prefix = `${name}=`;
    const cookie = String(req.headers.cookie || '')
        .split(';')
        .map((item) => item.trim())
        .find((item) => item.startsWith(prefix));
    if (!cookie) return '';
    try {
        return decodeURIComponent(cookie.slice(prefix.length));
    } catch {
        return '';
    }
}

function hasAdminSession(req) {
    const session = verifyToken(readCookie(req, ADMIN_SESSION_COOKIE));
    return Boolean(session && session.scope === 'admin' && session.username === ADMIN_USER);
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

function renderEmailTemplate({ title, greeting, message, contentHtml = '', note = '' }) {
    return `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f1f5f9;font-family:Arial,sans-serif;color:#172033;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:30px 14px;">
        <tr><td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #d8e0ea;border-radius:14px;overflow:hidden;">
                <tr><td style="background:#0f766e;padding:22px 28px;color:#ffffff;font-size:24px;font-weight:700;">JustChat</td></tr>
                <tr><td style="padding:30px 28px 18px;">
                    <h1 style="margin:0 0 18px;font-size:24px;line-height:1.25;color:#172033;">${escapeHtml(title)}</h1>
                    <p style="margin:0 0 14px;font-size:16px;line-height:1.55;">${escapeHtml(greeting)}</p>
                    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475467;">${escapeHtml(message)}</p>
                    ${contentHtml}
                    ${note ? `<p style="margin:22px 0 0;font-size:13px;line-height:1.5;color:#667085;">${escapeHtml(note)}</p>` : ''}
                </td></tr>
                <tr><td style="border-top:1px solid #e5e7eb;padding:18px 28px;font-size:12px;line-height:1.5;color:#667085;">Diese Nachricht wurde automatisch von JustChat gesendet. Bitte antworte nicht auf diese E-Mail.</td></tr>
            </table>
        </td></tr>
    </table>
</body>
</html>`;
}

function emailCodeBlock(code) {
    return `<div style="margin:20px 0;padding:18px;border-radius:10px;background:#f0fdfa;border:1px solid #99f6e4;text-align:center;font-size:30px;font-weight:700;letter-spacing:8px;color:#0f766e;">${escapeHtml(code)}</div>`;
}

async function sendMail({ to, subject, text, html }) {
    const transport = getMailer();
    if (!transport) return false;

    await transport.sendMail({
        from: SMTP_FROM,
        to,
        subject,
        text,
        html,
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
        const updatePayload = {
            event: 'image_update_requested',
            app: process.env.APP_NAME || 'JustChat',
            imageTag: 'latest',
            requestedAt,
        };
        const requestOptions = {
            method: IMAGE_UPDATE_WEBHOOK_METHOD,
            headers,
            signal: AbortSignal.timeout(15000),
        };
        if (!['GET', 'HEAD'].includes(IMAGE_UPDATE_WEBHOOK_METHOD)) {
            requestOptions.body = JSON.stringify(updatePayload);
        }
        const response = await fetch(IMAGE_UPDATE_WEBHOOK_URL, requestOptions);
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

function parseAttachment(attachment, maxBytes = MAX_ATTACHMENT_BYTES) {
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
    if (!buffer.length || buffer.length > maxBytes) {
        const error = new Error(`Datei muss kleiner als ${Math.round(maxBytes / 1024 / 1024)} MB sein`);
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

async function optimizeImageAttachment(attachment) {
    const parsed = parseAttachment(attachment, MAX_IMAGE_INPUT_BYTES);
    if (!parsed) return null;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(parsed.mimeType)) {
        const error = new Error('Nur JPEG, PNG, WebP und GIF sind erlaubt');
        error.statusCode = 400;
        throw error;
    }
    try {
        const isGif = parsed.mimeType === 'image/gif';
        let image = sharp(parsed.data, isGif ? { animated: true } : undefined)
            .rotate()
            .resize({
                width: MAX_IMAGE_WIDTH,
                height: MAX_IMAGE_HEIGHT,
                fit: 'inside',
                withoutEnlargement: true,
            });
        let output;
        let mimeType;
        let fileName;
        if (isGif) {
            output = await image.gif({ effort: 8, colours: 192 }).toBuffer();
            mimeType = 'image/gif';
            fileName = parsed.fileName.replace(/\.[^.]+$/, '') + '.gif';
        } else {
            output = await image.webp({ quality: 80, effort: 6, smartSubsample: true }).toBuffer();
            mimeType = 'image/webp';
            fileName = parsed.fileName.replace(/\.[^.]+$/, '') + '.webp';
        }
        if (output.length > MAX_ATTACHMENT_BYTES) {
            const error = new Error('Komprimiertes Bild ist noch größer als 5 MB');
            error.statusCode = 400;
            throw error;
        }
        return {
            fileName,
            mimeType,
            sizeBytes: output.length,
            data: output,
        };
    } catch (error) {
        if (error.statusCode) throw error;
        const invalidImage = new Error('Bild konnte nicht verarbeitet werden');
        invalidImage.statusCode = 400;
        throw invalidImage;
    }
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

    const recentCode = await query(
        `select greatest(0, ceil(extract(epoch from (created_at + interval '60 seconds' - now()))))::int as retry_after_seconds
         from login_codes
         where user_id = $1 and used_at is null and created_at > now() - interval '60 seconds'
         order by created_at desc
         limit 1`,
        [user.id],
    );
    if (recentCode.rows[0]) {
        return {
            sent: false,
            retryAfterSeconds: recentCode.rows[0].retry_after_seconds,
        };
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
        html: renderEmailTemplate({
            title: 'Login bestätigen',
            greeting: `Hallo ${user.display_name || user.username},`,
            message: 'verwende den folgenden Sicherheitscode, um deine Anmeldung bei JustChat abzuschließen.',
            contentHtml: emailCodeBlock(code),
            note: 'Der Code ist 10 Minuten gültig. Falls du dich nicht anmelden wolltest, kannst du diese E-Mail ignorieren.',
        }),
    });
    return { sent: true, retryAfterSeconds: 60 };
}

async function sendEmailVerificationCode(user) {
    if (!user.email) {
        const error = new Error('Für die Registrierung ist eine E-Mail-Adresse erforderlich');
        error.statusCode = 400;
        throw error;
    }
    if (!getMailer()) {
        const error = new Error('Registrierung braucht vollständige SMTP-Konfiguration');
        error.statusCode = 503;
        throw error;
    }

    const recentCode = await query(
        `select greatest(0, ceil(extract(epoch from (created_at + interval '60 seconds' - now()))))::int as retry_after_seconds
         from email_verification_codes
         where user_id = $1 and used_at is null and created_at > now() - interval '60 seconds'
         order by created_at desc
         limit 1`,
        [user.id],
    );
    if (recentCode.rows[0]) {
        return {
            sent: false,
            retryAfterSeconds: recentCode.rows[0].retry_after_seconds,
        };
    }

    const code = createLoginCode();
    await query(
        `insert into email_verification_codes (user_id, code_hash, expires_at)
         values ($1, $2, now() + interval '15 minutes')`,
        [user.id, hashPassword(code)],
    );
    await sendMail({
        to: user.email,
        subject: 'Bestätige deine JustChat E-Mail-Adresse',
        text: `Dein Code zur Bestätigung deiner E-Mail-Adresse lautet: ${code}\n\nDer Code ist 15 Minuten gültig.`,
        html: renderEmailTemplate({
            title: 'E-Mail-Adresse bestätigen',
            greeting: `Hallo ${user.display_name || user.username},`,
            message: 'gib diesen Code in JustChat ein, um deine Registrierung abzuschließen.',
            contentHtml: emailCodeBlock(code),
            note: 'Der Code ist 15 Minuten gültig. Falls du kein Konto erstellt hast, ignoriere diese Nachricht.',
        }),
    });
    return { sent: true, retryAfterSeconds: 60 };
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
        html: renderEmailTemplate({
            title: 'Passwort zurücksetzen',
            greeting: `Hallo ${user.display_name || user.username},`,
            message: 'mit diesem Code kannst du ein neues Passwort für dein JustChat-Konto festlegen.',
            contentHtml: emailCodeBlock(code),
            note: 'Der Code ist 15 Minuten gültig. Falls du das nicht angefordert hast, ignoriere diese Nachricht.',
        }),
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
            username_history_visibility text not null default 'contacts',
            send_on_enter boolean not null default false,
            gif_playback text not null default 'none',
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
            owner_user_id bigint references users(id) on delete cascade,
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

        create table if not exists contact_requests (
            id bigserial primary key,
            sender_id bigint not null references users(id) on delete cascade,
            recipient_id bigint not null references users(id) on delete cascade,
            status text not null default 'pending',
            archived_by_sender boolean not null default false,
            archived_by_recipient boolean not null default false,
            created_at timestamptz not null default now(),
            responded_at timestamptz,
            unique(sender_id, recipient_id),
            check(sender_id <> recipient_id),
            check(status in ('pending', 'accepted', 'declined', 'blocked'))
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

        create table if not exists email_verification_codes (
            id bigserial primary key,
            user_id bigint not null references users(id) on delete cascade,
            code_hash text not null,
            expires_at timestamptz not null,
            used_at timestamptz,
            created_at timestamptz not null default now()
        );

        create table if not exists username_history (
            id bigserial primary key,
            user_id bigint not null references users(id) on delete cascade,
            username text not null,
            changed_at timestamptz not null default now()
        );

        alter table users add column if not exists email text;
        alter table users add column if not exists google_id text;
        alter table users add column if not exists email_verified_at timestamptz;
        alter table users add column if not exists email_verification_required boolean not null default false;
        alter table users add column if not exists avatar_asset_id bigint references avatar_assets(id);
        alter table users add column if not exists two_factor_enabled boolean not null default false;
        alter table users add column if not exists display_name_visibility text not null default 'contacts';
        alter table users add column if not exists username_history_visibility text not null default 'contacts';
        alter table users add column if not exists notification_sound_asset_id bigint references notification_sound_assets(id);
        alter table users add column if not exists send_on_enter boolean not null default false;
        alter table users add column if not exists gif_playback text not null default 'none';
        alter table avatar_assets add column if not exists owner_user_id bigint references users(id) on delete cascade;
        alter table conversations add column if not exists hidden_for_user_one boolean not null default false;
        alter table conversations add column if not exists hidden_for_user_two boolean not null default false;
        alter table conversations add column if not exists deleted_for_user_one_at timestamptz;
        alter table conversations add column if not exists deleted_for_user_two_at timestamptz;

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
        create index if not exists idx_contact_requests_sender
            on contact_requests(sender_id);
        create index if not exists idx_contact_requests_recipient
            on contact_requests(recipient_id);
        create index if not exists idx_username_history_user_changed
            on username_history(user_id, changed_at desc);
        create unique index if not exists idx_contact_requests_pair_unique
            on contact_requests(least(sender_id, recipient_id), greatest(sender_id, recipient_id));
    `);
}

async function purgeExpiredArchivedConversations() {
    const deleted = await query(
        `delete from conversations
         where hidden_for_user_one = true and hidden_for_user_two = true
            and deleted_for_user_one_at < now() - interval '${CHAT_RETENTION_DAYS} days'
            and deleted_for_user_two_at < now() - interval '${CHAT_RETENTION_DAYS} days'
         returning id`,
    );
    if (deleted.rowCount > 0) {
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            ['system', `archive_expiry_cleanup_${deleted.rowCount}`, null],
        );
    }
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
            u.two_factor_enabled, u.display_name_visibility, u.username_history_visibility, u.notification_sound_asset_id, u.send_on_enter, u.gif_playback,
            u.created_at, u.last_seen_at,
            u.id in (select early_user.id from users early_user where not early_user.email_verification_required or early_user.email_verified_at is not null order by early_user.created_at, early_user.id limit 10) as first_account,
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

async function getExistingConversation(userId, otherUserId) {
    const [userOneId, userTwoId] = conversationPair(userId, otherUserId);
    const result = await query(
        'select id from conversations where user_one_id = $1 and user_two_id = $2',
        [userOneId, userTwoId],
    );
    return result.rows[0] || null;
}

function personalAvatarLimit(createdAt) {
    const years = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    if (years >= 20) return 16;
    if (years >= 10) return 8;
    if (years >= 5) return 4;
    if (years >= 1) return 2;
    return 1;
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

    if (hasAdminSession(req)) return next();
    if (req.method === 'GET' && req.path === '/admin/export') return res.redirect('/admin');
    return res.status(401).json({ error: 'Admin login erforderlich' });
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
        .admin-login-shell { min-height: calc(100vh - 56px); display: grid; place-items: center; }
        .admin-login-card { width: min(420px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 28px; box-shadow: 0 18px 42px rgba(15, 23, 42, .1); }
        .admin-login-card h1 { margin-bottom: 8px; }
        .admin-login-card form { display: grid; gap: 14px; margin-top: 22px; }
        .admin-login-card button { width: 100%; margin-top: 4px; }
        .login-error { border-radius: 8px; padding: 10px 12px; background: #fef3f2; color: var(--error); font-size: 14px; }
        .hidden { display: none !important; }
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

function renderAdminLogin() {
    return renderAdminLayout(`
        <div class="admin-login-shell">
            <section class="admin-login-card">
                <h1>JustChat Admin</h1>
                <p class="muted">Melde dich an, um Verwaltung und Systemstatus zu öffnen.</p>
                <form id="adminLoginForm">
                    <div class="field">
                        <label for="adminUsername">Benutzername</label>
                        <input id="adminUsername" name="username" autocomplete="username" required>
                    </div>
                    <div class="field">
                        <label for="adminPassword">Passwort</label>
                        <input id="adminPassword" name="password" type="password" autocomplete="current-password" required>
                    </div>
                    <p id="adminLoginError" class="login-error hidden" role="alert"></p>
                    <button id="adminLoginButton" type="submit">Anmelden</button>
                </form>
                <p class="muted" style="margin-top: 18px;"><a href="/">Zur Web-App</a></p>
            </section>
        </div>
        <script>
            const form = document.getElementById('adminLoginForm');
            const error = document.getElementById('adminLoginError');
            const button = document.getElementById('adminLoginButton');
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                error.classList.add('hidden');
                button.disabled = true;
                try {
                    const response = await fetch('/admin/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            username: document.getElementById('adminUsername').value,
                            password: document.getElementById('adminPassword').value,
                        }),
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(data.error || 'Anmeldung fehlgeschlagen');
                    window.location.replace('/admin');
                } catch (submitError) {
                    error.textContent = submitError.message;
                    error.classList.remove('hidden');
                    button.disabled = false;
                }
            });
        </script>
    `);
}

function renderDashboard(data) {
    const dbStatus = statusClass(data.database.online);

    return renderAdminLayout(`
        <header>
            <div>
                <h1>${escapeHtml(data.appName)} Admin</h1>
                <p class="muted">Betrieb, Nutzerverwaltung, Avatar-Bibliothek und gesicherter Archiv-Export.</p>
            </div>
            <div class="toolbar">
                <button id="refreshButton" type="button">Aktualisieren</button>
                <a class="button secondary" href="/">Web-App</a>
                <button id="logoutButton" class="secondary" type="button">Abmelden</button>
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
                    <a id="downloadExport" class="button" href="/admin/export">ZIP-Archiv herunterladen</a>
                    <button id="downloadSelected" class="secondary" type="button">Auswahl als ZIP</button>
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

        <div class="notice">Hinweis: Von Nutzern entfernte Chats werden mindestens 30 Tage serverseitig aufbewahrt. ZIP-Archive enthalten private Chatdaten und Originaldateien; sie dürfen nur für einen berechtigten Zweck und mit passender rechtlicher Grundlage herausgegeben werden.</div>

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
                if (file.size > 20 * 1024 * 1024) throw new Error('Bild muss kleiner als 20 MB sein');

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
                if (response.status === 401) {
                    window.location.replace('/admin');
                    throw new Error('Admin-Sitzung abgelaufen');
                }
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
            el('logoutButton').addEventListener('click', async () => {
                await fetch('/admin/logout', { method: 'POST' });
                window.location.replace('/admin');
            });
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
        .loading-shell { min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: linear-gradient(135deg, #f7fbff 0%, #edf7f4 100%); }
        .loading-card { display: grid; justify-items: center; gap: 16px; color: var(--accent); }
        .loading-brand { font-size: 34px; font-weight: 800; color: var(--text); }
        .spinner { width: 42px; height: 42px; border-radius: 50%; border: 4px solid #cfe8e5; border-top-color: var(--accent); animation: spin .85s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .connection-banner { position: fixed; top: 0; left: 0; right: 0; z-index: 50; min-height: 28px; padding: calc(6px + env(safe-area-inset-top)) 12px 6px; text-align: center; font-size: 13px; font-weight: 700; color: #fff; transition: transform .18s ease, opacity .18s ease; }
        .connection-banner.offline { background: #b42318; }
        .connection-banner.online { background: #138a45; }
        .connection-banner.hidden { transform: translateY(-100%); opacity: 0; }
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
        .personal-avatar { display: grid; gap: 4px; }
        .personal-avatar-remove { padding: 4px; color: var(--danger); font-size: 12px; background: transparent; }
        .profile-upload { display: grid; gap: 8px; margin-top: 8px; }
        .crop-editor { display: grid; justify-items: center; gap: 10px; border-radius: 10px; padding: 12px; background: #f7fbfa; border: 1px solid var(--line); }
        .crop-editor canvas { width: 190px; height: 190px; border-radius: 50%; background: #e5e7eb; }
        .crop-editor input[type="range"] { width: min(280px, 100%); }
        .primary { background: var(--accent); color: #fff; border-radius: 8px; padding: 11px 14px; font-weight: 700; }
        .primary:hover { background: var(--accent-strong); }
        .ghost { background: transparent; color: var(--accent); font-weight: 700; padding: 8px; }
        .error { color: var(--danger); min-height: 20px; }
        .success { color: var(--accent); min-height: 20px; }
        .inline-panel { border: 1px solid var(--line); border-radius: 8px; background: #f7fbfa; padding: 12px; display: grid; gap: 10px; }
        .app { height: 100vh; height: 100dvh; display: grid; grid-template-columns: 360px 1fr; overflow: hidden; }
        .sidebar { background: var(--sidebar); border-right: 1px solid var(--line); display: grid; grid-template-rows: auto auto auto 1fr; min-width: 0; min-height: 0; }
        .topbar { padding: 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .me-box { display: grid; grid-template-columns: 50px 1fr; gap: 10px; align-items: center; min-width: 0; }
        .top-actions { display: flex; align-items: center; gap: 6px; }
        .icon-button { width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center; padding: 0; }
        .icon-button svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        .brand { min-width: 0; }
        .brand strong { display: block; font-size: 20px; overflow-wrap: anywhere; }
        .brand span { display: block; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
        .search { padding: 12px 16px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
        .search input { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; width: 100%; }
        .search-results { display: grid; gap: 4px; max-height: min(46vh, 440px); overflow: auto; }
        .search-group-title { padding: 8px 4px 4px; color: var(--muted); font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
        .message-result { width: 100%; display: grid; gap: 4px; padding: 10px; border-radius: 8px; background: #f7fbfa; text-align: left; }
        .message-result:hover { background: #e5f5f1; }
        .message-result-head { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; }
        .message-result-head strong { color: var(--text); }
        .message-result-preview { overflow: hidden; color: var(--text); font-size: 13px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
        .requests { border-bottom: 1px solid var(--line); padding: 10px 12px; display: grid; gap: 8px; max-height: 270px; overflow: auto; }
        .requests h3 { margin: 0; color: var(--muted); font-size: 12px; text-transform: uppercase; }
        .request-card { border: 1px solid var(--line); border-radius: 8px; padding: 9px; background: #fff; display: grid; gap: 7px; }
        .request-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
        .request-actions { display: flex; flex-wrap: wrap; gap: 6px; }
        .request-actions button { padding: 6px 8px; border-radius: 6px; font-size: 12px; }
        .request-status { color: var(--muted); font-size: 12px; }
        .list { overflow: auto; }
        .row { width: 100%; background: transparent; display: grid; grid-template-columns: 50px 1fr; gap: 12px; padding: 12px 16px; text-align: left; border-bottom: 1px solid #edf1f6; }
        .row:hover, .row.active { background: #eef8f6; }
        .avatar { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 800; object-fit: cover; }
        .avatar-frame { display: inline-grid; place-items: center; border-radius: 50%; padding: 3px; width: max-content; height: max-content; flex: none; }
        .avatar-frame.bronze { background: linear-gradient(135deg, #cd7f32, #8c4d18); }
        .avatar-frame.silver { background: linear-gradient(135deg, #f1f5f9, #94a3b8); }
        .avatar-frame.gold { background: linear-gradient(135deg, #fde68a, #d97706); }
        .avatar-frame.diamond { background: linear-gradient(120deg, #a5f3fc, #fff, #c4b5fd, #67e8f9); background-size: 240% 240%; animation: diamondSparkle 2.2s ease-in-out infinite; box-shadow: 0 0 12px rgba(103, 232, 249, .8); }
        .avatar-frame.none { padding: 0; }
        .avatar-frame.founder { position: relative; }
        .founder-badge { position: absolute; right: -8px; bottom: -5px; z-index: 1; border: 1px solid #fff; border-radius: 999px; padding: 2px 5px; color: #704300; background: linear-gradient(135deg, #fff2ab, #f3bc37 58%, #cf8512); box-shadow: 0 2px 6px rgba(151, 98, 15, .28); font-size: 9px; line-height: 1.1; font-weight: 900; letter-spacing: .02em; }
        .contact-frame { margin: 0 auto; }
        .contact-frame .founder-badge { right: -10px; bottom: 1px; padding: 4px 8px; font-size: 12px; }
        @keyframes diamondSparkle { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; box-shadow: 0 0 17px rgba(196, 181, 253, .95); } }
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
        .bubble.search-highlight { outline: 3px solid rgba(15, 118, 110, .35); box-shadow: 0 0 0 7px rgba(15, 118, 110, .09); animation: searchPulse 1.4s ease-out 1; }
        @keyframes searchPulse { from { box-shadow: 0 0 0 14px rgba(15, 118, 110, .18); } to { box-shadow: 0 0 0 7px rgba(15, 118, 110, .09); } }
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
        .attachment-info { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .attachment-image-preview { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; flex: none; }
        .attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .attachment-preview button { background: transparent; color: var(--danger); font-weight: 700; padding: 3px 6px; }
        .send-button { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; padding: 0; overflow: hidden; }
        .send-button svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; transform: translateX(1px); }
        .composer-error { grid-column: 1 / -1; margin: 0; min-height: 0; }
        .sensitive-warning { grid-column: 1 / -1; display: grid; gap: 10px; border: 1px solid #f6cd8b; border-radius: 12px; padding: 12px; background: #fff8eb; color: #7a4c04; }
        .sensitive-warning strong { display: block; color: #693d00; }
        .sensitive-warning p { margin: 0; font-size: 13px; line-height: 1.45; }
        .sensitive-actions { display: flex; flex-wrap: wrap; gap: 8px; }
        .sensitive-send { background: #946200; color: #fff; border-radius: 8px; padding: 9px 12px; font-weight: 700; }
        .sensitive-delete { background: #fff; color: var(--danger); border: 1px solid #f3c6c1; border-radius: 8px; padding: 9px 12px; font-weight: 700; }
        .chat-home { position: relative; isolation: isolate; grid-row: 1 / -1; overflow: hidden; background: linear-gradient(145deg, #f7fbff 0%, #eaf5f3 48%, #edf7f4 100%); }
        .chat-home::before, .chat-home::after { content: ''; position: absolute; z-index: -1; border-radius: 50%; filter: blur(2px); animation: homeFloat 14s ease-in-out infinite alternate; }
        .chat-home::before { width: min(50vw, 470px); height: min(50vw, 470px); top: -150px; right: -100px; background: radial-gradient(circle, rgba(15, 118, 110, .16), rgba(15, 118, 110, 0) 68%); }
        .chat-home::after { width: min(45vw, 400px); height: min(45vw, 400px); left: -100px; bottom: -130px; background: radial-gradient(circle, rgba(59, 130, 246, .12), rgba(59, 130, 246, 0) 70%); animation-delay: -5s; }
        .home-card { display: grid; justify-items: center; gap: 12px; width: min(430px, 100%); padding: 34px 30px; border: 1px solid rgba(255, 255, 255, .9); border-radius: 24px; background: rgba(255, 255, 255, .7); box-shadow: 0 20px 55px rgba(15, 23, 42, .06); backdrop-filter: blur(8px); }
        .home-mark { width: 72px; height: 72px; border-radius: 24px; display: grid; place-items: center; color: #fff; background: linear-gradient(145deg, var(--accent), #11a193); box-shadow: 0 12px 28px rgba(15, 118, 110, .25); }
        .home-mark svg { width: 36px; height: 36px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
        .home-card h2 { margin: 6px 0 0; color: var(--text); font-size: 27px; }
        .home-card p { max-width: 330px; margin: 0; color: var(--muted); font-size: 15px; line-height: 1.5; }
        .home-list-button { display: none; margin-top: 8px; }
        @keyframes homeFloat { to { transform: translate3d(22px, -18px, 0) scale(1.08); } }
        .chat.drop-active .messages { outline: 2px dashed var(--accent); outline-offset: -10px; background: #dff1ec; }
        .drop-hint { display: none; position: absolute; inset: 72px 18px 74px; place-items: center; pointer-events: none; z-index: 2; color: var(--accent); font-size: 18px; font-weight: 700; }
        .chat.drop-active .drop-hint { display: grid; }
        .settings-view { grid-row: 1 / -1; overflow: auto; padding: 24px; background: var(--bg); }
        .settings-card { width: min(700px, 100%); margin: 0 auto; background: #fff; border-radius: 8px; border: 1px solid var(--line); padding: 20px; }
        .settings-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 4px; }
        .settings-breadcrumb { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); font-size: 14px; }
        .settings-breadcrumb button { width: auto; padding: 4px 0; color: var(--accent); background: transparent; font-weight: 700; }
        .settings-breadcrumb strong { overflow: hidden; color: var(--text); font-size: 20px; text-overflow: ellipsis; white-space: nowrap; }
        .settings-breadcrumb.has-category strong { font-size: 16px; }
        .settings-overview { display: grid; gap: 10px; }
        .settings-category { width: 100%; padding: 14px 16px; border: 1px solid var(--line); border-radius: 10px; background: #fff; display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; }
        .settings-category:hover { border-color: #c7e6df; background: #eef8f6; }
        .settings-category-title { display: block; color: var(--text); font-weight: 700; }
        .settings-category-description { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; font-weight: 400; }
        .settings-category-arrow { color: var(--muted); font-size: 23px; }
        .settings-section { border: 1px solid var(--line); border-radius: 10px; padding: 16px; display: grid; gap: 12px; background: #fff; }
        .settings-section h3 { margin: 0; font-size: 17px; }
        .settings-actions { display: grid; gap: 10px; }
        .history-list { display: flex; flex-wrap: wrap; gap: 6px; min-height: 24px; }
        .history-item { font-size: 13px; border-radius: 999px; padding: 5px 9px; background: #eef8f6; color: var(--text); }
        .contact-card { width: min(560px, 100%); padding: 0; overflow: hidden; border-radius: 18px; box-shadow: 0 12px 32px rgba(15, 23, 42, .07); }
        .modal-head.contact-header { margin-bottom: 0; padding: 18px 20px 0; }
        .contact-hero { display: grid; justify-items: center; gap: 14px; padding: 16px 22px 22px; background: linear-gradient(180deg, #f2fbf8 0%, #fff 100%); border-bottom: 1px solid var(--line); }
        .contact-avatar { width: 96px; height: 96px; font-size: 32px; margin: 0 auto; }
        .contact-heading { text-align: center; display: grid; gap: 3px; }
        .contact-heading strong { font-size: 21px; }
        .contact-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 18px 20px 0; }
        .contact-detail { border: 1px solid var(--line); border-radius: 10px; padding: 11px 12px; background: #f8fcfb; min-height: 70px; }
        .contact-detail.wide { grid-column: 1 / -1; }
        .contact-detail label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
        .contact-about { color: var(--text); font-size: 15px; line-height: 1.45; }
        .contact-actions { display: grid; gap: 10px; margin: 18px 20px 20px; padding: 14px; border-radius: 12px; border: 1px solid #fee2df; background: #fff9f8; }
        .contact-actions .muted { margin: 0; }
        .contact-actions #contactBlockInfo:empty, .contact-actions #contactError:empty { display: none; }
        .contact-action-buttons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
        .danger-button { background: #fff1f0; color: var(--danger); border: 1px solid #f3c6c1; border-radius: 8px; padding: 11px 14px; font-weight: 700; }
        .blocked-list { display: grid; gap: 8px; }
        .blocked-item { border: 1px solid var(--line); border-radius: 8px; background: #f7fbfa; padding: 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .blocked-person { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .blocked-person .avatar { width: 38px; height: 38px; }
        .blocked-person strong, .blocked-person span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .modal { position: fixed; inset: 0; background: rgba(15, 23, 42, .42); display: grid; place-items: center; padding: 18px; z-index: 20; }
        .modal-card { width: min(560px, 100%); max-height: min(760px, 100%); overflow: auto; background: #fff; border-radius: 8px; border: 1px solid var(--line); padding: 20px; box-shadow: 0 24px 80px rgba(15, 23, 42, .22); }
        .modal-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
        .close-button { width: 38px; height: 38px; display: grid; place-items: center; font-size: 28px; line-height: 1; padding: 0; border-radius: 50%; }
        .segmented { display: flex; gap: 8px; flex-wrap: wrap; }
        .small { font-size: 13px; }
        .empty { height: 100%; display: grid; place-items: center; text-align: center; color: var(--muted); padding: 24px; }
        .hidden { display: none !important; }
        @media (prefers-reduced-motion: reduce) {
            .chat-home::before, .chat-home::after { animation: none; }
        }
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
            .contact-details { grid-template-columns: 1fr; }
            .contact-action-buttons { grid-template-columns: 1fr; }
            .home-card { padding: 28px 22px; border-radius: 20px; }
            .home-list-button { display: block; }
        }
    </style>
</head>
<body>
    <div id="connectionBanner" class="connection-banner hidden" role="status" aria-live="polite"></div>
    <div id="loading" class="loading-shell">
        <div class="loading-card" role="status" aria-label="JustChat wird geladen">
            <div class="loading-brand">JustChat</div>
            <div class="spinner" aria-hidden="true"></div>
            <span id="loadingStatus" class="muted">Chats werden geladen...</span>
        </div>
    </div>

    <div id="auth" class="auth-shell hidden">
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
                <p class="muted">Wähle ein Standardbild aus. Ein eigenes Profilbild kannst du später in den Einstellungen hochladen.</p>
            </div>
            <div id="authPrimaryFields" class="stack">
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
                <button id="authSubmit" class="primary" type="submit">Anmelden</button>
                <a id="googleLogin" class="primary hidden" style="text-align:center;text-decoration:none;" href="/auth/google">Mit Google fortfahren</a>
                <button id="toggleAuth" class="ghost" type="button">Neues Konto erstellen</button>
                <div class="segmented">
                    <button id="forgotUsername" class="ghost" type="button">Benutzername vergessen</button>
                    <button id="forgotPassword" class="ghost" type="button">Passwort vergessen</button>
                </div>
            </div>
            <div id="authError" class="error"></div>
            <div id="emailVerificationPanel" class="inline-panel hidden">
                <strong>E-Mail bestätigen</strong>
                <p class="muted small">Wir haben dir einen Code per E-Mail gesendet. Gib ihn hier ein, um dein Konto zu aktivieren.</p>
                <div class="field">
                    <label for="emailVerificationCode">Bestätigungscode</label>
                    <input id="emailVerificationCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
                </div>
                <button id="verifyEmail" class="primary" type="button">E-Mail bestätigen</button>
                <button id="resendEmailVerification" class="ghost" type="button" disabled>Code erneut senden (60 s)</button>
                <button id="cancelEmailVerification" class="ghost close-button" type="button" aria-label="Bestätigung schließen" title="Schließen">&times;</button>
            </div>
            <div id="twoFactorPanel" class="inline-panel hidden">
                <strong>2FA-Bestätigung</strong>
                <p class="muted small">Gib den Code aus deiner E-Mail direkt hier ein.</p>
                <div class="field">
                    <label for="twoFactorCode">Code</label>
                    <input id="twoFactorCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
                </div>
                <button id="verifyTwoFactor" class="primary" type="button">Code bestätigen</button>
                <button id="resendTwoFactor" class="ghost" type="button" disabled>Code erneut senden (60 s)</button>
                <button id="cancelTwoFactor" class="ghost close-button" type="button" aria-label="2FA schließen" title="Schließen">&times;</button>
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
                    <div id="meAvatarSlot"><div id="meAvatar" class="avatar">J</div></div>
                    <div class="brand">
                        <strong id="meName">JustChat</strong>
                        <span id="meUsername"></span>
                    </div>
                </div>
                <div class="top-actions">
                    <button id="settingsButton" class="ghost icon-button" type="button" aria-label="Einstellungen" title="Einstellungen">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"></path><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.3a2 2 0 1 1-4 0V21a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.1 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.6a2 2 0 1 1 0-4H3a1.7 1.7 0 0 0 1.6-1.1A1.7 1.7 0 0 0 4.2 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6v-.3a2 2 0 1 1 4 0V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.3a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6.9z"></path></svg>
                    </button>
                    <button id="addPerson" class="primary icon-button" type="button" aria-label="Kontakt hinzufügen" title="Kontakt hinzufügen">+</button>
                </div>
            </div>
            <div class="search">
                <input id="search" placeholder="Kontakte oder Nachrichten suchen">
                <div id="searchResults" class="search-results"></div>
            </div>
            <div id="requestsPanel" class="requests hidden">
                <h3>Kontaktanfragen</h3>
                <div id="requestList"></div>
            </div>
            <div id="conversationList" class="list"></div>
        </aside>
        <section id="chat" class="chat">
            <div id="chatEmpty" class="empty chat-home">
                <div class="home-card">
                    <div class="home-mark">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.8 7.8 0 0 1-8 7.5 8.8 8.8 0 0 1-3.2-.6L4 20l1.5-4a7.2 7.2 0 0 1-1.5-4.5A7.8 7.8 0 0 1 12 4a7.8 7.8 0 0 1 8 7.5z"></path><path d="M8.5 11.5h.1M12 11.5h.1M15.5 11.5h.1"></path></svg>
                    </div>
                    <h2>JustChat</h2>
                    <p>Wähle einen Chat aus und bleibe mit deinen Kontakten verbunden.</p>
                    <button id="homeChatsButton" class="primary home-list-button" type="button">Chats anzeigen</button>
                </div>
            </div>
            <div id="chatPane" class="hidden" style="display: contents;">
                <div class="chat-head">
                    <button id="back" class="ghost close-button" type="button" aria-label="Chat schließen" title="Schließen">&times;</button>
                    <button id="chatProfileButton" class="chat-profile" type="button" aria-label="Profil anzeigen">
                        <div id="chatAvatarSlot"><div id="chatAvatar" class="avatar">?</div></div>
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
                    <div id="sensitiveMessageWarning" class="sensitive-warning hidden" role="alert">
                        <div>
                            <strong>Achtung: Bankdaten erkannt</strong>
                            <p>Diese Nachricht enthält vermutlich eine IBAN. Vertraust du diesem Kontakt und möchtest du die Nachricht wirklich senden?</p>
                        </div>
                        <div class="sensitive-actions">
                            <button id="sendSensitiveMessage" class="sensitive-send" type="button">Trotzdem senden</button>
                            <button id="discardSensitiveMessage" class="sensitive-delete" type="button">Abbrechen / Nachricht löschen</button>
                        </div>
                    </div>
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
                    <div class="settings-header">
                        <nav id="settingsBreadcrumb" class="settings-breadcrumb" aria-label="Einstellungspfad">
                            <strong>Einstellungen</strong>
                        </nav>
                        <button id="closeAccount" class="ghost close-button" type="button" aria-label="Einstellungen schließen" title="Schließen">&times;</button>
                    </div>
                    <div id="settingsOverview" class="settings-overview">
                        <button class="settings-category" type="button" data-settings-category="profile">
                            <span>
                                <span class="settings-category-title">Profil</span>
                                <span class="settings-category-description">Benutzername, Info und Profilbild</span>
                            </span>
                            <span class="settings-category-arrow" aria-hidden="true">&rsaquo;</span>
                        </button>
                        <button class="settings-category" type="button" data-settings-category="privacy">
                            <span>
                                <span class="settings-category-title">Datenschutz</span>
                                <span class="settings-category-description">Sichtbarkeit und blockierte Kontakte</span>
                            </span>
                            <span class="settings-category-arrow" aria-hidden="true">&rsaquo;</span>
                        </button>
                        <button class="settings-category" type="button" data-settings-category="chat">
                            <span>
                                <span class="settings-category-title">Benachrichtigungen &amp; Chat</span>
                                <span class="settings-category-description">Ton, GIFs und Enter-Verhalten</span>
                            </span>
                            <span class="settings-category-arrow" aria-hidden="true">&rsaquo;</span>
                        </button>
                        <button class="settings-category" type="button" data-settings-category="security">
                            <span>
                                <span class="settings-category-title">Sicherheit</span>
                                <span class="settings-category-description">E-Mail und Zwei-Faktor-Anmeldung</span>
                            </span>
                            <span class="settings-category-arrow" aria-hidden="true">&rsaquo;</span>
                        </button>
                    </div>
                    <section class="settings-section hidden" data-settings-panel="profile">
                        <h3>Profil</h3>
                        <div class="field">
                            <label for="profileUsername">Benutzername</label>
                            <input id="profileUsername" maxlength="32">
                            <p id="usernameTokens" class="muted small"></p>
                        </div>
                        <div class="field">
                            <label>Frühere Benutzernamen</label>
                            <div id="ownUsernameHistory" class="history-list"><span class="muted small">Keine früheren Namen.</span></div>
                        </div>
                        <div class="field">
                            <label for="profileDisplayName">Anzeigename</label>
                            <input id="profileDisplayName" maxlength="60">
                        </div>
                        <div class="field">
                            <label for="profileAbout">Info</label>
                            <textarea id="profileAbout" maxlength="180"></textarea>
                        </div>
                        <div class="field">
                            <label>Registriert seit</label>
                            <div id="profileRegisteredSince" class="contact-about"></div>
                        </div>
                        <div class="field">
                            <label>Profilbild</label>
                            <div id="profileAvatarPicker" class="avatar-picker"></div>
                            <div class="profile-upload">
                                <input id="profileAvatarUpload" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
                                <div id="avatarCropEditor" class="crop-editor hidden">
                                    <canvas id="avatarCropCanvas" width="320" height="320"></canvas>
                                    <label class="small" for="avatarZoom">Ausschnitt / Zoom</label>
                                    <input id="avatarZoom" type="range" min="100" max="300" value="100">
                                    <label class="small" for="avatarPositionX">Horizontal verschieben</label>
                                    <input id="avatarPositionX" type="range" min="-100" max="100" value="0">
                                    <label class="small" for="avatarPositionY">Vertikal verschieben</label>
                                    <input id="avatarPositionY" type="range" min="-100" max="100" value="0">
                                    <label id="gifStillOption" class="segmented hidden">
                                        <input id="gifAsStill" type="checkbox" checked style="width:auto;">
                                        <span>GIF als Standbild setzen</span>
                                    </label>
                                </div>
                                <button id="uploadProfileAvatar" class="ghost" type="button">Eigenes Profilbild hochladen</button>
                                <p id="avatarUploadLimit" class="muted small">JPEG, PNG, WebP oder GIF, maximal 20 MB. Bilder werden automatisch komprimiert.</p>
                                <p class="muted small">Kontingent: Start 1 Bild, nach 1 Jahr 2, nach 5 Jahren 4, nach 10 Jahren 8 und nach 20 Jahren 16.</p>
                            </div>
                        </div>
                    </section>
                    <section class="settings-section hidden" data-settings-panel="privacy">
                        <h3>Datenschutz</h3>
                        <div class="field">
                            <label for="displayNameVisibility">Anzeigename anzeigen</label>
                            <select id="displayNameVisibility">
                                <option value="contacts">Nur Kontakten</option>
                                <option value="everyone">Allen</option>
                            </select>
                        </div>
                        <div class="field">
                            <label for="usernameHistoryVisibility">Frühere Benutzernamen anzeigen</label>
                            <select id="usernameHistoryVisibility">
                                <option value="contacts">Nur Kontakten</option>
                                <option value="everyone">Allen</option>
                            </select>
                        </div>
                        <div class="field">
                            <label>Blockierte Kontakte</label>
                            <div id="blockedList" class="blocked-list">
                                <span class="muted small">Keine blockierten Kontakte.</span>
                            </div>
                        </div>
                    </section>
                    <section class="settings-section hidden" data-settings-panel="chat">
                        <h3>Benachrichtigungen & Chat</h3>
                        <div class="field">
                            <label for="notificationSound">Benachrichtigungston</label>
                            <select id="notificationSound">
                                <option value="">Kein Ton</option>
                            </select>
                            <button id="previewSound" class="ghost" type="button">Ton anhören</button>
                        </div>
                        <div class="field">
                            <label for="gifPlayback">GIFs anzeigen</label>
                            <select id="gifPlayback">
                                <option value="none">Keine GIFs (Standbild)</option>
                                <option value="all">Alle GIFs abspielen</option>
                            </select>
                        </div>
                        <label class="segmented">
                            <input id="sendOnEnter" type="checkbox" style="width:auto;">
                            <span>Nachricht mit Enter senden (Shift+Enter für neue Zeile)</span>
                        </label>
                    </section>
                    <section class="settings-section hidden" data-settings-panel="security">
                        <h3>Sicherheit</h3>
                        <div class="field">
                            <label for="profileEmail">E-Mail</label>
                            <input id="profileEmail" type="email" maxlength="160">
                        </div>
                        <label class="segmented">
                            <input id="profile2fa" type="checkbox" style="width:auto;">
                            <span>2FA per E-Mail-Code aktivieren</span>
                        </label>
                        <p class="muted small">Bei aktivierter 2FA wird beim Login ein Code an deine E-Mail gesendet.</p>
                    </section>
                    <div id="profileError" class="error"></div>
                    <div id="profileNotice" class="success"></div>
                    <div id="settingsActions" class="settings-actions hidden">
                        <button class="primary" type="submit">Änderungen speichern</button>
                    </div>
                    <button id="logout" class="ghost" type="button">Logout</button>
                </form>
            </div>
            <div id="contactPanel" class="settings-view hidden">
                <div class="settings-card contact-card">
                    <div class="modal-head contact-header">
                        <h2>Kontaktprofil</h2>
                        <button id="closeContact" class="ghost close-button" type="button" aria-label="Profil schließen" title="Schließen">&times;</button>
                    </div>
                    <div class="contact-hero">
                        <div id="contactAvatarSlot"><div id="contactAvatar" class="avatar contact-avatar">?</div></div>
                        <div class="contact-heading">
                            <strong id="contactName"></strong>
                            <span id="contactUsername" class="muted"></span>
                        </div>
                    </div>
                    <div class="contact-details">
                        <div class="contact-detail wide">
                            <label>Info</label>
                            <div id="contactAbout" class="contact-about"></div>
                        </div>
                        <div class="contact-detail">
                            <label>Zuletzt aktiv</label>
                            <div id="contactLastSeen" class="contact-about"></div>
                        </div>
                        <div class="contact-detail">
                            <label>Registriert seit</label>
                            <div id="contactRegisteredSince" class="contact-about"></div>
                        </div>
                        <div class="contact-detail wide">
                            <label>Frühere Benutzernamen</label>
                            <div id="contactUsernameHistory" class="history-list"><span class="muted small">Keine sichtbaren früheren Namen.</span></div>
                        </div>
                    </div>
                    <div class="contact-actions">
                        <p id="contactBlockInfo" class="muted small"></p>
                        <div id="contactError" class="error"></div>
                        <div class="contact-action-buttons">
                            <button id="toggleBlock" class="danger-button" type="button">Person blockieren</button>
                            <button id="deleteChat" class="danger-button" type="button">Chat bei mir löschen</button>
                        </div>
                        <p class="muted small">Gelöschte Chats werden serverseitig für mindestens 30 Tage gesichert.</p>
                    </div>
                </div>
            </div>
        </section>
    </div>

    <div id="addModal" class="modal hidden">
        <form id="addForm" class="modal-card stack">
            <div class="modal-head">
                <h2>Kontaktanfrage senden</h2>
                <button id="closeAdd" class="ghost" type="button">Schließen</button>
            </div>
            <div class="field">
                <label for="addUsername">@name</label>
                <input id="addUsername" placeholder="@benutzername" maxlength="41">
            </div>
            <div id="addError" class="error"></div>
            <button class="primary" type="submit">Anfrage senden</button>
        </form>
    </div>

    <script>
        const state = {
            token: localStorage.getItem('justchat_token'),
            me: null,
            conversations: [],
            contactRequests: [],
            activeConversation: null,
            eventSource: null,
            registerMode: false,
            pendingTwoFactorUserId: null,
            pendingEmailVerificationUserId: null,
            avatars: [],
            selectedAvatarId: null,
            profileAvatarId: null,
            pendingAttachment: null,
            pendingAttachmentPreviewUrl: null,
            sensitiveMessageApproved: false,
            searchMessageId: null,
            searchRequestId: 0,
            sounds: [],
            blockedUsers: [],
            typingSent: false,
            typingLastSentAt: 0,
            typingStopTimer: null,
            remoteTyping: false,
            remoteTypingTimer: null,
            serverOnline: true,
            connectionNoticeTimer: null,
            bootRetryTimer: null,
            twoFactorResendTimer: null,
            twoFactorResendUntil: 0,
            emailVerificationResendTimer: null,
            emailVerificationResendUntil: 0,
            profileAvatarImage: null,
            profileAvatarFile: null,
        };

        const $ = (id) => document.getElementById(id);

        function api(path, options = {}) {
            const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
            if (state.token) headers.Authorization = 'Bearer ' + state.token;
            const controller = new AbortController();
            const requestTimeout = setTimeout(() => controller.abort(), 12000);
            return fetch(path, { ...options, headers, signal: controller.signal })
                .then(async (res) => {
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) {
                        const error = new Error(data.error || 'Anfrage fehlgeschlagen');
                        error.status = res.status;
                        error.data = data;
                        throw error;
                    }
                    return data;
                })
                .catch((error) => {
                    if (error.name === 'AbortError') {
                        throw new Error('Server antwortet nicht');
                    }
                    throw error;
                })
                .finally(() => clearTimeout(requestTimeout));
        }

        function initials(name) {
            return String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
        }

        const ibanLengths = {
            AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29,
            BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29,
            ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
            HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20,
            LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19,
            MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29,
            RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28,
            TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
        };

        function containsIban(value) {
            const text = String(value || '').toUpperCase();
            const compact = text.replace(/[^A-Z0-9]/g, '');
            const candidates = [
                ...text.matchAll(/[A-Z]{2}\\d{2}(?:[\\s-]?[A-Z0-9]){10,30}/g),
                ...compact.matchAll(/[A-Z]{2}\\d{2}[A-Z0-9]{11,30}/g),
            ];
            return candidates.some((match) => {
                const iban = match[0].replace(/[^A-Z0-9]/g, '');
                if (!ibanLengths[iban.slice(0, 2)] || iban.length !== ibanLengths[iban.slice(0, 2)]) return false;
                const rotated = iban.slice(4) + iban.slice(0, 4);
                const numeric = rotated.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
                let remainder = 0;
                for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
                return remainder === 1;
            });
        }

        function hideSensitiveMessageWarning() {
            $('sensitiveMessageWarning').classList.add('hidden');
            state.sensitiveMessageApproved = false;
        }

        function loyaltyTier(entity) {
            const date = entity && (entity.member_since || entity.created_at);
            if (!date) return 'none';
            const years = (Date.now() - new Date(date).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
            if (years >= 20) return 'diamond';
            if (years >= 10) return 'gold';
            if (years >= 5) return 'silver';
            if (years >= 1) return 'bronze';
            return 'none';
        }

        function avatarMarkup(entity, id = '', extraClass = '') {
            const idAttribute = id ? ' id="' + id + '"' : '';
            const classes = 'avatar' + (extraClass ? ' ' + extraClass : '');
            const inner = entity.avatar_url
                ? '<img' + idAttribute + ' class="' + classes + '" src="' + entity.avatar_url + '" alt="">'
                : '<div' + idAttribute + ' class="' + classes + '" style="background:' + entity.avatar_color + '">' + initials(entity.display_name) + '</div>';
            const frameClass = extraClass.includes('contact-avatar') ? ' contact-frame' : '';
            const founderClass = entity.first_account ? ' founder' : '';
            const founderBadge = entity.first_account ? '<span class="founder-badge" title="Einer der ersten 10 Accounts">1st</span>' : '';
            return '<span class="avatar-frame ' + loyaltyTier(entity) + frameClass + founderClass + '">' + inner + founderBadge + '</span>';
        }

        function membershipText(value) {
            if (!value) return 'Nicht verfügbar';
            return new Date(value).toLocaleDateString([], { dateStyle: 'long' });
        }

        function gifAnimationEnabled() {
            return Boolean(state.me && state.me.gif_playback === 'all');
        }

        function applyGifPreference(root = $('messenger')) {
            if (!root) return;
            root.querySelectorAll('img').forEach((image) => {
                const source = image.dataset.gifSource || image.getAttribute('src') || '';
                const isGif = image.dataset.isGif === 'true' || /^data:image\\/gif/i.test(source);
                if (!isGif) return;
                if (!image.dataset.gifSource) image.dataset.gifSource = source;
                if (gifAnimationEnabled()) {
                    if (image.dataset.gifFrozen === 'true') image.src = image.dataset.gifSource;
                    delete image.dataset.gifFrozen;
                    return;
                }
                if (image.dataset.gifFrozen === 'true') return;
                const freeze = () => {
                    if (gifAnimationEnabled() || image.dataset.gifFrozen === 'true') return;
                    const canvas = document.createElement('canvas');
                    canvas.width = image.naturalWidth || image.width || 1;
                    canvas.height = image.naturalHeight || image.height || 1;
                    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                    image.dataset.gifFrozen = 'true';
                    image.src = canvas.toDataURL('image/png');
                };
                if (image.complete && image.naturalWidth) freeze();
                else image.addEventListener('load', freeze, { once: true });
            });
        }

        if (window.MutationObserver && $('messenger')) {
            const gifImageObserver = new MutationObserver(() => applyGifPreference());
            gifImageObserver.observe($('messenger'), { childList: true, subtree: true });
        }

        function showAuth() {
            $('loading').classList.add('hidden');
            $('auth').classList.remove('hidden');
            $('messenger').classList.add('hidden');
            fetch('/api/config').then((res) => res.json()).then((config) => {
                $('googleLogin').classList.toggle('hidden', !config.googleEnabled);
            }).catch(() => {});
        }

        function showApp() {
            $('loading').classList.add('hidden');
            $('auth').classList.add('hidden');
            $('messenger').classList.remove('hidden');
        }

        function showConnectionStatus(online) {
            if (online === state.serverOnline) return;
            state.serverOnline = online;
            const banner = $('connectionBanner');
            banner.textContent = online ? 'Wieder online' : 'Offline';
            banner.className = 'connection-banner ' + (online ? 'online' : 'offline');
            if (state.connectionNoticeTimer) clearTimeout(state.connectionNoticeTimer);
            state.connectionNoticeTimer = setTimeout(() => banner.classList.add('hidden'), 5000);
        }

        function resetAuthPanels() {
            state.pendingTwoFactorUserId = null;
            state.pendingEmailVerificationUserId = null;
            state.twoFactorResendUntil = 0;
            if (state.twoFactorResendTimer) clearInterval(state.twoFactorResendTimer);
            state.twoFactorResendTimer = null;
            state.emailVerificationResendUntil = 0;
            if (state.emailVerificationResendTimer) clearInterval(state.emailVerificationResendTimer);
            state.emailVerificationResendTimer = null;
            $('authPrimaryFields').classList.remove('hidden');
            $('emailVerificationPanel').classList.add('hidden');
            $('twoFactorPanel').classList.add('hidden');
            $('forgotUsernamePanel').classList.add('hidden');
            $('forgotPasswordPanel').classList.add('hidden');
            $('resetFields').classList.add('hidden');
            $('emailVerificationCode').value = '';
            $('twoFactorCode').value = '';
            $('authNotice').textContent = '';
            $('authHint').textContent = state.registerMode
                ? 'Erstelle dein JustChat-Konto.'
                : 'Melde dich an, um deine Chats zu sehen.';
        }

        function startTwoFactorResendCountdown(seconds) {
            if (state.twoFactorResendTimer) clearInterval(state.twoFactorResendTimer);
            state.twoFactorResendUntil = Date.now() + Math.max(0, Number(seconds) || 60) * 1000;
            const button = $('resendTwoFactor');
            const updateButton = () => {
                const remaining = Math.max(0, Math.ceil((state.twoFactorResendUntil - Date.now()) / 1000));
                button.disabled = remaining > 0;
                button.textContent = remaining > 0 ? 'Code erneut senden (' + remaining + ' s)' : 'Code erneut senden';
                if (!remaining && state.twoFactorResendTimer) {
                    clearInterval(state.twoFactorResendTimer);
                    state.twoFactorResendTimer = null;
                }
            };
            updateButton();
            state.twoFactorResendTimer = setInterval(updateButton, 1000);
        }

        function beginTwoFactor(data) {
            state.pendingTwoFactorUserId = data.userId;
            $('authPrimaryFields').classList.add('hidden');
            $('twoFactorPanel').classList.remove('hidden');
            $('authHint').textContent = 'Bestätige deine Anmeldung mit deinem E-Mail-Code.';
            $('authNotice').textContent = data.codeSent === false
                ? 'Ein Login-Code wurde bereits gesendet. Prüfe bitte dein Postfach.'
                : 'Ein Login-Code wurde an deine E-Mail gesendet.';
            startTwoFactorResendCountdown(data.resendAfterSeconds || 60);
            $('twoFactorCode').focus();
        }

        function startEmailVerificationResendCountdown(seconds) {
            if (state.emailVerificationResendTimer) clearInterval(state.emailVerificationResendTimer);
            state.emailVerificationResendUntil = Date.now() + Math.max(0, Number(seconds) || 60) * 1000;
            const button = $('resendEmailVerification');
            const updateButton = () => {
                const remaining = Math.max(0, Math.ceil((state.emailVerificationResendUntil - Date.now()) / 1000));
                button.disabled = remaining > 0;
                button.textContent = remaining > 0 ? 'Code erneut senden (' + remaining + ' s)' : 'Code erneut senden';
                if (!remaining && state.emailVerificationResendTimer) {
                    clearInterval(state.emailVerificationResendTimer);
                    state.emailVerificationResendTimer = null;
                }
            };
            updateButton();
            state.emailVerificationResendTimer = setInterval(updateButton, 1000);
        }

        function beginEmailVerification(data) {
            state.pendingEmailVerificationUserId = data.userId;
            $('authPrimaryFields').classList.add('hidden');
            $('emailVerificationPanel').classList.remove('hidden');
            $('authHint').textContent = 'Bestätige deine E-Mail-Adresse, um dein Konto zu aktivieren.';
            $('authNotice').textContent = data.codeSent === false
                ? 'Ein Bestätigungscode wurde bereits gesendet. Prüfe bitte dein Postfach.'
                : 'Ein Bestätigungscode wurde an deine E-Mail gesendet.';
            startEmailVerificationResendCountdown(data.resendAfterSeconds || 60);
            $('emailVerificationCode').focus();
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
                '<div class="' + (avatar.mine ? 'personal-avatar' : '') + '">' +
                '<button type="button" class="avatar-option ' + (Number(state.profileAvatarId) === Number(avatar.id) ? 'selected' : '') + '" data-profile-avatar="' + avatar.id + '">' +
                '<img src="' + avatar.data_url + '" alt="' + escapeText(avatar.name) + '"></button>' +
                (avatar.mine ? '<button type="button" class="personal-avatar-remove" data-delete-profile-avatar="' + avatar.id + '">Löschen</button>' : '') +
                '</div>'
            ).join('');
        }

        async function loadProfileAvatars() {
            const data = await api('/api/me/avatars');
            state.avatars = data.avatars || [];
            $('avatarUploadLimit').textContent = 'Eigene Bilder: ' + data.ownCount + ' / ' + data.uploadLimit +
                '. JPEG, PNG, WebP oder GIF, maximal 20 MB. Bilder werden automatisch komprimiert.';
            renderProfileAvatarPicker();
        }

        function drawAvatarCrop() {
            if (!state.profileAvatarImage) return;
            const canvas = $('avatarCropCanvas');
            const context = canvas.getContext('2d');
            const image = state.profileAvatarImage;
            const zoom = Number($('avatarZoom').value || 100) / 100;
            const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
            const maxX = Math.max(0, (image.naturalWidth - side) / 2);
            const maxY = Math.max(0, (image.naturalHeight - side) / 2);
            const x = (image.naturalWidth - side) / 2 + (Number($('avatarPositionX').value) / 100) * maxX;
            const y = (image.naturalHeight - side) / 2 + (Number($('avatarPositionY').value) / 100) * maxY;
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, x, y, side, side, 0, 0, canvas.width, canvas.height);
        }

        async function prepareProfileAvatar(file) {
            state.profileAvatarFile = file;
            if (!file) {
                $('avatarCropEditor').classList.add('hidden');
                return;
            }
            if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
                throw new Error('Nur JPEG, PNG, WebP und GIF sind erlaubt.');
            }
            if (file.size > 20 * 1024 * 1024) throw new Error('Bild muss kleiner als 20 MB sein.');
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'));
                reader.readAsDataURL(file);
            });
            state.profileAvatarImage = await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('Bild konnte nicht angezeigt werden.'));
                image.src = dataUrl;
            });
            $('avatarZoom').value = '100';
            $('avatarPositionX').value = '0';
            $('avatarPositionY').value = '0';
            $('gifStillOption').classList.toggle('hidden', file.type !== 'image/gif');
            $('gifAsStill').checked = true;
            $('avatarCropEditor').classList.remove('hidden');
            drawAvatarCrop();
        }

        function readProfileAvatarFile() {
            const file = state.profileAvatarFile || $('profileAvatarUpload').files[0];
            if (!file) return Promise.reject(new Error('Bitte ein Bild auswählen.'));
            if (file.type === 'image/gif' && !$('gifAsStill').checked) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve({
                        fileName: file.name,
                        mimeType: file.type,
                        dataBase64: String(reader.result).slice(String(reader.result).indexOf(',') + 1),
                    });
                    reader.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'));
                    reader.readAsDataURL(file);
                });
            }
            return new Promise((resolve, reject) => {
                $('avatarCropCanvas').toBlob((blob) => {
                    if (!blob) return reject(new Error('Profilbild konnte nicht zugeschnitten werden.'));
                    const reader = new FileReader();
                    reader.onload = () => resolve({
                        fileName: file.name.replace(/\.[^.]+$/, '') + '.png',
                        mimeType: 'image/png',
                        dataBase64: String(reader.result).slice(String(reader.result).indexOf(',') + 1),
                    });
                    reader.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'));
                    reader.readAsDataURL(blob);
                }, 'image/png');
            });
        }

        async function loadUsernameHistory() {
            const data = await api('/api/me/username-history');
            $('usernameTokens').textContent = 'Namensänderungen verfügbar dieses Jahr: ' + data.remainingChanges + ' / 3';
            $('ownUsernameHistory').innerHTML = data.history.length
                ? data.history.map((entry) => '<span class="history-item">@' + escapeText(entry.username) + '</span>').join('')
                : '<span class="muted small">Keine früheren Namen.</span>';
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
            $('contactAvatarSlot').innerHTML = avatarMarkup(contact, 'contactAvatar', 'contact-avatar');
            $('contactName').textContent = contact.display_name;
            $('contactUsername').textContent = '@' + contact.username;
            $('contactAbout').textContent = contact.about || 'Keine Info angegeben.';
            $('contactLastSeen').textContent = formatLastSeen(contact.last_seen_at);
            $('contactRegisteredSince').textContent = membershipText(contact.created_at);
            $('contactUsernameHistory').innerHTML = '<span class="muted small">Wird geladen...</span>';
            api('/api/users/' + contact.user_id + '/username-history')
                .then((data) => {
                    $('contactUsernameHistory').innerHTML = data.history.length
                        ? data.history.map((entry) => '<span class="history-item">@' + escapeText(entry.username) + '</span>').join('')
                        : '<span class="muted small">Keine sichtbaren früheren Namen.</span>';
                })
                .catch(() => {
                    $('contactUsernameHistory').innerHTML = '<span class="muted small">Nicht verfügbar.</span>';
                });
            $('contactBlockInfo').textContent = contact.blocked_me
                ? 'Diese Person hat Nachrichten von dir blockiert.'
                : (contact.blocked_by_me ? 'Diese Person ist blockiert und kann dir hier nicht schreiben.' : '');
            $('toggleBlock').textContent = contact.blocked_by_me ? 'Blockierung aufheben' : 'Person blockieren';
            $('deleteChat').textContent = (contact.blocked_by_me || contact.blocked_me) ? 'Kontakt archivieren' : 'Chat bei mir löschen';
            $('contactError').textContent = '';
        }

        function renderConversationList() {
            $('conversationList').innerHTML = state.conversations.map((chat) => {
                const active = state.activeConversation && state.activeConversation.id === chat.id ? ' active' : '';
                const preview = (chat.blocked_by_me || chat.blocked_me)
                    ? 'Geblockt'
                    : (chat.last_message || (chat.has_attachment ? 'Datei' : 'Noch keine Nachrichten'));
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

        function renderContactRequests() {
            const panel = $('requestsPanel');
            if (!state.contactRequests.length) {
                panel.classList.add('hidden');
                $('requestList').innerHTML = '';
                return;
            }
            panel.classList.remove('hidden');
            $('requestList').innerHTML = state.contactRequests.map((request) => {
                const incoming = Number(request.recipient_id) === Number(state.me.id);
                let status = incoming ? 'Anfrage erhalten' : 'Anfrage gesendet';
                let actions = '';
                if (request.status === 'pending' && incoming) {
                    actions =
                        '<button class="primary" type="button" data-accept-request="' + request.id + '">Annehmen</button>' +
                        '<button class="ghost" type="button" data-decline-request="' + request.id + '">Ablehnen</button>' +
                        '<button class="danger-button" type="button" data-block-request="' + request.id + '" data-user="' + request.user_id + '">Blockieren</button>';
                } else if (request.status === 'declined') {
                    status = 'Abgelehnt';
                    actions = '<button class="ghost" type="button" data-archive-request="' + request.id + '">Archivieren</button>';
                } else if (request.status === 'blocked') {
                    status = 'Geblockt';
                    actions = '<button class="ghost" type="button" data-archive-request="' + request.id + '">Archivieren</button>';
                }
                return '<div class="request-card"><div class="request-head"><strong>' + escapeText(request.display_name) +
                    '</strong><span>@' + escapeText(request.username) + '</span></div>' +
                    '<div class="request-status">' + status + '</div>' +
                    (actions ? '<div class="request-actions">' + actions + '</div>' : '') + '</div>';
            }).join('');
        }

        function renderBlockedUsers() {
            if (!state.blockedUsers.length) {
                $('blockedList').innerHTML = '<span class="muted small">Keine blockierten Kontakte.</span>';
                return;
            }
            $('blockedList').innerHTML = state.blockedUsers.map((user) =>
                '<div class="blocked-item"><div class="blocked-person">' + avatarMarkup(user) +
                '<div><strong>' + escapeText(user.display_name) + '</strong><span class="muted small">@' +
                escapeText(user.username) + '</span></div></div>' +
                '<button class="ghost" type="button" data-unblock-user="' + user.id + '">Entblocken</button></div>'
            ).join('');
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
                        ? '<img' + (message.attachment.mime_type === 'image/gif' ? ' data-is-gif="true"' : '') + ' src="' + message.attachment.data_url + '" alt="' + escapeText(message.attachment.file_name) + '">'
                        : '<a class="attachment-link" href="' + message.attachment.data_url + '" download="' + escapeText(message.attachment.file_name) + '">Datei: ' + escapeText(message.attachment.file_name) + '</a>')
                    : '';
                const text = message.body ? escapeText(message.body) : '';
                return '<div class="bubble ' + (mine ? 'me' : '') + '" data-message-id="' + message.id + '">' +
                    attachment + text + '<span class="meta">' + time + read + '</span></div>';
            }).join('');
            applyGifPreference($('messages'));
            const selectedMessage = state.searchMessageId
                ? $('messages').querySelector('[data-message-id="' + state.searchMessageId + '"]')
                : null;
            if (selectedMessage) {
                selectedMessage.classList.add('search-highlight');
                selectedMessage.scrollIntoView({ block: 'center', behavior: 'smooth' });
                state.searchMessageId = null;
            } else {
                $('messages').scrollTop = $('messages').scrollHeight;
            }
        }

        function renderPendingAttachment() {
            const preview = $('attachmentPreview');
            if (!state.pendingAttachment) {
                if (state.pendingAttachmentPreviewUrl) URL.revokeObjectURL(state.pendingAttachmentPreviewUrl);
                state.pendingAttachmentPreviewUrl = null;
                preview.classList.add('hidden');
                preview.innerHTML = '';
                return;
            }
            if (state.pendingAttachmentPreviewUrl) URL.revokeObjectURL(state.pendingAttachmentPreviewUrl);
            state.pendingAttachmentPreviewUrl = String(state.pendingAttachment.type || '').startsWith('image/')
                ? URL.createObjectURL(state.pendingAttachment)
                : null;
            preview.classList.remove('hidden');
            preview.innerHTML = '<div class="attachment-info">' +
                (state.pendingAttachmentPreviewUrl ? '<img class="attachment-image-preview"' + (state.pendingAttachment.type === 'image/gif' ? ' data-is-gif="true"' : '') + ' src="' + state.pendingAttachmentPreviewUrl + '" alt="Vorschau">' : '') +
                '<span class="attachment-name">Datei: ' + escapeText(state.pendingAttachment.name) + '</span></div>' +
                '<button id="removeAttachment" type="button" aria-label="Datei entfernen">&times;</button>';
            applyGifPreference(preview);
        }

        function chooseAttachment(file) {
            if (!file) return;
            const imageFile = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type);
            const maximumSize = imageFile ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
            if (file.size > maximumSize) {
                $('composerError').textContent = imageFile
                    ? 'Bild muss kleiner als 20 MB sein'
                    : 'Datei muss kleiner als 5 MB sein';
                return;
            }
            $('composerError').textContent = '';
            state.pendingAttachment = file;
            renderPendingAttachment();
        }

        function readSelectedAttachment() {
            const file = state.pendingAttachment || $('attachmentInput').files[0];
            if (!file) return Promise.resolve(null);
            const imageFile = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type);
            const maximumSize = imageFile ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
            if (file.size > maximumSize) {
                return Promise.reject(new Error(imageFile ? 'Bild muss kleiner als 20 MB sein' : 'Datei muss kleiner als 5 MB sein'));
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
            $('meAvatarSlot').innerHTML = avatarMarkup(state.me, 'meAvatar');
            applyGifPreference();
        }

        const settingsCategoryNames = {
            profile: 'Profil',
            privacy: 'Datenschutz',
            chat: 'Benachrichtigungen & Chat',
            security: 'Sicherheit',
        };

        function showSettingsCategory(category) {
            const categoryName = settingsCategoryNames[category] || '';
            $('settingsOverview').classList.toggle('hidden', Boolean(categoryName));
            document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
                panel.classList.toggle('hidden', panel.dataset.settingsPanel !== category);
            });
            $('settingsActions').classList.toggle('hidden', !categoryName);
            $('settingsBreadcrumb').classList.toggle('has-category', Boolean(categoryName));
            $('settingsBreadcrumb').innerHTML = categoryName
                ? '<button type="button" data-settings-home aria-label="Zur Einstellungsübersicht">&lsaquo; Einstellungen</button><span aria-hidden="true">/</span><strong>' + escapeText(categoryName) + '</strong>'
                : '<strong>Einstellungen</strong>';
        }

        function openAccount() {
            stopTyping();
            showSettingsCategory();
            $('profileUsername').value = state.me.username || '';
            $('profileDisplayName').value = state.me.display_name || '';
            $('profileEmail').value = state.me.email || '';
            $('profileAbout').value = state.me.about || '';
            $('profileRegisteredSince').textContent = membershipText(state.me.created_at);
            $('profile2fa').checked = Boolean(state.me.two_factor_enabled);
            $('displayNameVisibility').value = state.me.display_name_visibility || 'contacts';
            $('usernameHistoryVisibility').value = state.me.username_history_visibility || 'contacts';
            $('notificationSound').value = state.me.notification_sound_asset_id ? String(state.me.notification_sound_asset_id) : '';
            $('gifPlayback').value = state.me.gif_playback === 'all' ? 'all' : 'none';
            $('sendOnEnter').checked = Boolean(state.me.send_on_enter);
            state.profileAvatarId = state.me.avatar_asset_id;
            renderProfileAvatarPicker();
            $('profileError').textContent = '';
            $('profileNotice').textContent = '';
            $('chatEmpty').classList.add('hidden');
            $('chatPane').classList.add('hidden');
            $('contactPanel').classList.add('hidden');
            $('accountPanel').classList.remove('hidden');
            $('sidebar').classList.add('chat-open');
            $('chat').classList.add('chat-open');
            Promise.all([loadProfileAvatars(), loadNotificationSounds(), loadBlockedUsers(), loadUsernameHistory()])
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

        async function loadContactRequests() {
            const data = await api('/api/contact-requests');
            state.contactRequests = data.requests || [];
            renderContactRequests();
        }

        async function loadBlockedUsers() {
            const data = await api('/api/blocked-users');
            state.blockedUsers = data.users || [];
            renderBlockedUsers();
        }

        function showChatHome() {
            stopTyping();
            setRemoteTyping(false);
            state.activeConversation = null;
            state.pendingAttachment = null;
            hideSensitiveMessageWarning();
            $('attachmentInput').value = '';
            renderPendingAttachment();
            $('accountPanel').classList.add('hidden');
            $('contactPanel').classList.add('hidden');
            $('chatPane').classList.add('hidden');
            $('chatEmpty').classList.remove('hidden');
            $('chat').classList.add('chat-open');
            $('sidebar').classList.add('chat-open');
            renderConversationList();
        }

        async function refreshOpenMessages(conversationId) {
            if (!state.activeConversation || Number(state.activeConversation.id) !== Number(conversationId)) return;
            const data = await api('/api/conversations/' + conversationId + '/messages');
            state.activeConversation = data.conversation;
            if (!$('chatPane').classList.contains('hidden')) {
                renderMessages(data.messages);
                updateMessageControls();
            }
        }

        async function openConversation(id, messageId = null) {
            if (state.activeConversation && Number(state.activeConversation.id) !== Number(id)) stopTyping();
            const focus = messageId ? '?focusMessageId=' + encodeURIComponent(messageId) : '';
            const data = await api('/api/conversations/' + id + '/messages' + focus);
            if (!state.activeConversation || Number(state.activeConversation.id) !== Number(data.conversation.id)) {
                state.pendingAttachment = null;
                hideSensitiveMessageWarning();
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
            $('chatAvatarSlot').innerHTML = avatarMarkup(data.conversation, 'chatAvatar');
            updateMessageControls();
            renderMessages(data.messages);
            renderConversationList();
            await api('/api/conversations/' + id + '/read', { method: 'POST', body: '{}' });
            await loadConversations();
        }

        function connectEvents() {
            if (state.eventSource) state.eventSource.close();
            state.eventSource = new EventSource('/api/events?token=' + encodeURIComponent(state.token));
            state.eventSource.addEventListener('open', () => showConnectionStatus(true));
            state.eventSource.addEventListener('error', () => showConnectionStatus(false));
            state.eventSource.addEventListener('message:new', async (event) => {
                const payload = JSON.parse(event.data);
                const isActive = state.activeConversation && Number(state.activeConversation.id) === Number(payload.conversationId);
                const isOpen = isActive &&
                    !$('chatPane').classList.contains('hidden');
                if (state.me && Number(payload.message.sender_id) !== Number(state.me.id) && !isOpen) {
                    playNotificationSound();
                }
                if (isOpen) {
                    setRemoteTyping(false);
                    await refreshOpenMessages(payload.conversationId);
                    await api('/api/conversations/' + payload.conversationId + '/read', { method: 'POST', body: '{}' });
                }
                await loadConversations();
            });
            state.eventSource.addEventListener('typing', (event) => {
                const payload = JSON.parse(event.data);
                if (state.activeConversation && Number(state.activeConversation.id) === Number(payload.conversationId)) {
                    setRemoteTyping(payload.typing);
                }
            });
            state.eventSource.addEventListener('message:read', async (event) => {
                const payload = JSON.parse(event.data);
                await refreshOpenMessages(payload.conversationId);
            });
            state.eventSource.addEventListener('conversation:deleted', async (event) => {
                const payload = JSON.parse(event.data);
                await loadConversations();
                if (state.activeConversation && Number(state.activeConversation.id) === Number(payload.conversationId)) {
                    showChatHome();
                }
            });
            state.eventSource.addEventListener('contact:changed', async (event) => {
                const payload = JSON.parse(event.data);
                if (!$('accountPanel').classList.contains('hidden')) await loadBlockedUsers();
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
            state.eventSource.addEventListener('contact:request', async () => {
                await loadContactRequests();
                await loadConversations();
            });
        }

        window.addEventListener('offline', () => showConnectionStatus(false));

        async function boot() {
            if (!state.token) return showAuth();
            if (state.bootRetryTimer) {
                clearTimeout(state.bootRetryTimer);
                state.bootRetryTimer = null;
            }
            $('loadingStatus').textContent = 'Anmeldung wird geprüft...';
            try {
                await loadMe();
                showApp();
                connectEvents();
                showConnectionStatus(true);
            } catch (error) {
                if (!error.status || error.status >= 500) {
                    showConnectionStatus(false);
                    if (!$('loading').classList.contains('hidden')) {
                        $('loadingStatus').textContent = error.message + '. Neuer Versuch...';
                    }
                    state.bootRetryTimer = setTimeout(boot, 3000);
                    return;
                }
                localStorage.removeItem('justchat_token');
                state.token = null;
                showAuth();
                return;
            }
            Promise.all([
                loadNotificationSounds(),
                loadConversations(),
                loadContactRequests(),
                loadBlockedUsers(),
            ]).catch(() => showConnectionStatus(false));
        }

        $('authForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            $('authError').textContent = '';
            if (state.pendingEmailVerificationUserId) {
                $('verifyEmail').click();
                return;
            }
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
                if (data.emailVerificationRequired) {
                    beginEmailVerification(data);
                    return;
                }
                if (data.twoFactorRequired) {
                    beginTwoFactor(data);
                    return;
                }
                state.token = data.token;
                localStorage.setItem('justchat_token', state.token);
                await boot();
            } catch (error) {
                $('authError').textContent = error.message;
            }
        });

        $('verifyEmail').addEventListener('click', async () => {
            $('authError').textContent = '';
            try {
                const code = $('emailVerificationCode').value.trim();
                if (!code || !state.pendingEmailVerificationUserId) return;
                const verified = await api('/api/auth/verify-email', {
                    method: 'POST',
                    body: JSON.stringify({ userId: state.pendingEmailVerificationUserId, code }),
                });
                state.token = verified.token;
                localStorage.setItem('justchat_token', state.token);
                await boot();
            } catch (error) {
                $('authError').textContent = error.message;
            }
        });
        $('resendEmailVerification').addEventListener('click', async () => {
            if (!state.pendingEmailVerificationUserId || Date.now() < state.emailVerificationResendUntil) return;
            $('authError').textContent = '';
            try {
                const data = await api('/api/auth/resend-email-verification', {
                    method: 'POST',
                    body: JSON.stringify({ userId: state.pendingEmailVerificationUserId }),
                });
                $('authNotice').textContent = 'Ein neuer Bestätigungscode wurde an deine E-Mail gesendet.';
                startEmailVerificationResendCountdown(data.resendAfterSeconds || 60);
            } catch (error) {
                const retryAfterSeconds = error.data && error.data.retryAfterSeconds;
                if (retryAfterSeconds) startEmailVerificationResendCountdown(retryAfterSeconds);
                $('authError').textContent = error.message;
            }
        });
        $('cancelEmailVerification').addEventListener('click', () => {
            resetAuthPanels();
            $('authError').textContent = '';
        });
        $('toggleAuth').addEventListener('click', () => setAuthMode(!state.registerMode));
        $('settingsButton').addEventListener('click', openAccount);
        $('closeAccount').addEventListener('click', closeAccount);
        $('settingsOverview').addEventListener('click', (event) => {
            const button = event.target.closest('[data-settings-category]');
            if (button) showSettingsCategory(button.dataset.settingsCategory);
        });
        $('settingsBreadcrumb').addEventListener('click', (event) => {
            if (event.target.closest('[data-settings-home]')) showSettingsCategory();
        });
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
                showChatHome();
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
            const deleteButton = event.target.closest('[data-delete-profile-avatar]');
            if (deleteButton) {
                $('profileError').textContent = '';
                $('profileNotice').textContent = '';
                api('/api/me/avatar-assets/' + deleteButton.dataset.deleteProfileAvatar, { method: 'DELETE' })
                    .then(async () => {
                        await loadMe();
                        await loadProfileAvatars();
                        $('profileNotice').textContent = 'Eigenes Profilbild wurde gelöscht.';
                    })
                    .catch((error) => {
                        $('profileError').textContent = error.message;
                    });
                return;
            }
            const button = event.target.closest('[data-profile-avatar]');
            if (!button) return;
            state.profileAvatarId = button.dataset.profileAvatar;
            renderProfileAvatarPicker();
        });
        $('profileAvatarUpload').addEventListener('change', async (event) => {
            $('profileError').textContent = '';
            try {
                await prepareProfileAvatar(event.target.files[0]);
            } catch (error) {
                $('profileAvatarUpload').value = '';
                $('avatarCropEditor').classList.add('hidden');
                $('profileError').textContent = error.message;
            }
        });
        $('avatarZoom').addEventListener('input', drawAvatarCrop);
        $('avatarPositionX').addEventListener('input', drawAvatarCrop);
        $('avatarPositionY').addEventListener('input', drawAvatarCrop);
        $('uploadProfileAvatar').addEventListener('click', async () => {
            $('profileError').textContent = '';
            $('profileNotice').textContent = '';
            try {
                const attachment = await readProfileAvatarFile();
                const data = await api('/api/me/avatar-assets', {
                    method: 'POST',
                    body: JSON.stringify({ attachment }),
                });
                state.profileAvatarId = data.avatar.id;
                $('profileAvatarUpload').value = '';
                state.profileAvatarFile = null;
                state.profileAvatarImage = null;
                $('avatarCropEditor').classList.add('hidden');
                await loadProfileAvatars();
                $('profileNotice').textContent = 'Eigenes Profilbild hochgeladen. Speichere das Profil, um es zu verwenden.';
            } catch (error) {
                $('profileError').textContent = error.message;
            }
        });
        $('profileForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            $('profileError').textContent = '';
            $('profileNotice').textContent = '';
            try {
                await api('/api/me', {
                    method: 'PATCH',
                    body: JSON.stringify({
                        username: $('profileUsername').value,
                        displayName: $('profileDisplayName').value,
                        email: $('profileEmail').value,
                        about: $('profileAbout').value,
                        avatarAssetId: state.profileAvatarId,
                        twoFactorEnabled: $('profile2fa').checked,
                        displayNameVisibility: $('displayNameVisibility').value,
                        usernameHistoryVisibility: $('usernameHistoryVisibility').value,
                        notificationSoundAssetId: $('notificationSound').value || null,
                        gifPlayback: $('gifPlayback').value,
                        sendOnEnter: $('sendOnEnter').checked,
                    }),
                });
                await loadMe();
                await loadNotificationSounds();
                await loadUsernameHistory();
                await loadConversations();
                $('profileNotice').textContent = 'Einstellungen wurden gespeichert.';
            } catch (error) {
                $('profileError').textContent = error.message;
            }
        });
        $('previewSound').addEventListener('click', () => playNotificationSound($('notificationSound').value));
        $('blockedList').addEventListener('click', async (event) => {
            const button = event.target.closest('[data-unblock-user]');
            if (!button) return;
            $('profileError').textContent = '';
            $('profileNotice').textContent = '';
            try {
                await api('/api/users/' + button.dataset.unblockUser + '/block', { method: 'DELETE', body: '{}' });
                await loadBlockedUsers();
                await loadConversations();
                $('profileNotice').textContent = 'Kontakt wurde entblockt.';
            } catch (error) {
                $('profileError').textContent = error.message;
            }
        });
        $('addForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            $('addError').textContent = '';
            const username = $('addUsername').value.trim().replace(/^@/, '');
            try {
                await api('/api/contact-requests/by-username', {
                    method: 'POST',
                    body: JSON.stringify({ username }),
                });
                $('addUsername').value = '';
                $('addModal').classList.add('hidden');
                await loadContactRequests();
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
        $('resendTwoFactor').addEventListener('click', async () => {
            if (!state.pendingTwoFactorUserId || Date.now() < state.twoFactorResendUntil) return;
            $('authError').textContent = '';
            try {
                const data = await api('/api/auth/resend-2fa', {
                    method: 'POST',
                    body: JSON.stringify({ userId: state.pendingTwoFactorUserId }),
                });
                $('authNotice').textContent = 'Ein neuer Login-Code wurde an deine E-Mail gesendet.';
                startTwoFactorResendCountdown(data.resendAfterSeconds || 60);
            } catch (error) {
                const retryAfterSeconds = error.data && error.data.retryAfterSeconds;
                if (retryAfterSeconds) startTwoFactorResendCountdown(retryAfterSeconds);
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
            showChatHome();
        });
        $('homeChatsButton').addEventListener('click', () => {
            $('sidebar').classList.remove('chat-open');
            $('chat').classList.remove('chat-open');
        });
        $('messageInput').addEventListener('input', () => {
            hideSensitiveMessageWarning();
            updateTyping();
        });
        $('messageInput').addEventListener('blur', stopTyping);
        $('messageInput').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing || !state.me || !state.me.send_on_enter) return;
            event.preventDefault();
            $('composer').requestSubmit();
        });
        $('attachmentInput').addEventListener('change', (event) => chooseAttachment(event.target.files[0]));
        $('attachmentPreview').addEventListener('click', (event) => {
            if (!event.target.closest('#removeAttachment')) return;
            state.pendingAttachment = null;
            $('attachmentInput').value = '';
            renderPendingAttachment();
        });
        $('sendSensitiveMessage').addEventListener('click', () => {
            state.sensitiveMessageApproved = true;
            $('sensitiveMessageWarning').classList.add('hidden');
            $('composer').requestSubmit();
        });
        $('discardSensitiveMessage').addEventListener('click', () => {
            stopTyping();
            hideSensitiveMessageWarning();
            $('messageInput').value = '';
            state.pendingAttachment = null;
            $('attachmentInput').value = '';
            renderPendingAttachment();
            $('composerError').textContent = 'Nachricht wurde nicht gesendet und gelöscht.';
            $('messageInput').focus();
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
        $('requestList').addEventListener('click', async (event) => {
            const accept = event.target.closest('[data-accept-request]');
            const decline = event.target.closest('[data-decline-request]');
            const archive = event.target.closest('[data-archive-request]');
            const block = event.target.closest('[data-block-request]');
            try {
                if (accept || decline) {
                    const button = accept || decline;
                    await api('/api/contact-requests/' + (accept ? accept.dataset.acceptRequest : decline.dataset.declineRequest) + '/respond', {
                        method: 'POST',
                        body: JSON.stringify({ action: accept ? 'accept' : 'decline' }),
                    });
                    await loadContactRequests();
                    await loadConversations();
                    return;
                }
                if (block) {
                    await api('/api/users/' + block.dataset.user + '/block', { method: 'PUT', body: '{}' });
                    await loadContactRequests();
                    return;
                }
                if (archive) {
                    await api('/api/contact-requests/' + archive.dataset.archiveRequest + '/archive', {
                        method: 'POST',
                        body: '{}',
                    });
                    await loadContactRequests();
                }
            } catch (error) {
                $('composerError').textContent = error.message;
            }
        });
        $('search').addEventListener('input', async (event) => {
            const q = event.target.value.trim();
            const requestId = ++state.searchRequestId;
            if (q.length < 2) {
                $('searchResults').innerHTML = '';
                return;
            }
            try {
                const data = await api('/api/users?search=' + encodeURIComponent(q));
                if (requestId !== state.searchRequestId) return;
                const users = data.users.length
                    ? '<div class="search-group-title">Kontakte</div>' + data.users.map((user) =>
                        '<button class="row" data-user="' + user.id + '">' +
                        avatarMarkup(user) +
                        '<div class="row-main"><div class="row-title"><strong>' + escapeText(user.display_name) + '</strong></div>' +
                        '<div class="preview">@' + escapeText(user.username) + '</div></div></button>'
                    ).join('')
                    : '';
                const messages = data.messages.length
                    ? '<div class="search-group-title">Nachrichten</div>' + data.messages.map((message) => {
                        const sentByMe = Number(message.sender_id) === Number(state.me.id);
                        const person = sentByMe ? 'Du in ' + message.display_name : message.display_name;
                        const time = new Date(message.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
                        return '<button class="message-result" type="button" data-message-chat="' + message.conversation_id + '" data-message-id="' + message.id + '">' +
                            '<span class="message-result-head"><strong>' + escapeText(person) + '</strong><span>' + escapeText(time) + '</span></span>' +
                            '<span class="message-result-preview">' + escapeText(message.body) + '</span></button>';
                    }).join('')
                    : '';
                $('searchResults').innerHTML = users + messages ||
                    '<span class="muted small">Keine Treffer gefunden.</span>';
            } catch (error) {
                if (requestId !== state.searchRequestId) return;
                $('searchResults').innerHTML = '<span class="error small">' + escapeText(error.message) + '</span>';
            }
        });
        $('searchResults').addEventListener('click', async (event) => {
            const messageRow = event.target.closest('[data-message-chat]');
            if (messageRow) {
                state.searchMessageId = messageRow.dataset.messageId;
                $('search').value = '';
                $('searchResults').innerHTML = '';
                try {
                    await openConversation(messageRow.dataset.messageChat, messageRow.dataset.messageId);
                } catch (error) {
                    state.searchMessageId = null;
                    $('composerError').textContent = error.message;
                }
                return;
            }
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
                if (body && containsIban(body) && !state.sensitiveMessageApproved) {
                    stopTyping();
                    $('sensitiveMessageWarning').classList.remove('hidden');
                    return;
                }
                const attachment = await readSelectedAttachment();
                if ((!body && !attachment) || !state.activeConversation) return;
                hideSensitiveMessageWarning();
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

app.get('/admin', async (req, res) => {
    if (!ADMIN_PASSWORD) {
        return requireAdminAuth(req, res, () => {});
    }
    if (!hasAdminSession(req)) return res.send(renderAdminLogin());
    const data = await getDashboardData();
    return res.send(renderDashboard(data));
});

app.post('/admin/login', (req, res) => {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({ error: 'Die Admin-Anmeldung ist nicht konfiguriert' });
    }
    const username = String(req.body.username || '');
    const password = String(req.body.password || '');
    if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Benutzername oder Passwort ist falsch' });
    }
    res.cookie(ADMIN_SESSION_COOKIE, createAdminSessionToken(), {
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 1000 * 60 * 60 * 12,
        path: '/admin',
    });
    return res.json({ ok: true });
});

app.post('/admin/logout', (req, res) => {
    res.clearCookie(ADMIN_SESSION_COOKIE, { path: '/admin' });
    return res.json({ ok: true });
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
             where is_active = true and owner_user_id is null
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
        const attachment = await optimizeImageAttachment(req.body.attachment);
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
            'update avatar_assets set is_active = false where id = $1 and owner_user_id is null and is_active = true returning id',
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
            [ADMIN_USER, userId ? `chat_archive_zip_export_user_${userId}` : 'chat_archive_zip_export_all', req.ip],
        );

        const users = await query(
            `select id, username, display_name, email, about, avatar_color, created_at, last_seen_at
             from users
             where ($1::bigint is null or id in (
                select user_one_id from conversations where $1 in (user_one_id, user_two_id)
                union
                select user_two_id from conversations where $1 in (user_one_id, user_two_id)
             ))
             order by id`,
            [userId],
        );
        const conversations = await query(
            `select id, user_one_id, user_two_id, created_at,
                hidden_for_user_one, hidden_for_user_two,
                deleted_for_user_one_at, deleted_for_user_two_at,
                greatest(deleted_for_user_one_at, deleted_for_user_two_at) + interval '${CHAT_RETENTION_DAYS} days' as minimum_retention_until
             from conversations
             where ($1::bigint is null or $1 in (user_one_id, user_two_id))
             order by id`,
            [userId],
        );
        const messages = await query(
            `select m.id, m.conversation_id, m.sender_id, m.body, m.created_at, m.read_at
             from messages m
             join conversations c on c.id = m.conversation_id
             where ($1::bigint is null or $1 in (c.user_one_id, c.user_two_id))
             order by m.conversation_id, m.created_at`,
            [userId],
        );
        const contactRequests = await query(
            `select id, sender_id, recipient_id, status, archived_by_sender, archived_by_recipient, created_at, responded_at
             from contact_requests
             where ($1::bigint is null or $1 in (sender_id, recipient_id))
             order by created_at`,
            [userId],
        );
        const attachments = await query(
            `select a.id, a.message_id, a.file_name, a.mime_type, a.size_bytes, a.created_at, a.data,
                m.conversation_id
             from message_attachments a
             join messages m on m.id = a.message_id
             join conversations c on c.id = m.conversation_id
             where ($1::bigint is null or $1 in (c.user_one_id, c.user_two_id))
             order by m.conversation_id, a.message_id, a.id`,
            [userId],
        );
        const exportedAt = new Date().toISOString();
        const attachmentMetadata = attachments.rows.map((attachment) => ({
            id: attachment.id,
            message_id: attachment.message_id,
            conversation_id: attachment.conversation_id,
            file_name: attachment.file_name,
            mime_type: attachment.mime_type,
            size_bytes: attachment.size_bytes,
            created_at: attachment.created_at,
            archive_path: `dateien/chat-${attachment.conversation_id}/nachricht-${attachment.message_id}/${attachment.id}-${zipPathSegment(attachment.file_name)}`,
        }));
        const metadataByMessage = new Map();
        for (const attachment of attachmentMetadata) {
            const items = metadataByMessage.get(String(attachment.message_id)) || [];
            items.push(attachment);
            metadataByMessage.set(String(attachment.message_id), items);
        }
        const messageMetadata = messages.rows.map((message) => ({
            ...message,
            attachments: metadataByMessage.get(String(message.id)) || [],
        }));
        const manifest = {
            exported_at: exportedAt,
            purpose: 'Archivexport für berechtigte Sicherheits-, Rechts- oder Behördenanfragen',
            retention_policy: `Von Nutzern entfernte Chats werden mindestens ${CHAT_RETENTION_DAYS} Tage aufbewahrt. Beidseitig entfernte Chats dürfen danach bereinigt werden.`,
            selected_user_id: userId || null,
            users: users.rows,
            conversations: conversations.rows,
            contact_requests: contactRequests.rows,
            messages: messageMetadata,
        };
        const files = [
            { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
        ];
        for (let index = 0; index < attachments.rows.length; index += 1) {
            files.push({ name: attachmentMetadata[index].archive_path, data: attachments.rows[index].data });
        }
        const archive = createZipArchive(files);

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="justchat-archiv-${exportedAt.slice(0, 10)}.zip"`);
        return res.send(archive);
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
        if (!getMailer()) {
            return res.status(503).json({ error: 'Registrierung braucht vollständige SMTP-Konfiguration' });
        }
        const existingAccount = await query('select * from users where username = $1 or email = $2 limit 1', [username, email]);
        if (existingAccount.rows[0]) {
            const existingUser = existingAccount.rows[0];
            const canResumeVerification = existingUser.username === username
                && existingUser.email === email
                && existingUser.email_verification_required
                && !existingUser.email_verified_at
                && verifyPassword(password, existingUser.password_hash);
            if (!canResumeVerification) {
                return res.status(409).json({ error: 'Benutzername oder E-Mail ist bereits vergeben' });
            }
            const delivery = await sendEmailVerificationCode(existingUser);
            return res.json({
                emailVerificationRequired: true,
                userId: existingUser.id,
                codeSent: delivery.sent,
                resendAfterSeconds: delivery.retryAfterSeconds,
            });
        }
        if (avatarAssetId) {
            const avatar = await query(
                'select id from avatar_assets where id = $1 and owner_user_id is null and is_active = true',
                [avatarAssetId],
            );
            if (!avatar.rows[0]) return res.status(400).json({ error: 'Profilbild ist nicht verfügbar' });
        }

        const result = await query(
            `insert into users (username, display_name, email, avatar_asset_id, password_hash, avatar_color, two_factor_enabled, email_verification_required)
             values ($1, $2, $3, $4, $5, $6, $7, true)
             returning id, username, display_name, email, avatar_asset_id, about, avatar_color, two_factor_enabled, display_name_visibility, created_at, last_seen_at`,
            [username, displayName, email, avatarAssetId, hashPassword(password), avatarColor, twoFactorEnabled],
        );
        const user = result.rows[0];

        const delivery = await sendEmailVerificationCode(user);
        return res.status(201).json({
            emailVerificationRequired: true,
            userId: user.id,
            codeSent: delivery.sent,
            resendAfterSeconds: delivery.retryAfterSeconds,
        });
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

        if (user.email_verification_required && !user.email_verified_at) {
            const delivery = await sendEmailVerificationCode(user);
            return res.json({
                emailVerificationRequired: true,
                userId: user.id,
                codeSent: delivery.sent,
                resendAfterSeconds: delivery.retryAfterSeconds,
            });
        }

        await query('update users set last_seen_at = now() where id = $1', [user.id]);
        if (user.two_factor_enabled) {
            const delivery = await sendTwoFactorCode(user);
            return res.json({
                twoFactorRequired: true,
                userId: user.id,
                codeSent: delivery.sent,
                resendAfterSeconds: delivery.retryAfterSeconds,
            });
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

app.post('/api/auth/resend-email-verification', async (req, res, next) => {
    try {
        const userId = parseId(req.body.userId);
        if (!userId) return res.status(400).json({ error: 'Ungültige Bestätigungsanfrage' });
        const result = await query(
            'select * from users where id = $1 and email_verification_required = true and email_verified_at is null',
            [userId],
        );
        const user = result.rows[0];
        if (!user) return res.status(400).json({ error: 'E-Mail-Adresse ist bereits bestätigt' });

        const delivery = await sendEmailVerificationCode(user);
        if (!delivery.sent) {
            return res.status(429).json({
                error: 'Bitte warte, bevor du einen neuen Code anforderst.',
                retryAfterSeconds: delivery.retryAfterSeconds,
            });
        }
        return res.json({ ok: true, resendAfterSeconds: delivery.retryAfterSeconds });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/auth/verify-email', async (req, res, next) => {
    try {
        const userId = parseId(req.body.userId);
        const code = String(req.body.code || '').trim();
        if (!userId || !/^\d{6}$/.test(code)) {
            return res.status(400).json({ error: 'Ungültiger Bestätigungscode' });
        }

        const result = await query(
            `select evc.*, u.id as user_id, u.username, u.display_name, u.email, u.about, u.avatar_color,
                u.avatar_asset_id, u.two_factor_enabled, u.created_at, u.last_seen_at
             from email_verification_codes evc
             join users u on u.id = evc.user_id
             where evc.user_id = $1 and evc.used_at is null and evc.expires_at > now()
                and u.email_verification_required = true and u.email_verified_at is null
             order by evc.created_at desc
             limit 1`,
            [userId],
        );
        const row = result.rows[0];
        if (!row || !verifyPassword(code, row.code_hash)) {
            return res.status(401).json({ error: 'Bestätigungscode ist falsch oder abgelaufen' });
        }

        await query('update email_verification_codes set used_at = now() where id = $1', [row.id]);
        await query(
            'update users set email_verified_at = now(), email_verification_required = false, last_seen_at = now() where id = $1',
            [row.user_id],
        );
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
            last_seen_at: new Date().toISOString(),
        };
        return res.json({ token: createToken(user), user });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/auth/resend-2fa', async (req, res, next) => {
    try {
        const userId = parseId(req.body.userId);
        if (!userId) return res.status(400).json({ error: 'Ungültige 2FA-Anfrage' });
        const result = await query('select * from users where id = $1 and two_factor_enabled = true', [userId]);
        const user = result.rows[0];
        if (!user) return res.status(400).json({ error: 'Ungültige 2FA-Anfrage' });

        const delivery = await sendTwoFactorCode(user);
        if (!delivery.sent) {
            return res.status(429).json({
                error: 'Bitte warte, bevor du einen neuen Code anforderst.',
                retryAfterSeconds: delivery.retryAfterSeconds,
            });
        }
        return res.json({ ok: true, resendAfterSeconds: delivery.retryAfterSeconds });
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
            const accountsHtml = result.rows.map((user) =>
                `<div style="padding:10px 0;border-bottom:1px solid #ccfbf1;"><strong style="color:#0f766e;">@${escapeHtml(user.username)}</strong><span style="display:block;color:#475467;">${escapeHtml(user.display_name)}</span></div>`
            ).join('');
            await sendMail({
                to: email,
                subject: 'Dein JustChat Benutzername',
                text: `Zu dieser E-Mail gehören folgende JustChat-Konten:\n\n${names}`,
                html: renderEmailTemplate({
                    title: 'Benutzername wiederfinden',
                    greeting: 'Hallo,',
                    message: 'zu dieser E-Mail-Adresse gehören die folgenden JustChat-Konten:',
                    contentHtml: `<div style="margin:20px 0;padding:4px 16px;border-radius:10px;background:#f0fdfa;border:1px solid #99f6e4;">${accountsHtml}</div>`,
                    note: 'Falls du diese Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren.',
                }),
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
             where is_active = true and owner_user_id is null
             order by created_at desc
             limit 60`,
        );
        return res.json({ avatars: result.rows });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/me/avatars', requireAuth, async (req, res, next) => {
    try {
        const result = await query(
            `select id, name, mime_type, size_bytes, owner_user_id = $1 as mine,
                'data:' || mime_type || ';base64,' || encode(data, 'base64') as data_url
             from avatar_assets
             where is_active = true and (owner_user_id is null or owner_user_id = $1)
             order by (owner_user_id is not null) desc, created_at desc
             limit 80`,
            [req.user.id],
        );
        const ownCount = result.rows.filter((avatar) => avatar.mine).length;
        return res.json({
            avatars: result.rows,
            ownCount,
            uploadLimit: personalAvatarLimit(req.user.created_at),
        });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/me/avatar-assets', requireAuth, async (req, res, next) => {
    try {
        const attachment = await optimizeImageAttachment(req.body.attachment);
        if (!attachment) return res.status(400).json({ error: 'Bitte ein Profilbild hochladen' });
        const count = await query(
            'select count(*)::int as count from avatar_assets where owner_user_id = $1 and is_active = true',
            [req.user.id],
        );
        const limit = personalAvatarLimit(req.user.created_at);
        if (count.rows[0].count >= limit) {
            return res.status(400).json({ error: `Du kannst aktuell maximal ${limit} eigene Profilbilder speichern` });
        }
        const result = await query(
            `insert into avatar_assets (name, mime_type, size_bytes, data, owner_user_id)
             values ($1, $2, $3, $4, $5)
             returning id, name, mime_type, size_bytes, created_at`,
            [attachment.fileName, attachment.mimeType, attachment.sizeBytes, attachment.data, req.user.id],
        );
        return res.status(201).json({ avatar: result.rows[0] });
    } catch (error) {
        return next(error);
    }
});

app.delete('/api/me/avatar-assets/:id', requireAuth, async (req, res, next) => {
    try {
        const avatarId = parseId(req.params.id);
        if (!avatarId) return res.status(400).json({ error: 'Ungültiges Profilbild' });
        const result = await query(
            `update avatar_assets
             set is_active = false
             where id = $1 and owner_user_id = $2 and is_active = true
             returning id`,
            [avatarId, req.user.id],
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Eigenes Profilbild nicht gefunden' });
        await query(
            'update users set avatar_asset_id = null where id = $1 and avatar_asset_id = $2',
            [req.user.id, avatarId],
        );
        return res.json({ ok: true });
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

app.get('/api/me/username-history', requireAuth, async (req, res, next) => {
    try {
        const history = await query(
            'select username, changed_at from username_history where user_id = $1 order by changed_at desc limit 30',
            [req.user.id],
        );
        const changesThisYear = await query(
            `select count(*)::int as count from username_history
             where user_id = $1 and changed_at >= date_trunc('year', now())`,
            [req.user.id],
        );
        return res.json({
            history: history.rows,
            remainingChanges: Math.max(0, 3 - changesThisYear.rows[0].count),
        });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/users/:id/username-history', requireAuth, async (req, res, next) => {
    try {
        const userId = parseId(req.params.id);
        if (!userId) return res.status(400).json({ error: 'Ungültiger Kontakt' });
        const user = await getUserById(userId);
        if (!user) return res.status(404).json({ error: 'Kontakt nicht gefunden' });
        const isContact = Boolean(await getExistingConversation(req.user.id, userId));
        const visible = user.username_history_visibility === 'everyone' || isContact;
        if (!visible) return res.json({ history: [] });
        const history = await query(
            'select username, changed_at from username_history where user_id = $1 order by changed_at desc limit 30',
            [userId],
        );
        return res.json({ history: history.rows });
    } catch (error) {
        return next(error);
    }
});

app.patch('/api/me', requireAuth, async (req, res, next) => {
    try {
        const username = normalizeUsername(req.body.username || req.user.username);
        const displayName = cleanDisplayName(req.body.displayName, req.user.username);
        const email = cleanEmail(req.body.email);
        const about = String(req.body.about || '').trim().slice(0, 180);
        const avatarAssetId = parseId(req.body.avatarAssetId);
        const twoFactorEnabled = Boolean(req.body.twoFactorEnabled);
        const displayNameVisibility = req.body.displayNameVisibility === 'everyone' ? 'everyone' : 'contacts';
        const usernameHistoryVisibility = req.body.usernameHistoryVisibility === 'everyone' ? 'everyone' : 'contacts';
        const notificationSoundAssetId = parseId(req.body.notificationSoundAssetId);
        const gifPlayback = req.body.gifPlayback === 'all' ? 'all' : 'none';
        const sendOnEnter = Boolean(req.body.sendOnEnter);

        if (!/^[a-z0-9_]{3,32}$/.test(username)) {
            return res.status(400).json({ error: 'Benutzername: 3-32 Zeichen, nur a-z, 0-9 und _' });
        }
        validateCleanName(username, 'Benutzername');
        validateCleanName(displayName, 'Anzeigename');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein' });
        }
        if (twoFactorEnabled && !getMailer()) {
            return res.status(400).json({ error: '2FA braucht vollständige SMTP-Konfiguration' });
        }
        if (avatarAssetId) {
            const avatar = await query(
                `select id from avatar_assets
                 where id = $1 and is_active = true and (owner_user_id is null or owner_user_id = $2)`,
                [avatarAssetId, req.user.id],
            );
            if (!avatar.rows[0]) return res.status(400).json({ error: 'Profilbild ist nicht verfügbar' });
        }
        if (notificationSoundAssetId) {
            const sound = await query(
                'select id from notification_sound_assets where id = $1 and is_active = true',
                [notificationSoundAssetId],
            );
            if (!sound.rows[0]) return res.status(400).json({ error: 'Benachrichtigungston ist nicht verfügbar' });
        }

        if (username !== req.user.username) {
            const occupied = await query('select id from users where username = $1 and id <> $2', [username, req.user.id]);
            if (occupied.rows[0]) {
                return res.status(409).json({ error: 'Benutzername ist bereits vergeben' });
            }
            const changes = await query(
                `select count(*)::int as count from username_history
                 where user_id = $1 and changed_at >= date_trunc('year', now())`,
                [req.user.id],
            );
            if (changes.rows[0].count >= 3) {
                return res.status(400).json({ error: 'Du hast deine 3 Benutzernamen-Änderungen für dieses Jahr bereits verbraucht' });
            }
            await query(
                'insert into username_history (user_id, username) values ($1, $2)',
                [req.user.id, req.user.username],
            );
        }

        const result = await query(
            `update users
             set username = $1, display_name = $2, email = $3, about = $4, avatar_asset_id = $5, two_factor_enabled = $6,
                 display_name_visibility = $7, username_history_visibility = $8, notification_sound_asset_id = $9,
                 gif_playback = $10, send_on_enter = $11
             where id = $12
             returning id`,
            [username, displayName, email, about, avatarAssetId, twoFactorEnabled, displayNameVisibility, usernameHistoryVisibility, notificationSoundAssetId, gifPlayback, sendOnEnter, req.user.id],
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

        const user = await getUserById(req.user.id);
        return res.json({ user });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Benutzername oder E-Mail ist bereits vergeben' });
        return next(error);
    }
});

app.get('/api/users', requireAuth, async (req, res, next) => {
    try {
        const search = String(req.query.search || '').trim().toLowerCase();
        if (search.length < 2) return res.json({ users: [], messages: [] });

        const users = await query(
            `select u.id, u.username, u.display_name, u.about, u.avatar_color, u.last_seen_at, u.created_at as member_since,
                u.id in (select early_user.id from users early_user where not early_user.email_verification_required or early_user.email_verified_at is not null order by early_user.created_at, early_user.id limit 10) as first_account,
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
        const messages = await query(
            `select m.id, m.conversation_id, m.sender_id, m.body, m.created_at,
                other_user.display_name, other_user.username
             from messages m
             join conversations c on c.id = m.conversation_id
             join users other_user
                on other_user.id = case when c.user_one_id = $1 then c.user_two_id else c.user_one_id end
             where $1 in (c.user_one_id, c.user_two_id)
                and case when c.user_one_id = $1 then not c.hidden_for_user_one else not c.hidden_for_user_two end
                and m.body <> ''
                and lower(m.body) like $2
             order by m.created_at desc
             limit 30`,
            [req.user.id, `%${search}%`],
        );
        return res.json({ users: users.rows, messages: messages.rows });
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
        await query(
            `update contact_requests
             set status = 'blocked', responded_at = now(),
                 archived_by_sender = false, archived_by_recipient = false
             where status <> 'accepted'
                and ((sender_id = $1 and recipient_id = $2) or (sender_id = $2 and recipient_id = $1))`,
            [req.user.id, otherUserId],
        );
        sendEvent(otherUserId, 'contact:changed', { userId: req.user.id });
        sendEvent(req.user.id, 'contact:changed', { userId: otherUserId });
        sendEvent(otherUserId, 'contact:request', { userId: req.user.id });
        sendEvent(req.user.id, 'contact:request', { userId: otherUserId });
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

app.get('/api/blocked-users', requireAuth, async (req, res, next) => {
    try {
        const result = await query(
            `select u.id, u.username, u.display_name, u.avatar_color, u.created_at as member_since,
                u.id in (select early_user.id from users early_user where not early_user.email_verification_required or early_user.email_verified_at is not null order by early_user.created_at, early_user.id limit 10) as first_account,
                case when aa.id is null then null else 'data:' || aa.mime_type || ';base64,' || encode(aa.data, 'base64') end as avatar_url
             from user_blocks b
             join users u on u.id = b.blocked_user_id
             left join avatar_assets aa on aa.id = u.avatar_asset_id and aa.is_active = true
             where b.blocker_id = $1
             order by b.created_at desc`,
            [req.user.id],
        );
        return res.json({ users: result.rows });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/contact-requests', requireAuth, async (req, res, next) => {
    try {
        const result = await query(
            `select r.id, r.sender_id, r.recipient_id, r.status, r.created_at, r.responded_at,
                other_user.id as user_id, other_user.username, other_user.display_name, other_user.created_at as member_since,
                other_user.avatar_color,
                other_user.id in (select early_user.id from users early_user where not early_user.email_verification_required or early_user.email_verified_at is not null order by early_user.created_at, early_user.id limit 10) as first_account,
                case when aa.id is null then null else 'data:' || aa.mime_type || ';base64,' || encode(aa.data, 'base64') end as avatar_url
             from contact_requests r
             join users other_user on other_user.id = case when r.sender_id = $1 then r.recipient_id else r.sender_id end
             left join avatar_assets aa on aa.id = other_user.avatar_asset_id and aa.is_active = true
             where $1 in (r.sender_id, r.recipient_id)
                and r.status <> 'accepted'
                and case when r.sender_id = $1 then not r.archived_by_sender else not r.archived_by_recipient end
             order by r.created_at desc`,
            [req.user.id],
        );
        return res.json({ requests: result.rows });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/contact-requests/by-username', requireAuth, async (req, res, next) => {
    try {
        const username = normalizeUsername(req.body.username);
        if (!username || !/^[a-z0-9_]{3,32}$/.test(username)) {
            return res.status(400).json({ error: 'Bitte vollständigen @name eingeben' });
        }
        const found = await query('select id from users where username = $1 and id <> $2', [username, req.user.id]);
        const user = found.rows[0];
        if (!user) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
        if (await getExistingConversation(req.user.id, user.id)) {
            return res.status(409).json({ error: 'Dieser Kontakt ist bereits in deinen Chats' });
        }
        const blockStatus = await getBlockStatus(req.user.id, user.id);
        if (blockStatus.blocked_by_me || blockStatus.blocked_me) {
            return res.status(403).json({ error: 'Für diesen Kontakt sind Anfragen blockiert' });
        }
        const existing = await query(
            `select id, status from contact_requests
             where (sender_id = $1 and recipient_id = $2) or (sender_id = $2 and recipient_id = $1)
             limit 1`,
            [req.user.id, user.id],
        );
        if (existing.rows[0]) {
            const statusText = existing.rows[0].status === 'pending' ? 'Es besteht bereits eine offene Anfrage' : 'Diese Anfrage ist bereits erledigt';
            return res.status(409).json({ error: statusText });
        }
        const created = await query(
            `insert into contact_requests (sender_id, recipient_id)
             values ($1, $2)
             returning id, status`,
            [req.user.id, user.id],
        );
        sendEvent(user.id, 'contact:request', { userId: req.user.id });
        return res.status(201).json({ request: created.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Es besteht bereits eine Anfrage für diesen Kontakt' });
        return next(error);
    }
});

app.post('/api/contact-requests/:id/respond', requireAuth, async (req, res, next) => {
    try {
        const requestId = parseId(req.params.id);
        const action = req.body.action === 'accept' ? 'accept' : req.body.action === 'decline' ? 'decline' : null;
        if (!requestId || !action) return res.status(400).json({ error: 'Ungültige Aktion' });
        const existing = await query(
            `select * from contact_requests
             where id = $1 and recipient_id = $2 and status = 'pending'`,
            [requestId, req.user.id],
        );
        const request = existing.rows[0];
        if (!request) return res.status(404).json({ error: 'Offene Anfrage nicht gefunden' });
        const status = action === 'accept' ? 'accepted' : 'declined';
        await query('update contact_requests set status = $1, responded_at = now() where id = $2', [status, request.id]);
        let conversationId = null;
        if (action === 'accept') {
            const [userOneId, userTwoId] = conversationPair(request.sender_id, request.recipient_id);
            const conversation = await query(
                `insert into conversations (user_one_id, user_two_id)
                 values ($1, $2)
                 on conflict (user_one_id, user_two_id) do update set
                    hidden_for_user_one = false, hidden_for_user_two = false,
                    deleted_for_user_one_at = null, deleted_for_user_two_at = null
                 returning id`,
                [userOneId, userTwoId],
            );
            conversationId = conversation.rows[0].id;
        }
        sendEvent(request.sender_id, 'contact:request', { userId: req.user.id, status, conversationId });
        sendEvent(request.recipient_id, 'contact:request', { userId: request.sender_id, status, conversationId });
        return res.json({ ok: true, status, conversationId });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/contact-requests/:id/archive', requireAuth, async (req, res, next) => {
    try {
        const requestId = parseId(req.params.id);
        if (!requestId) return res.status(400).json({ error: 'Ungültige Anfrage' });
        const archived = await query(
            `update contact_requests
             set archived_by_sender = case when sender_id = $2 then true else archived_by_sender end,
                 archived_by_recipient = case when recipient_id = $2 then true else archived_by_recipient end
             where id = $1 and $2 in (sender_id, recipient_id) and status in ('declined', 'blocked')
             returning id`,
            [requestId, req.user.id],
        );
        if (!archived.rows[0]) return res.status(404).json({ error: 'Kontakt kann nicht archiviert werden' });
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
                other_user.created_at as member_since,
                other_user.id in (select early_user.id from users early_user where not early_user.email_verification_required or early_user.email_verified_at is not null order by early_user.created_at, early_user.id limit 10) as first_account,
                case when aa.id is null then null else 'data:' || aa.mime_type || ';base64,' || encode(aa.data, 'base64') end as avatar_url,
                latest.body as last_message,
                latest.has_attachment as has_attachment,
                latest.created_at as last_message_at,
                latest.sender_id as last_sender_id,
                unread.count as unread_count,
                exists(select 1 from user_blocks where blocker_id = $1 and blocked_user_id = other_user.id) as blocked_by_me,
                exists(select 1 from user_blocks where blocker_id = other_user.id and blocked_user_id = $1) as blocked_me
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
        const existing = await getExistingConversation(req.user.id, otherUserId);
        if (!existing) return res.status(403).json({ error: 'Vor dem Chatten muss die Kontaktanfrage angenommen werden' });
        await query(
            `update conversations
             set hidden_for_user_one = case when user_one_id = $2 then false else hidden_for_user_one end,
                 hidden_for_user_two = case when user_two_id = $2 then false else hidden_for_user_two end,
                 deleted_for_user_one_at = case when user_one_id = $2 then null else deleted_for_user_one_at end,
                 deleted_for_user_two_at = case when user_two_id = $2 then null else deleted_for_user_two_at end
             where id = $1`,
            [existing.id, req.user.id],
        );
        return res.json({ conversation: { id: existing.id } });
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
        const conversation = await getExistingConversation(req.user.id, user.id);
        if (!conversation) return res.status(403).json({ error: 'Sende zuerst eine Kontaktanfrage' });
        return res.json({ conversation: { id: conversation.id } });
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
        const focusMessageId = parseId(req.query.focusMessageId);
        const messages = focusMessageId
            ? await query(
                `with focused as (
                    select created_at from messages where id = $2 and conversation_id = $1
                 ), nearby as (
                    select id, conversation_id, sender_id, body, created_at, read_at
                    from messages
                    where conversation_id = $1
                       and created_at <= coalesce((select created_at from focused), now())
                    order by created_at desc
                    limit 100
                 )
                 select * from nearby order by created_at asc`,
                [conversation.id, focusMessageId],
            )
            : await query(
                `select * from (
                    select id, conversation_id, sender_id, body, created_at, read_at
                    from messages
                    where conversation_id = $1
                    order by created_at desc
                    limit 200
                 ) recent
                 order by created_at asc`,
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
                first_account: otherUser.first_account,
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
        const attachmentMimeType = String(req.body.attachment && req.body.attachment.mimeType || '').toLowerCase();
        const attachment = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(attachmentMimeType)
            ? await optimizeImageAttachment(req.body.attachment)
            : parseAttachment(req.body.attachment);
        if (!body && !attachment) return res.status(400).json({ error: 'Nachricht ist leer' });

        const conversation = await getConversationForUser(req.params.id, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Chat nicht gefunden' });
        const blockStatus = await getBlockStatus(req.user.id, conversation.other_user_id);
        if (blockStatus.blocked_by_me || blockStatus.blocked_me) {
            return res.status(403).json({ error: 'In diesem Chat sind Nachrichten blockiert' });
        }
        await query(
            `update conversations
             set hidden_for_user_one = false, hidden_for_user_two = false,
                 deleted_for_user_one_at = null, deleted_for_user_two_at = null
             where id = $1`,
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
                 hidden_for_user_two = case when user_two_id = $2 then true else hidden_for_user_two end,
                 deleted_for_user_one_at = case when user_one_id = $2 then now() else deleted_for_user_one_at end,
                 deleted_for_user_two_at = case when user_two_id = $2 then now() else deleted_for_user_two_at end
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

        const markedRead = await query(
            `update messages
             set read_at = coalesce(read_at, now())
             where conversation_id = $1 and sender_id <> $2 and read_at is null
             returning id`,
            [conversation.id, req.user.id],
        );
        if (markedRead.rowCount > 0) {
            sendEvent(conversation.other_user_id, 'message:read', { conversationId: conversation.id });
        }
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/events', requireAuth, (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
    });
    res.write('event: ready\ndata: {"ok":true}\n\n');
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    res.on('close', () => clearInterval(keepAlive));
    addEventClient(req.user.id, res);
});

app.use((error, req, res, next) => {
    console.error(error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ error: statusCode === 500 ? 'Serverfehler' : error.message });
});

waitForDatabase()
    .then(async () => {
        if (DATABASE_URL) {
            await purgeExpiredArchivedConversations();
            const archiveCleanupTimer = setInterval(() => {
                purgeExpiredArchivedConversations().catch((error) => {
                    console.error('Archiv-Bereinigung fehlgeschlagen:', error.message);
                });
            }, 60 * 60 * 1000);
            archiveCleanupTimer.unref();
        }
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`JustChat läuft auf Port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error('Datenbank konnte nicht initialisiert werden:', error);
        process.exit(1);
    });
