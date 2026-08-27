/* =========================================================
   State
======================================================== */
const state = {
  channels: [],         // alle geparsten Sender
  filtered: [],         // gefiltert nach Suche + Gruppe
  groups: new Map(),    // gruppenname -> anzahl
  activeGroup: 'Alle',
  search: '',
  view: 'grid',
  currentChannel: null,
  currentIndex: -1,
  history: [],
  hls: null,
  // EPG (lokal geladen)
  epgPrograms: new Map(),
  epgLoaded: false,
  // Untertitel – delegiert an SubtitleManager
  subtitleTracks: [],
  subtitleActiveTrack: -1,
  subtitleCues: [],
};

const STORAGE = {
  history: 'm3u_history',
  lastUrl: 'm3u_last_url',
  volume: 'm3u_volume',
};

/* =========================================================
   DOM
======================================================== */
const $ = (id) => document.getElementById(id);
const els = {
  channels: $('channels'),
  groupList: $('groupList'),
  groupCount: $('groupCount'),
  channelInfo: $('channelInfo'),
  searchInput: $('searchInput'),
  video: $('videoEl'),
  audio: $('audioEl'),
  poster: $('poster'),
  loadingOverlay: $('loadingOverlay'),
  npLogo: $('npLogo'),
  npTitle: $('npTitle'),
  npSub: $('npSub'),
  playPauseBtn: $('playPauseBtn'),
  playIcon: $('playIcon'),
  pauseIcon: $('pauseIcon'),
  stopBtn: $('stopBtn'),
  fullscreenBtn: $('fullscreenBtn'),
  volumeRange: $('volumeRange'),
  historyList: $('historyList'),
  sidebar: $('sidebar'),
  scrim: $('scrim'),
  menuBtn: $('menuBtn'),
  modalBackdrop: $('modalBackdrop'),
  loadPlaylistBtn: $('loadPlaylistBtn'),
  closeModalBtn: $('closeModalBtn'),
  cancelModalBtn: $('cancelModalBtn'),
  loadBtn: $('loadBtn'),
  urlInput: $('urlInput'),
  fileInput: $('fileInput'),
  pasteInput: $('pasteInput'),
  corsProxySelect: $('corsProxySelect'),
  // Untertitel
  subtitleToggleBtn: $('subtitleToggleBtn'),
  subtitleSettingsBtn: $('subtitleSettingsBtn'),
  subtitleOverlay: $('subtitleOverlay'),
  subtitleText: $('subtitleText'),
  npEpg: $('npEpg'),
  subtitleSettingsModal: $('subtitleSettingsModal'),
  subtitleLoaderModal: $('subtitleLoaderModal'),
  // Settings-Form
  subFontFamily: $('subFontFamily'),
  subFontSize: $('subFontSize'),
  subFontSizeVal: $('subFontSizeVal'),
  subFontWeight: $('subFontWeight'),
  subTextColor: $('subTextColor'),
  subTextColorVal: $('subTextColorVal'),
  subTextColorPreview: $('subTextColorPreview'),
  subBgColor: $('subBgColor'),
  subBgColorVal: $('subBgColorVal'),
  subBgColorPreview: $('subBgColorPreview'),
  subBgOpacity: $('subBgOpacity'),
  subBgOpacityVal: $('subBgOpacityVal'),
  subBorderColor: $('subBorderColor'),
  subBorderColorVal: $('subBorderColorVal'),
  subBorderColorPreview: $('subBorderColorPreview'),
  subBorderWidth: $('subBorderWidth'),
  subBorderWidthVal: $('subBorderWidthVal'),
  subBorderRadius: $('subBorderRadius'),
  subBorderRadiusVal: $('subBorderRadiusVal'),
  subPosition: $('subPosition'),
  subPadding: $('subPadding'),
  subPaddingVal: $('subPaddingVal'),
  subMultiLine: $('subMultiLine'),
  // Loader
  subFileInput: $('subFileInput'),
  subUrlInput: $('subUrlInput'),
  subPasteInput: $('subPasteInput'),
  toastContainer: $('toastContainer'),
  epgFileInput: $('epgFileInput'),
};

/* =========================================================
   SubtitleManager initialisieren
======================================================== */
const sm = initSubtitleManager(state, els);

/* =========================================================
   Utils
======================================================== */
function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  els.toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(120%)';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

