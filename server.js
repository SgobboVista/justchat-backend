const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 50070;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;
const startedAt = new Date();

let pool;

app.use(express.json());

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

async function getDashboardData() {
    const dbPool = getDatabasePool();
    const data = {
        appName: process.env.APP_NAME || 'JustChat Backend',
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
        return res.status(503).send(renderSetupPage());
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

function renderLayout(content) {
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
        body {
            margin: 0;
            min-height: 100vh;
            font-family: Arial, sans-serif;
            background: var(--bg);
            color: var(--text);
        }
        main {
            width: min(1120px, calc(100% - 32px));
            margin: 0 auto;
            padding: 32px 0;
        }
        header {
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 24px;
        }
        h1, h2, p { margin: 0; }
        h1 { font-size: clamp(28px, 4vw, 44px); letter-spacing: 0; }
        h2 { font-size: 18px; margin-bottom: 16px; }
        .muted { color: var(--muted); margin-top: 8px; }
        .grid {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 16px;
        }
        .panel, .metric {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 8px;
            padding: 20px;
        }
        .panel { margin-top: 16px; }
        .metric span {
            display: block;
            color: var(--muted);
            font-size: 13px;
            margin-bottom: 10px;
        }
        .metric strong {
            display: block;
            font-size: 24px;
            line-height: 1.15;
            overflow-wrap: anywhere;
        }
        .status {
            display: inline-flex;
            align-items: center;
            border-radius: 999px;
            border: 1px solid currentColor;
            padding: 6px 10px;
            font-size: 13px;
            font-weight: 700;
        }
        .ok { color: var(--ok); }
        .warn { color: var(--warn); }
        .error { color: var(--error); }
        dl {
            display: grid;
            grid-template-columns: 180px 1fr;
            gap: 12px 18px;
            margin: 0;
        }
        dt { color: var(--muted); }
        dd { margin: 0; overflow-wrap: anywhere; }
        code {
            background: #f5f7fb;
            border: 1px solid var(--line);
            border-radius: 6px;
            padding: 2px 6px;
        }
        a {
            color: var(--accent);
            font-weight: 700;
            text-decoration: none;
        }
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
<body>
    <main>${content}</main>
</body>
</html>`;
}

function renderSetupPage() {
    return renderLayout(`
        <header>
            <div>
                <h1>Admin Dashboard</h1>
                <p class="muted">Die Admin-Anmeldung ist noch nicht konfiguriert.</p>
            </div>
            <span class="status warn">Setup erforderlich</span>
        </header>
        <section class="panel">
            <h2>Naechster Schritt</h2>
            <p>Setze <code>ADMIN_PASSWORD</code> als Umgebungsvariable und starte den Server neu. Optional kannst du mit <code>ADMIN_USER</code> den Login-Namen aendern.</p>
        </section>
    `);
}

function renderDashboard(data) {
    const dbStatus = statusClass(data.database.online);
    const appName = escapeHtml(data.appName);
    const environment = escapeHtml(data.environment);
    const uptime = escapeHtml(data.uptime);
    const startedAtText = escapeHtml(data.startedAt);
    const nodeVersion = escapeHtml(data.nodeVersion);
    const port = escapeHtml(data.port);
    const memoryMb = escapeHtml(data.memoryMb);
    const databaseMessage = escapeHtml(data.database.message);

    return renderLayout(`
        <header>
            <div>
                <h1>${appName}</h1>
                <p class="muted">Admin Dashboard fuer Betrieb, Status und Infrastruktur.</p>
            </div>
            <span class="status ${dbStatus}">Datenbank: ${statusText(data.database.online)}</span>
        </header>

        <section class="grid" aria-label="Server Kennzahlen">
            <div class="metric"><span>Umgebung</span><strong>${environment}</strong></div>
            <div class="metric"><span>Uptime</span><strong>${uptime}</strong></div>
            <div class="metric"><span>Speicher</span><strong>${memoryMb} MB</strong></div>
            <div class="metric"><span>Port</span><strong>${port}</strong></div>
        </section>

        <section class="panel">
            <h2>System</h2>
            <dl>
                <dt>Gestartet</dt><dd>${startedAtText}</dd>
                <dt>Node.js</dt><dd>${nodeVersion}</dd>
                <dt>Admin Login</dt><dd>${data.authConfigured ? 'Konfiguriert' : 'Nicht konfiguriert'}</dd>
            </dl>
        </section>

        <section class="panel">
            <h2>Datenbank</h2>
            <dl>
                <dt>Status</dt><dd><span class="status ${dbStatus}">${statusText(data.database.online)}</span></dd>
                <dt>Konfiguriert</dt><dd>${data.database.configured ? 'Ja' : 'Nein'}</dd>
                <dt>Latenz</dt><dd>${data.database.latencyMs === null ? '-' : `${data.database.latencyMs} ms`}</dd>
                <dt>Meldung</dt><dd>${databaseMessage}</dd>
            </dl>
        </section>
    `);
}

app.get('/', (req, res) => {
    res.send(renderLayout(`
        <header>
            <div>
                <h1>JustChat Backend</h1>
                <p class="muted">API ist online und einsatzbereit.</p>
            </div>
            <a href="/admin">Admin oeffnen</a>
        </header>
        <section class="panel">
            <h2>Status</h2>
            <p>Server laeuft auf Port <code>${PORT}</code>.</p>
        </section>
    `));
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server laeuft auf Port ${PORT}`);
});
