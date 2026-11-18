/* pdf.js ile sayfa çizimi, metin kutuları ve görünüm ölçekleri. */

import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { state, dom, emit, clamp, pageKey, toast } from './core.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';
export { pdfjsLib };

function normDeg(d) {
  let r = d % 360;
  if (r < 0) r += 360;
  return Math.round(r);
}

export const view = {
  entry: null,
  pdfPage: null,
  viewport: null,
  scale: 1,
  dpr: 1,
  ctx: null,
  textContent: null,
};

export let textBoxes = [];

const textCache = new Map();
let renderSeq = 0;
let renderTask = null;

export function invalidateTextCache(fileId) {
  for (const k of [...textCache.keys()]) if (k.startsWith(fileId + ':')) textCache.delete(k);
}

export async function getPage(entry) {
  const file = state.files.get(entry.fileId);
  if (!file) throw new Error('Belge bulunamadı');
  return file.pdfDoc.getPage(entry.srcIndex + 1);
}

export async function getTextContent(entry) {
  const key = pageKey(entry);
  if (!textCache.has(key)) {
    textCache.set(key, (async () => {
      const page = await getPage(entry);
      const tc = await page.getTextContent();
      return tc;
    })());
  }
  try { return await textCache.get(key); }
  catch (err) { textCache.delete(key); throw err; }
}

function showEmpty() {
  dom.emptyState.hidden = false;
  dom.scroller.hidden = true;
  dom.pager.hidden = true;
  dom.toolbar.hidden = true;
  dom.textLayer.textContent = '';
  dom.annotLayer.textContent = '';
  dom.editLayer.textContent = '';
  textBoxes = [];
  view.entry = null;
}

export function updateChrome() {
  const n = state.pages.length;
  dom.btnSave.disabled = n === 0;
  dom.toolbar.hidden = n === 0;
  dom.pager.hidden = n === 0;
  dom.docPages.textContent = n ? `${state.index + 1} / ${n} sayfa` : '';
  dom.pageIndicator.textContent = n ? `${state.index + 1} / ${n}` : '—';
  dom.docName.textContent = state.title || 'Belge';
  const openLabel = dom.btnOpen.querySelector('span');
  if (openLabel) openLabel.textContent = n ? 'PDF Ekle' : 'PDF Aç';
  dom.btnOpen.title = n ? 'Açık belgeye sayfa ekle' : 'PDF aç';
  dom.btnPrev.disabled = state.index <= 0;
  dom.btnNext.disabled = state.index >= n - 1;
  dom.btnRotate.disabled = !n;
  dom.btnDeletePage.disabled = !n;
}

export async function renderCurrent() {
  const token = ++renderSeq;
  const entry = state.pages[state.index];
  updateChrome();
  if (!entry) { showEmpty(); return; }

  dom.emptyState.hidden = true;
  dom.scroller.hidden = false;
  dom.pager.hidden = false;
  dom.toolbar.hidden = false;

  if (renderTask) { try { renderTask.cancel(); } catch { /* yoksay */ } renderTask = null; }

  let pdfPage;
  try {
    pdfPage = await getPage(entry);
  } catch (err) {
    console.error(err);
    toast('Sayfa yüklenemedi. Dosya şifreli olabilir.');
    return;
  }
  if (token !== renderSeq) return;

  const totalRotation = (((pdfPage.rotate || 0) + (entry.rotation || 0)) % 360 + 360) % 360;
  const base = pdfPage.getViewport({ scale: 1, rotation: totalRotation });
  const padX = window.innerWidth < 821 ? 16 : 44;
  const availW = Math.max(220, dom.scroller.clientWidth - padX);
  const availH = Math.max(220, dom.scroller.clientHeight - 46);
  const fitW = availW / base.width;
  const fitPage = Math.min(availW / base.width, availH / base.height);
  const fitBase = state.fitMode === 'page' ? fitPage : fitW;
  const scale = clamp(fitBase * state.zoom, 0.08, 7);
  const viewport = pdfPage.getViewport({ scale, rotation: totalRotation });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const cssW = Math.round(viewport.width * 100) / 100;
  const cssH = Math.round(viewport.height * 100) / 100;

  const canvas = dom.canvas;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  dom.pageWrap.style.width = cssW + 'px';
  dom.pageWrap.style.height = cssH + 'px';
  dom.textLayer.style.width = cssW + 'px';
  dom.textLayer.style.height = cssH + 'px';
  dom.annotLayer.setAttribute('viewBox', `0 0 ${cssW} ${cssH}`);
  dom.annotLayer.setAttribute('width', cssW);
  dom.annotLayer.setAttribute('height', cssH);

  const ctx = canvas.getContext('2d', { alpha: false });
  renderTask = pdfPage.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    background: '#ffffff',
  });

  try {
    await renderTask.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    console.error(err);
    toast('Sayfa çizilemedi.');
    return;
  } finally {
    renderTask = null;
  }
  if (token !== renderSeq) return;

  view.entry = entry;
  view.pdfPage = pdfPage;
  view.viewport = viewport;
  view.scale = scale;
  view.dpr = dpr;
  view.ctx = ctx;

  // metin katmanı
  dom.textLayer.textContent = '';
  dom.annotLayer.textContent = '';
  dom.editLayer.textContent = '';
  textBoxes = [];
  let tc = null;
  try { tc = await getTextContent(entry); } catch { tc = null; }
  if (token !== renderSeq) return;
  view.textContent = tc;
  if (tc) {
    textBoxes = buildBoxes(tc, viewport);
    paintTextBoxes(textBoxes);
  }

  dom.zoomLabel.textContent = Math.round(scale * 100) + '%';
  emit('page:rendered', { entry, viewport, pdfPage, scale });
}

