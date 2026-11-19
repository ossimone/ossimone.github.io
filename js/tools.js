/* İşaretleme araçları: vurgu, kalem, kutu, not ve silme. */

import {
  state, dom, on, emit, clamp, uid, setDirty, toast, openModal, closeModal,
  currentEntry, hexToRgb, rgbCss,
} from './core.js';
import {
  view, cssToPdf, cssRectFromPdf, pdfToCss, boxesAt,
} from './render.js';
import { openTextEditor, commitInlineEdit, closeInlineEdit, drawTextPreviews } from './textedit.js';
import { getPageFonts, resolveFont, getSysFont } from './fonts.js';
import { wrapText, lineHeightFor } from './textlayout.js';

const COLORS = {
  highlight: [255, 214, 10],
  underline: [0, 0, 255],   /* mavi: altı çiz */
  strike: [128, 0, 128],    /* mor: üstü çiz */
  pen: [223, 45, 55],
  rect: [47, 109, 246],
  note: [242, 183, 5],
};

let drag = null;
let opDrag = null;   // {entry, op, mode: 'move'|'resize', handle, startCss, startPdf, startRect, startX, startY, fonts, readyRuns, baseExtra, moved, pointerId}

function pdfDelta(startCss, currentCss) {
  const a = cssToPdf(startCss.x, startCss.y);
  const b = cssToPdf(currentCss.x, currentCss.y);
  return { x: b[0] - a[0], y: b[1] - a[1] };
}

function fireTextOpChanged() {
  setDirty();
  emit('overlays:changed');
}

export function initTools() {
  on('page:rendered', () => drawOverlays());
  on('overlays:changed', () => drawOverlays());

  const wrap = dom.pageWrap;
  wrap.addEventListener('pointerdown', onDown);
  // document seviyesinde dinle — Safari'de capture hedefi silinirse akış kesilmez
  document.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);

  dom.btnDeleteAnnot.addEventListener('click', () => {
    deleteSelected();
  });

  dom.noteApply.addEventListener('click', commitNote);
  dom.noteColor.addEventListener('input', () => { /* canlı önizleme gerekmiyor */ });

  wrap.addEventListener('dblclick', (e) => {
    const entry = entryReady();
    if (!entry) return;
    if (state.tool !== 'text') return;
    if (state.editTarget) return;
    if (state.editTarget && (e.target === dom.editText || dom.modalText.contains(e.target))) return;
    const p = localPoint(e);
    const pdf = cssToPdf(p.x, p.y);
    const hits = boxesAt(p.x, p.y);
    openTextEditor(hits[0] || null, pdf).then((opened) => {
      if (!opened) toast('Bu noktada düzenlenebilir metin bulunamadı (taranmış sayfa olabilir).');
    });
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedAnnot) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      e.preventDefault();
      deleteSelected();
    }
  });
}

