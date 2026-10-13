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
 * from each preview image, and the artwork is *composited* out of scene.pkg:
 * a scene is a stack of texture layers that Wallpaper Engine blends at runtime,
 * so the picture only exists once the stack is rendered (see the scene renderer
 * below). Wallpapers without a scene.pkg — video and web ones — use their
 * preview image, which is all they ship.
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
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

    /* ── scene.pkg: composite the scene ─────────────────────────────── */

    /* #region scene-renderer */

    /**
     * A scene.pkg is a PKGV container:
     *
     *   "PKGV0011" [int32 file count]
     *   per file: [int32 name length][name utf8][int32 offset][int32 size]
     *   <data section>      every offset is relative to its start
     *
     * scene.json lists the objects in draw order, and every image object points
     * at models/<x>.json → materials/<x>.json → materials/<x>.tex. The order
     * matters: a scene is a *stack of layers* that Wallpaper Engine composites
     * at runtime, so lifting one texture out of the package hands back a single
     * layer of the picture. For 2372608028 that layer was a nearly empty atlas,
     * which is why the background did not look like the original artwork. The
     * code below renders the stack instead.
     *
     * A .tex is a TEXV0005 container holding a TEXB blob:
     *
     *   "TEXB00NN" + NN header ints (the last one is the mip count)
     *   per mip: [w][h][lz4?][raw size][stored size][data]
     *
     * Each mip is either a stored PNG/JPEG stream or raw pixels — RGBA8888,
     * DXT5, DXT1 or a single channel mask — LZ4-compressed when its flag says
     * so. Roughly half of this library's artwork is in the raw flavours, where
     * a magic-byte scan finds nothing at all.
     */

    // Composited at this width; a 4K scene is not worth decoding twice over.
    const SCENE_WIDTH = 1920;
    // Luminance standard deviation below which a composite is an empty frame
    // rather than a picture (a scene whose only content is a mesh or a
    // script-driven layer renders to a flat colour).
    const FLAT_STD = 4;

    function utf8(bytes, start, len) {
      return new TextDecoder('utf-8').decode(bytes.subarray(start, start + len));
    }

    function indexOfBytes(hay, needle, from) {
      const n = hay.length;
      const m = needle.length;
      for (let i = from || 0; i + m <= n; i += 1) {
        let ok = true;
        for (let k = 0; k < m; k += 1) {
          if (hay[i + k] !== needle.charCodeAt(k)) { ok = false; break; }
        }
        if (ok) return i;
      }
      return -1;
    }

    function startsWithBytes(bytes, sig, at) {
      for (let k = 0; k < sig.length; k += 1) {
        if (bytes[(at || 0) + k] !== sig[k]) return false;
      }
      return true;
    }

    function viewOf(bytes) {
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    /** Parse the PKGV file table of a scene.pkg. */
    function readPkg(bytes) {
      const dv = viewOf(bytes);
      const count = dv.getInt32(12, true);
      let pos = 16;
      const entries = new Map();
      for (let i = 0; i < count && pos + 12 <= bytes.length; i += 1) {
        const nameLen = dv.getInt32(pos, true);
        pos += 4;
        if (nameLen < 0 || pos + nameLen + 8 > bytes.length) break;
        const name = utf8(bytes, pos, nameLen);
        pos += nameLen;
        const off = dv.getInt32(pos, true);
        const size = dv.getInt32(pos + 4, true);
        pos += 8;
        if (off < 0 || size < 0) break;
        entries.set(name, [off, size]);
      }
      return { bytes, entries, dataStart: pos };
    }

    function pkgMember(pkg, name) {
      const e = pkg.entries.get(name);
      if (!e) return null;
      const start = pkg.dataStart + e[0];
      if (start + e[1] > pkg.bytes.length) return null;
      return pkg.bytes.subarray(start, start + e[1]);
    }

    function pkgJson(pkg, name) {
      const m = pkgMember(pkg, name);
      if (!m) return null;
      try {
        return JSON.parse(utf8(m, 0, m.length));
      } catch (e) {
        return null;
      }
    }

    /** scene.json names lack the folder and extension ("dsds" → "materials/dsds.tex"). */
    function resolveEntry(pkg, name) {
      if (!name) return null;
      if (pkg.entries.has(name)) return name;
      const tries = [
        name + '.tex',
        'materials/' + name + '.tex',
        'materials/' + name,
        name + '.json',
        'models/' + name + '.json',
      ];
      for (let i = 0; i < tries.length; i += 1) {
        if (pkg.entries.has(tries[i])) return tries[i];
      }
      const base = String(name).split('/').pop() + '.tex';
      const keys = pkg.entries.keys();
      for (let k = keys.next(); !k.done; k = keys.next()) {
        if (k.value.split('/').pop() === base) return k.value;
      }
      return null;
    }

    /** "x y z" → [x, y, z]; script/animation values are objects and give null. */
    function vecValue(v, n) {
      if (typeof v !== 'string') return null;
      const parts = v.trim().split(/\s+/);
      if (parts.length < n) return null;
      const out = [];
      for (let i = 0; i < n; i += 1) {
        const f = parseFloat(parts[i]);
        if (!Number.isFinite(f)) return null;
        out.push(f);
      }
      return out;
    }

    function colorValue(v, fallback) {
      const parts = typeof v === 'string' ? v.trim().split(/\s+/) : null;
      if (!parts || parts.length < 3) return fallback;
      const out = [];
      for (let i = 0; i < 3; i += 1) {
        const f = parseFloat(parts[i]);
        out.push(Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : fallback[i]);
      }
      return out;
    }

    /** Decode an LZ4 raw block (no frame header) into `expected` bytes. */
    function lz4Block(src, expected) {
      const cap = expected > 0 ? expected : Math.max(64, src.length * 4);
      const out = new Uint8Array(cap);
      let o = 0;
      let i = 0;
      const n = src.length;
      while (i < n && o < cap) {
        const token = src[i];
        i += 1;
        let literals = token >> 4;
        if (literals === 15) {
          let b = 255;
          while (b === 255 && i < n) { b = src[i]; i += 1; literals += b; }
        }
        if (literals > 0) {
          if (i + literals > n || o + literals > cap) break;
          out.set(src.subarray(i, i + literals), o);
          o += literals;
          i += literals;
        }
        if (i + 2 > n || o >= cap) break;
        const offset = src[i] | (src[i + 1] << 8);
        i += 2;
        if (offset === 0 || offset > o) throw new Error('bad LZ4 offset');
        let length = token & 15;
        if (length === 15) {
          let b = 255;
          while (b === 255 && i < n) { b = src[i]; i += 1; length += b; }
        }
        length += 4;
        let s = o - offset;
        if (o + length > cap) length = cap - o;
        if (offset >= length) {
          out.set(out.subarray(s, s + length), o);
          o += length;
        } else {
          for (let k = 0; k < length; k += 1) { out[o] = out[s + k]; o += 1; }
        }
      }
      return out.subarray(0, o);
    }

    function dxtPalette(c0, c1) {
      const p = new Uint8Array(16);
      const r0 = ((c0 >> 11) & 31) * 255 / 31;
      const g0 = ((c0 >> 5) & 63) * 255 / 63;
      const b0 = (c0 & 31) * 255 / 31;
      const r1 = ((c1 >> 11) & 31) * 255 / 31;
      const g1 = ((c1 >> 5) & 63) * 255 / 63;
      const b1 = (c1 & 31) * 255 / 31;
      p[0] = r0; p[1] = g0; p[2] = b0;
      p[4] = r1; p[5] = g1; p[6] = b1;
      if (c0 > c1) {
        p[8] = (2 * r0 + r1) / 3; p[9] = (2 * g0 + g1) / 3; p[10] = (2 * b0 + b1) / 3;
        p[12] = (r0 + 2 * r1) / 3; p[13] = (g0 + 2 * g1) / 3; p[14] = (b0 + 2 * b1) / 3;
      } else {
        p[8] = (r0 + r1) / 2; p[9] = (g0 + g1) / 2; p[10] = (b0 + b1) / 2;
        p[12] = 0; p[13] = 0; p[14] = 0;
      }
      p[3] = 255; p[7] = 255; p[11] = 255; p[15] = 255;
      return p;
    }

    /**
     * Decode DXT1 or DXT5 blocks. `kind` is 1 or 5 — the two flavours this
     * library uses (DXT5 whenever a texture needs eight bits of alpha).
     */
    function decodeDxt(raw, w, h, kind) {
      const block = kind === 5 ? 16 : 8;
      const bw = Math.ceil(w / 4);
      const bh = Math.ceil(h / 4);
      if (raw.length < bw * bh * block) return null;
      const out = new Uint8ClampedArray(w * h * 4);
      const alphaTable = new Uint8Array(8);
      for (let by = 0; by < bh; by += 1) {
        for (let bx = 0; bx < bw; bx += 1) {
          const src = (by * bw + bx) * block;
          let colorAt = src;
          let a0 = 255;
          let a1 = 255;
          let alphaBits = 0;
          if (kind === 5) {
            a0 = raw[src];
            a1 = raw[src + 1];
            alphaBits = raw[src + 2] | (raw[src + 3] << 8) | (raw[src + 4] << 16)
              | (raw[src + 5] << 24);
            alphaBits >>>= 0;
            colorAt = src + 8;
            if (a0 > a1) {
              for (let i = 0; i < 6; i += 1) {
                alphaTable[i + 2] = ((6 - i) * a0 + (i + 1) * a1) / 7;
              }
            } else {
              alphaTable[2] = (4 * a0 + a1) / 5;
              alphaTable[3] = (3 * a0 + 2 * a1) / 5;
              alphaTable[4] = (2 * a0 + 3 * a1) / 5;
              alphaTable[5] = (a0 + 4 * a1) / 5;
              alphaTable[6] = 0;
              alphaTable[7] = 255;
            }
            alphaTable[0] = a0;
            alphaTable[1] = a1;
          }
          const c0 = raw[colorAt] | (raw[colorAt + 1] << 8);
          const c1 = raw[colorAt + 2] | (raw[colorAt + 3] << 8);
          const palette = dxtPalette(c0, c1);
          const bits = (raw[colorAt + 4] | (raw[colorAt + 5] << 8)
            | (raw[colorAt + 6] << 16) | (raw[colorAt + 7] << 24)) >>> 0;
          for (let py = 0; py < 4; py += 1) {
            const y = by * 4 + py;
            if (y >= h) break;
            for (let px = 0; px < 4; px += 1) {
              const x = bx * 4 + px;
              if (x >= w) break;
              const idx = py * 4 + px;
              const ci = (bits >> (2 * idx)) & 3;
              const dst = (y * w + x) * 4;
              out[dst] = palette[ci * 4];
              out[dst + 1] = palette[ci * 4 + 1];
              out[dst + 2] = palette[ci * 4 + 2];
              if (kind === 5) {
                const shift = 3 * idx;
                const ai = (alphaBits >>> shift) & 7;
                out[dst + 3] = alphaTable[ai];
              } else {
                out[dst + 3] = c0 > c1 || ci !== 3 ? 255 : 0;
              }
            }
          }
        }
      }
      return { data: out, w: w, h: h };
    }

    /** Interpret decompressed mip bytes using the container's format field. */
    function rawPixels(raw, w, h, fmt) {
      if (!raw || !raw.length || w < 1 || h < 1) return null;
      const per = raw.length / (w * h);
      if (per > 2.5) {
        if (raw.length >= w * h * 4) {
          return { data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, w * h * 4), w: w, h: h };
        }
        if (raw.length >= w * h * 3) {
          const out = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < w * h; i += 1) {
            out[i * 4] = raw[i * 3];
            out[i * 4 + 1] = raw[i * 3 + 1];
            out[i * 4 + 2] = raw[i * 3 + 2];
            out[i * 4 + 3] = 255;
          }
          return { data: out, w: w, h: h };
        }
      } else if (per > 0.9) {
        if (fmt === 1 || fmt === 4) {          // DXT5 also spends one byte per pixel
          const dxt = decodeDxt(raw, w, h, 5);
          if (dxt) return dxt;
        }
        if (raw.length >= w * h) {             // single channel mask
          const out = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < w * h; i += 1) {
            out[i * 4] = raw[i];
            out[i * 4 + 1] = raw[i];
            out[i * 4 + 2] = raw[i];
            out[i * 4 + 3] = 255;
          }
          return { data: out, w: w, h: h };
        }
      } else if (per > 0.45) {
        return decodeDxt(raw, w, h, 1);
      }
      return null;
    }

    /** Header of a TEXV0005 container plus its TEXB mip table. */
    function readTex(bytes) {
      const dv = viewOf(bytes);
      const fmt = bytes.length >= 22 ? dv.getInt32(18, true) : 0;
      const dims = bytes.length >= 42 ? {
        texW: dv.getInt32(26, true),
        texH: dv.getInt32(30, true),
        imgW: dv.getInt32(34, true),
        imgH: dv.getInt32(38, true),
      } : { texW: 0, texH: 0, imgW: 0, imgH: 0 };

      const versions = [2, 3, 4, 5];
      for (let v = 0; v < versions.length; v += 1) {
        const ver = versions[v];
        const start = indexOfBytes(bytes, 'TEXB000' + ver, 40);
        if (start < 0) continue;
        const headerAt = start + 9;
        const mips = dv.getInt32(headerAt + 4 * (ver - 1), true);
        let pos = headerAt + 4 * ver;
        if (!(mips > 0) || mips > 64) return { fmt: fmt, dims: dims, mips: [] };
        const list = [];
        for (let i = 0; i < mips; i += 1) {
          if (pos + 20 > bytes.length) break;
          const w = dv.getInt32(pos, true);
          const h = dv.getInt32(pos + 4, true);
          const lz4 = dv.getInt32(pos + 8, true) === 1;
          const rawSize = dv.getInt32(pos + 12, true);
          const size = dv.getInt32(pos + 16, true);
          pos += 20;
          if (w < 4 || h < 4 || size <= 0 || pos + size > bytes.length) break;
          list.push({ w: w, h: h, lz4: lz4, rawSize: rawSize, off: pos, size: size });
          pos += size;
        }
        return { fmt: fmt, dims: dims, mips: list };
      }
      return { fmt: fmt, dims: dims, mips: [] };
    }

    /** Raw mips hold the padded power-of-two texture; cut the padding back off. */
    function cropToImage(px, tex, mip) {
      const d = tex.dims;
      if (!(d.texW > 0 && d.texH > 0 && d.imgW > 0 && d.imgH > 0)) return px;
      const cw = Math.round(d.imgW * mip.w / d.texW);
      const ch = Math.round(d.imgH * mip.h / d.texH);
      if (!(cw > 0 && ch > 0) || (cw >= px.w && ch >= px.h)) return px;
      const out = new Uint8ClampedArray(cw * ch * 4);
      for (let y = 0; y < ch; y += 1) {
        out.set(px.data.subarray(y * px.w * 4, (y * px.w + cw) * 4), y * cw * 4);
      }
      return { data: out, w: cw, h: ch };
    }

    function bitmapOf(blob) {
      if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
        im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
        im.src = url;
      });
    }

    /** Pixels of one texture, preferring a mip close to the output size. */
    async function texPixels(pkg, texName, minMipWidth) {
      const blob = pkgMember(pkg, texName);
      if (!blob || blob.length < 42) return null;
      const tex = readTex(blob);
      if (!tex.mips.length) return null;

      // Mip 0 comes first, so walking backwards finds the smallest mip that is
      // still at least as wide as the output: no point decoding 4K for 1920px.
      let pick = tex.mips[0];
      if (minMipWidth > 0) {
        for (let i = tex.mips.length - 1; i >= 0; i -= 1) {
          if (tex.mips[i].w >= minMipWidth) { pick = tex.mips[i]; break; }
        }
      }
      const data = blob.subarray(pick.off, pick.off + pick.size);

      if (startsWithBytes(data, PNG_SIG, 0) || startsWithBytes(data, JPEG_SOI, 0)) {
        // Stored image stream: let the browser decode it, then read it back so
        // every layer takes the same compositing path.
        let bmp;
        try {
          bmp = await bitmapOf(new Blob([data]));
        } catch (e) {
          return null;
        }
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width || bmp.naturalWidth;
        canvas.height = bmp.height || bmp.naturalHeight;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        if (!(canvas.width > 0 && canvas.height > 0)) return null;
        const img = g.getImageData(0, 0, canvas.width, canvas.height);
        return { data: img.data, w: canvas.width, h: canvas.height };
      }

      let raw = data;
      if (pick.lz4) {
        try {
          raw = lz4Block(data, pick.rawSize);
        } catch (e) {
          return null;
        }
      }
      if (raw.length && (startsWithBytes(raw, PNG_SIG, 0) || startsWithBytes(raw, JPEG_SOI, 0))) {
        return null;      // a stream we could not identify: do not treat it as pixels
      }
      const px = rawPixels(raw, pick.w, pick.h, tex.fmt);
      if (!px) return null;
      return cropToImage(px, tex, pick);
    }

    /** One image object of a scene, as a drawable layer. */
    async function layerOf(pkg, obj, scale, minMipWidth, canvasH) {
      const modelKey = resolveEntry(pkg, obj.image);
      if (!modelKey || modelKey.slice(-5) !== '.json') return null;
      const model = pkgJson(pkg, modelKey);
      if (!model || model.puppet) return null;         // mesh: needs a rasteriser
      const matKey = resolveEntry(pkg, model.material);
      if (!matKey) return null;
      const material = pkgJson(pkg, matKey);
      if (!material) return null;

      let texName = null;
      let sheet = false;
      const passes = material.passes || [];
      for (let i = 0; i < passes.length && !texName; i += 1) {
        // A sprite sheet is an animation atlas: drawing the whole thing in the
        // object's rectangle shows every frame at once, so it is not a still
        // layer at all. Such objects are the falling sprites in a scene whose
        // real picture is elsewhere.
        if (passes[i].combos && passes[i].combos.SPRITESHEET) sheet = true;
        const textures = passes[i].textures || [];
        for (let k = 0; k < textures.length; k += 1) {
          if (textures[k]) { texName = resolveEntry(pkg, textures[k]); break; }
        }
      }
      if (!texName || sheet) return null;

      const size = vecValue(obj.size, 2);
      if (!size) return null;                          // script-driven size
      const scl = vecValue(obj.scale, 2) || [1, 1];
      const origin = vecValue(obj.origin, 2) || [0, 0];
      const px = await texPixels(pkg, texName, minMipWidth);
      if (!px) return null;

      const dw = Math.max(1, Math.round(size[0] * scl[0] * scale));
      const dh = Math.max(1, Math.round(size[1] * scl[1] * scale));
      if (dw < 4 || dh < 4) return null;
      const alpha = typeof obj.alpha === 'number' ? obj.alpha : 1;
      return {
        px: px,
        // Scene Y points up while image Y points down.
        x: (origin[0] - size[0] * scl[0] / 2) * scale,
        y: canvasH - (origin[1] - size[1] * scl[1] / 2) * scale - dh,
        dw: dw,
        dh: dh,
        alpha: alpha,
      };
    }

    /** Source-over blend of one layer into an RGB buffer, with bilinear scaling. */
    function blitLayer(out, W, H, L) {
      const sw = L.px.w;
      const sh = L.px.h;
      const src = L.px.data;
      const x0 = Math.max(0, Math.floor(L.x));
      const y0 = Math.max(0, Math.floor(L.y));
      const x1 = Math.min(W, Math.ceil(L.x + L.dw));
      const y1 = Math.min(H, Math.ceil(L.y + L.dh));
      if (x1 <= x0 || y1 <= y0) return;

      const exact = L.dw === sw && L.dh === sh
        && L.x === Math.round(L.x) && L.y === Math.round(L.y);
      const aMul = Math.max(0, Math.min(1, L.alpha));

      if (exact && aMul === 1) {
        for (let y = y0; y < y1; y += 1) {
          const sy = y - L.y;
          for (let x = x0; x < x1; x += 1) {
            const s = (sy * sw + (x - L.x)) * 4;
            const a = src[s + 3];
            if (a === 0) continue;
            const d = (y * W + x) * 3;
            if (a === 255) {
              out[d] = src[s];
              out[d + 1] = src[s + 1];
              out[d + 2] = src[s + 2];
            } else {
              const f = a / 255;
              const g = 1 - f;
              out[d] = src[s] * f + out[d] * g;
              out[d + 1] = src[s + 1] * f + out[d + 1] * g;
              out[d + 2] = src[s + 2] * f + out[d + 2] * g;
            }
          }
        }
        return;
      }

      const kx = sw / L.dw;
      const ky = sh / L.dh;
      for (let y = y0; y < y1; y += 1) {
        const fy = Math.max(0, Math.min(sh - 1, (y + 0.5 - L.y) * ky - 0.5));
        const y0i = Math.floor(fy);
        const y1i = Math.min(sh - 1, y0i + 1);
        const wy = fy - y0i;
        for (let x = x0; x < x1; x += 1) {
          const fx = Math.max(0, Math.min(sw - 1, (x + 0.5 - L.x) * kx - 0.5));
          const x0i = Math.floor(fx);
          const x1i = Math.min(sw - 1, x0i + 1);
          const wx = fx - x0i;
          const i00 = (y0i * sw + x0i) * 4;
          const i10 = (y0i * sw + x1i) * 4;
          const i01 = (y1i * sw + x0i) * 4;
          const i11 = (y1i * sw + x1i) * 4;
          const w00 = (1 - wx) * (1 - wy);
          const w10 = wx * (1 - wy);
          const w01 = (1 - wx) * wy;
          const w11 = wx * wy;
          const a = (src[i00 + 3] * w00 + src[i10 + 3] * w10
            + src[i01 + 3] * w01 + src[i11 + 3] * w11) * aMul;
          if (a < 1) continue;
          const r = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
          const g = src[i00 + 1] * w00 + src[i10 + 1] * w10
            + src[i01 + 1] * w01 + src[i11 + 1] * w11;
          const b = src[i00 + 2] * w00 + src[i10 + 2] * w10
            + src[i01 + 2] * w01 + src[i11 + 2] * w11;
          const d = (y * W + x) * 3;
          if (a >= 254) {
            out[d] = r;
            out[d + 1] = g;
            out[d + 2] = b;
          } else {
            const f = a / 255;
            const inv = 1 - f;
            out[d] = r * f + out[d] * inv;
            out[d + 1] = g * f + out[d + 1] * inv;
            out[d + 2] = b * f + out[d + 2] * inv;
          }
        }
      }
    }

    /** Fraction of the frame taken by a puppet (mesh) object, 0 if none. */
    function puppetFraction(pkg, scene) {
      const ortho = (scene.general || {}).orthogonalprojection || {};
      const area = (ortho.width || 0) * (ortho.height || 0);
      if (!(area > 0)) return 0;
      let best = 0;
      const objects = scene.objects || [];
      for (let i = 0; i < objects.length; i += 1) {
        const obj = objects[i];
        if (!obj.image) continue;
        const key = resolveEntry(pkg, obj.image);
        if (!key || key.slice(-5) !== '.json') continue;
        const model = pkgJson(pkg, key);
        if (!model || !model.puppet) continue;
        const size = vecValue(obj.size, 2);
        if (!size) continue;
        const scl = vecValue(obj.scale, 2) || [1, 1];
        best = Math.max(best, size[0] * scl[0] * size[1] * scl[1] / area);
      }
      return best;
    }

    /**
     * Average an RGBA buffer down to a small grid. Averaging (rather than
     * point sampling) is what makes the dominant-colour tests below stable:
     * noise averages away, so a picture reads as a picture.
     */
    function downsampled(rgba, w, h, gw, gh) {
      const out = new Uint8ClampedArray(gw * gh * 3);
      for (let gy = 0; gy < gh; gy += 1) {
        const y0 = Math.min(h - 1, Math.floor(gy * h / gh));
        const y1 = Math.max(y0 + 1, Math.min(h, Math.floor((gy + 1) * h / gh)));
        for (let gx = 0; gx < gw; gx += 1) {
          const x0 = Math.min(w - 1, Math.floor(gx * w / gw));
          const x1 = Math.max(x0 + 1, Math.min(w, Math.floor((gx + 1) * w / gw)));
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) {
              const s = (y * w + x) * 4;
              r += rgba[s];
              g += rgba[s + 1];
              b += rgba[s + 2];
              n += 1;
            }
          }
          const d = (gy * gw + gx) * 3;
          out[d] = r / n;
          out[d + 1] = g / n;
          out[d + 2] = b / n;
        }
      }
      return out;
    }

    /** Share of the picture that is not its dominant colour. */
    function contentFraction(rgba, w, h) {
      const gw = 160;
      const gh = 90;
      const small = downsampled(rgba, w, h, gw, gh);
      const counts = new Map();
      let mode = 0;
      let modeCount = 0;
      for (let i = 0; i < gw * gh; i += 1) {
        const key = (small[i * 3] << 16) | (small[i * 3 + 1] << 8) | small[i * 3 + 2];
        const n = (counts.get(key) || 0) + 1;
        counts.set(key, n);
        if (n > modeCount) { modeCount = n; mode = key; }
      }
      const mr = (mode >> 16) & 255;
      const mg = (mode >> 8) & 255;
      const mb = mode & 255;
      let diff = 0;
      for (let i = 0; i < gw * gh; i += 1) {
        if (Math.abs(small[i * 3] - mr) + Math.abs(small[i * 3 + 1] - mg)
          + Math.abs(small[i * 3 + 2] - mb) > 24) diff += 1;
      }
      return diff / (gw * gh);
    }

    /** Luminance standard deviation of a composite, on a 64x64 reduction. */
    function flatness(rgba, w, h) {
      const n = 64;
      const small = downsampled(rgba, w, h, n, n);
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < n * n; i += 1) {
        const lum = 0.299 * small[i * 3] + 0.587 * small[i * 3 + 1] + 0.114 * small[i * 3 + 2];
        sum += lum;
        sumSq += lum * lum;
      }
      const mean = sum / (n * n);
      return Math.sqrt(Math.max(0, sumSq / (n * n) - mean * mean));
    }

    /**
     * Composite every still layer of a scene.pkg. Returns an object URL plus the
     * pixel buffer (the quality checks need the pixels, not the URL).
     */
    async function renderScene(pkgFile) {
      let bytes;
      try {
        bytes = new Uint8Array(await pkgFile.arrayBuffer());
      } catch (e) {
        return null;
      }
      let pkg;
      let scene;
      try {
        pkg = readPkg(bytes);
        scene = pkgJson(pkg, 'scene.json');
      } catch (e) {
        return null;
      }
      if (!scene || !scene.objects) return null;

      const general = scene.general || {};
      const ortho = general.orthogonalprojection || {};
      let ow = Math.round(ortho.width || 0);
      let oh = Math.round(ortho.height || 0);
      if (!(ow > 0 && oh > 0)) {
        const objects = scene.objects;
        for (let i = 0; i < objects.length; i += 1) {
          const size = vecValue(objects[i].size, 2);
          const origin = vecValue(objects[i].origin, 2);
          if (!size || !origin) continue;
          ow = Math.max(ow, Math.round(origin[0] + size[0] / 2));
          oh = Math.max(oh, Math.round(origin[1] + size[1] / 2));
        }
      }
      if (!(ow > 0 && oh > 0)) return null;

      const scale = ow > SCENE_WIDTH ? SCENE_WIDTH / ow : 1;
      const W = Math.max(1, Math.round(ow * scale));
      const H = Math.max(1, Math.round(oh * scale));
      const minMip = scale < 1 ? W : 0;

      const layers = [];
      for (let i = 0; i < scene.objects.length; i += 1) {
        const obj = scene.objects[i];
        if (obj.visible === false || !obj.image) continue;
        let L = null;
        try {
          L = await layerOf(pkg, obj, scale, minMip, H);
        } catch (e) {
          L = null;
        }
        if (L) layers.push(L);
        // Decoding a 4K layer takes a moment; hand the frame back to the UI
        // every few layers so the window never looks frozen.
        if (i % 4 === 3) await new Promise((resolve) => { setTimeout(resolve, 0); });
      }
      if (!layers.length) return null;

      const clear = colorValue(general.clearcolor, [0.7, 0.7, 0.7]);
      const out = new Uint8ClampedArray(W * H * 3);
      const cr = Math.round(clear[0] * 255);
      const cg = Math.round(clear[1] * 255);
      const cb = Math.round(clear[2] * 255);
      for (let i = 0; i < W * H; i += 1) {
        out[i * 3] = cr;
        out[i * 3 + 1] = cg;
        out[i * 3 + 2] = cb;
      }
      for (let i = 0; i < layers.length; i += 1) blitLayer(out, W, H, layers[i]);

      const rgba = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < W * H; i += 1) {
        rgba[i * 4] = out[i * 3];
        rgba[i * 4 + 1] = out[i * 3 + 1];
        rgba[i * 4 + 2] = out[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }

      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      canvas.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.9);
      });
      if (!blob) return null;

      return {
        url: URL.createObjectURL(blob),
        w: W,
        h: H,
        layers: layers.length,
        rgba: rgba,
        puppet: puppetFraction(pkg, scene),
      };
    }

    /* #endregion scene-renderer */

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

      // A preview GIF animates; a composited scene is static but far sharper.
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

      let pick = null;
      if (!useAnimated) {
        const pkg = await source.file(id, 'scene.pkg');
        if (pkg) {
          status = { ...status, message: '正在合成场景图层…' };
          emit();
          let scene = null;
          try {
            scene = await renderScene(pkg);
          } catch (e) {
            scene = null;
          }
          // Some scenes cannot be reproduced by stacking textures: a puppet
          // (mesh) subject is not a texture at all, and a script-driven scene
          // can composite to a flat colour. The author's preview shows more.
          const empty = scene && (flatness(scene.rgba, scene.w, scene.h) < FLAT_STD
            || (scene.puppet > 0.2 && contentFraction(scene.rgba, scene.w, scene.h) < 0.5));
          const previewEntry = previewUrl ? await measureUrl(previewUrl) : null;
          if (scene && !(empty && previewEntry)) {
            pick = { url: scene.url, w: scene.w, h: scene.h, layers: scene.layers };
          } else if (scene) {
            URL.revokeObjectURL(scene.url);
            if (scene.puppet > 0.2) {
              // The composite is missing its subject; a moving preview is the
              // better of the two, so remember that for the UI.
              artworkRes.set(id, { w: scene.w, h: scene.h, layers: scene.layers, puppet: true });
            }
          }
        }
      }
      if (!pick && previewUrl) {
        const m = await measureUrl(previewUrl);
        if (m) pick = { url: m.url, w: m.w, h: m.h, layers: 0, preview: true };
      }
      if (!pick) return;

      // A GIF can momentarily lose its frame; stack its still first frame
      // underneath so the gap shows artwork instead of the dark canvas.
      const urls = [pick.url];
      if (useAnimated && stillUrl && stillUrl !== pick.url) urls.push(stillUrl);

      artworkCache.set(cacheKey, urls);
      const prev = artworkRes.get(id) || {};
      artworkRes.set(id, {
        w: pick.w,
        h: pick.h,
        layers: pick.layers,
        preview: !!pick.preview,
        puppet: !!prev.puppet,
      });
      if (layer) { layer.urls = urls; sync(); }
      status = { ...status, message: '' };
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
                  return r && r.w < 1280
                    ? 'var(--dsw-alias-state-warn-primary)'
                    : 'var(--dsw-alias-label-tertiary)';
                })(),
              },
            }, (function () {
              const r = artworkRes.get(cur.wallpaper);
              if (!r) return '正在合成场景图层…';
              const size = r.w + '×' + r.h;
              const tag = r.w >= 1920 ? '清晰'
                : r.w >= 1280 ? '尚可'
                : '放大会糊，可调高「壁纸模糊」掩盖';
              if (r.layers) {
                return '合成 ' + r.layers + ' 层 · ' + size + ' · ' + tag;
              }
              return '预览图 ' + size + '（无 scene.pkg）· ' + tag;
            })()) : null,
            /* Live layer state, so a wallpaper that resolves but does not paint
               can be told apart from one that never resolved. */
            h('div', {
              style: {
                fontSize: '11px', marginTop: '4px',
                fontFamily: 'ui-monospace, Consolas, monospace',
                color: 'var(--dsw-alias-label-caption)',
                overflowWrap: 'anywhere',
              },
            }, (function () {
              if (!layer) return '图层: 未创建';
              const urls = layer.urls || [];
              const inDoc = document.body.contains(layer.root);
              const bg = String(getComputedStyle(layer.img).backgroundImage);
              const frame = document.querySelector('[class*="_frame"]');
              const frameBg = frame ? getComputedStyle(frame).backgroundColor : '?';
              return '图层 ' + urls.length + ' 张 · display='
                + (layer.root.style.display || '默认')
                + ' · 在DOM=' + (inDoc ? '是' : '否')
                + ' · token=' + (disposeTokens ? '已注入' : '未注入')
                + ' · theme=' + (theme() ? '有' : '无')
                + ' · 框架bg=' + frameBg
                + ' · ' + (bg === 'none' ? '背景=无' : bg.slice(0, 22));
            })()),
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

        /* animated previews: sharper composite vs moving GIF */
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
            return n + ' 张有动图预览' + (cur.preferAnimated ? '' : '，其余按 scene.pkg 图层合成原图');
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
