/**
 * Headless test for the scene renderer inside client.js.
 *
 * The plugin is a single browser file, so the renderer is fenced with
 * `#region scene-renderer` markers and this harness evaluates exactly that
 * slice in Node with small DOM shims (canvas, createImageBitmap, Blob, URL).
 * It renders the wallpapers you pass on the command line and writes PNGs, which
 * is how the compositor was verified against a Python reference implementation
 * (tools/render-scene.py in the development workspace) and against the
 * wallpapers' own preview images.
 *
 *   node test/scene-render.mjs <workshopId> [<workshopId> ...]
 *   node test/scene-render.mjs 2372608028 --layers     # per-object report
 *
 * The library path defaults to the Windows Steam location; override it with
 * the WPE_LIBRARY environment variable. PNG mips decode here; JPEG mips need a
 * browser, so a wallpaper whose artwork is a single JPEG stream reports
 * `no layers` in this harness only.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'client.js');
const BASE = process.env.WPE_LIBRARY
  || 'D:\\Steam\\steamapps\\workshop\\content\\431960';
const OUT = process.env.WPE_OUT || path.join(HERE, 'out');

/* ── minimal PNG encode (RGBA) ─────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function pngEncode(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4)
      .copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── minimal PNG decode (for stored PNG mips) ──────────────────────── */

function pngDecode(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('not a PNG');
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 8;
  let colorType = 6;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const len = (bytes[pos] << 24 | bytes[pos + 1] << 16 | bytes[pos + 2] << 8
      | bytes[pos + 3]) >>> 0;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = (body[0] << 24 | body[1] << 16 | body[2] << 8 | body[3]) >>> 0;
      h = (body[4] << 24 | body[5] << 16 | body[6] << 8 | body[7]) >>> 0;
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('bit depth ' + depth + ' unsupported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2
    : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error('color type ' + colorType + ' unsupported');
  const flat = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8ClampedArray(w * h * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    const filter = flat[p];
    p += 1;
    flat.copy(cur, 0, p, p + stride);
    p += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) cur[i] = (cur[i] + a) & 255;
      else if (filter === 2) cur[i] = (cur[i] + b) & 255;
      else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < w; x += 1) {
      const d = (y * w + x) * 4;
      const s = x * channels;
      if (channels === 4) {
        out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3];
      } else if (channels === 3) {
        out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255;
      } else if (channels === 2) {
        out[d] = cur[s]; out[d + 1] = cur[s]; out[d + 2] = cur[s]; out[d + 3] = cur[s + 1];
      } else {
        out[d] = cur[s]; out[d + 1] = cur[s]; out[d + 2] = cur[s]; out[d + 3] = 255;
      }
    }
    cur.copy(prev);
  }
  return { data: out, width: w, height: h };
}

/* ── DOM shims ─────────────────────────────────────────────────────── */

let urlSeq = 0;

function makeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    _data: null,
    getContext() {
      return {
        putImageData(img) {
          canvas._data = img.data;
          canvas.width = img.width;
          canvas.height = img.height;
        },
        getImageData(x, y, w, h) {
          return { data: canvas._data, width: w, height: h };
        },
        drawImage(bmp) {
          canvas._data = bmp.data;
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        },
      };
    },
    toBlob(cb) {
      cb({ size: canvas._data ? canvas._data.length : 0 });
    },
  };
  return canvas;
}

const shims = {
  document: { createElement: () => makeCanvas() },
  createImageBitmap: async (blob) => {
    const bytes = blob.parts && blob.parts[0];
    if (!bytes) throw new Error('empty blob');
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) {
      throw new Error('only PNG streams decode in this harness (JPEG needs a browser)');
    }
    const img = pngDecode(bytes);
    return { width: img.width, height: img.height, data: img.data, close() {} };
  },
  URL: {
    createObjectURL: (blob) => 'blob:test/' + (urlSeq += 1) + '/' + (blob && blob.size),
    revokeObjectURL: () => {},
  },
  Blob: class Blob {
    constructor(parts) { this.parts = parts; this.size = parts.reduce((n, p) => n + (p.length || 0), 0); }
  },
  ImageData: class ImageData {
    constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
  },
};

