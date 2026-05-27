function registerAdminRoutes(app, dependencies) {
    const {
        ADMIN_PASSWORD, ADMIN_USER, ADMIN_SESSION_COOKIE, CHAT_RETENTION_DAYS, IMAGE_UPDATE_WEBHOOK_URL,
        getDashboardData, renderAdminLogin, renderDashboard, requireAdminAuth, hasAdminSession,
        createAdminSessionToken, query, dispatchImageUpdate, getImageUpdateState,
        optimizeImageAttachment, parseNotificationSoundAttachment, parseId, createZipArchive, zipPathSegment,
        parseNewsVideoAttachment, broadcastEvent, sendNewsPushNotification, sendEvent,
    } = dependencies;
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
            select u.id, u.username, u.display_name, u.email, u.avatar_color, u.avatar_asset_id, u.banned_at, u.ban_reason,
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
        const reports = await query(`
            select report.id, report.category, report.details, report.status, report.admin_note, report.action_taken,
                report.created_at, report.reviewed_at, report.conversation_id, report.message_id, report.reported_user_id,
                reporter.display_name as reporter_name, reporter.username as reporter_username,
                reported.display_name as reported_name, reported.username as reported_username, reported.banned_at,
                message.body as message_body, message.created_at as message_created_at,
                attachment.id as attachment_id, attachment.file_name, attachment.mime_type, attachment.size_bytes,
                conversation.moderation_locked, conversation.moderation_notice
            from content_reports report
            join users reporter on reporter.id = report.reporter_user_id
            join users reported on reported.id = report.reported_user_id
            join conversations conversation on conversation.id = report.conversation_id
            join messages message on message.id = report.message_id
            left join lateral (
                select id, file_name, mime_type, size_bytes
                from message_attachments
                where message_id = report.message_id
                limit 1
            ) attachment on true
            order by case when report.status = 'open' then 0 else 1 end, report.created_at desc
            limit 100
        `);
        let news = { rows: [] };
        let warning = '';
        try {
            news = await query(`
                select id, author_name, audience, body, image_file_name, image_mime_type, image_size_bytes,
                    video_file_name, video_mime_type, video_size_bytes, created_at,
                    case when image_data is null then null else '/admin/api/news/' || id || '/image' end as image_url,
                    case when video_data is null then null else '/admin/api/news/' || id || '/video' end as video_url
                from news_posts
                order by created_at desc
                limit 30
            `);
        } catch (error) {
            warning = `News konnten nicht geladen werden: ${error.message}`;
        }

        return res.json({
            summary: summary.rows[0],
            users: users.rows,
            avatars: avatars.rows,
            sounds: sounds.rows,
            news: news.rows,
            audit: audit.rows,
            reports: reports.rows,
            imageUpdate: getImageUpdateState(),
            warning,
        });
    } catch (error) {
        return res.status(500).json({ error: `Statistik-Abfrage fehlgeschlagen: ${error.message}` });
    }
});

app.get('/admin/api/reports/:id/attachment', requireAdminAuth, async (req, res, next) => {
    try {
        const reportId = parseId(req.params.id);
        const result = await query(
            `select attachment.file_name, attachment.mime_type, attachment.data
             from content_reports report
             join message_attachments attachment on attachment.message_id = report.message_id
             where report.id = $1
             limit 1`,
            [reportId],
        );
        if (!result.rows[0]) return res.status(404).send('Datei nicht gefunden');
        res.type(result.rows[0].mime_type);
        res.set('Content-Disposition', `inline; filename="${zipPathSegment(result.rows[0].file_name)}"`);
        res.set('Cache-Control', 'private, no-store');
        return res.send(result.rows[0].data);
    } catch (error) {
        return next(error);
    }
});