function escapeHtml(s) {
  return String(s != null ? s : '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function placeholderImg(name) {
  const letter = (name || '?').trim().charAt(0).toUpperCase();
  const safeLetter = letter.replace(/[<>&"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="100%" height="100%" fill="#1a2238"/><text x="50%" y="55%" font-family="sans-serif" font-size="36" font-weight="bold" fill="#ff5a3c" text-anchor="middle" dominant-baseline="middle">${safeLetter}</text></svg>`;
  try {
    return 'data:image/svg+xml;base64,' + btoa(svg);
  } catch {
    // Non-ASCII: encode via URI before base64
    const encoded = encodeURIComponent(svg).replace(/'/g, '%27');
    return 'data:image/svg+xml;charset=utf-8,' + encoded;
  }
}

/* =========================================================
   CORS-Proxy
======================================================== */
let currentCORSProxy = '';
try { currentCORSProxy = localStorage.getItem('m3u_cors_proxy') || ''; } catch {}

/* =========================================================
   M3U Parser
======================================================== */
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    if (t.startsWith('#EXTINF')) {
      const item = {
        name: '', url: '', logo: '', group: 'Ohne Gruppe',
        tvgId: '', tvgName: '', language: '', country: '',
        duration: -1, type: 'unknown', radio: false,
      };

      const afterExtinf = t.substring(t.indexOf(':') + 1);

      // Letztes Komma außerhalb von Quotes
      let inQuote = false;
      let commaIdx = -1;
      for (let k = 0; k < afterExtinf.length; k++) {
        const ch = afterExtinf[k];
        if (ch === '"') inQuote = !inQuote;
        else if (ch === ',' && !inQuote) { commaIdx = k; break; }
      }

      let attrPart = afterExtinf;
      let namePart = '';
      if (commaIdx >= 0) {
        attrPart = afterExtinf.substring(0, commaIdx);
        namePart = afterExtinf.substring(commaIdx + 1).trim();
      }

      const durMatch = attrPart.match(/^(-?\d+(?:\.\d+)?)/);
      if (durMatch) {
        item.duration = parseFloat(durMatch[1]);
        attrPart = attrPart.substring(durMatch[0].length).trim();
      }

      const attrRegex = /([a-zA-Z0-9_-]+)=("([^"]*)"|'([^']*)'|(\S+))/g;
      let m;
      while ((m = attrRegex.exec(attrPart)) !== null) {
        const key = m[1].toLowerCase();
        const val = m[3] ?? m[4] ?? m[5] ?? '';
        switch (key) {
          case 'tvg-id': item.tvgId = val; break;
          case 'tvg-name': item.tvgName = val; break;
          case 'tvg-logo': item.logo = val; break;
          case 'group-title': item.group = val || 'Ohne Gruppe'; break;
          case 'tvg-language': item.language = val; break;
          case 'tvg-country': item.country = val; break;
          case 'radio': item.radio = val === 'true' || val === '1'; break;
        }
      }

      item.name = namePart || item.tvgName || 'Unbekannt';
      current = item;
    } else if (t.startsWith('#EXTGRP:')) {
      if (current) current.group = t.substring(8).trim() || current.group;
    } else if (t.startsWith('#')) {
      continue;
    } else {
      if (current) {
        current.url = t;
        current.type = detectType(t, current);
        channels.push(current);
        current = null;
      }
    }
  }
  // Duplikate nach URL entfernen (erster Eintrag gewinnt)
  const seen = new Set();
  const unique = [];
  for (const ch of channels) {
    if (!seen.has(ch.url)) {
      seen.add(ch.url);
      unique.push(ch);
    }
  }
  return unique;
}

function detectType(url, channel) {
  const u = (url || '').split('?')[0].toLowerCase();
  if (u.endsWith('.m3u8') || u.includes('.m3u8/')) return 'hls';
  if (u.endsWith('.mp4')) return 'mp4';
  if (u.endsWith('.mp3')) return 'mp3';
  if (u.endsWith('.aac')) return 'aac';
  if (u.endsWith('.m3u')) return 'm3u';
  if (u.endsWith('.ts')) return 'ts';
  const n = (channel.name || '').toLowerCase();
  if (/radio|fm|music|hits|audio/.test(n)) return 'audio';
  return 'unknown';
}

function isAudioChannel(ch) {
  if (ch.radio) return true;
  return ch.type === 'mp3' || ch.type === 'aac' || ch.type === 'audio';
}

/* =========================================================
   Playlist laden
======================================================== */
async function loadPlaylistFromUrl(url) {
  if (!url) return;

  async function tryFetch(fetchUrl, label) {
    const res = await fetch(fetchUrl, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ingestPlaylist(await res.text(), url);
    localStorage.setItem(STORAGE.lastUrl, url);
    return true;
  }

  try {
    els.loadingOverlay.classList.add('show');
    let success = false;

    const proxies = [
      { get: () => currentCORSProxy ? `${currentCORSProxy}${encodeURIComponent(url)}` : null, name: 'Konfiguriert' },
      { get: () => url, name: 'Direkt' },
      { get: () => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, name: 'allorigins.win' },
      { get: () => `https://codetunnel.io/proxy?url=${encodeURIComponent(url)}`, name: 'codetunnel.io' },
      { get: () => `https://corsproxy.io/?${encodeURIComponent(url)}`, name: 'corsproxy.io' },
    ];

    for (const { get, name } of proxies) {
      const fetchUrl = get();
      if (!fetchUrl) continue;
      try {
        success = await tryFetch(fetchUrl, name);
        break;
      } catch (e) { /* nächster */ }
    }

    if (!success) toast('Alle Methoden sind fehlgeschlagen.', 'error', 6000);
  } catch (e) {
    toast('Fehler beim Laden: ' + e.message, 'error', 6000);
  } finally {
    els.loadingOverlay.classList.remove('show');
  }
}

function loadPlaylistFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => ingestPlaylist(String(reader.result), file.name);
  reader.onerror = () => toast('Datei konnte nicht gelesen werden.', 'error');
  reader.readAsText(file);
}

function ingestPlaylist(text, sourceName) {
  const channels = parseM3U(text);
  if (!channels.length) {
    toast('Keine Sender in der Playlist gefunden.', 'error');
    return;
  }
  state.channels = channels;
  buildGroups();
  applyFilter();
  closeModal();
  toast(`${channels.length} Sender geladen aus ${sourceName}`, 'success');
}

/* =========================================================
    EPG (XMLTV) – Lokale Datei laden & gzip-entpacken
    ========================================================= */

function loadEpgFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const buffer = reader.result;
    let epgText = null;

    // Prüfen ob es sich um gzip handelt (Magic Bytes: 1f 8b)
    const uint8 = new Uint8Array(buffer);
    if (uint8[0] === 0x1f && uint8[1] === 0x8b) {
      try {
        epgText = await decompressGzip(buffer);
        toast('EPG (.xml.gz) entpackt und geladen', 'success', 2000);
      } catch (e) {
        toast('EPG konnte nicht entpackt werden: ' + e.message, 'error', 4000);
        return;
      }
    } else {
      epgText = new TextDecoder().decode(uint8);
    }

    if (!epgText) {
      toast('EPG-Datei leer oder ungültig.', 'error');
      return;
    }

    const programs = parseXmltv(epgText);
    if (programs.size) {
      state.epgPrograms = programs;
      state.epgLoaded = true;
      toast(`EPG geladen: ${programs.size} Kanäle`, 'success', 3000);
      // Falls ein Sender läuft, Anzeige aktualisieren
      if (state.currentChannel) updateNowPlaying(state.currentChannel);
    } else {
      toast('Keine EPG-Programme in der Datei gefunden.', 'error');
      console.error('EPG-Datei keine Programme. XML-Start:', epgText.substring(0, 800));
    }
  };
  reader.onerror = () => toast('EPG-Datei konnte nicht gelesen werden.', 'error');

  if (file.name.endsWith('.gz') || file.name.endsWith('.xml.gz')) {
    reader.readAsArrayBuffer(file);
  } else {
    reader.readAsText(file);
  }
}

