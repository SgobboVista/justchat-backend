function createAdminViews({ escapeHtml }) {
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
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="icon" type="image/png" sizes="32x32" href="/pwa-icon-32.png">
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
        html { height: 100%; touch-action: manipulation; }
        body { margin: 0; min-height: 100vh; touch-action: manipulation; font-family: Arial, sans-serif; background: var(--bg); color: var(--text); }
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
        button, input, select { font: inherit; touch-action: manipulation; }
        input, select, textarea { font-size: 16px; }
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
        .password-input { position: relative; }
        .password-input input { padding-right: 48px; }
        .password-toggle { position: absolute; top: 50%; right: 5px; transform: translateY(-50%); width: 40px; height: 40px; padding: 0; border-radius: 8px; background: transparent; color: var(--muted); }
        .password-toggle:hover { background: #f4f7fb; color: var(--accent); }
        .password-toggle svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
        .password-toggle .eye-slash { display: none; }
        .password-toggle.visible .eye-slash { display: block; }
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
        .news-compose { display: grid; gap: 12px; margin-top: 14px; }
        .news-compose textarea { width: 100%; min-height: 108px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; font: inherit; }
        .news-list { display: grid; gap: 12px; margin-top: 18px; }
        .news-card { display: grid; gap: 9px; border: 1px solid var(--line); border-radius: 10px; padding: 14px; background: #fff; }
        .news-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
        .news-author { font-weight: 700; color: var(--accent); }
        .news-card p { margin: 0; white-space: pre-wrap; line-height: 1.45; }
        .news-card img { display: block; width: min(520px, 100%); max-height: 340px; border-radius: 8px; object-fit: contain; background: #f3f6fa; }
        .news-card video { display: block; width: min(520px, 100%); max-height: 300px; border-radius: 8px; background: #000; }
        .news-archive { margin-top: 18px; border: 1px solid var(--line); border-radius: 10px; background: #f9fbfe; }
        .news-archive summary { cursor: pointer; padding: 14px; color: var(--accent); font-weight: 700; }
        .news-archive .news-list { margin: 0; padding: 0 14px 14px; }
        .sensitive-value { display: inline-block; filter: blur(5px); transition: filter .15s ease; cursor: default; }
        .sensitive-value:hover, .sensitive-value:focus { filter: none; outline: none; }
        .notice { border: 1px solid #fedf89; background: #fffaeb; color: #7a4f01; border-radius: 8px; padding: 12px; margin-top: 16px; }
        .load-error { border: 1px solid #fecdca; background: #fef3f2; color: var(--error); border-radius: 8px; padding: 12px; margin-bottom: 16px; }
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
<body><main>${content}</main>
    <script data-cfasync="false">
        ['gesturestart', 'gesturechange', 'gestureend'].forEach((name) => {
            document.addEventListener(name, (event) => event.preventDefault(), { passive: false });
        });
    </script>
</body>
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
                        <div class="password-input">
                            <input id="adminPassword" name="password" type="password" autocomplete="current-password" required>
                            <button class="password-toggle" type="button" data-password-toggle="adminPassword" aria-label="Passwort anzeigen" title="Passwort anzeigen">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.8"></circle><path class="eye-slash" d="M3 3l18 18"></path></svg>
                            </button>
                        </div>
                    </div>
                    <p id="adminLoginError" class="login-error hidden" role="alert"></p>
                    <button id="adminLoginButton" type="submit">Anmelden</button>
                </form>
                <p class="muted" style="margin-top: 18px;"><a href="/">Zur Web-App</a></p>
            </section>
        </div>
        <script data-cfasync="false">
            const form = document.getElementById('adminLoginForm');
            const error = document.getElementById('adminLoginError');
            const button = document.getElementById('adminLoginButton');
            const passwordToggle = document.querySelector('[data-password-toggle]');
            passwordToggle.addEventListener('click', () => {
                const password = document.getElementById(passwordToggle.dataset.passwordToggle);
                const visible = password.type === 'password';
                password.type = visible ? 'text' : 'password';
                passwordToggle.classList.toggle('visible', visible);
                passwordToggle.setAttribute('aria-label', visible ? 'Passwort verbergen' : 'Passwort anzeigen');
                passwordToggle.title = visible ? 'Passwort verbergen' : 'Passwort anzeigen';
            });
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
        <p id="adminLoadError" class="load-error hidden" role="alert"></p>
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
                        <dt>App-Version</dt><dd>${escapeHtml(data.appVersion)}</dd>
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
            <h2>News an @alle</h2>
            <p class="muted">Veröffentliche ein Update als <strong>SgobboVista</strong>. Nutzer sehen es im News-Tab und erhalten bei aktiviertem Push eine Benachrichtigung.</p>
            <div class="news-compose">
                <textarea id="newsBody" maxlength="4000" placeholder="Was gibt es Neues?"></textarea>
                <div class="toolbar">
                    <input id="newsImage" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
                    <input id="newsVideo" type="file" accept="video/mp4,video/webm,video/quicktime">
                    <button id="publishNews" type="button">News veröffentlichen</button>
                </div>
                <p class="muted">Optionales Bild: JPEG, PNG, WebP oder GIF, maximal 20 MB. Optionales Video: MP4, WebM oder MOV, maximal 25 MB.</p>
            </div>
            <details class="news-archive">
                <summary id="newsArchiveSummary">Veröffentlichte News verwalten</summary>
                <div id="newsList" class="news-list"></div>
            </details>
        </section>

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

        <script data-cfasync="false">
            const state = { users: [], avatars: [], sounds: [], news: [], audit: [], imageUpdate: null };
            const el = (id) => document.getElementById(id);
            const escapeText = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
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

            async function readVideoAttachment(file) {
                if (!file) return null;
                if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type)) {
                    throw new Error('Nur MP4, WebM und MOV sind erlaubt');
                }
                if (file.size > 25 * 1024 * 1024) throw new Error('Video muss kleiner als 25 MB sein');
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve({
                        fileName: file.name,
                        mimeType: file.type,
                        dataBase64: String(reader.result).slice(String(reader.result).indexOf(',') + 1),
                    });
                    reader.onerror = () => reject(new Error('Video konnte nicht gelesen werden'));
                    reader.readAsDataURL(file);
                });
            }

            async function adminApi(path, options = {}) {
                const response = await fetch(path, Object.assign({}, options, {
                    headers: Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}),
                }));
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
                    return '<tr><td>' + avatar + '</td><td><strong>' + escapeText(user.display_name) + '</strong><br><span class="muted">@' + escapeText(user.username) + '</span></td><td><span class="sensitive-value" tabindex="0" title="Zum Anzeigen berühren oder darüberfahren">' + escapeText(user.email || '-') + '</span></td><td>' + user.conversation_count + '</td><td>' + user.message_count + '</td></tr>';
                }).join('');
                el('avatarGrid').innerHTML = state.avatars.length ? state.avatars.map((avatar) =>
                    '<div class="avatar-card asset-card"><img src="' + avatar.data_url + '" alt=""><strong>' + escapeText(avatar.name) + '</strong><span class="muted">' + Math.round(avatar.size_bytes / 1024) + ' KB</span><button class="danger" type="button" data-delete-avatar="' + avatar.id + '">Löschen</button></div>'
                ).join('') : '<p class="muted">Noch keine Profilbilder hochgeladen.</p>';
                el('soundGrid').innerHTML = state.sounds.length ? state.sounds.map((sound) =>
                    '<div class="sound-card asset-card"><strong>' + escapeText(sound.name) + '</strong><audio controls preload="none" src="' + sound.data_url + '"></audio><span class="muted">' + Math.round(sound.size_bytes / 1024) + ' KB</span><button class="danger" type="button" data-delete-sound="' + sound.id + '">Löschen</button></div>'
                ).join('') : '<p class="muted">Noch keine Benachrichtigungstöne hochgeladen.</p>';
                el('newsList').innerHTML = state.news.length ? state.news.map((news) =>
                    '<article class="news-card"><div class="news-head"><span class="news-author">' + escapeText(news.author_name) + ' <span class="muted">' + escapeText(news.audience) + '</span></span><button class="danger" type="button" data-delete-news="' + news.id + '">Löschen</button></div>' +
                    '<span class="muted">' + new Date(news.created_at).toLocaleString() + '</span><p>' + escapeText(news.body) + '</p>' +
                    (news.image_url ? '<img loading="lazy" src="' + news.image_url + '" alt="News-Bild">' : '') +
                    (news.video_url ? '<video controls preload="metadata" src="' + news.video_url + '"></video>' : '') + '</article>'
                ).join('') : '<p class="muted">Noch keine News veröffentlicht.</p>';
                el('newsArchiveSummary').textContent = 'Veröffentlichte News verwalten (' + state.news.length + ')';
                el('auditRows').innerHTML = state.audit.map((row) =>
                    '<tr><td>' + new Date(row.created_at).toLocaleString() + '</td><td>' + escapeText(row.admin_user) + '</td><td>' + escapeText(row.action) + '</td><td><span class="sensitive-value" tabindex="0" title="Zum Anzeigen berühren oder darüberfahren">' + escapeText(row.ip_address || '-') + '</span></td></tr>'
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
                el('adminLoadError').classList.add('hidden');
                try {
                    const data = await adminApi('/admin/api/overview');
                    state.summary = data.summary;
                    state.users = data.users;
                    state.avatars = data.avatars;
                    state.sounds = data.sounds;
                    state.news = data.news || [];
                    state.audit = data.audit;
                    state.imageUpdate = data.imageUpdate;
                    render();
                    if (data.warning) {
                        el('adminLoadError').textContent = data.warning;
                        el('adminLoadError').classList.remove('hidden');
                    }
                } catch (error) {
                    el('adminLoadError').textContent = 'Statistiken konnten nicht geladen werden: ' + error.message;
                    el('adminLoadError').classList.remove('hidden');
                }
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
            el('publishNews').addEventListener('click', async () => {
                try {
                    const imageFile = el('newsImage').files[0];
                    const image = imageFile ? {
                        fileName: imageFile.name,
                        mimeType: imageFile.type,
                        dataBase64: await readFileBase64(imageFile),
                    } : null;
                    const video = await readVideoAttachment(el('newsVideo').files[0]);
                    await adminApi('/admin/api/news', {
                        method: 'POST',
                        body: JSON.stringify({ body: el('newsBody').value, image, video }),
                    });
                    el('newsBody').value = '';
                    el('newsImage').value = '';
                    el('newsVideo').value = '';
                    await loadAdmin();
                } catch (error) {
                    alert(error.message);
                }
            });
            el('newsList').addEventListener('click', async (event) => {
                const button = event.target.closest('[data-delete-news]');
                if (!button) return;
                try {
                    await adminApi('/admin/api/news/' + button.dataset.deleteNews, { method: 'DELETE' });
                    await loadAdmin();
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


    return { renderAdminLayout, renderAdminLogin, renderDashboard };
}

module.exports = { createAdminViews };