app.post('/admin/api/reports/:id/action', requireAdminAuth, async (req, res, next) => {
    try {
        const reportId = parseId(req.params.id);
        const action = String(req.body.action || '').trim();
        const note = String(req.body.note || '').trim().slice(0, 1000);
        const permitted = new Set(['lock_chat', 'unlock_chat', 'ban_user', 'unban_user', 'police_evidence', 'dismiss']);
        if (!reportId || !permitted.has(action)) return res.status(400).json({ error: 'Ungültige Maßnahme' });
        if (['lock_chat', 'unlock_chat', 'ban_user', 'unban_user'].includes(action) && !note) {
            return res.status(400).json({ error: 'Bitte schreibe eine Begründung für die Betroffenen' });
        }
        const reportResult = await query('select * from content_reports where id = $1', [reportId]);
        const report = reportResult.rows[0];
        if (!report) return res.status(404).json({ error: 'Meldung nicht gefunden' });

        let status = action === 'dismiss' ? 'dismissed' : (action === 'police_evidence' ? 'escalated' : 'actioned');
        if (action === 'lock_chat' || action === 'ban_user') {
            const notice = `Es wurden Maßnahmen eingeleitet. ${note}`;
            await query(
                `update conversations set moderation_locked = true, moderation_notice = $1, moderation_action_at = now()
                 where id = $2`,
                [notice, report.conversation_id],
            );
        }
        if (action === 'unlock_chat') {
            const notice = `Die Maßnahme wurde geprüft. Weiterchatten ist wieder möglich. ${note}`;
            await query(
                `update conversations set moderation_locked = false, moderation_notice = $1, moderation_action_at = now()
                 where id = $2`,
                [notice, report.conversation_id],
            );
        }
        if (action === 'ban_user') {
            await query(
                'update users set banned_at = now(), ban_reason = $1 where id = $2',
                [note, report.reported_user_id],
            );
        }
        if (action === 'unban_user') {
            await query(
                'update users set banned_at = null, ban_reason = null where id = $1',
                [report.reported_user_id],
            );
        }
        await query(
            `update content_reports
             set status = $1, admin_note = $2, action_taken = $3, reviewed_at = now()
             where id = $4`,
            [status, note, action, reportId],
        );
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, `report_${reportId}_${action}`, req.ip],
        );
        const participants = await query('select user_one_id, user_two_id from conversations where id = $1', [report.conversation_id]);
        if (participants.rows[0]) {
            sendEvent(participants.rows[0].user_one_id, 'moderation:changed', { conversationId: report.conversation_id });
            sendEvent(participants.rows[0].user_two_id, 'moderation:changed', { conversationId: report.conversation_id });
        }
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.get('/admin/reports/:id/export', requireAdminAuth, async (req, res, next) => {
    try {
        const reportId = parseId(req.params.id);
        const reportResult = await query('select * from content_reports where id = $1', [reportId]);
        const report = reportResult.rows[0];
        if (!report) return res.status(404).send('Meldung nicht gefunden');
        const conversation = await query('select * from conversations where id = $1', [report.conversation_id]);
        const users = await query(
            'select id, username, display_name, email, birth_date, created_at, last_seen_at, banned_at, ban_reason from users where id in (select user_one_id from conversations where id = $1 union select user_two_id from conversations where id = $1)',
            [report.conversation_id],
        );
        const messages = await query(
            'select id, conversation_id, sender_id, body, created_at, read_at from messages where conversation_id = $1 order by created_at',
            [report.conversation_id],
        );
        const attachments = await query(
            'select id, message_id, file_name, mime_type, size_bytes, created_at, data from message_attachments where message_id in (select id from messages where conversation_id = $1) order by message_id, id',
            [report.conversation_id],
        );
        const exportedAt = new Date().toISOString();
        const attachmentMetadata = attachments.rows.map((attachment) => ({
            id: attachment.id,
            message_id: attachment.message_id,
            file_name: attachment.file_name,
            mime_type: attachment.mime_type,
            size_bytes: attachment.size_bytes,
            created_at: attachment.created_at,
            archive_path: `dateien/nachricht-${attachment.message_id}/${attachment.id}-${zipPathSegment(attachment.file_name)}`,
        }));
        const files = [{
            name: 'fall-manifest.json',
            data: Buffer.from(JSON.stringify({
                exported_at: exportedAt,
                purpose: 'Beweissicherung zu einer Inhaltsmeldung; Weitergabe nur bei berechtigtem Zweck und passender Rechtsgrundlage.',
                report,
                conversation: conversation.rows[0],
                users: users.rows,
                messages: messages.rows,
                attachments: attachmentMetadata,
            }, null, 2), 'utf8'),
        }];
        attachments.rows.forEach((attachment, index) => files.push({ name: attachmentMetadata[index].archive_path, data: attachment.data }));
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, `report_${reportId}_evidence_zip_export`, req.ip],
        );
        const archive = createZipArchive(files);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="justchat-meldung-${reportId}-${exportedAt.slice(0, 10)}.zip"`);
        return res.send(archive);
    } catch (error) {
        return next(error);
    }
});

app.get('/admin/api/news/:id/video', requireAdminAuth, async (req, res, next) => {
    try {
        const newsId = parseId(req.params.id);
        const result = await query(
            'select video_mime_type, video_data from news_posts where id = $1 and video_data is not null',
            [newsId],
        );
        if (!result.rows[0]) return res.status(404).send('Video nicht gefunden');
        res.type(result.rows[0].video_mime_type);
        res.set('Cache-Control', 'private, max-age=3600');
        return res.send(result.rows[0].video_data);
    } catch (error) {
        return next(error);
    }
});

app.get('/admin/api/news/:id/image', requireAdminAuth, async (req, res, next) => {
    try {
        const newsId = parseId(req.params.id);
        const result = await query(
            'select image_mime_type, image_data from news_posts where id = $1 and image_data is not null',
            [newsId],
        );
        if (!result.rows[0]) return res.status(404).send('Bild nicht gefunden');
        res.type(result.rows[0].image_mime_type);
        res.set('Cache-Control', 'private, max-age=3600');
        return res.send(result.rows[0].image_data);
    } catch (error) {
        return next(error);
    }
});

app.post('/admin/api/news', requireAdminAuth, async (req, res, next) => {
    try {
        const body = String(req.body.body || '').trim().slice(0, 4000);
        const image = await optimizeImageAttachment(req.body.image);
        const video = parseNewsVideoAttachment(req.body.video);
        if (!body) return res.status(400).json({ error: 'Bitte einen News-Text eingeben' });
        const result = await query(
            `insert into news_posts (author_name, audience, body, image_file_name, image_mime_type, image_size_bytes, image_data,
                video_file_name, video_mime_type, video_size_bytes, video_data)
             values ('SgobboVista', '@alle', $1, $2, $3, $4, $5, $6, $7, $8, $9)
             returning id, author_name, audience, body, image_file_name, image_mime_type, image_size_bytes,
                video_file_name, video_mime_type, video_size_bytes, created_at`,
            [body, image && image.fileName, image && image.mimeType, image && image.sizeBytes, image && image.data,
                video && video.fileName, video && video.mimeType, video && video.sizeBytes, video && video.data],
        );
        const news = result.rows[0];
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, `news_publish_${news.id}`, req.ip],
        );
        broadcastEvent('news:new', { news });
        sendNewsPushNotification(news).catch((error) => console.error('News-Push fehlgeschlagen:', error.message));
        return res.status(201).json({ news });
    } catch (error) {
        return next(error);
    }
});

app.delete('/admin/api/news/:id', requireAdminAuth, async (req, res, next) => {
    try {
        const newsId = parseId(req.params.id);
        if (!newsId) return res.status(400).json({ error: 'Ungültiger News-Beitrag' });
        const result = await query('delete from news_posts where id = $1 returning id', [newsId]);
        if (!result.rows[0]) return res.status(404).json({ error: 'News-Beitrag nicht gefunden' });
        await query(
            `insert into admin_audit_logs (admin_user, action, ip_address)
             values ($1, $2, $3)`,
            [ADMIN_USER, `news_delete_${newsId}`, req.ip],
        );
        broadcastEvent('news:deleted', { newsId });
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.post('/admin/api/image-update', requireAdminAuth, async (req, res, next) => {
    try {
        if (!IMAGE_UPDATE_WEBHOOK_URL) {
            return res.status(503).json({ error: 'IMAGE_UPDATE_WEBHOOK_URL ist nicht konfiguriert' });
        }
        if (getImageUpdateState().status === 'running') {
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
            imageUpdate: getImageUpdateState(),
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

}

module.exports = { registerAdminRoutes };
