/**
 * Wallpaper Engine Background — client half.
 *
 * Everything lives inside the factory. DSH re-executes a bundle whenever the
 * module system materializes it again (HMR, a fresh request); a top-level
 * `const` would then collide with the previous execution's binding and throw
 * `SyntaxError: Identifier ... has already been declared`, which kills the
 * script before `__ModuleLoader__.load()` runs, so the new code silently never
 * registers. Keep the module scope empty.
 *
 * The user grants access to their Wallpaper Engine workshop folder through the
 * browser's directory picker; titles come from each project.json, thumbnails
 * from each preview image, and full-resolution artwork is carved out of
 * scene.pkg by scanning for embedded JPEG/PNG streams.
 */

window.__ModuleLoader__.load({
  id: 'dsh-wallpaper-engine',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef, useSyncExternalStore } = React;

    const PREFS_KEY = 'dsh-wallpaper-engine:prefs:v1';
    const DB_NAME = 'dsh-wallpaper-engine';
    const DB_STORE = 'handles';
    const DB_KEY = 'library-dir';

    const DEFAULTS = {
      wallpaper: null,
      enabled: true,
      panelAlpha: 0.55,
      blur: 0,
      dim: 0.25,
      imageOpacity: 1,
      // Off by default: the carved scene.pkg artwork is far sharper than the
      // animated GIF preview. Turn it on to trade sharpness for motion.
      preferAnimated: false,
    };

    const PREVIEW_NAMES = ['preview.jpg', 'preview.jpeg', 'preview.png', 'preview.gif', 'preview.webp'];

    const JPEG_SOI = [0xff, 0xd8, 0xff];
    const JPEG_EOI = [0xff, 0xd9];
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const PNG_END = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
    // Below this width an embedded image is a sprite or mask, not the artwork.
    // Deliberately low: a 700 px texture still beats a 300 px preview, and the
    // old 1280 floor threw such textures away in favour of the preview.
    const MIN_USABLE_WIDTH = 480;
    // At or above this, an embedded scene.pkg texture is clearly the better
    // source — sharp enough to be worth giving up an animation for.
    const HIGH_RES_WIDTH = 1280;

    /* ── small utilities ────────────────────────────────────────────── */

    function clamp(v, lo, hi, fallback) {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(hi, Math.max(lo, n));
    }

    function readPrefs() {
      let stored = {};
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (raw) stored = JSON.parse(raw) || {};
      } catch (e) {
        stored = {};
      }
      return { ...DEFAULTS, ...stored };
    }

    function writePrefs(prefs) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch (e) { /* storage unavailable: session-only is fine */ }
    }

    /** Repair workshop titles that arrive as GBK/UTF-8 mojibake. */
    function fixTitle(s) {
      if (!s || s.indexOf('\ufffd') < 0) return s || '';
      return s;
    }

    /* ── IndexedDB: remember the folder handle across reloads ───────── */

    function openDb() {
      return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async function saveHandle(handle) {
      try {
        const db = await openDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).put(handle, DB_KEY);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) { /* persistence is a nicety, not a requirement */ }
    }

    async function loadHandle() {
      try {
        const db = await openDb();
        return await new Promise((resolve) => {
          const tx = db.transaction(DB_STORE, 'readonly');
          const req = tx.objectStore(DB_STORE).get(DB_KEY);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
      } catch (e) {
        return null;
      }
    }

    /* ── scene.pkg: recover the embedded artwork ────────────────────── */

    /** Byte offsets of every `sig … endSig` span in `bytes`. */
    function findSpans(bytes, sig, endSig) {
      const spans = [];
      const n = bytes.length;
      const sn = sig.length;
      const en = endSig.length;
      let i = 0;
      while (i < n) {
        let start = -1;
        for (let j = i; j <= n - sn; j += 1) {
          let ok = true;
          for (let k = 0; k < sn; k += 1) {
            if (bytes[j + k] !== sig[k]) { ok = false; break; }
          }
          if (ok) { start = j; break; }
        }
        if (start < 0) break;
        let end = -1;
        for (let j = start + sn; j <= n - en; j += 1) {
          let ok = true;
          for (let k = 0; k < en; k += 1) {
            if (bytes[j + k] !== endSig[k]) { ok = false; break; }
          }
          if (ok) { end = j; break; }
        }
        if (end < 0) break;
        spans.push([start, end + en]);
        i = end + en;
      }
      return spans;
    }

    function measure(blob) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight, url });
        im.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        im.src = url;
      });
    }

    /**
     * Every decodable image embedded in a scene.pkg, largest first.
     * scene.pkg stores its textures as plain JPEG/PNG streams, so a magic-byte
     * scan recovers them.
     */
    async function extractTextures(pkgFile) {
      let bytes;
      try {
        bytes = new Uint8Array(await pkgFile.arrayBuffer());
      } catch (e) {
        return [];
      }

      const spans = []
        .concat(findSpans(bytes, JPEG_SOI, JPEG_EOI))
        .concat(findSpans(bytes, PNG_SIG, PNG_END));

      const out = [];
      for (let i = 0; i < spans.length; i += 1) {
        const span = spans[i];
        const info = await measure(new Blob([bytes.subarray(span[0], span[1])]));
        if (info) out.push(info);
      }
      out.sort((a, b) => b.w * b.h - a.w * a.h);
      return out;
    }

    /** Size of an image URL that already exists (a preview Blob URL, say). */
    function measureUrl(url) {
      return new Promise((resolve) => {
        const im = new Image();
        im.onload = () => resolve({ url, w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => resolve(null);
        im.src = url;
      });
    }

    /**
     * First frame of an animated image, as a static JPEG blob URL.
     * A picker holding dozens of simultaneously animating GIFs keeps the
     * decoder busy and makes the one wallpaper on the background layer stutter,
     * so the grid shows a still and only the wallpaper animates.
     */
    async function stillFromImage(blob) {
      try {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        if (bitmap.close) bitmap.close();
        return await new Promise((resolve) => {
          canvas.toBlob((out) => {
            resolve(out ? URL.createObjectURL(out) : null);
          }, 'image/jpeg', 0.82);
        });
      } catch (e) {
        // No createImageBitmap / toBlob: fall back to the animated URL.
        return null;
      }
    }

    /* ── library sources ────────────────────────────────────────────── */

    /**
     * A source exposes the chosen folder uniformly whether it came from
     * showDirectoryPicker (a FileSystemDirectoryHandle, persistable) or from
     * an <input webkitdirectory> FileList.
     */
    function sourceFromHandle(handle) {
      return {
        kind: 'handle',
        name: handle.name,
        async dirs() {
          const out = [];
          for await (const [name, child] of handle.entries()) {
            if (child.kind === 'directory') out.push(name);
          }
          return out;
        },
        async file(dir, name) {
          try {
            const d = await handle.getDirectoryHandle(dir);
            const fh = await d.getFileHandle(name);
            return await fh.getFile();
          } catch (e) {
            return null;
          }
        },
      };
    }

    function sourceFromFiles(fileList) {
      const map = new Map();
      const dirs = new Set();
      for (let i = 0; i < fileList.length; i += 1) {
        const f = fileList[i];
        const rel = f.webkitRelativePath || f.name;
        const parts = rel.split('/');
        if (parts.length !== 3) continue;   // <root>/<workshopId>/<file>
        const dir = parts[1];
        const name = parts[2];
        dirs.add(dir);
        map.set(dir + '/' + name, f);
      }
      const root = fileList.length > 0
        ? ((fileList[0].webkitRelativePath || '').split('/')[0] || 'workshop')
        : 'workshop';
      return {
        kind: 'files',
        name: root,
        async dirs() { return Array.from(dirs); },
        async file(dir, name) { return map.get(dir + '/' + name) || null; },
      };
    }

    /** Read titles and thumbnails — only the small files are touched. */
    async function scanLibrary(source, onProgress) {
      const dirs = await source.dirs();
      const out = [];
      for (let i = 0; i < dirs.length; i += 1) {
        const id = dirs[i];
        const pj = await source.file(id, 'project.json');
        if (!pj) continue;

        let title = id;
        let type = '';
        try {
          const parsed = JSON.parse(await pj.text());
          title = fixTitle(parsed.title) || id;
          type = String(parsed.type || '').toLowerCase();
        } catch (e) { /* keep the id as the title */ }

        let previewName = null;
        for (let k = 0; k < PREVIEW_NAMES.length; k += 1) {
          const f = await source.file(id, PREVIEW_NAMES[k]);
          if (f) { previewName = PREVIEW_NAMES[k]; break; }
        }

        let thumb = null;
        let anim = null;
        let animated = false;
        if (previewName) {
          const pf = await source.file(id, previewName);
          if (pf) {
            anim = URL.createObjectURL(pf);
            if (previewName === 'preview.gif') {
              animated = true;
              // Grid shows a still; only the background layer animates.
              thumb = (await stillFromImage(pf)) || anim;
            } else {
              thumb = anim;
            }
          }
        }

        out.push({ id, title, type, thumb, anim, animated });
        if (onProgress && i % 8 === 0) onProgress(i + 1, dirs.length);
      }
      out.sort((a, b) => a.title.localeCompare(b.title));
      return out;
    }

    /* ── token overrides ────────────────────────────────────────────── */

    /**
     * The theme presenter writes token values as inline styles on <body>, so
     * no CSS rule — not even one with `!important` — can override them. The
     * values themselves have to change.
     */
    function buildTokens(prefs) {
      const a = clamp(prefs.panelAlpha, 0.2, 1, DEFAULTS.panelAlpha);
      const light = 'rgba(255,255,255,' + a + ')';
      const dark = 'rgba(18,20,26,' + a + ')';
      const lightSoft = 'rgba(255,255,255,' + Math.min(1, a + 0.12) + ')';
      const darkSoft = 'rgba(24,26,33,' + Math.min(1, a + 0.12) + ')';

      const tokens = {};
      const set = (key, l, d) => { tokens[key] = { light: l, dark: d }; };
      set('--dsw-alias-bg-base', light, dark);
      set('--dsw-alias-bg-layer-1', lightSoft, darkSoft);
      set('--dsw-alias-bg-layer-2', lightSoft, darkSoft);
      set('--dsw-alias-bg-layer-3', lightSoft, darkSoft);
      set('--dsw-alias-bg-overlay', lightSoft, darkSoft);
      set('--dsw-specific-sidebar-fill', light, dark);
      return tokens;
    }

    /* ── root transparency ──────────────────────────────────────────── */

    const STYLE_ID = 'dsh-wallpaper-engine/root.css';

    /**
     * In the CSS paint order every in-flow block (html, body, #root, the app
     * frame) draws ABOVE a negative-z-index layer, so each one has to be
     * cleared or the wallpaper stays hidden no matter what the layer does.
     */
    const ROOT_CSS = `
html, body, #root {
  background: transparent !important;
}
[class*="_frame"],
#root > div:first-child {
  background: transparent !important;
}
[class*="_frame"]::before {
  background: transparent !important;
}
`;

    function insertStyle(css, id) {
      if (typeof document === 'undefined') return function () {};
      const existing = document.querySelector('style[data-wpe-css=' + JSON.stringify(id) + ']');
      if (existing) return function () {};
      const tag = document.createElement('style');
      tag.setAttribute('data-wpe-css', id);
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
    }

    /* ── background layer ───────────────────────────────────────────── */

    function createLayer() {
      const root = document.createElement('div');
      root.setAttribute('data-wpe', 'root');
      root.style.cssText =
        'position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden';

      const img = document.createElement('div');
      img.setAttribute('data-wpe', 'image');
      img.style.cssText =
        'position:absolute;inset:0;background-size:cover;background-position:center';

      const dim = document.createElement('div');
      dim.setAttribute('data-wpe', 'dim');
      dim.style.cssText = 'position:absolute;inset:0';

      root.appendChild(img);
      root.appendChild(dim);
      document.body.appendChild(root);
      return { root, img, dim, urls: [] };
    }

    /**
     * Paint the layer. `layer.urls` is ordered front-to-back: an animated GIF
     * that drops a frame for a moment would otherwise reveal the dark canvas
     * behind the layer as a black flash, so the still first frame is stacked
     * underneath it to absorb that.
     */
    function paintLayer(layer, prefs) {
      const blur = clamp(prefs.blur, 0, 60, DEFAULTS.blur);
      const dim = clamp(prefs.dim, 0, 0.85, DEFAULTS.dim);
      const opacity = clamp(prefs.imageOpacity, 0, 1, 1);
      const urls = layer.urls || [];

      if (urls.length > 0) {
        layer.img.style.backgroundImage = urls
          .map((u) => 'url("' + u + '")')
          .join(', ');
        layer.img.style.backgroundSize = urls.map(() => 'cover').join(', ');
        layer.img.style.backgroundPosition = urls.map(() => 'center').join(', ');
        layer.img.style.opacity = String(opacity);
        // Blur the wallpaper itself; backdrop-filter would create a containing
        // block and break every position:fixed control inside the frame.
        layer.img.style.filter = blur > 0 ? 'blur(' + blur + 'px)' : 'none';
        layer.img.style.inset = blur > 0 ? '-' + (blur * 2) + 'px' : '0';
        layer.dim.style.background = 'rgba(0,0,0,' + dim + ')';
      } else {
        layer.img.style.backgroundImage = 'none';
        layer.dim.style.background = 'none';
      }
    }

    /* ── shared state ───────────────────────────────────────────────── */

    let prefs = readPrefs();
    let library = [];
    let status = { scanning: false, done: 0, total: 0, message: '', source: null };
    let layer = null;
    let disposeTokens = null;
    let themeSvc = null;
    let ctxRef = null;
    /** Handle remembered in IndexedDB whose read access lapsed to "prompt". */
    let remembered = null;
    /** Cache of extracted artwork URLs, keyed by workshop id. */
    const artworkCache = new Map();
    /** Resolved source resolution per wallpaper id, for honest UI feedback. */
    const artworkRes = new Map();

    const listeners = new Set();
    function emit() {
      listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    }
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    function getSnapshot() { return prefs; }
    function usePrefs() { return useSyncExternalStore(subscribe, getSnapshot); }

    /** Look the theme service up lazily — it may activate after this plugin. */
    function theme() {
      if (themeSvc) return themeSvc;
      if (ctxRef) themeSvc = ctxRef.get('theme');
      return themeSvc;
    }

    function sync() {
      if (!layer) return;
      // With no wallpaper resolved there is nothing to show, so leave the app
      // completely untouched rather than tinting panels over a blank layer.
      if (!prefs.enabled || !layer.urls || layer.urls.length === 0) {
        layer.root.style.display = 'none';
        if (disposeTokens) { disposeTokens(); disposeTokens = null; }
        return;
      }
      layer.root.style.display = '';
      paintLayer(layer, prefs);

      const svc = theme();
      if (svc && typeof svc.overrideTokens === 'function') {
        if (disposeTokens) { disposeTokens(); disposeTokens = null; }
        disposeTokens = svc.overrideTokens('dsh-wallpaper-engine', buildTokens(prefs));
      }
    }

    function update(patch) {
      prefs = { ...prefs, ...patch };
      writePrefs(prefs);
      sync();
      emit();
    }

    /** Resolve the chosen wallpaper to a URL and put it on the layer. */
    async function applyWallpaper(id) {
      if (!id) {
        if (layer) { layer.urls = []; sync(); }
        return;
      }

      const entry = library.find((w) => w.id === id);
      const source = status.source;
      if (!source) return;

      // A preview GIF animates; a carved scene.pkg is static but far sharper.
      // The preference only bites where an animated preview actually exists.
      const useAnimated = !!(prefs.preferAnimated && entry && entry.animated);
      const cacheKey = id + (useAnimated ? '#anim' : '#still');

      if (artworkCache.has(cacheKey)) {
        if (layer) { layer.urls = artworkCache.get(cacheKey); sync(); }
        return;
      }

      // The animated URL is the moving one; the still is its first frame, used
      // by the picker and as the layer's backstop. A wallpaper whose only
      // artwork *is* an animated preview has to keep using that preview —
      // falling back to the baked still would silently make it a static image.
      const animUrl = entry ? (entry.anim || null) : null;
      const stillUrl = entry ? (entry.thumb || null) : null;
      const previewUrl = animUrl || stillUrl;

      const candidates = [];
      if (!useAnimated) {
        const pkg = await source.file(id, 'scene.pkg');
        if (pkg) candidates.push.apply(candidates, await extractTextures(pkg));
      }
      if (previewUrl) {
        const m = await measureUrl(previewUrl);
        if (m) candidates.push(m);
      }

      let pick = null;
      if (useAnimated && previewUrl) {
        // Animation was asked for outright.
        pick = candidates.find((c) => c.url === previewUrl) || candidates[0] || null;
      }
      if (!pick) {
        const ranked = candidates.slice().sort((a, b) => b.w * b.h - a.w * a.h);
        // A high-resolution texture is worth losing the animation for; a small
        // one is not, so the moving preview wins there.
        const sharp = ranked.find((c) => c.url !== previewUrl && c.w >= HIGH_RES_WIDTH);
        pick = sharp
          || ranked.find((c) => c.url === previewUrl)
          || ranked.find((c) => c.w >= MIN_USABLE_WIDTH)
          || ranked[0]
          || null;
      }
      if (!pick) return;

      // Never revoke a URL the picker is still displaying.
      const keep = new Set();
      if (animUrl) keep.add(animUrl);
      if (stillUrl) keep.add(stillUrl);
      keep.add(pick.url);
      for (let i = 0; i < candidates.length; i += 1) {
        if (!keep.has(candidates[i].url)) URL.revokeObjectURL(candidates[i].url);
      }

      // A GIF can momentarily lose its frame; stack its still first frame
      // underneath so the gap shows artwork instead of the dark canvas.
      const urls = [pick.url];
      if (useAnimated && stillUrl && stillUrl !== pick.url) urls.push(stillUrl);

      artworkCache.set(cacheKey, urls);
      artworkRes.set(id, pick.w + '×' + pick.h);
      if (layer) { layer.urls = urls; sync(); }
      emit();
    }

    function message(text) {
      status = { ...status, message: text, scanning: false };
      emit();
    }

    async function adoptSource(source) {
      // Drop the previous library's object URLs before replacing it, or a
      // rescan leaks one blob per wallpaper.
      library.forEach((w) => {
        if (w.thumb) URL.revokeObjectURL(w.thumb);
        if (w.anim && w.anim !== w.thumb) URL.revokeObjectURL(w.anim);
      });
      library = [];

      status = { ...status, scanning: true, source, message: '', done: 0, total: 0 };
      emit();
      try {
        library = await scanLibrary(source, (done, total) => {
          status = { ...status, done, total };
          emit();
        });
      } catch (e) {
        message('读取失败：' + (e && e.message ? e.message : String(e)));
        return;
      }
      status = {
        ...status,
        scanning: false,
        message: '已找到 ' + library.length + ' 张壁纸',
        done: 0,
        total: 0,
      };
      emit();

      // Re-apply on reload: the wallpaper id persisted, the URL did not.
      if (prefs.wallpaper) {
        const still = library.some((w) => w.id === prefs.wallpaper);
        if (still) await applyWallpaper(prefs.wallpaper);
        else update({ wallpaper: null });
      }
    }

    /* ── controls ───────────────────────────────────────────────────── */

    function Row(props) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '10px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
        },
      }, props.children);
    }

    function Label(props) {
      return h('div', {
        style: {
          flex: 'none', width: '132px', fontSize: '13px',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }, props.children);
    }

    function Slider(props) {
      return h('div', { style: { flex: 'auto', display: 'flex', alignItems: 'center', gap: '10px' } },
        h('input', {
          type: 'range', min: props.min, max: props.max, step: props.step || 1,
          value: props.value,
          onChange: (e) => props.onChange(Number(e.target.value)),
          style: { flex: 'auto', minWidth: 0, accentColor: 'var(--dsw-alias-brand-primary)' },
          'aria-label': props.label,
        }),
        h('span', {
          style: {
            flex: 'none', width: '52px', textAlign: 'right', fontSize: '12px',
            color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums',
          },
        }, props.display));
    }

    function Button(props) {
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        disabled: props.disabled,
        style: {
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: 'var(--dsw-radius-sm, 8px)',
          background: props.primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
          color: props.primary ? '#fff' : 'var(--dsw-alias-label-secondary)',
          fontSize: '13px', cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.55 : 1,
          padding: '6px 14px',
        },
      }, props.children);
    }

    /* ── settings page ──────────────────────────────────────────────── */

    function WallpaperSettings() {
      const cur = usePrefs();
      const [, bump] = useState(0);
      const fileInput = useRef(null);

      useEffect(() => subscribe(() => bump((n) => n + 1)), []);

      const pickFolder = useCallback(async () => {
        // Preferred: a persistable directory handle, so the library comes back
        // by itself on the next reload.
        if (typeof window.showDirectoryPicker === 'function') {
          try {
            const handle = await window.showDirectoryPicker({ id: 'wpe-library', mode: 'read' });
            await saveHandle(handle);
            await adoptSource(sourceFromHandle(handle));
            return;
          } catch (e) {
            if (e && e.name === 'AbortError') return;
            // fall through to the plain input
          }
        }
        if (fileInput.current) fileInput.current.click();
      }, []);

      const onFiles = useCallback((e) => {
        const files = e.target.files;
        if (files && files.length > 0) adoptSource(sourceFromFiles(files));
        e.target.value = '';
      }, []);

      const current = library.find((w) => w.id === cur.wallpaper) || null;
      const shown = library.filter((w) => {
        const q = status.filter ? status.filter.toLowerCase() : '';
        if (!q) return true;
        return w.title.toLowerCase().includes(q) || w.id.includes(q);
      });

      return h('div', {
        style: { padding: '4px 0 32px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      },
        h('input', {
          ref: fileInput,
          type: 'file',
          webkitdirectory: '',
          directory: '',
          multiple: true,
          onChange: onFiles,
          style: { display: 'none' },
        }),

        /* current wallpaper */
        h('div', {
          style: {
            display: 'flex', gap: '14px', alignItems: 'center',
            padding: '12px', marginBottom: '14px',
            border: '0.5px solid var(--dsw-alias-border-l1)',
            borderRadius: 'var(--dsw-radius-md, 10px)',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        },
          h('div', {
            style: {
              flex: 'none', width: '96px', height: '54px', borderRadius: '8px',
              background: current && current.thumb
                ? 'url("' + current.thumb + '") center / cover no-repeat'
                : 'var(--dsw-alias-bg-layer-2)',
              border: '0.5px solid var(--dsw-alias-border-l1)',
            },
          }),
          h('div', { style: { minWidth: 0, flex: 'auto' } },
            h('div', { style: { fontSize: '13px', fontWeight: 500 } },
              current ? current.title : '未选择壁纸'),
            h('div', {
              style: { fontSize: '12px', marginTop: '4px', color: 'var(--dsw-alias-label-tertiary)' },
            }, current ? ('ID ' + current.id) : '先选择你的 Wallpaper Engine 文件夹'),
            current ? h('div', {
              style: {
                fontSize: '12px', marginTop: '2px',
                color: (function () {
                  const r = artworkRes.get(cur.wallpaper);
                  return r && parseInt(r, 10) < 1280
                    ? 'var(--dsw-alias-state-warn-primary)'
                    : 'var(--dsw-alias-label-tertiary)';
                })(),
              },
            }, (function () {
              const r = artworkRes.get(cur.wallpaper);
              if (!r) return '正在解析源图…';
              const w = parseInt(r, 10);
              if (w >= 1920) return '源图 ' + r + ' · 清晰';
              if (w >= 1280) return '源图 ' + r + ' · 尚可';
              return '源图仅 ' + r + ' · 放大会糊，可调高「壁纸模糊」掩盖';
            })()) : null,
            h('div', {
              style: {
                fontSize: '12px', marginTop: '2px',
                color: status.message && status.message.indexOf('失败') >= 0
                  ? 'var(--dsw-alias-state-error-primary)'
                  : 'var(--dsw-alias-label-tertiary)',
              },
            }, status.scanning
              ? ('扫描中… ' + status.done + '/' + status.total)
              : (status.message || (status.source ? '' : '尚未选择文件夹'))))),

        /* folder picker */
        h(Row, null,
          h(Label, null, '壁纸库文件夹'),
          h(Button, {
            onClick: pickFolder,
            primary: !status.source && !status.needsPermission,
          }, '选择文件夹…'),
          status.source && status.source.kind === 'handle' ? h(Button, {
            onClick: () => adoptSource(status.source),
            disabled: status.scanning,
          }, '重新扫描') : null,
          h('span', {
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', minWidth: 0 },
          }, status.source
            ? status.source.name + '　（新下载的壁纸点「重新扫描」）'
            : '例如 …\\workshop\\content\\431960')),

        /* access lapsed across a restart: one click re-grants it */
        status.needsPermission ? h(Row, null,
          h(Label, null, '上次的壁纸库'),
          h(Button, {
            primary: true,
            onClick: async () => {
              try {
                const perm = await remembered.requestPermission({ mode: 'read' });
                if (perm !== 'granted') return;
                const handle = remembered;
                remembered = null;
                status = { ...status, needsPermission: false };
                await adoptSource(sourceFromHandle(handle));
              } catch (e) { /* stay on the button */ }
            },
          }, '恢复授权并扫描'),
          h('span', {
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
          }, '重启后浏览器需要你再授权一次')) : null,

        /* animated previews: sharper still vs moving GIF */
        h(Row, null,
          h(Label, null, '动态壁纸'),
          h(Button, {
            onClick: () => {
              const next = !cur.preferAnimated;
              update({ preferAnimated: next });
              if (cur.wallpaper) applyWallpaper(cur.wallpaper);
            },
          }, cur.preferAnimated ? '优先动图' : '优先高清'),
          h('span', {
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', minWidth: 0 },
          }, (function () {
            const n = library.filter((w) => w.animated).length;
            if (library.length === 0) return '选择文件夹后可用';
            return n + ' 张有动图预览' + (cur.preferAnimated ? '' : '，其余取 scene.pkg 高清原图');
          })())),

        /* sliders */
        h(Row, null, h(Label, null, '面板透明度'),
          h(Slider, {
            label: '面板透明度', min: 20, max: 100, value: Math.round(cur.panelAlpha * 100),
            display: Math.round(cur.panelAlpha * 100) + '%',
            onChange: (v) => update({ panelAlpha: v / 100 }),
          })),
        h(Row, null, h(Label, null, '壁纸模糊'),
          h(Slider, {
            label: '壁纸模糊', min: 0, max: 60, value: cur.blur,
            display: cur.blur + 'px',
            onChange: (v) => update({ blur: v }),
          })),
        h(Row, null, h(Label, null, '背景压暗'),
          h(Slider, {
            label: '背景压暗', min: 0, max: 85, value: Math.round(cur.dim * 100),
            display: Math.round(cur.dim * 100) + '%',
            onChange: (v) => update({ dim: v / 100 }),
          })),
        h(Row, null, h(Label, null, '壁纸亮度'),
          h(Slider, {
            label: '壁纸亮度', min: 10, max: 100, value: Math.round(cur.imageOpacity * 100),
            display: Math.round(cur.imageOpacity * 100) + '%',
            onChange: (v) => update({ imageOpacity: v / 100 }),
          })),

        /* picker */
        library.length > 0 ? h('div', null,
          h('div', {
            style: { marginTop: '20px', fontSize: '14px', fontWeight: 500 },
          }, '选择壁纸  ·  共 ' + library.length + ' 张'),
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '10px 0 14px' },
          },
            h('input', {
              type: 'search',
              placeholder: '搜索名称或 ID…',
              onChange: (e) => { status = { ...status, filter: e.target.value }; emit(); },
              style: {
                boxSizing: 'border-box', flex: 'auto', height: '32px', padding: '0 10px',
                fontSize: '13px', color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-bg-layer-1)',
                border: '0.5px solid var(--dsw-alias-border-l2)',
                borderRadius: 'var(--dsw-radius-sm, 8px)', outline: 'none',
              },
            })),
          h('div', {
            style: {
              display: 'grid', gap: '10px',
              gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
            },
          }, shown.map((w) => {
            const active = w.id === cur.wallpaper;
            return h('button', {
              key: w.id, type: 'button', title: w.title + '  (' + w.id + ')',
              'aria-pressed': active ? 'true' : 'false',
              onClick: () => { update({ wallpaper: w.id, enabled: true }); applyWallpaper(w.id); },
              style: {
                border: active
                  ? '2px solid var(--dsw-alias-brand-primary, #2563eb)'
                  : '0.5px solid var(--dsw-alias-border-l1)',
                borderRadius: 'var(--dsw-radius-md, 10px)',
                background: 'transparent', padding: '4px', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'center',
                position: 'relative',
              },
            },
              w.thumb ? h('img', {
                src: w.thumb, alt: w.title,
                style: {
                  width: '100%', aspectRatio: '1 / 1', objectFit: 'cover',
                  borderRadius: '6px', display: 'block',
                },
              }) : h('div', {
                style: {
                  width: '100%', aspectRatio: '1 / 1', borderRadius: '6px',
                  background: 'var(--dsw-alias-bg-layer-2)',
                },
              }),
              w.animated ? h('span', {
                style: {
                  position: 'absolute', top: '8px', right: '8px',
                  fontSize: '10px', lineHeight: '14px', padding: '0 5px',
                  borderRadius: '5px', background: 'rgba(0,0,0,0.6)', color: '#fff',
                },
              }, '动') : null,
              h('span', {
                style: {
                  fontSize: '11px', lineHeight: '14px', maxWidth: '100%',
                  color: active
                    ? 'var(--dsw-alias-brand-primary, #2563eb)'
                    : 'var(--dsw-alias-label-tertiary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                },
              }, w.title));
          })),
        ) : null,
      );
    }

    /* ── plugin ─────────────────────────────────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctxRef = ctx;

        ctx.effect(() => {
          const disposeCss = insertStyle(ROOT_CSS, STYLE_ID);
          layer = createLayer();
          sync();

          // The theme service usually activates alongside this plugin; if it
          // is not up yet, retry briefly so the token override still lands.
          let tries = 0;
          const timer = setInterval(() => {
            tries += 1;
            if (theme() || tries > 20) {
              clearInterval(timer);
              sync();
            }
          }, 250);

          // Restore the remembered folder. Its read access can lapse back to
          // "prompt" across a restart, and re-granting needs a user gesture, so
          // keep the handle and surface a button instead of silently doing
          // nothing. A rescan also picks up wallpapers downloaded since last
          // time — there is no filesystem watcher, so this is how new ones
          // appear.
          let cancelled = false;
          loadHandle().then(async (handle) => {
            if (cancelled || !handle || !handle.queryPermission) return;
            try {
              const perm = await handle.queryPermission({ mode: 'read' });
              if (perm === 'granted') {
                await adoptSource(sourceFromHandle(handle));
                return;
              }
            } catch (e) { /* fall through to the manual grant */ }
            remembered = handle;
            status = { ...status, needsPermission: true };
            emit();
          });

          return () => {
            cancelled = true;
            clearInterval(timer);
            disposeCss();
            if (disposeTokens) { disposeTokens(); disposeTokens = null; }
            library.forEach((w) => {
              if (w.thumb) URL.revokeObjectURL(w.thumb);
              if (w.anim && w.anim !== w.thumb) URL.revokeObjectURL(w.anim);
            });
            artworkCache.forEach((urls) => {
              urls.forEach((u) => URL.revokeObjectURL(u));
            });
            artworkCache.clear();
            if (layer && layer.root.parentNode) layer.root.parentNode.removeChild(layer.root);
            layer = null;
          };
        }, 'dsh-wallpaper-engine: layer + tokens');

        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'wallpaper-engine', order: 500, label: 'Wallpaper Engine 壁纸' },
          WallpaperSettings,
        ));
      },
    };
  },
});
