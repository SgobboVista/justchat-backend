const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const sharp = require('sharp');
const webPush = require('web-push');
const tf = require('@tensorflow/tfjs-node');
const nsfwjs = require('nsfwjs');
const { createAdminViews } = require('./src/views/admin');
const { renderMessengerApp } = require('./src/views/messenger');
const { registerPwaRoutes } = require('./src/routes/pwa');
const { registerPageRoutes } = require('./src/routes/pages');
const { registerAdminRoutes } = require('./src/routes/admin');
const { registerAuthRoutes } = require('./src/routes/auth');
const { registerApiRoutes } = require('./src/routes/api');

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
const APP_VERSION = process.env.APP_VERSION || require('./package.json').version;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:kontakt@sgobbovista.de';
const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
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
const MAX_NEWS_VIDEO_BYTES = 25 * 1024 * 1024;
const DOMAIN_BANLIST_SOURCE_URL = 'https://github.com/SgobboVista/sgovi-banlists';
const DOMAIN_BANLIST_API_URL = 'https://api.github.com/repos/SgobboVista/sgovi-banlists/contents';
const DOMAIN_BANLIST_RAW_BASE_URL = 'https://raw.githubusercontent.com/SgobboVista/sgovi-banlists/main/';
const DOMAIN_BANLIST_REFRESH_MS = 6 * 60 * 60 * 1000;
const DOMAIN_BANLIST_FETCH_TIMEOUT_MS = 10000;
const NSFW_BLOCK_THRESHOLD = Math.min(1, Math.max(0.1, Number(process.env.NSFW_BLOCK_THRESHOLD || 0.72)));
const NSFW_STRONG_CLASS_THRESHOLD = Math.min(1, Math.max(0.1, Number(process.env.NSFW_STRONG_CLASS_THRESHOLD || 0.55)));
const NSFW_MAX_GIF_FRAMES = 5;
const DOMAIN_BANLIST_FALLBACK_FILES = [
    'adult.txt', 'animal-cruelty.txt', 'censorship.txt', 'child-abuse.txt', 'copyright.txt',
    'data-breach.txt', 'discrimination.txt', 'drugs.txt', 'duplicate.txt', 'extremism.txt',
    'fake-news.txt', 'fake-products.txt', 'hacking.txt', 'hate-speech.txt', 'illegal.txt',
    'malware-link.txt', 'malware.txt', 'misinformation.txt', 'obscure.txt', 'offline.txt',
    'other.txt', 'outdated.txt', 'phishing.txt', 'privacy.txt', 'racism.txt', 'spam.txt',
    'terrorism.txt', 'unethical.txt', 'violence.txt', 'weapons.txt', 'wrong-language.txt',
    'youth-endangerment.txt',
];
const domainBanlistState = {
    domains: new Set(),
    loadedAt: 0,
    loading: null,
};
let nsfwModelPromise = null;
let imageUpdateState = {
    configured: Boolean(IMAGE_UPDATE_WEBHOOK_URL),
    status: IMAGE_UPDATE_WEBHOOK_URL ? 'idle' : 'not_configured',
    requestedAt: null,
    finishedAt: null,
    message: IMAGE_UPDATE_WEBHOOK_URL
        ? 'Bereit, ein neues Container-Image anzufordern.'
        : 'IMAGE_UPDATE_WEBHOOK_URL ist nicht konfiguriert.',
};

app.use(express.json({ limit: '70mb' }));

