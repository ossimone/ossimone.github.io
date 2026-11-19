/* PDF içindeki gömülü yazı tiplerini bulma, ölçme ve önizleme için yazı tipi kaydı. */

import { state } from './core.js';
import { getPage, getTextContent } from './render.js';

const PDFLib = window.PDFLib;
const fontkit = window.fontkit;

const libDocs = new Map();
const pageFontCache = new Map();
const faceCache = new Map();
const sysFontCache = new Map();

export const SYS_FONTS = {
  'sys:sans':        { file: 'LiberationSans-Regular.ttf', label: 'Liberation Sans — sans (Arial benzeri)', css: 'PDFSans, sans-serif', cat: 'sans', bold: false, italic: false },
  'sys:sans-bold':   { file: 'LiberationSans-Bold.ttf',    label: 'Liberation Sans Kalın — sans',            css: 'PDFSans, sans-serif', cat: 'sans', bold: true,  italic: false },
  'sys:sans-italic': { file: 'LiberationSans-Italic.ttf',  label: 'Liberation Sans Eğik — sans',             css: 'PDFSans, sans-serif', cat: 'sans', bold: false, italic: true },
  'sys:serif':       { file: 'Tinos-Regular.ttf',   label: 'Tinos — serif (Times benzeri)',           css: 'PDFSerif, serif', cat: 'serif', bold: false, italic: false },
  'sys:serif-bold':  { file: 'Tinos-Bold.ttf',      label: 'Tinos Kalın — serif',                     css: 'PDFSerif, serif', cat: 'serif', bold: true,  italic: false },
  'sys:serif-italic':{ file: 'Tinos-Italic.ttf',    label: 'Tinos Eğik — serif',                      css: 'PDFSerif, serif', cat: 'serif', bold: false, italic: true },
  'sys:mono':        { file: 'Cousine-Regular.ttf', label: 'Cousine — eş aralıklı (Courier benzeri)',   css: 'PDFMono, monospace', cat: 'mono', bold: false, italic: false },
  'sys:mono-bold':   { file: 'Cousine-Bold.ttf',    label: 'Cousine Kalın — eş aralıklı',              css: 'PDFMono, monospace', cat: 'mono', bold: true,  italic: false },
  'sys:dejavu':      { file: 'DejaVuSans.ttf',      label: 'DejaVu Sans — geniş karakter desteği',     css: 'PDFSans, sans-serif', cat: 'sans', bold: false, italic: false },
};

export function stripSubset(name = '') {
  return name.replace(/^[A-Z]{6}\+/, '');
}
export function normName(s = '') {
  return stripSubset(s).toLowerCase().replace(/[\s_\-.,]/g, '');
}

export function getLibDoc(fileId) {
  if (!libDocs.has(fileId)) {
    const file = state.files.get(fileId);
    if (!file) return Promise.reject(new Error('Dosya bulunamadı'));
    libDocs.set(fileId, PDFLib.PDFDocument.load(file.bytes.slice(0)).catch(err => {
      libDocs.delete(fileId);
      throw err;
    }));
  }
  return libDocs.get(fileId);
}

/* ---------- gömülü yazı tipi çıkarma ---------- */

function classify(names) {
  const n = names.join(' ').toLowerCase();
  if (/mono|courier|consol|menlo|inconsolata|code|lucida console/.test(n)) return 'mono';
  if (/serif|times|georgia|garamond|cambria|palatino|baskerville|minion|roman|book/.test(n) && !/sans/.test(n)) return 'serif';
  return 'sans';
}

