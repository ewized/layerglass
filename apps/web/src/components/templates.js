// Trusted, static component markup. Printer names and server values use textContent.
export const playerTemplate = `
<printer-camera-view class="viewer" id="viewer" role="region" aria-label="Live printer camera"></printer-camera-view>

    <printer-pull-indicator id="pull-refresh" class="pull-refresh" role="status" aria-live="polite" hidden></printer-pull-indicator>

    <header class="player-header player-chrome">
      <h1 id="camera-name">Printer camera</h1>
      <p id="camera-id" hidden></p>
    </header>

    <printer-settings id="player-options" class="player-options" role="dialog" aria-label="Settings" hidden></printer-settings>

    <printer-context-menu id="video-context-menu" class="video-context-menu" role="menu" aria-label="Video options" hidden></printer-context-menu>
    <printer-stats id="player-stats" class="player-stats" role="complementary" aria-label="Stats for nerds" hidden></printer-stats>

    <printer-controls id="player-controls" class="player-bottom player-chrome"></printer-controls>
`;

export const cameraTemplate = `
<div id="video-diffusion" class="video-diffusion" aria-hidden="true" hidden><div class="diffusion-base"></div><div class="diffusion-next"></div></div>
      <video id="video" autoplay muted playsinline aria-label="Live camera video"></video>
      <img id="jpeg" alt="Live printer camera" hidden>
      <printer-loading id="overlay" class="viewer-overlay"></printer-loading>
      <span id="caption-label" class="sr-only">LIVE VIEW</span>
`;

export const loadingTemplate = `
<div class="loader" id="loader" aria-hidden="true"></div>
        <svg id="offline-icon" class="offline-icon" viewBox="0 0 24 24" aria-hidden="true" hidden><use href="#i-offline"/></svg>
        <p id="overlay-title" class="sr-only" role="status">Connecting to your camera</p>
        <p id="overlay-subtitle" class="sr-only">The live view will appear here.</p>
        <button id="play-button" class="overlay-action icon-button" aria-label="Play live view" title="Play" hidden><svg class="filled-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-play"/></svg></button>
        <button id="empty-scan-button" class="overlay-action icon-button" aria-label="Scan for printers" title="Printers" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-search"/></svg></button>
`;

export const settingsTemplate = `
<div class="settings-heading">
        <button id="settings-back" class="icon-button" aria-label="Back to settings" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-back"/></svg></button>
        <h2 id="settings-title">Settings</h2>
        <button id="scan-button" class="icon-button" aria-label="Scan for printers" title="Scan" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-refresh"/></svg><span id="scan-label" class="sr-only">Scan</span></button>
      </div>
      <div data-settings-page="root" class="settings-page">
        <button id="printers-button" class="menu-row" data-settings-target="printers"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-printer"/></svg><span>Printers</span><span id="selected-printer" class="menu-value"></span><svg class="menu-chevron" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron"/></svg></button>
        <button class="menu-row" data-settings-target="connection"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-connection"/></svg><span>Connection</span><svg class="menu-chevron" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron"/></svg></button>
      </div>
      <div data-settings-page="printers" class="settings-page" hidden>
        <div id="printer-skeleton" class="printer-skeleton" aria-hidden="true" hidden>
          <div class="printer-skeleton-row"><span class="printer-skeleton-label"><span class="skeleton-name"></span><span class="skeleton-address"></span></span><span class="skeleton-action"></span></div>
          <div class="printer-skeleton-row"><span class="printer-skeleton-label"><span class="skeleton-name"></span><span class="skeleton-address"></span></span><span class="skeleton-action"></span></div>
          <div class="printer-skeleton-row"><span class="printer-skeleton-label"><span class="skeleton-name"></span><span class="skeleton-address"></span></span><span class="skeleton-action"></span></div>
        </div>
        <printer-list id="camera-list" class="camera-list" role="group" aria-label="Printers"></printer-list>

        <span id="discovery-message" class="sr-only" role="status" aria-live="polite"></span>
      </div>
      <div data-settings-page="connection" class="settings-page" hidden>
        <form id="backend-form" class="backend-form">
          <label for="backend-type">Backend</label>
          <select id="backend-type" name="type"><option value="python">Docker backend</option><option value="demo">Demo</option><option value="direct">Direct printer (Klipper / Moonraker)</option></select>
          <label for="backend-url" id="backend-url-label">Backend address</label>
          <input id="backend-url" name="url" type="url" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" placeholder="https://printer.example.com" aria-describedby="backend-capabilities backend-error">
          <button id="backend-confirm" class="icon-button primary" type="submit" title="Save and connect" aria-label="Save and connect"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-check"/></svg></button>
          <p id="backend-error" class="backend-error" role="alert" hidden></p>
          <p id="backend-capabilities" class="backend-note"></p>
        </form>
        <label id="local-media-label" class="menu-row" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-play"/></svg><span>Open local video</span><input id="local-media" type="file" accept="video/*" class="sr-only"></label>
        <span id="stream-message" class="sr-only" role="status" aria-live="polite">Connecting to the camera…</span>
        <button id="refresh-button" class="menu-row"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-refresh"/></svg><span>Refresh viewer</span></button>
        <button id="restart-button" class="menu-row"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-restart"/></svg><span id="restart-label">Restart stream</span></button>
      </div>
`;

