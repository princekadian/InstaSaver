// InstaSaver - Content Script (Isolated World)

(function () {
  'use strict';
  if (window.__instaSaverLoaded) return;
  window.__instaSaverLoaded = true;

  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

  // ── Toast ──────────────────────────────────────────────────────────────────
  function toast(msg, ms) {
    let el = document.getElementById('_is_toast');
    if (!el) {
      el = document.createElement('div');
      el.id = '_is_toast';
      el.className = 'is-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || 4000);
  }

  // ── Strip DASH byte-range params ───────────────────────────────────────────
  function cleanUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      u.searchParams.delete('bytestart');
      u.searchParams.delete('byteend');
      u.searchParams.delete('dl');
      return u.toString();
    } catch (_) { return url; }
  }

  function isValid(url) {
    return url && typeof url === 'string' && url.startsWith('http') && url.length > 40 && !url.startsWith('blob:');
  }

  // ── Filename builder ───────────────────────────────────────────────────────
  function makeFilename(type) {
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
    const parts = location.pathname.split('/').filter(Boolean);
    const skip = ['p', 'reels', 'reel', 'stories', 'tv', 'explore'];
    const user = (!skip.includes(parts[0]) && parts[0]) ? parts[0]
               : (parts[0] === 'stories' && parts[1]) ? parts[1] : 'ig';
    const ext = (type.includes('video') || type === 'reel') ? 'mp4' : 'jpg';
    return `IG_${user.replace(/[^a-z0-9_-]/gi,'_').slice(0,25)}_${type}_${date}_${time}.${ext}`;
  }

  // ── Convert shortcode to Instagram media ID ───────────────────────────────
  function shortcodeToId(code) {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(0);
    for (const c of code) id = id * 64n + BigInt(abc.indexOf(c));
    return id.toString();
  }

  // ── Method A: Instagram internal media API ─────────────────────────────────
  // Converts the reel shortcode → media_id → hits /api/v1/media/{id}/info/
  // carouselIdx: optional 0-based index for carousel posts
  async function fetchViaApi(shortcode, carouselIdx) {
    if (!shortcode) return null;
    try {
      const mediaId = shortcodeToId(shortcode);
      return await fetchMediaById(mediaId, carouselIdx);
    } catch (err) {
      console.warn('[InstaSaver] API fetch error:', err.message);
      return null;
    }
  }

  // ── Fetch media info by numeric ID (works for reels, stories, posts) ──────
  // carouselIdx: if provided, extracts that specific slide from carousel posts
  async function fetchMediaById(mediaId, carouselIdx) {
    if (!mediaId) return null;
    try {
      const resp = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
        credentials: 'include',
        headers: {
          'X-IG-App-ID': '936619743392459',
          'User-Agent': navigator.userAgent,
        }
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const item = data && data.items && data.items[0];
      if (!item) return null;

      // Pick the right media source — carousel slide or single post
      let media = item;
      if (item.carousel_media && item.carousel_media.length > 0 &&
          carouselIdx !== undefined && carouselIdx < item.carousel_media.length) {
        media = item.carousel_media[carouselIdx];
        console.log('[InstaSaver] Using carousel slide', carouselIdx, 'of', item.carousel_media.length);
      }

      // Extract best video
      if (media.video_versions && media.video_versions.length) {
        const best = [...media.video_versions].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
        if (best && isValid(best.url)) return cleanUrl(best.url);
      }
      if (isValid(media.video_url)) return cleanUrl(media.video_url);
      // Extract best image
      if (media.image_versions2 && media.image_versions2.candidates && media.image_versions2.candidates.length) {
        const best = [...media.image_versions2.candidates].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
        if (best && best.url) return cleanUrl(best.url);
      }
      return null;
    } catch (err) {
      console.warn('[InstaSaver] Media API error:', err.message);
      return null;
    }
  }

  // ── Method B: Fetch page HTML and regex-extract video_url ─────────────────
  async function fetchPageVideoUrl(pageUrl) {
    try {
      const resp = await fetch(pageUrl || location.href, {
        credentials: 'include',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-IG-App-ID': '936619743392459',
        }
      });
      if (!resp.ok) return null;
      const html = await resp.text();

      // Multiple patterns for different Instagram HTML formats
      const patterns = [
        /"video_url"\s*:\s*"(https:[^"]+)"/,
        /"video_url"\s*:\s*"(https:\\[^"]+)"/,   // escaped slashes
        /"playback_url"\s*:\s*"(https:[^"]+)"/,
        /"contentUrl"\s*:\s*"(https:[^"]+\.mp4[^"]*)"/,
        /https:\/\/[^"'\s]+\.mp4\?[^"'\s]{20,}/,  // raw mp4 URL anywhere
      ];

      for (const pat of patterns) {
        const m = html.match(pat);
        if (m) {
          const raw = m[1] || m[0];
          const url = cleanUrl(raw.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\/g, ''));
          if (isValid(url)) { console.log('[InstaSaver] Page HTML match:', url.slice(0, 80)); return url; }
        }
      }
      return null;
    } catch (err) {
      console.warn('[InstaSaver] fetchPageVideoUrl error:', err.message);
      return null;
    }
  }

  // ── FALLBACK: Ask injector.js via CustomEvent (fiber/intercept) ────────────
  function askInjectorForUrl() {
    return new Promise((resolve) => {
      const handler = (e) => {
        window.removeEventListener('__is_video_url_result', handler);
        const u = e.detail && e.detail.url;
        resolve(isValid(u) ? cleanUrl(u) : null);
      };
      window.addEventListener('__is_video_url_result', handler);
      window.dispatchEvent(new CustomEvent('__is_get_video_url'));
      setTimeout(() => { window.removeEventListener('__is_video_url_result', handler); resolve(null); }, 3000);
    });
  }

  function askInjectorForImage() {
    return new Promise((resolve) => {
      const handler = (e) => {
        window.removeEventListener('__is_image_url_result', handler);
        resolve(e.detail && e.detail.url || null);
      };
      window.addEventListener('__is_image_url_result', handler);
      window.dispatchEvent(new CustomEvent('__is_get_image_url'));
      setTimeout(() => { window.removeEventListener('__is_image_url_result', handler); resolve(null); }, 2000);
    });
  }

  // ── BLOB download — uses Instagram session cookies via content script ───────
  async function blobDownload(url, filename) {
    if (!isValid(url)) {
      toast('❌ Could not find media URL');
      return;
    }
    toast('⬇️ Downloading… please wait', 20000);
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { 'Referer': 'https://www.instagram.com/' }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (blob.size < 50000) throw new Error(`File too small (${blob.size}b) — likely an error response`);

      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: filename,
        style: 'display:none'
      });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      toast(`✅ Saved! ${filename}`);
    } catch (err) {
      console.error('[InstaSaver] blobDownload error:', err.message);
      toast('⚠️ Opening in new tab — right-click → Save video as…');
      window.open(url, '_blank');
    }
  }

  // ── Get reel video URL — 3 methods in priority order ─────────────────────
  async function getReelUrl() {
    toast('🔍 Finding video URL…', 10000);

    // Extract shortcode from URL: /reels/SHORTCODE/ or /p/SHORTCODE/
    const parts = location.pathname.split('/').filter(Boolean);
    const scIdx = parts.findIndex(p => ['reels','reel','p','tv'].includes(p));
    const shortcode = scIdx !== -1 ? parts[scIdx + 1] : null;

    // Method 1: Instagram internal API (most reliable — server returns real data)
    if (shortcode) {
      const url = await fetchViaApi(shortcode);
      if (url) { console.log('[InstaSaver] Got URL via API'); return url; }
    }

    // Method 2: Page HTML regex (server-rendered page contains video_url)
    const url2 = await fetchPageVideoUrl(location.href);
    if (url2) { console.log('[InstaSaver] Got URL via page HTML'); return url2; }

    // Method 3: Injector hooks (__additionalDataLoaded / fetch intercept)
    const url3 = await askInjectorForUrl();
    if (url3) { console.log('[InstaSaver] Got URL via injector'); return url3; }

    return null;
  }

  // ── Carousel helpers ────────────────────────────────────────────────────────
  // Detect which carousel slide is currently visible (0-indexed)
  function getCarouselIndex(article) {
    // Method 1: Find dot indicators (most reliable)
    // Instagram renders dots as a row of small circular divs; the active one is bigger
    const divs = article.querySelectorAll('div');
    for (const container of divs) {
      const kids = container.children;
      if (kids.length < 2 || kids.length > 15) continue;

      // Check if all children look like dots (small circular elements, 3-14px)
      let allDots = true;
      const rects = [];
      for (let i = 0; i < kids.length; i++) {
        const r = kids[i].getBoundingClientRect();
        rects.push(r);
        if (r.width < 3 || r.width > 14 || r.height < 3 || r.height > 14) {
          allDots = false;
          break;
        }
      }
      if (!allDots || rects.length < 2) continue;

      // Found dots! Active dot is bigger, or has higher opacity
      let maxW = 0, activeIdx = 0;
      rects.forEach((r, i) => {
        if (r.width > maxW) { maxW = r.width; activeIdx = i; }
      });

      // If all same size, check opacity instead
      const allSameSize = rects.every(r => Math.abs(r.width - rects[0].width) < 0.5);
      if (allSameSize) {
        for (let i = 0; i < kids.length; i++) {
          const opacity = parseFloat(getComputedStyle(kids[i]).opacity);
          if (opacity > 0.7) { activeIdx = i; break; }
        }
      }

      console.log('[InstaSaver] Carousel index via dots:', activeIdx, 'of', kids.length);
      return activeIdx;
    }

    // Method 2: Centered <li> fallback
    const lis = article.querySelectorAll('ul li');
    if (lis.length >= 2) {
      const ar = article.getBoundingClientRect();
      const centerX = ar.left + ar.width / 2;
      for (let i = 0; i < lis.length; i++) {
        const r = lis[i].getBoundingClientRect();
        if (r.width > 100 && r.left <= centerX && r.right >= centerX) {
          console.log('[InstaSaver] Carousel index via li:', i);
          return i;
        }
      }
    }

    console.log('[InstaSaver] Carousel index: could not detect, defaulting to 0');
    return 0;
  }

  // Find the currently visible large image in the article (for carousels)
  function getVisibleImage(article) {
    const imgs = [...article.querySelectorAll('img')].filter(img => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      return w >= 200 && h >= 200;
    });
    if (imgs.length === 0) return null;
    if (imgs.length === 1) return imgs[0];

    // Carousel: pick image closest to article's horizontal center
    const ar = article.getBoundingClientRect();
    const centerX = ar.left + ar.width / 2;
    let best = null, bestDist = Infinity;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.width < 100) continue;
      const dist = Math.abs((r.left + r.width / 2) - centerX);
      if (dist < bestDist) { bestDist = dist; best = img; }
    }
    return best || imgs[0];
  }

  // Extract the highest-quality URL from an <img> element's srcset
  function extractBestUrl(img) {
    if (!img) return null;
    let best = null, bestW = 0;
    if (img.srcset) {
      for (const entry of img.srcset.split(',')) {
        const parts = entry.trim().split(/\s+/);
        const u = parts[0], n = parseInt(parts[1]) || 0;
        if (n > bestW && u && isValid(u)) { bestW = n; best = u; }
      }
    }
    if (!best && img.src && isValid(img.src)) best = img.src;
    return best;
  }

  // ── Get post image/video URL ───────────────────────────────────────────────
  async function getPostUrl(article) {
    toast('🔍 Finding media URL…', 10000);

    // Extract shortcode from article links (e.g. /p/ABC123/ or /reel/ABC123/)
    let shortcode = null;
    const postLink = article.querySelector('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
    if (postLink) {
      const parts = postLink.getAttribute('href').split('/').filter(Boolean);
      const idx = parts.findIndex(p => ['p', 'reel', 'tv'].includes(p));
      if (idx !== -1 && parts[idx + 1]) shortcode = parts[idx + 1];
    }

    // Detect carousel (has next/prev buttons or dots)
    const isCarousel = !!article.querySelector('[aria-label*="Next"], [aria-label*="Go to next"], [aria-label*="Go back"], [aria-label*="previous" i]')
                    || article.querySelectorAll('ul li').length > 1;
    const slideIdx = isCarousel ? getCarouselIndex(article) : undefined;
    console.log('[InstaSaver] Post:', shortcode, 'carousel:', isCarousel, 'slide:', slideIdx);

    // Check if the currently visible slide has a video
    const hasVideo = !!article.querySelector('video');

    if (hasVideo) {
      // Try API with carousel index — verify it returns a video URL
      if (shortcode) {
        const url = await fetchViaApi(shortcode, slideIdx);
        if (url && (url.includes('.mp4') || url.includes('video'))) {
          return { url, type: 'video' };
        }
      }
      // Injector fallback for video
      const url = await askInjectorForUrl();
      if (url) return { url, type: 'video' };
    }

    // For images — try API with carousel index
    if (shortcode) {
      const apiUrl = await fetchViaApi(shortcode, slideIdx);
      if (apiUrl) return { url: apiUrl, type: 'post' };
    }

    // Fallback: find the currently VISIBLE image in the article DOM
    const visibleImg = getVisibleImage(article);
    const imgUrl = extractBestUrl(visibleImg);
    if (imgUrl) return { url: imgUrl, type: 'post' };

    // Last resort: global injector
    const url = await askInjectorForImage();
    return { url, type: 'post' };
  }

  // ── Button factory ─────────────────────────────────────────────────────────
  function makeBtn(id, cssClass, label, cb, parent) {
    document.getElementById(id) && document.getElementById(id).remove();
    const btn = document.createElement('button');
    btn.id = id;
    btn.className = `is-btn ${cssClass}`;
    btn.innerHTML = `${ICON}<span>${label}</span>`;
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (btn.classList.contains('is-loading')) return;
      btn.classList.add('is-loading');
      Promise.resolve(cb()).finally(() => setTimeout(() => btn.classList.remove('is-loading'), 2000));
    });
    (parent || document.body).appendChild(btn);
    return btn;
  }

  // ── Post injection — button inside article, top-right ─────────────────────
  const done = new WeakSet();
  function processPost(article) {
    if (done.has(article)) return;
    if (!article.querySelector('video, img[srcset], img[src]')) return;
    done.add(article);

    const uid = '_isp_' + Math.random().toString(36).slice(2, 7);
    // Ensure article is a positioning context
    if (getComputedStyle(article).position === 'static') {
      article.style.position = 'relative';
    }
    makeBtn(uid, 'is-post', 'Save', async () => {
      const { url, type } = await getPostUrl(article);
      await blobDownload(url, makeFilename(type));
    }, article);
  }

  // ── Reel injection — fixed top-right, only on reel pages ──────────────────
  let lastReelHref = '';
  function processReel() {
    if (!location.pathname.includes('/reel')) return;
    if (location.href === lastReelHref) return;
    lastReelHref = location.href;
    setTimeout(() => {
      if (!document.querySelector('video')) return;
      makeBtn('_is_reel', 'is-reel', 'Save Reel', async () => {
        const url = await getReelUrl();
        await blobDownload(url, makeFilename('reel'));
      });
    }, 800);
  }

  // ── Story injection — fixed top-right, only on story pages ────────────────
  let lastStoryHref = '';
  function processStory() {
    if (!location.pathname.includes('/stories/')) return;
    if (location.href === lastStoryHref) return;
    lastStoryHref = location.href;
    setTimeout(async () => {
      const root = document.querySelector('section[role="dialog"],div[role="dialog"]') || document.body;
      if (!root.querySelector('video, img[srcset], img[src]')) return;
      makeBtn('_is_story', 'is-story', 'Save Story', async () => {
        toast('🔍 Finding story URL…', 10000);

        // Extract numeric story media ID from URL: /stories/username/MEDIA_ID/
        const parts = location.pathname.split('/').filter(Boolean);
        const storyIdx = parts.indexOf('stories');
        const storyMediaId = (storyIdx !== -1 && parts[storyIdx + 2]) ? parts[storyIdx + 2] : null;

        // Method 1: Instagram API with direct media ID (most reliable — returns real video, not audio)
        if (storyMediaId) {
          console.log('[InstaSaver] Fetching story via API, media ID:', storyMediaId);
          const apiUrl = await fetchMediaById(storyMediaId);
          if (apiUrl) {
            const isVideo = apiUrl.includes('.mp4') || !!root.querySelector('video');
            await blobDownload(apiUrl, makeFilename(isVideo ? 'story-video' : 'story-image'));
            return;
          }
        }

        // Method 2: Fallback — page HTML regex (filter audio URLs)
        const isVid = !!root.querySelector('video');
        if (isVid) {
          const url2 = await fetchPageVideoUrl(location.href);
          if (url2) {
            await blobDownload(url2, makeFilename('story-video'));
            return;
          }
          const url3 = await askInjectorForUrl();
          if (url3) {
            await blobDownload(url3, makeFilename('story-video'));
            return;
          }
        } else {
          const url = await askInjectorForImage();
          if (url) {
            await blobDownload(url, makeFilename('story-image'));
            return;
          }
        }

        toast('❌ Could not find story URL — try refreshing');
      });
    }, 800);
  }

  // ── Clean up buttons that shouldn't be visible on current page ─────────────
  function cleanupButtons() {
    if (!location.pathname.includes('/stories/')) {
      const el = document.getElementById('_is_story');
      if (el) { el.remove(); lastStoryHref = ''; }
    }
    if (!location.pathname.includes('/reel')) {
      const el = document.getElementById('_is_reel');
      if (el) { el.remove(); lastReelHref = ''; }
    }
  }

  // ── Main injector ──────────────────────────────────────────────────────────
  function inject() {
    cleanupButtons();
    document.querySelectorAll('article').forEach(processPost);
    if (location.pathname.includes('/reel')) processReel();
    if (location.pathname.includes('/stories/')) processStory();
  }

  let timer;
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(inject, 400); })
    .observe(document.body, { childList: true, subtree: true });

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      cleanupButtons();
      setTimeout(inject, 900);
    }
  }, 400);

  setTimeout(inject, 1500);
  console.log('[InstaSaver] Content script ✓');
})();
