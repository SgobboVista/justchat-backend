function registerAccountDeletionRoutes(app, dependencies) {
    const {
        requireAuth, query, sendMail, renderEmailTemplate, escapeHtml, parseId,
        getMailer, verifyPassword, PUBLIC_BASE_URL,
    } = dependencies;

    /**
     * Prüfe ob ein Account gelöscht werden darf
     * - Keine Verstöße gemeldet
     * - Chats nicht eingefroren
     * - Mindestens 2 Tage nicht in der Webapp aktiv
     */
    async function canDeleteAccount(userId) {
        const user = await query(
            `select id, username, email, created_at, last_seen_at, banned_at
             from users where id = $1`,
            [userId]
        );
        const userRow = user.rows[0];
        if (!userRow) return { allowed: false, reason: 'Nutzer nicht gefunden' };

        // Prüfe ob banniert
        if (userRow.banned_at) {
            return { allowed: false, reason: 'Konto ist gebannt' };
        }

        // Prüfe auf Verstöße (content_reports mit Violations)
        const violations = await query(
            `select count(*)::int as count
             from content_reports
             where reported_user_id = $1 and status != 'dismissed'`,
            [userId]
        );
        if (violations.rows[0].count > 0) {
            return { 
                allowed: false, 
                reason: 'Es gibt bestätigte Verstöße gegen die Community-Richtlinien' 
            };
        }

        // Prüfe auf gefrorene Chats
        const frozenChats = await query(
            `select count(*)::int as count
             from conversations
             where (user_one_id = $1 or user_two_id = $1) 
               and frozen_at is not null`,
            [userId]
        );
        if (frozenChats.rows[0].count > 0) {
            return { 
                allowed: false, 
                reason: 'Einige deiner Chats sind eingefroren' 
            };
        }

        // Prüfe auf Group-Verstöße
        const groupViolations = await query(
            `select count(*)::int as count
             from group_content_reports
             where reported_user_id = $1 and status != 'dismissed'`,
            [userId]
        );
        if (groupViolations.rows[0].count > 0) {
            return { 
                allowed: false, 
                reason: 'Es gibt bestätigte Verstöße gegen die Community-Richtlinien in Gruppen' 
            };
        }

        // Prüfe auf Inaktivität (mindestens 2 Tage)
        const lastSeen = userRow.last_seen_at ? new Date(userRow.last_seen_at) : new Date(userRow.created_at);
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        if (lastSeen > twoDaysAgo) {
            const hoursLeft = Math.ceil((twoDaysAgo - lastSeen) / (1000 * 60 * 60));
            return { 
                allowed: false, 
                reason: `Du musst mindestens 2 Tage inaktiv sein (noch ${Math.abs(hoursLeft)} Stunden)` 
            };
        }

        return { allowed: true };
    }

    /**
     * POST /api/me/request-deletion
     * Löschung beantragen
     */
    app.post('/api/me/request-deletion', requireAuth, async (req, res, next) => {
        try {
            const twoFaCode = String(req.body.twoFaCode || '').trim();

            // Prüfe ob 2FA erforderlich ist
            const userCheck = await query(
                'select two_factor_enabled from users where id = $1',
                [req.user.id]
            );
            const needsTwoFa = userCheck.rows[0]?.two_factor_enabled;

            if (needsTwoFa && !twoFaCode) {
                return res.status(400).json({ 
                    error: 'Zwei-Faktor-Authentifizierung erforderlich',
                    requires2fa: true 
                });
            }

            // Verifiziere 2FA wenn aktiviert
            if (needsTwoFa) {
                const loginCode = await query(
                    `select * from login_codes
                     where user_id = $1 and used_at is null and expires_at > now()
                     order by created_at desc limit 1`,
                    [req.user.id]
                );
                
                if (!loginCode.rows[0]) {
                    return res.status(400).json({ error: '2FA-Code erforderlich. Bitte anmelden und 2FA erneut anfragen.' });
                }

                const codeRow = loginCode.rows[0];
                // Verifiziere den 2FA-Code
                if (!verifyPassword(twoFaCode, codeRow.code_hash)) {
                    return res.status(401).json({ error: '2FA-Code ist falsch' });
                }
                
                // Code als benutzt markieren
                await query('update login_codes set used_at = now() where id = $1', [codeRow.id]);
            }

            // Prüfe ob Löschung erlaubt ist
            const canDelete = await canDeleteAccount(req.user.id);
            if (!canDelete.allowed) {
                return res.status(403).json({ error: canDelete.reason });
            }

            // Prüfe ob bereits eine ausstehende Löschung existiert
            const existingRequest = await query(
                `select id from account_deletions
                 where user_id = $1 and cancelled_at is null and deleted_at is null`,
                [req.user.id]
            );
            if (existingRequest.rows[0]) {
                return res.status(400).json({ 
                    error: 'Es gibt bereits eine laufende Löschanfrage' 
                });
            }

            // Erstelle Löschanfrage
            const result = await query(
                `insert into account_deletions (user_id, cancel_token)
                 values ($1, $2)
                 returning id, user_id, created_at, scheduled_deletion_at, cancel_token`,
                [req.user.id, Buffer.from(Math.random().toString()).toString('base64').slice(0, 40)]
            );

            const deletion = result.rows[0];
            const user = await query('select email, display_name from users where id = $1', [req.user.id]);
            const userData = user.rows[0];

            // Sende Löschungs-Ankündigung Email
            if (userData?.email && getMailer()) {
                const cancelUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/account/cancel-deletion?token=${deletion.cancel_token}`;
                await sendMail({
                    to: userData.email,
                    subject: 'JustChat Konto wird gelöscht',
                    text: `Hallo ${userData.display_name || userData.email},\n\nDein JustChat-Konto wird in 7 Tagen gelöscht.\n\nWenn du dich geirrt hast, kannst du die Löschung hier abbrechen:\n${cancelUrl}\n\nDieser Link ist 7 Tage gültig.`,
                    html: renderEmailTemplate({
                        title: 'Konto-Löschung geplant',
                        greeting: `Hallo ${userData.display_name || userData.email},`,
                        message: 'dein JustChat-Konto wird in 7 Tagen dauerhaft gelöscht.',
                        contentHtml: `<div style="margin:20px 0;padding:16px;border-radius:10px;background:#fff3f2;border:1px solid #f3c6c1;">
                            <p style="margin:0 0 12px;color:#7d1c17;"><strong>Wichtig:</strong> Dies kann nicht rückgängig gemacht werden.</p>
                            <p style="margin:0;color:#7d1c17;">Du kannst die Löschung in den nächsten 7 Tagen hier abbrechen:</p>
                        </div>
                        <div style="margin:20px 0;padding:12px;border-radius:8px;background:#eef8f6;border:1px solid #b8ded8;text-align:center;">
                            <a href="${escapeHtml(cancelUrl)}" style="color:#0f766e;text-decoration:none;font-weight:700;">Löschung abbrechen</a>
                        </div>`,
                        note: 'Dieser Link ist 7 Tage gültig.',
                    }),
                });
            }

            return res.json({
                ok: true,
                message: 'Löschanfrage erstellt. Du erhältst eine Bestätigung per E-Mail.',
                scheduledDeletionAt: deletion.scheduled_deletion_at,
            });
        } catch (error) {
            return next(error);
        }
    });

    /**
     * POST /api/me/cancel-deletion
     * Löschung abbrechen (mit Token oder Auth)
     */
    app.post('/api/me/cancel-deletion', async (req, res, next) => {
        try {
            let userId = null;
            const token = String(req.body.token || '').trim();

            // Verifiziere über Token (für Email-Link)
            if (token) {
                const deletion = await query(
                    `select user_id from account_deletions
                     where cancel_token = $1 and cancelled_at is null and deleted_at is null`,
                    [token]
                );
                if (!deletion.rows[0]) {
                    return res.status(400).json({ error: 'Ungültiger oder abgelaufener Token' });
                }
                userId = deletion.rows[0].user_id;
            } else {
                return res.status(401).json({ error: 'Token erforderlich oder als authentifizierter Nutzer mit Token aufrufen' });
            }

            // Finde die Löschanfrage
            const result = await query(
                `update account_deletions
                 set cancelled_at = now()
                 where user_id = $1 and cancelled_at is null and deleted_at is null
                 returning id, user_id`,
                [userId]
            );

            if (!result.rows[0]) {
                return res.status(404).json({ error: 'Keine aktive Löschanfrage gefunden' });
            }

            // Sende Bestätigungsemail
            const user = await query('select email, display_name from users where id = $1', [userId]);
            const userData = user.rows[0];
            if (userData?.email && getMailer()) {
                await sendMail({
                    to: userData.email,
                    subject: 'Konto-Löschung abgebrochen',
                    text: `Hallo ${userData.display_name || userData.email},\n\ndeine Konto-Löschung wurde erfolgreich abgebrochen. Dein Konto bleibt bestehen.`,
                    html: renderEmailTemplate({
                        title: 'Konto-Löschung abgebrochen',
                        greeting: `Hallo ${userData.display_name || userData.email},`,
                        message: 'deine Konto-Löschung wurde erfolgreich abgebrochen. Dein Konto bleibt vollständig erhalten.',
                        contentHtml: `<div style="margin:20px 0;padding:16px;border-radius:10px;background:#eef8f6;border:1px solid #b8ded8;color:#0f766e;text-align:center;font-weight:700;">✓ Dein Konto wurde gerettet!</div>`,
                    }),
                });
            }

            return res.json({
                ok: true,
                message: 'Konto-Löschung abgebrochen. Dein Konto bleibt bestehen.',
            });
        } catch (error) {
            return next(error);
        }
    });

    /**
     * GET /api/me/deletion-status
     * Prüfe Status der Löschanfrage
     */
    app.get('/api/me/deletion-status', requireAuth, async (req, res, next) => {
        try {
            const result = await query(
                `select id, created_at, scheduled_deletion_at, cancelled_at, deleted_at
                 from account_deletions
                 where user_id = $1 and deleted_at is null
                 order by created_at desc limit 1`,
                [req.user.id]
            );

            if (!result.rows[0]) {
                return res.json({
                    deletionScheduled: false,
                });
            }

            const deletion = result.rows[0];
            const now = new Date();
            const scheduledDate = new Date(deletion.scheduled_deletion_at);
            const hoursUntilDeletion = Math.max(0, Math.ceil((scheduledDate - now) / (1000 * 60 * 60)));

            return res.json({
                deletionScheduled: true,
                scheduledAt: deletion.created_at,
                scheduledDeletionAt: deletion.scheduled_deletion_at,
                cancelledAt: deletion.cancelled_at,
                hoursUntilDeletion,
            });
        } catch (error) {
            return next(error);
        }
    });
}

module.exports = { registerAccountDeletionRoutes };