function localPoint(e) {
  const r = dom.pageWrap.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function entryReady() {
  const entry = currentEntry();
  if (!entry || !view.viewport || view.entry !== entry) return null;
  return entry;
}

/* ---------- seçim ---------- */

function selectAnnot(annot) {
  state.selectedAnnot = annot ? annot.id : null;
  dom.btnDeleteAnnot.hidden = !annot;
  drawOverlays();
}

export function deleteSelected() {
  const entry = currentEntry();
  if (!entry || !state.selectedAnnot) return;
  const before = entry.annots.length;
  entry.annots = entry.annots.filter(a => a.id !== state.selectedAnnot);
  if (entry.annots.length !== before) {
    setDirty();
    toast('İşaret silindi');
  }
  selectAnnot(null);
}

/* ---------- çizim ---------- */

function onDown(e) {
  const entry = entryReady();
  if (!entry) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const p = localPoint(e);
  const pdf = cssToPdf(p.x, p.y);
  const tool = state.tool;

  // Metin düzenlemesi açıkken sayfaya tıklama otomatik uygular
  if (state.editTarget && tool !== 'text') {
    const inEditor = e.target === dom.editText || dom.modalText.contains(e.target);
    if (!inEditor) closeInlineEdit();
  }

  if (tool === 'text') {
    // Inline edici textarea veya floating araç içerisindeyse tıklamayı yargı
    const inEditor = state.editTarget && (e.target === dom.editText || dom.modalText.contains(e.target));
    if (inEditor) return;
    // Aşama A: var olan op canlı olarak günceldir — senkron kapat, sürüklemeye async bekleme girmesin
    if (state.editTarget) {
      if (state.editTarget.existingId) {
        closeInlineEdit();
        onTextPointerDown(e, entry, p).catch(err => { console.error(err); });
        return;
      }
      Promise.resolve(commitInlineEdit())
        .then(() => onTextPointerDown(e, entry, p))
        .catch(err => { console.error(err); });
      return;
    }
    onTextPointerDown(e, entry, p).catch(err => { console.error(err); });
    return;
  }

  if (tool === 'select' || tool === 'erase') {
    const hit = hitTest(entry, pdf[0], pdf[1]);
    if (tool === 'erase') {
      if (hit) {
        entry.annots = entry.annots.filter(a => a.id !== hit.id);
        setDirty();
        selectAnnot(null);
      }
      return;
    }
    if (hit) {
      selectAnnot(hit);
      if (hit.type === 'note') openNoteEditor(hit);
    } else {
      selectAnnot(null);
    }
    return;
  }

  if (tool === 'note') {
    state.noteTarget = { mode: 'new', entry, point: pdf };
    openNoteModal();
    return;
  }

  // çizim araçları
  e.preventDefault();
  try { document.documentElement.setPointerCapture(e.pointerId); } catch { /* yoksay */ }
  const color = COLORS[tool] || COLORS.pen;
  drag = {
    tool, entry, startPdf: pdf, lastPdf: pdf, points: [pdf],
    color, temp: null, active: true,
  };
  if (tool === 'highlight' || tool === 'rect') {
    drag.temp = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    drag.temp.setAttribute('fill', tool === 'highlight' ? rgbCss(color, 0.35) : 'none');
    drag.temp.setAttribute('stroke', rgbCss(color, tool === 'highlight' ? 0.5 : 0.95));
    drag.temp.setAttribute('stroke-width', tool === 'highlight' ? '0.8' : '1.6');
    dom.annotLayer.appendChild(drag.temp);
  } else if (tool === 'underline') {
    drag.temp = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    drag.temp.setAttribute('fill', 'none');
    drag.temp.setAttribute('stroke', rgbCss(color));
    drag.temp.setAttribute('stroke-width', '1.2');
    drag.temp.setAttribute('stroke-linecap', 'square');
    dom.annotLayer.appendChild(drag.temp);
  } else if (tool === 'strike') {
    drag.temp = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    drag.temp.setAttribute('fill', 'none');
    drag.temp.setAttribute('stroke', rgbCss(color));
    drag.temp.setAttribute('stroke-width', '1.2');
    drag.temp.setAttribute('stroke-dasharray', '4 2');
    drag.temp.setAttribute('stroke-linecap', 'square');
    dom.annotLayer.appendChild(drag.temp);
  } else if (tool === 'pen') {
    drag.temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    drag.temp.setAttribute('fill', 'none');
    drag.temp.setAttribute('stroke', rgbCss(color));
    drag.temp.setAttribute('stroke-width', String(Math.max(1.4, 2.2)));
    drag.temp.setAttribute('stroke-linecap', 'round');
    drag.temp.setAttribute('stroke-linejoin', 'round');
    dom.annotLayer.appendChild(drag.temp);
  }
  updatePreview(p);
}

/* ---------- metin kutusu taşıma / boyutlandırma ---------- */

/** Aşama C: tutamaç vuru testi DOM yığınından bağımsız, geometrik yapılır. */
function handleCenters(op) {
  const [x0, y0, x1, y1] = cssRectFromPdf(op.rect);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return {
    nw: [x0, y0], n: [mx, y0], ne: [x1, y0],
    e: [x1, my], se: [x1, y1], s: [mx, y1],
    sw: [x0, y1], w: [x0, my],
  };
}
function hitHandle(op, p) {
  if (!op) return null;
  const cs = handleCenters(op);
  const touch = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  let radius = touch ? 22 : 14;
  const [x0, y0, x1, y1] = cssRectFromPdf(op.rect);
  const dc = Math.hypot(p.x - (x0 + x1) / 2, p.y - (y0 + y1) / 2);
  let best = null, bestD = Infinity;
  for (const h in cs) {
    const d = Math.hypot(p.x - cs[h][0], p.y - cs[h][1]);
    if (d < bestD) { bestD = d; best = h; }
  }
  // küçük kutularda merkeze köşeden daha yakın tıklama kutu tıklamasıdır (Aşama C düzeltmesi)
  if (bestD > radius || bestD >= dc) return null;
  return best;
}
function cursorFor(handle) {
  if (handle === 'nw' || handle === 'se') return 'nwse-resize';
  if (handle === 'ne' || handle === 'sw') return 'nesw-resize';
  if (handle === 'n' || handle === 's') return 'ns-resize';
  if (handle === 'e' || handle === 'w') return 'ew-resize';
  return 'move';
}

async function onTextPointerDown(e, entry, p) {
  const pdf = cssToPdf(p.x, p.y);
  const hadSel = !!state.selectedTextOp;
  // Seçili metin op tutamacına tıklandı mı? (Aşama C: geometrik, DOM yığınından bağımsız)
  const selOp = state.selectedTextOp ? entry.textOps.find(o => o.id === state.selectedTextOp) : null;
  const target = e.target;
  const handleEl = target && target.nodeType === 1 ? target.closest('.op-handle') : null;
  const geoHandle = hitHandle(selOp, p);
  if ((handleEl || geoHandle) && selOp) {
    e.preventDefault();
    const handle = geoHandle || (handleEl && handleEl.dataset.handle) || 'se';
    try { document.documentElement.setPointerCapture(e.pointerId); } catch { /* yoksay */ }
    const startY = selOp.y;
    const startRect = selOp.rect.slice();
    opDrag = {
      entry, op: selOp, mode: 'resize', handle,
      startCss: p, startPdf: pdf, startRect, startX: selOp.x, startY,
      moved: false, pointerId: e.pointerId,
      baseExtra: Math.max(0, (startRect[1] - (startY - (selOp.lineCount - 1) * (selOp.lineHeight || lineHeightFor(selOp.fontSize)) - selOp.fontSize * 0.25))),
      padTop: startRect[3] - startY,
      ready: false,
    };
    dom.pageWrap.style.cursor = cursorFor(handle);
    prepOpDrag(opDrag).catch(err => { console.error(err); });
    return;
  }
  // Seçili op içine tıklandı mı? → taşıma oturumu başlat
  if (selOp) {
    const r = cssRectFromPdf(selOp.rect);
    if (p.x >= r[0] && p.x <= r[2] && p.y >= r[1] && p.y <= r[3]) {
      try { document.documentElement.setPointerCapture(e.pointerId); } catch { /* yoksay */ }
      opDrag = {
        entry, op: selOp, mode: 'move', handle: null,
        startCss: p, startPdf: pdf, startRect: selOp.rect.slice(),
        startX: selOp.x, startY: selOp.y,
        moved: false, pointerId: e.pointerId, wasSelected: true,
        padTop: selOp.rect[3] - selOp.y,
        padBottom: Math.max(0, (selOp.rect[1] - (selOp.y - (selOp.lineCount - 1) * (selOp.lineHeight || lineHeightFor(selOp.fontSize)) - selOp.fontSize * 0.25))),
        ready: false,
      };
      prepOpDrag(opDrag).catch(err => { console.error(err); });
      return;
    }
  }
  // Seçili op yok ama op'a mı tıklandı? → yeni seçim başlat (tıklama select eder)
  const opsAt = (entry.textOps || []).filter(o => {
    const r = cssRectFromPdf(o.rect);
    return p.x >= r[0] && p.x <= r[2] && p.y >= r[1] && p.y <= r[3];
  });
  if (opsAt.length) {
    const op = opsAt[opsAt.length - 1];
    state.selectedTextOp = op.id;
    try { document.documentElement.setPointerCapture(e.pointerId); } catch { /* yoksay */ }
    opDrag = {
      entry, op, mode: 'move', handle: null,
      startCss: p, startPdf: pdf, startRect: op.rect.slice(),
      startX: op.x, startY: op.y, moved: false, pointerId: e.pointerId, wasSelected: false,
      padTop: op.rect[3] - op.y,
      padBottom: Math.max(0, (op.rect[1] - (op.y - (op.lineCount - 1) * (op.lineHeight || lineHeightFor(op.fontSize)) - op.fontSize * 0.25))),
      ready: false,
    };
    prepOpDrag(opDrag).catch(err => { console.error(err); });
    emit('overlays:changed');
    return;
  }
  state.selectedTextOp = null;
  drawTextPreviews();
  emit('overlays:changed');
  // Aşama C: seçili op varken ıskalayan tıklama YENİ op oluşturmaz (ikinci op sızıntısı)
  if (hadSel) return;
  const hits = boxesAt(p.x, p.y);
  openTextEditor(hits[0] || null, pdf).then((opened) => {
    if (!opened) toast('Bu noktada düzenlenebilir metin bulunamadı (taranmış sayfa olabilir).');
  });
}

async function prepOpDrag(dragObj) {
  const fonts = await getPageFonts(dragObj.entry);
  dragObj.fonts = fonts;
  const op = dragObj.op;
  // op.runs yok → dolu fontKey üzerinden tek run üret
  if (op.runs && op.runs.length) {
    const resolved = [];
    for (const r of op.runs) {
      if (!r.fontKey) { resolved.push(r); continue; }
      try {
        const rf = await resolveFont(r.fontKey, fonts);
        resolved.push({ ...r, fk: rf && rf.fk });
      } catch {
        resolved.push(r);
      }
    }
    dragObj.readyRuns = resolved;
  } else {
    try {
      const rf = await resolveFont(op.fontKey, fonts);
      dragObj.readyRuns = [{ text: op.text, fontKey: op.fontKey, bold: op.bold, italic: op.italic, cat: rf && rf.cat || 'sans', fontCss: op.fontCss, fk: rf && rf.fk }];
    } catch {
      dragObj.readyRuns = [{ text: op.text, fontKey: op.fontKey, bold: op.bold, italic: op.italic, cat: 'sans', fontCss: op.fontCss, fk: null }];
    }
  }
  dragObj.ready = true;
}

function onOpDragMove(e, entry) {
  if (!opDrag || opDrag.entry !== entry) return;
  const p = localPoint(e);
  const dPxX = p.x - opDrag.startCss.x, dPxY = p.y - opDrag.startCss.y;
  const dist = Math.hypot(dPxX, dPxY);
  if (!opDrag.moved && dist < 4) return;
  if (!opDrag.moved) opDrag.moved = true;
  e.preventDefault();
  const op = opDrag.op;
  const d = pdfDelta(opDrag.startCss, p);

  if (opDrag.mode === 'move') {
    op.x = opDrag.startX + d.x;
    op.y = opDrag.startY + d.y;
    op.rect = [opDrag.startRect[0] + d.x, opDrag.startRect[1] + d.y, opDrag.startRect[2] + d.x, opDrag.startRect[3] + d.y];
    drawTextPreviews();
    emit('overlays:changed');
    return;
  }

  // --- resize ---
  const MIN_W = Math.max(36, op.fontSize);
  const MIN_H = Math.max(18, op.fontSize * 0.9);
  const r0 = opDrag.startRect;
  const handle = opDrag.handle;
  const isW = handle.includes('w'), isE = handle.includes('e');
  const isN = handle.includes('n'), isS = handle.includes('s');
  let [x0, y0, x1, y1] = opDrag.startRect;
 
  if (isW) {
    x0 = Math.min(x1 - MIN_W, r0[0] + d.x);
    const padXLeft = opDrag.startX - r0[0];
    op.x = x0 + padXLeft;
  } else if (isE) {
    x1 = Math.max(x0 + MIN_W, r0[2] + d.x);
  }

  if (isN) {
    y1 = Math.max(y0 + MIN_H, r0[3] + d.y);
    const padTop = opDrag.padTop;
    op.y = y1 - padTop;
  } else if (isS) {
    y0 = Math.min(y1 - MIN_H, r0[1] + d.y);
  }

  if (!isW && !isE && !isN && !isS) {
    x1 = Math.max(x0 + MIN_W, r0[2] + d.x);
    y0 = Math.min(y1 - MIN_H, r0[1] + d.y);
    // kuzey-doğu ses edin
  }

  op.rect = [x0, y0, x1, y1];

  // yeniden satırlara dağılt (koşturma kademeli)
  relayoutOp(opDrag, op, x1 - x0);
  drawTextPreviews();
  emit('overlays:changed');
}

function relayoutOp(opDrag, op, avail) {
  if (!opDrag.ready) return;
  const runs = opDrag.readyRuns;
  const text = op.text;
  const lines = wrapText(text, runs, op.fontSize, Math.max(4, avail));
  op.lines = lines.map(l => ({ ...l, runs: (l.runs || []).map(r => ({ text: r.text, fontKey: r.fontKey, bold: r.bold, italic: r.italic, cat: r.cat, fontCss: r.fontCss })) }));
  op.lineCount = Math.max(1, lines.length);
  op.lineHeight = lineHeightFor(op.fontSize);
  const ascPad = opDrag.padTop;
  const newTop = op.y + ascPad;
  const lineBottom = op.y - (op.lineCount - 1) * op.lineHeight - op.fontSize * 0.25;
  // Aşama D: 's' tutamacıyla alt kenar sürüklenmişse ankraj, sürüklenen kenarı korur
  const sDragged = (opDrag.handle || '').includes('s') && !(opDrag.handle || '').includes('n');
  const padBottom = sDragged
    ? Math.max(0, lineBottom - op.rect[1])
    : Math.max(0, opDrag.baseExtra || opDrag.padBottom || 0);
  op.rect = [op.rect[0], Math.min(lineBottom - padBottom, newTop - op.fontSize * 0.5), op.rect[2], newTop];
}

function onOpDragEnd(e, entry) {
  const dragObj = opDrag;
  opDrag = null;
  dom.pageWrap.style.cursor = '';
  try { document.documentElement.releasePointerCapture?.(e.pointerId); } catch { /* yoksay */ }
  if (!dragObj) return;
  if (dragObj.moved) {
    const r = dragObj.op.rect;
    const pageW = view.viewport ? view.viewport.width / (view.scale || 1) : 595;
    const pageH = view.viewport ? view.viewport.height / (view.scale || 1) : 842;
    if (r[0] < -1 || r[1] < -1 || r[2] > pageW + 1 || r[3] > pageH + 1) {
      toast('Metin kutusu sayfa sınırlarının dışına taşıyor.');
    }
    setDirty();
    drawTextPreviews();
    emit('overlays:changed');
  } else {
    // hareket yoksa: ilk dokunuş seçer (çerçeve + tutamaçlar), seçiliye ikinci dokunuş düzenler
    state.selectedTextOp = dragObj.op.id;
    if (dragObj.wasSelected) {
      setTimeout(() => {
        try {
          const r = dragObj.op.rect;
          openTextEditor(null, [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]).catch(err => { console.error(err); });
        } catch (err) { console.error(err); }
      }, 0);
    } else {
      drawTextPreviews();
      emit('overlays:changed');
    }
  }
}

function onMove(e) {
  const entry0 = entryReady();
  // text-op sürükleme oturumu var mı?
  if (opDrag && entry0 === opDrag.entry) {
    onOpDragMove(e, entry0);
    return;
  }
  if (!drag || !drag.active) return;
  const entry = entryReady();
  if (!entry || entry !== drag.entry) return;
  const p = localPoint(e);
  const pdf = cssToPdf(p.x, p.y);
  drag.lastPdf = pdf;
  if (drag.tool === 'pen') {
    const last = drag.points[drag.points.length - 1];
    const dist = Math.hypot(pdf[0] - last[0], pdf[1] - last[1]);
    if (dist > 0.8) drag.points.push(pdf);
  }
  updatePreview(p);
}

function updatePreview(p) {
  if (!drag?.temp) return;
  if (drag.tool === 'pen') {
    const d = drag.points.map((pt, i) => {
      const [x, y] = pdfToCss(pt[0], pt[1]);
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    drag.temp.setAttribute('d', d);
  } else {
    const [x, y] = pdfToCss(drag.startPdf[0], drag.startPdf[1]);
    const r = { x: Math.min(x, p.x), y: Math.min(y, p.y), w: Math.abs(p.x - x), h: Math.abs(p.y - y) };
    drag.temp.setAttribute('x', r.x); drag.temp.setAttribute('y', r.y);
    drag.temp.setAttribute('width', r.w); drag.temp.setAttribute('height', r.h);
  }
}

function onUp(e) {
  const entry0 = entryReady();
  // text-op sürükleme oturumu varsa önce onu bitir
  if (opDrag && entry0 === opDrag.entry) {
    onOpDragEnd(e, entry0);
    return;
  }
  if (!drag || !drag.active) return;
  const d = drag;
  drag = null;
  try { document.documentElement.releasePointerCapture?.(e.pointerId); } catch { /* yoksay */ }
  d.temp?.remove();
  const entry = d.entry;
  if (!entry) return;

  if (d.tool === 'pen') {
    if (d.points.length < 2) return;
    entry.annots.push({
      id: uid(), type: 'pen', points: d.points.map(pt => [+pt[0].toFixed(2), +pt[1].toFixed(2)]),
      color: d.color, width: 2.2,
    });
    setDirty();
  } else if (d.tool === 'underline') {
    const x0 = Math.min(d.startPdf[0], d.lastPdf[0]);
    const x1 = Math.max(d.startPdf[0], d.lastPdf[0]);
    const y0 = Math.min(d.startPdf[1], d.lastPdf[1]);
    const y1 = Math.max(d.startPdf[1], d.lastPdf[1]);
    if (x1 - x0 < 4 || y1 - y0 < 2) return;
    entry.annots.push({
      id: uid(), type: 'note', rect: [x0, y0, x1, y1], color: d.color, fontSize: 6,
    });
    setDirty();
  } else if (d.tool === 'strike') {
    const x0 = Math.min(d.startPdf[0], d.lastPdf[0]);
    const x1 = Math.max(d.startPdf[0], d.lastPdf[0]);
    const y0 = Math.min(d.startPdf[1], d.lastPdf[1]);
    const y1 = Math.max(d.startPdf[1], d.lastPdf[1]);
    if (x1 - x0 < 4 || y1 - y0 < 2) return;
    entry.annots.push({
      id: uid(), type: 'note', rect: [x0, y0, x1, y1], color: d.color, fontSize: 6,
    });
    setDirty();
  } else {
    const x0 = Math.min(d.startPdf[0], d.lastPdf[0]);
    const x1 = Math.max(d.startPdf[0], d.lastPdf[0]);
    const y0 = Math.min(d.startPdf[1], d.lastPdf[1]);
    const y1 = Math.max(d.startPdf[1], d.lastPdf[1]);
    if (x1 - x0 < 2 || y1 - y0 < 2) return;
    entry.annots.push({
      id: uid(), type: d.tool === 'highlight' ? 'highlight' : 'rect',
      rect: [x0, y0, x1, y1], color: d.color, width: 1.6,
      opacity: d.tool === 'highlight' ? 0.38 : 1,
    });
    setDirty();
  }
  selectAnnot(null);
  drawOverlays();
}

/* ---------- notlar ---------- */

function openNoteModal() {
  dom.noteTitle.textContent = 'Not ekle';
  dom.noteApply.textContent = 'Ekle';
  dom.noteText.value = '';
  dom.noteSize.value = '11';
  dom.noteColor.value = '#f2b705';
  openModal(dom.modalNote);
  setTimeout(() => dom.noteText.focus(), 60);
}

function openNoteEditor(note) {
  state.noteTarget = { mode: 'edit', entry: currentEntry(), annot: note };
  dom.noteTitle.textContent = 'Notu düzenle';
  dom.noteApply.textContent = 'Kaydet';
  dom.noteText.value = note.text || '';
  dom.noteSize.value = String(note.fontSize || 11);
  dom.noteColor.value = rgbToHexLocal(note.color || [242, 183, 5]);
  openModal(dom.modalNote);
}

function rgbToHexLocal(rgb) {
  return '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

function commitNote() {
  const t = state.noteTarget;
  if (!t) { closeModal(dom.modalNote); return; }
  const text = dom.noteText.value.trim();
  if (!text) { closeModal(dom.modalNote); return; }
  const color = hexToRgb(dom.noteColor.value);
  const fontSize = clamp(parseFloat(dom.noteSize.value) || 11, 5, 72);
  const entry = t.entry;
  if (!entry) { closeModal(dom.modalNote); return; }

  if (t.mode === 'edit' && t.annot) {
    t.annot.text = text;
    t.annot.color = color;
    t.annot.fontSize = fontSize;
  } else {
    const pageW = view.viewport ? view.viewport.width / (view.scale || 1) : 600;
    const pageH = view.viewport ? view.viewport.height / (view.scale || 1) : 800;
    const w = Math.min(190, Math.max(90, pageW * 0.3));
    const perLine = Math.max(8, Math.floor((w - 10) / (fontSize * 0.52)));
    const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
    const h = clamp(12 + lines * fontSize * 1.35, 30, Math.min(200, pageH * 0.3));
    let [x, yTop] = t.point;
    x = clamp(x, 2, pageW - w - 2);
    yTop = clamp(yTop, h + 2, pageH - 2);
    entry.annots.push({
      id: uid(), type: 'note', rect: [x, yTop - h, x + w, yTop],
      text, color, fontSize,
    });
  }
  setDirty();
  closeModal(dom.modalNote);
  state.noteTarget = null;
  drawOverlays();
  emit('overlays:changed');
}

/* ---------- çizim / isabet ---------- */

export function drawOverlays() {
  const svg = dom.annotLayer;
  svg.textContent = '';
  dom.noteLayer.textContent = '';
  const entry = state.pages[state.index];
  if (!entry || !view.viewport) return;

  for (const a of entry.annots || []) {
    if (a.type === 'highlight' || a.type === 'rect') {
      const r = cssRectFromPdf(a.rect);
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      el.setAttribute('x', r[0]); el.setAttribute('y', r[1]);
      el.setAttribute('width', Math.max(1, r[2] - r[0]));
      el.setAttribute('height', Math.max(1, r[3] - r[1]));
      if (a.type === 'highlight') {
        el.setAttribute('fill', rgbCss(a.color, a.opacity ?? 0.38));
        el.setAttribute('rx', '1');
        el.style.mixBlendMode = view.dpr ? 'multiply' : 'normal';
      } else {
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', rgbCss(a.color));
        el.setAttribute('stroke-width', String(a.width || 1.6));
      }
      svg.appendChild(el);
    } else if (a.type === 'pen') {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = a.points.map((pt, i) => {
        const [x, y] = pdfToCss(pt[0], pt[1]);
        return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      }).join(' ');
      el.setAttribute('d', d);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', rgbCss(a.color));
      el.setAttribute('stroke-width', String(a.width || 2.2));
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(el);
    } else if (a.type === 'note') {
      const r = cssRectFromPdf(a.rect);
      const box = document.createElement('div');
      box.className = 'note-box';
      box.style.left = r[0] + 'px';
      box.style.top = r[1] + 'px';
      box.style.width = Math.max(12, r[2] - r[0]) + 'px';
      box.style.height = Math.max(10, r[3] - r[1]) + 'px';
      box.style.background = rgbCss(a.color, 0.92);
      box.style.fontSize = Math.max(6, (a.fontSize || 11) * view.scale) + 'px';
      box.textContent = a.text;
      dom.noteLayer.appendChild(box);
    }
    if (state.selectedAnnot === a.id) {
      const r2 = a.type === 'pen' ? bboxOfPointsCss(a.points) : cssRectFromPdf(a.rect);
      const expand = 2;
      const sel = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      sel.setAttribute('x', r2[0] - expand); sel.setAttribute('y', r2[1] - expand);
      sel.setAttribute('width', Math.max(2, r2[2] - r2[0] + expand * 2));
      sel.setAttribute('height', Math.max(2, r2[3] - r2[1] + expand * 2));
      sel.setAttribute('class', 'selected');
      svg.appendChild(sel);
    }
  }
}

function bboxOfPoints(points) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function bboxOfPointsCss(points) {
  const pts = points.map(p => pdfToCss(p[0], p[1]));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitTest(entry, x, y) {
  const tol = 7 / (view.scale || 1);
  const annots = entry.annots || [];
  for (let i = annots.length - 1; i >= 0; i--) {
    const a = annots[i];
    if (a.type === 'highlight' || a.type === 'rect' || a.type === 'note') {
      const r = a.rect;
      if (x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol) return a;
    } else if (a.type === 'pen') {
      for (let j = 1; j < a.points.length; j++) {
        const d = distToSegment(x, y, a.points[j - 1][0], a.points[j - 1][1], a.points[j][0], a.points[j][1]);
        if (d < tol + (a.width || 2) / 2) return a;
      }
    }
  }
  return null;
}

export function clearSelection() { selectAnnot(null); }
