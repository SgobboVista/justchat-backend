function registerApiRoutes(app, dependencies) {
    const {
        requireAuth, query, optimizeImageAttachment, ensureOutgoingImageAllowed, personalAvatarLimit, parseId, getUserById,
        getExistingConversation, normalizeUsername, cleanDisplayName, cleanEmail, validateCleanName,
        sendEvent, getBlockStatus, conversationPair, getConversationForUser, cleanMessage,
        findBlockedDomain, parseAttachment, parseNewsVideoAttachment, addEventClient, PUSH_ENABLED, parseBirthDate, isAtLeastAge, getMailer,
        encryptText, decryptText, encryptBuffer, decryptMessageRows, decryptAttachmentRows,
    } = dependencies;
const REPORT_CATEGORIES = new Set([
    'sexual_content', 'grooming', 'child_safety', 'harassment', 'threats',
    'violence', 'hate_speech', 'fraud', 'spam', 'illegal_content', 'other',
]);

function downloadDisposition(fileName) {
    const cleanName = String(fileName || 'datei').replace(/[\r\n"]/g, '').slice(0, 180) || 'datei';
    return `attachment; filename="${cleanName}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`;
}

function privateAttachmentDownloadUrl(conversationId, attachmentId) {
    return `/api/conversations/${conversationId}/attachments/${attachmentId}/download`;
}

function groupAttachmentDownloadUrl(groupId, attachmentId) {
    return `/api/groups/${groupId}/attachments/${attachmentId}/download`;
}

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

app.get('/api/news', requireAuth, async (req, res, next) => {
    try {
        const result = await query(
            `select id, author_name, audience, body, image_file_name, image_mime_type, image_size_bytes,
                video_file_name, video_mime_type, video_size_bytes, created_at,
                case when image_data is null then null else '/api/news/' || id || '/image' end as image_url,
                case when video_data is null then null else '/api/news/' || id || '/video' end as video_url
             from news_posts
             order by created_at desc
             limit 50`,
        );
        return res.json({ news: result.rows, pushEnabled: PUSH_ENABLED });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/news/:id/video', requireAuth, async (req, res, next) => {
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

app.get('/api/news/:id/image', requireAuth, async (req, res, next) => {
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

app.post('/api/push-subscriptions', requireAuth, async (req, res, next) => {
    try {
        if (!PUSH_ENABLED) return res.status(503).json({ error: 'Push-Benachrichtigungen sind noch nicht konfiguriert' });
        const subscription = req.body.subscription;
        const endpoint = String(subscription && subscription.endpoint || '').trim();
        if (!endpoint) return res.status(400).json({ error: 'Push-Abo ist ungültig' });
        await query(
            `insert into push_subscriptions (user_id, endpoint, subscription)
             values ($1, $2, $3::jsonb)
             on conflict (endpoint) do update
             set user_id = excluded.user_id, subscription = excluded.subscription, updated_at = now()`,
            [req.user.id, endpoint, JSON.stringify(subscription)],
        );
        return res.status(201).json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.delete('/api/push-subscriptions', requireAuth, async (req, res, next) => {
    try {
        const endpoint = String(req.body.endpoint || '').trim();
        if (endpoint) await query('delete from push_subscriptions where user_id = $1 and endpoint = $2', [req.user.id, endpoint]);
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

app.get('/api/me/age-verification', requireAuth, async (req, res, next) => {
    try {
        const latest = await query(
            `select id, status, admin_note, created_at, reviewed_at,
                document_data is not null as document_available
             from age_verification_requests
             where user_id = $1
             order by created_at desc
             limit 1`,
            [req.user.id],
        );
        return res.json({
            verifiedAt: req.user.age_verified_at,
            verifiedBy: req.user.age_verified_by,
            request: latest.rows[0] || null,
        });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/me/age-verification', requireAuth, async (req, res, next) => {
    try {
        if (req.user.age_verified_at) return res.status(409).json({ error: 'Dein Alter wurde bereits verifiziert.' });
        const attachment = parseAttachment(req.body.attachment, 10 * 1024 * 1024);
        if (!attachment) return res.status(400).json({ error: 'Bitte lade ein Foto deines Ausweisdokuments hoch.' });
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(attachment.mimeType)) {
            return res.status(400).json({ error: 'Bitte lade ein JPEG-, PNG- oder WebP-Bild hoch.' });
        }
        await query(
            `update age_verification_requests
             set status = 'canceled',
                 document_file_name = null,
                 document_mime_type = null,
                 document_size_bytes = null,
                 document_data = null,
                 admin_note = 'Durch neue Einreichung ersetzt.',
                 reviewed_at = now()
             where user_id = $1 and status = 'pending'`,
            [req.user.id],
        );
        const result = await query(
            `insert into age_verification_requests
                (user_id, document_file_name, document_mime_type, document_size_bytes, document_data)
             values ($1, $2, $3, $4, $5)
             returning id, status, admin_note, created_at, reviewed_at, document_data is not null as document_available`,
            [req.user.id, attachment.fileName, attachment.mimeType, attachment.sizeBytes, attachment.data],
        );
        return res.status(201).json({ request: result.rows[0] });
    } catch (error) {
        return next(error);
    }
});

app.put('/api/me/birth-date', requireAuth, async (req, res, next) => {
    try {
        if (req.user.birth_date) {
            return res.status(409).json({ error: 'Das Geburtsdatum wurde bereits hinterlegt' });
        }
        const birthDate = parseBirthDate(req.body.birthDate);
        if (!birthDate) {
            return res.status(400).json({ error: 'Bitte gib dein gültiges Geburtsdatum ein' });
        }
        if (!isAtLeastAge(birthDate)) {
            return res.status(403).json({ error: 'JustChat ist erst ab 16 Jahren verfügbar' });
        }
        await query('update users set birth_date = $1 where id = $2 and birth_date is null', [birthDate, req.user.id]);
        const user = await getUserById(req.user.id);
        return res.json({ user });
    } catch (error) {
        return next(error);
    }
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
             order by m.created_at desc
             limit 200`,
            [req.user.id],
        );
        const visibleMessages = decryptMessageRows(messages.rows)
            .filter((message) => message.body && message.body.toLowerCase().includes(search))
            .slice(0, 30);
        return res.json({ users: users.rows, messages: visibleMessages });
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
            `select id, status, sender_id, recipient_id from contact_requests
             where (sender_id = $1 and recipient_id = $2) or (sender_id = $2 and recipient_id = $1)
             limit 1`,
            [req.user.id, user.id],
        );
        if (existing.rows[0]) {
            const request = existing.rows[0];
            if (request.status === 'pending') {
                return res.status(409).json({ error: 'Es besteht bereits eine offene Anfrage' });
            }
            if (request.status === 'blocked') {
                return res.status(403).json({ error: 'Für diesen Kontakt sind Anfragen blockiert' });
            }
            if (request.status === 'accepted') {
                return res.status(409).json({ error: 'Dieser Kontakt ist bereits in deinen Chats' });
            }
            if (request.status === 'declined') {
                const updated = await query(
                    `update contact_requests
                     set sender_id = $1, recipient_id = $2, status = 'pending',
                         archived_by_sender = false, archived_by_recipient = false,
                         created_at = now(), responded_at = null
                     where id = $3
                     returning id, status`,
                    [req.user.id, user.id, request.id],
                );
                sendEvent(user.id, 'contact:request', { userId: req.user.id });
                sendEvent(req.user.id, 'contact:request', { userId: user.id });
                return res.status(201).json({ request: updated.rows[0] });
            }
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

app.post('/api/contact-requests/:id/resend', requireAuth, async (req, res, next) => {
    try {
        const requestId = parseId(req.params.id);
        if (!requestId) return res.status(400).json({ error: 'Ungültige Anfrage' });
        const existing = await query(
            `select r.*, other_user.id as other_user_id
             from contact_requests r
             join users other_user on other_user.id = case when r.sender_id = $2 then r.recipient_id else r.sender_id end
             where r.id = $1 and $2 in (r.sender_id, r.recipient_id) and r.status = 'declined'`,
            [requestId, req.user.id],
        );
        const request = existing.rows[0];
        if (!request) return res.status(404).json({ error: 'Abgelehnte Anfrage nicht gefunden' });
        if (await getExistingConversation(req.user.id, request.other_user_id)) {
            return res.status(409).json({ error: 'Dieser Kontakt ist bereits in deinen Chats' });
        }
        const blockStatus = await getBlockStatus(req.user.id, request.other_user_id);
        if (blockStatus.blocked_by_me || blockStatus.blocked_me) {
            return res.status(403).json({ error: 'Für diesen Kontakt sind Anfragen blockiert' });
        }
        const updated = await query(
            `update contact_requests
             set sender_id = $1, recipient_id = $2, status = 'pending',
                 archived_by_sender = false, archived_by_recipient = false,
                 created_at = now(), responded_at = null
             where id = $3
             returning id, status`,
            [req.user.id, request.other_user_id, request.id],
        );
        sendEvent(request.other_user_id, 'contact:request', { userId: req.user.id });
        sendEvent(req.user.id, 'contact:request', { userId: request.other_user_id });
        return res.status(201).json({ request: updated.rows[0] });
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

app.get('/api/groups/contacts', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.query.groupId);
        const result = await query(
            `select u.id, u.username, u.display_name, u.avatar_color,
                case when aa.id is null then null else 'data:' || aa.mime_type || ';base64,' || encode(aa.data, 'base64') end as avatar_url,
                membership.role as group_role,
                invitation.status as invitation_status,
                invitation.created_at as invitation_created_at,
                invitation.responded_at as invitation_responded_at
             from conversations c
             join users u on u.id = case when c.user_one_id = $1 then c.user_two_id else c.user_one_id end
             left join avatar_assets aa on aa.id = u.avatar_asset_id and aa.is_active = true
             left join group_members membership on membership.group_id = $2 and membership.user_id = u.id
             left join group_invitations invitation on invitation.group_id = $2 and invitation.invitee_user_id = u.id
             where $1 in (c.user_one_id, c.user_two_id)
                and not exists (
                    select 1 from user_blocks b
                    where (b.blocker_id = $1 and b.blocked_user_id = u.id)
                       or (b.blocker_id = u.id and b.blocked_user_id = $1)
                )
             order by lower(u.display_name), lower(u.username)`,
            [req.user.id, groupId],
        );
        return res.json({ contacts: result.rows });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/groups', requireAuth, async (req, res, next) => {
    try {
        const result = await query(
            `select g.id, g.name, g.owner_user_id, g.created_at, g.image_updated_at,
                case when g.image_data is null then null else '/api/groups/' || g.id || '/image' end as image_url,
                count(members.user_id)::int as member_count,
                latest.body as last_message, latest.created_at as last_message_at
             from group_members mine
             join chat_groups g on g.id = mine.group_id
             join group_members members on members.group_id = g.id
             left join lateral (
                select body, created_at
                from group_messages
                where group_id = g.id
                   and not exists (
                        select 1 from user_blocks b
                        where (b.blocker_id = $1 and b.blocked_user_id = group_messages.sender_id)
                           or (b.blocker_id = group_messages.sender_id and b.blocked_user_id = $1)
                   )
                order by created_at desc
                limit 1
             ) latest on true
             where mine.user_id = $1
             group by g.id, latest.body, latest.created_at
             order by latest.created_at desc nulls last, g.created_at desc`,
            [req.user.id],
        );
        result.rows.forEach((group) => {
            if (group.last_message) group.last_message = decryptText(group.last_message);
        });
        const invitations = await query(
            `select invitation.id, invitation.group_id, invitation.created_at,
                g.name, g.owner_user_id, inviter.display_name as inviter_display_name, inviter.username as inviter_username
             from group_invitations invitation
             join chat_groups g on g.id = invitation.group_id
             join users inviter on inviter.id = invitation.inviter_user_id
             where invitation.invitee_user_id = $1 and invitation.status = 'pending'
             order by invitation.created_at desc`,
            [req.user.id],
        );
        return res.json({ groups: result.rows, invitations: invitations.rows });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/groups', requireAuth, async (req, res, next) => {
    try {
        const name = String(req.body.name || '').trim().slice(0, 60);
        if (name.length < 2) return res.status(400).json({ error: 'Bitte gib einen Gruppennamen ein' });
        const memberIds = [...new Set((Array.isArray(req.body.memberIds) ? req.body.memberIds : [])
            .map((id) => parseId(id))
            .filter((id) => id && Number(id) !== Number(req.user.id)))];
        if (memberIds.length > 50) return res.status(400).json({ error: 'Eine Gruppe kann maximal 50 eingeladene Kontakte enthalten' });
        if (memberIds.length) {
            const contacts = await query(
                `select u.id
                 from conversations c
                 join users u on u.id = case when c.user_one_id = $1 then c.user_two_id else c.user_one_id end
                 where $1 in (c.user_one_id, c.user_two_id)
                    and u.id = any($2::bigint[])
                    and not exists (
                        select 1 from user_blocks b
                        where (b.blocker_id = $1 and b.blocked_user_id = u.id)
                           or (b.blocker_id = u.id and b.blocked_user_id = $1)
                    )`,
                [req.user.id, memberIds],
            );
            if (contacts.rows.length !== memberIds.length) {
                return res.status(400).json({ error: 'Du kannst nur eigene, nicht blockierte Kontakte einladen' });
            }
        }
        const created = await query(
            `insert into chat_groups (name, owner_user_id)
             values ($1, $2)
             returning id, name, owner_user_id, created_at`,
            [name, req.user.id],
        );
        const group = created.rows[0];
        await query(
            `insert into group_members (group_id, user_id, role)
             values ($1, $2, 'owner')`,
            [group.id, req.user.id],
        );
        if (memberIds.length) {
            await query(
                `insert into group_invitations (group_id, inviter_user_id, invitee_user_id)
                 select $1, $2, invited_id
                 from unnest($3::bigint[]) invited_id
                 where not exists (
                    select 1 from group_invitation_blocks b
                    where b.blocker_user_id = invited_id and b.inviter_user_id = $2
                 )`,
                [group.id, req.user.id, memberIds],
            );
        }
        [req.user.id, ...memberIds].forEach((userId) => sendEvent(userId, 'group:changed', { groupId: group.id }));
        return res.status(201).json({ group });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/groups/:id/messages', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        if (!groupId) return res.status(400).json({ error: 'Ungültige Gruppe' });
        const groupResult = await query(
            `select g.id, g.name, g.owner_user_id, g.created_at, g.image_updated_at,
                case when g.image_data is null then null else '/api/groups/' || g.id || '/image' end as image_url,
                g.media_send_policy, g.media_min_member_days,
                count(all_members.user_id)::int as member_count
             from chat_groups g
             join group_members mine on mine.group_id = g.id and mine.user_id = $2
             join group_members all_members on all_members.group_id = g.id
             where g.id = $1
             group by g.id`,
            [groupId, req.user.id],
        );
        if (!groupResult.rows[0]) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
        const messages = await query(
            `select gm.id, gm.group_id, gm.sender_id, gm.body, gm.created_at,
                u.display_name, u.username, u.avatar_color, u.created_at as member_since,
                u.age_verified_at, u.age_verified_by,
                u.id in (select early_user.id from users early_user where not early_user.email_verification_required or early_user.email_verified_at is not null order by early_user.created_at, early_user.id limit 10) as first_account,
                case when aa.id is null then null else 'data:' || aa.mime_type || ';base64,' || encode(aa.data, 'base64') end as avatar_url,
                sender_member.role as group_role,
                exists(select 1 from group_media_allowed_users allowed where allowed.group_id = gm.group_id and allowed.user_id = gm.sender_id) as media_allowed
             from group_messages gm
             join users u on u.id = gm.sender_id
             join group_members sender_member on sender_member.group_id = gm.group_id and sender_member.user_id = gm.sender_id
             left join avatar_assets aa on aa.id = u.avatar_asset_id and aa.is_active = true
             where gm.group_id = $1
                and not exists (
                    select 1 from user_blocks b
                    where (b.blocker_id = $2 and b.blocked_user_id = gm.sender_id)
                       or (b.blocker_id = gm.sender_id and b.blocked_user_id = $2)
                )
             order by gm.created_at desc
             limit 200`,
            [groupId, req.user.id],
        );
        const messageRows = decryptMessageRows(messages.rows.reverse());
        if (messageRows.length) {
            const attachments = await query(
                `select id, group_message_id, file_name, mime_type, size_bytes, data
                 from group_message_attachments
                 where group_message_id = any($1::bigint[])`,
                [messageRows.map((message) => message.id)],
            );
            const byMessage = new Map(decryptAttachmentRows(attachments.rows).map((attachment) => [String(attachment.group_message_id), {
                id: attachment.id,
                file_name: attachment.file_name,
                mime_type: attachment.mime_type,
                size_bytes: attachment.size_bytes,
                data_url: `data:${attachment.mime_type};base64,${attachment.data_base64}`,
                download_url: groupAttachmentDownloadUrl(groupId, attachment.id),
            }]));
            messageRows.forEach((message) => { message.attachment = byMessage.get(String(message.id)) || null; });
            const reportNotices = await query(
                `select group_message_id, status, admin_note, reviewed_at
                 from group_content_reports
                 where reporter_user_id = $1
                    and group_message_id = any($2::bigint[])`,
                [req.user.id, messageRows.map((message) => message.id)],
            );
            const noticesByMessage = new Map(reportNotices.rows.map((notice) => [String(notice.group_message_id), notice]));
            messageRows.forEach((message) => {
                const notice = noticesByMessage.get(String(message.id));
                message.report_notice = notice ? {
                    status: notice.status,
                    admin_note: notice.admin_note,
                    reviewed_at: notice.reviewed_at,
                } : null;
                message.reported_by_me = Boolean(notice && notice.status !== 'dismissed');
            });
        }
        return res.json({ group: groupResult.rows[0], messages: messageRows });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/groups/:id/image', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        const result = await query(
            `select g.image_mime_type, g.image_data
             from chat_groups g
             join group_members member on member.group_id = g.id and member.user_id = $2
             where g.id = $1 and g.image_data is not null`,
            [groupId, req.user.id],
        );
        if (!result.rows[0]) return res.status(404).send('Gruppenbild nicht gefunden');
        res.type(result.rows[0].image_mime_type);
        res.set('Cache-Control', 'private, max-age=3600');
        return res.send(result.rows[0].image_data);
    } catch (error) {
        return next(error);
    }
});

app.get('/api/groups/:id/attachments/:attachmentId/download', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        const attachmentId = parseId(req.params.attachmentId);
        if (!groupId || !attachmentId) return res.status(400).send('Ungültige Datei');
        const result = await query(
            `select attachment.id, attachment.file_name, attachment.mime_type, attachment.size_bytes, attachment.data
             from group_message_attachments attachment
             join group_messages message on message.id = attachment.group_message_id
             join group_members member on member.group_id = message.group_id and member.user_id = $3
             where message.group_id = $1 and attachment.id = $2`,
            [groupId, attachmentId, req.user.id],
        );
        const attachment = decryptAttachmentRows(result.rows)[0];
        if (!attachment) return res.status(404).send('Datei nicht gefunden');
        res.type(attachment.mime_type || 'application/octet-stream');
        res.set('Content-Disposition', downloadDisposition(attachment.file_name));
        res.set('Content-Length', String(attachment.data.length));
        res.set('Cache-Control', 'private, no-store');
        return res.send(attachment.data);
    } catch (error) {
        return next(error);
    }
});

app.get('/api/groups/:id/info', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        if (!groupId) return res.status(400).json({ error: 'Ungültige Gruppe' });
        const groupResult = await query(
            `select g.id, g.name, g.owner_user_id, g.created_at, g.image_updated_at,
                case when g.image_data is null then null else '/api/groups/' || g.id || '/image' end as image_url,
                g.media_send_policy, g.media_min_member_days,
                count(all_members.user_id)::int as member_count,
                case when exists (
                    select 1 from user_blocks b
                    where (b.blocker_id = $2 and b.blocked_user_id = owner.id)
                       or (b.blocker_id = owner.id and b.blocked_user_id = $2)
                ) then 'Geblockt' else owner.display_name end as owner_display_name,
                case when exists (
                    select 1 from user_blocks b
                    where (b.blocker_id = $2 and b.blocked_user_id = owner.id)
                       or (b.blocker_id = owner.id and b.blocked_user_id = $2)
                ) then null else owner.username end as owner_username
             from chat_groups g
             join group_members mine on mine.group_id = g.id and mine.user_id = $2
             join group_members all_members on all_members.group_id = g.id
             join users owner on owner.id = g.owner_user_id
             where g.id = $1
             group by g.id, owner.id`,
            [groupId, req.user.id],
        );
        if (!groupResult.rows[0]) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
        const members = await query(
            `select member.user_id, member.role, member.joined_at,
                exists(select 1 from group_media_allowed_users allowed where allowed.group_id = member.group_id and allowed.user_id = member.user_id) as media_allowed,
                case when exists (
                    select 1 from user_blocks b
                    where (b.blocker_id = $2 and b.blocked_user_id = u.id)
                       or (b.blocker_id = u.id and b.blocked_user_id = $2)
                ) then 'Geblockt' else u.display_name end as display_name,
                case when exists (
                    select 1 from user_blocks b
                    where (b.blocker_id = $2 and b.blocked_user_id = u.id)
                       or (b.blocker_id = u.id and b.blocked_user_id = $2)
                ) then null else u.username end as username
             from group_members member
             join users u on u.id = member.user_id
             where member.group_id = $1
             order by case when member.role = 'owner' then 0 else 1 end, lower(u.display_name)`,
            [groupId, req.user.id],
        );
        return res.json({ group: groupResult.rows[0], members: members.rows });
    } catch (error) {
        return next(error);
    }
});

app.put('/api/groups/:id/name', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        const name = String(req.body.name || '').trim().slice(0, 60);
        if (!groupId) return res.status(400).json({ error: 'Ungültige Gruppe' });
        if (name.length < 2) return res.status(400).json({ error: 'Bitte gib einen Gruppennamen ein' });
        const updated = await query(
            `update chat_groups
             set name = $1
             where id = $2 and owner_user_id = $3
             returning id, name, owner_user_id, created_at, image_updated_at,
                case when image_data is null then null else '/api/groups/' || id || '/image' end as image_url,
                media_send_policy, media_min_member_days`,
            [name, groupId, req.user.id],
        );
        if (!updated.rows[0]) return res.status(403).json({ error: 'Nur der Besitzer kann den Gruppennamen ändern' });
        const members = await query('select user_id from group_members where group_id = $1', [groupId]);
        members.rows.forEach((member) => sendEvent(member.user_id, 'group:changed', { groupId }));
        return res.json({ group: updated.rows[0] });
    } catch (error) {
        return next(error);
    }
});

app.put('/api/groups/:id/media-settings', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        if (!groupId) return res.status(400).json({ error: 'Ungültige Gruppe' });
        const policy = ['all', 'older_than', 'specific'].includes(req.body.policy) ? req.body.policy : 'all';
        const minDays = Math.max(0, Math.min(3650, Number(req.body.minMemberDays || 0) || 0));
        const allowedIds = [...new Set((Array.isArray(req.body.allowedUserIds) ? req.body.allowedUserIds : [])
            .map((id) => parseId(id)).filter(Boolean))];
        const owned = await query('select id from chat_groups where id = $1 and owner_user_id = $2', [groupId, req.user.id]);
        if (!owned.rows[0]) return res.status(403).json({ error: 'Nur der Besitzer kann Medienrechte ändern' });
        await query('update chat_groups set media_send_policy = $1, media_min_member_days = $2 where id = $3', [policy, minDays, groupId]);
        await query('delete from group_media_allowed_users where group_id = $1', [groupId]);
        if (policy === 'specific' && allowedIds.length) {
            await query(
                `insert into group_media_allowed_users (group_id, user_id)
                 select $1, member.user_id
                 from group_members member
                 where member.group_id = $1 and member.user_id = any($2::bigint[])
                 on conflict do nothing`,
                [groupId, allowedIds],
            );
        }
        const members = await query('select user_id from group_members where group_id = $1', [groupId]);
        members.rows.forEach((member) => sendEvent(member.user_id, 'group:changed', { groupId }));
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.put('/api/groups/:id/image', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        if (!groupId) return res.status(400).json({ error: 'Ungültige Gruppe' });
        const owned = await query('select id from chat_groups where id = $1 and owner_user_id = $2', [groupId, req.user.id]);
        if (!owned.rows[0]) return res.status(403).json({ error: 'Nur der Besitzer kann das Gruppenbild ändern' });
        const image = await optimizeImageAttachment(req.body.attachment);
        if (!image) return res.status(400).json({ error: 'Bitte wähle ein Gruppenbild aus' });
        await query(
            `update chat_groups
             set image_file_name = $1, image_mime_type = $2, image_size_bytes = $3, image_data = $4,
                image_updated_at = now()
             where id = $5`,
            [image.fileName, image.mimeType, image.sizeBytes, image.data, groupId],
        );
        const members = await query('select user_id from group_members where group_id = $1', [groupId]);
        members.rows.forEach((member) => sendEvent(member.user_id, 'group:changed', { groupId }));
        return res.json({ ok: true, imageUrl: '/api/groups/' + groupId + '/image' });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/groups/:id/members', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        if (!groupId) return res.status(400).json({ error: 'Ungültige Gruppe' });
        const ownedGroup = await query(
            'select id from chat_groups where id = $1 and owner_user_id = $2',
            [groupId, req.user.id],
        );
        if (!ownedGroup.rows[0]) return res.status(403).json({ error: 'Nur der Ersteller kann Kontakte einladen' });
        const memberIds = [...new Set((Array.isArray(req.body.memberIds) ? req.body.memberIds : [])
            .map((id) => parseId(id))
            .filter((id) => id && Number(id) !== Number(req.user.id)))];
        if (!memberIds.length) return res.status(400).json({ error: 'Bitte wähle mindestens einen Kontakt aus' });
        const contacts = await query(
            `select u.id
             from conversations c
             join users u on u.id = case when c.user_one_id = $1 then c.user_two_id else c.user_one_id end
             where $1 in (c.user_one_id, c.user_two_id)
                and u.id = any($2::bigint[])
                and not exists (
                    select 1 from user_blocks b
                    where (b.blocker_id = $1 and b.blocked_user_id = u.id)
                       or (b.blocker_id = u.id and b.blocked_user_id = $1)
                )`,
            [req.user.id, memberIds],
        );
        if (contacts.rows.length !== memberIds.length) {
            return res.status(400).json({ error: 'Du kannst nur eigene, nicht blockierte Kontakte einladen' });
        }
        const added = await query(
            `insert into group_invitations (group_id, inviter_user_id, invitee_user_id)
             select $1, $2, invited_id
             from unnest($3::bigint[]) invited_id
             where not exists (
                select 1 from group_members membership
                where membership.group_id = $1 and membership.user_id = invited_id
             )
               and not exists (
                select 1 from group_invitation_blocks b
                where b.blocker_user_id = invited_id and b.inviter_user_id = $2
             )
             on conflict (group_id, invitee_user_id) do update
             set status = 'pending', inviter_user_id = excluded.inviter_user_id, created_at = now(), responded_at = null
             where group_invitations.status not in ('pending', 'accepted', 'declined_forever')
             returning invitee_user_id as user_id`,
            [groupId, req.user.id, memberIds],
        );
        added.rows.forEach((member) => sendEvent(member.user_id, 'group:changed', { groupId }));
        sendEvent(req.user.id, 'group:changed', { groupId });
        return res.json({ addedCount: added.rows.length });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/group-invitations/:id/respond', requireAuth, async (req, res, next) => {
    try {
        const invitationId = parseId(req.params.id);
        const action = ['accept', 'decline', 'decline_forever'].includes(req.body.action) ? req.body.action : null;
        if (!invitationId || !action) return res.status(400).json({ error: 'Ungültige Aktion' });
        const result = await query(
            `select id, group_id, inviter_user_id
             from group_invitations
             where id = $1 and invitee_user_id = $2 and status = 'pending'`,
            [invitationId, req.user.id],
        );
        const invitation = result.rows[0];
        if (!invitation) return res.status(404).json({ error: 'Einladung nicht gefunden' });
        const status = action === 'accept' ? 'accepted' : action === 'decline_forever' ? 'declined_forever' : 'declined';
        await query(
            'update group_invitations set status = $1, responded_at = now() where id = $2',
            [status, invitation.id],
        );
        if (action === 'accept') {
            await query(
                `insert into group_members (group_id, user_id, role)
                 values ($1, $2, 'member')
                 on conflict (group_id, user_id) do nothing`,
                [invitation.group_id, req.user.id],
            );
        }
        if (action === 'decline_forever') {
            await query(
                `insert into group_invitation_blocks (blocker_user_id, inviter_user_id)
                 values ($1, $2)
                 on conflict (blocker_user_id, inviter_user_id) do nothing`,
                [req.user.id, invitation.inviter_user_id],
            );
        }
        sendEvent(req.user.id, 'group:changed', { groupId: invitation.group_id });
        sendEvent(invitation.inviter_user_id, 'group:changed', { groupId: invitation.group_id });
        return res.json({ ok: true, status, groupId: invitation.group_id });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/groups/:id/messages', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        const body = cleanMessage(req.body.body);
        const mimeType = String(req.body.attachment && req.body.attachment.mimeType || '').toLowerCase();
        const attachment = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)
            ? await optimizeImageAttachment(req.body.attachment)
            : ['video/mp4', 'video/webm', 'video/quicktime'].includes(mimeType)
                ? parseNewsVideoAttachment(req.body.attachment)
                : null;
        if (!groupId || (!body && !attachment)) return res.status(400).json({ error: 'Nachricht ist leer' });
        const blockedDomain = await findBlockedDomain(body);
        if (blockedDomain) {
            return res.status(400).json({
                error: 'Diese Nachricht enthaelt eine gesperrte Domain.',
                code: 'blocked_domain',
                blockedDomain,
            });
        }
        const membership = await query(
            `select member.group_id, member.joined_at, g.media_send_policy, g.media_min_member_days,
                exists(select 1 from group_media_allowed_users allowed where allowed.group_id = member.group_id and allowed.user_id = member.user_id) as media_allowed
             from group_members member
             join chat_groups g on g.id = member.group_id
             where member.group_id = $1 and member.user_id = $2`,
            [groupId, req.user.id],
        );
        if (!membership.rows[0]) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
        if (attachment) {
            if (String(attachment.mimeType).startsWith('image/')) await ensureOutgoingImageAllowed(attachment);
            const row = membership.rows[0];
            const memberDays = (Date.now() - new Date(row.joined_at).getTime()) / (24 * 60 * 60 * 1000);
            const allowed = row.media_send_policy === 'all'
                || (row.media_send_policy === 'older_than' && memberDays >= Number(row.media_min_member_days || 0))
                || (row.media_send_policy === 'specific' && row.media_allowed);
            if (!allowed) return res.status(403).json({ error: 'Du darfst in dieser Gruppe keine Medien senden' });
        }
        const inserted = await query(
            `insert into group_messages (group_id, sender_id, body)
             values ($1, $2, $3)
             returning id, group_id, sender_id, body, created_at`,
            [groupId, req.user.id, encryptText(body)],
        );
        const message = inserted.rows[0];
        message.body = decryptText(message.body);
        const senderProfile = await query(
            `select u.display_name, u.username, u.avatar_color, u.created_at as member_since,
                u.id in (select early_user.id from users early_user where not early_user.email_verification_required or early_user.email_verified_at is not null order by early_user.created_at, early_user.id limit 10) as first_account,
                case when aa.id is null then null else 'data:' || aa.mime_type || ';base64,' || encode(aa.data, 'base64') end as avatar_url,
                member.role as group_role,
                exists(select 1 from group_media_allowed_users allowed where allowed.group_id = member.group_id and allowed.user_id = member.user_id) as media_allowed
             from users u
             join group_members member on member.group_id = $2 and member.user_id = u.id
             left join avatar_assets aa on aa.id = u.avatar_asset_id and aa.is_active = true
             where u.id = $1`,
            [req.user.id, groupId],
        );
        Object.assign(message, senderProfile.rows[0] || {});
        if (attachment) {
            const stored = await query(
                `insert into group_message_attachments (group_message_id, file_name, mime_type, size_bytes, data)
                 values ($1, $2, $3, $4, $5)
                 returning id, file_name, mime_type, size_bytes, encode(data, 'base64') as data_base64`,
                [message.id, attachment.fileName, attachment.mimeType, attachment.sizeBytes, encryptBuffer(attachment.data)],
            );
            message.attachment = {
                id: stored.rows[0].id,
                file_name: stored.rows[0].file_name,
                mime_type: stored.rows[0].mime_type,
                size_bytes: stored.rows[0].size_bytes,
                data_url: `data:${stored.rows[0].mime_type};base64,${attachment.data.toString('base64')}`,
                download_url: groupAttachmentDownloadUrl(groupId, stored.rows[0].id),
            };
        } else {
            message.attachment = null;
        }
        const recipients = await query(
            `select members.user_id
             from group_members members
             where members.group_id = $1
                and not exists (
                    select 1 from user_blocks b
                    where (b.blocker_id = $2 and b.blocked_user_id = members.user_id)
                       or (b.blocker_id = members.user_id and b.blocked_user_id = $2)
                )`,
            [groupId, req.user.id],
        );
        recipients.rows.forEach((member) => sendEvent(member.user_id, 'group:message', { groupId, message }));
        return res.status(201).json({ message });
    } catch (error) {
        return next(error);
    }
});

app.delete('/api/groups/:id/messages/:messageId', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        const messageId = parseId(req.params.messageId);
        const deleted = await query(
            `delete from group_messages
             where id = $1 and group_id = $2 and sender_id = $3 and created_at >= now() - interval '60 seconds'
             returning id`,
            [messageId, groupId, req.user.id],
        );
        if (!deleted.rows[0]) return res.status(403).json({ error: 'Nachrichten können nur innerhalb einer Minute gelöscht werden' });
        const members = await query('select user_id from group_members where group_id = $1', [groupId]);
        members.rows.forEach((member) => sendEvent(member.user_id, 'group:message', { groupId }));
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/groups/:id/messages/:messageId/report', requireAuth, async (req, res, next) => {
    try {
        const groupId = parseId(req.params.id);
        const messageId = parseId(req.params.messageId);
        const category = String(req.body.category || '').trim();
        const details = String(req.body.details || '').trim().slice(0, 1000);
        if (!REPORT_CATEGORIES.has(category)) return res.status(400).json({ error: 'Bitte wähle einen Meldegrund aus' });
        const message = await query(
            `select gm.sender_id
             from group_messages gm
             join group_members member on member.group_id = gm.group_id and member.user_id = $3
             where gm.id = $1 and gm.group_id = $2`,
            [messageId, groupId, req.user.id],
        );
        if (!message.rows[0] || Number(message.rows[0].sender_id) === Number(req.user.id)) {
            return res.status(400).json({ error: 'Du kannst nur Inhalte anderer Personen melden' });
        }
        const inserted = await query(
            `insert into group_content_reports (reporter_user_id, reported_user_id, group_id, group_message_id, category, details)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (reporter_user_id, group_message_id) do nothing
             returning id`,
            [req.user.id, message.rows[0].sender_id, groupId, messageId, category, details],
        );
        if (!inserted.rows[0]) return res.status(409).json({ error: 'Diese Nachricht wurde von dir bereits gemeldet' });
        return res.status(201).json({ ok: true, reportId: inserted.rows[0].id });
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
                other_user.age_verified_at,
                other_user.age_verified_by,
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
                c.moderation_locked,
                c.moderation_notice,
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
        result.rows.forEach((row) => {
            if (row.last_message) row.last_message = decryptText(row.last_message);
        });
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
                    select id, conversation_id, sender_id, body, created_at, read_at,
                        exists(select 1 from message_favorites where message_id = messages.id and user_id = $3) as favorited_by_me
                    from messages
                    where conversation_id = $1
                       and created_at <= coalesce((select created_at from focused), now())
                    order by created_at desc
                    limit 100
                 )
                 select * from nearby order by created_at asc`,
                [conversation.id, focusMessageId, req.user.id],
            )
            : await query(
                `select * from (
                    select id, conversation_id, sender_id, body, created_at, read_at,
                        exists(select 1 from message_favorites where message_id = messages.id and user_id = $2) as favorited_by_me
                    from messages
                    where conversation_id = $1
                    order by created_at desc
                    limit 200
                 ) recent
                 order by created_at asc`,
                [conversation.id, req.user.id],
            );
        const messageRows = decryptMessageRows(messages.rows);
        const messageIds = messageRows.map((message) => message.id);

        if (messageIds.length > 0) {
            const attachments = await query(
                `select id, message_id, file_name, mime_type, size_bytes, data
                 from message_attachments
                 where message_id = any($1::bigint[])`,
                [messageIds],
            );
            const attachmentsByMessage = new Map(decryptAttachmentRows(attachments.rows).map((attachment) => [
                String(attachment.message_id),
                {
                    id: attachment.id,
                    file_name: attachment.file_name,
                    mime_type: attachment.mime_type,
                    size_bytes: attachment.size_bytes,
                    data_url: `data:${attachment.mime_type};base64,${attachment.data_base64}`,
                    download_url: privateAttachmentDownloadUrl(conversation.id, attachment.id),
                },
            ]));

            for (const message of messageRows) {
                message.attachment = attachmentsByMessage.get(String(message.id)) || null;
            }
            const reportNotices = await query(
                `select message_id, status, admin_note, reviewed_at
                 from content_reports
                 where reporter_user_id = $1
                    and message_id = any($2::bigint[])`,
                [req.user.id, messageIds],
            );
            const noticesByMessage = new Map(reportNotices.rows.map((notice) => [String(notice.message_id), notice]));
            for (const message of messageRows) {
                const notice = noticesByMessage.get(String(message.id));
                message.report_notice = notice ? {
                    status: notice.status,
                    admin_note: notice.admin_note,
                    reviewed_at: notice.reviewed_at,
                } : null;
                message.reported_by_me = Boolean(notice && notice.status !== 'dismissed');
            }
        }

        return res.json({
            conversation: {
                id: conversation.id,
                user_id: otherUser.id,
                username: otherUser.username,
                display_name: otherUser.display_name,
                age_verified_at: otherUser.age_verified_at,
                age_verified_by: otherUser.age_verified_by,
                avatar_color: otherUser.avatar_color,
                avatar_url: otherUser.avatar_url,
                first_account: otherUser.first_account,
                about: otherUser.about,
                created_at: otherUser.created_at,
                last_seen_at: otherUser.last_seen_at,
                blocked_by_me: blockStatus.blocked_by_me,
                blocked_me: blockStatus.blocked_me,
                moderation_locked: conversation.moderation_locked,
                moderation_notice: conversation.moderation_notice,
                moderation_action_at: conversation.moderation_action_at,
            },
            messages: messageRows,
        });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/conversations/:id/attachments/:attachmentId/download', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        const attachmentId = parseId(req.params.attachmentId);
        if (!conversation || !attachmentId) return res.status(404).send('Datei nicht gefunden');
        const result = await query(
            `select attachment.id, attachment.file_name, attachment.mime_type, attachment.size_bytes, attachment.data
             from message_attachments attachment
             join messages message on message.id = attachment.message_id
             where message.conversation_id = $1 and attachment.id = $2`,
            [conversation.id, attachmentId],
        );
        const attachment = decryptAttachmentRows(result.rows)[0];
        if (!attachment) return res.status(404).send('Datei nicht gefunden');
        res.type(attachment.mime_type || 'application/octet-stream');
        res.set('Content-Disposition', downloadDisposition(attachment.file_name));
        res.set('Content-Length', String(attachment.data.length));
        res.set('Cache-Control', 'private, no-store');
        return res.send(attachment.data);
    } catch (error) {
        return next(error);
    }
});

app.post('/api/conversations/:id/messages', requireAuth, async (req, res, next) => {
    try {
        const body = cleanMessage(req.body.body);
        const blockedDomain = body ? await findBlockedDomain(body) : null;
        if (blockedDomain) {
            return res.status(400).json({
                error: 'Diese Nachricht enthaelt eine gesperrte Domain.',
                code: 'blocked_domain',
                blockedDomain,
            });
        }
        const attachmentMimeType = String(req.body.attachment && req.body.attachment.mimeType || '').toLowerCase();
        const attachment = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(attachmentMimeType)
            ? await optimizeImageAttachment(req.body.attachment)
            : parseAttachment(req.body.attachment);
        if (!body && !attachment) return res.status(400).json({ error: 'Nachricht ist leer' });
        if (attachment && String(attachment.mimeType).startsWith('image/')) {
            await ensureOutgoingImageAllowed(attachment);
        }

        const conversation = await getConversationForUser(req.params.id, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Chat nicht gefunden' });
        const blockStatus = await getBlockStatus(req.user.id, conversation.other_user_id);
        if (blockStatus.blocked_by_me || blockStatus.blocked_me) {
            return res.status(403).json({ error: 'In diesem Chat sind Nachrichten blockiert' });
        }
        if (conversation.moderation_locked) {
            return res.status(403).json({
                error: conversation.moderation_notice || 'Für diesen Chat wurden Maßnahmen eingeleitet. Weitere Nachrichten sind derzeit nicht möglich.',
                code: 'moderation_locked',
            });
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
            [conversation.id, req.user.id, encryptText(body)],
        );
        const message = result.rows[0];
        message.body = decryptText(message.body);

        if (attachment) {
            const attachmentResult = await query(
                `insert into message_attachments (message_id, file_name, mime_type, size_bytes, data)
                 values ($1, $2, $3, $4, $5)
                 returning id, file_name, mime_type, size_bytes, encode(data, 'base64') as data_base64`,
                [message.id, attachment.fileName, attachment.mimeType, attachment.sizeBytes, encryptBuffer(attachment.data)],
            );
            const storedAttachment = attachmentResult.rows[0];
            message.attachment = {
                id: storedAttachment.id,
                file_name: storedAttachment.file_name,
                mime_type: storedAttachment.mime_type,
                size_bytes: storedAttachment.size_bytes,
                data_url: `data:${storedAttachment.mime_type};base64,${attachment.data.toString('base64')}`,
                download_url: privateAttachmentDownloadUrl(conversation.id, storedAttachment.id),
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

app.post('/api/conversations/:id/messages/:messageId/report', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        const messageId = parseId(req.params.messageId);
        if (!conversation || !messageId) return res.status(404).json({ error: 'Nachricht nicht gefunden' });
        const category = String(req.body.category || '').trim();
        const details = String(req.body.details || '').trim().slice(0, 1000);
        if (!REPORT_CATEGORIES.has(category)) {
            return res.status(400).json({ error: 'Bitte wähle einen Meldegrund aus' });
        }
        const message = await query(
            `select id, sender_id from messages where id = $1 and conversation_id = $2`,
            [messageId, conversation.id],
        );
        if (!message.rows[0] || Number(message.rows[0].sender_id) === Number(req.user.id)) {
            return res.status(400).json({ error: 'Du kannst nur Inhalte der anderen Person melden' });
        }
        const result = await query(
            `insert into content_reports (reporter_user_id, reported_user_id, conversation_id, message_id, category, details)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (reporter_user_id, message_id) do nothing
             returning id`,
            [req.user.id, message.rows[0].sender_id, conversation.id, messageId, category, details],
        );
        if (!result.rows[0]) return res.status(409).json({ error: 'Diese Nachricht wurde von dir bereits gemeldet' });
        return res.status(201).json({ ok: true, reportId: result.rows[0].id });
    } catch (error) {
        return next(error);
    }
});

app.put('/api/conversations/:id/messages/:messageId/favorite', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        const messageId = parseId(req.params.messageId);
        if (!conversation || !messageId) return res.status(404).json({ error: 'Nachricht nicht gefunden' });
        const message = await query('select id from messages where id = $1 and conversation_id = $2', [messageId, conversation.id]);
        if (!message.rows[0]) return res.status(404).json({ error: 'Nachricht nicht gefunden' });
        await query(
            `insert into message_favorites (user_id, message_id)
             values ($1, $2)
             on conflict (user_id, message_id) do nothing`,
            [req.user.id, messageId],
        );
        sendEvent(req.user.id, 'message:favorite', { conversationId: conversation.id });
        return res.json({ ok: true, favorite: true });
    } catch (error) {
        return next(error);
    }
});

app.delete('/api/conversations/:id/messages/:messageId/favorite', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        const messageId = parseId(req.params.messageId);
        if (!conversation || !messageId) return res.status(404).json({ error: 'Nachricht nicht gefunden' });
        await query(
            `delete from message_favorites
             where user_id = $1 and message_id = $2
                and exists(select 1 from messages where id = $2 and conversation_id = $3)`,
            [req.user.id, messageId, conversation.id],
        );
        sendEvent(req.user.id, 'message:favorite', { conversationId: conversation.id });
        return res.json({ ok: true, favorite: false });
    } catch (error) {
        return next(error);
    }
});

app.get('/api/conversations/:id/library', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Chat nicht gefunden' });
        const favorites = await query(
            `select message.id, message.sender_id, message.body, message.created_at,
                attachment.file_name, attachment.mime_type
             from message_favorites favorite
             join messages message on message.id = favorite.message_id
             left join message_attachments attachment on attachment.message_id = message.id
             where favorite.user_id = $1 and message.conversation_id = $2
             order by message.created_at desc`,
            [req.user.id, conversation.id],
        );
        const media = await query(
            `select attachment.id, attachment.message_id, attachment.file_name, attachment.mime_type,
                attachment.size_bytes, attachment.created_at, message.sender_id,
                attachment.data
             from message_attachments attachment
             join messages message on message.id = attachment.message_id
             where message.conversation_id = $1
             order by
                case
                    when attachment.mime_type like 'image/%' then 1
                    when attachment.mime_type like 'video/%' then 2
                    when attachment.mime_type like 'audio/%' then 3
                    when attachment.mime_type in ('application/pdf', 'text/plain') then 4
                    else 5
                end,
                attachment.created_at desc`,
            [conversation.id],
        );
        return res.json({
            favorites: decryptMessageRows(favorites.rows),
            media: decryptAttachmentRows(media.rows).map((attachment) => ({
                ...attachment,
                data_url: `data:${attachment.mime_type};base64,${attachment.data_base64}`,
                download_url: privateAttachmentDownloadUrl(conversation.id, attachment.id),
            })),
        });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/conversations/:id/typing', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        if (!conversation) return res.status(404).json({ error: 'Chat nicht gefunden' });
        const blockStatus = await getBlockStatus(req.user.id, conversation.other_user_id);
        if (blockStatus.blocked_by_me || blockStatus.blocked_me || conversation.moderation_locked) return res.json({ ok: true });
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

app.delete('/api/conversations/:id/messages/:messageId', requireAuth, async (req, res, next) => {
    try {
        const conversation = await getConversationForUser(req.params.id, req.user.id);
        const messageId = parseId(req.params.messageId);
        if (!conversation || !messageId) return res.status(404).json({ error: 'Nachricht nicht gefunden' });
        const deleted = await query(
            `delete from messages
             where id = $1 and conversation_id = $2 and sender_id = $3 and created_at >= now() - interval '60 seconds'
             returning id`,
            [messageId, conversation.id, req.user.id],
        );
        if (!deleted.rows[0]) return res.status(403).json({ error: 'Nachrichten können nur innerhalb einer Minute gelöscht werden' });
        sendEvent(conversation.other_user_id, 'message:deleted', { conversationId: conversation.id, messageId });
        sendEvent(req.user.id, 'message:deleted', { conversationId: conversation.id, messageId });
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

}

module.exports = { registerApiRoutes };
