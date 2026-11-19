/* Metin düzenleme: satır seçimi, yazı tipi çözümleme ve önizleme. */

import {
  state, dom, on, emit, clamp, openModal, closeModal, setDirty, toast,
  hexToRgb, rgbCss, uid, currentEntry,
} from './core.js';
import {
  view, cssRectFromPdf, pdfToCss, groupLine, lineText, groupRect,
} from './render.js';
import {
  getPageFonts, resolveFont, fontOptions, fontLabelFor, getSysFont,
  measureWidth, missingChars, SYS_FONTS, categoryOfGeneric, usableFor,
} from './fonts.js';
import { wrapText, lineHeightFor, rectForLines } from './textlayout.js';

export function initTextEdit() {
  on('page:rendered', () => drawTextPreviews());
  // Elle punto girilince: temel puntoyu güncelle, sığdır'ı kapat
  dom.editSize.addEventListener('input', () => {
    const t = state.editTarget;
    if (!t) return;
    const v = parseFloat(dom.editSize.value);
    if (Number.isFinite(v) && v > 0) {
      t.baseFontSize = clamp(v, 2, 400);
      dom.editFit.checked = false;
      updateHint();
    }
  });
  // Genişlik (pt) değişince kutu genişliğini güncelle
  dom.editBoxWidth.addEventListener('input', () => {
    const t = state.editTarget;
    if (!t) return;
    const v = parseFloat(dom.editBoxWidth.value);
    if (Number.isFinite(v) && v >= 10) {
      t.rect[2] = t.rect[0] + v;
      t.rect[0] = t.rect[0]; // x0'ı sabit tut
      updateHint();
      rebuildLiveOp();
    }
  });
  // Sığdır açılıp kapatıldığında hint'i tazele ve canlı op'u yeniden kur
  dom.editFit.addEventListener('change', () => { updateHint(); rebuildLiveOp(); });

  dom.editApply.addEventListener('click', () => applyEdit(false));
  dom.editCoverOnly.addEventListener('click', () => applyEdit(true));
  dom.editRevert.addEventListener('click', revertEdit);
  dom.editFont.addEventListener('change', () => { updateHint(); syncInlineFromSelection(); rebuildLiveOp(); });
  dom.editSize.addEventListener('input', () => { updateHint(); syncInlineFromSelection(); rebuildLiveOp(); });
  dom.editColor.addEventListener('input', () => { syncInlineFromSelection(); rebuildLiveOp(); });
  dom.editText.addEventListener('input', () => { updateHint(); rebuildLiveOp(); });
  // ⋯ menüsü: genişlik / sığdır / sadece kapat / iptal
  const moreBtn = document.getElementById('editMore');
  const morePanel = document.getElementById('teMore');
  if (moreBtn && morePanel) {
    moreBtn.addEventListener('click', () => {
      morePanel.hidden = !morePanel.hidden;
      moreBtn.setAttribute('aria-expanded', String(!morePanel.hidden));
    });
  }
  const cancelBtn = document.getElementById('editCancel');
  if (cancelBtn) cancelBtn.addEventListener('click', cancelInlineEdit);
  // Esc: otomatik uygula (Aşama A canlı güncelleme)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state.editTarget) return;
    e.stopPropagation();
    Promise.resolve(commitInlineEdit()).catch(err => console.error(err));
  }, true);
}

export function cancelInlineEdit() {
  const t = state.editTarget;
  if (!t) return;
  const entry = t.entry;
  entry.textOps = t.snapshotOps ? t.snapshotOps.slice() : [];
  state.editTarget = null;
  if (t.existingId) state.selectedTextOp = null;
  closeFloating();
  drawTextPreviews();
  emit('overlays:changed');
}

export function commitInlineEdit() {
  if (!state.editTarget) return null;
  return applyEdit(false);
}

/** Aşama A: var olan op'u async beklemeden, NESNE KİMLİĞİNİ koruyarak yeniden kurar.
 *  Font önbelleği sıcaksa tamamen senkron çalışır; soğuksa null döner (async yola düşülür). */
function rebuildLiveOp() {
  const t = state.editTarget;
  if (!t || !t.existingId || !t.fontCache) return null;
  const entry = t.entry;
  const op = (entry.textOps || []).find(o => o.id === t.existingId);
  if (!op) return null;
  const text = dom.editText.value;
  const color = hexToRgb(dom.editColor.value);
  const userDir = t.textDir || 0;
  const cache = t.fontCache;
  let runs = null;
  let needsEmbToast = false;
  const useRuns = !text.includes('\n') && t.runsSource && dom.editFont.value === t.defaultKey;
  if (useRuns) {
    const defaultStyle = { fontKey: null, bold: t.want.bold, italic: t.want.italic, cat: t.want.category };
    const built = buildRunsFor(text, t.runsSource, defaultStyle);
    if (built) {
      runs = [];
      for (const st0 of built.runs) {
        let resolved = st0.fontKey ? cache.get(st0.fontKey) : null;
        let key = st0.fontKey;
        if (!resolved) {
          key = sysFallbackFor({ cat: st0.cat, bold: st0.bold, italic: st0.italic });
          resolved = cache.get(key);
        }
        if (!resolved) return null;
        if (resolved.embedded && resolved.fk && missingChars(resolved.fk, st0.text).length) {
          const fb = sysFallbackFor(resolved.embedded);
          const fbRes = cache.get(fb);
          if (!fbRes) return null;
          key = fb; resolved = fbRes; needsEmbToast = true;
        }
        runs.push({ text: st0.text, fontKey: key, bold: !!resolved.bold, italic: !!resolved.italic, cat: resolved.cat || st0.cat, fontCss: resolved.css, fk: resolved.fk });
      }
    }
  }
  if (!runs) {
    let key = dom.editFont.value || t.defaultKey;
    let resolved = cache.get(key);
    if (!resolved) return null;
    if (key.startsWith('emb:') && resolved.fk && missingChars(resolved.fk, text).length) {
      const fb = sysFallbackFor(resolved.embedded || { cat: resolved.cat, bold: resolved.bold, italic: resolved.italic });
      const fbRes = cache.get(fb);
      if (!fbRes) return null;
      key = fb; resolved = fbRes;
    }
    const embEntry = key.startsWith('emb:') ? t.fonts.find(x => x.resName === key.slice(4)) : null;
    const sysMeta = SYS_FONTS[key];
    runs = [{ text, fontKey: key, bold: embEntry ? !!embEntry.bold : !!(sysMeta && sysMeta.bold), italic: embEntry ? !!embEntry.italic : !!(sysMeta && sysMeta.italic), cat: SYS_FONTS[key] && SYS_FONTS[key].cat || 'sans', fontCss: resolved.css, fk: resolved.fk }];
  }
  const fin = layoutTextOp(t, text, color, runs, needsEmbToast);
  op.text = text;
  op.rect = fin.rect;
  op.x = t.baselineX;
  op.y = t.baselineY;
  op.fontSize = fin.fontSize;
  op.lines = fin.lines.map(l => ({ ...l, runs: (l.runs || []).map(r => ({ text: r.text, fontKey: r.fontKey, bold: r.bold, italic: r.italic, cat: r.cat, fontCss: r.fontCss })) }));
  op.lineHeight = fin.lineHeight;
  op.lineCount = fin.lineCount;
  op.color = color;
  op.bg = t.bg;
  op.fontKey = runs[0].fontKey;
  op.fontLabel = fontLabelFor(runs[0].fontKey, t.fonts);
  op.fontCss = runs[0].fontCss;
  op.bold = runs[0].bold;
  op.italic = runs[0].italic;
  op.angle = fin.cssAngle;
  op.textDir = userDir || 0;
  op.cover = true;
  op.baseFontSize = t.baseFontSize;
  op.overflow = fin.overflow;
  op.runs = runs.map(r => ({ text: r.text, fontKey: r.fontKey, bold: r.bold, italic: r.italic, cat: r.cat, fontCss: r.fontCss }));
  setDirty();
  drawTextPreviews();
  emit('overlays:changed');
  return op;
}

