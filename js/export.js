/* Düzenlenmiş belgeyi yeni bir PDF olarak üretir. */

import { state, clamp, baseName, toast } from './core.js';
import { getLibDoc, getPageFonts, getSysFont } from './fonts.js';

const PDFLib = window.PDFLib;

export async function buildPdf() {
  const { PDFDocument, degrees, rgb, StandardFonts, BlendMode, LineCapStyle } = PDFLib;
  if (!state.pages.length) throw new Error('Belge boş');

  const out = await PDFDocument.create();
  out.registerFontkit(window.fontkit);
  out.setTitle(state.title || 'Belge');
  out.setProducer('PDF Stüdyo');
  out.setCreator('PDF Stüdyo');
  const now = new Date();
  out.setCreationDate(now);
  out.setModificationDate(now);

  const fontCache = new Map();
  let helv = null;
  let noteFont = null;
  const warnings = [];

  async function outFont(key, entry) {
    const cacheKey = (entry ? entry.fileId + ':' + entry.srcIndex : '') + '::' + key;
    if (fontCache.has(cacheKey)) return fontCache.get(cacheKey);
    const promise = (async () => {
      try {
        let bytes = null;
        if (entry && key && key.startsWith('emb:')) {
          const fonts = await getPageFonts(entry);
          const f = fonts.find(x => x.resName === key.slice(4));
          if (f && f.bytes) bytes = f.bytes;
        }
        if (!bytes) {
          const sys = await getSysFont(key && key.startsWith('sys:') ? key : 'sys:sans');
          bytes = sys.bytes;
        }
        try {
          return await out.embedFont(bytes, { subset: true });
        } catch {
          try { return await out.embedFont(bytes, { subset: false }); } catch { return null; }
        }
      } catch (err) {
        warnings.push(String(err && err.message || err));
        return null;
      }
    })();
    fontCache.set(cacheKey, promise);
    return promise;
  }

  // sayfaları sırayla kopyala
  const libDocs = new Map();
  for (const entry of state.pages) {
    if (!libDocs.has(entry.fileId)) libDocs.set(entry.fileId, await getLibDoc(entry.fileId));
    const src = libDocs.get(entry.fileId);
    let copied;
    try {
      [copied] = await out.copyPages(src, [entry.srcIndex]);
    } catch (err) {
      throw new Error('Sayfa kopyalanamadı: ' + (err.message || err));
    }
    const baseRot = copied.getRotation().angle || 0;
    const total = ((baseRot + (entry.rotation || 0)) % 360 + 360) % 360;
    copied.setRotation(degrees(total));
    out.addPage(copied);
  }

  // metin düzenlemeleri
  for (let i = 0; i < state.pages.length; i++) {
    const entry = state.pages[i];
    const page = out.getPage(i);
    for (const op of entry.textOps || []) {
      if (op.cover !== false) {
        const [x0, y0, x1, y1] = op.rect;
        try {
          page.drawRectangle({
            x: x0, y: y0, width: Math.max(0.2, x1 - x0), height: Math.max(0.2, y1 - y0),
            color: rgb(op.bg[0] / 255, op.bg[1] / 255, op.bg[2] / 255),
            borderWidth: 0,
          });
        } catch (err) { warnings.push('Kapatma dikdörtgeni: ' + (err.message || err)); }
      }
      if (!op.text) continue;
      const colorRgb = { r: op.color[0] / 255, g: op.color[1] / 255, b: op.color[2] / 255 };
      const dirRad = (op.textDir || 0) * Math.PI / 180;
      const cosD = Math.cos(dirRad), sinD = Math.sin(dirRad);
      const lineH = Math.max(1, op.lineHeight || op.fontSize * 1.2);
      const linesOut = Array.isArray(op.lines) && op.lines.length ? op.lines : String(op.text).split('\n').map(t => ({ text: t, width: 0, runs: null }));
      const stepX = Math.sin(dirRad) * lineH;
      const stepY = -Math.cos(dirRad) * lineH;

      for (let li = 0; li < linesOut.length; li++) {
        const line = linesOut[li];
        const bx = op.x + li * stepX;
        const by = op.y + li * stepY;

        if (line.runs && line.runs.length) {
          let curX = bx, curY = by;
          for (const run of line.runs) {
            const runFont = await outFont(run.fontKey, entry);
            let useFont = runFont;
            let runText = run.text;
            if (!useFont) {
              useFont = helv || (helv = await out.embedFont(StandardFonts.Helvetica));
              runText = sanitizeWinAnsi(runText);
            }
            try {
              const size = Math.max(1, op.fontSize);
              const runOpts = {
                x: curX, y: curY, size,
                font: useFont,
                color: rgb(colorRgb.r, colorRgb.g, colorRgb.b),
                lineHeight: size * 1.2,
              };
              if (op.textDir) runOpts.rotate = degrees(op.textDir);
              page.drawText(runText, runOpts);
              const adv = useFont.widthOfTextAtSize(runText, size);
              curX += adv * cosD;
              curY += adv * sinD;
            } catch (err) {
              warnings.push('Metin parçası yazılamadı: ' + (err.message || err));
            }
          }
          continue;
        }

        let font = await outFont(op.fontKey, entry);
        let textOut = line.text;
        if (!font) {
          font = helv || (helv = await out.embedFont(StandardFonts.Helvetica));
          textOut = sanitizeWinAnsi(textOut);
        }
        try {
          const opts = {
            x: bx, y: by, size: Math.max(1, op.fontSize),
            font,
            color: rgb(colorRgb.r, colorRgb.g, colorRgb.b),
            lineHeight: Math.max(1, op.fontSize) * 1.2,
          };
          if (op.textDir) opts.rotate = degrees(op.textDir);
          page.drawText(textOut, opts);
        } catch (err) {
          warnings.push('Metin yazılamadı: ' + (err.message || err));
        }
      }
    }
  }

  // işaretler (metinlerin üstüne)
  for (let i = 0; i < state.pages.length; i++) {
    const entry = state.pages[i];
    const page = out.getPage(i);
    for (const a of entry.annots || []) {
      try {
        if (a.type === 'highlight' || a.type === 'rect') {
          const [x0, y0, x1, y1] = a.rect;
          const color = rgb(a.color[0] / 255, a.color[1] / 255, a.color[2] / 255);
          if (a.type === 'highlight') {
            page.drawRectangle({
              x: x0, y: y0, width: x1 - x0, height: y1 - y0, color,
              opacity: clamp(a.opacity ?? 0.38, 0.05, 1),
              blendMode: BlendMode.Multiply, borderWidth: 0,
            });
          } else {
            page.drawRectangle({
              x: x0, y: y0, width: x1 - x0, height: y1 - y0,
              borderColor: color, borderWidth: a.width || 1.6,
            });
          }
        } else if (a.type === 'pen') {
          const color = rgb(a.color[0] / 255, a.color[1] / 255, a.color[2] / 255);
          const w = a.width || 2.2;
          for (let j = 1; j < a.points.length; j++) {
            const p1 = a.points[j - 1], p2 = a.points[j];
            if (Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) < 0.15) continue;
            page.drawLine({
              start: { x: p1[0], y: p1[1] }, end: { x: p2[0], y: p2[1] },
              thickness: w, color, lineCap: LineCapStyle.Round,
            });
          }
        } else if (a.type === 'note') {
          const [x0, y0, x1, y1] = a.rect;
          const color = rgb(a.color[0] / 255, a.color[1] / 255, a.color[2] / 255);
          page.drawRectangle({
            x: x0, y: y0, width: x1 - x0, height: y1 - y0,
            color, opacity: 0.94, borderColor: rgb(0.15, 0.13, 0.05),
            borderWidth: 0.6, borderOpacity: 0.35,
          });
          if (!noteFont) {
            const sys = await getSysFont('sys:sans');
            noteFont = await out.embedFont(sys.bytes, { subset: true }).catch(() => null);
            if (!noteFont) noteFont = await out.embedFont(StandardFonts.Helvetica);
          }
          const size = clamp(a.fontSize || 11, 4, 72);
          const maxW = Math.max(10, x1 - x0 - 8);
          const lines = wrapText(noteFont, a.text || '', size, maxW);
          const lineH = size * 1.22;
          const maxLines = Math.max(1, Math.floor((y1 - y0 - 6) / lineH));
          let shown = lines.slice(0, maxLines);
          if (lines.length > maxLines) {
            shown[maxLines - 1] = shown[maxLines - 1].replace(/.{1,3}$/, '…');
          }
          shown.forEach((line, k) => {
            page.drawText(line, {
              x: x0 + 4, y: y1 - 4 - size * 0.92 - k * lineH,
              size, font: noteFont, color: rgb(0.17, 0.14, 0.03),
            });
          });
        }
      } catch (err) {
        warnings.push('İşaret eklenemedi: ' + (err.message || err));
      }
    }
  }

  const bytes = await out.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const name = (state.title ? baseName(state.title) : 'belge') + ' - düzenlendi.pdf';
  if (warnings.length) {
    console.warn('PDF uyarıları:', warnings);
    toast(warnings.length + ' öğe yaklaşık olarak eklendi.');
  }
  return { blob, name, bytes, warnings };
}

function wrapText(font, text, size, maxWidth) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      const next = line ? line + ' ' + w : w;
      let width = 0;
      try { width = font.widthOfTextAtSize(next, size); } catch { width = next.length * size * 0.5; }
      if (width > maxWidth && line) {
        out.push(line);
        line = w;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function sanitizeWinAnsi(text) {
  return String(text).replace(/[^\u0000-\u00ff]/g, '?');
}
