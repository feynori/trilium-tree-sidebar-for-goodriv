// 点击工具栏图标即打开侧边栏
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// GoodRiv requests only three narrow operations. ETAPI Token never leaves the extension.
const GOODRIV_ACTIONS = new Set(['ping', 'createNote', 'openNote']);
function triliumBase(raw) {
  const u = new URL(String(raw || '').trim());
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error('小树保存的 Trilium 地址无效，请在小树设置中修正');
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw Error('远程 Trilium 请使用 HTTPS');
  return u.href.replace(/\/+$/, '').replace(/\/etapi$/, '');
}
async function goodrivAction(message) {
  const settings = await chrome.storage.local.get(['url', 'token', 'parent']);
  const base = triliumBase(settings.url || 'http://localhost:37840');
  const token = String(settings.token || '').trim();
  if (!token) throw Error('请先在 Trilium 小树设置里保存 ETAPI Token');
  const api = async (path, options = {}) => {
    let response;
    try { response = await fetch(base + '/etapi' + path, { ...options, headers: { Authorization: token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } }); }
    catch { throw Error('小树连接不到 Trilium，请确认 Trilium 正在运行'); }
    if (!response.ok) throw Error('Trilium 返回 ' + response.status);
    return response;
  };
  if (message.action === 'ping') { await api('/app-info'); return { connected: true }; }
  if (message.action === 'createNote') {
    const title = String(message.title || '').trim();
    if (!title || title.length > 180) throw Error('笔记名称无效');
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const day = await (await api('/calendar/days/' + date)).json();
    const parentNoteId = day.noteId;
    if (!parentNoteId) throw Error('Trilium 未返回当天日记节点');
    const result = await (await api('/create-note', { method: 'POST', body: JSON.stringify({ parentNoteId, title, type: 'text', content: '' }) })).json();
    const noteId = result.note?.noteId;
    if (!noteId) throw Error('Trilium 未返回新笔记 ID');
    await chrome.tabs.create({ url: base + '/#root/' + encodeURIComponent(noteId) });
    return { noteId, base };
  }
  if (message.action === 'openNote') {
    const noteId = String(message.noteId || '');
    if (!/^[\w-]{1,100}$/.test(noteId)) throw Error('笔记 ID 无效');
    await api('/notes/' + encodeURIComponent(noteId));
    await chrome.tabs.create({ url: base + '/#root/' + encodeURIComponent(noteId) });
    return { opened: true };
  }
  throw Error('不支持的操作');
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel !== 'goodriv-trilium:v1' || !GOODRIV_ACTIONS.has(message.action)) return;
  if (!sender.tab || !/^(file:\/\/|https?:\/\/localhost(?::\d+)?\/|http:\/\/127\.0\.0\.1(?::\d+)?\/)/.test(sender.url || sender.tab.url || '')) return;
  goodrivAction(message).then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});