function makeEntry({ resName, baseFont, bytes, generic }) {
  const entry = {
    resName,
    baseFont: baseFont || resName,
    bytes: bytes && bytes.length > 64 ? bytes : null,
    fk: null,
    family: stripSubset(baseFont || resName),
    postscript: '',
    category: classify([baseFont || resName, generic || '']),
    bold: /bold|black|heavy|semibold|demi/i.test(baseFont || ''),
    italic: /italic|oblique/i.test(baseFont || ''),
    glyphCount: 0,
    usable: false,
  };
  if (generic) entry.category = generic === 'monospace' ? 'mono' : generic === 'serif' ? 'serif' : 'sans';
  if (entry.bytes) {
    try {
      const fk = fontkit.create(entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes));
      entry.fk = fk;
      entry.family = fk.familyName || entry.family;
      entry.postscript = fk.postscriptName || '';
      if (!generic) entry.category = classify([entry.family, entry.postscript, entry.baseFont]);
      entry.bold = entry.bold || /bold|black|heavy|semibold|demi/i.test(entry.family + ' ' + (fk.subfamilyName || ''));
      entry.italic = entry.italic || /italic|oblique/i.test(entry.family + ' ' + (fk.subfamilyName || ''));
      try { entry.glyphCount = fk.numGlyphs || 0; } catch { entry.glyphCount = 0; }
      entry.usable = true;
    } catch {
      entry.usable = false;
    }
  }
  return entry;
}

