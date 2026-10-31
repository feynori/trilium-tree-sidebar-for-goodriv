// Runs only on a locally opened GoodRiv page. No credentials or generic ETAPI access.
(() => {
  'use strict';
  if (window !== window.top || document.querySelector('meta[name="goodriv-app"]')?.content !== 'v1') return;
  const channel = 'goodriv-trilium:v1';
  window.addEventListener('message', async event => {
    if (event.source !== window || event.data?.channel !== channel || event.data.direction !== 'request') return;
    const { id, action } = event.data;
    if (typeof id !== 'string' || id.length > 100 || !['ping', 'createNote', 'openNote'].includes(action)) return;
    const payload = { channel, action };
    if (action === 'createNote') payload.title = String(event.data.title || '');
    if (action === 'openNote') payload.noteId = String(event.data.noteId || '');
    try {
      const response = await chrome.runtime.sendMessage(payload);
      window.postMessage({ channel, direction: 'response', id, ...(response || { ok: false, error: '小树插件没有响应' }) }, '*');
    } catch (error) {
      window.postMessage({ channel, direction: 'response', id, ok: false, error: error.message }, '*');
    }
  });
})();
