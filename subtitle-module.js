/* =========================================================
   Untertitel-Modul – SubtitleManager (komplett neu)
   =========================================================
   Verantwortlichkeiten:
   1. VTT-Dateien parsen (lokale Dateien, URL, eingebetteter Text)
   2. HLS-Subtitle-Tracks erkennen & auflösen (inkl. nested Playlists)
   3. Custom-Overlay rendern (requestAnimationFrame-Schleife)
   4. Einstellungen verwalten (localStorage, Live-Vorschau)
   5. Ein- / Ausschalten (Toggle) mit automatischer Track-Aktivierung
   ========================================================= */

class SubtitleManager {
  /* ---------- Konstanten ---------- */
  static DEFAULT_SETTINGS = {
    fontFamily: 'sans-serif',
    fontSize: 28,
    fontWeight: '600',
    textColor: '#ffffff',
    bgColor: '#000000',
    bgOpacity: 65,
    borderColor: '#000000',
    borderWidth: 0,
    borderRadius: 4,
    position: 'bottom',
    padding: 48,
    multiLine: 'yes',
  };

  /* ---------- State ---------- */
  constructor(stateRef, els) {
    /** @type {Object} – Referenz auf den globalen state */
    this.state = stateRef;
    /** @type {Object} – DOM-Elemente */
    this.els = els;
    /** @type {Array<Object>} – Parst cues (startTime, endTime, text) */
    this.cues = [];
    /** @type {boolean} */
    this.enabled = false;
    /** @type {boolean} */
    this.active = false;
    /** @type {boolean|null} – Wird vom HLS-Stream-Loader gesetzt */
    this.hasNativeTracks = null;
    /** @type {number|null} – setInterval-Handle für die erste Aktivierung */
    this._pollTimer = null;
    /** @type {boolean} */
    this._renderLoopStarted = false;
    /** @type {AbortController|null} */
    this._abortController = null;

    // Einstellungen laden
    this.settings = this._loadSettings();
    this.enabled = this._loadEnabled();
  }

  /* =========================================================
     1. VTT-PARSER
     ========================================================= */