/** Aşama A: canlı modelde mevcut op düzenlemesini yalnız kapatır (op zaten günceldir).
 *  Yeni metin (existingId yok) durumunda async commit yoluna düşer. */
export function closeInlineEdit() {
  const t = state.editTarget;
  if (!t) return;
  if (t.existingId) {
    closeFloating();
    state.editTarget = null;
    state.selectedTextOp = null;
    drawTextPreviews();
    emit('overlays:changed');
    return;
  }
  commitInlineEdit();
}

/** inlinedeki textarea'yı güncel font/punto/renge senkronlar */
function syncInlineFromSelection() {
  const t = state.editTarget;
  if (!t) return;
  const sel = dom.editFont.value || t.defaultKey;
  let resolvedCss = 'PDFSans, sans-serif';
  let bold = '400', italic = 'normal', colorRgb = '#000000';
  if (sel) {
    if (sel.startsWith('sys:')) {
      const sys = SYS_FONTS[sel];
      resolvedCss = (sys && sys.css) || 'PDFSans, sans-serif';
      bold = sys && sys.bold ? '700' : '400';
      italic = sys && sys.italic ? 'italic' : 'normal';
    } else if (sel.startsWith('emb:')) {
      const f = t.fonts.find(x => x.resName === sel.slice(4));
      if (f) {
        resolvedCss = f.category === 'serif' ? 'PDFSerif, serif' : f.category === 'mono' ? 'PDFMono, monospace' : 'PDFSans, sans-serif';
        bold = f.bold ? '700' : '400';
        italic = f.italic ? 'italic' : 'normal';
      }
    }
  }
  const colorHex = dom.editColor.value || '#000000';
  const ta = dom.editText;
  if (!ta) return;
  ta.style.color = colorHex;
  ta.style.font = `${Math.round(parseFloat(dom.editSize.value) || t.fontSize)}px ${resolvedCss}`;
  ta.style.fontWeight = bold;
  ta.style.fontStyle = italic;
}

function intersects(a, b) {
  const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return false;
  const areaA = Math.max(0.001, (a[2] - a[0]) * (a[3] - a[1]));
  return (ix * iy) / areaA > 0.35;
}

function availOf(rect, isVert) {
  return Math.max(4, isVert ? (rect[3] - rect[1]) : (rect[2] - rect[0]));
}

function isVertBox(t) {
  const b = t.boxes && t.boxes[0];
  return !!(b && (b.angle === 90 || b.angle === 270));
}

/** O an ölçülen bkz line genişliği ile efektif punto ve taşma bayrağını hesaplar. */
function resolveEffective(t, text, measure) {
  const base = t.baseFontSize;
  const isVert = isVertBox(t);
  const avail = availOf(t.rect, isVert);
  const trimmed = String(text || '').trim();
  if (!trimmed) return { size: base, overflow: false };
  const total0 = measure(base);
  const fit = dom.editFit && dom.editFit.checked;
  const eff = fit ? (total0 > avail ? Math.max(2, (base * avail) / total0) : base) : base;
  const overflow = measure(eff) > avail;
  return { size: eff, overflow };
}

/** Karma runs moduna özgü gömülü/fallback çözümlemesi tekrar kullanılır (apply + preview/hint). */
async function resolveRuns(t, text) {
  if (!t.runsSource) return null;
  const defaultStyle = {
    fontKey: null,
    bold: t.want.bold,
    italic: t.want.italic,
    cat: t.want.category,
  };
  const built = buildRunsFor(text, t.runsSource, defaultStyle);
  if (!built) return null;
  const runs = [];
  let needsEmbToast = false;
  for (const st0 of built.runs) {
    let key, resolved;
    if (st0.fontKey) {
      key = st0.fontKey;
      try {
        resolved = await resolveFont(key, t.fonts);
      } catch (err) {
        console.warn(err);
        key = sysFallbackFor({ cat: st0.cat, bold: st0.bold, italic: st0.italic });
        resolved = await getSysFont(key);
      }
      const emb = resolved.embedded;
      if (emb && emb.fk && missingChars(emb.fk, st0.text).length) {
        const fb = sysFallbackFor(emb);
        if (key !== fb) {
          key = fb;
          resolved = await getSysFont(key);
          needsEmbToast = true;
        }
      }
    } else {
      key = sysFallbackFor({ cat: st0.cat, bold: st0.bold, italic: st0.italic });
      resolved = await getSysFont(key);
    }
    runs.push({
      text: st0.text,
      fontKey: key,
      bold: !!resolved.bold,
      italic: !!resolved.italic,
      cat: resolved.cat || st0.cat,
      fontCss: resolved.css,
      fk: resolved.fk,
    });
  }
  return { runs, needsEmbToast };
}