/**
 * Gzip-komprimierte Daten mit der Browser API entpacken.
 * Funktioniert in Chrome 80+, Firefox 113+, Safari 16.4+
 */
async function decompressGzip(data) {
  try {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    const resultBlob = await new Response(stream).blob();
    return await resultBlob.text();
  } catch (e) {
    throw new Error('Decompression fehlgeschlagen (Browser unterstützt DecompressionStream nicht).');
  }
}

/**
 * XMLTV-Datei parsen.
 */
function parseXmltv(xml) {
  const programs = new Map();
  if (!xml || typeof xml !== 'string' || xml.length < 100) return programs;

  const normalized = xml.replace(/>\s*</g, '><').replace(/\r\n/g, '\n');
  const progRegex = /<programme([^>]*)>/g;
  let progMatch;

  while ((progMatch = progRegex.exec(normalized)) !== null) {
    const attrsStr = progMatch[1];
    const tagEnd = progMatch.index + progMatch[0].length;
    const closeTagIdx = normalized.indexOf('</programme>', tagEnd);
    if (closeTagIdx === -1) continue;

    const content = normalized.substring(tagEnd, closeTagIdx);

    const channelMatch = attrsStr.match(/channel\s*=\s*["']([^"']+)["']/i);
    const startMatch = attrsStr.match(/start\s*=\s*["']([^"']+)["']/i);
    const stopMatch = attrsStr.match(/stop\s*=\s*["']([^"']+)["']/i);
    if (!channelMatch || !startMatch || !stopMatch) continue;

    const titleMatch = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const start = parseXmltvTime(startMatch[1]);
    const stop = parseXmltvTime(stopMatch[1]);
    if (start <= 0 || stop <= 0 || stop <= start) continue;

    if (!programs.has(channelMatch[1])) programs.set(channelMatch[1], []);
    programs.get(channelMatch[1]).push({
      start, stop,
      title: stripHtml(titleMatch[1]).trim(),
    });
  }

  for (const [, progList] of programs) {
    progList.sort((a, b) => a.start - b.start);
  }
  return programs;
}

function stripHtml(str) { return str.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'); }

function parseXmltvTime(str) {
  const match = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/);
  if (!match) return 0;
  const [, y, m, d, h, min, s, tz] = match;
  const offsetMin = parseInt(tz.substring(1), 10) * 60 * (tz[0] === '-' ? -1 : 1);
  const date = new Date(Date.UTC(parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(h), parseInt(min), parseInt(s)));
  // Zeitzonenoffset in Sekunden, hinzufügen
  return Math.floor(date.getTime() / 1000) + offsetMin * 60;
}

function getEpgForChannel(channel) {
  if (!channel || !channel.tvgId || !state.epgLoaded) return { current: null, next: null };
  const progList = state.epgPrograms.get(channel.tvgId);
  if (!progList || !progList.length) return { current: null, next: null };

  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < progList.length; i++) {
    if (now >= progList[i].start && now < progList[i].stop) {
      return { current: progList[i], next: progList[i + 1] || null };
    }
  }
  // Keine aktuelle Sendung – nächste finden
  for (const prog of progList) {
    if (prog.start > now) return { current: null, next: prog };
  }
  return { current: null, next: progList[0] }; // letzte Sendung des Tages
}