function paintTextBoxes(boxes) {
  const frag = document.createDocumentFragment();
  boxes.forEach((b, i) => {
    if (b.empty) return;
    const el = document.createElement('div');
    el.className = 'tb';
    el.dataset.i = String(i);
    el.style.left = b.css[0].toFixed(2) + 'px';
    el.style.top = b.css[1].toFixed(2) + 'px';
    el.style.width = Math.max(2, b.css[2] - b.css[0]).toFixed(2) + 'px';
    el.style.height = Math.max(2, b.css[3] - b.css[1]).toFixed(2) + 'px';
    frag.appendChild(el);
  });
  dom.textLayer.appendChild(frag);
}

function buildBoxes(tc, viewport) {
  const boxes = [];
  for (const item of tc.items) {
    if (!item || typeof item.str !== 'string') continue;
    const t = item.transform;
    if (!t) continue;
    const style = tc.styles[item.fontName] || {};
    const fs = item.height || Math.hypot(t[2], t[3]) || 10;
    const asc = typeof style.ascent === 'number' ? style.ascent : 0.8;
    const desc = typeof style.descent === 'number' ? style.descent : -0.2;
    const x = t[4], y = t[5];
    const w = item.width || 0;
    // metin altyazı uzayında [0,w] x [desc·fs, asc·fs] dikdörtgeni;
    // yön vektörünü transformdan alıp kullanıcı uzayında sınırla
    const fsh = Math.hypot(t[0], t[1]) || fs;
    const dir = [t[0] / fsh, t[1] / fsh];
    const perp = [-dir[1], dir[0]];
    const offA = desc * fs;
    const span = (asc - desc) * fs;
    const bx = x + offA * perp[0], by = y + offA * perp[1];
    const texp = [
      [bx, by],
      [bx + w * dir[0], by + w * dir[1]],
      [bx + w * dir[0] + span * perp[0], by + w * dir[1] + span * perp[1]],
      [bx + span * perp[0], by + span * perp[1]],
    ];
    const txs = texp.map(p => p[0]), tys = texp.map(p => p[1]);
    const x0 = Math.min(...txs), x1 = Math.max(...txs);
    const y0 = Math.min(...tys), y1 = Math.max(...tys);
    const pts = texp.map(([px, py]) => viewport.convertToViewportPoint(px, py));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const box = {
      i: boxes.length,
      str: item.str,
      empty: !item.str.trim(),
      pdf: [x0, y0, x1, y1],
      css: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      baseline: y,
      x: x,
      fontSize: fs,
      width: w,
      fontName: item.fontName,
      style,
      rotated: Math.abs(t[1]) > Math.max(0.001, Math.abs(t[0]) * 0.02),
      angle: normDeg(Math.atan2(t[1], t[0]) * 180 / Math.PI),
    };
    if (box.css[2] - box.css[0] < 0.5 || box.css[3] - box.css[1] < 0.5) box.empty = true;
    boxes.push(box);
  }
  return boxes;
}

