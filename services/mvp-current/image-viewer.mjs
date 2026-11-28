const paths = new Map([['/catalog/preview','/catalog/image'], ['/gallery/preview','/gallery/image']]);
const rawPaths = new Set(paths.values());
const scope = 'dialog[data-image-viewer-dialog]';

const backStyle = `
  [data-image-preview] [data-viewer-back], ${scope} [data-viewer-back] { position: absolute; z-index: 1;
    top: 8px; left: 8px;
    top: max(8px, env(safe-area-inset-top)); left: max(8px, env(safe-area-inset-left));
    box-sizing: border-box; display: inline-grid; place-items: center; min-width: 44px; min-height: 44px;
    margin: 0; padding: 0 11px; border: 1px solid #767676; border-radius: 22px;
    background: rgba(18,18,18,.88); color: #fff; font: 16px/1.15 system-ui; text-decoration: none; }
  [data-image-preview] [data-viewer-back]:focus-visible, ${scope} [data-viewer-back]:focus-visible { outline: 2px solid #f4d66f; outline-offset: 2px; }
`;
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

// Pure HTML for the server fallback; the browser-only setup is guarded below.
export function renderImagePreview({src, back, alt}) {
  const image = src ? `<img data-viewer-image src="${escapeHTML(src)}" alt="${escapeHTML(alt)}">` : '<p role="status">图片不可用。</p>';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>图片查看</title><style>
    html,body { margin:0; background:#000; color:#fff; }
    [data-image-preview] { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; overflow:hidden; }
    [data-image-preview] img { display:block; width:auto; height:auto; max-width:100%; max-height:100%; object-fit:contain; margin:0; }
    ${backStyle}
    </style><main data-image-preview>${image}<a data-viewer-back href="${escapeHTML(back)}">返回</a></main></html>`;
}


function imageLink(event) {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const link = event.target instanceof Element ? event.target.closest('a[data-image-viewer][href]') : null;
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  let url;
  try { url = new URL(link.href); } catch { return; }
  if (url.origin !== location.origin || url.username || url.password) return;
  if (rawPaths.has(url.pathname)) return {link, url};
  const imagePath = paths.get(url.pathname);
  if (!imagePath) return;
  const media = new URL(imagePath, location.origin);
  for (const key of imagePath === '/catalog/image' ? ['id'] : ['group', 'file', 'batch']) {
    if (url.searchParams.has(key)) media.searchParams.set(key, url.searchParams.get(key));
  }
  return {link, url: media};
}

function makeViewer() {
  const style = document.createElement('style');
  style.textContent = backStyle + `
    ${scope} { position: fixed; inset: 0; box-sizing: border-box; width: 100%; max-width: none;
      height: 100%; height: 100dvh; max-height: none; margin: 0; border: 0; padding: 0;
      overflow: hidden; touch-action: none; background: #000; color: #fff; font: 16px/1.3 system-ui; }
    ${scope}[open] { display: grid; grid-template-rows: minmax(0, 1fr); }
    ${scope}::backdrop { background: #000; }
    ${scope} [data-viewer-stage] { position: relative; min-width: 0; min-height: 0; overflow: auto;
      overscroll-behavior: contain; overflow-anchor: none; touch-action: none; }
    ${scope} [data-viewer-stage][data-pannable] { cursor: grab; }
    ${scope} [data-viewer-stage][data-dragging] { cursor: grabbing; }
    ${scope} [data-viewer-canvas] { display: flex; align-items: center; justify-content: center;
      min-width: 100%; width: max-content; min-height: 100%; }
    ${scope} [data-viewer-image] { display: block; flex: none; max-width: none; max-height: none;
      margin: 0; border: 0; padding: 0; user-select: none; object-fit: contain; }
    ${scope} [data-viewer-image][hidden] { display: none; }
    ${scope} [data-viewer-status] { position: absolute; inset: 16px; display: grid; place-content: center;
      text-align: center; pointer-events: none; }
    ${scope} [data-viewer-status][hidden] { display: none; }
  `;
  document.head.append(style);

  const dialog = document.createElement('dialog');
  dialog.setAttribute('data-image-viewer-dialog', '');
  dialog.setAttribute('aria-label', '图片查看');
  dialog.innerHTML = `
    <button type="button" autofocus data-viewer-back data-viewer-toolbar>返回</button>
    <div data-viewer-stage tabindex="0" aria-label="看图区域">
      <div data-viewer-canvas></div>
      <div data-viewer-status role="status"></div>
    </div>`;
  document.body.append(dialog);
  const back = dialog.querySelector('button');
  const stage = dialog.querySelector('[data-viewer-stage]');
  const canvas = dialog.querySelector('[data-viewer-canvas]');
  const status = dialog.querySelector('[data-viewer-status]');
  const minZoom = 1, maxZoom = 4;
  let zoom = minZoom, image, anchor, scroll, natural, pinch;
  const touches = new Map();
  let mouse, pinchFrame = 0;

  function pointAt(position) {
    const rect = image.getBoundingClientRect();
    return rect.width && rect.height
      ? {x: (position.x - rect.x) / rect.width, y: (position.y - rect.y) / rect.height}
      : {x: 0.5, y: 0.5};
  }

  function centerOfStage() {
    const frame = stage.getBoundingClientRect();
    return {x: frame.x + stage.clientWidth / 2, y: frame.y + stage.clientHeight / 2};
  }

  function layout(point, target) {
    if (!natural || !dialog.open) return;
    const frame = stage.getBoundingClientRect();
    if (!frame.width || !frame.height) return;
    const scale = Math.min(1, Math.floor(frame.width) / natural.w, Math.floor(frame.height) / natural.h) * zoom;
    image.style.width = natural.w * scale + 'px';
    image.style.height = natural.h * scale + 'px';
    const rect = image.getBoundingClientRect();
    const at = target ?? centerOfStage();
    stage.scrollLeft += rect.x + rect.width * (point?.x ?? 0.5) - at.x;
    stage.scrollTop += rect.y + rect.height * (point?.y ?? 0.5) - at.y;
    stage.toggleAttribute('data-pannable', stage.scrollWidth > stage.clientWidth || stage.scrollHeight > stage.clientHeight);
  }

  function pair() {
    if (touches.size !== 2) return null;
    const [a, b] = touches.values();
    return {mid: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, distance: Math.hypot(a.x - b.x, a.y - b.y)};
  }

  // On a contact-count change, only take a new reference; never change the view.
  function rebase() {
    const current = pair();
    pinch = current && current.distance >= 1
      ? {distance: current.distance, point: pointAt(current.mid), zoom}
      : null;
  }

  function updatePinch() {
    const current = pair();
    if (!current) return;
    if (!pinch) { rebase(); return; }
    const requested = pinch.zoom * current.distance / pinch.distance;
    zoom = Math.max(minZoom, Math.min(maxZoom, requested));
    layout(pinch.point, current.mid);
    if (requested !== zoom) rebase(); // Reverse immediately from either end stop.
  }

  function flushPinch() {
    if (!pinchFrame) return;
    cancelAnimationFrame(pinchFrame);
    pinchFrame = 0;
    updatePinch();
  }

  function clearGesture() {
    if (pinchFrame) cancelAnimationFrame(pinchFrame);
    pinchFrame = 0;
    const ids = [...touches.keys(), ...(mouse ? [mouse.id] : [])];
    touches.clear();
    mouse = pinch = null;
    stage.removeAttribute('data-dragging');
    for (const id of ids) if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
  }

  stage.addEventListener('pointerdown', event => {
    if (!natural || !dialog.open || event.button !== 0) return;
    const at = {x: event.clientX, y: event.clientY};
    if (event.pointerType === 'touch' && !mouse) {
      flushPinch();
      touches.set(event.pointerId, at);
      stage.setPointerCapture(event.pointerId);
      rebase();
    } else if (event.pointerType === 'mouse' && !touches.size && stage.hasAttribute('data-pannable')) {
      mouse = {...at, id: event.pointerId};
      stage.setPointerCapture(event.pointerId);
      stage.setAttribute('data-dragging', '');
      event.preventDefault();
    }
  });

  stage.addEventListener('pointermove', event => {
    const at = {x: event.clientX, y: event.clientY}, id = event.pointerId;
    const previous = touches.get(id);
    if (previous) {
      touches.set(id, at);
      if (touches.size === 1) {
        if (zoom > minZoom) {
          stage.scrollLeft += previous.x - at.x;
          stage.scrollTop += previous.y - at.y;
        }
      } else if (touches.size === 2 && !pinchFrame) {
        // Each pointer has its own move event; read the pair together on the next frame.
        pinchFrame = requestAnimationFrame(() => {
          pinchFrame = 0;
          updatePinch();
        });
      }
    } else if (mouse?.id === id) {
      stage.scrollLeft += mouse.x - at.x;
      stage.scrollTop += mouse.y - at.y;
      mouse = {...at, id};
    }
  });

  function endPointer(event) {
    const id = event.pointerId;
    if (touches.has(id)) { flushPinch(); touches.delete(id); rebase(); }
    if (mouse?.id === id) {
      mouse = null;
      stage.removeAttribute('data-dragging');
    }
    if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stage.addEventListener(event, endPointer);
  }

  // Optional desktop controls are scoped to the open dialog and add no visible UI.
  dialog.addEventListener('keydown', event => {
    if (!natural || !dialog.open || touches.size || event.ctrlKey || event.metaKey || event.altKey) return;
    const factors = {'+': 1.3, '=': 1.3, '-': 1 / 1.3, '−': 1 / 1.3};
    if (event.key !== '0' && !Object.hasOwn(factors, event.key)) return;
    event.preventDefault();
    const at = centerOfStage();
    const point = pointAt(at);
    zoom = event.key === '0' ? minZoom : Math.max(minZoom, Math.min(maxZoom, zoom * factors[event.key]));
    layout(point, at);
  });


  function close() {
    dialog.close();
    restore();
  }
  back.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  function restore() {
    if (dialog.open || !anchor) return;
    clearGesture();
    canvas.replaceChildren();
    image = natural = null;
    const original = anchor;
    const position = scroll;
    anchor = scroll = null;
    if (original?.isConnected) original.focus({preventScroll: true});
    if (position && (scrollX !== position.x || scrollY !== position.y)) {
      window.scrollTo({left: position.x, top: position.y, behavior: 'instant'});
    }
  }
  dialog.addEventListener('close', restore);

  function resize() {
    if (!natural || !dialog.open) return;
    const at = centerOfStage();
    layout(pointAt(at), at);
    rebase();
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(stage, {box: 'border-box'});
  else window.addEventListener('resize', resize);

  return function open(link, url) {
    clearGesture();
    anchor = link;
    scroll = {x: scrollX, y: scrollY};
    natural = null;
    zoom = minZoom;
    stage.removeAttribute('data-pannable');
    status.textContent = '正在加载图片…';
    status.hidden = false;
    const next = document.createElement('img');
    next.setAttribute('data-viewer-image', '');
    next.alt = link.querySelector('img')?.alt || '原图';
    next.draggable = false;
    next.hidden = true;
    image = next;
    canvas.replaceChildren(next);
    stage.scrollLeft = stage.scrollTop = 0;
    if (!dialog.open) dialog.showModal();
    back.focus({preventScroll: true});
    const fail = () => {
      if (image !== next || !dialog.open) return;
      status.textContent = '图片加载失败，可返回原页面。';
    };
    next.addEventListener('error', fail, {once: true});
    next.addEventListener('load', () => {
      if (image !== next || !dialog.open) return;
      if (!next.naturalWidth || !next.naturalHeight) { fail(); return; }
      natural = {w: next.naturalWidth, h: next.naturalHeight};
      status.hidden = true;
      next.hidden = false;
      layout();
    }, {once: true});
    next.src = url.href;
  };
}

if (typeof document !== 'undefined' && typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal === 'function') {
  let show;
  document.addEventListener('click', event => {
    const chosen = imageLink(event);
    if (!chosen) return;
    show ??= makeViewer();
    show(chosen.link, chosen.url);
    event.preventDefault();
  });
}
