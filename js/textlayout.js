/* Metin yerleşim (wrap): önizleme ve PDF export aynı sonuç için bu modülü kullanır. */

/** texts: paragraf satırlarını, run uzunluklarını koruyarak, ölçerek satırlara böler. */

import { measureWidth } from './fonts.js';

const segOf = (s) => [...new Intl.Segmenter('tr', { granularity: 'grapheme' }).segment(String(s))].map(x => x.segment);

/** runs dizisini start..end aralığına (byte offset) böler */
export function sliceRuns(runs, start, end) {
  const out = [];
  let offset = 0;
  for (const r of runs) {
    const rStart = offset, rEnd = offset + r.text.length;
    if (rEnd <= start || rStart >= end) { offset = rEnd; continue; }
    const a = Math.max(start, rStart), b = Math.min(end, rEnd);
    out.push({ ...r, text: r.text.slice(a - rStart, b - rStart) });
    offset = rEnd;
  }
  return out;
}

const measureRunText = (run, fontSize) => {
  if (run.fk) return measureWidth(run.fk, run.text, fontSize);
  return String(run.text).length * fontSize * 0.52; // yoksayılabilir fallback
};
const sumRuns = (runs, fontSize) => runs.reduce((acc, r) => acc + measureRunText(r, fontSize), 0);

const splitTokens = (text) => String(text).split(/(\s+)/).filter(Boolean);

export function wrapParagraphLine(text, runs, fontSize, maxWidth) {
  if (!String(text).trim()) {
    return [{ text: '', runs: [], width: 0 }];
  }
  const tokens = splitTokens(text);
  const lines = [];
  let offset = 0;
  let curStr = '', curRuns = [], curW = 0;
  for (const tok of tokens) {
    const tokRuns = sliceRuns(runs, offset, offset + tok.length);
    const tokW = sumRuns(tokRuns, fontSize);
    if (curStr && curW + tokW > maxWidth) {
      lines.push({ text: curStr, runs: curRuns, width: curW });
      curStr = tok; curRuns = tokRuns; curW = tokW;
    } else {
      curStr += tok;
      curRuns = mergeRuns(curRuns, tokRuns);
      curW += tokW;
    }
    offset += tok.length;
  }
  if (curStr) lines.push({ text: curStr, runs: curRuns, width: curW });
  return lines;
}

const sameFont = (a, b) => a && b
  && a.fontKey === b.fontKey && a.bold === b.bold && a.italic === b.italic && a.fk === b.fk;

function mergeRuns(a, b) {
  if (!a.length || !b.length) return [...a, ...b];
  const out = a.slice();
  const firstB = b[0];
  if (sameFont(out[out.length - 1], firstB)) {
    const last = { ...out[out.length - 1], text: out[out.length - 1].text + firstB.text };
    out[out.length - 1] = last;
    out.push(...b.slice(1));
    return out;
  }
  out.push(...b);
  return out;
}

/** Bütün metni (birden çok paragraf) satırlar halinde döndürür. */
export function wrapText(text, runs, fontSize, maxWidth) {
  const parts = String(text).split('\n');
  const out = [];
  let offset = 0;
  for (const part of parts) {
    const subRuns = sliceRuns(runs, offset, offset + part.length);
    out.push(...wrapParagraphLine(part, subRuns, fontSize, maxWidth));
    offset += part.length + 1;
  }
  return out;
}

/** SATIR nesnesi oluştur: op.li else bir liste için dolgu olarak `lineHeight` döndürür. */
export function lineHeightFor(fontSize) {
  return Math.max(1, fontSize) * 1.2;
}

/** Satır listesinden dikdörtgen (PDF bbox) hesapla: baseline'lar yapılırken. */
export function rectForLines(baseY, lines, fontSize, padding = 1) {
  const lineHeight = lineHeightFor(fontSize);
  const asc = fontSize * 0.8;
  const bottom = baseY - (lines.length - 1) * lineHeight - fontSize * 0.25 - padding;
  const top = baseY + asc + padding;
  return [bottom, top];
}

/** Karmaşe runs çözümle: fk çözümlü ve fontCss'li dizi; PdfToCss sadece fk gerek. */
export function runsFromLegacy(text, fontCss, bold, italic) {
  return [{
    text: String(text),
    fontKey: null, fontCss, bold: !!bold, italic: !!italic,
    cat: 'sans',
  }];
}