/* ── extract the renderer out of client.js ─────────────────────────── */

const src = fs.readFileSync(CLIENT, 'utf8');
const match = src.match(/\/\* #region scene-renderer \*\/([\s\S]*?)\/\* #endregion scene-renderer \*\//);
if (!match) {
  console.error('no #region scene-renderer block in ' + CLIENT);
  process.exit(1);
}

const exposed = ['readPkg', 'pkgJson', 'pkgMember', 'resolveEntry', 'readTex', 'texPixels',
  'layerOf', 'blitLayer', 'renderScene', 'flatness', 'contentFraction', 'puppetFraction',
  'rawPixels', 'decodeDxt', 'vecValue', 'colorValue', 'SCENE_WIDTH', 'FLAT_STD'];
const factory = new Function(
  'document', 'createImageBitmap', 'URL', 'Blob', 'ImageData', 'PNG_SIG', 'JPEG_SOI',
  match[1] + '\nreturn {' + exposed.join(', ') + '};',
);
const api = factory(shims.document, shims.createImageBitmap, shims.URL, shims.Blob,
  shims.ImageData, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0xff, 0xd8, 0xff]);

/* ── run ───────────────────────────────────────────────────────────── */

const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const layerTable = process.argv.includes('--layers');
const width = Number((process.argv.find((a) => a.startsWith('--width=')) || '--width=1920').slice(8));
if (!ids.length) {
  console.error('usage: node test/scene-render.mjs <workshopId> [...] [--layers] [--width=N]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

for (const wid of ids) {
  const pkgPath = path.join(BASE, wid, 'scene.pkg');
  if (!fs.existsSync(pkgPath)) {
    console.log(wid + ': no scene.pkg at ' + pkgPath);
    continue;
  }
  const bytes = new Uint8Array(fs.readFileSync(pkgPath));
  const pkgFile = {
    name: 'scene.pkg',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
  const pkg = api.readPkg(bytes);

  if (layerTable) {
    const scene = api.pkgJson(pkg, 'scene.json');
    const ortho = (scene.general || {}).orthogonalprojection || {};
    const ow = Math.round(ortho.width || 0);
    const oh = Math.round(ortho.height || 0);
    const scale = ow > width ? width / ow : 1;
    const W = Math.round(ow * scale);
    const H = Math.round(oh * scale);
    const minMip = scale < 1 ? W : 0;
    console.log(JSON.stringify({ id: wid, ortho: [ow, oh], canvas: [W, H], scale }));
    const objects = scene.objects || [];
    for (let i = 0; i < objects.length; i += 1) {
      const obj = objects[i];
      if (obj.visible === false || !obj.image) continue;
      let L = null;
      let why = '';
      const t0 = Date.now();
      try {
        L = await api.layerOf(pkg, obj, scale, minMip, H);
      } catch (e) {
        why = String(e.message || e);
      }
      const ms = Date.now() - t0;
      if (L) {
        console.log(JSON.stringify({
          i, name: obj.name, x: L.x, y: L.y, dw: L.dw, dh: L.dh,
          src: [L.px.w, L.px.h], alpha: L.alpha, ms,
        }));
      } else {
        console.log(JSON.stringify({ i, name: obj.name, skipped: why || 'unresolved', ms }));
      }
    }
    continue;
  }

  const t0 = Date.now();
  const scene = await api.renderScene(pkgFile);
  const ms = Date.now() - t0;
  if (!scene) {
    console.log(wid + ': renderScene returned null (JPEG-only artwork? no placeable layer?)');
    continue;
  }
  const out = path.join(OUT, wid + '.png');
  fs.writeFileSync(out, pngEncode(scene.rgba, scene.w, scene.h));
  console.log(JSON.stringify({
    id: wid,
    canvas: [scene.w, scene.h],
    layers: scene.layers,
    puppet: Number(scene.puppet.toFixed(3)),
    flatness: Number(api.flatness(scene.rgba, scene.w, scene.h).toFixed(2)),
    content: Number(api.contentFraction(scene.rgba, scene.w, scene.h).toFixed(3)),
    ms,
    out,
  }));
}
