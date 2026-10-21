// Editor nativo do Pegasus: recorte, pincel, texto, filtros e desfazer.
// GIF sem alteração permanece animado; qualquer edição converte o quadro visível em WEBP estático.
export function setupImageEditor({ onApply, onError }) {
  const el = id => document.getElementById(id);
  const dialog = el('imageEditorDialog');
  const canvas = el('editCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const animated = el('editGifPreview');
  const cropBox = el('editCropBox');
  const info = el('editInfo');
  const gifNotice = el('editGifNotice');
  const history = [];
  let mode = 'draw';
  let isGif = false;
  let modified = false;
  let original = null;
  let sourceImage = null;
  let pointer = null;
  let dataUrl = '';
  let originalName = '';
  let fileSize = 0;

  const imageLoad = src => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não foi possível abrir a imagem.'));
    img.src = src;
  });
  const fileRead = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
  const error = message => onError?.(message);
  function hideCrop() { cropBox.hidden = true; }
  function putImage(image) {
    const ratio = Math.min(1, 1800 / image.naturalWidth, 1800 / image.naturalHeight, Math.sqrt(5_000_000 / (image.naturalWidth * image.naturalHeight)));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  function saveSnapshot() {
    if (isGif) flattenGif();
    history.push(canvas.toDataURL('image/png'));
    if (history.length > 10) history.shift();
  }
  function flattenGif() {
    if (!isGif) return;
    isGif = false;
    modified = true;
    canvas.hidden = false;
    animated.hidden = true;
    gifNotice.textContent = 'O GIF foi convertido em uma imagem estática para permitir a edição.';
    gifNotice.hidden = false;
  }
  function setMode(next) {
    mode = next;
    dialog.querySelectorAll('[data-edit-mode]').forEach(b => b.classList.toggle('active', b.dataset.editMode === next));
    canvas.style.cursor = next === 'crop' ? 'crosshair' : next === 'text' ? 'text' : 'crosshair';
    el('editTextGroup').hidden = next !== 'text';
    el('editBrushGroup').hidden = next !== 'draw';
    hideCrop();
  }
  async function open(file) {
    if (!file || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) return error('Use PNG, JPEG, WEBP ou GIF.');
    const limit = file.type === 'image/gif' ? 4_000_000 : 2_500_000;
    if (file.size <= 0 || file.size > limit) return error(file.type === 'image/gif' ? 'GIFs devem ter até 4 MB.' : 'Imagens devem ter até 2,5 MB.');
    try {
      dataUrl = await fileRead(file);
      const image = await imageLoad(dataUrl);
      sourceImage = image;
      originalName = file.name;
      fileSize = file.size;
      original = dataUrl;
      isGif = file.type === 'image/gif';
      modified = false;
      history.length = 0;
      putImage(image);
      animated.src = dataUrl;
      animated.hidden = !isGif;
      canvas.hidden = isGif;
      gifNotice.hidden = true;
      gifNotice.textContent = '';
      info.textContent = `${file.name} • ${image.naturalWidth} × ${image.naturalHeight}`;
      setMode('draw');
      dialog.showModal();
    } catch (err) { error(err.message); }
  }
  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)) };
  }
  function cropRegion(a, b) {
    const x = Math.round(Math.min(a.x, b.x)); const y = Math.round(Math.min(a.y, b.y));
    const w = Math.round(Math.abs(a.x - b.x)); const h = Math.round(Math.abs(a.y - b.y));
    if (w < 10 || h < 10) return;
    const output = document.createElement('canvas'); output.width = w; output.height = h;
    output.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
    canvas.width = w; canvas.height = h;
    ctx.clearRect(0, 0, w, h); ctx.drawImage(output, 0, 0);
    modified = true;
  }
  function showCropRect(a, b) {
    const rect = canvas.getBoundingClientRect();
    cropBox.hidden = false;
    cropBox.style.left = `${Math.min(a.x, b.x) / canvas.width * rect.width}px`;
    cropBox.style.top = `${Math.min(a.y, b.y) / canvas.height * rect.height}px`;
    cropBox.style.width = `${Math.abs(a.x - b.x) / canvas.width * rect.width}px`;
    cropBox.style.height = `${Math.abs(a.y - b.y) / canvas.height * rect.height}px`;
  }
  function addText(point) {
    const value = el('editTextInput').value.trim();
    if (!value) return error('Escreva o texto no campo antes de clicar na imagem.');
    saveSnapshot();
    ctx.fillStyle = el('editColor').value;
    const px = Math.max(18, Math.round(canvas.width / 35));
    ctx.font = `bold ${px}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 5;
    ctx.fillText(value.slice(0, 100), point.x, point.y, Math.max(10, canvas.width - point.x - 4));
    ctx.shadowBlur = 0;
    modified = true;
  }
  function applyFilter(filter) {
    const styles = { original: 'none', pb: 'grayscale(1)', sepia: 'sepia(.9)', frio: 'saturate(1.25) hue-rotate(12deg) contrast(1.08)', vivo: 'saturate(1.6) contrast(1.15)', sonho: 'saturate(.9) brightness(1.12) contrast(.94)' };
    if (filter === 'original') return;
    saveSnapshot();
    const intermediate = document.createElement('canvas'); intermediate.width = canvas.width; intermediate.height = canvas.height;
    intermediate.getContext('2d').drawImage(canvas, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.filter = styles[filter] || 'none';
    ctx.drawImage(intermediate, 0, 0);
    ctx.filter = 'none'; modified = true;
  }
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const pt = canvasPoint(event);
    if (isGif) flattenGif();
    if (mode === 'text') return addText(pt);
    saveSnapshot();
    pointer = { start: pt, last: pt };
    canvas.setPointerCapture(event.pointerId);
    if (mode === 'draw') {
      ctx.beginPath(); ctx.moveTo(pt.x, pt.y);
      ctx.strokeStyle = el('editColor').value;
      ctx.lineWidth = Number(el('editBrush').value) * Math.max(1, canvas.width / Math.max(280, canvas.clientWidth));
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.lineTo(pt.x + .1, pt.y + .1); ctx.stroke(); modified = true;
    }
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointer) return;
    const point = canvasPoint(event);
    if (mode === 'draw') { ctx.lineTo(point.x, point.y); ctx.stroke(); }
    if (mode === 'crop') showCropRect(pointer.start, point);
    pointer.last = point;
  });
  canvas.addEventListener('pointerup', event => {
    if (!pointer) return;
    if (mode === 'crop') cropRegion(pointer.start, canvasPoint(event));
    pointer = null; hideCrop();
  });
  canvas.addEventListener('pointercancel', () => { pointer = null; hideCrop(); });
  dialog.querySelectorAll('[data-edit-mode]').forEach(button => button.addEventListener('click', () => {
    if (isGif) flattenGif();
    setMode(button.dataset.editMode);
  }));
  dialog.querySelectorAll('[data-image-filter]').forEach(button => button.addEventListener('click', () => applyFilter(button.dataset.imageFilter)));
  el('editUndoButton').addEventListener('click', async () => {
    if (!history.length) return;
    try { const snap = await imageLoad(history.pop()); putImage(snap); modified = true; } catch (err) { error(err.message); }
  });
  el('editResetButton').addEventListener('click', () => {
    putImage(sourceImage);
    history.length = 0;
    isGif = original.startsWith('data:image/gif');
    modified = false;
    animated.hidden = !isGif; canvas.hidden = isGif;
    gifNotice.hidden = true; hideCrop();
  });
  function close() { dialog.close(); pointer = null; hideCrop(); }
  el('editCancelButton').addEventListener('click', close);
  el('editCloseButton').addEventListener('click', close);
  el('editApplyButton').addEventListener('click', async () => {
    try {
      if (!modified) {
        onApply({ dataUrl: original, name: originalName, size: fileSize }); close(); return;
      }
      let scaleCanvas = canvas;
      let result;
      for (let s = 0; s < 5; s++) {
        for (const quality of [.9, .8, .67, .54]) {
          result = scaleCanvas.toDataURL('image/webp', quality);
          const size = Math.ceil((result.split(',')[1]?.length || 0) * .75);
          if (size <= 2_500_000) {
            onApply({ dataUrl: result, name: originalName.replace(/\.[^.]+$/, '') + '-editada.webp', size });
            close(); return;
          }
        }
        const reduced = document.createElement('canvas');
        reduced.width = Math.max(150, Math.round(scaleCanvas.width * .78));
        reduced.height = Math.max(150, Math.round(scaleCanvas.height * .78));
        reduced.getContext('2d').drawImage(scaleCanvas, 0, 0, reduced.width, reduced.height);
        scaleCanvas = reduced;
      }
      error('Não foi possível reduzir a imagem para o limite de envio.');
    } catch (err) { error(err.message); }
  });
  return { open };
}