/** runs ya da tek font ile gerçek ölçüm geri çağrısını verir. */
async function measureCallback(t, text) {
  const isVert = isVertBox(t);
  const availW = availOf(t.rect, isVert);
  const useRuns = t.runsSource && dom.editFont && dom.editFont.value === t.defaultKey;
  if (useRuns) {
    const resolvedRuns = await resolveRuns(t, text);
    if (resolvedRuns) {
      const { runs } = resolvedRuns;
      return (sz) => Math.max(...wrapText(text, runs, sz, availW).map(l => l.width), 0);
    }
  }
  return measureLineWidthSingle(t, text);
}

async function measureLineWidthSingle(t, text) {
  if (!String(text).trim()) return () => 0;
  const isVert = isVertBox(t);
  const availW = availOf(t.rect, isVert);
  const key = (dom.editFont && dom.editFont.value) || t.defaultKey;
  let resolved;
  try { resolved = await resolveFont(key, t.fonts); } catch { resolved = await getSysFont('sys:sans'); }
  const lineRuns = [{ text, fontKey: null, bold: false, italic: false, cat: 'sans', fontCss: '', fk: resolved.fk }];
  return (sz) => Math.max(...wrapText(text, lineRuns, sz, availW).map(l => l.width), 0);
}

async function effectiveFor(t, text) {
  if (!String(text || '').trim()) return { size: t.baseFontSize, overflow: false };
  const measure = await measureCallback(t, text);
  return resolveEffective(t, text, measure);
}

function opAtPoint(entry, px, py) {
  for (const op of entry.textOps || []) {
    const r = op.rect;
    if (px >= r[0] - 1 && px <= r[2] + 1 && py >= r[1] - 1 && py <= r[3] + 1) return op;
  }
  return null;
}

/* ---------- karma yazı tipi (runs) ---------- */

function graphemes(s) {
  try {
    return [...new Intl.Segmenter('tr', { granularity: 'grapheme' }).segment(String(s))].map(x => x.segment);
  } catch {
    return [...String(s)];
  }
}

function lcsIndices(a, b) {
  const n = a.length, m = b.length;
  const dp = new Array((n + 1) * (m + 1)).fill(0);
  const id = (i, j) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[id(i, j)] = a[i - 1] === b[j - 1] ? dp[id(i - 1, j - 1)] + 1 : Math.max(dp[id(i - 1, j)], dp[id(i, j - 1)]);
    }
  }
  const pairs = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (dp[id(i - 1, j)] >= dp[id(i, j - 1)]) i--;
    else j--;
  }
  return pairs.reverse();
}

function buildStyleMap(boxes, fonts) {
  const segOf = graphemes;
  const textParts = [];
  const items = [];
  let clusterIdx = 0;
  let prev = null;
  const wantOf = (box) => {
    const m = usableFor(fonts, box.fontName);
    if (m) return { fontKey: 'emb:' + m.resName, bold: !!m.bold, italic: !!m.italic, cat: m.category };
    const g = String((box.style && box.style.fontFamily) || '');
    return { fontKey: null, bold: /bold|black|heavy|semibold|demi/i.test(g), italic: /italic|oblique/i.test(g), cat: categoryOfGeneric(g) };
  };
  for (const box of boxes) {
    if (prev) {
      const gap = box.pdf[0] - prev.pdf[2];
      if (gap > Math.max(0.6, box.fontSize * 0.2)) { textParts.push(' '); clusterIdx += 1; }
    }
    const st = wantOf(box);
    const segs = segOf(box.str);
    const start = clusterIdx;
    for (const s of segs) { textParts.push(s); clusterIdx += 1; }
    if (segs.length) items.push({ start, end: clusterIdx, ...st });
    prev = box;
  }
  const raw = textParts.join('');
  const segs = segOf(raw);
  let a = 0, b = segs.length;
  while (a < b && /^\s+$/.test(segs[a])) a++;
  while (b > a && /^\s+$/.test(segs[b - 1])) b--;
  const trimmed = segs.slice(a, b).join('');
  const fixed = items
    .map(it => ({ ...it, start: it.start - a, end: Math.min(it.end - a, b - a) }))
    .filter(it => it.end > 0 && it.start < b - a)
    .map(it => ({ ...it, start: Math.max(0, it.start) }));
  return { text: trimmed, items: fixed };
}

/** Yeni metnin eski satırın stillerine eşlendiği runs'ı üretir; okunaksız kalırsa null döner. */
function buildRunsFor(newText, runsSource, defaultStyle) {
  const segOf = graphemes;
  const newSeg = segOf(newText);
  if (!newSeg.length) return null;
  const oldSeg = segOf(runsSource.text);
  const pairs = lcsIndices(oldSeg, newSeg);
  const score = (2 * pairs.length) / ((oldSeg.length || 1) + (newSeg.length || 1));
  if (score < 0.6 || !pairs.length) return null;
  const styleAt = (idx) => {
    for (const it of runsSource.items) if (idx >= it.start && idx < it.end) return it;
    return null;
  };
  const pairNewToOld = new Map(pairs.map(([i, j]) => [j, i]));
  const styleAtNew = new Array(newSeg.length).fill(null);
  let cursor = -1;
  for (let j = 0; j < newSeg.length; j++) {
    if (pairNewToOld.has(j)) cursor = pairNewToOld.get(j);
    if (cursor >= 0) styleAtNew[j] = styleAt(cursor);
    else if (pairs.length) styleAtNew[j] = styleAt(pairs[0][0]);
  }
  const runs = [];
  const idOf = (st) => st ? (st.fontKey ? st.fontKey : 'def:') + '|' + st.bold + '|' + st.italic + '|' + st.cat : 'def|false|false|sans';
  let cur = null;
  for (let j = 0; j < newSeg.length; j++) {
    const st = styleAtNew[j] || defaultStyle;
    const key = idOf(st);
    if (cur && cur.key === key) { cur.text += newSeg[j]; continue; }
    cur = {
      key,
      text: newSeg[j],
      fontKey: st.fontKey || null,
      bold: !!st.bold,
      italic: !!st.italic,
      cat: st.cat || 'sans',
      fontCss: null,
    };
    runs.push(cur);
  }
  return { runs, score };
}

