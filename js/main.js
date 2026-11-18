/* Uygulama girişi: dosya açma, araç durumu, kaydetme ve kısayollar. */

import {
  state, dom, toast, uid, clamp, setDirty, loading, openModal, closeModal,
  emit, on, baseName, downloadBlob,
} from './core.js';
import { pdfjsLib, renderCurrent, resetView, updateChrome, textBoxes } from './render.js';
import { initTools, clearSelection } from './tools.js';
import { openTextEditor } from './textedit.js';
import { initTextEdit, drawTextPreviews, hideTextSelection } from './textedit.js';
import { initOrganizer, refreshThumbs, goTo, rotateCurrent, deleteCurrent } from './organizer.js';
import { invalidateFontCache, getPageFonts } from './fonts.js';
import { buildPdf } from './export.js';

let opening = false;

function setTool(tool) {
  state.tool = tool;
  dom.app.dataset.tool = tool;
  document.querySelectorAll('.tool[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  clearSelection();
  hideTextSelection();
  const draw = tool === 'pen' || tool === 'highlight' || tool === 'rect';
  dom.pageWrap.style.touchAction = draw ? 'none' : 'pan-x pan-y';
}

async function openFiles(fileList) {
  const all = [...fileList];
  const files = all.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) { toast('PDF dosyası bulunamadı'); return; }
  if (opening) return;
  opening = true;
  loading(true, files.length > 1 ? `${files.length} PDF açılıyor…` : 'PDF açılıyor…');

  const startIndex = state.pages.length;
  let added = 0;
  for (const f of files) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), verbosity: 0 }).promise;
      const fileId = uid();
      state.files.set(fileId, { id: fileId, name: f.name, bytes, pdfDoc: doc });
      for (let i = 0; i < doc.numPages; i++) {
        state.pages.push({ id: uid(), fileId, srcIndex: i, rotation: 0, annots: [], textOps: [] });
      }
      added += doc.numPages;
      if (!state.title) state.title = baseName(f.name);
    } catch (err) {
      console.error(err);
      const msg = /password/i.test(String(err && err.message)) ? 'şifre korumalı' : 'açılamadı';
      toast(`“${f.name}” ${msg}.`);
    }
  }

  if (!added) {
    opening = false;
    loading(false);
    updateChrome();
    return;
  }

  if (startIndex > 0) setDirty();
  state.index = Math.min(startIndex, state.pages.length - 1);
  opening = false;
  loading(false);
  updateChrome();
  emit('pages:changed');
  await renderCurrent();
  if (files.length > 1) toast(`${added} sayfa eklendi`);
}

function suggestName() {
  const base = state.title ? baseName(state.title) : 'belge';
  return `${base} - düzenlendi.pdf`;
}

function normalizeName(value) {
  let name = String(value || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ');
  if (!name) return suggestName();
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  return name;
}

function openSaveDialog() {
  if (!state.pages.length) return;
  dom.saveName.value = suggestName();
  openModal(dom.modalSave);
  setTimeout(() => {
    if (!window.matchMedia('(min-width: 821px)').matches) return;
    const end = dom.saveName.value.replace(/\.pdf$/i, '').length;
    dom.saveName.setSelectionRange(0, end);
  }, 60);
}

async function save(filename) {
  if (!state.pages.length) return;
  if (opening) return;
  const name = normalizeName(filename);
  loading(true, 'PDF oluşturuluyor…');
  try {
    const { blob } = await buildPdf();
    downloadBlob(blob, name);
    setDirty(false);
    toast('Yeni PDF indirildi: ' + name);
  } catch (err) {
    console.error(err);
    toast('Kaydetme başarısız: ' + (err.message || err));
  } finally {
    loading(false);
  }
}

function wireModals() {
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal');
      if (modal) closeModal(modal);
    });
  });
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('pointerdown', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal')].filter(m => !m.hidden).pop();
    if (open) closeModal(open);
  });
}