/** pdf-lib üzerinden sayfa kaynaklarındaki yazı tipleri (yedek yol). */
async function fontsFromPdfLib(fileId, srcIndex) {
  let doc;
  try { doc = await getLibDoc(fileId); } catch { return []; }
  let page;
  try { page = doc.getPage(srcIndex); } catch { return []; }
  const resources = page.node.Resources();
  if (!resources) return [];
  const fontDict = resources.lookup(PDFLib.PDFName.of('Font'));
  if (!fontDict || typeof fontDict.entries !== 'function') return [];

  const out = [];
  for (const [nameObj, _ref] of fontDict.entries()) {
    let resName = '';
    try { resName = nameObj.decodeText(); } catch { resName = String(nameObj).replace(/^\//, ''); }
    let font;
    try { font = fontDict.lookup(nameObj); } catch { continue; }
    if (!font || typeof font.lookup !== 'function') continue;

    let baseFont = resName;
    try {
      const bf = font.lookup(PDFLib.PDFName.of('BaseFont'));
      if (bf && bf.decodeText) baseFont = bf.decodeText();
    } catch { /* yoksay */ }

    let bytes = null;
    try {
      let target = font;
      let desc = target.lookup(PDFLib.PDFName.of('FontDescriptor'));
      if (!desc) {
        const df = target.lookup(PDFLib.PDFName.of('DescendantFonts'));
        if (df && df.size && df.size() > 0) {
          target = target.context.lookup(df.get(0));
          desc = target.lookup(PDFLib.PDFName.of('FontDescriptor'));
        }
      }
      if (desc) {
        for (const k of ['FontFile2', 'FontFile3', 'FontFile']) {
          const ref = desc.lookup(PDFLib.PDFName.of(k));
          if (!ref) continue;
          const stream = desc.context.lookup(ref);
          if (!stream || !stream.contents) continue;
          let decoded = stream.contents;
          try {
            decoded = PDFLib.decodePDFRawStream(stream).decode();
          } catch {
            try { decoded = stream.decode(); } catch { /* ham bayt */ }
          }
          if (decoded && decoded.length > 64) { bytes = decoded; break; }
        }
      }
    } catch { /* yoksay */ }

    out.push(makeEntry({ resName, baseFont, bytes }));
  }
  return out;
}

/** Sayfadaki yazı tipleri: önce pdf.js'in yüklediği fontlar, sonra pdf-lib yedeği. */
export async function getPageFonts(entryOrFileId, maybeIndex) {
  const fileId = typeof entryOrFileId === 'string' ? entryOrFileId : entryOrFileId.fileId;
  const srcIndex = typeof entryOrFileId === 'string' ? maybeIndex : entryOrFileId.srcIndex;
  const entry = typeof entryOrFileId === 'string'
    ? { fileId, srcIndex } : entryOrFileId;
  const key = fileId + ':' + srcIndex;
  if (pageFontCache.has(key)) return pageFontCache.get(key);

  const promise = (async () => {
    const result = [];
    const seen = new Set();

    // 1) pdf.js'in çözdüğü fontlar (isabetli eşleşme: fontName)
    try {
      const page = await getPage(entry);
      const tc = await getTextContent(entry).catch(() => null);
      const names = [...new Set((tc ? tc.items : []).map(i => i.fontName).filter(Boolean))];
      for (const fontName of names) {
        let font = null;
        try { font = page.commonObjs.get(fontName); } catch { font = null; }
        if (!font) continue;
        let bytes = null;
        try {
          if (font.data && (font.data instanceof Uint8Array || font.data.byteLength)) {
            bytes = font.data instanceof Uint8Array ? font.data : new Uint8Array(font.data);
          }
        } catch { bytes = null; }
        const item = makeEntry({
          resName: fontName,
          baseFont: font.name || fontName,
          bytes,
          generic: font.fallbackName === 'monospace' ? 'monospace' : font.fallbackName === 'serif' ? 'serif' : (font.fallbackName ? 'sans-serif' : null),
        });
        seen.add(normName(item.baseFont));
        result.push(item);
      }
    } catch { /* yoksay */ }

    // 2) pdf-lib ile kalan fontlar / eksik baytlar
    try {
      const libFonts = await fontsFromPdfLib(fileId, srcIndex);
      for (const f of libFonts) {
        const sameRes = result.find(r => r.resName === f.resName);
        if (sameRes) {
          if (!sameRes.bytes && f.bytes) {
            Object.assign(sameRes, makeEntry({ resName: sameRes.resName, baseFont: f.baseFont, bytes: f.bytes }));
          }
          continue;
        }
        if (!f.usable) continue;
        if (result.some(r => r.resName === f.resName)) continue;
        result.push(f);
      }
    } catch { /* yoksay */ }

    // kullanılabilir olanları öne al
    result.sort((a, b) => (b.usable - a.usable) || (b.glyphCount - a.glyphCount));
    return result;
  })();

  pageFontCache.set(key, promise);
  return promise;
}

export function invalidateFontCache() {
  pageFontCache.clear();
  faceCache.clear();
  libDocs.clear();
}

/* ---------- yazı tipi seçimi ---------- */

export function categoryOfGeneric(text = '') {
  if (/mono/i.test(text)) return 'mono';
  if (/serif/i.test(text) && !/sans/i.test(text)) return 'serif';
  return 'sans';
}

export function pickFont(fonts, style = {}) {
  const wantCat = categoryOfGeneric(style.fontFamily || '');
  const wantBold = /bold|black|heavy/i.test(style.fontFamily || '');
  let best = null, bestScore = -1;
  for (const f of fonts) {
    if (!f.usable) continue;
    let score = 0;
    if (f.category === wantCat) score += 5;
    if (wantBold === f.bold) score += 2;
    score += Math.min(3, Math.log10(Math.max(1, f.glyphCount)) - 1);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  if (best) return 'emb:' + best.resName;
  return wantCat === 'serif' ? 'sys:serif' : wantCat === 'mono' ? 'sys:mono' : 'sys:sans';
}

/** Metin kutusunun fontName'i için baytları olan gömülü font kaydını bulur. */
export function usableFor(fonts, resName, text) {
  if (!fonts || !resName) return null;
  const direct = fonts.find(f => f.resName === resName);
  if (direct && direct.usable) return direct;
  if (!direct) return null;
  const nb = normName(direct.baseFont || '');
  if (!nb) return null;
  const cands = fonts.filter(f => f.usable && normName(f.baseFont || '') === nb);
  if (!cands.length) return null;
  // Aynı BaseFont'a sahip birden çok alt küme olabilir: metni kapsayanı seç.
  if (text) {
    const covering = cands.filter(f => f.fk && missingChars(f.fk, text).length === 0);
    if (covering.length) return covering.sort((a, b) => (b.glyphCount || 0) - (a.glyphCount || 0))[0];
  }
  return cands.sort((a, b) => (b.glyphCount || 0) - (a.glyphCount || 0))[0];
}

export function fontLabelFor(key, fonts) {
  if (key.startsWith('emb:')) {
    const res = key.slice(4);
    const f = fonts.find(x => x.resName === res);
    if (!f) return 'Gömülü yazı tipi';
    return `Gömülü · ${f.family}${f.bold ? ' Kalın' : ''}${f.italic ? ' Eğik' : ''}`;
  }
  return (SYS_FONTS[key] || SYS_FONTS['sys:sans']).label;
}

export async function getSysFont(key) {
  const meta = SYS_FONTS[key] || SYS_FONTS['sys:sans'];
  if (!sysFontCache.has(meta.file)) {
    sysFontCache.set(meta.file, (async () => {
      const res = await fetch('vendor/fonts/' + meta.file);
      if (!res.ok) throw new Error('Yazı tipi yüklenemedi: ' + meta.file);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, fk: fontkit.create(bytes), css: meta.css, bold: meta.bold, italic: meta.italic, cat: meta.cat, label: meta.label };
    })());
  }
  return sysFontCache.get(meta.file);
}

/** key -> { bytes, fk, css, label, embedded? } */
export async function resolveFont(key, fonts) {
  if (key && key.startsWith('emb:')) {
    const res = key.slice(4);
    const f = fonts.find(x => x.resName === res);
    if (f && f.usable) {
      return {
        bytes: f.bytes,
        fk: f.fk,
        css: await previewFamily('emb:' + res, f.bytes, f.category),
        label: `Gömülü · ${f.family}`,
        embedded: f,
      };
    }
  }
  const sys = await getSysFont(key);
  return { bytes: sys.bytes, fk: sys.fk, css: sys.css, label: sys.label };
}

/** Önizleme için @font-face kaydı (gömülü font tarayıcıda çözülemezse kategoriye düşer). */
async function previewFamily(key, bytes, category) {
  if (faceCache.has(key)) return faceCache.get(key);
  const family = 'emb_' + key.replace(/[^a-zA-Z0-9]/g, '_');
  try {
    const copy = bytes.slice ? bytes.slice().buffer : bytes;
    const face = new FontFace(family, copy);
    await face.load();
    document.fonts.add(face);
    const val = `"${family}", ${category === 'serif' ? 'PDFSerif' : category === 'mono' ? 'PDFMono' : 'PDFSans'}, sans-serif`;
    faceCache.set(key, val);
    return val;
  } catch {
    const val = category === 'serif' ? 'PDFSerif, serif' : category === 'mono' ? 'PDFMono, monospace' : 'PDFSans, sans-serif';
    faceCache.set(key, val);
    return val;
  }
}

export function measureWidth(fk, text, size) {
  try {
    const upm = fk.unitsPerEm || 1000;
    return (fk.layout(String(text)).advanceWidth / upm) * size;
  } catch {
    return String(text).length * size * 0.52;
  }
}

export function missingChars(fk, text) {
  if (!fk) return [];
  const out = new Set();
  for (const ch of String(text)) {
    if (ch === '\n' || ch === '\r') continue;
    try {
      const cp = ch.codePointAt(0);
      if (!fk.hasGlyphForCodePoint(cp)) out.add(ch);
    } catch { /* yoksay */ }
  }
  return [...out];
}

export function fontOptions(fonts) {
  const opts = [];
  const embedded = fonts.filter(f => f.usable);
  if (embedded.length) {
    const dup = new Map();
    for (const f of embedded) {
      const k = `${f.family}|${f.bold}|${f.italic}`;
      dup.set(k, (dup.get(k) || 0) + 1);
    }
    opts.push({
      group: 'Belgedeki gömülü yazı tipleri',
      items: embedded.map(f => {
        const k = `${f.family}|${f.bold}|${f.italic}`;
        const tag = dup.get(k) > 1 ? ` (${f.resName})` : '';
        return {
          value: 'emb:' + f.resName,
          label: `${f.family}${f.bold ? ' Kalın' : ''}${f.italic ? ' Eğik' : ''}${tag}${f.glyphCount ? ` · ${f.glyphCount} glif` : ''}`,
        };
      }),
    });
  }
  opts.push({
    group: 'Hazır yazı tipleri',
    items: Object.entries(SYS_FONTS).map(([k, v]) => ({ value: k, label: v.label })),
  });
  return opts;
}