export async function openTextEditor(box, pdfPoint) {
  const entry = currentEntry();
  if (!entry || !view.viewport) return false;

  // Düzenleme sırasında seçim çerçevesi görünmesin
  state.selectedTextOp = null;

  const existing = pdfPoint ? opAtPoint(entry, pdfPoint[0], pdfPoint[1]) : null;
  let boxes = [];
  let rect, text, fontSize, baselineX, baselineY, style = {};

  if (existing) {
    rect = existing.rect.slice();
    text = existing.text || '';
    fontSize = existing.fontSize;
    baselineX = existing.x;
    baselineY = existing.y;
  } else {
    if (!box) return false;
    boxes = groupLine(box);
    if (!boxes.length) boxes = [box];
    rect = groupRect(boxes);
    text = lineText(boxes).replace(/\s+/g, ' ').trim();
    fontSize = Math.max(...boxes.map(b => b.fontSize));
    baselineX = Math.min(...boxes.map(b => (b.x !== undefined ? b.x : b.pdf[0])));
    baselineY = boxes[0].baseline;
    style = box.style || {};
  }

  const fonts = await getPageFonts(entry);
  // Aşama A: canlı düzenleme — tüm font çözümlemeleri bir kez önceden yapılır (senkron rebuild için)
  const fontCache = new Map();
  for (const f of fonts) {
    if (!f.usable) continue;
    try { fontCache.set('emb:' + f.resName, await resolveFont('emb:' + f.resName, fonts)); } catch { /* yoksay */ }
  }
  for (const k of Object.keys(SYS_FONTS)) {
    try { fontCache.set(k, await getSysFont(k)); } catch { /* yoksay */ }
  }
  const generic = (box && box.style && box.style.fontFamily) || '';
  const exact = box ? usableFor(fonts, box.fontName) : null;
  const want = exact && exact.fk ? {
    category: exact.category,
    bold: exact.bold,
    italic: exact.italic,
  } : {
    category: categoryOfGeneric(generic),
    bold: /bold|black|heavy/i.test(generic),
    italic: /italic|oblique/i.test(generic),
  };
  const fallbackKey = sysFallbackFor(want);
  const groupNames = existing
    ? [existing.fontKey.replace('emb:', '')]
    : [...new Set(boxes.map(b => {
        const m = usableFor(fonts, b.fontName);
        return m ? m.resName : null;
      }).filter(Boolean))];
  const pool = fonts.filter(f => groupNames.includes(f.resName));
  let key;
  if (existing) key = existing.fontKey;
  else {
    const covering = bestCovering(pool, text, exact ? 'emb:' + exact.resName : null, want);
    key = covering || (exact && missingChars(exact.fk, text).length === 0 ? 'emb:' + exact.resName : fallbackKey);
  }
  if (!existing && box?.rotated) {
    toast('Döndürülmüş metinlerde yazı tipi eşleşmesi yaklaşık olur.');
  }

  const sel = dom.editFont;
  sel.textContent = '';
  for (const group of fontOptions(fonts)) {
    const og = document.createElement('optgroup');
    og.label = group.group;
    for (const it of group.items) {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  if (![...sel.options].some(o => o.value === key)) {
    const extra = document.createElement('option');
    extra.value = key;
    extra.textContent = key.startsWith('emb:') ? fontLabelFor(key, fonts) : (SYS_FONTS[key]?.label || key);
    sel.appendChild(extra);
  }
  sel.value = key;

  const area = Math.max(1, rect[2] - rect[0]);
  // Temel punto: op'tan base yoksa mevcut fontSize; yeni satır için kutu fontu. Tamreplace hakkı.
  let baseFontSize;
  if (existing) baseFontSize = (existing.baseFontSize != null ? existing.baseFontSize : existing.fontSize);
  else baseFontSize = Math.max(...(boxes.length ? boxes.map(b => b.fontSize) : [fontSize]));

  const sample = existing ? { bg: existing.bg, fg: existing.color } : sampleColors(cssRectFromPdf(rect));
  let runsSource = null;
  if (!existing && boxes.length) runsSource = buildStyleMap(boxes, fonts);

  dom.editText.value = text;
  dom.editText.rows = Math.min(6, Math.max(2, text.split('\n').length));
  dom.editSize.value = Math.round(baseFontSize * 10) / 10;
  dom.editColor.value = existing ? rgbToHexLocal(existing.color) : rgbToHexLocal(sample.fg);
  dom.editBoxWidth.value = Math.round(rect[2] - rect[0]);
  dom.editFit.checked = false;

  state.editTarget = {
    entry, rect, boxes, fontSize: baseFontSize, baselineX, baselineY, fonts,
    bg: sample.bg, area, existingId: existing ? existing.id : null,
    defaultKey: key, want, fallbackKey, runsSource,
    baseFontSize,
    textDir: existing ? (existing.textDir || 0) : (boxes[0] ? boxes[0].angle : 0),
    fontCache,
  };
  dom.editRevert.hidden = !existing;

  // Inline mod sistemi: modal'ı "floating" yap ve textarea'yı on-canvas konumlandır
  // Aşama A: canlı model op'u yerinde günceller → İptal/revert için DERİN kopya gerekir
  const snapshotOps = structuredClone(entry.textOps);
  state.editTarget.snapshotOps = snapshotOps;
  openFloatingEditor(state.editTarget);
  setTimeout(() => { dom.editText.focus(); dom.editText.select(); }, 40);
  return true;
}

function openFloatingEditor(t) {
  // inline editor: textarea'yı canvas üzerinde absolut konumla, modal'ı floating yap
  const viewRot = view.viewport ? view.viewport.rotation : 0;
  const userDir = t.textDir || 0;
  const cssAngle = (viewRot + (360 - (userDir || 0))) % 360;
  const [cx, cy] = pdfToCss(t.baselineX, t.baselineY);
  const sizeCss = t.fontSize * view.scale;
  const scale = view.scale;
  const boxRect = cssRectFromPdf(t.rect);
  const boxWidth = Math.max(40, boxRect[2] - boxRect[0]);
  const boxHeight = Math.max(20, boxRect[3] - boxRect[1]);

  // textarea'ı canvas üstünde konumlandır
  const wrap = dom.inlineEditorWrap;
  const ta = dom.editText;
  if (wrap) wrap.hidden = false;
  ta.classList.add('inline-editor');
  ta.style.left = boxRect[0] + 'px';
  ta.style.top = boxRect[1] + 'px';
  ta.style.transform = `rotate(${cssAngle}deg)`;
  if (cssAngle === 0) {
    ta.style.transformOrigin = '0 0';
  } else {
    ta.style.transformOrigin = '0 0';
  }
  ta.style.width = boxWidth + 'px';
  ta.style.height = (boxHeight + sizeCss * 1.6).toFixed(1) + 'px';
  ta.style.fontSize = `${sizeCss}px`;
  ta.style.lineHeight = `${sizeCss * 1.2}px`;
  ta.style.color = rgbCss(t.bg && Math.max ? [0,0,0] : [0,0,0]);
  // font/bold/italik/renk: seçili fontun css'i (runs için en baskın düzen)
  const selKey = dom.editFont.value || t.defaultKey;
  let resolvedCss = 'PDFSans, sans-serif';
  let bold = '400', italic = 'normal', colorRgb = '#000000';
  if (selKey) {
    // resolveFont sync değil — legacy advance davranışta zaten ilk kez resolve edilmiş sayılır
    if (selKey.startsWith('sys:')) {
      const sys = SYS_FONTS[selKey];
      resolvedCss = sys && sys.css || 'PDFSans, sans-serif';
      bold = sys && sys.bold ? '700' : '400';
      italic = sys && sys.italic ? 'italic' : 'normal';
    } else if (selKey.startsWith('emb:')) {
      const f = t.fonts.find(x => x.resName === selKey.slice(4));
      if (f) { resolvedCss = f.category === 'serif' ? 'PDFSerif, serif' : f.category === 'mono' ? 'PDFMono, monospace' : 'PDFSans, sans-serif'; bold = f.bold ? '700' : '400'; italic = f.italic ? 'italic' : 'normal'; }
    }
  }
  const existingOp = t.entry.textOps.find(x => x.id === t.existingId);
  if (existingOp && existingOp.fontCss) {
    resolvedCss = existingOp.fontCss;
    if (existingOp.bold) bold = '700'; else bold = '400';
    if (existingOp.italic) italic = 'italic'; else italic = 'normal';
    const c = existingOp.color || [0, 0, 0];
    colorRgb = '#' + c.map(v => clamp(v, 0, 255).toString(16).padStart(2, '0')).join('');
  }
  ta.style.font = `${sizeCss}px ${resolvedCss}`;
  ta.style.fontWeight = bold;
  ta.style.fontStyle = italic;
  ta.style.color = colorRgb;
  ta.value = dom.editText.value;

  // floating modal'ı op'un altına (ya da üstüne) yerleştir
  const card = dom.modalText.querySelector('.modal-card');
  const morePanel = document.getElementById('teMore');
  const moreBtn = document.getElementById('editMore');
  if (morePanel) morePanel.hidden = true;
  if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
  dom.modalText.classList.add('floating');
  dom.modalText.hidden = false;
  // okunabilir boyut ayarla — tahmini card yüksekliği
  const cardH = card.offsetHeight || 260;
  const cardW = card.offsetWidth || 380;
  const wrapW = view.viewport ? Math.round(view.viewport.width) : 600;
  // CSS koordinatları pageWrap'e göre
  let left = boxRect[0] - 2;
  let top = boxRect[3] + 10;
  // sağ/tarafta taşarsa kaydır
  if (left + cardW > wrapW - 4) left = Math.max(4, wrapW - cardW - 6);
  if (left < 4) left = 4;
  dom.modalText.style.left = left + 'px';
  if (top + cardH > (dom.pageWrap.offsetHeight || 600)) {
    top = Math.max(4, boxRect[1] - cardH - 10);
  }
  dom.modalText.style.top = top + 'px';
  dom.pageWrap.appendChild(dom.modalText); // en üst z için

  state.editTarget = { ...t, isInline: true };
}

function closeFloating(commit) {
  const t = state.editTarget;
  const morePanel = document.getElementById('teMore');
  const moreBtn = document.getElementById('editMore');
  if (morePanel) morePanel.hidden = true;
  if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
  dom.modalText.hidden = true;
  dom.modalText.classList.remove('floating');
  dom.modalText.removeAttribute('style');
  dom.inlineEditorWrap.hidden = true;
  dom.editText.classList.remove('inline-editor');
}

function rgbToHexLocal(rgb) {
  return '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

async function updateHint() {
  const t = state.editTarget;
  if (!t) return;
  const key = dom.editFont.value;
  let hint = '';
  if (key.startsWith('emb:')) {
    const f = t.fonts.find(x => x.resName === key.slice(4));
    if (f) {
      hint = `Gömülü yazı tipi kullanılıyor: ${f.family}.`;
      const missing = missingChars(f.fk, dom.editText.value);
      if (missing.length) {
        const fb = SYS_FONTS[sysFallbackFor(f)];
        hint += ` Bu alt kümede şu karakterler yok: ${missing.slice(0, 14).map(c => `“${c}”`).join(', ')}${missing.length > 14 ? '…' : ''}. Uygulanınca ${fb ? fb.label : 'yakın bir yazı tipi'} kullanılacak.`;
      }
      if (f.glyphCount && f.glyphCount < 80) hint += ' (Alt küme küçük olduğu için yeni harfler desteklenmeyebilir.)';
    }
  } else {
    const sys = SYS_FONTS[key];
    hint = sys ? `${sys.label} kullanılacak. Özgün yazı tipi gömülü olmadığı için biçim yaklaşık olur.` : '';
  }
  if (dom.editText.value.includes('\n')) {
    hint += ' Çok satırlı metin alt satırdaki yazılarla çakışabilir.';
  }
  if (t.runsSource && dom.editFont.value === t.defaultKey) {
    hint += (hint ? ' ' : '') + 'Satırın karma biçimi (kalın/normal/italik) korunur.';
  }
  // taşma + etkin punto: runs	single font ile tutarlı, live hesaplanır
  let overflow = false;
  try {
    if (String(dom.editText.value).trim()) {
      const eff = await effectiveFor(t, dom.editText.value);
      overflow = !!eff.overflow;
      // editSize alanını etkin puntoyla senkronla (kullanıcının yazdığı özel puntoyu bozmıyoruz)
      const shown = parseFloat(dom.editSize.value);
      const rounded = Math.round(eff.size * 10) / 10;
      if (!Number.isFinite(shown) || Math.abs(shown - rounded) > 1e-6) {
        dom.editSize.value = String(rounded);
      }
    }
  } catch { overflow = false; }
  if (overflow) {
    hint += (hint ? ' ' : '') + '⚠ Satır kutuya sığmıyor.';
  }
  dom.editHint.textContent = hint;
  dom.editHint.classList.toggle('hint-overflow', overflow);
  if (dom.editSize) dom.editSize.classList.toggle('te-overflow', overflow);
}

function revertEdit() {
  const t = state.editTarget;
  if (!t || !t.existingId) return;
  const entry = t.entry;
  entry.textOps = (entry.textOps || []).filter(o => o.id !== t.existingId);
  setDirty();
  closeFloating();
  state.editTarget = null;
  if (state.selectedTextOp === t.existingId) state.selectedTextOp = null;
  drawTextPreviews();
  toast('Düzenleme geri alındı');
}

async function applyEdit(coverOnly) {
  const t = state.editTarget;
  if (!t) return;
  // Aşama A: var olan op canlı yolda zaten güncel — önbellek sıcaksa yalnız kapat
  if (t.existingId && !coverOnly && t.fontCache) {
    const op = rebuildLiveOp();
    if (op) {
      closeFloating();
      state.editTarget = null;
      state.selectedTextOp = null;
      drawTextPreviews();
      emit('overlays:changed');
      return;
    }
  }
  const useRuns = !coverOnly && t.runsSource
    && dom.editFont.value === t.defaultKey
    && !dom.editText.value.includes('\n');
  if (useRuns) return applyEditRuns(false);
  return applyEditLegacy(coverOnly);
}


async function applyEditRuns() {
  const t = state.editTarget;
  const entry = t.entry;
  const text = dom.editText.value;
  const color = hexToRgb(dom.editColor.value);
  const userDir = t.textDir || 0;

  const defaultStyle = {
    fontKey: null,
    bold: t.want.bold,
    italic: t.want.italic,
    cat: t.want.category,
  };
  const built = buildRunsFor(text, t.runsSource, defaultStyle);
  if (!built) return applyEditLegacy(false);
  const resolvedRuns = await resolveRuns(t, text);
  if (!resolvedRuns) return applyEditLegacy(false);
  const { runs, needsEmbToast } = resolvedRuns;
  if (needsEmbToast) toast('Gömülü alt kümede eksik karakterler vardı, yakın yazı tipi kullanıldı.');

  const fin = layoutTextOp(t, text, color, runs, needsEmbToast);
  const op = {
    id: t.existingId || uid(),
    type: 'text',
    rect: fin.rect,
    x: t.baselineX,
    y: t.baselineY,
    fontSize: fin.fontSize,
    text,
    lines: fin.lines,
    lineHeight: fin.lineHeight,
    lineCount: fin.lineCount,
    color,
    bg: t.bg,
    fontKey: runs[0].fontKey,
    fontLabel: fontLabelFor(runs[0].fontKey, t.fonts),
    fontCss: runs[0].fontCss,
    bold: runs[0].bold,
    italic: runs[0].italic,
    angle: fin.cssAngle,
    textDir: userDir || 0,
    cover: true,
    baseFontSize: t.baseFontSize,
    overflow: fin.overflow,
    // lines ve runs içindeki fk (fontkit nesnesi) saklamaya girmemeli
    lines: fin.lines.map(l => ({ ...l, runs: (l.runs || []).map(r => ({ text: r.text, fontKey: r.fontKey, bold: r.bold, italic: r.italic, cat: r.cat, fontCss: r.fontCss })) })),
    runs: runs.map(r => ({ text: r.text, fontKey: r.fontKey, bold: r.bold, italic: r.italic, cat: r.cat, fontCss: r.fontCss })),
  };

  entry.textOps = (entry.textOps || []).filter(o => o.id !== t.existingId && !intersects(o.rect, op.rect));
  entry.textOps.push(op);
  setDirty();
  closeFloating();
  state.editTarget = null;
  state.selectedTextOp = null;
  drawTextPreviews();
  emit('overlays:changed');
}


async function applyEditLegacy(coverOnly) {
  const t = state.editTarget;
  if (!t) return;
  const entry = t.entry;
  const text = coverOnly ? '' : dom.editText.value;
  const color = hexToRgb(dom.editColor.value);
  let key = dom.editFont.value;

  let resolved;
  try {
    resolved = await resolveFont(key, t.fonts);
  } catch (err) {
    console.warn(err);
    resolved = await getSysFont('sys:sans');
    key = 'sys:sans';
  }

  // gömülü alt küme yeni karakterleri içermiyorsa yakın yazı tipine geç
  if (!coverOnly && key.startsWith('emb:')) {
    const emb = resolved.embedded;
    if (emb && emb.fk && missingChars(emb.fk, text).length) {
      key = sysFallbackFor(emb);
      resolved = await getSysFont(key);
      toast('Gömülü alt kümede eksik karakterler vardı, yakın yazı tipi kullanıldı.');
    }
  }

  const embEntry = key.startsWith('emb:') ? t.fonts.find(x => x.resName === key.slice(4)) : null;
  const sysMeta = SYS_FONTS[key];
  const userDir = t.textDir || 0;
  const runs = coverOnly ? [] : [{ text, fontKey: key, bold: embEntry ? !!embEntry.bold : !!(sysMeta && sysMeta.bold), italic: embEntry ? !!embEntry.italic : !!(sysMeta && sysMeta.italic), cat: SYS_FONTS[key] && SYS_FONTS[key].cat || 'sans', fontCss: resolved.css, fk: resolved.fk }];
  const fin = layoutTextOp(t, text, color, runs, false);
  const op = {
    id: t.existingId || uid(),
    type: 'text',
    rect: fin.rect,
    x: t.baselineX,
    y: t.baselineY,
    fontSize: fin.fontSize,
    text: coverOnly ? '' : text,
    lines: coverOnly ? [{ text: '', runs: [], width: 0 }] : fin.lines.map(l => ({ ...l, runs: (l.runs || []).map(r => ({ text: r.text, fontKey: r.fontKey, bold: r.bold, italic: r.italic, cat: r.cat, fontCss: r.fontCss })) })),
    lineHeight: fin.lineHeight,
    lineCount: fin.lineCount,
    color,
    bg: t.bg,
    fontKey: key,
    fontLabel: fontLabelFor(key, t.fonts),
    fontCss: resolved.css,
    bold: embEntry ? !!embEntry.bold : !!(sysMeta && sysMeta.bold),
    italic: embEntry ? !!embEntry.italic : !!(sysMeta && sysMeta.italic),
    angle: fin.cssAngle,
    textDir: userDir || 0,
    cover: true,
    baseFontSize: t.baseFontSize,
    overflow: fin.overflow,
  };

  entry.textOps = (entry.textOps || []).filter(o => o.id !== t.existingId && !intersects(o.rect, op.rect));
  entry.textOps.push(op);
  setDirty();
  closeFloating();
  state.editTarget = null;
  state.selectedTextOp = null;
  drawTextPreviews();
  emit('overlays:changed');
}

/** sığdır etkin puntoyu döndür; runs'u sığsın diye ikili arama ile küçültür (lineWidth bazında). */
function binaryFitShrink(runs, text, fontSize, availWidth) {
  const fits = (fs) => {
    if (fs <= 2) return true;
    const lines = wrapText(text, runs || [], fs, availWidth);
    return lines.every(l => l.width <= availWidth + 0.5);
  };
  if (!dom.editFit || !dom.editFit.checked) return fontSize;
  if (fits(fontSize) || fontSize <= 2) return fontSize;
  let lo = 2, hi = fontSize;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return Math.max(2, lo);
}

function availableWidth(t) {
  return isVertBox(t) ? (t.rect[3] - t.rect[1]) : (t.rect[2] - t.rect[0]);
}

/** Tüm düzenlemelerin ortak fin: wrap, paşta rectangle, op nesnesi. */
function layoutTextOp(t, text, color, runs, needsEmbToast) {
  const viewRot = view.viewport ? view.viewport.rotation : 0;
  const userDir = t.textDir || 0;
  const cssAngle = (viewRot + (360 - (userDir || 0))) % 360;
  const availW = Math.max(4, availableWidth(t));
  const fontSize = binaryFitShrink(runs, text, t.baseFontSize, availW);
  const lineHeight = lineHeightFor(fontSize);
  const lines = wrapText(text, runs || [], fontSize, availW);
  const lineCount = Math.max(1, lines.length);
  const newBottom = t.baselineY - (lineCount - 1) * lineHeight - fontSize * 0.25;
  const rect = [t.rect[0], Math.min(t.rect[1], newBottom), t.rect[2], t.rect[3]];
  // sayfanın altında mı?
  let pageOver = false;
  try {
    if (view.pdfPage && view.pdfPage.view) {
      const pageBottom = view.pdfPage.view[1];
      if (newBottom < pageBottom - 1) pageOver = true;
    }
  } catch { /* yoksay */ }
  const lineOver = lines.some(l => l.width > availW + 0.5);
  const overflow = lineOver || pageOver;
  return { cssAngle, fontSize, lineHeight, lines, lineCount, rect, overflow };
}

export function sysFallbackFor(font) {
  const cat = (font && font.category) || 'sans';
  const bold = !!(font && font.bold);
  const italic = !!(font && font.italic);
  if (cat === 'serif') return bold ? 'sys:serif-bold' : italic ? 'sys:serif-italic' : 'sys:serif';
  if (cat === 'mono') return bold ? 'sys:mono-bold' : 'sys:mono';
  return bold ? 'sys:sans-bold' : italic ? 'sys:sans-italic' : 'sys:sans';
}

function bestCovering(fonts, text, preferredKey, want = {}) {
  const usable = fonts.filter(f => f.usable);
  if (!usable.length) return null;
  const pref = preferredKey ? usable.find(f => 'emb:' + f.resName === preferredKey) : null;
  const cat = (pref && pref.category) || want.category || 'sans';
  const bold = pref ? pref.bold : !!want.bold;
  let best = null, bestScore = -1;
  for (const f of usable) {
    if (missingChars(f.fk, text).length) continue;
    let score = 10;
    if (f.category === cat) score += 4;
    if (f.bold === bold) score += 2;
    score += Math.min(2, f.glyphCount / 2000);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return best ? 'emb:' + best.resName : null;
}

/* ---------- önizleme ---------- */

export function drawTextPreviews() {
  const entry = state.pages[state.index];
  const layer = dom.editLayer;
  layer.textContent = '';
  if (!entry || !view.viewport || !menuVisible()) return;
  const scale = view.scale;
  for (const op of entry.textOps || []) {
    const r = cssRectFromPdf(op.rect);
    const cover = document.createElement('div');
    cover.className = 'cover';
    cover.style.left = r[0] + 'px';
    cover.style.top = r[1] + 'px';
    cover.style.width = Math.max(1, r[2] - r[0]) + 'px';
    cover.style.height = Math.max(1, r[3] - r[1]) + 'px';
    cover.style.background = rgbCss(op.bg);
    layer.appendChild(cover);
  }
  const vpRot = view.viewport ? view.viewport.rotation : 0;
  const skipId = state.editTarget && state.editTarget.existingId;
  for (const op of entry.textOps || []) {
    if (!op.text) continue;
    if (op.id === skipId) continue; // editShelf altındakini gösterme — inline textarea görür
    const [cx, cy] = pdfToCss(op.x, op.y);
    const sizeCss = op.fontSize * scale;
    const lineHeight = (op.lineHeight || lineHeightFor(op.fontSize)) * scale;
    const cssAngle = op.textDir != null ? (vpRot + (360 - op.textDir)) % 360 : (op.angle || 0);
    // layoutTextop lines varsa onu kullan; yoksa eskisplit
    if (Array.isArray(op.lines) && op.lines.length) {
      op.lines.forEach((line, i) => {
        if (!line.text && !Array.isArray(line.runs)) return;
        const el = document.createElement('div');
        el.className = 't';
        el.style.left = cx + 'px';
        el.style.top = cy + 'px';
        el.style.color = rgbCss(op.color);
        el.style.transformOrigin = '0 0';
        if (op.overflow) el.classList.add('t-overflow');
        const dy = i * lineHeight - 0.82 * sizeCss;
        el.style.transform = `rotate(${cssAngle}deg) translateY(${dy}px)`;
        if (Array.isArray(op.runs) && op.runs.length > 1 && Array.isArray(line.runs)) {
          line.runs.forEach((run) => {
            const span = document.createElement('span');
            span.textContent = run.text;
            span.style.font = `${sizeCss}px ${run.fontCss || 'PDFSans, sans-serif'}`;
            span.style.fontWeight = run.bold ? '700' : '400';
            span.style.fontStyle = run.italic ? 'italic' : 'normal';
            span.style.display = 'inline-block';
            span.style.whiteSpace = 'pre';
            el.appendChild(span);
          });
        } else {
          el.textContent = line.text;
          el.style.font = `${sizeCss}px ${op.fontCss || 'PDFSans, sans-serif'}`;
          el.style.fontWeight = op.bold ? '700' : '400';
          el.style.fontStyle = op.italic ? 'italic' : 'normal';
        }
        layer.appendChild(el);
      });
      continue;
    }
    const lines = String(op.text).split('\n');
    lines.forEach((line, i) => {
      if (!line) return;
      const el = document.createElement('div');
      el.className = 't';
      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
      el.style.color = rgbCss(op.color);
      el.style.transformOrigin = '0 0';
      if (op.overflow) el.classList.add('t-overflow');
      const dy = i * (lineHeightFor(op.fontSize) * scale);
      el.style.transform = `rotate(${cssAngle}deg) translateY(${dy}px)`;
      if (Array.isArray(op.runs) && op.runs.length && op.runs.length > 1) {
        let lineStart = 0;
        for (let k = 0; k < i; k++) lineStart += lines[k].length + 1;
        const end = lineStart + line.length;
        let cursor = lineStart;
        for (const run of op.runs) {
          const runStart = cursor, runEnd = Math.min(cursor + run.text.length, end);
          const piece = line.slice(Math.max(0, runStart - lineStart), Math.max(0, runEnd - lineStart));
          cursor += run.text.length;
          if (!piece) continue;
          const span = document.createElement('span');
          span.textContent = piece;
          span.style.font = `${sizeCss}px ${run.fontCss || 'PDFSans, sans-serif'}`;
          span.style.fontWeight = run.bold ? '700' : '400';
          span.style.fontStyle = run.italic ? 'italic' : 'normal';
          span.style.display = 'inline-block';
          span.style.whiteSpace = 'pre';
          el.appendChild(span);
        }
      } else {
        el.textContent = line;
        el.style.font = `${sizeCss}px ${op.fontCss || 'PDFSans, sans-serif'}`;
        el.style.fontWeight = op.bold ? '700' : '400';
        el.style.fontStyle = op.italic ? 'italic' : 'normal';
      }
      layer.appendChild(el);
    });
  }
  // Seçili metin kutusu + tutamaçları (yalnızca metin aracı)
  drawSelection(entry);
}

/* Aşama B: kalıcı seçim katmanı — seçim kutusu ve 8 tutamaç bir kez oluşturulur,
   sonrasında yalnızca style güncellenir. Sürükleme sırasında pointer hedefi
   asla DOM'dan silinmez (Safari pointer capture kuralı için kritik). */
let selBox = null;
let selHandles = null;
let selOwner = null;

function hideSelection() {
  if (selBox) { selBox.remove(); selBox = null; }
  if (selHandles) { for (const h in selHandles) selHandles[h].remove(); selHandles = null; }
  selOwner = null;
}

/** Aşama B: araç değişiminde kalıcı seçimi gizlemek için dışa açılan kancak */
export function hideTextSelection() { hideSelection(); }

function drawSelection(entry) {
  if (state.tool !== 'text') { hideSelection(); return; }
  const id = state.selectedTextOp;
  const op = id ? (entry.textOps || []).find(o => o.id === id) : null;
  if (!op) { state.selectedTextOp = null; hideSelection(); return; }
  const layer = dom.selLayer;
  if (!layer) return;
  // bir kez kur (op değişirse yeniden kur)
  if (!selBox || !selBox.isConnected || selOwner !== op.id) {
    hideSelection();
    selBox = document.createElement('div');
    selBox.className = 'op-selection';
    layer.appendChild(selBox);
    selHandles = {};
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const el = document.createElement('div');
      el.className = 'op-handle op-handle-' + h;
      el.dataset.handle = h;
      layer.appendChild(el);
      selHandles[h] = el;
    }
    selOwner = op.id;
  }
  // yerinde güncelle
  const [x0, y0, x1, y1] = cssRectFromPdf(op.rect);
  selBox.style.left = x0 + 'px';
  selBox.style.top = y0 + 'px';
  selBox.style.width = Math.max(1, x1 - x0) + 'px';
  selBox.style.height = Math.max(1, y1 - y0) + 'px';
  for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const el = selHandles[h];
    const hw = h.includes('w') ? x0 : h.includes('e') ? x1 : (x0 + x1) / 2;
    const hh = h.includes('n') ? y0 : h.includes('s') ? y1 : (y0 + y1) / 2;
    el.style.left = (hw - SNAP / 2) + 'px';
    el.style.top = (hh - SNAP / 2) + 'px';
  }
}

const SNAP = 12;

function menuVisible() { return !!view.viewport; }

/* ---------- renk örnekleme ---------- */

function sampleColors(cssRect) {
  const ctx = view.ctx;
  const dpr = view.dpr || 1;
  const fallback = { bg: [255, 255, 255], fg: [0, 0, 0] };
  if (!ctx || !cssRect) return fallback;
  const pad = 2;
  let x0 = Math.floor(cssRect[0] * dpr) - pad;
  let y0 = Math.floor(cssRect[1] * dpr) - pad;
  let x1 = Math.ceil(cssRect[2] * dpr) + pad;
  let y1 = Math.ceil(cssRect[3] * dpr) + pad;
  x0 = clamp(x0, 0, ctx.canvas.width - 1); x1 = clamp(x1, 1, ctx.canvas.width);
  y0 = clamp(y0, 0, ctx.canvas.height - 1); y1 = clamp(y1, 1, ctx.canvas.height);
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return fallback;

  let data;
  try { data = ctx.getImageData(x0, y0, w, h).data; }
  catch { return fallback; }

  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 12000)));
  const hist = new Map();
  let bg = [255, 255, 255], bgCount = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const cur = hist.get(key) || [0, 0, 0, 0];
      cur[0] += r; cur[1] += g; cur[2] += b; cur[3]++;
      hist.set(key, cur);
    }
  }
  for (const v of hist.values()) {
    if (v[3] > bgCount) { bgCount = v[3]; bg = [v[0] / v[3], v[1] / v[3], v[2] / v[3]]; }
  }

  // metin rengi: arka plandan belirgin şekilde farklı, koyu ve yeterince sık görülen ton
  const bgLum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
  let total = 0;
  for (const v of hist.values()) total += v[3];
  const minCount = Math.max(2, Math.round(total * 0.0015));
  let fg = null, fgScore = 0;
  for (const v of hist.values()) {
    if (v[3] < minCount) continue;
    const c = [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
    const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const dist = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
    if (dist < 100) continue;
    const contrast = Math.abs(lum - bgLum);
    const score = v[3] * (0.2 + (contrast / 255) * 4.5) * (lum < bgLum ? 1.5 : 1);
    if (score > fgScore) { fgScore = score; fg = c; }
  }
  if (!fg) fg = bgLum > 128 ? [0, 0, 0] : [255, 255, 255];
  return { bg: bg.map(Math.round), fg: fg.map(Math.round) };
}

export function resetEditsForPage(entry) {
  if (!entry) return;
  entry.textOps = [];
  state.selectedTextOp = null;
}
