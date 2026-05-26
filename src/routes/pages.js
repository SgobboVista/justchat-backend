function registerPageRoutes(app, dependencies) {
    const {
        APP_VERSION, DATABASE_URL, PUBLIC_BASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
        getDashboardData, renderAdminLayout, renderMessengerApp,
    } = dependencies;
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
        version: APP_VERSION,
        uptime: data.uptime,
        database: data.database,
    });
});

app.get('/api/config', (req, res) => {
    res.json({
        googleEnabled: Boolean(PUBLIC_BASE_URL && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    });
});

}

module.exports = { registerPageRoutes };
