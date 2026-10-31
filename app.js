(() => {
  'use strict';

  // ---------- 小工具 ----------
  const $ = (s, r = document) => r.querySelector(s);
  const enc = encodeURIComponent;
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const JSON_HDR = { 'Content-Type': 'application/json' };

  const cfg = { url: 'http://localhost:37840', token: '', parent: '', place: 'day' };
  const expanded = new Set();
  const cache = new Map();          // noteId -> 笔记元数据
  let selectedId = null;
  let cur = null;                   // 当前编辑的笔记状态
  let saveTimer = null;
  let openSeq = 0;

  const HIDDEN_TYPES = new Set(['launcher', 'widget']);
  const isVisible = (id) => !id.startsWith('_');   // 以 _ 开头的是 Trilium 内部隐藏笔记

  // ---------- 图标 ----------
  const SVG = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const I = {
    doc: SVG('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
    folder: SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    code: SVG('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'),
    image: SVG('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/>'),
    clip: SVG('<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15 7"/>'),
    search: SVG('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    chev: SVG('<path d="m9 6 6 6-6 6"/>'),
    plus: SVG('<path d="M12 5v14M5 12h14"/>'),
    sprout: SVG('<path d="M12 21v-9M12 12c0-4 3-6 7-6 0 4-3 6-7 6zM12 14c0-3-2-5-6-5 0 3 2 5 6 5z"/>')
  };
  function iconFor(type) {
    switch (type) {
      case 'text': return ['t-text', I.doc];
      case 'book': return ['t-book', I.folder];
      case 'code': return ['t-code', I.code];
      case 'image': return ['t-image', I.image];
      case 'file': return ['t-file', I.clip];
      case 'search': return ['t-search', I.search];
      default: return ['t-other', I.doc];
    }
  }

  // ---------- 提示 ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }
  function setConn(kind, text) {
    $('#dot').className = 'dot ' + kind;
    $('#conn-text').textContent = text;
  }

  // ---------- ETAPI ----------
  const baseUrl = () => cfg.url.trim().replace(/\/+$/, '').replace(/\/etapi$/, '');
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(`${baseUrl()}/etapi${path}`, {
        ...opts,
        headers: { Authorization: cfg.token.trim(), ...(opts.headers || {}) }
      });
    } catch {
      throw new Error('连不上 Trilium：请确认桌面版正在运行，地址没写错');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('Token 不对（401），请在 Trilium 里重新创建一个');
      if (res.status === 404) throw new Error('找不到这条笔记或接口（404）');
      throw new Error(`请求失败 ${res.status} ${body.slice(0, 120)}`);
    }
    return res;
  }
  async function getMeta(id, force = false) {
    if (!force && cache.has(id)) return cache.get(id);
    const m = await (await api(`/notes/${enc(id)}`)).json();
    cache.set(id, m);
    return m;
  }

  // ---------- 笔记树 ----------
  const treeEl = $('#tree'), treeWrap = $('#tree-wrap'), layout = $('#layout');

  // 名字完整显示：自动换行，并按长度、层级微调字号
  function fitName(nameEl, title, depth) {
    const len = [...title].length;
    let px = len <= 9 ? 18 : len <= 14 ? 17 : len <= 20 ? 16 : len <= 30 ? 15 : 14;
    px -= Math.min(depth, 3) * 0.5;
    nameEl.style.fontSize = px + 'px';
    nameEl.dataset.depth = depth;
  }

  async function renderChildren(container, parentId, depth = 0) {
    const parent = await getMeta(parentId);
    const ids = (parent.childNoteIds || []).filter(isVisible);
    const metas = await Promise.all(ids.map((id) => getMeta(id).catch(() => null)));
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const m of metas) {
      if (!m || HIDDEN_TYPES.has(m.type)) continue;
      frag.append(buildNode(m, depth)); n++;
    }
    container.replaceChildren(frag);
    return n;
  }

  function buildNode(m, depth = 0) {
    const kids = (m.childNoteIds || []).filter(isVisible);
    const wrap = el('div', 'node'); wrap.dataset.id = m.noteId; wrap.dataset.depth = depth;
    const row = el('div', 'row' + (m.noteId === selectedId ? ' selected' : '')); row.dataset.id = m.noteId;

    const chev = el('button', 'chev' + (kids.length ? '' : ' leaf'));
    if (kids.length) { chev.innerHTML = I.chev; chev.title = '展开 / 折叠'; } else chev.tabIndex = -1;

    const [cls, svg] = iconFor(m.type);
    const ico = el('span', 'ico ' + cls); ico.innerHTML = svg;
    const name = el('span', 'name'); name.textContent = m.title || '（无标题）'; fitName(name, name.textContent, depth);
    const add = el('button', 'add'); add.title = '在这里新建子笔记'; add.innerHTML = I.plus;
    row.append(chev, ico, name, add);

    const box = el('div', 'children'); box.hidden = true;
    wrap.append(row, box);

    row.addEventListener('click', (e) => {
      if (e.target.closest('.chev') || e.target.closest('.add')) return;
      openNote(m.noteId);
    });
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.add') || !kids.length) return;
      toggle(wrap, m, !wrap.classList.contains('open'));
    });
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      if (kids.length) toggle(wrap, m, !wrap.classList.contains('open'));
    });
    add.addEventListener('click', (e) => { e.stopPropagation(); newNote(m.noteId); });

    if (kids.length && expanded.has(m.noteId)) toggle(wrap, m, true, true);
    return wrap;
  }

  async function toggle(wrap, m, open, skipPersist = false) {
    const box = wrap.querySelector(':scope > .children');
    if (open) {
      wrap.classList.add('open'); box.hidden = false; expanded.add(m.noteId);
      if (!box.dataset.loaded) {
        box.dataset.loaded = '1';
        box.innerHTML = '<div class="loading-row">小树枝正在长出来……</div>';
        try { await renderChildren(box, m.noteId, Number(wrap.dataset.depth) + 1); }
        catch (e) { delete box.dataset.loaded; box.innerHTML = `<div class="loading-row">${e.message}</div>`; }
      }
    } else {
      wrap.classList.remove('open'); box.hidden = true; expanded.delete(m.noteId);
    }
    if (!skipPersist) persistExpanded();
  }
  const persistExpanded = () => chrome.storage.local.set({ expanded: [...expanded] });

  async function renderTree() {
    const scroll = treeWrap.scrollTop;
    const n = await renderChildren(treeEl, 'root');
    const empty = $('#empty');
    if (n === 0) {
      empty.innerHTML = `${I.sprout}<div>这里还没有笔记</div><div>点右边粉色的「新建」，种下第一棵</div>`;
      empty.hidden = false;
    } else empty.hidden = true;
    treeWrap.scrollTop = scroll;
  }

  function revealSelected(tries = 12) {
    if (!selectedId) return;
    const r = document.querySelector('.row.selected');
    if (r) { r.scrollIntoView({ block: 'nearest' }); return; }
    if (tries > 0) setTimeout(() => revealSelected(tries - 1), 150);   // 子节点还在加载
  }

  function markSelected() {
    document.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
    if (selectedId) document.querySelectorAll(`.row[data-id="${selectedId}"]`).forEach((r) => r.classList.add('selected'));
    $('#btn-open').disabled = !selectedId;
    $('#btn-delete').disabled = !selectedId;
  }

  // ---------- 搜索 ----------
  let searchTimer = null;
  $('#search').addEventListener('input', () => {
    const q = $('#search').value.trim();
    $('#search-clear').hidden = !q;
    clearTimeout(searchTimer);
    if (!q) return showTree();
    searchTimer = setTimeout(() => runSearch(q), 350);
  });
  $('#search-clear').addEventListener('click', clearSearch);
  function clearSearch() { $('#search').value = ''; $('#search-clear').hidden = true; showTree(); }
  function showTree() { $('#results').hidden = true; treeEl.hidden = false; }
  async function runSearch(q) {
    const box = $('#results');
    treeEl.hidden = true; box.hidden = false; $('#empty').hidden = true;
    box.innerHTML = '<div class="loading-row">找找看……</div>';
    try {
      const data = await (await api(`/notes?search=${enc(q)}&limit=40`)).json();
      const list = (data.results || []).filter((n) => isVisible(n.noteId) && !HIDDEN_TYPES.has(n.type));
      if (!list.length) { box.innerHTML = '<div class="loading-row">没找到，换个词试试</div>'; return; }
      const frag = document.createDocumentFragment();
      for (const n of list) {
        cache.set(n.noteId, n);
        const row = el('div', 'row' + (n.noteId === selectedId ? ' selected' : '')); row.dataset.id = n.noteId;
        const lead = el('span', 'chev leaf');
        const [cls, svg] = iconFor(n.type);
        const ico = el('span', 'ico ' + cls); ico.innerHTML = svg;
        const name = el('span', 'name'); name.textContent = n.title || '（无标题）'; fitName(name, name.textContent, 0);
        row.append(lead, ico, name);
        row.addEventListener('click', () => openNote(n.noteId));
        frag.append(row);
      }
      box.replaceChildren(frag);
    } catch (e) { box.innerHTML = `<div class="loading-row">${e.message}</div>`; }
  }

  // ---------- 编辑区 ----------
  const editor = $('#editor'), titleEl = $('#edit-title'), richEl = $('#edit-rich'),
        codeEl = $('#edit-code'), msgEl = $('#edit-msg'), stateEl = $('#save-state');

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((n) => n.remove());
    doc.querySelectorAll('*').forEach((e) => {
      [...e.attributes].forEach((a) => {
        const n = a.name.toLowerCase();
        if (n.startsWith('on') || ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(a.value))) e.removeAttribute(a.name);
      });
    });
    return doc;
  }
  const isComplex = (html) => /<(img|table|figure|iframe|pre|section|math|svg|input)\b|include-note/i.test(html);

  function setSaveState(kind, text) { stateEl.className = 'save-state ' + kind; stateEl.textContent = text; }

  async function openNote(id, { focusTitle = false } = {}) {
    await flushSave();
    const seq = ++openSeq;
    selectedId = id; markSelected();
    editor.hidden = false; layout.classList.add('editing');
    richEl.hidden = true; codeEl.hidden = true; msgEl.hidden = true;
    titleEl.value = ''; titleEl.disabled = true; setSaveState('', '打开中……');
    cur = null;
    try {
      const m = await getMeta(id, true);
      if (seq !== openSeq) return;
      titleEl.value = m.title; titleEl.disabled = false;
      if (m.isProtected) throw new Error('这是加密笔记，侧边栏读不了，请在 Trilium 里打开');
      const c = { id, type: m.type, kind: 'none', dirtyTitle: false, dirtyBody: false };

      if (m.type === 'text' || m.type === 'book') {
        const html = await (await api(`/notes/${enc(id)}/content`)).text();
        if (seq !== openSeq) return;
        if (isComplex(html)) {
          c.kind = 'readonly';
          const doc = sanitize(html);
          doc.querySelectorAll('img').forEach((img) => {
            const s = img.getAttribute('src') || '';
            if (s && !/^(https?:|data:)/i.test(s)) img.setAttribute('src', `${baseUrl()}/${s.replace(/^\/+/, '')}`);
          });
          richEl.innerHTML = doc.body.innerHTML; richEl.contentEditable = 'false';
          msgEl.textContent = '这条笔记里有图片、表格或代码块，为了不弄坏格式，侧边栏里只能看。想改请点右边的「打开」。';
          msgEl.hidden = false; richEl.hidden = false;
        } else {
          c.kind = 'rich';
          richEl.innerHTML = sanitize(html).body.innerHTML; richEl.contentEditable = 'true'; richEl.hidden = false;
        }
      } else if (m.type === 'code' || (m.mime || '').startsWith('text/')) {
        c.kind = 'code';
        codeEl.value = await (await api(`/notes/${enc(id)}/content`)).text();
        if (seq !== openSeq) return;
        codeEl.hidden = false;
      } else {
        msgEl.textContent = `这是「${m.type}」类型的笔记，侧边栏不能编辑。想改请点右边的「打开」。`;
        msgEl.hidden = false;
      }
      cur = c;
      setSaveState('', c.kind === 'rich' || c.kind === 'code' ? '改动会自动保存' : '');
      revealSelected();
      if (focusTitle) { titleEl.focus(); titleEl.select(); }
    } catch (e) {
      if (seq !== openSeq) return;
      msgEl.textContent = e.message; msgEl.hidden = false; setSaveState('err', '');
    }
  }

  function closeEditor() {
    flushSave();
    openSeq++; cur = null; selectedId = null;
    editor.hidden = true; layout.classList.remove('editing');
    markSelected();
  }
  $('#edit-close').addEventListener('click', closeEditor);

  // 自动保存
  function scheduleSave(what) {
    if (!cur) return;
    if (what === 'title') cur.dirtyTitle = true; else cur.dirtyBody = true;
    setSaveState('', '编辑中……');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 700);
  }
  async function flushSave() {
    clearTimeout(saveTimer);
    const c = cur;
    if (!c || (!c.dirtyTitle && !c.dirtyBody)) return;
    const title = titleEl.value.trim();
    const wantTitle = c.dirtyTitle && title;
    const wantBody = c.dirtyBody && (c.kind === 'rich' || c.kind === 'code');
    const body = c.kind === 'rich' ? richEl.innerHTML : codeEl.value;
    c.dirtyTitle = false; c.dirtyBody = false;
    setSaveState('', '保存中……');
    try {
      if (wantTitle) {
        await api(`/notes/${enc(c.id)}`, { method: 'PATCH', headers: JSON_HDR, body: JSON.stringify({ title }) });
        const meta = cache.get(c.id); if (meta) meta.title = title;
        document.querySelectorAll(`.row[data-id="${c.id}"] .name`).forEach((n) => { n.textContent = title; fitName(n, title, Number(n.dataset.depth || 0)); });
      }
      if (wantBody) {
        await api(`/notes/${enc(c.id)}/content`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
      }
      setSaveState('ok', '已保存 ✓ ' + new Date().toLocaleTimeString());
    } catch (e) {
      c.dirtyTitle = c.dirtyTitle || !!wantTitle; c.dirtyBody = c.dirtyBody || !!wantBody;
      setSaveState('err', '保存失败：' + e.message);
    }
  }
  titleEl.addEventListener('input', () => scheduleSave('title'));
  richEl.addEventListener('input', () => scheduleSave('body'));
  codeEl.addEventListener('input', () => scheduleSave('body'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave(); }
    if (e.key === 'Escape' && $('#search').value) clearSearch();
  });

  // ---------- 右侧按钮 ----------
  const today = () => {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  };
  async function ensureDayParent() {
    const day = await (await api('/calendar/days/' + today())).json();
    if (!day.noteId) throw new Error('Trilium 没有返回今天的 Day Note');
    return day.noteId;
  }
  let creatingNote = false;
  async function newNote(parentId) {
    if (creatingNote) return;
    creatingNote = true;
    try {
      await flushSave();
      const place = parentId ? 'parent' : cfg.place;
      let parent;
      if (parentId) parent = parentId;
      else if (place === 'day') parent = await ensureDayParent();
      else {
        parent = cfg.parent.trim();
        if (!parent) throw new Error('请在设置里填写目标笔记的 Note ID');
        if (!/^[\w-]{4,32}$/.test(parent)) throw new Error('Note ID 格式不对');
      }
      const r = await (await api('/create-note', {
        method: 'POST', headers: JSON_HDR,
        body: JSON.stringify({ parentNoteId: parent, title: '新笔记', type: 'text', content: '' })
      })).json();
      if (!r.note?.noteId) throw new Error('Trilium 没有返回新笔记 ID');
      let labelError = null;
      if (!parentId && place === 'calendar') {
        try {
          await api('/attributes', {
            method: 'POST', headers: JSON_HDR,
            body: JSON.stringify({ noteId: r.note.noteId, type: 'label', name: 'startDate', value: today(), isInheritable: false })
          });
        } catch (e) { labelError = e; }
      }
      cache.delete(parent);
      if (parent !== 'root') { expanded.add(parent); persistExpanded(); }
      if ($('#search').value) clearSearch();
      await renderTree();
      await openNote(r.note.noteId, { focusTitle: true });
      toast(labelError ? '笔记已创建，但未显示在日历：' + labelError.message : '新笔记已种下 🌱');
    } catch (e) {
      toast(e.message.includes('404') ? '新笔记的存放位置不存在，请检查设置里的 Note ID' : e.message);
    } finally { creatingNote = false; }
  }
  $('#btn-new').addEventListener('click', () => newNote());

  $('#btn-collapse').addEventListener('click', () => {
    expanded.clear(); persistExpanded();
    document.querySelectorAll('.node.open').forEach((n) => {
      n.classList.remove('open'); n.querySelector(':scope > .children').hidden = true;
    });
  });
  $('#btn-refresh').addEventListener('click', async () => {
    await flushSave();
    cache.clear();
    await connect();
    if (selectedId) { const keep = selectedId; openNote(keep); }
  });
  $('#btn-open').addEventListener('click', () => {
    if (selectedId) window.open(`${baseUrl()}/#root/${selectedId}`, '_blank');
  });
  $('#btn-delete').addEventListener('click', async () => {
    if (!selectedId) return;
    const id = selectedId;
    const meta = cache.get(id);
    if (!confirm(`删除「${meta ? meta.title : '这条笔记'}」？它下面的子笔记也会一起删除。`)) return;
    try {
      cur = null; clearTimeout(saveTimer);
      await api(`/notes/${enc(id)}`, { method: 'DELETE' });
      (meta?.parentNoteIds || []).forEach((p) => cache.delete(p));
      cache.delete(id);
      closeEditor();
      await renderTree();
      toast('已删除');
    } catch (e) { toast(e.message); }
  });

  // ---------- 设置（页脚浮层） ----------
  const settings = $('#settings');
  function updatePlaceUI() {
    const place = $('#set-place').value, custom = place !== 'day';
    $('#set-parent').hidden = !custom;
    $('#set-parent-label').hidden = !custom;
    $('#set-parent-label').textContent = place === 'calendar' ? '日历集合的 Note ID' : '父笔记 Note ID';
    $('#set-place-hint').textContent = place === 'day'
      ? '新建笔记会成为今天日记的子笔记。点笔记树某一行旁的“＋”仍建在那一行下面。'
      : place === 'calendar'
        ? '填写日历集合笔记的 ID；新笔记将成为它的子笔记，并带有今天的全天日期。'
        : '顶部“新建”放在指定父笔记下；点笔记树某一行旁的“＋”仍优先放在那一行下面。';
  }
  $('#set-place').addEventListener('change', updatePlaceUI);
  function fillSettings() { $('#set-url').value = cfg.url; $('#set-token').value = cfg.token; $('#set-parent').value = cfg.parent; $('#set-place').value = cfg.place; updatePlaceUI(); }
  function setSettingsStatus(kind, msg) { const s = $('#set-status'); s.className = 'set-status ' + kind; s.textContent = msg; }
  function openSettings() { fillSettings(); setSettingsStatus('', ''); settings.hidden = false; }
  $('#open-settings').addEventListener('click', () => (settings.hidden ? openSettings() : (settings.hidden = true)));
  $('#set-close').addEventListener('click', () => (settings.hidden = true));

  function readSettings() {
    cfg.url = $('#set-url').value.trim() || 'http://localhost:37840';
    cfg.token = $('#set-token').value.trim();
    cfg.parent = $('#set-parent').value.trim();
    cfg.place = $('#set-place').value;
  }
  $('#set-test').addEventListener('click', async () => {
    readSettings(); setSettingsStatus('', '测试中……');
    try { const info = await (await api('/app-info')).json(); setSettingsStatus('ok', `连上了 ✓ Trilium ${info.appVersion || ''}`); }
    catch (e) { setSettingsStatus('err', e.message); }
  });
  $('#set-save').addEventListener('click', async () => {
    readSettings();
    if (!cfg.token) return setSettingsStatus('err', '请先填 Token');
    try {
      // 非本机地址需要浏览器授权（必须紧跟在点击之后）
      if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl())) {
        const ok = await chrome.permissions.request({ origins: [new URL(baseUrl()).origin + '/*'] });
        if (!ok) return setSettingsStatus('err', '没有授权访问这个地址');
      }
    } catch { return setSettingsStatus('err', '地址格式不对'); }
    if (cfg.place !== 'day' && !/^[\w-]{4,32}$/.test(cfg.parent)) return setSettingsStatus('err', '请填写有效的目标 Note ID');
    await chrome.storage.local.set({ url: cfg.url, token: cfg.token, parent: cfg.parent, newNotePlace: cfg.place });
    settings.hidden = true;
    cache.clear();
    await connect();
  });

  // ---------- 连接 ----------
  async function connect() {
    const banner = $('#banner');
    banner.hidden = true;
    if (!cfg.token) {
      setConn('err', '还没填 Token');
      banner.innerHTML = '先在右下角「设置」里填上 ETAPI Token 吧。';
      banner.hidden = false; openSettings(); return;
    }
    setConn('busy', '连接中……');
    try {
      await api('/app-info');
      setConn('ok', '已连接 · ' + baseUrl().replace(/^https?:\/\//, ''));
      await renderTree();
    } catch (e) {
      setConn('err', '未连接');
      banner.innerHTML = '';
      const t = el('div'); t.textContent = e.message;
      const b = el('button'); b.textContent = '再试一次';
      b.addEventListener('click', connect);
      banner.append(t, b); banner.hidden = false;
      treeEl.replaceChildren();
    }
  }

  (async function init() {
    const s = await chrome.storage.local.get(['url', 'token', 'parent', 'newNotePlace', 'expanded']);
    if (s.url) cfg.url = s.url;
    if (s.token) cfg.token = s.token;
    if (s.parent) cfg.parent = s.parent;
    cfg.place = ['day', 'parent', 'calendar'].includes(s.newNotePlace) ? s.newNotePlace : (s.parent && s.parent !== 'root' ? 'parent' : 'day');
    (s.expanded || []).forEach((id) => expanded.add(id));
    markSelected();
    connect();
  })();
})();