if (PUSH_ENABLED) {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

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

function parseBirthDate(value) {
    const birthDate = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
    const parsed = new Date(`${birthDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== birthDate) return null;
    if (birthDate > new Date().toISOString().slice(0, 10)) return null;
    return birthDate;
}

function isAtLeastAge(birthDate, minimumAge = 16) {
    const date = parseBirthDate(birthDate);
    if (!date) return false;
    const today = new Date();
    const cutoff = new Date(Date.UTC(today.getUTCFullYear() - minimumAge, today.getUTCMonth(), today.getUTCDate()));
    return new Date(`${date}T00:00:00Z`) <= cutoff;
}

function cleanMessage(body) {
    return String(body || '').trim().slice(0, 4000);
}

function normalizeBlockedDomain(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/[./]+$/, '');
}

async function getDomainBanlistUrls() {
    try {
        const response = await fetch(DOMAIN_BANLIST_API_URL, {
            signal: AbortSignal.timeout(DOMAIN_BANLIST_FETCH_TIMEOUT_MS),
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'JustChat-domain-filter',
            },
        });
        if (response.ok) {
            const entries = await response.json();
            const urls = entries
                .filter((entry) => entry.type === 'file' && /\.txt$/i.test(entry.name) && entry.download_url)
                .map((entry) => entry.download_url);
            if (urls.length) return urls;
        }
    } catch (error) {
        console.warn('Domain-Banlist-Dateiliste konnte nicht geladen werden:', error.message);
    }
    return DOMAIN_BANLIST_FALLBACK_FILES.map((file) => DOMAIN_BANLIST_RAW_BASE_URL + encodeURIComponent(file));
}

async function loadBlockedDomains() {
    if (domainBanlistState.domains.size && Date.now() - domainBanlistState.loadedAt < DOMAIN_BANLIST_REFRESH_MS) {
        return domainBanlistState.domains;
    }
    if (domainBanlistState.loading) return domainBanlistState.loading;

    domainBanlistState.loading = (async () => {
        const urls = await getDomainBanlistUrls();
        const lists = await Promise.all(urls.map(async (url) => {
            try {
                const response = await fetch(url, {
                    signal: AbortSignal.timeout(DOMAIN_BANLIST_FETCH_TIMEOUT_MS),
                    headers: { 'User-Agent': 'JustChat-domain-filter' },
                });
                return response.ok ? response.text() : '';
            } catch (error) {
                console.warn('Domain-Banlist-Datei konnte nicht geladen werden:', url, error.message);
                return '';
            }
        }));
        const domains = new Set();
        lists.forEach((content) => {
            content.split(/\r?\n/).forEach((line) => {
                const raw = line.trim();
                if (!raw || raw.startsWith('#')) return;
                const domain = normalizeBlockedDomain(raw.replace(/^\|\|/, '').replace(/\^.*$/, '').split(/\s+/)[0]);
                if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i.test(domain)) {
                    domains.add(domain);
                }
            });
        });
        if (domains.size) {
            domainBanlistState.domains = domains;
            domainBanlistState.loadedAt = Date.now();
            console.log(`Domain-Banlist geladen: ${domains.size} Domains von ${DOMAIN_BANLIST_SOURCE_URL}`);
        } else if (!domainBanlistState.domains.size) {
            console.warn('Domain-Banlist enthaelt aktuell keine ladbaren Domains.');
        }
        return domainBanlistState.domains;
    })().finally(() => {
        domainBanlistState.loading = null;
    });
    return domainBanlistState.loading;
}

async function findBlockedDomain(body) {
    const domains = await loadBlockedDomains();
    if (!domains.size) return null;
    const candidates = String(body || '').match(
        /(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}/gi,
    ) || [];
    for (const candidate of candidates) {
        let hostname = '';
        try {
            hostname = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`).hostname;
        } catch (error) {
            continue;
        }
        const labels = normalizeBlockedDomain(hostname).split('.');
        for (let index = 0; index < labels.length - 1; index += 1) {
            const domain = labels.slice(index).join('.');
            if (domains.has(domain)) return domain;
        }
    }
    return null;
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