function updateEpgDisplay(ch) {
  if (!els.npEpg) return;

  if (!state.epgLoaded || !ch || !ch.tvgId) {
    els.npEpg.style.display = 'none';
    return;
  }

  const epg = getEpgForChannel(ch);
  if (!epg.current && !epg.next) {
    els.npEpg.style.display = 'none';
    return;
  }

  const lines = [];
  if (epg.current) {
    const duration = epg.current.stop - epg.current.start;
    const elapsed = Math.floor(Date.now() / 1000) - epg.current.start;
    const progress = Math.min(100, Math.round((elapsed / duration) * 100));
    const endTime = new Date(epg.current.stop * 1000);
    const timeStr = endTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    lines.push(`<div class="epg-program current">
      <span class="epg-label">Aktuell</span>
      <span class="epg-title">${escapeHtml(epg.current.title)}</span>
      <span class="epg-time">bis ${timeStr}</span>
      <div class="epg-progress"><div class="epg-bar" style="width:${progress}%"></div></div>
    </div>`);
  }
  if (epg.next) {
    lines.push(`<div class="epg-program next">
      <span class="epg-label">Nächste</span>
      <span class="epg-title">${escapeHtml(epg.next.title)}</span>
    </div>`);
  }
  els.npEpg.innerHTML = lines.join('<div class="epg-divider"></div>');
  els.npEpg.style.display = '';
}

/** Periodisch EPG-Fortschrittsbalken aktualisieren (alle 30 Sek.) */
let epgTimer = null;

function startEpgTimer() {
  stopEpgTimer();
  epgTimer = setInterval(() => {
    if (state.currentChannel && state.epgLoaded) {
      updateEpgDisplay(state.currentChannel);
    }
  }, 30000);
}

function stopEpgTimer() {
  if (epgTimer) { clearInterval(epgTimer); epgTimer = null; }
}

function buildGroups() {
  const tvCount = state.channels.filter(ch => !isAudioChannel(ch)).length;
  const radioCount = state.channels.filter(ch => isAudioChannel(ch)).length;
  state.groups = new Map();
  state.groups.set('Alle', state.channels.length);
  state.groups.set('TV', tvCount);
  state.groups.set('Radio', radioCount);
  for (const ch of state.channels) {
    const g = ch.group || 'Ohne Gruppe';
    state.groups.set(g, (state.groups.get(g) || 0) + 1);
  }
  renderGroups();
}

function renderGroups() {
  els.groupList.innerHTML = '';
  els.groupCount.textContent = `${state.groups.size} Gruppen`;
  const sorted = Array.from(state.groups.entries()).sort((a, b) => {
    const order = ['Alle', 'TV', 'Radio'];
    const idxA = order.indexOf(a[0]);
    const idxB = order.indexOf(b[0]);
    if (idxA >= 0 && idxB >= 0) return idxA - idxB;
    if (idxA >= 0) return -1;
    if (idxB >= 0) return 1;
    return a[0].localeCompare(b[0], 'de');
  });

  let hasShownDefaults = false;
  for (const [name, count] of sorted) {
    if (!hasShownDefaults && !['Alle', 'TV', 'Radio'].includes(name)) {
      const sep = document.createElement('div');
      sep.className = 'group-separator';
      sep.textContent = '—';
      els.groupList.appendChild(sep);
      hasShownDefaults = true;
    }
    let label = escapeHtml(name);
    let icon = '';
    if (name === 'TV') {
      icon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M9 22h6M12 18v4"/></svg> `;
    } else if (name === 'Radio') {
      icon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M8.5 15.5c-1.7-1.7-1.7-4.5 0-6.2"/><path d="M12 12"/><path d="M15.5 8.5c1.7 1.7 1.7 4.5 0 6.2"/><path d="M19.1 4.9c3.9 3.9 3.9 10.2 0 14.1"/><circle cx="12" cy="12" r="2"/><path d="M23 12h-1"/></svg> `;
    }
    const div = document.createElement('div');
    div.className = 'group-item' + (state.activeGroup === name ? ' active' : '');
    div.innerHTML = `<span>${icon}${label}</span><span class="count">${count}</span>`;
    div.addEventListener('click', () => {
      state.activeGroup = name;
      renderGroups();
      applyFilter();
      closeSidebarMobile();
    });
    els.groupList.appendChild(div);
  }
}

/* =========================================================
   Filter & Render
======================================================== */
function applyFilter() {
  const q = state.search.trim().toLowerCase();
  state.filtered = state.channels.filter(ch => {
    if (state.activeGroup === 'TV' && isAudioChannel(ch)) return false;
    if (state.activeGroup === 'Radio' && !isAudioChannel(ch)) return false;
    if (state.activeGroup !== 'Alle' && state.activeGroup !== 'TV' && state.activeGroup !== 'Radio' && ch.group !== state.activeGroup) return false;
    if (!q) return true;
    return (
      ch.name.toLowerCase().includes(q) ||
      (ch.tvgName || '').toLowerCase().includes(q) ||
      (ch.group || '').toLowerCase().includes(q) ||
      (ch.language || '').toLowerCase().includes(q)
    );
  });
  renderChannels();
  // Index des laufenden Senders aktualisieren (falls noch im Filter)
  if (state.currentChannel) {
    state.currentIndex = state.filtered.indexOf(state.currentChannel);
    updateNowPlaying(state.currentChannel);
  }
}