export function boxesAt(cssX, cssY) {
  const hits = textBoxes.filter(b => !b.empty && cssX >= b.css[0] - 1 && cssX <= b.css[2] + 1 && cssY >= b.css[1] - 1 && cssY <= b.css[3] + 1);
  hits.sort((a, b) => (a.css[2] - a.css[0]) * (a.css[3] - a.css[1]) - (b.css[2] - b.css[0]) * (b.css[3] - b.css[1]));
  return hits;
}

export function groupLine(box) {
  if (!box) return [];
  const fs = box.fontSize;
  const tol = Math.max(1, fs * 0.45);
  const maxGap = Math.max(2, fs * 0.9);
  const cand = textBoxes.filter(b => {
    if (b.empty || b.rotated) return false;
    if (Math.abs(b.baseline - box.baseline) > tol) return false;
    if (Math.abs(b.fontSize - fs) > Math.max(0.8, fs * 0.16)) return false;
    return true;
  });
  cand.sort((a, b) => a.pdf[0] - b.pdf[0]);
  if (!cand.length) return [box];
  let start = cand.indexOf(box);
  if (start < 0) {
    start = 0;
    for (let i = 1; i < cand.length; i++) {
      if (Math.abs(cand[i].pdf[0] - box.pdf[0]) < Math.abs(cand[start].pdf[0] - box.pdf[0])) start = i;
    }
  }
  const group = [cand[start]];
  for (let i = start + 1; i < cand.length; i++) {
    if (cand[i].pdf[0] - group[group.length - 1].pdf[2] > maxGap) break;
    group.push(cand[i]);
  }
  for (let i = start - 1; i >= 0; i--) {
    if (group[0].pdf[0] - cand[i].pdf[2] > maxGap) break;
    group.unshift(cand[i]);
  }
  return group;
}

export function lineText(boxes) {
  let out = '';
  let prev = null;
  for (const b of boxes) {
    if (prev) {
      const gap = b.pdf[0] - prev.pdf[2];
      if (gap > Math.max(0.6, b.fontSize * 0.2) && !/\s$/.test(out) && !/^\s/.test(b.str)) out += ' ';
    }
    out += b.str;
    prev = b;
  }
  return out;
}

export function groupRect(boxes) {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map(b => b.pdf[0]));
  const x1 = Math.max(...boxes.map(b => b.pdf[2]));
  const y0 = Math.min(...boxes.map(b => b.pdf[1]));
  const y1 = Math.max(...boxes.map(b => b.pdf[3]));
  const fs = Math.max(...boxes.map(b => b.fontSize));
  const padX = Math.max(0.4, fs * 0.06);
  const padY = Math.max(0.4, fs * 0.06);
  return [x0 - padX, y0 - padY, x1 + padX, y1 + padY];
}

/* pdf <-> css */
export function pdfToCss(x, y) { return view.viewport ? view.viewport.convertToViewportPoint(x, y) : [x, y]; }
export function cssToPdf(x, y) { return view.viewport ? view.viewport.convertToPdfPoint(x, y) : [x, y]; }
export function cssRectFromPdf(rect) {
  const [x0, y0, x1, y1] = rect;
  const pts = [pdfToCss(x0, y0), pdfToCss(x1, y0), pdfToCss(x1, y1), pdfToCss(x0, y1)];
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export async function renderThumb(entry, canvas, width = 132) {
  const page = await getPage(entry);
  const totalRotation = (((page.rotate || 0) + (entry.rotation || 0)) % 360 + 360) % 360;
  const base = page.getViewport({ scale: 1, rotation: totalRotation });
  const scale = width / base.width;
  const vp = page.getViewport({ scale, rotation: totalRotation });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(vp.width * dpr));
  canvas.height = Math.max(1, Math.round(vp.height * dpr));
  await page.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    background: '#ffffff',
  }).promise;
}

export function resetView() {
  view.entry = null;
  view.pdfPage = null;
  view.viewport = null;
  view.textContent = null;
  textBoxes = [];
  textCache.clear();
}