function getImageUpdateState() {
    return imageUpdateState;
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

async function getNsfwModel() {
    if (!nsfwModelPromise) {
        tf.enableProdMode();
        nsfwModelPromise = nsfwjs.load('MobileNetV2').catch((error) => {
            nsfwModelPromise = null;
            throw error;
        });
    }
    return nsfwModelPromise;
}

function selectedImageFrameIndexes(frameCount) {
    if (frameCount <= NSFW_MAX_GIF_FRAMES) {
        return Array.from({ length: frameCount }, (_, index) => index);
    }
    return Array.from({ length: NSFW_MAX_GIF_FRAMES }, (_, index) =>
        Math.round(index * (frameCount - 1) / (NSFW_MAX_GIF_FRAMES - 1))
    );
}

async function ensureOutgoingImageAllowed(attachment) {
    if (!attachment || !String(attachment.mimeType).startsWith('image/')) return;
    let model;
    try {
        model = await getNsfwModel();
    } catch (error) {
        console.error('NSFW-Modell konnte nicht geladen werden:', error.message);
        const unavailable = new Error('Bildprüfung ist derzeit nicht verfügbar. Bitte versuche es später erneut.');
        unavailable.statusCode = 503;
        throw unavailable;
    }

    const metadata = await sharp(attachment.data, { animated: attachment.mimeType === 'image/gif' }).metadata();
    const indexes = selectedImageFrameIndexes(Math.max(1, Number(metadata.pages) || 1));
    for (const page of indexes) {
        const raw = await sharp(attachment.data, { page })
            .flatten({ background: '#ffffff' })
            .removeAlpha()
            .toColourspace('srgb')
            .raw()
            .toBuffer({ resolveWithObject: true });
        const tensor = tf.tensor3d(new Uint8Array(raw.data), [raw.info.height, raw.info.width, raw.info.channels], 'int32');
        let predictions;
        try {
            predictions = await model.classify(tensor);
        } finally {
            tensor.dispose();
        }
        const probability = Object.fromEntries(predictions.map((result) => [result.className, result.probability]));
        const explicitTotal = (probability.Porn || 0) + (probability.Hentai || 0) + (probability.Sexy || 0);
        if ((probability.Porn || 0) >= NSFW_STRONG_CLASS_THRESHOLD
            || (probability.Hentai || 0) >= NSFW_STRONG_CLASS_THRESHOLD
            || explicitTotal >= NSFW_BLOCK_THRESHOLD) {
            const blocked = new Error('Dieses Bild wurde als Nacktbild oder sexueller Inhalt erkannt und kann nicht gesendet werden.');
            blocked.statusCode = 400;
            throw blocked;
        }
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

function parseNewsVideoAttachment(attachment) {
    const parsed = parseAttachment(attachment, MAX_NEWS_VIDEO_BYTES);
    if (!parsed) return null;
    const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
    if (!allowedTypes.includes(parsed.mimeType)) {
        const error = new Error('Nur MP4, WebM und MOV sind als News-Video erlaubt');
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
            birth_date date,
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
            banned_at timestamptz,
            ban_reason text,
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

        create table if not exists content_reports (
            id bigserial primary key,
            reporter_user_id bigint not null references users(id) on delete cascade,
            reported_user_id bigint not null references users(id) on delete cascade,
            conversation_id bigint not null references conversations(id) on delete cascade,
            message_id bigint not null references messages(id) on delete cascade,
            category text not null,
            details text not null default '',
            status text not null default 'open',
            admin_note text not null default '',
            action_taken text not null default 'none',
            created_at timestamptz not null default now(),
            reviewed_at timestamptz,
            unique(reporter_user_id, message_id),
            check(reporter_user_id <> reported_user_id),
            check(status in ('open', 'actioned', 'escalated', 'dismissed'))
        );

        create table if not exists chat_groups (
            id bigserial primary key,
            name text not null,
            owner_user_id bigint not null references users(id) on delete cascade,
            image_file_name text,
            image_mime_type text,
            image_size_bytes integer,
            image_data bytea,
            image_updated_at timestamptz,
            created_at timestamptz not null default now()
        );

        create table if not exists group_members (
            group_id bigint not null references chat_groups(id) on delete cascade,
            user_id bigint not null references users(id) on delete cascade,
            role text not null default 'member',
            joined_at timestamptz not null default now(),
            primary key (group_id, user_id),
            check(role in ('owner', 'member'))
        );

        create table if not exists group_messages (
            id bigserial primary key,
            group_id bigint not null references chat_groups(id) on delete cascade,
            sender_id bigint not null references users(id) on delete cascade,
            body text not null,
            created_at timestamptz not null default now()
        );

        create table if not exists group_invitations (
            id bigserial primary key,
            group_id bigint not null references chat_groups(id) on delete cascade,
            inviter_user_id bigint not null references users(id) on delete cascade,
            invitee_user_id bigint not null references users(id) on delete cascade,
            status text not null default 'pending',
            created_at timestamptz not null default now(),
            responded_at timestamptz,
            unique(group_id, invitee_user_id),
            check(inviter_user_id <> invitee_user_id),
            check(status in ('pending', 'accepted', 'declined', 'declined_forever'))
        );

        create table if not exists group_invitation_blocks (
            blocker_user_id bigint not null references users(id) on delete cascade,
            inviter_user_id bigint not null references users(id) on delete cascade,
            created_at timestamptz not null default now(),
            primary key (blocker_user_id, inviter_user_id),
            check(blocker_user_id <> inviter_user_id)
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

        create table if not exists news_posts (
            id bigserial primary key,
            author_name text not null default 'SgobboVista',
            audience text not null default '@alle',
            body text not null,
            image_file_name text,
            image_mime_type text,
            image_size_bytes integer,
            image_data bytea,
            video_file_name text,
            video_mime_type text,
            video_size_bytes integer,
            video_data bytea,
            created_at timestamptz not null default now()
        );

        create table if not exists push_subscriptions (
            id bigserial primary key,
            user_id bigint not null references users(id) on delete cascade,
            endpoint text not null unique,
            subscription jsonb not null,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );

        alter table users add column if not exists email text;
        alter table users add column if not exists birth_date date;
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
        alter table users add column if not exists banned_at timestamptz;
        alter table users add column if not exists ban_reason text;
        alter table avatar_assets add column if not exists owner_user_id bigint references users(id) on delete cascade;
        alter table conversations add column if not exists hidden_for_user_one boolean not null default false;
        alter table conversations add column if not exists hidden_for_user_two boolean not null default false;
        alter table conversations add column if not exists deleted_for_user_one_at timestamptz;
        alter table conversations add column if not exists deleted_for_user_two_at timestamptz;
        alter table conversations add column if not exists moderation_locked boolean not null default false;
        alter table conversations add column if not exists moderation_notice text not null default '';
        alter table conversations add column if not exists moderation_action_at timestamptz;
        alter table chat_groups add column if not exists image_file_name text;
        alter table chat_groups add column if not exists image_mime_type text;
        alter table chat_groups add column if not exists image_size_bytes integer;
        alter table chat_groups add column if not exists image_data bytea;
        alter table chat_groups add column if not exists image_updated_at timestamptz;
        alter table news_posts add column if not exists image_file_name text;
        alter table news_posts add column if not exists image_mime_type text;
        alter table news_posts add column if not exists image_size_bytes integer;
        alter table news_posts add column if not exists image_data bytea;

        create unique index if not exists idx_users_email_unique
            on users(email)
            where email is not null and email <> '';
        create unique index if not exists idx_users_google_unique
            on users(google_id)
            where google_id is not null and google_id <> '';
        create index if not exists idx_messages_conversation_created
            on messages(conversation_id, created_at);
        create index if not exists idx_group_members_user
            on group_members(user_id);
        create index if not exists idx_group_messages_group_created
            on group_messages(group_id, created_at);
        create index if not exists idx_group_invitations_invitee_status
            on group_invitations(invitee_user_id, status, created_at desc);
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
        create index if not exists idx_news_posts_created on news_posts(created_at desc);
        create index if not exists idx_push_subscriptions_user on push_subscriptions(user_id);
        create index if not exists idx_content_reports_status_created on content_reports(status, created_at desc);
    `);
}

async function purgeExpiredArchivedConversations() {
    const deleted = await query(
        `delete from conversations
         where hidden_for_user_one = true and hidden_for_user_two = true
            and deleted_for_user_one_at < now() - interval '${CHAT_RETENTION_DAYS} days'
            and deleted_for_user_two_at < now() - interval '${CHAT_RETENTION_DAYS} days'
            and not exists (select 1 from content_reports report where report.conversation_id = conversations.id)
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
        `select u.id, u.username, u.display_name, u.email, u.birth_date, u.about, u.avatar_color, u.avatar_asset_id,
            u.two_factor_enabled, u.display_name_visibility, u.username_history_visibility, u.notification_sound_asset_id, u.send_on_enter, u.gif_playback,
            u.banned_at, u.ban_reason, u.created_at, u.last_seen_at,
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
        if (user.banned_at && req.path !== '/api/me') {
            return res.status(403).json({
                error: user.ban_reason || 'Dein Konto wurde gesperrt.',
                code: 'account_banned',
            });
        }
        if (!user.birth_date && !['/api/me', '/api/me/birth-date'].includes(req.path)) {
            return res.status(403).json({
                error: 'Bitte hinterlege zuerst dein Geburtsdatum. JustChat ist ab 16 Jahren verfügbar.',
                code: 'birth_date_required',
            });
        }
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

function broadcastEvent(event, payload) {
    for (const userId of eventClients.keys()) {
        sendEvent(userId, event, payload);
    }
}

async function sendNewsPushNotification(news) {
    if (!PUSH_ENABLED) return;
    const subscriptions = await query('select id, subscription from push_subscriptions');
    const payload = JSON.stringify({
        title: 'SgobboVista an @alle',
        body: news.body.slice(0, 140),
        url: '/?tab=news',
        newsId: news.id,
    });
    await Promise.all(subscriptions.rows.map(async (entry) => {
        try {
            await webPush.sendNotification(entry.subscription, payload);
        } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) {
                await query('delete from push_subscriptions where id = $1', [entry.id]);
                return;
            }
            console.error('Push-Benachrichtigung fehlgeschlagen:', error.message);
        }
    }));
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
        appVersion: APP_VERSION,
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

const { renderAdminLayout, renderAdminLogin, renderDashboard } = createAdminViews({ escapeHtml });

registerPwaRoutes(app, { sharp });

const routeDependencies = {
    ADMIN_PASSWORD, ADMIN_USER, ADMIN_SESSION_COOKIE, DATABASE_URL,
    PUBLIC_BASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, IMAGE_UPDATE_WEBHOOK_URL,
    VAPID_PUBLIC_KEY, PUSH_ENABLED,
    CHAT_RETENTION_DAYS,
    APP_VERSION,
    crypto, getDashboardData, renderAdminLayout, renderAdminLogin, renderDashboard, renderMessengerApp,
    requireAdminAuth, requireAuth, hasAdminSession, createAdminSessionToken,
    query, dispatchImageUpdate, parseAttachment, optimizeImageAttachment, ensureOutgoingImageAllowed, parseNotificationSoundAttachment,
    parseId, createZipArchive, zipPathSegment, createToken, verifyPassword, hashPassword,
    normalizeUsername, cleanDisplayName, validateCleanName, cleanEmail, parseBirthDate, isAtLeastAge, cleanMessage, findBlockedDomain,
    sendEmailVerificationCode, sendTwoFactorCode, sendPasswordResetCode, getUserById,
    addEventClient, sendEvent, getConversationForUser, getBlockStatus, getExistingConversation,
    personalAvatarLimit, conversationPair, getImageUpdateState, escapeHtml, sendMail, renderEmailTemplate,
    parseNewsVideoAttachment, broadcastEvent, sendNewsPushNotification, getMailer,
};

registerPageRoutes(app, routeDependencies);
registerAdminRoutes(app, routeDependencies);
registerAuthRoutes(app, routeDependencies);
registerApiRoutes(app, routeDependencies);
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
            loadBlockedDomains().catch((error) => {
                console.error('Domain-Banlist konnte nicht vorgeladen werden:', error.message);
            });
            getNsfwModel().then(() => {
                console.log('NSFW-Bildprüfung bereit');
            }).catch((error) => {
                console.error('NSFW-Bildprüfung konnte nicht vorgeladen werden:', error.message);
            });
        });
    })
    .catch((error) => {
        console.error('Datenbank konnte nicht initialisiert werden:', error);
        process.exit(1);
    });
