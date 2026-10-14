// RedPen adds this script to the top of an HTML page that runs its scripts.
// RedPen asks for the page's current state when the page first settles, and
// again when the reviewer turns actions off. The reply is untrusted page
// content: RedPen sanitizes it exactly like the original file before it shows it.
(() => {
  'use strict';
  const reviewPage = window.parent;
  const outerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML').get;
  const MAX_IMAGE_URL = 256 * 1024;
  const QUIET = 500;
  const MAX_SETTLE = 3000;

  // Tell RedPen when the page stops changing, so the first view shows what the
  // scripts drew. Page changes, loaded files, and animation frames all count.
  // A page that never stops is reported after a time limit.
  let lastChange = 0;
  const changed = () => { lastChange = performance.now(); };
  const changes = new MutationObserver(changed);
  changes.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  let loads = null;
  try { loads = new PerformanceObserver(changed); loads.observe({ type: 'resource' }); } catch { /* Page changes still count. */ }
  // Animation frames that the page asked for and that have not run yet. A busy
  // computer can delay a frame for longer than the quiet period.
  const frames = new Set();
  const requestFrame = window.requestAnimationFrame;
  const cancelFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame = function (callback) {
    const id = requestFrame.call(window, function (time) {
      frames.delete(id);
      changed();
      return callback.call(this, time);
    });
    frames.add(id);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    frames.delete(id);
    return cancelFrame.call(window, id);
  };
  window.addEventListener('load', () => {
    const limit = performance.now() + MAX_SETTLE;
    changed();
    (function report() {
      if (frames.size) changed();
      const now = performance.now();
      const wait = Math.min(QUIET - (now - lastChange), limit - now);
      if (wait > 0) return void setTimeout(report, wait);
      changes.disconnect();
      loads?.disconnect();
      reviewPage.postMessage({ type: 'redpen-live-idle' }, '*');
    })();
  }, { once: true });

  // Copy live values that the HTML markup does not hold. The copy is taken
  // before any change, so both lists keep the same element order.
  function pair(original, copy, selector) {
    const copies = [...copy.querySelectorAll(selector)];
    return [...original.querySelectorAll(selector)].map((element, index) => [element, copies[index]]).filter(([, match]) => match);
  }

  function canvasImage(canvas) {
    const image = document.createElement('img');
    try {
      let source = canvas.toDataURL('image/png');
      if (source.length > MAX_IMAGE_URL) source = canvas.toDataURL('image/webp', 0.9);
      if (source.length <= MAX_IMAGE_URL) image.setAttribute('src', source);
    } catch { /* A canvas with images from other sites cannot be read. */ }
    for (const name of ['id', 'class', 'style']) if (canvas.hasAttribute(name)) image.setAttribute(name, canvas.getAttribute(name));
    const box = canvas.getBoundingClientRect();
    image.style.width = box.width + 'px';
    image.style.height = box.height + 'px';
    image.setAttribute('alt', canvas.getAttribute('aria-label') || 'Canvas drawing');
    return image;
  }

  async function inlineStylesheet(link, copy) {
    try {
      const response = await fetch(link.href, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return;
      const style = document.createElement('style');
      style.textContent = await response.text();
      copy.replaceWith(style);
    } catch { /* The copy keeps the link. RedPen then reports it as blocked. */ }
  }

  async function snapshot() {
    const root = document.documentElement;
    const copy = root.cloneNode(true);
    const fields = pair(root, copy, 'input, textarea, select');
    const styles = pair(root, copy, 'style');
    const canvases = pair(root, copy, 'canvas');
    const links = pair(root, copy, 'link[rel~="stylesheet" i]').filter(([link]) => new URL(link.href, location.href).origin !== location.origin);
    for (const [element, match] of pair(root, copy, '*')) {
      if (element.scrollTop || element.scrollLeft) match.setAttribute('data-redpen-scroll', `${element.scrollLeft},${element.scrollTop}`);
    }
    for (const [field, match] of fields) {
      if (field.localName === 'textarea') match.textContent = field.value;
      else if (field.localName === 'select') [...field.options].forEach((option, index) => match.options[index]?.toggleAttribute('selected', option.selected));
      else if (field.type === 'checkbox' || field.type === 'radio') match.toggleAttribute('checked', field.checked);
      else if (field.type !== 'password' && field.type !== 'file') match.setAttribute('value', field.value);
    }
    // Scripts can change styles without changing the style element's text.
    for (const [style, match] of styles) {
      try { if (style.sheet) match.textContent = [...style.sheet.cssRules].map((rule) => rule.cssText).join('\n'); } catch { /* Keep the original text. */ }
    }
    if (document.adoptedStyleSheets?.length) {
      const style = document.createElement('style');
      try { style.textContent = document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join('\n'); } catch { /* Skip unreadable sheets. */ }
      copy.querySelector('head')?.append(style);
    }
    for (const [canvas, match] of canvases) match.replaceWith(canvasImage(canvas));
    // The scripts already ran, and fallback text for browsers without JavaScript
    // does not apply. Leaving scripts in would also add a "script was blocked" notice.
    copy.querySelectorAll('script, noscript').forEach((node) => node.remove());
    // RedPen shows only local files, so keep internet styles as inline text.
    await Promise.all(links.map(([link, match]) => inlineStylesheet(link, match)));
    return (document.doctype ? '<!doctype html>' : '') + outerHTML.call(copy);
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== reviewPage || event.data?.type !== 'redpen-live-snapshot') return;
    let html = '';
    try { html = await snapshot(); } catch { /* An empty reply keeps the earlier view. */ }
    // The page has an opaque origin, so the reply cannot name a target origin.
    reviewPage.postMessage({ type: 'redpen-live-snapshot', id: String(event.data.id), html, scrollX: window.scrollX, scrollY: window.scrollY }, '*');
  }, true);
})();