function renderChannels() {
  els.channels.className = 'channels' + (state.view === 'list' ? ' list-view' : '');
  els.channels.innerHTML = '';

  if (!state.channels.length) {
    els.channelInfo.textContent = 'Keine Sender geladen';
    els.channels.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16v12H4z"/><path d="M2 20h20M8 8h8M8 12h5"/></svg>
        <h2>Keine Playlist geladen</h2>
        <p>Lade eine M3U-Playlist per URL, Datei oder durch Einfügen des Inhalts.</p>
        <button class="btn primary" id="emptyLoadBtn">Playlist laden</button>
      </div>`;
    $('emptyLoadBtn')?.addEventListener('click', openModal);
    return;
  }

  els.channelInfo.textContent = `${state.filtered.length} von ${state.channels.length} Sendern`;

  if (!state.filtered.length) {
    els.channels.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;">
      <h2>Keine Treffer</h2>
      <p>Passe Suche oder Gruppe an.</p>
    </div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const ch of state.filtered) {
    const card = document.createElement('div');
    card.className = 'channel' + (state.currentChannel === ch ? ' active' : '');
    const logo = ch.logo || placeholderImg(ch.name);
    const typeLabel = typeToLabel(ch.type);
    const safeFallback = placeholderImg(ch.name).replace(/'/g, '&#39;');
    card.innerHTML = `
      <div class="thumb">
        <img src="${escapeHtml(logo)}" alt="${escapeHtml(ch.name)}" loading="lazy" onerror="this.src='${safeFallback}'" />
        ${typeLabel ? `<span class="badge">${typeLabel}</span>` : ''}
      </div>
      <div class="body">
        <div class="name">${escapeHtml(ch.name)}</div>
        <div class="meta">${escapeHtml(ch.group || '—')}${ch.language ? ' · ' + escapeHtml(ch.language) : ''}</div>
      </div>
    `;
    card.addEventListener('click', () => playChannel(ch));
    frag.appendChild(card);
  }
  els.channels.appendChild(frag);
}

function typeToLabel(t) {
  switch (t) {
    case 'hls': return 'HLS'; case 'mp4': return 'MP4'; case 'mp3': return 'MP3';
    case 'aac': return 'AAC'; case 'm3u': return 'M3U'; case 'ts': return 'TS';
    default: return '';
  }
}

/* =========================================================
   Player
======================================================== */
async function playChannel(ch) {
  if (!ch || !ch.url) {
    toast('Sender hat keine gültige URL.', 'error');
    return;
  }

  state.currentChannel = ch;
  // Index im aktuellen Filter-Array tracken
  state.currentIndex = state.filtered.indexOf(ch);
  renderChannels();
  updateNowPlaying(ch);
  addToHistory(ch);
  showLoading(true);

  // Vorheriges HLS & Untertitel aufräumen
  cleanupHls();
  resetMediaElements();
  sm.deactivate();

  try {
    const type = ch.type;

    if (type === 'hls' || type === 'm3u') {
      if (window.Hls && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 30 });
        state.hls = hls;

        hls.loadSource(ch.url);
        hls.attachMedia(els.video);
        els.video.style.display = '';
        els.audio.style.display = 'none';

        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          safePlay(els.video);

          // Browser-TextTracks sofort deaktivieren
          if (els.video?.textTracks) {
            for (let i = 0; i < els.video.textTracks.length; i++) {
              els.video.textTracks[i].mode = 'disabled';
            }
          }
        });

        // Timeout
        let streamTimeout = setTimeout(() => {
          if (els.video.paused && state.currentChannel === ch) {
            toast('Stream startet nicht (Timeout).', 'error', 5000);
            cleanupHls();
          }
        }, 15000);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { clearTimeout(streamTimeout); });

        // HLS Subtitle Events – Handler entfernen, um Doppeleinträge zu vermeiden
        ['SUBTITLE_TRACKS_UPDATED', 'SUBTITLE_TRACKS_ADDED'].forEach(evt => {
          if (Hls.Events[evt]) {
            hls.off(Hls.Events[evt], onHlsSubtitleUpdate);
            hls.on(Hls.Events[evt], onHlsSubtitleUpdate);
          }
        });
        if (Hls.Events.SUBTITLE_TRACK_LOADED) {
          hls.off(Hls.Events.SUBTITLE_TRACK_LOADED, onHlsSubtitleTrackLoaded);
          hls.on(Hls.Events.SUBTITLE_TRACK_LOADED, onHlsSubtitleTrackLoaded);
        }

      } else {
        throw new Error('HLS wird in diesem Browser nicht unterstützt.');
      }

    } else if (type === 'mp4' || type === 'ts') {
      els.video.src = ch.url;
      els.video.style.display = '';
      els.audio.style.display = 'none';
      await safePlay(els.video);

    } else if (type === 'mp3' || type === 'aac' || type === 'audio') {
      els.audio.src = ch.url;
      els.audio.style.display = '';
      els.video.style.display = 'none';
      await safePlay(els.audio);
      els.poster.style.display = 'grid';
      const logoFallback = (ch.logo || placeholderImg(ch.name)).replace(/'/g, '&#39;');
      els.poster.innerHTML = `<img src="${escapeHtml(ch.logo || placeholderImg(ch.name))}" alt="${escapeHtml(ch.name)}" onerror="this.src='${logoFallback}'" />`;

    } else {
      els.video.src = ch.url;
      els.video.style.display = '';
      els.audio.style.display = 'none';
      await safePlay(els.video);
    }

    showLoading(false);
    updatePlayPauseIcon();

    // Untertitel aktiv, Render-Loop starten
    if (sm.enabled && !sm.active && state.hls) {
      await sm._enable();
    }


  } catch (e) {
    showLoading(false);
    toast('Wiedergabe fehlgeschlagen: ' + (e.message || e), 'error', 6000);
  }
}

function safePlay(media) {
  els.poster.style.display = 'none';
  const p = media.play();
  if (p && p.catch) {
    return p.catch(err => {
      if (err.name === 'NotAllowedError') {
        media.muted = true;
        return media.play().catch(e2 => { throw e2; });
      }
      throw err;
    });
  }
  return Promise.resolve();
}

function cleanupHls() {
  if (state.hls) {
    try { state.hls.destroy(); } catch {}
    state.hls = null;
  }
}

function resetMediaElements() {
  try { els.video.pause(); } catch {}
  try { els.audio.pause(); } catch {}
  els.video.removeAttribute('src');
  els.audio.removeAttribute('src');
  if (els.video) {
    const tracks = els.video.querySelectorAll('track');
    for (const t of tracks) t.remove();
  }
  els.video.load();
  // Media-Event-Listener neu binden (nach Reset des Elements)
  bindMediaEvents(els.video);
  bindMediaEvents(els.audio);
}

function updateNowPlaying(ch) {
  els.npTitle.textContent = ch.name;
  const parts = [];
  if (ch.group) parts.push(ch.group);
  if (ch.language) parts.push(ch.language);
  if (ch.tvgId) parts.push('ID: ' + ch.tvgId);
  els.npSub.textContent = parts.join(' · ') || '—';

  // EPG-Anzeige
  updateEpgDisplay(ch);

  if (ch.logo) {
    els.npLogo.src = ch.logo;
    els.npLogo.style.display = '';
    els.npLogo.onerror = () => { els.npLogo.src = placeholderImg(ch.name); };
  } else {
    els.npLogo.style.display = 'none';
  }
}

function showLoading(on) {
  els.loadingOverlay.classList.toggle('show', on);
}

/* =========================================================
   Play / Stop / Fullscreen
======================================================== */
function togglePlayPause() {
  const media = els.video.style.display === 'none' ? els.audio : els.video;
  if (!media.src && !state.hls) return;
  if (media.paused) {
    media.play().catch(e => toast('Abspielen nicht möglich: ' + e.message, 'error'));
  } else {
    media.pause();
  }
  updatePlayPauseIcon();
}

function updatePlayPauseIcon() {
  const media = els.video.style.display === 'none' ? els.audio : els.video;
  const playing = !media.paused && !media.ended;
  els.playIcon.style.display = playing ? 'none' : '';
  els.pauseIcon.style.display = playing ? '' : 'none';
}


function stopPlayback() {
  cleanupHls();
  resetMediaElements();
  sm.deactivate();
  sm.enabled = false;
  sm.updateToggleUI(els.subtitleToggleBtn, false);
  state.currentChannel = null;
  state.subtitleCues = [];
  state.subtitleActiveTrack = -1;
  els.npTitle.textContent = 'Kein Sender ausgewählt';
  els.npSub.textContent = '—';
  els.npLogo.style.display = 'none';
  els.poster.style.display = 'grid';
  els.poster.innerHTML = `<div class="empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8M12 18v4"/></svg>
    <div>Wähle einen Sender aus der Liste</div>
  </div>`;
  updatePlayPauseIcon();
  renderChannels();
  saveSubtitleSettings();
  stopEpgTimer();
}

function toggleFullscreen() {
  const stage = $('playerStage');
  if (!document.fullscreenElement) {
    (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
  } else {
    document.exitFullscreen?.();
  }
}

/* =========================================================
   HLS Subtitle Events (Handler)
======================================================== */
function onHlsSubtitleUpdate() {
  sm.detectTracks();
  if (sm.enabled && !sm.active) {
    sm._enable();
  }
}

function onHlsSubtitleTrackLoaded() {
  if (els.video?.textTracks) {
    for (let i = 0; i < els.video.textTracks.length; i++) {
      els.video.textTracks[i].mode = 'disabled';
    }
  }
}

/* =========================================================
   History
======================================================== */
function addToHistory(ch) {
  state.history = state.history.filter(h => h.url !== ch.url);
  state.history.unshift({ name: ch.name, url: ch.url, logo: ch.logo, group: ch.group, type: ch.type, radio: ch.radio });
  state.history = state.history.slice(0, 20);
  saveHistory();
  renderHistory();
}

function saveHistory() {
  try { localStorage.setItem(STORAGE.history, JSON.stringify(state.history)); } catch {}
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE.history);
    if (raw) state.history = JSON.parse(raw);
  } catch {}
  renderHistory();
}

function renderHistory() {
  if (!state.history.length) {
    els.historyList.innerHTML = `<div style="color: var(--muted); font-size: 13px; padding: 8px 4px;">Noch keine Sender abgespielt.</div>`;
    return;
  }
  els.historyList.innerHTML = '';
  for (const h of state.history.slice(0, 10)) {
    const c = state.channels.find(c => c.url === h.url) || h;
    const div = document.createElement('div');
    div.className = 'history-item';
    const imgFallback = placeholderImg(h.name).replace(/'/g, '&#39;');
    div.innerHTML = `
      <img src="${escapeHtml(h.logo || placeholderImg(h.name))}" alt="" onerror="this.src='${imgFallback}'" />
      <div class="meta">
        <div class="name">${escapeHtml(h.name)}</div>
        <div class="sub">${escapeHtml(h.group || '')}</div>
      </div>
    `;
    div.addEventListener('click', () => {
      const full = state.channels.find(c => c.url === h.url);
      playChannel(full || h);
    });
    els.historyList.appendChild(div);
  }
}

/* =========================================================
   Modal
======================================================== */
function openModal() {
  els.modalBackdrop.classList.add('show');
  try { els.urlInput.value = localStorage.getItem(STORAGE.lastUrl) || ''; } catch {}
  els.fileInput.value = '';
  els.pasteInput.value = '';
  if (els.corsProxySelect) els.corsProxySelect.value = currentCORSProxy;
  setTimeout(() => els.urlInput.focus(), 50);
}

function closeModal() {
  els.modalBackdrop.classList.remove('show');
  resetPlaylistInputs();
}

/** Datei- und Text-Inputs für das Playlist-Modal zurücksetzen */
function resetPlaylistInputs() {
  if (els.fileInput) els.fileInput.value = '';
  if (els.epgFileInput) els.epgFileInput.value = '';
  if (els.pasteInput) els.pasteInput.value = '';
}

/** Datei- und Text-Inputs für das Untertitel-Modal zurücksetzen */
function resetSubtitleInputs() {
  if (els.subFileInput) els.subFileInput.value = '';
  if (els.subUrlInput) els.subUrlInput.value = '';
  if (els.subPasteInput) els.subPasteInput.value = '';
}

async function handleLoad() {
  const url = els.urlInput.value.trim();
  const file = els.fileInput.files[0];
  const paste = els.pasteInput.value.trim();

  if (file) { loadPlaylistFromFile(file); resetPlaylistInputs(); return; }
  if (paste) { ingestPlaylist(paste, 'Eingefügter Inhalt'); resetPlaylistInputs(); return; }
  if (url) { await loadPlaylistFromUrl(url); resetPlaylistInputs(); return; }
  toast('Bitte URL, Datei oder Inhalt angeben.', 'error');
  resetPlaylistInputs();
}

/* =========================================================
   Sidebar Mobile
======================================================== */
function openSidebarMobile() { els.sidebar.classList.add('open'); els.scrim.classList.add('show'); }
function closeSidebarMobile() { els.sidebar.classList.remove('open'); els.scrim.classList.remove('show'); }

/* =========================================================
   Untertitel – Settings Modal
======================================================== */
function openSubtitleSettingsModal() {
  els.subtitleSettingsModal.classList.add('show');
  sm.populateForm(els);
  sm._updatePreview();
}

function closeSubtitleSettingsModal() { els.subtitleSettingsModal.classList.remove('show'); }

function openSubtitleLoaderModal() { els.subtitleLoaderModal.classList.add('show'); }
function closeSubtitleLoaderModal() {
  els.subtitleLoaderModal.classList.remove('show');
  resetSubtitleInputs();
}

/* =========================================================
   Untertitel – Event Handler
======================================================== */
async function handleLoadSubtitles() {
  const file = els.subFileInput?.files[0];
  const url = els.subUrlInput?.value.trim();
  const paste = els.subPasteInput?.value.trim();

  if (!file && !url && !paste) {
    toast('Bitte eine Datei, URL oder Text angeben.', 'error');
    return;
  }

  try {
    const count = await sm.loadExternalSource(file, url, paste);
    closeSubtitleLoaderModal();
    if (count > 0) {
      sm.enabled = true;
      sm.updateToggleUI(els.subtitleToggleBtn, true);
      sm._startRenderLoop();
      toast(`${count} Untertitel geladen`, 'success');
    } else {
      toast('Keine Untertitel gefunden.', 'error');
    }
  } catch (e) {
    toast('Fehler: ' + e.message, 'error');
  }
}

/* =========================================================
   Media-Event-Binding (top-level, auch von resetMediaElements aufrufbar)
======================================================== */
function bindMediaEvents(mediaEl) {
  if (!mediaEl) return;
  const mediaEvents = ['play', 'pause', 'ended', 'waiting', 'playing', 'canplay', 'error'];
  for (const ev of mediaEvents) {
    mediaEl.addEventListener(ev, onMediaEvent);
  }
}

/* =========================================================
   Events
======================================================== */
function bindEvents() {
  // Suche
  els.searchInput.addEventListener('input', e => {
    state.search = e.target.value;
    applyFilter();
  });

  // Playlist-Modal
  els.loadPlaylistBtn.addEventListener('click', openModal);
  els.closeModalBtn.addEventListener('click', closeModal);
  els.cancelModalBtn.addEventListener('click', closeModal);
  els.loadBtn.addEventListener('click', handleLoad);
  els.modalBackdrop.addEventListener('click', e => { if (e.target === els.modalBackdrop) closeModal(); });

  // CORS-Proxy
  els.corsProxySelect?.addEventListener('change', e => {
    currentCORSProxy = e.target.value;
    localStorage.setItem('m3u_cors_proxy', currentCORSProxy);
  });

  // EPG-Datei
  els.epgFileInput?.addEventListener('change', e => {
    if (e.target.files[0]) loadEpgFromFile(e.target.files[0]);
  });

  // Player-Controls
  els.playPauseBtn.addEventListener('click', togglePlayPause);
  els.stopBtn.addEventListener('click', stopPlayback);
  els.fullscreenBtn.addEventListener('click', toggleFullscreen);

  // Volume
  els.volumeRange.addEventListener('input', e => {
    const v = e.target.value / 100;
    els.video.volume = v;
    els.audio.volume = v;
    localStorage.setItem(STORAGE.volume, String(v));
  });

  // View toggle
  document.querySelectorAll('.view-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.view = btn.dataset.view;
      renderChannels();
    });
  });

  // Sidebar
  els.menuBtn.addEventListener('click', openSidebarMobile);
  els.scrim.addEventListener('click', closeSidebarMobile);

  /* ---------- Untertitel ---------- */

  // Toggle
  els.subtitleToggleBtn.addEventListener('click', () => {
    sm.toggle();
    sm.updateToggleUI(els.subtitleToggleBtn, sm.enabled);
    toast(sm.enabled ? 'Untertitel aktiviert' : 'Untertitel deaktiviert');
  });

  // Settings Modal
  els.subtitleSettingsBtn.addEventListener('click', openSubtitleSettingsModal);
  els.subtitleSettingsModal.addEventListener('click', e => {
    if (e.target === els.subtitleSettingsModal) closeSubtitleSettingsModal();
  });
  $('closeSubtitleSettingsBtn')?.addEventListener('click', closeSubtitleSettingsModal);
  $('applySubtitleSettingsBtn')?.addEventListener('click', () => {
    sm.readSettingsFromForm(els);
    closeSubtitleSettingsModal();
    toast('Untertitel-Einstellungen angewendet', 'success');
  });
  $('resetSubtitleSettingsBtn')?.addEventListener('click', () => {
    sm.resetSettings();
    sm.populateForm(els);
    sm._updatePreview();
    toast('Einstellungen zurückgesetzt');
  });

  // Loader Modal
  els.subtitleLoaderModal.addEventListener('click', e => {
    if (e.target === els.subtitleLoaderModal) closeSubtitleLoaderModal();
  });
  $('closeSubtitleLoaderBtn')?.addEventListener('click', closeSubtitleLoaderModal);
  $('cancelSubtitleLoaderBtn')?.addEventListener('click', closeSubtitleLoaderModal);
  $('loadSubtitlesBtn')?.addEventListener('click', handleLoadSubtitles);

  // Range-Value-Updates
  els.subFontSize?.addEventListener('input', e => { els.subFontSizeVal && (els.subFontSizeVal.textContent = e.target.value + 'px'); });
  els.subBgOpacity?.addEventListener('input', e => { els.subBgOpacityVal && (els.subBgOpacityVal.textContent = e.target.value + '%'); });
  els.subBorderWidth?.addEventListener('input', e => { els.subBorderWidthVal && (els.subBorderWidthVal.textContent = e.target.value + 'px'); });
  els.subBorderRadius?.addEventListener('input', e => { els.subBorderRadiusVal && (els.subBorderRadiusVal.textContent = e.target.value + 'px'); });
  els.subPadding?.addEventListener('input', e => { els.subPaddingVal && (els.subPaddingVal.textContent = e.target.value + 'px'); });

  // Live-Vorschau
  const previewListeners = [
    els.subTextColor, els.subBgColor, els.subBgOpacity,
    els.subBorderColor, els.subBorderWidth, els.subBorderRadius,
    els.subFontFamily, els.subFontWeight, els.subPosition,
    els.subPadding, els.subMultiLine,
  ];
  for (const el of previewListeners) {
    if (el) {
      el.addEventListener('input', sm._updatePreview.bind(sm));
      el.addEventListener('change', sm._updatePreview.bind(sm));
    }
  }

  // Video/Audio-Events initial binden
  bindMediaEvents(els.video);
  bindMediaEvents(els.audio);
}

function onMediaEvent(e) {
  const target = e.target;
  if (target && target.nodeType === 1) {
    switch (e.type) {
      case 'play': case 'pause': case 'ended': updatePlayPauseIcon(); break;
      case 'waiting': showLoading(true); break;
      case 'playing': case 'canplay': showLoading(false); break;
      case 'error':
        showLoading(false);
        toast(`${target.tagName.toLowerCase()}-Fehler`, 'error');
        break;
    }
  }
}

/* =========================================================
   Tastenkürzel
======================================================== */
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (els.modalBackdrop.classList.contains('show')) closeModal();
      else if (document.fullscreenElement) document.exitFullscreen?.();
      else closeSidebarMobile();
    }
    if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      togglePlayPause();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      els.searchInput.focus();
    }
    if (e.key === 'c' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
      toggleSubtitles();
    }
  });
}

function toggleSubtitles() {
  const enabled = sm.toggle();
  sm.updateToggleUI(els.subtitleToggleBtn, enabled);
  saveSubtitleSettings();
}

function saveSubtitleSettings() {
  sm.saveSettings();
}

/* =========================================================
   Init
======================================================== */
function init() {
  // Volume wiederherstellen
  let v = 0.8;
  try { const raw = localStorage.getItem(STORAGE.volume); if (raw !== null) v = parseFloat(raw); } catch {}
  if (isNaN(v)) v = 0.8;
  els.video.volume = v;
  els.audio.volume = v;
  els.volumeRange.value = Math.round(v * 100);

  // Subtitle-Initialisierung
  try { sm.enabled = sm._loadEnabled(); } catch { sm.enabled = false; }
  sm.updateToggleUI(els.subtitleToggleBtn, sm.enabled);
  sm.applyStyles();

  loadHistory();
  bindEvents();
  bindKeys();
  applyFilter();
  startEpgTimer();

  let lastUrl = '';
  try { lastUrl = localStorage.getItem(STORAGE.lastUrl) || ''; } catch {}
  if (lastUrl) {
    loadPlaylistFromUrl(lastUrl);
  } else {
    openModal();
  }
}

init();