function wireUI() {
  // Dosya seçimi: görünmez ama odaklanılabilir file input'u, tetikleyicinin tam üstünü kaplıyor.
  // Böylece dokunma/tıklama doğrudan input'a gider; iOS Safari dahil her tarayıcıda dosya seçici açılır.
  // Safari (macOS) her durumda change/input göndermeyebiliyor; odağı kaybettiğimizde de tara.
  const fileHits = [...document.querySelectorAll('.file-hit')];
  const pickFiles = async (input) => {
    // FileList canlı bir listedir; input.value temizlenince boşalır. Önce diziye kopyala.
    const files = [...input.files];
    if (!files.length) return;
    input.value = ''; // aynı dosya tekrar seçilebilsin
    console.log('[pdfstudio] pick:', files.length, files.map(f => f.name));
    await openFiles(files);
  };
  for (const input of fileHits) {
    input.addEventListener('input', () => pickFiles(input));
    input.addEventListener('change', () => pickFiles(input));
  }
  window.addEventListener('focus', () => {
    for (const input of fileHits) pickFiles(input);
  });

  dom.btnSave.addEventListener('click', openSaveDialog);
  dom.saveApply.addEventListener('click', () => {
    const name = dom.saveName.value;
    closeModal(dom.modalSave);
    save(name);
  });
  dom.saveName.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    dom.saveApply.click();
  });
  dom.btnHelp.addEventListener('click', () => openModal(dom.modalHelp));

  document.querySelectorAll('.tool[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  dom.btnZoomIn.addEventListener('click', () => {
    if (!state.pages.length) return;
    state.zoom = clamp(state.zoom * 1.18, 0.25, 8);
    renderCurrent();
  });
  dom.btnZoomOut.addEventListener('click', () => {
    if (!state.pages.length) return;
    state.zoom = clamp(state.zoom / 1.18, 0.25, 8);
    renderCurrent();
  });
  dom.zoomLabel.addEventListener('click', () => {
    state.zoom = 1;
    state.fitMode = 'page';
    dom.btnFit.textContent = 'Genişliğe sığdır';
    renderCurrent();
  });
  dom.btnNew.addEventListener('click', resetDocument);
  dom.btnFit.addEventListener('click', () => {
    state.fitMode = state.fitMode === 'page' ? 'width' : 'page';
    state.zoom = 1;
    dom.btnFit.textContent = state.fitMode === 'page' ? 'Genişliğe sığdır' : 'Sayfayı sığdır';
    renderCurrent();
  });

  dom.btnRotate.addEventListener('click', () => rotateCurrent());
  dom.btnDeletePage.addEventListener('click', () => {
    if (!state.pages.length) return;
    if (state.pages.length === 1) { toast('Son sayfa silinemez. Yeni PDF açabilirsin.'); return; }
    deleteCurrent();
  });
  dom.btnPrev.addEventListener('click', () => goTo(state.index - 1));
  dom.btnNext.addEventListener('click', () => goTo(state.index + 1));

  dom.btnSidebar.addEventListener('click', () => dom.app.classList.toggle('sidebar-open'));
  dom.stage.addEventListener('pointerdown', (e) => {
    if (window.innerWidth <= 820 && dom.app.classList.contains('sidebar-open') && !dom.sidebar.contains(e.target)) {
      dom.app.classList.remove('sidebar-open');
    }
  }, true);

  on('goto', async () => {
    dom.app.classList.remove('sidebar-open');
    await renderCurrent();
  });
  on('pages:changed', () => {
    if (!state.pages.length) {
      state.title = '';
      updateChrome();
    }
  });

  // sürükle-bırak
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dom.dropZone?.classList.add('drag');
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget) return;
    dom.dropZone?.classList.remove('drag');
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dom.dropZone?.classList.remove('drag');
    if (e.dataTransfer.files?.length) await openFiles(e.dataTransfer.files);
  });

  // klavye
  document.addEventListener('keydown', (e) => {
    const modalOpen = [...document.querySelectorAll('.modal')].some(m => !m.hidden);
    if (modalOpen) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      openSaveDialog();
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      if (state.index < state.pages.length - 1) { e.preventDefault(); goTo(state.index + 1); }
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      if (state.index > 0) { e.preventDefault(); goTo(state.index - 1); }
    }
  });

  // pencere boyutu
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!state.pages.length) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderCurrent(), 180);
  });

  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

function resetDocument() {
  if (!state.pages.length) return;
  if (state.dirty && !window.confirm('Kaydedilmemiş değişiklikler var. Belge kapatılsın mı?')) return;
  for (const f of state.files.values()) {
    try { f.pdfDoc.destroy(); } catch { /* yoksay */ }
  }
  state.files.clear();
  state.pages = [];
  state.index = 0;
  state.title = '';
  state.selectedAnnot = null;
  state.zoom = 1;
  state.fitMode = 'page';
  setDirty(false);
  resetView();
  invalidateFontCache();
  dom.thumbs.textContent = '';
  dom.btnDeleteAnnot.hidden = true;
  dom.btnFit.textContent = 'Genişliğe sığdır';
  setTool('select');
  dom.btnFit.textContent = state.fitMode === 'page' ? 'Genişliğe sığdır' : 'Sayfayı sığdır';
  updateChrome();
  renderCurrent();
}

async function init() {
  initTools();
  initTextEdit();
  initOrganizer();
  wireModals();
  wireUI();
  setTool('select');
  dom.btnFit.textContent = state.fitMode === 'page' ? 'Genişliğe sığdır' : 'Sayfayı sığdır';
  updateChrome();
  renderCurrent();

  // çevrimdışı önbellek (yalnızca güvenli bağlamda çalışır)
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try { await navigator.serviceWorker.register('sw.js'); } catch { /* sessiz */ }
  }

  // hata ayıklama / test kancası
  window.PDFStudio = {
    state, dom, openFiles, save, openSaveDialog, renderCurrent, goTo, setTool, buildPdf,
    texts: () => textBoxes, on, emit, refreshThumbs, getPageFonts, openTextEditor,
  };

  // ?file=... ile doğrudan PDF açma
  const param = new URLSearchParams(location.search).get('file');
  if (param) {
    try {
      const res = await fetch(param);
      const blob = await res.blob();
      const name = decodeURIComponent(param.split('/').pop() || 'belge.pdf');
      await openFiles([new File([blob], name, { type: 'application/pdf' })]);
    } catch (err) {
      console.warn('Dosya açılamadı', err);
    }
  }
}

init();
