// InstaSaver - Page World Injector (MAIN world, runs at document_start)
// Intercepts Instagram's own data-loading hooks before React runs.

(function () {
  'use strict';

  const store = {}; // shortcode/path → video url

  function cleanUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
      const u = new URL(url);
      u.searchParams.delete('bytestart');
      u.searchParams.delete('byteend');
      u.searchParams.delete('dl');
      return u.toString();
    } catch (_) { return url; }
  }

  function isGood(url) {
    return url && typeof url === 'string' && url.startsWith('http') &&
           !url.startsWith('blob:') && url.length > 40;
  }

  // ── Deep search JSON for video_url ─────────────────────────────────────────
  function findVideoUrl(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 20) return null;
    const vKeys = ['video_url', 'videoUrl', 'playback_url', 'browser_native_hd_url', 'browser_native_sd_url'];
    for (const k of vKeys) {
      if (typeof obj[k] === 'string' && isGood(obj[k])) return obj[k];
    }
    if (Array.isArray(obj.video_versions) && obj.video_versions.length) {
      const best = [...obj.video_versions].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      if (best && isGood(best.url)) return best.url;
    }
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') {
        const found = findVideoUrl(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function saveUrl(data) {
    const url = findVideoUrl(data, 0);
    if (url) {
      const clean = cleanUrl(url);
      const path  = location.pathname;
      store[path] = clean;
      window.__instaSaverVideoUrl = clean; // simple global for quick access
      console.log('[InstaSaver] Saved URL for', path, ':', clean.slice(0, 80));
    }
  }

  // ── Hook 1: window.__additionalDataLoaded ──────────────────────────────────
  // Instagram calls this with the full media data for the current page.
  const _adl = window.__additionalDataLoaded;
  window.__additionalDataLoaded = function (path, data) {
    console.log('[InstaSaver] __additionalDataLoaded fired for:', path);
    try { saveUrl(data); } catch (_) {}
    return _adl ? _adl.apply(this, arguments) : undefined;
  };

  // ── Hook 2: window.__defEarlyPayload ──────────────────────────────────────
  const _dep = window.__defEarlyPayload;
  window.__defEarlyPayload = function (data) {
    try { saveUrl(data); } catch (_) {}
    return _dep ? _dep.apply(this, arguments) : undefined;
  };

  // ── Hook 3: intercept fetch for API/graphql responses ─────────────────────
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res    = await origFetch(...args);
    const reqUrl = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';

    // Capture direct .mp4 CDN request URLs (strip byte-range)
    if (reqUrl.includes('.mp4') && !reqUrl.startsWith('blob:')) {
      const clean = cleanUrl(reqUrl);
      if (!store[location.pathname] || !reqUrl.includes('bytestart')) {
        store[location.pathname] = clean;
        window.__instaSaverVideoUrl = clean;
        console.log('[InstaSaver] fetch mp4:', clean.slice(0, 80));
      }
    }

    // Parse Instagram API/graphql JSON responses
    if (reqUrl.includes('/graphql/') || reqUrl.includes('/api/v1/') || reqUrl.includes('instagram.com')) {
      try {
        const text = await res.clone().text();
        if (text.includes('video_url') || text.includes('video_versions')) {
          saveUrl(JSON.parse(text));
        }
      } catch (_) {}
    }
    return res;
  };

  // ── Hook 4: intercept XHR ─────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (url && url.includes('.mp4') && !url.startsWith('blob:')) {
      const clean = cleanUrl(url);
      if (!store[location.pathname]) {
        store[location.pathname] = clean;
        window.__instaSaverVideoUrl = clean;
      }
    }
    this.addEventListener('load', function () {
      try {
        const t = this.responseText;
        if (t && (t.includes('video_url') || t.includes('video_versions'))) saveUrl(JSON.parse(t));
      } catch (_) {}
    });
    return origOpen.call(this, method, url, ...rest);
  };

  // ── Respond to content.js requests ────────────────────────────────────────
  window.addEventListener('__is_get_video_url', () => {
    const url = store[location.pathname] || window.__instaSaverVideoUrl || null;
    const valid = isGood(url) ? url : null;
    console.log('[InstaSaver] Responding:', valid ? valid.slice(0, 80) : 'none');
    window.dispatchEvent(new CustomEvent('__is_video_url_result', { detail: { url: valid } }));
  });

  window.addEventListener('__is_get_image_url', () => {
    let best = null, bestW = 0;
    document.querySelectorAll('img').forEach(img => {
      const w = img.naturalWidth || img.width || 0;
      if (w < 100) return;
      (img.srcset || '').split(',').forEach(p => {
        const [u, pw] = p.trim().split(/\s+/);
        const n = parseInt(pw) || 0;
        if (n > bestW && u && isGood(u)) { bestW = n; best = u; }
      });
      if (!best && img.src && isGood(img.src)) best = img.src;
    });
    window.dispatchEvent(new CustomEvent('__is_image_url_result', { detail: { url: best } }));
  });

  console.log('[InstaSaver] Injector hooks installed ✓');
})();