export const printerTemplate = `
<button type="button" class="menu-row printer-select" data-printer-action="select"><span class="printer-label"><span class="printer-name"></span><span class="printer-address"></span></span><svg class="printer-state" viewBox="0 0 24 24" aria-hidden="true" hidden><use href="#i-check"/></svg></button>
            <button type="button" class="icon-button printer-access" data-printer-action="access"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-key"/></svg></button>
            <form class="printer-code-form" hidden></form>
            <button type="button" class="icon-button menu-danger printer-forget" data-printer-action="forget"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-trash"/></svg></button>
            <p class="printer-error" role="alert" hidden></p>
`;

const saveConnection = `<button type="submit" class="icon-button primary printer-code-save" title="Save and connect"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-check"/></svg></button>`;

export const accessCodeTemplate = `
<label class="sr-only">LAN access code</label>
<input name="access-code" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="32" required>
${saveConnection}`;

export const contextTemplate = `
<button class="menu-row" role="menuitem" data-player-action="mini"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-mini"/></svg><span>Mini player</span></button>
      <button class="menu-row" role="menuitem" data-player-action="stats"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-stats"/></svg><span>Stats for nerds</span></button>
      <button class="menu-row" role="menuitem" data-player-action="copy-debug"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-copy"/></svg><span aria-live="polite" aria-atomic="true">Copy debug info</span></button>
`;

export const statsTemplate = `
<div class="stats-heading"><h2>Stats for nerds</h2><button id="close-stats" class="icon-button" aria-label="Close stats"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-close"/></svg></button></div>
      <div id="stats-values">
        <section class="stats-section" aria-label="Video"><h3>Video</h3><dl data-stats-section="video"></dl></section>
        <section class="stats-section" aria-label="Printer"><h3>Printer</h3><dl data-stats-section="printer"></dl></section>
        <section class="stats-section" aria-label="Activity" hidden><h3>Activity</h3><dl data-stats-section="activity"></dl></section>
      </div>
`;

export const pullTemplate = `
<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5M20 12l-5-5"/></svg>
      <span id="pull-refresh-label" class="sr-only">Pull to reload</span>
`;

export const controlsTemplate = `
<section class="replay-controls" id="replay-controls" aria-label="Video playback" hidden>
        <printer-timeline-events id="timeline-events" class="timeline-events"></printer-timeline-events>
        <input id="replay-slider" type="range" min="0" max="0" value="0" step="any" aria-label="Scrub buffered video" disabled>
        <printer-scrub-preview id="scrub-preview" class="scrub-preview" hidden></printer-scrub-preview>
      </section>
      <span id="replay-detail" class="sr-only" hidden></span>
      <div class="player-toolbar" id="player-toolbar" role="group" aria-label="Player controls">
        <button id="pause-button" class="icon-button" aria-label="Pause video" disabled><svg class="pause-icon filled-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-pause"/></svg><svg class="play-icon filled-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-play"/></svg></button>
        <div class="replay-clock">
          <button id="live-button" class="button live-button" aria-label="Return to live video" aria-pressed="false" disabled><span class="status-dot"></span>Live</button>
          <span id="replay-time" hidden></span>
        </div>
        <span class="sr-only" id="status-pill" role="status"><span id="status-label">Connecting</span></span>
        <button id="options-button" class="icon-button" aria-label="Settings" aria-haspopup="dialog" aria-controls="player-options" aria-expanded="false" title="Settings">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-settings"/></svg>
        </button>
        <button id="cast-button" class="icon-button" aria-label="Cast" aria-pressed="false" title="Cast" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-cast"/></svg>
        </button>
        <button id="fullscreen-button" class="icon-button" aria-label="Enter fullscreen" title="Fullscreen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-fullscreen"/></svg>
        </button>
      </div>
`;