  /**
   * Parse einen VTT-String zu einem Array von Cue-Objekten.
   * Unterstützt: WEBVTT-Header, X-TIMESTAMP-MAP, 2/3-stündige Zeiten,
   *              Millisekunden, mehrere Textzeilen pro Cue.
   */
  parseVTT(text) {
    if (!text || typeof text !== 'string') return [];

    const lines = text.split(/\r?\n/);
    const cues = [];
    let i = 0;

    // Header überspringen
    if (lines[0] && /^WEBVTT/i.test(lines[0])) {
      i = 1;
      if (lines[1] && lines[1].startsWith('X-TIMESTAMP-MAP')) i = 2;
      if (lines[i] && lines[i].trim() === '') i++;
    }

    const tsRe =
      /((?:\d{1,2}:)?\d{2}:\d{2}(?:\.\d{3})?)\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}(?:\.\d{3})?)(.*)/;

    while (i < lines.length) {
      const tsLine = lines[i]?.trim();
      if (!tsLine) { i++; continue; }

      const m = tsLine.match(tsRe);
      if (!m) { i++; continue; }

      const startTime = this._parseTime(m[1]);
      const endTime = this._parseTime(m[2]);
      // m[3] = settings (position, align etc.) – wird ignoriert

      i++;
      const textLines = [];
      while (i < lines.length && lines[i]?.trim() !== '') {
        textLines.push(lines[i]);
        i++;
      }

      if (textLines.length && endTime > startTime) {
        cues.push({ startTime, endTime, text: textLines.join('\n') });
      }
      i++;
    }

    return cues;
  }

  /**
   * Konvertiert eine VTT-Zeit (z.B. "00:01:30.500" oder "01:30.500") zu Sekunden.
   */
  _parseTime(str) {
    const parts = str.split(':');
    if (parts.length === 3) {
      return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
    }
    if (parts.length === 2) {
      return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(parts[0]) || 0;
  }

  /* =========================================================
     2. VTT LADEN (Datei, URL, Text)
     ========================================================= */

  /** VTT aus einer Blob-Datei laden */
  loadFromFile(file) {
    return new Promise((resolve) => {
      if (!file || !file.text) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        const cues = this.parseVTT(reader.result);
        resolve(cues);
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
  }

  /** VTT von einer URL laden (mit automatischer CORS-Proxy-Erkennung) */
  async loadFromUrl(url) {
    if (!url || !url.trim()) return null;

    // Erst direkter Versuch
    try {
      const text = await this._fetchText(url);
      return this.parseVTT(text);
    } catch { /* Proxy probieren */ }

    // CORS-Proxies durchgehen
    const proxies = [
      (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      (u) => `https://codetunnel.io/proxy?url=${encodeURIComponent(u)}`,
    ];

    for (const makeUrl of proxies) {
      try {
        const text = await this._fetchText(makeUrl(url));
        return this.parseVTT(text);
      } catch { /* weiter */ }
    }

    return null;
  }

  /** Einfacher Text-Fetch mit Timeout */
  _fetchText(url, timeout = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return fetch(url, { signal: ctrl.signal }).then(r => {
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
  }

  /** VTT-Text direkt parsen */
  parseFromText(text) {
    if (!text || typeof text !== 'string') return [];
    return this.parseVTT(text);
  }

  /* =========================================================
     3. HLS-SUBTITLE-TRACK-AUFLÖSUNG
     ========================================================= */

  /**
   * HLS-Subtitle-Tracks aus dem globalen state.hls extrahieren.
   */
  detectTracks() {
    const hls = this.state.hls;
    if (!hls) { this.hasNativeTracks = false; return []; }

    const tracks = hls.subtitleTracks || [];
    this.state.subtitleTracks = tracks.map((t, i) => ({
      id: t.id,
      name: t.name || `Track ${i + 1}`,
      language: t.lang || '',
    }));
    this.hasNativeTracks = this.state.subtitleTracks.length > 0;

    return this.state.subtitleTracks;
  }

  /**
   * Einen HLS-Subtitle-Track zu Cue-Arrays auflösen.
   * Verarbeitet: direkte VTT-URLs, nested .m3u8-Playlists.
   */
  async activateTrack(track) {
    if (!track || !track.url) return false;

    // hls.js eigene Untertitel deaktivieren – wir nutzen das Custom-Overlay
    if (this.state.hls) {
      this.state.hls.subtitleTrack = -1;
    }

    const url = track.url;
    const cues = await this._resolveSubtitleUrl(url, 0);

    if (cues?.length) {
      this.cues = cues;
      this.state.subtitleCues = cues;
      this.state.subtitleActiveTrack = -1;
      this.active = true;
      return true;
    }

    return false;
  }

  /**
   * Rekursive Auflösung einer Subtitle-URL:
   * - .vtt → direkt Cues parsen
   * - .m3u8 → Playlist holen, nach URI=…TYPE=SUBTITLES oder Stream-Infos suchen
   */
  async _resolveSubtitleUrl(url, depth) {
    if (depth > 5) {
      return [];
    }

    // VTT-Datei direkt
    if (/\.(vtt)(\?|$)/i.test(url.split('?')[0])) {
      return (await this.loadFromUrl(url)) || [];
    }

    // HLS-Playlist → auflösen
    const master = await this._fetchText(url);
    if (!master) return [];

    const allCues = [];
    const candidates = this._extractSubtitleUrls(master, url);

    for (const candidate of candidates) {
      if (candidate.isNested && depth < 5) {
        const nested = await this._resolveSubtitleUrl(candidate.url, depth + 1);
        allCues.push(...nested);
      } else {
        const cues = await this.loadFromUrl(candidate.url);
        if (cues) allCues.push(...cues);
      }
    }

    return allCues;
  }

  /**
   * Aus einer M3U8-Playlist VTT- und nested-Playlist-URLs extrahieren.
   */
  _extractSubtitleUrls(text, baseUrl) {
    const urls = [];
    const lines = text.split(/\r?\n/);
    let expectStreamInf = false;

    for (const line of lines) {
      const t = line.trim();

      // #EXT-X-MEDIA:TYPE=SUBTITLES,URI="..."
      if (t.startsWith('#EXT-X-MEDIA') && /TYPE=SUBTITLES/.test(t)) {
        const uri = this._matchAttr(t, 'URI');
        if (uri) {
          urls.push({
            url: this._toAbsolute(uri, baseUrl),
            isNested: /\.(m3u8)/i.test(uri),
          });
        }
        expectStreamInf = false;
        continue;
      }

      if (t.startsWith('#EXT-X-STREAM-INF')) {
        expectStreamInf = true;
        continue;
      }

      if (expectStreamInf && t && !t.startsWith('#')) {
        const isVtt = /\.(vtt)(\?|$)/i.test(t.split('?')[0]);
        const isM3u8 = /\.(m3u8)(\?|$)/i.test(t.split('?')[0]);
        if (isVtt) {
          urls.push({ url: this._toAbsolute(t, baseUrl), isNested: false });
        } else if (isM3u8) {
          urls.push({ url: this._toAbsolute(t, baseUrl), isNested: true });
        }
        expectStreamInf = false;
      }
    }

    return urls;
  }

  /** Attribut-Wert aus einem Key=Value-String extrahieren */
  _matchAttr(str, key) {
    const re = new RegExp(`${key}=["']?([^"']+)["']?`, 'i');
    const m = str.match(re);
    return m ? m[1] : null;
  }

  /** Relative zu absoluter URL auflösen */
  _toAbsolute(path, base) {
    try { return new URL(path, base).href; } catch { return path; }
  }

  /* =========================================================
     4. CUES AKTIVIEREN / DEAKTIVIEREN
     ========================================================= */

  /**
   * Manuell Cues setzen (z.B. aus Datei-Upload).
   */
  setCues(cues) {
    this.cues = cues || [];
    this.state.subtitleCues = this.cues;
    this.state.subtitleActiveTrack = -1;
    this.active = true;
  }

  /**
   * Alle Untertitel deaktivieren (Cues löschen, Render-Loop stoppen).
   */
  deactivate() {
    this.active = false;
    this.cues = [];
    this.state.subtitleCues = [];
    this.state.subtitleActiveTrack = -1;
    this._renderLoopStarted = false;
    this.hasNativeTracks = null;

    if (this.state.hls) this.state.hls.subtitleTrack = -1;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }

    // Browser-TextTracks deaktivieren
    if (this.els.video && this.els.video.textTracks) {
      for (let i = 0; i < this.els.video.textTracks.length; i++) {
        this.els.video.textTracks[i].mode = 'disabled';
      }
    }
  }

  /* =========================================================
     5. TOGGLE (Ein / Aus)
     ========================================================= */

  /**
   * Untertitel umschalten.
   */
  toggle() {
    this.enabled = !this.enabled;

    if (this.enabled) {
      this._enable();
    } else {
      this._disable();
    }

    this._saveEnabled();
    this._onEnabledChange?.(this.enabled);
    return this.enabled;
  }

  /** Untertitel aktivieren (auto-detect Tracks oder manuell) */
  async _enable() {
    if (this.active) return; // schon aktiv

    const hls = this.state.hls;

    if (hls) {
      // HLS: eingebettete Tracks suchen & aktivieren
      this.detectTracks();

      if (this.hasNativeTracks && this.state.subtitleTracks.length) {
        const track = this.state.subtitleTracks[0];
        const ok = await this.activateTrack(track);
        if (ok) {
          this._startRenderLoop();
          return;
        }
      }

      // fallback: polling auf native TextTracks
      this._startPolling();
    } else {
      // Kein HLS – Render-Loop starten, falls Cues existieren
      if (this.cues.length) {
        this._startRenderLoop();
      }
    }
  }

  /** Untertitel deaktivieren */
  _disable() {
    this.deactivate();
    this.els.subtitleOverlay?.classList.remove('active');
    this.els.subtitleText && (this.els.subtitleText.style.opacity = '0');
  }

  /** Polling: periodisch prüfen, ob TextTracks aktiv wurden */
  _startPolling() {
    this._stopPolling();
    let attempts = 0;
    const maxAttempts = 24; // 6 Sekunden

    this._pollTimer = window.setInterval(() => {
      attempts++;
      const tracks = this.els.video?.textTracks;
      if (tracks) {
        for (let i = 0; i < tracks.length; i++) {
          if (tracks[i].mode === 'showing') {
            this._stopPolling();
            this.active = true;
            this._startRenderLoop();
            return;
          }
        }
      }
      if (attempts >= maxAttempts) {
        this._stopPolling();
      }
    }, 250);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /* =========================================================
     6. RENDER-SCHLEIFE
     ========================================================= */

  /** requestAnimationFrame-Loop starten */
  _startRenderLoop() {
    if (this._renderLoopStarted) return;
    this._renderLoopStarted = true;

    const tick = () => {
      if (this._renderLoopStarted && this.enabled && this.els.video) {
        this._render();
      }
      if (this._renderLoopStarted) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }

  /** Einen einzelnen Render-Durchlauf */
  _render() {
    if (!this.enabled || !this.els.subtitleOverlay || !this.els.subtitleText) return;

    const cue = this._getCueAt(this.state.hls ? this.els.video.currentTime : 0);

    if (cue) {
      const text = cue.text.replace(/\\n/g, '\n');
      this._renderText(text);
      this.els.subtitleText.style.opacity = '1';
      this.els.subtitleOverlay.classList.add('active');
    } else {
      this.els.subtitleText.style.opacity = '0';
      if (!this.cues.length) {
        this.els.subtitleOverlay.classList.remove('active');
      }
    }
  }

  /** Den Cue finden, der zur aktuellen Zeit passt */
  _getCueAt(time) {
    for (let i = 0; i < this.cues.length; i++) {
      const c = this.cues[i];
      if (time >= c.startTime && time < c.endTime) {
        return c;
      }
    }
    return null;
  }

  /** Cue-Text auf dem Overlay rendern */
  _renderText(text) {
    if (!text) { this.els.subtitleText.innerHTML = ''; return; }

    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const s = this.settings;
    const maxLines = s.multiLine === 'yes' ? 2 : 1;

    let html = '';
    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
      html += `<span class="sub-line">${this._escapeHtml(lines[i])}</span>`;
    }

    this.els.subtitleText.innerHTML = html;

    if (s.multiLine === 'yes') {
      this.els.subtitleText.classList.add('multi-line');
    } else {
      this.els.subtitleText.classList.remove('multi-line');
    }
  }

  /* =========================================================
     7. STYLES ANWENDEN
     ========================================================= */

  /** CSS-Eigenschaften auf das Overlay anwenden */
  applyStyles() {
    if (!this.els.subtitleText) return;
    const s = this.settings;

    const { fontFamily, fontSize, fontWeight, textColor } = s;
    this.els.subtitleText.style.fontFamily = fontFamily;
    this.els.subtitleText.style.fontSize = `${fontSize}px`;
    this.els.subtitleText.style.fontWeight = fontWeight;
    this.els.subtitleText.style.color = textColor;

    // Hintergrund
    if (s.bgOpacity > 0) {
      const [r, g, b] = this._hexToRgb(s.bgColor);
      this.els.subtitleText.style.backgroundColor = `rgba(${r},${g},${b},${(s.bgOpacity / 100).toFixed(2)})`;
      this.els.subtitleText.style.padding = '4px 10px';
      this.els.subtitleText.style.borderRadius = `${s.borderRadius}px`;
      this.els.subtitleText.style.border =
        s.borderWidth > 0 ? `${s.borderWidth}px solid ${s.borderColor}` : 'none';
    } else {
      this.els.subtitleText.style.backgroundColor = 'transparent';
      this.els.subtitleText.style.padding = '0';
      this.els.subtitleText.style.borderRadius = '0';
      this.els.subtitleText.style.border = 'none';
    }

    // Position
    const overlay = this.els.subtitleOverlay;
    overlay.classList.remove('position-top', 'position-mid');
    overlay.style.paddingBottom = '';
    if (s.position === 'top') {
      overlay.classList.add('position-top');
    } else if (s.position === 'mid') {
      overlay.classList.add('position-mid');
    } else {
      overlay.style.paddingBottom = `${s.padding}px`;
    }

    // Live-Vorschau aktualisieren
    this._updatePreview();
  }

  /** Vorschau-Box im Settings-Modal stylen */
  _updatePreview() {
    const preview = this.els.subtitleSettingsModal?.querySelector('.subtitle-preview-box .subtitle-text');
    if (!preview) return;
    const s = this.settings;

    preview.style.fontFamily = s.fontFamily;
    preview.style.fontSize = `${s.fontSize}px`;
    preview.style.fontWeight = s.fontWeight;
    preview.style.color = s.textColor;

    if (s.bgOpacity > 0) {
      const [r, g, b] = this._hexToRgb(s.bgColor);
      preview.style.backgroundColor = `rgba(${r},${g},${b},${(s.bgOpacity / 100).toFixed(2)})`;
      preview.style.padding = '4px 10px';
      preview.style.borderRadius = `${s.borderRadius}px`;
      preview.style.border =
        s.borderWidth > 0 ? `${s.borderWidth}px solid ${s.borderColor}` : 'none';
    } else {
      preview.style.backgroundColor = 'transparent';
      preview.style.padding = '0';
      preview.style.borderRadius = '0';
      preview.style.border = 'none';
    }
  }

  /** Hex-Farbe zu RGB-Tupel */
  _hexToRgb(hex) {
    const v = hex.replace('#', '');
    return [
      parseInt(v.substring(0, 2), 16),
      parseInt(v.substring(2, 4), 16),
      parseInt(v.substring(4, 6), 16),
    ];
  }

  /* =========================================================
     8. EINSTELLUNGEN
     ========================================================= */

  _loadSettings() {
    try {
      const raw = localStorage.getItem('m3u_subtitle_settings');
      if (raw) return { ...SubtitleManager.DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {}
    return { ...SubtitleManager.DEFAULT_SETTINGS };
  }

  _loadEnabled() {
    try {
      const raw = localStorage.getItem('m3u_subtitle_enabled');
      if (raw !== null) return raw === 'true';
    } catch {}
    return false;
  }

  _saveEnabled() {
    try { localStorage.setItem('m3u_subtitle_enabled', String(this.enabled)); } catch {}
  }

  saveSettings() {
    try { localStorage.setItem('m3u_subtitle_settings', JSON.stringify(this.settings)); } catch {}
  }

  /** Numerischen Wert clampen (auf den Bereich [min, max] beschränken) */
  _clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  /** Settings-Formular auslesen und settings aktualisieren */
  readSettingsFromForm(formEls) {
    this.settings = {
      fontFamily: formEls.subFontFamily?.value || this.settings.fontFamily,
      fontSize: this._clamp(parseInt(formEls.subFontSize?.value, 10) || 10, 10, 120),
      fontWeight: formEls.subFontWeight?.value || this.settings.fontWeight,
      textColor: formEls.subTextColor?.value || this.settings.textColor,
      bgColor: formEls.subBgColor?.value || this.settings.bgColor,
      bgOpacity: this._clamp(parseInt(formEls.subBgOpacity?.value, 10) ?? 65, 0, 100),
      borderColor: formEls.subBorderColor?.value || this.settings.borderColor,
      borderWidth: this._clamp(parseInt(formEls.subBorderWidth?.value, 10) ?? 0, 0, 10),
      borderRadius: this._clamp(parseInt(formEls.subBorderRadius?.value, 10) ?? 4, 0, 40),
      position: formEls.subPosition?.value || this.settings.position,
      padding: this._clamp(parseInt(formEls.subPadding?.value, 10) ?? 48, 8, 200),
      multiLine: formEls.subMultiLine?.value || this.settings.multiLine,
    };

    this.applyStyles();
    this.saveSettings();
  }

  /** Formular mit aktuellen Einstellungen füllen */
  populateForm(formEls) {
    const s = this.settings;
    if (!formEls) return;

    formEls.subFontFamily && (formEls.subFontFamily.value = s.fontFamily);
    formEls.subFontSize && (formEls.subFontSize.value = s.fontSize);
    formEls.subFontWeight && (formEls.subFontWeight.value = s.fontWeight);
    formEls.subTextColor && (formEls.subTextColor.value = s.textColor);
    formEls.subBgColor && (formEls.subBgColor.value = s.bgColor);
    formEls.subBgOpacity && (formEls.subBgOpacity.value = s.bgOpacity);
    formEls.subBorderColor && (formEls.subBorderColor.value = s.borderColor);
    formEls.subBorderWidth && (formEls.subBorderWidth.value = s.borderWidth);
    formEls.subBorderRadius && (formEls.subBorderRadius.value = s.borderRadius);
    formEls.subPosition && (formEls.subPosition.value = s.position);
    formEls.subPadding && (formEls.subPadding.value = s.padding);
    formEls.subMultiLine && (formEls.subMultiLine.value = s.multiLine);
  }

  /** Einstellungen auf Default zurücksetzen */
  resetSettings() {
    this.settings = { ...SubtitleManager.DEFAULT_SETTINGS };
  }

  /** UI-Button für Toggle stylen */
  updateToggleUI(btn, enabled) {
    if (!btn) return;
    if (enabled) {
      btn.style.background = 'var(--panel-2)';
      btn.style.borderColor = 'var(--accent)';
      btn.style.color = 'var(--accent)';
    } else {
      btn.style.removeProperty('background');
      btn.style.removeProperty('border-color');
      btn.style.removeProperty('color');
    }
  }

  /* =========================================================
     9. MANUELLE SUBTITLE-QUELLEN LADEN
     ========================================================= */

  /**
   * Untertitel aus Datei, URL oder Text laden und sofort anzeigen.
   * Gibt einen Promise zurück, der mit der Anzahl der Cues auflöst.
   */
  async loadExternalSource(file, url, pasteText) {
    let cues = null;

    if (file) {
      cues = await this.loadFromFile(file);
    } else if (url) {
      cues = await this.loadFromUrl(url);
    } else if (pasteText) {
      cues = this.parseFromText(pasteText);
    }

    if (cues && cues.length) {
      this.setCues(cues);
      if (!this.enabled) {
        this.enabled = true;
        this._startRenderLoop();
      }
      return cues.length;
    }

    return 0;
  }

  /* =========================================================
     10. HILFSFUNKTIONEN
     ========================================================= */

  _escapeHtml(str) {
    return str.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  /** Callback, der bei enabled-Änderung aufgerufen wird (für Toast-Nachrichten) */
  onEnabledChange(callback) {
    this._onEnabledChange = callback;
  }
}

/* =========================================================
   Export für globalen Zugriff
   ========================================================= */
let subtitleManager = null;

function initSubtitleManager(stateRef, elsRef) {
  subtitleManager = new SubtitleManager(stateRef, elsRef);
  return subtitleManager;
}

// Alias-Funktionen für bestehende Callbacks (kompatibel)
function getSubtitleManager() { return subtitleManager; }
