function registerAuthRoutes(app, dependencies) {
    const {
        PUBLIC_BASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, crypto, query, parseId,
        createToken, verifyPassword, hashPassword, normalizeUsername, cleanDisplayName,
        validateCleanName, cleanEmail, parseBirthDate, isAtLeastAge, sendEmailVerificationCode, sendTwoFactorCode,
        sendPasswordResetCode, escapeHtml, sendMail, renderEmailTemplate, getMailer,
    } = dependencies;
app.post('/api/auth/register', async (req, res, next) => {
    try {
        const username = normalizeUsername(req.body.username);
        const email = cleanEmail(req.body.email);
        const birthDate = parseBirthDate(req.body.birthDate);
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
        if (!birthDate) {
            return res.status(400).json({ error: 'Bitte gib dein gültiges Geburtsdatum ein' });
        }
        if (!isAtLeastAge(birthDate)) {
            return res.status(403).json({ error: 'JustChat ist erst ab 16 Jahren verfügbar' });
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
            if (!existingUser.birth_date) {
                await query('update users set birth_date = $1 where id = $2', [birthDate, existingUser.id]);
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
            `insert into users (username, display_name, email, birth_date, avatar_asset_id, password_hash, avatar_color, two_factor_enabled, email_verification_required)
             values ($1, $2, $3, $4, $5, $6, $7, $8, true)
             returning id, username, display_name, email, birth_date, avatar_asset_id, about, avatar_color, two_factor_enabled, display_name_visibility, created_at, last_seen_at`,
            [username, displayName, email, birthDate, avatarAssetId, hashPassword(password), avatarColor, twoFactorEnabled],
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
        return res.send(`<!doctype html><html><body><script data-cfasync="false">
            localStorage.setItem('justchat_token', ${JSON.stringify(token)});
            location.href = '/';
        </script></body></html>`);
    } catch (error) {
        return next(error);
    }
});

}

module.exports = { registerAuthRoutes };
