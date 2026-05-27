function renderMessengerApp({ appVersion = '' } = {}) {
    return `<!doctype html>
<html lang="de">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
    <meta name="theme-color" content="#0f766e">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="default">
    <meta name="apple-mobile-web-app-title" content="JustChat">
    <link rel="manifest" href="/manifest.webmanifest">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="icon" type="image/png" sizes="32x32" href="/pwa-icon-32.png">
    <link rel="icon" type="image/png" sizes="192x192" href="/pwa-icon-192.png">
    <link rel="apple-touch-icon" href="/pwa-icon-180.png">
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
        html { height: 100%; touch-action: manipulation; }
        body { margin: 0; min-height: 100vh; touch-action: manipulation; font-family: Arial, sans-serif; background: var(--bg); color: var(--text); }
        button, input, textarea, select { font: inherit; touch-action: manipulation; }
        input, textarea, select { font-size: 16px; }
        button { cursor: pointer; border: 0; }
        .loading-shell { min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: linear-gradient(135deg, #f7fbff 0%, #edf7f4 100%); }
        .loading-card { display: grid; justify-items: center; gap: 16px; color: var(--accent); }
        .loading-brand { font-size: 34px; font-weight: 800; color: var(--text); }
        .spinner { width: 42px; height: 42px; border-radius: 50%; border: 4px solid #cfe8e5; border-top-color: var(--accent); animation: spin .85s linear infinite; }
        .loading-error { max-width: 420px; color: var(--danger); text-align: center; line-height: 1.45; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .connection-banner { position: fixed; top: 0; left: 0; right: 0; z-index: 50; min-height: 28px; padding: calc(6px + env(safe-area-inset-top)) 12px 6px; text-align: center; font-size: 13px; font-weight: 700; color: #fff; transition: transform .18s ease, opacity .18s ease; }
        .connection-banner.offline { background: #b42318; }
        .connection-banner.online { background: #138a45; }
        .connection-banner.hidden { transform: translateY(-100%); opacity: 0; }
        .auth-shell { min-height: 100vh; min-height: 100dvh; display: grid; justify-items: center; align-content: center; padding: 24px; overflow-y: auto; -webkit-overflow-scrolling: touch; background: linear-gradient(135deg, #f7fbff 0%, #edf7f4 100%); }
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
        .password-input { position: relative; }
        .password-input input { padding-right: 50px; }
        .password-toggle { position: absolute; top: 50%; right: 5px; transform: translateY(-50%); width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; padding: 0; background: transparent; color: var(--muted); }
        .password-toggle:hover { color: var(--accent); background: #eef8f6; }
        .password-toggle svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
        .password-toggle .eye-slash { display: none; }
        .password-toggle.visible .eye-slash { display: block; }
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
        .install-panel { border: 1px solid #b8ded8; border-radius: 10px; background: #eef8f6; padding: 13px; display: grid; gap: 9px; }
        .install-panel strong { color: var(--text); }
        .install-panel p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
        .install-panel .primary { width: 100%; }
        .install-status:empty { display: none; }
        .app { height: 100vh; height: 100dvh; padding-bottom: calc(86px + env(safe-area-inset-bottom)); display: grid; grid-template-columns: 360px 1fr; overflow: hidden; }
        .sidebar { background: var(--sidebar); border-right: 1px solid var(--line); display: grid; grid-template-rows: auto auto auto minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; }
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
        .search-results { display: grid; gap: 4px; max-height: min(46vh, 440px); overflow: auto; -webkit-overflow-scrolling: touch; }
        .search-group-title { padding: 8px 4px 4px; color: var(--muted); font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
        .message-result { width: 100%; display: grid; gap: 4px; padding: 10px; border-radius: 8px; background: #f7fbfa; text-align: left; }
        .message-result:hover { background: #e5f5f1; }
        .message-result-head { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; }
        .message-result-head strong { color: var(--text); }
        .message-result-preview { overflow: hidden; color: var(--text); font-size: 13px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
        .requests { border-bottom: 1px solid var(--line); padding: 10px 12px; display: grid; gap: 8px; max-height: 270px; overflow: auto; -webkit-overflow-scrolling: touch; }
        .requests h3 { margin: 0; color: var(--muted); font-size: 12px; text-transform: uppercase; }
        .request-card { border: 1px solid var(--line); border-radius: 8px; padding: 9px; background: #fff; display: grid; gap: 7px; }
        .request-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
        .request-actions { display: flex; flex-wrap: wrap; gap: 6px; }
        .request-actions button { padding: 6px 8px; border-radius: 6px; font-size: 12px; }
        .request-status { color: var(--muted); font-size: 12px; }
        .list { min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
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
        .messages { min-height: 0; padding: 22px 18px; overflow-y: auto; -webkit-overflow-scrolling: touch; display: flex; flex-direction: column; gap: 7px; background: radial-gradient(circle at top left, rgba(255,255,255,.72), transparent 32%), linear-gradient(180deg, #eaf2f6 0%, #dde8ee 100%); }
        .jump-latest { position: absolute; right: 22px; bottom: 94px; z-index: 6; width: 46px; height: 46px; border-radius: 50%; padding: 0; display: grid; place-items: center; color: #fff; background: var(--accent); box-shadow: 0 10px 24px rgba(15, 118, 110, .3); }
        .jump-latest:hover { background: var(--accent-strong); }
        .jump-latest svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
        .bubble { position: relative; max-width: min(620px, 76%); border: 1px solid rgba(15, 23, 42, .06); border-radius: 18px 18px 18px 6px; padding: 9px 11px 7px; background: var(--message-other); align-self: flex-start; overflow-wrap: anywhere; box-shadow: 0 4px 14px rgba(15, 23, 42, .06); }
        .bubble.me { border-color: rgba(15, 118, 110, .14); border-radius: 18px 18px 6px 18px; background: linear-gradient(135deg, #d9fbef 0%, #c9f3e7 100%); align-self: flex-end; }
        .bubble.search-highlight { outline: 3px solid rgba(15, 118, 110, .35); box-shadow: 0 0 0 7px rgba(15, 118, 110, .09); animation: searchPulse 1.4s ease-out 1; }
        @keyframes searchPulse { from { box-shadow: 0 0 0 14px rgba(15, 118, 110, .18); } to { box-shadow: 0 0 0 7px rgba(15, 118, 110, .09); } }
        .date-divider { width: 100%; display: flex; align-items: center; gap: 12px; margin: 12px 0 6px; color: var(--muted); font-size: 12px; font-weight: 700; }
        .date-divider::before, .date-divider::after { content: ''; flex: 1; height: 1px; background: rgba(100, 116, 139, .27); }
        .date-divider span { flex: none; padding: 4px 10px; border-radius: 999px; background: rgba(255, 255, 255, .72); }
        .message-text { display: block; color: #071125; font-size: 15.5px; line-height: 1.38; white-space: pre-wrap; }
        .message-meta-row { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-height: 22px; margin-top: 3px; }
        .message-status { color: var(--muted); font-size: 11px; white-space: nowrap; }
        .bubble img { display: block; max-width: min(420px, 100%); border-radius: 14px; margin-bottom: 8px; box-shadow: inset 0 0 0 1px rgba(15,23,42,.06); }
        .bubble video { display: block; width: min(420px, 100%); max-height: 300px; border-radius: 14px; margin-bottom: 8px; background: #000; }
        .message-image { cursor: zoom-in; }
        .message-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 3px; }
        .report-message { padding: 4px 7px; border-radius: 999px; color: #52627a; background: rgba(255, 255, 255, .45); font-size: 11px; font-weight: 700; }
        .report-message:hover { color: var(--danger); background: #fff3f2; }
        .report-notice { margin-top: 8px; padding: 8px 9px; border-radius: 8px; border: 1px solid #dbe6f6; background: #f6f8fc; color: var(--muted); font-size: 12px; line-height: 1.4; }
        .report-notice strong { display: block; color: var(--text); margin-bottom: 2px; }
        .favorite-message { width: 28px; height: 28px; display: inline-grid; place-items: center; padding: 0; border-radius: 999px; color: #94a3b8; background: rgba(255, 255, 255, .45); font-size: 15px; line-height: 1; }
        .favorite-message:hover, .favorite-message.active { color: #e11d48; background: #fff1f4; transform: translateY(-1px); }
        .attachment-link { display: flex; align-items: center; gap: 8px; color: var(--accent); font-weight: 700; text-decoration: none; padding: 9px 10px; margin-bottom: 6px; border-radius: 8px; background: rgba(15, 118, 110, .08); }
        .meta { color: var(--muted); font-size: 11px; text-align: right; }
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
        .blocked-domain-warning { border-color: #f3c6c1; background: #fff3f2; color: #8c2720; }
        .blocked-domain-warning strong { color: #7d1c17; }
        .blocked-domain-warning a { color: #7d1c17; font-weight: 700; }
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
        .feature-view { grid-row: 1 / -1; min-height: 0; overflow-y: auto; padding: 24px; background: var(--bg); }
        .feature-card { width: min(480px, 100%); margin: min(12vh, 100px) auto 0; display: grid; justify-items: center; gap: 14px; padding: 32px 24px; border: 1px solid var(--line); border-radius: 20px; background: #fff; text-align: center; }
        .feature-mark { width: 62px; height: 62px; border-radius: 20px; display: grid; place-items: center; background: #eef8f6; color: var(--accent); }
        .feature-mark svg { width: 31px; height: 31px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
        .feature-card h2 { margin: 4px 0 0; font-size: 26px; }
        .feature-card p { margin: 0; color: var(--muted); line-height: 1.5; }
        .soon-badge { padding: 6px 11px; border-radius: 999px; background: #eef8f6; color: var(--accent); font-size: 12px; font-weight: 800; text-transform: uppercase; }
        .news-view { width: min(720px, 100%); margin: 0 auto; display: grid; gap: 15px; }
        .news-view-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
        .news-view-head h2 { margin: 0; font-size: 28px; }
        .news-view-head p { margin: 5px 0 0; color: var(--muted); }
        .more-view { width: min(720px, 100%); margin: 0 auto; display: grid; gap: 15px; }
        .more-card { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 18px; display: grid; gap: 15px; }
        .more-copy { color: var(--text); line-height: 1.6; display: grid; gap: 10px; }
        .more-copy p { margin: 0; }
        .more-copy ul { margin: 0; padding-left: 20px; display: grid; gap: 6px; }
        .feature-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
        .feature-list li { border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: #f8fcfb; display: grid; gap: 4px; }
        .feature-list strong { color: var(--text); }
        .app-version { margin: 0; padding: 12px 14px; border-radius: 10px; color: var(--muted); background: #f7fbfa; font-size: 13px; font-weight: 700; text-align: center; }
        .anniversary-card { border-radius: 12px; padding: 16px; background: #eef8f6; border: 1px solid #c7e6df; display: grid; gap: 6px; }
        .anniversary-card strong { color: var(--accent-strong); font-size: 19px; }
        .news-feed { display: grid; gap: 12px; }
        .news-post { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--line); border-radius: 13px; background: #fff; }
        .news-post-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
        .news-post-author { color: var(--accent); font-weight: 800; }
        .news-post time { color: var(--muted); font-size: 12px; }
        .news-post p { margin: 0; line-height: 1.5; white-space: pre-wrap; }
        .news-post img { display: block; width: 100%; max-height: 510px; border-radius: 9px; object-fit: contain; background: #f3f6fa; }
        .news-post video { display: block; width: 100%; max-height: 410px; border-radius: 9px; background: #000; }
        .news-empty { border: 1px dashed var(--line); border-radius: 12px; padding: 28px; color: var(--muted); text-align: center; background: #fff; }
        .groups-view { width: min(720px, 100%); margin: 0 auto; display: grid; gap: 15px; }
        .groups-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
        .groups-head h2 { margin: 0; font-size: 28px; }
        .groups-head p { margin: 5px 0 0; color: var(--muted); }
        .group-create { border: 1px solid var(--line); border-radius: 13px; padding: 16px; background: #fff; display: grid; gap: 13px; }
        .group-picker { display: grid; gap: 7px; max-height: 250px; overflow-y: auto; }
        .group-picker-item { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: #f7fbfa; }
        .group-picker-item input { width: 18px; height: 18px; accent-color: var(--accent); }
        .group-picker-item span { display: grid; gap: 2px; }
        .group-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .group-invitations { display: grid; gap: 9px; }
        .group-invitation { display: grid; gap: 10px; border: 1px solid #b8ded8; border-radius: 12px; padding: 14px; background: #eef8f6; }
        .group-invitation strong { font-size: 16px; }
        .group-invitation p { margin: 0; color: var(--muted); font-size: 13px; }
        .group-invitation-actions { display: flex; gap: 7px; flex-wrap: wrap; }
        .group-invitation-actions button { padding: 9px 11px; border-radius: 8px; font-weight: 700; }
        .group-decline { color: var(--danger); background: #fff; border: 1px solid #f3c6c1; }
        .group-list { display: grid; gap: 9px; }
        .group-row { width: 100%; border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: #fff; text-align: left; display: grid; gap: 5px; }
        .group-row:hover { border-color: #b8ded8; background: #f7fbfa; }
        .group-row-head { display: flex; justify-content: space-between; gap: 12px; }
        .group-row-head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .group-room { width: min(780px, 100%); min-height: min(680px, calc(100vh - 118px)); margin: 0 auto; display: grid; grid-template-rows: auto auto minmax(280px, 1fr) auto; overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: #fff; }
        .group-room-head { padding: 12px 14px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }
        .group-info-button { min-width: 0; display: flex; align-items: center; gap: 11px; background: transparent; padding: 0; text-align: left; }
        .group-info-button:hover .group-room-title strong { color: var(--accent); }
        .group-avatar { width: 46px; height: 46px; flex: none; border-radius: 50%; object-fit: cover; display: grid; place-items: center; color: #fff; background: var(--accent); font-size: 19px; font-weight: 800; }
        .group-avatar img { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
        .group-avatar.large { width: 92px; height: 92px; font-size: 34px; }
        .group-room-title { display: grid; gap: 3px; min-width: 0; }
        .group-room-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 18px; }
        .group-room-invite { margin-left: auto; }
        .group-invite { grid-row: 2; margin: 12px; }
        .group-messages { grid-row: 3; min-height: 0; padding: 22px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 7px; background: radial-gradient(circle at top left, rgba(255,255,255,.72), transparent 32%), linear-gradient(180deg, #eaf2f6 0%, #dde8ee 100%); }
        .group-sender { display: block; color: var(--accent); font-size: 12px; font-weight: 800; margin-bottom: 4px; }
        .group-composer { grid-row: 4; display: grid; grid-template-columns: 48px minmax(0, 1fr) 48px; align-items: end; gap: 9px; padding: 11px; border-top: 1px solid var(--line); }
        .group-composer textarea { width: 100%; min-height: 48px; max-height: 110px; resize: vertical; border: 1px solid var(--line); border-radius: 24px; padding: 13px 17px; }
        .group-composer .attachment-preview { grid-column: 1 / -1; }
        .feature-view.group-room-open { padding: 0; overflow: hidden; }
        .feature-view.group-room-open .group-room { width: 100%; height: 100%; min-height: 0; margin: 0; border: 0; border-radius: 0; }
        .feature-view.group-room-open .group-room-head { min-height: 73px; padding: 14px 18px; background: var(--panel); }
        .feature-view.group-room-open .group-messages { padding: 18px; }
        .feature-view.group-room-open .group-composer { padding: 12px; gap: 10px; background: var(--panel); }
        .group-info-card { display: grid; gap: 15px; }
        .group-info-hero { display: grid; justify-items: center; gap: 8px; padding: 10px 0 14px; border-bottom: 1px solid var(--line); text-align: center; }
        .group-info-hero h3 { margin: 0; font-size: 22px; }
        .group-info-owner { margin: 0; color: var(--muted); font-size: 14px; }
        .group-picture-actions { display: grid; gap: 9px; padding: 13px; border: 1px solid var(--line); border-radius: 10px; background: #f7fbfa; }
        .group-picture-actions input { width: 100%; }
        .group-media-settings { display: grid; gap: 9px; padding: 13px; border: 1px solid var(--line); border-radius: 10px; background: #f7fbfa; }
        .group-members { display: grid; gap: 8px; }
        .group-member { display: flex; justify-content: space-between; align-items: center; gap: 12px; border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; background: #fff; }
        .group-member strong, .group-member span { display: block; }
        .group-role { color: var(--accent); font-size: 12px; font-weight: 700; }
        .tab-notice { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; position: absolute; top: 7px; left: calc(50% + 15px); box-shadow: 0 0 0 2px #fff; }
        .bottom-tabs {
            position: fixed;
            z-index: 18;
            right: 0;
            bottom: 0;
            left: 0;
            height: calc(86px + env(safe-area-inset-bottom));
            padding: 8px 10px env(safe-area-inset-bottom);
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 6px;
            border-top: 1px solid var(--line);
            background: var(--panel);
            box-shadow: 0 -1px 4px rgba(15, 23, 42, .03);
        }
        .bottom-tabs.group-chat-hidden { display: none; }
        .app.group-chat-open { padding-bottom: 0; }
        .bottom-tab {
            position: relative;
            min-width: 0;
            display: grid;
            justify-items: center;
            align-content: center;
            gap: 5px;
            background: transparent;
            color: var(--muted);
            font-size: 14px;
            font-weight: 700;
        }
        .bottom-tab svg { display: block; width: 64px; height: 37px; padding: 6px 20px; border-radius: 999px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: background .16s ease, color .16s ease; }
        .bottom-tab.active { color: var(--text); font-weight: 800; }
        .bottom-tab.active svg { color: var(--accent-strong); background: #d7eee9; }
        .bottom-tab:hover svg { background: #eef8f6; }
        .bottom-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 14px; }
        @keyframes homeFloat { to { transform: translate3d(22px, -18px, 0) scale(1.08); } }
        .chat.drop-active .messages { outline: 2px dashed var(--accent); outline-offset: -10px; background: #dff1ec; }
        .drop-hint { display: none; position: absolute; inset: 72px 18px 74px; place-items: center; pointer-events: none; z-index: 2; color: var(--accent); font-size: 18px; font-weight: 700; }
        .chat.drop-active .drop-hint { display: grid; }
        .settings-view { grid-row: 1 / -1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 24px; background: var(--bg); }
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
        .contact-library { display: grid; gap: 16px; margin: 18px 20px 0; }
        .contact-library h3 { margin: 0 0 9px; font-size: 16px; }
        .favorite-list, .media-library { display: grid; gap: 8px; }
        .favorite-item { width: 100%; display: grid; gap: 4px; padding: 10px; border: 1px solid var(--line); border-radius: 9px; background: #f8fcfb; text-align: left; }
        .favorite-item strong { color: #e11d48; font-size: 13px; }
        .favorite-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .media-section { display: grid; gap: 8px; }
        .media-section h4 { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
        .media-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
        .media-item { display: grid; gap: 5px; min-width: 0; padding: 7px; border: 1px solid var(--line); border-radius: 9px; background: #f8fcfb; color: var(--text); text-decoration: none; font-size: 11px; }
        .media-item img { width: 100%; height: 82px; border-radius: 6px; object-fit: cover; background: #e9f0f4; }
        .media-item video { width: 100%; height: 82px; border-radius: 6px; background: #e9f0f4; }
        .media-item audio { width: 100%; height: 38px; }
        .media-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .media-download { color: var(--accent); font-weight: 700; }
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
        .modal-card { width: min(560px, 100%); max-height: min(760px, 100%); overflow-y: auto; -webkit-overflow-scrolling: touch; background: #fff; border-radius: 8px; border: 1px solid var(--line); padding: 20px; box-shadow: 0 24px 80px rgba(15, 23, 42, .22); }
        .modal-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
        .birth-gate { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 22px; background: linear-gradient(145deg, #ecf7f5, #f7fbff); }
        .birth-gate-card { width: min(500px, 100%); display: grid; gap: 16px; padding: clamp(24px, 7vw, 38px); border: 1px solid #b8ded8; border-radius: 16px; background: #fff; box-shadow: 0 22px 65px rgba(15, 23, 42, .13); }
        .birth-gate-card h2 { margin: 0; font-size: clamp(27px, 8vw, 34px); }
        .birth-gate-card p { margin: 0; line-height: 1.55; color: var(--muted); }
        .age-mark { width: max-content; padding: 8px 13px; border-radius: 999px; color: #fff; background: var(--accent); font-weight: 800; }
        .moderation-notice { margin: 12px 14px 0; padding: 12px 14px; border: 1px solid #f6cd8b; border-radius: 10px; background: #fff8eb; color: #7a4c04; line-height: 1.5; font-size: 14px; }
        .image-viewer { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; touch-action: none; padding: max(18px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); background: rgba(5, 12, 22, .9); }
        .image-viewer img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; }
        .image-viewer-close { position: fixed; top: calc(14px + env(safe-area-inset-top)); right: calc(14px + env(safe-area-inset-right)); z-index: 72; width: 52px; height: 52px; border: 2px solid rgba(255, 255, 255, .88); border-radius: 50%; padding: 0; display: grid; place-items: center; color: #fff; background: rgba(9, 18, 32, .82); box-shadow: 0 6px 22px rgba(0, 0, 0, .35); font-size: 30px; line-height: 1; }
        .image-viewer-close:hover { background: rgba(30, 41, 59, .96); }
        .image-viewer-close:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
        .close-button { width: 38px; height: 38px; display: grid; place-items: center; font-size: 28px; line-height: 1; padding: 0; border-radius: 50%; }
        .segmented { display: flex; gap: 8px; flex-wrap: wrap; }
        .small { font-size: 13px; }
        .empty { height: 100%; display: grid; place-items: center; text-align: center; color: var(--muted); padding: 24px; }
        .hidden { display: none !important; }
        @media (prefers-reduced-motion: reduce) {
            .chat-home::before, .chat-home::after { animation: none; }
        }
        @media (max-width: 780px) {
            body.app-active { height: var(--app-height, 100vh); min-height: 0; overflow: hidden; }
            .auth-shell { min-height: var(--app-height, 100vh); align-content: start; overflow-y: auto; -webkit-overflow-scrolling: touch; }
            .app { height: var(--app-height, 100vh); grid-template-columns: 1fr; }
            .topbar { padding-top: calc(16px + env(safe-area-inset-top)); }
            .sidebar.chat-open { display: none; }
            .chat:not(.chat-open) { display: none; }
            .chat-head {
                min-height: 64px;
                padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
                background: var(--panel);
                box-shadow: 0 1px 3px rgba(15,23,42,.08);
            }
            .sidebar, .chat { height: 100%; }
            .messages {
                min-height: 0;
                padding: 14px 10px;
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
                overscroll-behavior-y: contain;
            }
            .bubble { max-width: 86%; border-radius: 16px 16px 16px 5px; padding: 8px 10px 6px; }
            .bubble.me { border-radius: 16px 16px 5px 16px; }
            .message-text { font-size: 15px; line-height: 1.35; }
            .message-meta-row { min-height: 21px; }
            .jump-latest { right: 16px; bottom: calc(86px + env(safe-area-inset-bottom)); }
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
            .media-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .home-card { padding: 28px 22px; border-radius: 20px; }
            .home-list-button { display: block; }
            .feature-view { padding: calc(24px + env(safe-area-inset-top)) 18px 20px; }
            .feature-view.group-room-open { padding: 0; }
            .feature-view.group-room-open .group-room-head {
                min-height: 64px;
                padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
                background: var(--panel);
                box-shadow: 0 1px 3px rgba(15,23,42,.08);
            }
            .feature-view.group-room-open .group-messages { padding: 14px 10px; }
            .feature-view.group-room-open .group-composer { padding: 10px 10px calc(10px + env(safe-area-inset-bottom)); gap: 8px; background: #f0f2f5; }
            .feature-view.group-room-open .group-composer textarea { border: 0; min-height: 48px; resize: none; }
            .feature-card { margin: clamp(28px, 12vh, 90px) auto 0; padding: 30px 22px; }
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
            <p id="loadingError" class="loading-error hidden" role="alert"></p>
            <button id="retryBoot" class="primary hidden" type="button">Erneut versuchen</button>
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
                <label for="birthDate">Geburtsdatum (JustChat ist ab 16 Jahren)</label>
                <input id="birthDate" type="date" autocomplete="bday">
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
                    <div class="password-input">
                        <input id="password" type="password" autocomplete="current-password" required minlength="6">
                        <button class="password-toggle" type="button" data-password-toggle="password" aria-label="Passwort anzeigen" title="Passwort anzeigen">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.8"></circle><path class="eye-slash" d="M3 3l18 18"></path></svg>
                        </button>
                    </div>
                </div>
                <div class="field register-only hidden">
                    <label for="passwordRepeat">Passwort wiederholen</label>
                    <div class="password-input">
                        <input id="passwordRepeat" type="password" autocomplete="new-password" minlength="6">
                        <button class="password-toggle" type="button" data-password-toggle="passwordRepeat" aria-label="Passwort anzeigen" title="Passwort anzeigen">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.8"></circle><path class="eye-slash" d="M3 3l18 18"></path></svg>
                        </button>
                    </div>
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
            <section class="install-panel" aria-label="JustChat installieren">
                <strong>JustChat als App nutzen</strong>
                <p>Installiere JustChat schon jetzt als Web-App auf deinem Startbildschirm. Eine offizielle Android-Version folgt demnächst.</p>
                <button id="installApp" class="primary" type="button">Web-App installieren</button>
                <p id="installStatus" class="install-status" role="status" aria-live="polite"></p>
            </section>
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
                        <div class="password-input">
                            <input id="resetPassword" type="password" autocomplete="new-password" minlength="6">
                            <button class="password-toggle" type="button" data-password-toggle="resetPassword" aria-label="Passwort anzeigen" title="Passwort anzeigen">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.8"></circle><path class="eye-slash" d="M3 3l18 18"></path></svg>
                            </button>
                        </div>
                    </div>
                    <div class="field">
                        <label for="resetPasswordRepeat">Passwort wiederholen</label>
                        <div class="password-input">
                            <input id="resetPasswordRepeat" type="password" autocomplete="new-password" minlength="6">
                            <button class="password-toggle" type="button" data-password-toggle="resetPasswordRepeat" aria-label="Passwort anzeigen" title="Passwort anzeigen">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.8"></circle><path class="eye-slash" d="M3 3l18 18"></path></svg>
                            </button>
                        </div>
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
            <div id="featureView" class="feature-view hidden">
                <div id="groupsView" class="groups-view hidden">
                    <div class="groups-head">
                        <div>
                            <h2>Gruppen</h2>
                            <p>Erstelle eine Gruppe und lade deine Kontakte ein.</p>
                        </div>
                        <button id="newGroup" class="primary" type="button">Neue Gruppe</button>
                    </div>
                    <form id="groupCreateForm" class="group-create hidden">
                        <div class="field">
                            <label for="groupName">Gruppenname</label>
                            <input id="groupName" maxlength="60" placeholder="z. B. Familie" required>
                        </div>
                        <div>
                            <strong>Kontakte einladen</strong>
                            <p class="muted small">Wähle Kontakte aus. Sie können die Einladung annehmen oder ablehnen.</p>
                        </div>
                        <div id="groupContactPicker" class="group-picker"></div>
                        <p id="groupCreateError" class="error"></p>
                        <div class="group-actions">
                            <button class="primary" type="submit">Gruppe erstellen</button>
                            <button id="cancelGroupCreate" class="ghost" type="button">Abbrechen</button>
                        </div>
                    </form>
                    <div id="groupInvitations" class="group-invitations"></div>
                    <div id="groupList" class="group-list"></div>
                </div>
                <div id="groupRoom" class="group-room hidden">
                    <div class="group-room-head">
                        <button id="backToGroups" class="ghost close-button" type="button" aria-label="Gruppenchat schließen" title="Schließen">&times;</button>
                        <button id="groupInfoButton" class="group-info-button" type="button" aria-label="Gruppeninfo anzeigen">
                            <div id="groupRoomImage" class="group-avatar">G</div>
                            <div class="group-room-title">
                                <strong id="groupRoomName"></strong>
                                <span id="groupRoomMembers" class="muted small"></span>
                            </div>
                        </button>
                        <button id="inviteToGroup" class="ghost group-room-invite" type="button">Einladen</button>
                    </div>
                    <form id="groupInviteForm" class="group-create group-invite hidden">
                        <strong>Weitere Kontakte einladen</strong>
                        <div id="groupInvitePicker" class="group-picker"></div>
                        <p id="groupInviteError" class="error"></p>
                        <div class="group-actions">
                            <button class="primary" type="submit">Einladen</button>
                            <button id="cancelGroupInvite" class="ghost" type="button">Abbrechen</button>
                        </div>
                    </form>
                    <div id="groupMessages" class="group-messages"></div>
                    <form id="groupComposer" class="group-composer">
                        <div id="groupBlockedDomainWarning" class="sensitive-warning blocked-domain-warning hidden" role="alert">
                            <div>
                                <strong>Nachricht blockiert</strong>
                                <p id="groupBlockedDomainText">Diese Nachricht enth&auml;lt eine nicht erlaubte Domain und kann nicht gesendet werden.</p>
                                <p>Data provided by <a href="https://github.com/SgobboVista/sgovi-banlists" target="_blank" rel="noopener">SgobboVista (sgovi-banlists)</a></p>
                            </div>
                            <div class="sensitive-actions">
                                <button id="discardBlockedGroupMessage" class="sensitive-delete" type="button">Nachricht l&ouml;schen</button>
                            </div>
                        </div>
                        <label class="file-button" title="Bild oder Video anhängen">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.4 11.1 12.3 20.2a6 6 0 0 1-8.5-8.5l9.1-9.1a4 4 0 1 1 5.7 5.7l-9.1 9.1a2 2 0 0 1-2.8-2.8l8.5-8.5"></path></svg>
                            <input id="groupAttachmentInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime">
                        </label>
                        <textarea id="groupMessageInput" maxlength="4000" placeholder="Nachricht an die Gruppe"></textarea>
                        <button class="primary send-button" type="submit" aria-label="Senden" title="Senden">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4z"></path></svg>
                        </button>
                        <p id="groupComposerError" class="error composer-error"></p>
                        <div id="groupAttachmentPreview" class="attachment-preview hidden"></div>
                    </form>
                </div>
                <div id="newsView" class="news-view hidden">
                    <div class="news-view-head">
                        <div>
                            <h2>News</h2>
                            <p>Updates von SgobboVista an @alle</p>
                        </div>
                        <button id="enableNewsPush" class="primary" type="button">Push aktivieren</button>
                    </div>
                    <p id="newsPushStatus" class="muted small"></p>
                    <div id="newsFeed" class="news-feed"></div>
                </div>
                <div id="moreView" class="more-view hidden">
                    <div class="news-view-head">
                        <div>
                            <h2>Weiteres</h2>
                            <p>Informationen zu JustChat und SgobboVista</p>
                        </div>
                    </div>
                    <div class="more-card">
                        <nav id="moreBreadcrumb" class="settings-breadcrumb" aria-label="Weiteres Pfad">
                            <strong>Weiteres</strong>
                        </nav>
                        <div id="moreOverview" class="settings-overview">
                            <button class="settings-category" type="button" data-more-category="features">
                                <span>
                                    <span class="settings-category-title">Funktionen</span>
                                    <span class="settings-category-description">Alle aktuell verfügbaren Möglichkeiten</span>
                                </span>
                                <span class="settings-category-arrow" aria-hidden="true">&rsaquo;</span>
                            </button>
                            <button class="settings-category" type="button" data-more-category="privacy">
                                <span>
                                    <span class="settings-category-title">Datenschutzbestimmungen</span>
                                    <span class="settings-category-description">Verarbeitung und Schutz deiner Daten</span>
                                </span>
                                <span class="settings-category-arrow" aria-hidden="true">&rsaquo;</span>
                            </button>
                            <button class="settings-category" type="button" data-more-category="terms">
                                <span>
                                    <span class="settings-category-title">Nutzervereinbarung</span>
                                    <span class="settings-category-description">Regeln für die Nutzung der App</span>
                                </span>
                                <span class="settings-category-arrow" aria-hidden="true">&rsaquo;</span>
                            </button>
                            <button class="settings-category" type="button" data-more-category="agb">
                                <span>
                                    <span class="settings-category-title">AGB</span>
                                    <span class="settings-category-description">Allgemeine Bedingungen des Angebots</span>
                                </span>
                                <span class="settings-category-arrow" aria-hidden="true">&rsaquo;</span>
                            </button>
                            <button class="settings-category" type="button" data-more-category="copyright">
                                <span>
                                    <span class="settings-category-title">Copyright / Urheberrechte</span>
                                    <span class="settings-category-description">Rechte an App und Inhalten</span>
                                </span>
                                <span class="settings-category-arrow" aria-hidden="true">&rsaquo;</span>
                            </button>
                            <button class="settings-category" type="button" data-more-category="anniversary">
                                <span>
                                    <span class="settings-category-title">Seitdem die App existiert</span>
                                    <span class="settings-category-description">Startdatum und jährliche Jubiläen</span>
                                </span>
                                <span class="settings-category-arrow" aria-hidden="true">&rsaquo;</span>
                            </button>
                        </div>
                        <p id="moreVersion" class="app-version">Aktuelle WebApp-Version: v${appVersion}</p>
                        <section class="settings-section more-copy hidden" data-more-panel="features">
                            <h3>Funktionen</h3>
                            <ul class="feature-list">
                                <li><strong>Private Chats</strong><span>Nachrichten, Dateianhänge, Bilder und Lesestatus mit deinen Kontakten.</span></li>
                                <li><strong>Kontakte und Privatsphäre</strong><span>Kontaktanfragen, Profilansicht, Blockieren sowie Sichtbarkeitseinstellungen.</span></li>
                                <li><strong>Gruppen</strong><span>Gruppen erstellen, Kontakte einladen oder Einladungen beantworten, Gruppenchats führen sowie Gruppeninfo und Gruppenbild verwalten.</span></li>
                                <li><strong>News von SgobboVista</strong><span>Updates an @alle mit Bildern oder Videos und optionalen Push-Benachrichtigungen.</span></li>
                                <li><strong>Suche</strong><span>Kontakte und Nachrichten schnell innerhalb der App finden.</span></li>
                                <li><strong>Domain-Schutz</strong><span>Nachrichten mit gesperrten Domains aus den SgobboVista-Banlists werden vor dem Senden blockiert.</span></li>
                                <li><strong>Bild-Schutz</strong><span>Zu sendende Chatbilder werden automatisch auf Nackt- und sexuelle Inhalte geprüft und bei Erkennung blockiert.</span></li>
                                <li><strong>Meldesystem</strong><span>Nachrichten, Dateien und Medien melden; Moderationsmaßnahmen werden im betroffenen Chat sichtbar angezeigt.</span></li>
                                <li><strong>Favoriten und Medienarchiv</strong><span>Nachrichten oder Dateien mit Herz dauerhaft behalten und Medien je Chat nach Art und Datum anzeigen.</span></li>
                                <li><strong>DSGVO-Aufbewahrung</strong><span>Chats, Meldungen und Admin-Auditdaten werden nach festen Maximalfristen automatisch bereinigt.</span></li>
                                <li><strong>Altersgrenze</strong><span>JustChat ist ab 16 Jahren verfügbar und erfordert ein Geburtsdatum zur Prüfung.</span></li>
                                <li><strong>Profilanpassung</strong><span>Anzeigename, Info, Profilbild, Benachrichtigungston und GIF-Wiedergabe verwalten.</span></li>
                                <li><strong>Sicherheit</strong><span>E-Mail-Bestätigung, Passwort-Wiederherstellung und optionale Zwei-Faktor-Anmeldung.</span></li>
                                <li><strong>Installierbare WebApp</strong><span>JustChat als App-Verknüpfung auf dem Startbildschirm verwenden.</span></li>
                                <li><strong>Weiteres</strong><span>Datenschutz, Nutzervereinbarung, AGB, Urheberrechte, App-Version und jährliche Jubiläumsanzeige.</span></li>
                            </ul>
                        </section>
                        <section class="settings-section more-copy hidden" data-more-panel="privacy">
                            <h3>Datenschutzbestimmungen</h3>
                            <p>JustChat verarbeitet Kontodaten, Profilinformationen, Kontakte, Nachrichten, Gruppendaten und von dir hochgeladene Dateien, damit die Chat-Funktionen bereitgestellt werden können.</p>
                            <p>Nachrichten, Dateien und Medien in privaten Chats und Gruppen werden nur so lange gespeichert, wie sie für die Bereitstellung, Sicherheit oder Moderation erforderlich sind. Nicht favorisierte Inhalte werden automatisch nach maximal 365 Tagen gelöscht.</p>
                            <p>Beidseitig entfernte private Chats werden maximal 30 Tage serverseitig aufbewahrt, sofern keine Meldung oder Favorisierung entgegensteht. Inhalte mit Herz bleiben erhalten, bis du die Favorisierung entfernst oder dein Konto nach den geltenden Regeln gelöscht wird.</p>
                            <p>Meldungen und Moderationsnachweise werden nur für Prüfung, Schutzmaßnahmen und berechtigte Rechtszwecke genutzt: offene Meldungen maximal 365 Tage, abgeschlossene Meldungen maximal 180 Tage nach Prüfung. Admin-Auditdaten wie Verwaltungsaktionen und IP-Hinweise werden maximal 180 Tage gespeichert.</p>
                            <p>Push-Benachrichtigungen werden nur genutzt, wenn du sie aktivierst. Blockierungen und Sichtbarkeitseinstellungen helfen dir, deine Privatsphäre selbst zu steuern.</p>
                            <p>Bitte teile in Chats nur Inhalte, die du mit den jeweiligen Empfängern teilen möchtest.</p>
                        </section>
                        <section class="settings-section more-copy hidden" data-more-panel="terms">
                            <h3>Nutzervereinbarung</h3>
                            <ul>
                                <li>Behandle andere Personen respektvoll und verwende JustChat nicht für Belästigung, Bedrohungen oder unerlaubte Inhalte.</li>
                                <li>JustChat ist eine Plattform ab 16 Jahren. Bei der Registrierung muss ein zutreffendes Geburtsdatum angegeben werden.</li>
                                <li>Nackt- oder sexuelle Bildinhalte dürfen nicht versendet werden und können automatisiert vor dem Speichern blockiert werden.</li>
                                <li>Du bist für Nachrichten und Medien verantwortlich, die du sendest oder hochlädst.</li>
                                <li>Missbrauch, Manipulation oder unberechtigter Zugriff auf Konten ist nicht gestattet.</li>
                            </ul>
                        </section>
                        <section class="settings-section more-copy hidden" data-more-panel="agb">
                            <h3>AGB</h3>
                            <p>JustChat wird von SgobboVista als Kommunikationsdienst angeboten. Für die Nutzung ist ein persönliches Konto erforderlich.</p>
                            <p>Funktionen können weiterentwickelt oder aus Sicherheitsgründen eingeschränkt werden. Bei Verstößen gegen die Nutzervereinbarung kann ein Konto eingeschränkt werden.</p>
                        </section>
                        <section class="settings-section more-copy hidden" data-more-panel="copyright">
                            <h3>Copyright / Urheberrechte</h3>
                            <p>&copy; 2026 SgobboVista. Die App-Oberfläche, Marke und von SgobboVista bereitgestellte Inhalte sind urheberrechtlich geschützt.</p>
                            <p>Nutzer behalten die Verantwortung und Rechte an eigenen Inhalten. Lade nur Medien hoch, die du verwenden und teilen darfst.</p>
                        </section>
                        <section class="settings-section more-copy hidden" data-more-panel="anniversary">
                            <h3>Seitdem die App existiert</h3>
                            <div class="anniversary-card">
                                <strong id="appAnniversaryTitle">JustChat seit 25.05.2026</strong>
                                <span id="appAnniversaryStatus"></span>
                                <span id="appAnniversaryNext" class="muted small"></span>
                            </div>
                            <p>JustChat von SgobboVista wurde am 25.05.2026 gestartet. An jedem 25. Mai zeigt die App automatisch das nächste Jahresjubiläum an.</p>
                        </section>
                    </div>
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
                <div id="moderationNotice" class="moderation-notice hidden" role="status"></div>
                <div id="messages" class="messages"></div>
                <button id="jumpLatest" class="jump-latest hidden" type="button" aria-label="Zur neuesten Nachricht springen" title="Zur neuesten Nachricht">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="m19 12-7 7-7-7"></path></svg>
                </button>
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
                    <div id="blockedDomainWarning" class="sensitive-warning blocked-domain-warning hidden" role="alert">
                        <div>
                            <strong>Nachricht blockiert</strong>
                            <p id="blockedDomainText">Diese Nachricht enth&auml;lt eine nicht erlaubte Domain und kann nicht gesendet werden.</p>
                            <p>Data provided by <a href="https://github.com/SgobboVista/sgovi-banlists" target="_blank" rel="noopener">SgobboVista (sgovi-banlists)</a></p>
                        </div>
                        <div class="sensitive-actions">
                            <button id="discardBlockedDomainMessage" class="sensitive-delete" type="button">Nachricht l&ouml;schen</button>
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
                    <div class="contact-library">
                        <section>
                            <h3>Favoriten &#10084;</h3>
                            <div id="contactFavorites" class="favorite-list"><span class="muted small">Keine Favoriten in diesem Chat.</span></div>
                        </section>
                        <section>
                            <h3>Medien und Dateien</h3>
                            <p class="muted small">Nach Art sortiert, jeweils neueste zuerst.</p>
                            <div id="contactMedia" class="media-library"><span class="muted small">Keine Medien in diesem Chat.</span></div>
                        </section>
                    </div>
                    <div class="contact-actions">
                        <p id="contactBlockInfo" class="muted small"></p>
                        <div id="contactError" class="error"></div>
                        <div class="contact-action-buttons">
                            <button id="toggleBlock" class="danger-button" type="button">Person blockieren</button>
                            <button id="deleteChat" class="danger-button" type="button">Chat bei mir löschen</button>
                        </div>
                        <p class="muted small">Nicht favorisierte Nachrichten und Medien werden nach einem Jahr gelöscht. Inhalte mit Herz bleiben erhalten.</p>
                    </div>
                </div>
            </div>
        </section>
        <nav id="bottomTabs" class="bottom-tabs" aria-label="Hauptnavigation">
            <button class="bottom-tab active" type="button" data-main-tab="chats" aria-current="page">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.8 7.8 0 0 1-8 7.5 8.8 8.8 0 0 1-3.2-.6L4 20l1.5-4a7.2 7.2 0 0 1-1.5-4.5A7.8 7.8 0 0 1 12 4a7.8 7.8 0 0 1 8 7.5z"></path></svg>
                <span>Chats</span>
            </button>
            <button class="bottom-tab" type="button" data-main-tab="groups">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 20v-2a4 4 0 0 0-8 0v2"></path><circle cx="12" cy="10" r="3.5"></circle><path d="M20 20v-2a3.4 3.4 0 0 0-2.5-3.3M16.5 7a3.2 3.2 0 0 1 0 6"></path><path d="M4 20v-2a3.4 3.4 0 0 1 2.5-3.3M7.5 7a3.2 3.2 0 0 0 0 6"></path></svg>
                <span>Gruppen</span>
                <span id="groupsNotice" class="tab-notice hidden" aria-hidden="true"></span>
            </button>
            <button class="bottom-tab" type="button" data-main-tab="news">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h13v15H6a2 2 0 0 1-2-2V5z"></path><path d="M17 9h3v9a2 2 0 0 1-2 2"></path><path d="M7 9h7M7 13h7M7 17h4"></path></svg>
                <span>News</span>
                <span id="newsNotice" class="tab-notice hidden" aria-hidden="true"></span>
            </button>
            <button class="bottom-tab" type="button" data-main-tab="more">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"></circle><circle cx="12" cy="12" r="1.4"></circle><circle cx="19" cy="12" r="1.4"></circle></svg>
                <span>Weiteres</span>
            </button>
        </nav>
    </div>

    <div id="birthDateGate" class="birth-gate hidden" role="dialog" aria-modal="true" aria-labelledby="birthDateGateTitle">
        <form id="birthDateGateForm" class="birth-gate-card">
            <span class="age-mark">Ab 16 Jahren</span>
            <h2 id="birthDateGateTitle">Geburtsdatum erforderlich</h2>
            <p>JustChat ist eine Plattform ab 16 Jahren. Bitte trage dein Geburtsdatum ein, um die App weiter nutzen zu können.</p>
            <p>Diese Angabe wird für die Altersprüfung benötigt und ist nicht für andere Nutzer sichtbar.</p>
            <div class="field">
                <label for="requiredBirthDate">Dein Geburtsdatum</label>
                <input id="requiredBirthDate" type="date" autocomplete="bday" required>
            </div>
            <div id="birthDateGateError" class="error" role="alert"></div>
            <button class="primary" type="submit">Geburtsdatum bestätigen</button>
        </form>
    </div>

    <div id="accountBanGate" class="birth-gate hidden" role="dialog" aria-modal="true" aria-labelledby="accountBanTitle">
        <div class="birth-gate-card">
            <span class="age-mark">Konto gesperrt</span>
            <h2 id="accountBanTitle">Es wurden Maßnahmen eingeleitet</h2>
            <p>Dein Konto wurde durch die Administration gesperrt.</p>
            <p id="accountBanReason"></p>
        </div>
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
    <div id="reportModal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="reportTitle">
        <form id="reportForm" class="modal-card stack">
            <div class="modal-head">
                <h2 id="reportTitle">Inhalt melden</h2>
                <button id="closeReport" class="ghost close-button" type="button" aria-label="Meldung schließen">&times;</button>
            </div>
            <p class="muted small">Melde diese Nachricht einschließlich angehängter Datei oder Medien. Der Inhalt wird für die Prüfung gespeichert.</p>
            <div class="field">
                <label for="reportCategory">Grund</label>
                <select id="reportCategory" required>
                    <option value="">Bitte auswählen</option>
                    <option value="sexual_content">Sexuelle Inhalte / Nacktbilder</option>
                    <option value="grooming">Grooming / sexuelle Kontaktanbahnung</option>
                    <option value="child_safety">Sexuelle Inhalte mit Minderjährigen</option>
                    <option value="harassment">Belästigung / Mobbing</option>
                    <option value="threats">Drohung</option>
                    <option value="violence">Gewalt / Gewaltverherrlichung</option>
                    <option value="hate_speech">Hassrede / Diskriminierung</option>
                    <option value="fraud">Betrug / Phishing</option>
                    <option value="spam">Spam</option>
                    <option value="illegal_content">Illegale Inhalte</option>
                    <option value="other">Sonstiges</option>
                </select>
            </div>
            <div class="field">
                <label for="reportDetails">Zusätzliche Beschreibung (optional)</label>
                <textarea id="reportDetails" maxlength="1000" placeholder="Was ist passiert?"></textarea>
            </div>
            <p id="reportError" class="error"></p>
            <button class="primary" type="submit">Meldung senden</button>
        </form>
    </div>
    <div id="groupInfoModal" class="modal hidden" role="dialog" aria-modal="true" aria-label="Gruppeninfo">
        <div class="modal-card group-info-card">
            <div class="modal-head">
                <h2>Gruppeninfo</h2>
                <button id="closeGroupInfo" class="ghost close-button" type="button" aria-label="Gruppeninfo schließen">&times;</button>
            </div>
            <div class="group-info-hero">
                <div id="groupInfoImage" class="group-avatar large">G</div>
                <h3 id="groupInfoName"></h3>
                <p id="groupInfoOwner" class="group-info-owner"></p>
                <p id="groupInfoCount" class="muted small"></p>
            </div>
            <div id="groupPictureActions" class="group-picture-actions hidden">
                <strong>Gruppenbild ändern</strong>
                <input id="groupPictureFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
                <button id="uploadGroupPicture" class="primary" type="button">Bild hochladen</button>
                <p class="muted small">JPEG, PNG, WebP oder GIF, maximal 20 MB.</p>
                <p id="groupPictureError" class="error"></p>
            </div>
            <div id="groupMediaSettings" class="group-media-settings hidden">
                <strong>Medien senden</strong>
                <label class="segmented"><input type="radio" name="groupMediaPolicy" value="all" checked style="width:auto;"><span>Alle Mitglieder</span></label>
                <label class="segmented"><input type="radio" name="groupMediaPolicy" value="older_than" style="width:auto;"><span>Nur Mitglieder älter als X Tage</span></label>
                <input id="groupMediaMinDays" type="number" min="0" max="3650" value="0" placeholder="Tage">
                <label class="segmented"><input type="radio" name="groupMediaPolicy" value="specific" style="width:auto;"><span>Nur bestimmte Leute</span></label>
                <div id="groupMediaAllowedPicker" class="group-picker"></div>
                <button id="saveGroupMediaSettings" class="primary" type="button">Medienrechte speichern</button>
                <p id="groupMediaSettingsError" class="error"></p>
            </div>
            <div>
                <strong>Mitglieder</strong>
                <div id="groupMemberList" class="group-members" style="margin-top: 10px;"></div>
            </div>
        </div>
    </div>
    <div id="imageViewer" class="image-viewer hidden" role="dialog" aria-modal="true" aria-label="Bildansicht">
        <button id="closeImageViewer" class="image-viewer-close" type="button" aria-label="Bild schließen" title="Schließen">&#10005;</button>
        <img id="imageViewerImage" alt="">
    </div>

    <script data-cfasync="false">
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
            blockedDomainDraft: false,
            blockedGroupDomainDraft: false,
            groupPendingAttachment: null,
            groupPendingAttachmentPreviewUrl: null,
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
            installPrompt: null,
            mainTab: 'chats',
            news: [],
            pushConfig: null,
            groups: [],
            groupInvitations: [],
            groupContacts: [],
            activeGroup: null,
            reportMessageId: null,
            reportKind: 'private',
        };

        const $ = (id) => document.getElementById(id);

        function maximumBirthDateForMinimumAge() {
            const today = new Date();
            const cutoff = new Date(today.getFullYear() - 16, today.getMonth(), today.getDate());
            const month = String(cutoff.getMonth() + 1).padStart(2, '0');
            const day = String(cutoff.getDate()).padStart(2, '0');
            return cutoff.getFullYear() + '-' + month + '-' + day;
        }

        const maximumBirthDate = maximumBirthDateForMinimumAge();
        $('birthDate').max = maximumBirthDate;
        $('requiredBirthDate').max = maximumBirthDate;

        function updateBirthDateGate() {
            const required = Boolean(state.me && !state.me.banned_at && !state.me.birth_date);
            $('birthDateGate').classList.toggle('hidden', !required);
            if (required) {
                $('requiredBirthDate').focus();
            } else {
                $('requiredBirthDate').value = '';
                $('birthDateGateError').textContent = '';
            }
            return required;
        }

        function updateAccountBanGate() {
            const banned = Boolean(state.me && state.me.banned_at);
            $('accountBanGate').classList.toggle('hidden', !banned);
            $('accountBanReason').textContent = banned
                ? (state.me.ban_reason || 'Weitere Informationen erhältst du von der Administration.')
                : '';
            return banned;
        }

        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js').catch(() => {});
            });
        }

        function appRunsStandalone() {
            return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
                || window.navigator.standalone === true;
        }

        function markWebAppInstalled() {
            $('installApp').disabled = true;
            $('installApp').textContent = 'Web-App installiert';
            $('installStatus').textContent = 'JustChat ist bereits auf deinem Startbildschirm installiert.';
        }

        window.addEventListener('beforeinstallprompt', (event) => {
            event.preventDefault();
            state.installPrompt = event;
            $('installApp').disabled = false;
        });

        window.addEventListener('appinstalled', () => {
            state.installPrompt = null;
            markWebAppInstalled();
        });

        $('installApp').addEventListener('click', async () => {
            if (appRunsStandalone()) {
                markWebAppInstalled();
                return;
            }
            if (!state.installPrompt) {
                $('installStatus').textContent = 'Falls kein Installationsdialog erscheint: Öffne das Browser-Menü und wähle "Zum Startbildschirm hinzufügen".';
                return;
            }
            state.installPrompt.prompt();
            const choice = await state.installPrompt.userChoice;
            state.installPrompt = null;
            if (choice.outcome !== 'accepted') {
                $('installStatus').textContent = 'Die Installation wurde nicht abgeschlossen. Du kannst sie jederzeit erneut starten.';
            }
        });

        if (appRunsStandalone()) markWebAppInstalled();

        ['gesturestart', 'gesturechange', 'gestureend'].forEach((name) => {
            document.addEventListener(name, (event) => event.preventDefault(), { passive: false });
        });

        function updateViewportHeight() {
            document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
        }

        updateViewportHeight();
        window.addEventListener('resize', updateViewportHeight);
        window.addEventListener('orientationchange', updateViewportHeight);

        document.querySelectorAll('[data-password-toggle]').forEach((toggle) => {
            toggle.addEventListener('click', () => {
                const password = $(toggle.dataset.passwordToggle);
                if (!password) return;
                const visible = password.type === 'password';
                password.type = visible ? 'text' : 'password';
                toggle.classList.toggle('visible', visible);
                toggle.setAttribute('aria-label', visible ? 'Passwort verbergen' : 'Passwort anzeigen');
                toggle.title = visible ? 'Passwort verbergen' : 'Passwort anzeigen';
            });
        });

        function api(path, options = {}) {
            const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
            if (state.token) headers.Authorization = 'Bearer ' + state.token;
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const requestOptions = Object.assign({}, options, { headers });
            if (controller) requestOptions.signal = controller.signal;
            let requestTimeout;
            const timeout = new Promise((resolve, reject) => {
                requestTimeout = setTimeout(() => {
                    if (controller) controller.abort();
                    reject(new Error('Server antwortet nicht'));
                }, 12000);
            });
            const request = fetch(path, requestOptions)
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
                });
            return Promise.race([request, timeout]).then(
                (data) => {
                    clearTimeout(requestTimeout);
                    return data;
                },
                (error) => {
                    clearTimeout(requestTimeout);
                    throw error;
                }
            );
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

        function isValidIbanCandidate(candidate) {
            const iban = candidate.replace(/[^A-Z0-9]/g, '');
            if (!ibanLengths[iban.slice(0, 2)] || iban.length !== ibanLengths[iban.slice(0, 2)]) return false;
            const rotated = iban.slice(4) + iban.slice(0, 4);
            const numeric = rotated.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
            let remainder = 0;
            for (let index = 0; index < numeric.length; index += 1) {
                remainder = (remainder * 10 + Number(numeric.charAt(index))) % 97;
            }
            return remainder === 1;
        }

        function containsIban(value) {
            const text = String(value || '').toUpperCase();
            const compact = text.replace(/[^A-Z0-9]/g, '');
            const readablePattern = /[A-Z]{2}\\d{2}(?:[\\s-]?[A-Z0-9]){10,30}/g;
            const compactPattern = /[A-Z]{2}\\d{2}[A-Z0-9]{11,30}/g;
            let match;
            while ((match = readablePattern.exec(text))) {
                if (isValidIbanCandidate(match[0])) return true;
            }
            while ((match = compactPattern.exec(compact))) {
                if (isValidIbanCandidate(match[0])) return true;
            }
            return false;
        }

        function hideSensitiveMessageWarning() {
            $('sensitiveMessageWarning').classList.add('hidden');
            state.sensitiveMessageApproved = false;
        }

        function isBlockedDomainError(error) {
            return Boolean(error && error.data && error.data.code === 'blocked_domain');
        }

        function blockedDomainText(domain) {
            return domain
                ? 'Die Domain "' + domain + '" ist gesperrt. Diese Nachricht kann nicht gesendet werden.'
                : 'Diese Nachricht enthaelt eine nicht erlaubte Domain und kann nicht gesendet werden.';
        }

        function hideBlockedDomainWarning() {
            state.blockedDomainDraft = false;
            $('blockedDomainWarning').classList.add('hidden');
            updateMessageControls();
        }

        function showBlockedDomainWarning(error) {
            stopTyping();
            hideSensitiveMessageWarning();
            state.blockedDomainDraft = true;
            $('blockedDomainText').textContent = blockedDomainText(error.data && error.data.blockedDomain);
            $('blockedDomainWarning').classList.remove('hidden');
            $('messageInput').disabled = true;
            $('attachmentInput').disabled = true;
            $('composer').querySelector('button[type="submit"]').disabled = true;
        }

        function hideBlockedGroupDomainWarning() {
            state.blockedGroupDomainDraft = false;
            $('groupBlockedDomainWarning').classList.add('hidden');
            $('groupMessageInput').disabled = false;
            $('groupAttachmentInput').disabled = false;
            $('groupComposer').querySelector('button[type="submit"]').disabled = false;
        }

        function showBlockedGroupDomainWarning(error) {
            state.blockedGroupDomainDraft = true;
            $('groupBlockedDomainText').textContent = blockedDomainText(error.data && error.data.blockedDomain);
            $('groupBlockedDomainWarning').classList.remove('hidden');
            $('groupMessageInput').disabled = true;
            $('groupAttachmentInput').disabled = true;
            $('groupComposer').querySelector('button[type="submit"]').disabled = true;
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
            try {
                return new Date(value).toLocaleDateString([], { dateStyle: 'long' });
            } catch (error) {
                return new Date(value).toLocaleDateString();
            }
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
            document.body.classList.remove('app-active');
            $('loading').classList.add('hidden');
            $('auth').classList.remove('hidden');
            $('messenger').classList.add('hidden');
            fetch('/api/config').then((res) => res.json()).then((config) => {
                $('googleLogin').classList.toggle('hidden', !config.googleEnabled);
            }).catch(() => {});
        }

        function showApp() {
            updateViewportHeight();
            document.body.classList.add('app-active');
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

        function selectMainTab(tab) {
            state.mainTab = tab;
            document.querySelectorAll('[data-main-tab]').forEach((button) => {
                const active = button.dataset.mainTab === tab;
                button.classList.toggle('active', active);
                if (active) button.setAttribute('aria-current', 'page');
                else button.removeAttribute('aria-current');
            });
        }

        function openFeatureView(tab) {
            stopTyping();
            setRemoteTyping(false);
            state.activeConversation = null;
            state.activeGroup = null;
            hideBlockedGroupDomainWarning();
            selectMainTab(tab);
            $('chatEmpty').classList.add('hidden');
            $('chatPane').classList.add('hidden');
            $('accountPanel').classList.add('hidden');
            $('contactPanel').classList.add('hidden');
            $('groupInfoModal').classList.add('hidden');
            $('bottomTabs').classList.remove('group-chat-hidden');
            $('messenger').classList.remove('group-chat-open');
            $('featureView').classList.remove('group-room-open');
            $('groupsView').classList.add('hidden');
            $('groupRoom').classList.add('hidden');
            $('newsView').classList.add('hidden');
            $('moreView').classList.add('hidden');
            if (tab === 'news') {
                $('newsView').classList.remove('hidden');
                $('newsNotice').classList.add('hidden');
                loadNews().catch((error) => {
                    $('newsFeed').innerHTML = '<div class="news-empty">' + escapeText(error.message) + '</div>';
                });
            } else if (tab === 'groups') {
                $('groupsView').classList.remove('hidden');
                $('groupsNotice').classList.add('hidden');
                loadGroups().catch((error) => {
                    $('groupList').innerHTML = '<div class="news-empty">' + escapeText(error.message) + '</div>';
                });
            } else {
                $('moreView').classList.remove('hidden');
                showMoreCategory();
                renderAppAnniversary();
            }
            $('featureView').classList.remove('hidden');
            $('sidebar').classList.add('chat-open');
            $('chat').classList.add('chat-open');
        }

        function renderGroups() {
            $('groupInvitations').innerHTML = state.groupInvitations.map((invitation) =>
                '<article class="group-invitation"><strong>Einladung: ' + escapeText(invitation.name) + '</strong>' +
                '<p>' + escapeText(invitation.inviter_display_name) + ' (@' + escapeText(invitation.inviter_username) + ') möchte dich zur Gruppe hinzufügen.</p>' +
                '<div class="group-invitation-actions">' +
                '<button class="primary" type="button" data-accept-group-invitation="' + invitation.id + '">Beitreten</button>' +
                '<button class="group-decline" type="button" data-decline-group-invitation="' + invitation.id + '">Ablehnen</button>' +
                '<button class="group-decline" type="button" data-block-group-invitation="' + invitation.id + '">Ablehnen und nie wieder fragen</button>' +
                '</div></article>'
            ).join('');
            $('groupList').innerHTML = state.groups.length ? state.groups.map((group) =>
                '<button class="group-row" type="button" data-group="' + group.id + '">' +
                '<span class="group-row-head"><strong>' + escapeText(group.name) + '</strong><span class="muted small">' +
                escapeText(String(group.member_count)) + ' Mitglieder</span></span>' +
                '<span class="preview">' + escapeText(group.last_message || 'Noch keine Nachrichten') + '</span></button>'
            ).join('') : '<div class="news-empty">Du bist noch in keiner Gruppe. Erstelle deine erste Gruppe.</div>';
        }

        async function loadGroups() {
            const data = await api('/api/groups');
            state.groups = data.groups || [];
            state.groupInvitations = data.invitations || [];
            $('groupsNotice').classList.toggle('hidden', !state.groupInvitations.length || state.mainTab === 'groups');
            renderGroups();
        }

        function groupContactOptions(inputName) {
            return state.groupContacts.length ? state.groupContacts.map((contact) =>
                '<label class="group-picker-item"><input type="checkbox" name="' + inputName + '" value="' + contact.id + '">' +
                '<span><strong>' + escapeText(contact.display_name) + '</strong><small class="muted">@' +
                escapeText(contact.username) + '</small></span></label>'
            ).join('') : '<p class="muted small">Füge zuerst Kontakte über Chats hinzu, um sie einzuladen.</p>';
        }

        function renderGroupContacts() {
            $('groupContactPicker').innerHTML = groupContactOptions('groupContact');
        }

        async function showGroupCreate() {
            $('groupCreateError').textContent = '';
            $('groupName').value = '';
            $('groupCreateForm').classList.remove('hidden');
            const data = await api('/api/groups/contacts');
            state.groupContacts = data.contacts || [];
            renderGroupContacts();
            $('groupName').focus();
        }

        async function showGroupInvite() {
            $('groupInviteError').textContent = '';
            const data = await api('/api/groups/contacts');
            state.groupContacts = data.contacts || [];
            $('groupInvitePicker').innerHTML = groupContactOptions('groupInviteContact');
            $('groupInviteForm').classList.remove('hidden');
        }

        function renderGroupMessages(messages) {
            $('groupMessages').innerHTML = messages.length ? messages.map((message) => {
                const mine = state.me && Number(message.sender_id) === Number(state.me.id);
                const attachment = message.attachment
                    ? (String(message.attachment.mime_type || '').startsWith('image/')
                        ? '<img class="message-image" data-chat-image="true" tabindex="0" role="button" src="' + message.attachment.data_url + '" alt="' + escapeText(message.attachment.file_name) + '">'
                        : String(message.attachment.mime_type || '').startsWith('video/')
                            ? '<video controls preload="metadata" src="' + message.attachment.data_url + '"></video>'
                            : '<a class="attachment-link" href="' + message.attachment.data_url + '" download="' + escapeText(message.attachment.file_name) + '">Datei: ' + escapeText(message.attachment.file_name) + '</a>')
                    : '';
                const canDelete = mine && (Date.now() - new Date(message.created_at).getTime()) <= 60000;
                const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                return '<div class="bubble ' + (mine ? 'me' : '') + '" data-group-message-id="' + message.id + '">' +
                    (!mine ? '<span class="group-sender">' + escapeText(message.display_name) + '</span>' : '') +
                    attachment + (message.body ? '<span class="message-text">' + escapeText(message.body) + '</span>' : '') +
                    '<div class="message-meta-row"><span class="message-status">' + escapeText(time) + '</span><div class="message-actions">' +
                    (canDelete ? '<button class="report-message" type="button" data-delete-group-message="' + message.id + '">Löschen</button>' : '') +
                    (!mine ? '<button class="report-message" type="button" data-report-group-message="' + message.id + '">Melden</button>' : '') +
                    '</div></div></div>';
            }).join('') : '<div class="news-empty">Schreibe die erste Nachricht in diese Gruppe.</div>';
            $('groupMessages').scrollTop = $('groupMessages').scrollHeight;
        }

        function renderGroupImage(slotId, group) {
            const slot = $(slotId);
            const initial = String(group && group.name || 'G').trim().slice(0, 1).toUpperCase() || 'G';
            if (!group || !group.image_url) {
                slot.textContent = initial;
                return;
            }
            const updated = group.image_updated_at ? '&v=' + encodeURIComponent(new Date(group.image_updated_at).getTime()) : '';
            slot.innerHTML = '<img src="' + group.image_url + '?token=' + encodeURIComponent(state.token) + updated + '" alt="">';
        }

        function renderGroupHeader(group) {
            $('groupRoomName').textContent = group.name;
            $('groupRoomMembers').textContent = group.member_count + ' Mitglieder';
            renderGroupImage('groupRoomImage', group);
        }

        function readGroupPicture(file) {
            if (!file) return Promise.reject(new Error('Bitte wähle ein Gruppenbild aus.'));
            if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
                return Promise.reject(new Error('Nur JPEG, PNG, WebP und GIF sind erlaubt.'));
            }
            if (file.size > 20 * 1024 * 1024) return Promise.reject(new Error('Bild muss kleiner als 20 MB sein.'));
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

        async function openGroupInfo() {
            if (!state.activeGroup) return;
            const data = await api('/api/groups/' + state.activeGroup.id + '/info');
            state.activeGroup = Object.assign({}, state.activeGroup, data.group);
            renderGroupHeader(state.activeGroup);
            renderGroupImage('groupInfoImage', data.group);
            $('groupInfoName').textContent = data.group.name;
            $('groupInfoOwner').textContent = 'Besitzer: ' + data.group.owner_display_name +
                (data.group.owner_username ? ' (@' + data.group.owner_username + ')' : '');
            $('groupInfoCount').textContent = data.group.member_count + ' Mitglieder';
            $('groupPictureActions').classList.toggle('hidden', Number(data.group.owner_user_id) !== Number(state.me.id));
            $('groupMediaSettings').classList.toggle('hidden', Number(data.group.owner_user_id) !== Number(state.me.id));
            document.querySelectorAll('input[name="groupMediaPolicy"]').forEach((input) => { input.checked = input.value === (data.group.media_send_policy || 'all'); });
            $('groupMediaMinDays').value = data.group.media_min_member_days || 0;
            $('groupMediaAllowedPicker').innerHTML = data.members.map((member) =>
                '<label class="group-picker-item"><input type="checkbox" name="groupMediaAllowed" value="' + member.user_id + '"' + (member.media_allowed ? ' checked' : '') + '>' +
                '<span><strong>' + escapeText(member.display_name) + '</strong>' + (member.username ? '<small>@' + escapeText(member.username) + '</small>' : '') + '</span></label>'
            ).join('');
            $('groupPictureError').textContent = '';
            $('groupMemberList').innerHTML = data.members.map((member) =>
                '<div class="group-member"><div><strong>' + escapeText(member.display_name) + '</strong>' +
                (member.username ? '<span class="muted small">@' + escapeText(member.username) + '</span>' : '') +
                (member.role === 'owner' ? '<span class="group-role">Besitzer</span>' : '') +
                '</div><span class="muted small">Dabei seit<br>' + escapeText(membershipText(member.joined_at)) + '</span></div>'
            ).join('');
            $('groupInfoModal').classList.remove('hidden');
        }

        async function openGroup(groupId) {
            const data = await api('/api/groups/' + groupId + '/messages');
            if (!state.activeGroup || Number(state.activeGroup.id) !== Number(data.group.id)) {
                $('groupMessageInput').value = '';
                hideBlockedGroupDomainWarning();
            }
            state.activeGroup = data.group;
            $('bottomTabs').classList.add('group-chat-hidden');
            $('messenger').classList.add('group-chat-open');
            $('featureView').classList.add('group-room-open');
            $('groupsView').classList.add('hidden');
            $('groupRoom').classList.remove('hidden');
            $('groupInviteForm').classList.add('hidden');
            $('inviteToGroup').classList.toggle('hidden', Number(data.group.owner_user_id) !== Number(state.me.id));
            renderGroupHeader(data.group);
            $('groupComposerError').textContent = '';
            renderGroupMessages(data.messages || []);
        }

        async function refreshOpenGroup(groupId) {
            if (!state.activeGroup || Number(state.activeGroup.id) !== Number(groupId)) return;
            const data = await api('/api/groups/' + groupId + '/messages');
            state.activeGroup = data.group;
            renderGroupHeader(data.group);
            renderGroupMessages(data.messages || []);
        }

        function renderNews() {
            $('newsFeed').innerHTML = state.news.length ? state.news.map((news) =>
                '<article class="news-post"><div class="news-post-head"><span class="news-post-author">' +
                escapeText(news.author_name) + ' <span class="muted">' + escapeText(news.audience) + '</span></span><time>' +
                new Date(news.created_at).toLocaleString() + '</time></div><p>' + escapeText(news.body) + '</p>' +
                (news.image_url ? '<img loading="lazy" src="' + news.image_url + '?token=' + encodeURIComponent(state.token) + '" alt="News-Bild">' : '') +
                (news.video_url ? '<video controls preload="metadata" playsinline src="' + news.video_url + '?token=' + encodeURIComponent(state.token) + '"></video>' : '') + '</article>'
            ).join('') : '<div class="news-empty">Noch keine News veröffentlicht.</div>';
        }

        async function loadNews() {
            const data = await api('/api/news');
            state.news = data.news || [];
            renderNews();
            if (!data.pushEnabled) {
                $('enableNewsPush').classList.add('hidden');
                $('newsPushStatus').textContent = 'Push-Benachrichtigungen werden demnächst aktiviert.';
            }
        }

        function urlBase64ToBytes(value) {
            const padding = '='.repeat((4 - value.length % 4) % 4);
            const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
            return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        }

        async function enableNewsPush() {
            if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
                throw new Error('Dieser Browser unterstützt keine Push-Benachrichtigungen.');
            }
            const config = state.pushConfig || await fetch('/api/config').then((response) => response.json());
            state.pushConfig = config;
            if (!config.pushEnabled || !config.vapidPublicKey) throw new Error('Push-Benachrichtigungen sind serverseitig noch nicht konfiguriert.');
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt.');
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToBytes(config.vapidPublicKey),
            });
            await api('/api/push-subscriptions', {
                method: 'POST',
                body: JSON.stringify({ subscription }),
            });
            $('newsPushStatus').textContent = 'Push-Benachrichtigungen für News sind aktiviert.';
            $('enableNewsPush').textContent = 'Push aktiviert';
            $('enableNewsPush').disabled = true;
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
            $('birthDate').required = registerMode;
            $('authSubmit').textContent = registerMode ? 'Konto erstellen' : 'Anmelden';
            $('toggleAuth').textContent = registerMode ? 'Schon ein Konto? Anmelden' : 'Neues Konto erstellen';
            $('authHint').textContent = registerMode ? 'Erstelle dein JustChat-Konto. Die Plattform ist ab 16 Jahren.' : 'Melde dich an, um deine Chats zu sehen.';
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
                '<button type="button" class="avatar-option ' + (Number(state.selectedAvatarId) === Number(avatar.id) ? 'selected' : '') + '" data-avatar="' + avatar.id + '" aria-pressed="' + (Number(state.selectedAvatarId) === Number(avatar.id) ? 'true' : 'false') + '">' +
                '<img src="' + avatar.data_url + '" alt="' + escapeText(avatar.name) + '" decoding="async" draggable="false"></button>'
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
            return state.activeConversation && !state.activeConversation.blocked_by_me && !state.activeConversation.blocked_me
                && !state.activeConversation.moderation_locked;
        }

        function updateMessageControls() {
            const enabled = Boolean(canMessageActiveConversation()) && !state.blockedDomainDraft;
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
            if (state.activeConversation.moderation_locked) {
                status.textContent = 'Nachrichten wurden durch eine Maßnahme gesperrt.';
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
            try {
                return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
            } catch (error) {
                return new Date(value).toLocaleString();
            }
        }

        function mediaCategory(mimeType) {
            const type = String(mimeType || '');
            if (type.startsWith('image/')) return { key: 'images', label: 'Bilder' };
            if (type.startsWith('video/')) return { key: 'videos', label: 'Videos' };
            if (type.startsWith('audio/')) return { key: 'audio', label: 'Audio' };
            if (type === 'application/pdf' || type.startsWith('text/')) return { key: 'documents', label: 'Dokumente' };
            return { key: 'files', label: 'Weitere Dateien' };
        }

        function renderContactLibrary(library) {
            const favorites = library.favorites || [];
            $('contactFavorites').innerHTML = favorites.length ? favorites.map((message) => {
                const author = Number(message.sender_id) === Number(state.me.id) ? 'Du' : state.activeConversation.display_name;
                const content = message.body || (message.file_name ? 'Datei: ' + message.file_name : 'Nachricht');
                const date = new Date(message.created_at).toLocaleDateString();
                return '<button class="favorite-item" type="button" data-library-message="' + message.id + '">' +
                    '<strong>&#10084; ' + escapeText(author) + ' - ' + escapeText(date) + '</strong><span>' + escapeText(content) + '</span></button>';
            }).join('') : '<span class="muted small">Keine Favoriten in diesem Chat.</span>';

            const mediaGroups = {};
            (library.media || []).forEach((attachment) => {
                const category = mediaCategory(attachment.mime_type);
                if (!mediaGroups[category.key]) mediaGroups[category.key] = { label: category.label, items: [] };
                mediaGroups[category.key].items.push(attachment);
            });
            $('contactMedia').innerHTML = Object.values(mediaGroups).map((group) =>
                '<section class="media-section"><h4>' + escapeText(group.label) + '</h4><div class="media-grid">' +
                group.items.map((attachment) => {
                    const date = new Date(attachment.created_at).toLocaleDateString();
                    const type = String(attachment.mime_type || '');
                    const preview = type.startsWith('image/')
                        ? '<img data-library-image="true" tabindex="0" role="button" src="' + attachment.data_url + '" alt="' + escapeText(attachment.file_name) + '">'
                        : type.startsWith('video/')
                            ? '<video controls preload="metadata" src="' + attachment.data_url + '"></video>'
                            : type.startsWith('audio/')
                                ? '<audio controls preload="metadata" src="' + attachment.data_url + '"></audio>'
                                : '<strong>' + escapeText(group.label.slice(0, -1) || 'Datei') + '</strong>';
                    return '<div class="media-item">' + preview + '<span>' + escapeText(attachment.file_name) + '</span><span class="muted">' +
                        escapeText(date) + '</span><a class="media-download" href="' + attachment.data_url + '" download="' +
                        escapeText(attachment.file_name) + '">Herunterladen</a></div>';
                }).join('') + '</div></section>'
            ).join('') || '<span class="muted small">Keine Medien in diesem Chat.</span>';
        }

        async function loadContactLibrary() {
            if (!state.activeConversation) return;
            $('contactFavorites').innerHTML = '<span class="muted small">Wird geladen...</span>';
            $('contactMedia').innerHTML = '<span class="muted small">Wird geladen...</span>';
            try {
                const library = await api('/api/conversations/' + state.activeConversation.id + '/library');
                renderContactLibrary(library);
            } catch (error) {
                $('contactFavorites').innerHTML = '<span class="muted small">Favoriten nicht verfügbar.</span>';
                $('contactMedia').innerHTML = '<span class="muted small">Medien nicht verfügbar.</span>';
            }
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
            loadContactLibrary();
        }

        function renderConversationList() {
            $('conversationList').innerHTML = state.conversations.map((chat) => {
                const active = state.activeConversation && state.activeConversation.id === chat.id ? ' active' : '';
                const preview = chat.moderation_locked
                    ? 'Maßnahmen eingeleitet - Chat gesperrt'
                    : ((chat.blocked_by_me || chat.blocked_me)
                        ? 'Geblockt'
                        : (chat.last_message || (chat.has_attachment ? 'Datei' : 'Noch keine Nachrichten')));
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
            return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            }[char]));
        }

        function openImageViewer(image) {
            $('imageViewerImage').src = image.currentSrc || image.src;
            $('imageViewerImage').alt = image.alt || 'Chatbild';
            $('imageViewer').classList.remove('hidden');
            $('closeImageViewer').focus();
        }

        function closeImageViewer() {
            $('imageViewer').classList.add('hidden');
            $('imageViewerImage').removeAttribute('src');
        }

        function messageDateKey(value) {
            const date = new Date(value);
            return [date.getFullYear(), date.getMonth(), date.getDate()].join('-');
        }

        function messageDateLabel(value) {
            const date = new Date(value);
            const today = new Date();
            const yesterday = new Date();
            yesterday.setDate(today.getDate() - 1);
            if (messageDateKey(date) === messageDateKey(today)) return 'Heute';
            if (messageDateKey(date) === messageDateKey(yesterday)) return 'Gestern';
            try {
                return date.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            } catch (error) {
                return date.toLocaleDateString();
            }
        }

        function scrollMessagesToEnd() {
            const container = $('messages');
            container.scrollTop = container.scrollHeight;
            window.requestAnimationFrame(() => {
                container.scrollTop = container.scrollHeight;
                updateJumpLatestButton();
            });
        }

        function isMessagesNearBottom(threshold = 120) {
            const container = $('messages');
            return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
        }

        function updateJumpLatestButton() {
            const visible = !$('chatPane').classList.contains('hidden') && !isMessagesNearBottom(140);
            $('jumpLatest').classList.toggle('hidden', !visible);
        }

        function renderMessages(messages, options = {}) {
            const shouldScroll = options.forceScroll || isMessagesNearBottom();
            let previousDateKey = '';
            $('messages').innerHTML = messages.map((message) => {
                const dateKey = messageDateKey(message.created_at);
                const divider = dateKey !== previousDateKey
                    ? '<div class="date-divider"><span>' + escapeText(messageDateLabel(message.created_at)) + '</span></div>'
                    : '';
                previousDateKey = dateKey;
                const mine = Number(message.sender_id) === Number(state.me.id);
                const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const read = mine && message.read_at ? ' - gelesen' : '';
                const attachment = message.attachment
                    ? (String(message.attachment.mime_type || '').startsWith('image/')
                        ? '<img class="message-image"' + (message.attachment.mime_type === 'image/gif' ? ' data-is-gif="true"' : '') + ' data-chat-image="true" tabindex="0" role="button" src="' + message.attachment.data_url + '" alt="' + escapeText(message.attachment.file_name) + '" title="Bild vergrößern">'
                        : '<a class="attachment-link" href="' + message.attachment.data_url + '" download="' + escapeText(message.attachment.file_name) + '">Datei: ' + escapeText(message.attachment.file_name) + '</a>')
                    : '';
                const text = message.body ? '<span class="message-text">' + escapeText(message.body) + '</span>' : '';
                const reportNotice = message.report_notice
                    ? '<div class="report-notice"><strong>Meldung geprüft</strong>Diese Meldung wurde abgewiesen.' + (message.report_notice.admin_note ? '<br>' + escapeText(message.report_notice.admin_note) : '') + '</div>'
                    : '';
                const canDelete = mine && (Date.now() - new Date(message.created_at).getTime()) <= 60000;
                return divider + '<div class="bubble ' + (mine ? 'me' : '') + '" data-message-id="' + message.id + '">' +
                    attachment + text + reportNotice +
                    '<div class="message-meta-row"><span class="message-status">' + escapeText(time + read) + '</span><div class="message-actions">' +
                    (canDelete ? '<button class="report-message" type="button" data-delete-message="' + message.id + '">Löschen</button>' : '') +
                    '<button class="favorite-message' + (message.favorited_by_me ? ' active' : '') + '" type="button" data-favorite-message="' + message.id + '" data-favorite="' + Boolean(message.favorited_by_me) + '" aria-label="' + (message.favorited_by_me ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen') + '">&#10084;</button>' +
                    (!mine ? '<button class="report-message" type="button" data-report-message="' + message.id + '">Melden</button>' : '') +
                    '</div></div>' +
                    '</div>';
            }).join('');
            applyGifPreference($('messages'));
            const selectedMessage = state.searchMessageId
                ? $('messages').querySelector('[data-message-id="' + state.searchMessageId + '"]')
                : null;
            if (selectedMessage) {
                selectedMessage.classList.add('search-highlight');
                try {
                    selectedMessage.scrollIntoView({ block: 'center', behavior: 'smooth' });
                } catch (error) {
                    selectedMessage.scrollIntoView();
                }
                state.searchMessageId = null;
                updateJumpLatestButton();
                window.requestAnimationFrame(updateJumpLatestButton);
            } else {
                if (shouldScroll) scrollMessagesToEnd();
                else updateJumpLatestButton();
                $('messages').querySelectorAll('img').forEach((image) => {
                    if (!image.complete) image.addEventListener('load', () => {
                        if (shouldScroll) scrollMessagesToEnd();
                        else updateJumpLatestButton();
                    }, { once: true });
                });
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

        function renderGroupPendingAttachment() {
            const preview = $('groupAttachmentPreview');
            if (!state.groupPendingAttachment) {
                if (state.groupPendingAttachmentPreviewUrl) URL.revokeObjectURL(state.groupPendingAttachmentPreviewUrl);
                state.groupPendingAttachmentPreviewUrl = null;
                preview.classList.add('hidden');
                preview.innerHTML = '';
                return;
            }
            if (state.groupPendingAttachmentPreviewUrl) URL.revokeObjectURL(state.groupPendingAttachmentPreviewUrl);
            state.groupPendingAttachmentPreviewUrl = String(state.groupPendingAttachment.type || '').startsWith('image/')
                ? URL.createObjectURL(state.groupPendingAttachment)
                : '';
            preview.classList.remove('hidden');
            preview.innerHTML = '<div class="attachment-info">' +
                (state.groupPendingAttachmentPreviewUrl ? '<img class="attachment-image-preview" src="' + state.groupPendingAttachmentPreviewUrl + '" alt="Vorschau">' : '') +
                '<span class="attachment-name">Datei: ' + escapeText(state.groupPendingAttachment.name) + '</span></div>' +
                '<button id="removeGroupAttachment" type="button" aria-label="Datei entfernen">&times;</button>';
        }

        function chooseGroupAttachment(file) {
            $('groupComposerError').textContent = '';
            if (!file) return;
            const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];
            if (!allowed.includes(file.type)) {
                $('groupComposerError').textContent = 'Nur Bilder und Videos sind in Gruppen erlaubt.';
                $('groupAttachmentInput').value = '';
                return;
            }
            if (file.size > 25 * 1024 * 1024) {
                $('groupComposerError').textContent = 'Medien dürfen maximal 25 MB groß sein.';
                $('groupAttachmentInput').value = '';
                return;
            }
            state.groupPendingAttachment = file;
            renderGroupPendingAttachment();
        }

        function readGroupAttachment() {
            const file = state.groupPendingAttachment || $('groupAttachmentInput').files[0];
            if (!file) return Promise.resolve(null);
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve({
                    fileName: file.name,
                    mimeType: file.type,
                    dataBase64: String(reader.result).slice(String(reader.result).indexOf(',') + 1),
                });
                reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
                reader.readAsDataURL(file);
            });
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
            updateAccountBanGate();
            updateBirthDateGate();
        }

        const settingsCategoryNames = {
            profile: 'Profil',
            privacy: 'Datenschutz',
            chat: 'Benachrichtigungen & Chat',
            security: 'Sicherheit',
        };
        const moreCategoryNames = {
            features: 'Funktionen',
            privacy: 'Datenschutzbestimmungen',
            terms: 'Nutzervereinbarung',
            agb: 'AGB',
            copyright: 'Copyright / Urheberrechte',
            anniversary: 'Seitdem die App existiert',
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

        function showMoreCategory(category) {
            const categoryName = moreCategoryNames[category] || '';
            $('moreOverview').classList.toggle('hidden', Boolean(categoryName));
            $('moreVersion').classList.toggle('hidden', Boolean(categoryName));
            document.querySelectorAll('[data-more-panel]').forEach((panel) => {
                panel.classList.toggle('hidden', panel.dataset.morePanel !== category);
            });
            $('moreBreadcrumb').classList.toggle('has-category', Boolean(categoryName));
            $('moreBreadcrumb').innerHTML = categoryName
                ? '<button type="button" data-more-home aria-label="Zur Weiteres-Übersicht">&lsaquo; Weiteres</button><span aria-hidden="true">/</span><strong>' + escapeText(categoryName) + '</strong>'
                : '<strong>Weiteres</strong>';
        }

        function renderAppAnniversary() {
            const startDate = new Date(2026, 4, 25);
            const today = new Date();
            const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            let years = date.getFullYear() - startDate.getFullYear();
            const anniversaryThisYear = new Date(date.getFullYear(), startDate.getMonth(), startDate.getDate());
            if (date < anniversaryThisYear) years -= 1;
            const anniversaryToday = years > 0 &&
                date.getMonth() === startDate.getMonth() &&
                date.getDate() === startDate.getDate();
            const nextYear = date <= anniversaryThisYear ? date.getFullYear() : date.getFullYear() + 1;
            const nextAnniversary = new Date(nextYear, startDate.getMonth(), startDate.getDate());
            const nextNumber = nextYear - startDate.getFullYear();
            $('appAnniversaryTitle').textContent = anniversaryToday
                ? 'Heute: ' + years + '. Jubiläum von JustChat'
                : 'JustChat seit 25.05.2026';
            $('appAnniversaryStatus').textContent = years > 0
                ? 'Die App besteht seit ' + years + (years === 1 ? ' Jahr.' : ' Jahren.')
                : 'Die App ist im Gründungsjahr gestartet.';
            $('appAnniversaryNext').textContent = anniversaryToday
                ? 'Danke, dass du diesen Geburtstag mit uns feierst.'
                : 'Nächstes Jubiläum: ' + nextAnniversary.toLocaleDateString('de-DE') + ' (' + nextNumber + '.)';
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
            $('featureView').classList.add('hidden');
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
            selectMainTab('chats');
            state.pendingAttachment = null;
            state.activeGroup = null;
            hideSensitiveMessageWarning();
            hideBlockedDomainWarning();
            $('attachmentInput').value = '';
            renderPendingAttachment();
            $('accountPanel').classList.add('hidden');
            $('contactPanel').classList.add('hidden');
            $('groupInfoModal').classList.add('hidden');
            $('bottomTabs').classList.remove('group-chat-hidden');
            $('messenger').classList.remove('group-chat-open');
            $('featureView').classList.remove('group-room-open');
            $('featureView').classList.add('hidden');
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
            state.activeGroup = null;
            if (!$('chatPane').classList.contains('hidden')) {
                $('moderationNotice').textContent = data.conversation.moderation_notice || '';
                $('moderationNotice').classList.toggle('hidden', !data.conversation.moderation_notice);
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
                hideBlockedDomainWarning();
                $('attachmentInput').value = '';
                renderPendingAttachment();
            }
            state.activeConversation = data.conversation;
            state.activeGroup = null;
            setRemoteTyping(false);
            selectMainTab('chats');
            $('accountPanel').classList.add('hidden');
            $('contactPanel').classList.add('hidden');
            $('groupInfoModal').classList.add('hidden');
            $('bottomTabs').classList.remove('group-chat-hidden');
            $('messenger').classList.remove('group-chat-open');
            $('featureView').classList.remove('group-room-open');
            $('featureView').classList.add('hidden');
            $('chatEmpty').classList.add('hidden');
            $('chatPane').classList.remove('hidden');
            $('sidebar').classList.add('chat-open');
            $('chat').classList.add('chat-open');
            $('chatName').textContent = data.conversation.display_name;
            $('chatUser').textContent = '@' + data.conversation.username;
            $('chatAvatarSlot').innerHTML = avatarMarkup(data.conversation, 'chatAvatar');
            $('moderationNotice').textContent = data.conversation.moderation_notice || '';
            $('moderationNotice').classList.toggle('hidden', !data.conversation.moderation_notice);
            updateMessageControls();
            renderMessages(data.messages, { forceScroll: !messageId });
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
            state.eventSource.addEventListener('message:favorite', async (event) => {
                const payload = JSON.parse(event.data);
                if (state.activeConversation && Number(state.activeConversation.id) === Number(payload.conversationId)) {
                    await refreshOpenMessages(payload.conversationId);
                    if (!$('contactPanel').classList.contains('hidden')) await loadContactLibrary();
                }
            });
            state.eventSource.addEventListener('conversation:deleted', async (event) => {
                const payload = JSON.parse(event.data);
                await loadConversations();
                if (state.activeConversation && Number(state.activeConversation.id) === Number(payload.conversationId)) {
                    showChatHome();
                }
            });
            state.eventSource.addEventListener('moderation:changed', async (event) => {
                const payload = JSON.parse(event.data);
                await loadMe();
                if (state.me.banned_at) return;
                await loadConversations();
                if (state.activeConversation && Number(state.activeConversation.id) === Number(payload.conversationId)) {
                    await refreshOpenMessages(payload.conversationId);
                }
            });
            state.eventSource.addEventListener('contact:changed', async (event) => {
                const payload = JSON.parse(event.data);
                if (!$('accountPanel').classList.contains('hidden')) await loadBlockedUsers();
                if (state.mainTab === 'groups') {
                    await loadGroups();
                    if (state.activeGroup) await refreshOpenGroup(state.activeGroup.id);
                }
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
            state.eventSource.addEventListener('news:new', async () => {
                $('newsNotice').classList.toggle('hidden', state.mainTab === 'news');
                if (state.mainTab === 'news') await loadNews();
            });
            state.eventSource.addEventListener('news:deleted', async () => {
                if (state.mainTab === 'news') await loadNews();
            });
            state.eventSource.addEventListener('group:changed', async (event) => {
                const payload = JSON.parse(event.data);
                await loadGroups();
                if (state.activeGroup && Number(state.activeGroup.id) === Number(payload.groupId)) {
                    await refreshOpenGroup(payload.groupId);
                    if (!$('groupInfoModal').classList.contains('hidden')) await openGroupInfo();
                }
            });
            state.eventSource.addEventListener('group:message', async (event) => {
                const payload = JSON.parse(event.data);
                if (state.mainTab === 'groups') {
                    await loadGroups();
                    await refreshOpenGroup(payload.groupId);
                }
            });
        }

        window.addEventListener('offline', () => showConnectionStatus(false));

        async function boot() {
            if (!state.token) return showAuth();
            if (state.bootRetryTimer) {
                clearTimeout(state.bootRetryTimer);
                state.bootRetryTimer = null;
            }
            $('loadingError').classList.add('hidden');
            $('retryBoot').classList.add('hidden');
            $('loadingStatus').textContent = 'Anmeldung wird geprüft...';
            try {
                await loadMe();
                showApp();
                if (state.me.banned_at) return;
                if (!state.me.birth_date) return;
                connectEvents();
                showConnectionStatus(true);
            } catch (error) {
                if (!error.status || error.status >= 500) {
                    showConnectionStatus(false);
                    if (!$('loading').classList.contains('hidden')) {
                        $('loadingStatus').textContent = 'Verbindung zum Server fehlgeschlagen.';
                        $('loadingError').textContent = error.message + '. Die App versucht es erneut.';
                        $('loadingError').classList.remove('hidden');
                        $('retryBoot').classList.remove('hidden');
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
                loadGroups(),
            ]).then(() => {
                if (new URLSearchParams(window.location.search).get('tab') === 'news') openFeatureView('news');
            }).catch(() => showConnectionStatus(false));
        }

        $('birthDateGateForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            $('birthDateGateError').textContent = '';
            try {
                const data = await api('/api/me/birth-date', {
                    method: 'PUT',
                    body: JSON.stringify({ birthDate: $('requiredBirthDate').value }),
                });
                state.me = data.user;
                updateBirthDateGate();
                await boot();
            } catch (error) {
                $('birthDateGateError').textContent = error.message;
            }
        });

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
                birthDate: $('birthDate').value,
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
        $('moreOverview').addEventListener('click', (event) => {
            const button = event.target.closest('[data-more-category]');
            if (button) showMoreCategory(button.dataset.moreCategory);
        });
        $('moreBreadcrumb').addEventListener('click', (event) => {
            if (event.target.closest('[data-more-home]')) showMoreCategory();
        });
        $('chatProfileButton').addEventListener('click', () => {
            if (!state.activeConversation) return;
            stopTyping();
            renderContactProfile();
            $('chatPane').classList.add('hidden');
            $('accountPanel').classList.add('hidden');
            $('contactPanel').classList.remove('hidden');
        });
        $('contactPanel').addEventListener('click', async (event) => {
            const selectedMessage = event.target.closest('[data-library-message]');
            if (selectedMessage && state.activeConversation) {
                $('contactPanel').classList.add('hidden');
                await openConversation(state.activeConversation.id, selectedMessage.dataset.libraryMessage);
                return;
            }
            const libraryImage = event.target.closest('[data-library-image]');
            if (libraryImage) {
                event.preventDefault();
                openImageViewer(libraryImage);
            }
        });
        $('contactPanel').addEventListener('keydown', (event) => {
            const libraryImage = event.target.closest('[data-library-image]');
            if (!libraryImage || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            openImageViewer(libraryImage);
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
            $('avatarPicker').querySelectorAll('[data-avatar]').forEach((option) => {
                const selected = option === button;
                option.classList.toggle('selected', selected);
                option.setAttribute('aria-pressed', selected ? 'true' : 'false');
            });
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
        $('retryBoot').addEventListener('click', () => {
            boot();
        });
        $('back').addEventListener('click', () => {
            showChatHome();
            if (window.matchMedia && window.matchMedia('(max-width: 780px)').matches) {
                $('sidebar').classList.remove('chat-open');
                $('chat').classList.remove('chat-open');
            }
        });
        $('homeChatsButton').addEventListener('click', () => {
            $('sidebar').classList.remove('chat-open');
            $('chat').classList.remove('chat-open');
        });
        $('bottomTabs').addEventListener('click', (event) => {
            const button = event.target.closest('[data-main-tab]');
            if (!button) return;
            if (button.dataset.mainTab === 'chats') {
                showChatHome();
                $('sidebar').classList.remove('chat-open');
                $('chat').classList.remove('chat-open');
                return;
            }
            state.activeConversation = null;
            state.pendingAttachment = null;
            $('attachmentInput').value = '';
            renderPendingAttachment();
            openFeatureView(button.dataset.mainTab);
        });
        $('newGroup').addEventListener('click', () => {
            showGroupCreate().catch((error) => {
                $('groupCreateError').textContent = error.message;
            });
        });
        $('cancelGroupCreate').addEventListener('click', () => {
            $('groupCreateForm').classList.add('hidden');
            $('groupCreateError').textContent = '';
        });
        $('groupCreateForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            $('groupCreateError').textContent = '';
            const memberIds = Array.from(document.querySelectorAll('input[name="groupContact"]:checked'))
                .map((input) => input.value);
            try {
                const data = await api('/api/groups', {
                    method: 'POST',
                    body: JSON.stringify({ name: $('groupName').value, memberIds }),
                });
                $('groupCreateForm').classList.add('hidden');
                await loadGroups();
                await openGroup(data.group.id);
            } catch (error) {
                $('groupCreateError').textContent = error.message;
            }
        });
        $('groupList').addEventListener('click', (event) => {
            const group = event.target.closest('[data-group]');
            if (!group) return;
            openGroup(group.dataset.group).catch((error) => {
                $('groupList').innerHTML = '<div class="news-empty">' + escapeText(error.message) + '</div>';
            });
        });
        $('backToGroups').addEventListener('click', () => {
            state.activeGroup = null;
            $('groupMessageInput').value = '';
            hideBlockedGroupDomainWarning();
            $('groupInfoModal').classList.add('hidden');
            $('bottomTabs').classList.remove('group-chat-hidden');
            $('messenger').classList.remove('group-chat-open');
            $('featureView').classList.remove('group-room-open');
            $('groupRoom').classList.add('hidden');
            $('groupsView').classList.remove('hidden');
            loadGroups().catch(() => {});
        });
        $('groupInfoButton').addEventListener('click', () => {
            openGroupInfo().catch((error) => {
                $('groupComposerError').textContent = error.message;
            });
        });
        $('closeGroupInfo').addEventListener('click', () => {
            $('groupInfoModal').classList.add('hidden');
        });
        $('groupInfoModal').addEventListener('click', (event) => {
            if (event.target === $('groupInfoModal')) $('groupInfoModal').classList.add('hidden');
        });
        $('uploadGroupPicture').addEventListener('click', async () => {
            if (!state.activeGroup) return;
            $('groupPictureError').textContent = '';
            try {
                const attachment = await readGroupPicture($('groupPictureFile').files[0]);
                await api('/api/groups/' + state.activeGroup.id + '/image', {
                    method: 'PUT',
                    body: JSON.stringify({ attachment }),
                });
                $('groupPictureFile').value = '';
                await refreshOpenGroup(state.activeGroup.id);
                await openGroupInfo();
                await loadGroups();
            } catch (error) {
                $('groupPictureError').textContent = error.message;
            }
        });
        $('saveGroupMediaSettings').addEventListener('click', async () => {
            if (!state.activeGroup) return;
            $('groupMediaSettingsError').textContent = '';
            try {
                const policy = document.querySelector('input[name="groupMediaPolicy"]:checked').value;
                const allowedUserIds = Array.from(document.querySelectorAll('input[name="groupMediaAllowed"]:checked')).map((input) => input.value);
                await api('/api/groups/' + state.activeGroup.id + '/media-settings', {
                    method: 'PUT',
                    body: JSON.stringify({
                        policy,
                        minMemberDays: $('groupMediaMinDays').value,
                        allowedUserIds,
                    }),
                });
                $('groupMediaSettingsError').textContent = 'Medienrechte wurden gespeichert.';
            } catch (error) {
                $('groupMediaSettingsError').textContent = error.message;
            }
        });
        $('inviteToGroup').addEventListener('click', () => {
            showGroupInvite().catch((error) => {
                $('groupInviteError').textContent = error.message;
            });
        });
        $('cancelGroupInvite').addEventListener('click', () => {
            $('groupInviteForm').classList.add('hidden');
            $('groupInviteError').textContent = '';
        });
        $('groupInviteForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!state.activeGroup) return;
            $('groupInviteError').textContent = '';
            const memberIds = Array.from(document.querySelectorAll('input[name="groupInviteContact"]:checked'))
                .map((input) => input.value);
            try {
                const data = await api('/api/groups/' + state.activeGroup.id + '/members', {
                    method: 'POST',
                    body: JSON.stringify({ memberIds }),
                });
                $('groupInviteError').textContent = data.addedCount
                    ? data.addedCount + ' Einladung(en) gesendet.'
                    : 'Keine neue Einladung möglich. Die Person ist bereits Mitglied, eingeladen oder möchte keine weiteren Einladungen.';
                await refreshOpenGroup(state.activeGroup.id);
                await loadGroups();
            } catch (error) {
                $('groupInviteError').textContent = error.message;
            }
        });
        $('groupInvitations').addEventListener('click', async (event) => {
            const accept = event.target.closest('[data-accept-group-invitation]');
            const decline = event.target.closest('[data-decline-group-invitation]');
            const block = event.target.closest('[data-block-group-invitation]');
            const button = accept || decline || block;
            if (!button) return;
            const invitationId = accept
                ? accept.dataset.acceptGroupInvitation
                : decline ? decline.dataset.declineGroupInvitation : block.dataset.blockGroupInvitation;
            const action = accept ? 'accept' : decline ? 'decline' : 'decline_forever';
            try {
                await api('/api/group-invitations/' + invitationId + '/respond', {
                    method: 'POST',
                    body: JSON.stringify({ action }),
                });
                await loadGroups();
            } catch (error) {
                $('groupList').innerHTML = '<div class="news-empty">' + escapeText(error.message) + '</div>';
            }
        });
        $('groupComposer').addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!state.activeGroup) return;
            $('groupComposerError').textContent = '';
            try {
                const attachment = await readGroupAttachment();
                await api('/api/groups/' + state.activeGroup.id + '/messages', {
                    method: 'POST',
                    body: JSON.stringify({ body: $('groupMessageInput').value, attachment }),
                });
                $('groupMessageInput').value = '';
                $('groupAttachmentInput').value = '';
                state.groupPendingAttachment = null;
                renderGroupPendingAttachment();
                await refreshOpenGroup(state.activeGroup.id);
                await loadGroups();
            } catch (error) {
                if (isBlockedDomainError(error)) {
                    showBlockedGroupDomainWarning(error);
                } else {
                    $('groupComposerError').textContent = error.message;
                }
            }
        });
        $('groupAttachmentInput').addEventListener('change', (event) => chooseGroupAttachment(event.target.files[0]));
        $('groupAttachmentPreview').addEventListener('click', (event) => {
            if (!event.target.closest('#removeGroupAttachment')) return;
            state.groupPendingAttachment = null;
            $('groupAttachmentInput').value = '';
            renderGroupPendingAttachment();
        });
        $('groupMessages').addEventListener('click', async (event) => {
            const deleteButton = event.target.closest('[data-delete-group-message]');
            if (deleteButton && state.activeGroup) {
                try {
                    await api('/api/groups/' + state.activeGroup.id + '/messages/' + deleteButton.dataset.deleteGroupMessage, { method: 'DELETE', body: '{}' });
                    await refreshOpenGroup(state.activeGroup.id);
                } catch (error) {
                    $('groupComposerError').textContent = error.message;
                }
                return;
            }
            const reportButton = event.target.closest('[data-report-group-message]');
            if (reportButton && state.activeGroup) {
                state.reportKind = 'group';
                state.reportMessageId = reportButton.dataset.reportGroupMessage;
                $('reportCategory').value = '';
                $('reportDetails').value = '';
                $('reportError').textContent = '';
                $('reportModal').classList.remove('hidden');
                return;
            }
            const image = event.target.closest('[data-chat-image]');
            if (image) openImageViewer(image);
        });
        $('discardBlockedGroupMessage').addEventListener('click', () => {
            $('groupMessageInput').value = '';
            hideBlockedGroupDomainWarning();
            $('groupComposerError').textContent = 'Nachricht wurde nicht gesendet und gelöscht.';
            $('groupMessageInput').focus();
        });
        $('enableNewsPush').addEventListener('click', () => {
            $('newsPushStatus').textContent = '';
            enableNewsPush().catch((error) => {
                $('newsPushStatus').textContent = error.message;
            });
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
        $('messages').addEventListener('scroll', updateJumpLatestButton, { passive: true });
        $('jumpLatest').addEventListener('click', () => {
            scrollMessagesToEnd();
            $('messageInput').focus();
        });
        $('messages').addEventListener('click', async (event) => {
            const deleteButton = event.target.closest('[data-delete-message]');
            if (deleteButton && state.activeConversation) {
                try {
                    await api('/api/conversations/' + state.activeConversation.id + '/messages/' + deleteButton.dataset.deleteMessage, {
                        method: 'DELETE',
                        body: '{}',
                    });
                    await refreshOpenMessages(state.activeConversation.id);
                    await loadConversations();
                } catch (error) {
                    $('composerError').textContent = error.message;
                }
                return;
            }
            const favoriteButton = event.target.closest('[data-favorite-message]');
            if (favoriteButton && state.activeConversation) {
                try {
                    await api('/api/conversations/' + state.activeConversation.id + '/messages/' + favoriteButton.dataset.favoriteMessage + '/favorite', {
                        method: favoriteButton.dataset.favorite === 'true' ? 'DELETE' : 'PUT',
                        body: '{}',
                    });
                    await refreshOpenMessages(state.activeConversation.id);
                } catch (error) {
                    $('composerError').textContent = error.message;
                }
                return;
            }
            const reportButton = event.target.closest('[data-report-message]');
            if (reportButton) {
                state.reportKind = 'private';
                state.reportMessageId = reportButton.dataset.reportMessage;
                $('reportCategory').value = '';
                $('reportDetails').value = '';
                $('reportError').textContent = '';
                $('reportModal').classList.remove('hidden');
                return;
            }
            const image = event.target.closest('[data-chat-image]');
            if (image) openImageViewer(image);
        });
        $('messages').addEventListener('keydown', (event) => {
            const image = event.target.closest('[data-chat-image]');
            if (!image || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            openImageViewer(image);
        });
        $('closeImageViewer').addEventListener('click', closeImageViewer);
        $('closeReport').addEventListener('click', () => {
            state.reportMessageId = null;
            state.reportKind = 'private';
            $('reportModal').classList.add('hidden');
        });
        $('reportForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!state.reportMessageId || (state.reportKind === 'group' ? !state.activeGroup : !state.activeConversation)) return;
            $('reportError').textContent = '';
            try {
                const wasGroupReport = state.reportKind === 'group';
                const reportUrl = state.reportKind === 'group'
                    ? '/api/groups/' + state.activeGroup.id + '/messages/' + state.reportMessageId + '/report'
                    : '/api/conversations/' + state.activeConversation.id + '/messages/' + state.reportMessageId + '/report';
                await api(reportUrl, {
                    method: 'POST',
                    body: JSON.stringify({
                        category: $('reportCategory').value,
                        details: $('reportDetails').value,
                    }),
                });
                state.reportMessageId = null;
                state.reportKind = 'private';
                $('reportModal').classList.add('hidden');
                if (wasGroupReport) $('groupComposerError').textContent = 'Die Nachricht wurde zur Prüfung gemeldet.';
                else $('composerError').textContent = 'Die Nachricht wurde zur Prüfung gemeldet.';
            } catch (error) {
                $('reportError').textContent = error.message;
            }
        });
        $('imageViewer').addEventListener('click', (event) => {
            if (event.target === $('imageViewer')) closeImageViewer();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !$('imageViewer').classList.contains('hidden')) closeImageViewer();
            if (event.key === 'Escape' && !$('groupInfoModal').classList.contains('hidden')) $('groupInfoModal').classList.add('hidden');
        });
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
        $('discardBlockedDomainMessage').addEventListener('click', () => {
            stopTyping();
            $('messageInput').value = '';
            state.pendingAttachment = null;
            $('attachmentInput').value = '';
            renderPendingAttachment();
            hideBlockedDomainWarning();
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
                        let time;
                        try {
                            time = new Date(message.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
                        } catch (error) {
                            time = new Date(message.created_at).toLocaleString();
                        }
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
                stopTyping();
                await api('/api/conversations/' + state.activeConversation.id + '/messages', {
                    method: 'POST',
                    body: JSON.stringify({ body, attachment }),
                });
                $('messageInput').value = '';
                $('attachmentInput').value = '';
                state.pendingAttachment = null;
                renderPendingAttachment();
                await openConversation(state.activeConversation.id);
                await loadConversations();
            } catch (error) {
                if (isBlockedDomainError(error)) {
                    showBlockedDomainWarning(error);
                } else {
                    $('composerError').textContent = error.message;
                }
            }
        });

        boot();
    </script>
</body>
</html>`;
}


module.exports = { renderMessengerApp };
