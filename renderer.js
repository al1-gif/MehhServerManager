'use strict';

let toastTimer = null;
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

function fmtBytes(b) {
  if (!b || b < 0) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(1)} MB`;
}
function fmtUptime(s) {
  if (!s || s <= 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  if (h > 0) return `${h}h ${m}m ${sc}s`;
  if (m > 0) return `${m}m ${sc}s`;
  return `${sc}s`;
}
function fileIcon(e) {
  if (e.isDir) return '📁';
  const x = e.ext;
  if (x === '.jar')  return '🔩';
  if (x === '.json') return '📋';
  if (['.properties','.cfg','.conf','.toml','.yml','.yaml','.ini'].includes(x)) return '⚙';
  if (x === '.log')  return '📜';
  if (x === '.txt')  return '📄';
  if (['.zip','.gz','.tar','.rar'].includes(x)) return '📦';
  if (['.png','.jpg','.gif','.webp'].includes(x)) return '🖼';
  if (['.sh','.bat','.cmd'].includes(x)) return '⚡';
  if (x === '.py') return '🐍';
  if (x === '.lua') return '🌙';
  return '📄';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtBytesLarge(b) {
  if (!b || b < 0) return '—';
  if (b < 1024*1024)      return `${(b/1024).toFixed(0)} KB`;
  if (b < 1024*1024*1024) return `${(b/1024/1024).toFixed(1)} MB`;
  return `${(b/1024/1024/1024).toFixed(2)} GB`;
}

const S = {
  tab: 'dashboard',
  serverState: 'stopped',
  players: [],
  conBuf: [],
  autoScroll: true,
  currentDir: null,
  dirStack: [],
  playitRunning: false,
  configured: false,
};

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const panel = document.getElementById(`tab-${name}`);
  if (panel) panel.style.display = 'flex';

  const nav = document.querySelector(`.nav-item[data-tab="${name}"]`);
  if (nav) nav.classList.add('active');

  S.tab = name;

  if (name === 'properties') loadProps();
  if (name === 'mods')       loadMods();
  if (name === 'players')    renderPlayers();
  if (name === 'tunnels')    refreshPlayit();
  if (name === 'files') {
    if (!S.configured) {
      document.getElementById('files-grid').innerHTML = '<div class="empty" style="padding:40px">No server active. Create or import a server first.</div>';
      document.getElementById('breadcrumb').textContent = '';
    } else if (!S.currentDir) {
      initFiles();
    } else {
      api.filesList(S.currentDir).then(renderFiles);
    }
  }
}

document.querySelectorAll('.nav-item').forEach(n => {
  n.addEventListener('click', () => switchTab(n.dataset.tab));
});

document.getElementById('tb-min').onclick   = () => api.minimize();
document.getElementById('tb-max').onclick   = () => api.toggleMaximize();
document.getElementById('tb-close').onclick = () => api.close();

function applyState(state) {
  S.serverState = state;
  const dot  = document.getElementById('sdot');
  const lbl  = document.getElementById('slabel');
  const bS   = document.getElementById('btn-start');
  const bSp  = document.getElementById('btn-stop');
  const bR   = document.getElementById('btn-restart');

  const map = {
    stopped:  { cls: '',         lbl: 'Offline'   },
    starting: { cls: 'starting', lbl: 'Starting…' },
    running:  { cls: 'online',   lbl: 'Online'    },
    stopping: { cls: 'stopping', lbl: 'Stopping…' },
  };
  const info = map[state] || map.stopped;

  dot.className = `sdot ${info.cls}`;
  lbl.textContent = info.lbl;

  if (bS)  bS.style.display  = state === 'stopped'  ? '' : 'none';
  if (bSp) bSp.style.display = (state === 'running' || state === 'stopping') ? '' : 'none';
  if (bR)  bR.style.display  = state === 'running'  ? '' : 'none';

  if (state === 'running' && !_uptimeInterval) startUptimeTick();
  if (state !== 'running' && state !== 'starting') stopUptimeTick();
}

document.getElementById('btn-start').onclick   = async () => { const r = await api.serverStart();   if (!r.ok) toast(r.error, 'err'); };
document.getElementById('btn-stop').onclick    = async () => { const r = await api.serverStop();    if (!r.ok) toast(r.error, 'err'); };
document.getElementById('btn-restart').onclick = async () => { const r = await api.serverRestart(); if (!r.ok) toast(r.error, 'err'); };

let _uptimeBase = 0;
let _uptimeInterval = null;

function startUptimeTick(baseSeconds) {
  if (baseSeconds !== undefined) _uptimeBase = baseSeconds;
  if (_uptimeInterval) return;
  const start = Date.now() - _uptimeBase * 1000;
  _uptimeInterval = setInterval(() => {
    const el = document.getElementById('d-uptime');
    if (el) el.textContent = fmtUptime(Math.floor((Date.now() - start) / 1000));
  }, 1000);
}
function stopUptimeTick() {
  if (_uptimeInterval) { clearInterval(_uptimeInterval); _uptimeInterval = null; }
  const el = document.getElementById('d-uptime');
  if (el) el.textContent = '—';
}

function applyStats({ uptime, state }) {
  if (uptime && !_uptimeInterval) startUptimeTick(uptime);
  if (state && state !== S.serverState) applyState(state);
}
function resetStats() {
  stopUptimeTick();
  const dp = document.getElementById('d-players');
  if (dp) dp.textContent = '0';
}

let _diskCache = { world: 0, ts: 0 };
async function pollDisk() {
  try {
    const r = await api.getDisk();
    const el = document.getElementById('d-disk');
    if (r && r.bytes && el) el.textContent = fmtBytesLarge(r.bytes);
  } catch (_) {}
}
pollDisk();
setInterval(pollDisk, 30000);

const conOut  = document.getElementById('con-out');
const MAX_CON = 500;

function scrollToBottom() {
  conOut.scrollTop = conOut.scrollHeight;
}

function appendLine(data) {
  S.conBuf.push(data);
  if (S.conBuf.length > MAX_CON) S.conBuf.shift();

  const span = document.createElement('span');
  span.className = `cl ${data.type || 'info'}`;
  span.textContent = data.text + '\n';
  conOut.appendChild(span);
  if (conOut.children.length > MAX_CON) conOut.firstChild.remove();

  requestAnimationFrame(() => { conOut.scrollTop = conOut.scrollHeight; });
}

const conIn = document.getElementById('con-in');
const cmdHistory = []; let histIdx = -1;

function sendCmd() {
  const cmd = conIn.value.trim();
  if (!cmd) return;
  cmdHistory.push(cmd); histIdx = -1;
  conIn.value = '';
  api.consoleSend(cmd).then(r => { if (!r.ok) toast(r.error || 'Server not running', 'warn'); });
}
document.getElementById('con-send').onclick = sendCmd;
conIn.addEventListener('keydown', e => {
  if (e.key === 'Enter') { sendCmd(); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); if (histIdx < cmdHistory.length-1) { histIdx++; conIn.value = cmdHistory[cmdHistory.length-1-histIdx]; } }
  if (e.key === 'ArrowDown') { e.preventDefault(); if (histIdx > 0) { histIdx--; conIn.value = cmdHistory[cmdHistory.length-1-histIdx]; } else { histIdx = -1; conIn.value = ''; } }
});
document.getElementById('con-clear').onclick = () => { conOut.innerHTML = ''; S.conBuf = []; };
const scrollBottomBtn = document.getElementById('con-scroll-bottom');

conOut.addEventListener('scroll', () => {
  const atBottom = conOut.scrollTop + conOut.clientHeight >= conOut.scrollHeight - 30;
  scrollBottomBtn.style.display = atBottom ? 'none' : '';
});
scrollBottomBtn.onclick = () => {
  scrollToBottom();
  scrollBottomBtn.style.display = 'none';
};

const PROPS = [
  { key:'motd',              name:'Message of the Day', desc:'Message shown in the server list',            type:'text' },
  { key:'max-players',       name:'Max Players',        desc:'Maximum number of players',                   type:'number', min:1, max:1000 },
  { key:'gamemode',          name:'Default Gamemode',   desc:'Default game mode for new players',           type:'select', opts:['survival','creative','adventure','spectator'] },
  { key:'difficulty',        name:'Difficulty',         desc:'Game difficulty',                             type:'select', opts:['peaceful','easy','normal','hard'] },
  { key:'online-mode',       name:'Online Mode',        desc:'Authenticate players with Mojang servers',    type:'bool' },
  { key:'pvp',               name:'PvP',                desc:'Allow player vs player combat',               type:'bool' },
  { key:'allow-flight',      name:'Allow Flight',       desc:'Allow players to fly in survival mode',       type:'bool' },
  { key:'spawn-monsters',    name:'Spawn Monsters',     desc:'Enable monster spawning',                     type:'bool' },
  { key:'spawn-animals',     name:'Spawn Animals',      desc:'Enable animal spawning',                      type:'bool' },
  { key:'spawn-npcs',        name:'Spawn NPCs',         desc:'Enable villager spawning',                    type:'bool' },
  { key:'generate-structures',name:'Generate Structures',desc:'Generate villages, dungeons, etc.',          type:'bool' },
  { key:'view-distance',     name:'View Distance',      desc:'Server-side render distance in chunks',       type:'number', min:3, max:32 },
  { key:'simulation-distance',name:'Simulation Distance',desc:'Distance at which entities are active',     type:'number', min:3, max:32 },
  { key:'level-seed',        name:'Level Seed',         desc:'Seed used to generate the world',            type:'text', full:true },
  { key:'level-name',        name:'World Name',         desc:'Name of the world folder',                   type:'text' },
  { key:'level-type',        name:'Level Type',         desc:'World generation type',                      type:'select', opts:['minecraft:default','minecraft:flat','minecraft:large_biomes','minecraft:amplified'] },
  { key:'white-list',        name:'Whitelist',          desc:'Only allow whitelisted players',             type:'bool' },
  { key:'enforce-whitelist', name:'Enforce Whitelist',  desc:'Kick non-whitelisted players on reload',     type:'bool' },
  { key:'enable-command-block',name:'Command Blocks',   desc:'Enable command blocks',                      type:'bool' },
  { key:'max-world-size',    name:'Max World Size',     desc:'Maximum world radius in blocks',             type:'number', min:1, max:29999984 },
  { key:'resource-pack',     name:'Resource Pack URL',  desc:'URL to a resource pack',                    type:'text', full:true },
  { key:'resource-pack-sha1',name:'Resource Pack SHA-1',desc:'SHA-1 hash of the resource pack for verification', type:'text', full:true },
];

let propsLoaded = false;
async function loadProps() {
  if (propsLoaded) return;
  const grid = document.getElementById('props-grid');
  grid.innerHTML = '<div class="empty">Loading…</div>';
  const r = await api.propertiesGet();
  if (!r.ok) {
    grid.innerHTML = `<div class="empty" style="color:var(--red)">❌ ${r.error}</div>`;
    return;
  }
  grid.innerHTML = '';
  for (const def of PROPS) {
    const val = r.props[def.key] ?? '';
    const card = document.createElement('div');
    card.className = 'prop-card' + (def.full ? ' full' : '');
    card.innerHTML = `<div class="prop-key">${def.key}</div><div class="prop-name">${def.name}</div><div class="prop-desc">${def.desc}</div>`;
    const ctrl = document.createElement('div');
    if (def.type === 'bool') {
      const on = val === 'true';
      ctrl.innerHTML = `<label class="toggle-wrap"><input type="checkbox" data-key="${def.key}"${on?' checked':''}><div class="toggle-track"></div><span class="toggle-lbl">${on?'Enabled':'Disabled'}</span></label>`;
      const ck = ctrl.querySelector('input'), lb = ctrl.querySelector('.toggle-lbl');
      ck.addEventListener('change', () => { lb.textContent = ck.checked ? 'Enabled' : 'Disabled'; });
    } else if (def.type === 'select') {
      ctrl.innerHTML = `<select class="form-input form-select" data-key="${def.key}">${def.opts.map(o=>`<option value="${o}"${val===o?' selected':''}>${o}</option>`).join('')}</select>`;
    } else if (def.type === 'number') {
      ctrl.innerHTML = `<input type="number" class="form-input" data-key="${def.key}" value="${esc(val)}" min="${def.min||0}" max="${def.max||9999}">`;
    } else {
      ctrl.innerHTML = `<input type="text" class="form-input" data-key="${def.key}" value="${esc(val)}">`;
    }
    card.appendChild(ctrl);
    grid.appendChild(card);
  }
  propsLoaded = true;
}

document.getElementById('props-save').onclick = async () => {
  const updates = {};
  document.querySelectorAll('#props-grid [data-key]').forEach(el => {
    updates[el.dataset.key] = el.type === 'checkbox' ? String(el.checked) : el.value;
  });
  const r = await api.propertiesSave(updates);
  if (r.ok) {
    const msg = document.getElementById('props-saved-msg');
    msg.style.display = '';
    setTimeout(() => { msg.style.display = 'none'; }, 4000);
    toast('Saved server.properties ✓');
    propsLoaded = false;
  } else {
    toast(r.error || 'Failed to save', 'err');
  }
};

async function loadMods() {
  const list = document.getElementById('mods-list');
  const title = document.getElementById('mods-title');
  if (!S.configured) {
    list.innerHTML = '<div class="empty">No server active. Create or import a server first.</div>';
    title.textContent = 'Mods / Plugins';
    return;
  }
  const r = await api.modsList();
  if (!r.ok) { list.innerHTML = `<div class="empty" style="color:var(--red)">❌ ${r.error}</div>`; return; }
  title.textContent = r.type === 'plugins' ? 'Plugins' : 'Mods / Plugins';
  if (!r.mods.length) { list.innerHTML = `<div class="empty">No .jar files in /${r.type} folder yet</div>`; return; }
  list.innerHTML = '';
  for (const m of r.mods) {
    const div = document.createElement('div');
    div.className = 'mod-item';
    div.innerHTML = `<span>🔩</span><span class="mod-name" title="${esc(m.name)}">${esc(m.name)}</span><span class="mod-size">${fmtBytes(m.size)}</span><button class="mod-del" data-path="${esc(m.path)}">🗑 Remove</button>`;
    div.querySelector('.mod-del').onclick = async (e) => {
      if (!confirm(`Remove ${m.name}?`)) return;
      const dr = await api.modsDelete(e.target.dataset.path);
      if (dr.ok) { toast(`Removed ${m.name}`); loadMods(); }
      else toast(dr.error, 'err');
    };
    list.appendChild(div);
  }
}

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', ()=> { dropZone.classList.remove('over'); });
dropZone.addEventListener('drop', async e => {
  e.preventDefault(); dropZone.classList.remove('over');
  const paths = Array.from(e.dataTransfer.files).filter(f=>f.name.endsWith('.jar')).map(f=>f.path);
  if (!paths.length) { toast('Only .jar files supported', 'warn'); return; }
  const r = await api.modsAdd(paths);
  if (r.ok) { toast(`Added ${paths.length} file(s) ✓`); loadMods(); }
  else toast(r.error, 'err');
});
document.getElementById('mods-add').onclick = async () => {
  const r = await api.modsOpenDialog();
  if (!r.ok) return;
  const ar = await api.modsAdd(r.paths);
  if (ar.ok) { toast(`Added ${r.paths.length} file(s) ✓`); loadMods(); }
  else toast(ar.error, 'err');
};

const _skinCache = {};

function tryImageUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(url);
    img.onerror = () => reject();
    img.src = url;
    setTimeout(() => reject(), 5000);
  });
}

async function resolvePlayerHead(name) {
  const cached = _skinCache[name];
  if (cached && Date.now() - cached.ts < 300000) return cached.headUrl;

  const set = url => { _skinCache[name] = { headUrl: url, ts: Date.now() }; return url; };

  try {
    const url = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/42`;
    await tryImageUrl(url);
    return set(url);
  } catch {}

  try {
    const url = `https://skinsystem.ely.by/renders/head/${encodeURIComponent(name)}?size=42`;
    await tryImageUrl(url);
    return set(url);
  } catch {}

  try {
    const url = `https://minotar.net/avatar/${encodeURIComponent(name)}/42`;
    await tryImageUrl(url);
    return set(url);
  } catch {}

  return set(null);
}

function renderPlayers() {
  const list  = document.getElementById('players-list');
  const badge = document.getElementById('player-badge');
  const pc    = document.getElementById('pc');

  const count = S.players.length;
  if (pc) pc.textContent = count;
  badge.textContent = count;
  badge.style.display = count > 0 ? '' : 'none';

  if (!count) { list.innerHTML = '<div class="empty large">No players currently online</div>'; return; }
  list.innerHTML = '';

  for (const p of S.players) {
    const card = document.createElement('div');
    card.className = 'player-card';
    const cached = _skinCache[p.name];
    const headUrl = cached?.headUrl;

    card.innerHTML = `
      <div class="player-card-top">
        <div class="player-av" id="av-${esc(p.name)}">
          ${headUrl
            ? `<img src="${headUrl}" alt="${esc(p.name)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'player-av-fallback',textContent:'👤'}))">`
            : `<span class="player-av-fallback">👤</span>`}
        </div>
        <div class="player-name">${esc(p.name)}</div>
        <div class="player-btns">
          <button class="pbtn op"   data-p="${esc(p.name)}" data-a="op">OP</button>
          <button class="pbtn deop" data-p="${esc(p.name)}" data-a="deop">DeOP</button>
        </div>
      </div>`;

    card.querySelectorAll('[data-a]').forEach(btn => {
      btn.onclick = async () => {
        const r = await api.playerAction({ player: btn.dataset.p, action: btn.dataset.a });
        if (!r.ok) toast(r.error || 'Failed', 'err');
        else toast(`${btn.dataset.a} ${btn.dataset.p}`);
      };
    });
    list.appendChild(card);

    if (!headUrl) {
      resolvePlayerHead(p.name).then(url => {
        const avEl = document.getElementById(`av-${p.name}`);
        if (avEl) {
          avEl.innerHTML = url
            ? `<img src="${url}" alt="${esc(p.name)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'player-av-fallback',textContent:'👤'}))">`
            : `<span class="player-av-fallback">👤</span>`;
        }
      });
    }
  }
}

setInterval(async () => {
  try {
    const players = await api.playersGet();
    if (Array.isArray(players)) {
      S.players = players;
      renderPlayers();
    }
  } catch {}
}, 60000);

async function refreshPlayit() {
  const r = await api.playitGetStatus();
  applyPlayitState(r);
}
function applyPlayitState({ running, address }) {
  S.playitRunning = running;
  const dot   = document.getElementById('playit-dot');
  const txt   = document.getElementById('playit-status');
  const btnS  = document.getElementById('playit-start');
  const btnSp = document.getElementById('playit-stop');
  const aBox  = document.getElementById('playit-addr-box');
  const aVal  = document.getElementById('playit-addr');

  dot.className = `sdot ${running ? 'online' : ''}`;
  txt.textContent = running ? 'Running' : 'Stopped';
  btnS.style.display  = running ? 'none' : '';
  btnSp.style.display = running ? '' : 'none';

  if (address) {
    aBox.style.display = '';
    aVal.textContent = address;
    aVal.onclick = () => { navigator.clipboard.writeText(address).catch(()=>{}); toast('Copied address ✓'); };
  } else if (running) {
    aBox.style.display = '';
    aVal.textContent = 'Detecting tunnel address…';
    aVal.onclick = null;
  } else {
    aBox.style.display = 'none';
  }
}

const playitCon = document.getElementById('playit-con');
function appendPlayitLine(text) {
  if (playitCon.querySelector('.empty')) playitCon.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text + '\n';
  playitCon.appendChild(span);
  while (playitCon.children.length > 300) playitCon.firstChild.remove();
  playitCon.scrollTop = playitCon.scrollHeight;
}

document.getElementById('playit-start').onclick = async () => {
  const r = await api.playitStart();
  if (r.ok) { applyPlayitState({ running: true, address: null }); toast('playit.gg starting…'); }
  else toast(r.error, 'err');
};
document.getElementById('playit-stop').onclick = async () => {
  await api.playitStop();
  applyPlayitState({ running: false, address: null });
  toast('playit.gg stopped');
};

async function initFiles() {
  if (!S.configured) {
    document.getElementById('files-grid').innerHTML = '<div class="empty" style="padding:40px">No server active. Create or import a server first.</div>';
    document.getElementById('breadcrumb').textContent = '';
    return;
  }
  const root = await api.filesGetRoot();
  if (root) navTo(root, true);
}
async function navTo(dir, isRoot = false) {
  if (!isRoot && S.currentDir) S.dirStack.push(S.currentDir);
  S.currentDir = dir;
  const r = await api.filesList(dir);
  renderFiles(r);
}
function renderFiles(r) {
  const grid  = document.getElementById('files-grid');
  const bread = document.getElementById('breadcrumb');
  bread.textContent = S.currentDir || '';
  if (!r.ok) { grid.innerHTML = `<div class="empty" style="color:var(--red)">❌ ${r.error}</div>`; return; }
  if (!r.entries.length) { grid.innerHTML = '<div class="empty" style="padding:40px">Empty folder</div>'; return; }

  const join = name => (S.currentDir || '').replace(/[\\\/]$/, '') + '\\' + name;

  const table = document.createElement('table');
  table.className = 'files-table';
  table.innerHTML = `<thead><tr>
    <th class="ft-icon-cell"></th>
    <th>Name</th>
    <th style="text-align:right">Size</th>
    <th>Type</th>
    <th>Modified</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');

  for (const e of r.entries) {
    const tr = document.createElement('tr');
    tr.className = `ft-row${e.isDir ? ' ft-dir' : ''}`;
    const ext  = e.ext ? e.ext.replace('.','').toUpperCase() : '';
    const type = e.isDir ? 'Folder' : (ext ? `${ext} File` : 'File');
    tr.innerHTML = `
      <td class="ft-icon-cell">${fileIcon(e)}</td>
      <td class="ft-name-cell" title="${esc(e.name)}">${esc(e.name)}</td>
      <td class="ft-size-cell">${e.isDir ? '' : fmtBytes(e.size)}</td>
      <td class="ft-type-cell">${type}</td>
      <td class="ft-date-cell">${e.modified ? new Date(e.modified).toLocaleString() : '—'}</td>`;
    tr.ondblclick = () => {
      if (e.isDir) navTo(join(e.name));
      else api.filesOpen(join(e.name));
    };
    tr.oncontextmenu = () => api.filesShowExplorer(join(e.name));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  grid.innerHTML = '';
  grid.appendChild(table);
}
async function refreshFiles() {
  if (!S.configured) {
    document.getElementById('files-grid').innerHTML = '<div class="empty" style="padding:40px">No server active. Create or import a server first.</div>';
    document.getElementById('breadcrumb').textContent = '';
    return;
  }
  if (S.currentDir) {
    const r = await api.filesList(S.currentDir);
    renderFiles(r);
  } else {
    initFiles();
  }
}

document.getElementById('files-up').onclick = () => {
  if (S.dirStack.length > 0) {
    S.currentDir = S.dirStack.pop();
    api.filesList(S.currentDir).then(renderFiles);
  }
};
document.getElementById('files-explorer').onclick = () => {
  if (S.currentDir) api.filesShowExplorer(S.currentDir);
};

async function initQuickSettings() {
  const cfg = await api.getConfig();
  if (!cfg) return;
  const mxG = (cfg.javaArgs || '').match(/-Xmx(\d+)[Gg]/);
  const mxM = (cfg.javaArgs || '').match(/-Xmx(\d+)[Mm]/);
  if (mxG) document.getElementById('qs-ram').value = mxG[1];
  else if (mxM) document.getElementById('qs-ram').value = Math.round(parseInt(mxM[1]) / 1024);
  document.getElementById('qs-ram-hint').textContent = cfg.javaArgs || '';

  const nameEl = document.getElementById('qs-server-name');
  const typeEl = document.getElementById('qs-server-type');
  if (nameEl) nameEl.value = cfg.serverName || cfg.serverFolder?.split(/[/\\]/).pop() || '—';
  if (typeEl && cfg.serverType) {
    const typeMap = { paper:'Paper', purpur:'Purpur', fabric:'Fabric', forge:'Forge', vanilla:'Vanilla', imported:'Imported' };
    const version = cfg.mcVersion && cfg.mcVersion !== 'unknown' ? ` ${cfg.mcVersion}` : '';
    typeEl.textContent = (typeMap[cfg.serverType] || cfg.serverType) + version;
  }
}

document.getElementById('qs-ram-save').onclick = async () => {
  const val = parseInt(document.getElementById('qs-ram').value, 10);
  if (!val || val < 1) { toast('Enter a valid RAM value in GB', 'warn'); return; }
  const r = await api.updateRam({ maxRam: val });
  if (r.ok) {
    document.getElementById('qs-ram-hint').textContent = r.javaArgs;
    toast(`RAM set to ${val}GB ✓ (restart server to apply)`);
  } else toast(r.error, 'err');
};

let wsSelectedLoader = 'paper';
let wizardFromManager = false;

function showWizard(mode = 'pick', fromManager = false) {
  wizardFromManager = fromManager;
  switchTab('dashboard');
  document.getElementById('setup-inline').style.display = 'flex';
  document.getElementById('dash-main').style.display = 'none';
  document.getElementById('dash-server-ctrl').style.display = 'none';
  showWizardStep(mode);
}

function showWizardStep(step) {
  ['ws-pick','ws-create','ws-import','ws-progress'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.getElementById(`ws-${step}`).style.display = '';
}

function showDashMain() {
  document.getElementById('setup-inline').style.display = 'none';
  document.getElementById('dash-main').style.display = '';
  document.getElementById('dash-server-ctrl').style.display = '';
}

document.getElementById('ws-choose-create').onclick = () => {
  document.getElementById('ws-name').value = '';
  document.getElementById('ws-create-confirm').disabled = true;
  showWizardStep('create');
  loadVersionsForLoader('paper');
};
document.getElementById('ws-choose-import').onclick = () => {
  showWizardStep('import');
};
document.getElementById('ws-create-back').onclick = () => {
  if (wizardFromManager) {
    showDashMain();
    document.getElementById('server-manager-overlay').style.display = 'none';
  } else {
    showWizardStep('pick');
  }
};
document.getElementById('ws-import-back').onclick = () => {
  if (wizardFromManager) {
    showDashMain();
    document.getElementById('server-manager-overlay').style.display = 'none';
  } else {
    showWizardStep('pick');
  }
};

document.querySelectorAll('.loader-card').forEach(card => {
  card.onclick = () => {
    document.querySelectorAll('.loader-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    wsSelectedLoader = card.dataset.loader;
    loadVersionsForLoader(wsSelectedLoader);
  };
});

async function loadVersionsForLoader(type) {
  const sel = document.getElementById('ws-version');
  const hint = document.getElementById('ws-version-hint');
  const confirmBtn = document.getElementById('ws-create-confirm');
  sel.innerHTML = '<option value="">Loading versions…</option>';
  confirmBtn.disabled = true;
  hint.textContent = 'Fetching version list…';

  const r = await api.mcGetVersions({ type });
  if (!r.ok) {
    sel.innerHTML = '<option value="">Failed to load versions</option>';
    hint.textContent = `Error: ${r.error}`;
    return;
  }
  sel.innerHTML = r.versions.map(v => `<option value="${v}">${v}</option>`).join('');
  hint.textContent = `${r.versions.length} versions available`;
  checkCreateForm();
}

function checkCreateForm() {
  const name = document.getElementById('ws-name').value.trim();
  const version = document.getElementById('ws-version').value;
  document.getElementById('ws-create-confirm').disabled = !(name && version);
}
document.getElementById('ws-name').addEventListener('input', checkCreateForm);
document.getElementById('ws-version').addEventListener('change', checkCreateForm);

document.getElementById('ws-create-confirm').onclick = async () => {
  const name    = document.getElementById('ws-name').value.trim();
  const version = document.getElementById('ws-version').value;
  const ram     = parseInt(document.getElementById('ws-ram').value, 10) || 2;
  if (!name || !version) return;

  showWizardStep('progress');
  document.getElementById('ws-progress-title').textContent = `Creating "${name}"…`;
  document.getElementById('ws-progress-pct').textContent = '0%';
  document.getElementById('ws-progress-msg').textContent = 'Starting…';
  document.getElementById('ws-progress-bar').style.width = '0%';
  document.getElementById('ws-progress-log').textContent = '';
  document.getElementById('ws-progress-log').classList.remove('visible');

  const r = await api.serversCreate({ name, type: wsSelectedLoader, mcVersion: version, ram });
  if (r.ok) {
    toast(`Server "${name}" created ✓`);
    S.configured = true;
    showDashMain();
    propsLoaded = false;
    S.currentDir = null; S.dirStack = [];
    _diskCache = { world: 0, ts: 0 };
    initQuickSettings();
    pollDisk();
    switchTab('dashboard');
  } else {
    showWizardStep('create');
    toast(r.error || 'Failed to create server', 'err');
  }
};

let wsImportFolder = null;
let wsImportJars = [];

document.getElementById('ws-import-browse').onclick = async () => {
  const r = await api.chooseFolder();
  if (!r.ok) return;
  wsImportFolder = r.folder;
  document.getElementById('ws-import-folder').value = r.folder;
  const msg = document.getElementById('ws-import-folder-msg');
  msg.textContent = r.hasProps ? '✓ Found server.properties' : '⚠ No server.properties found';
  msg.className = `setup-msg ${r.hasProps ? 'ok' : ''}`;

  const folderName = r.folder.split(/[/\\]/).pop();
  if (!document.getElementById('ws-import-name').value) {
    document.getElementById('ws-import-name').value = folderName;
  }

  wsImportJars = r.jars || [];
  const jarSel = document.getElementById('ws-import-jar');
  jarSel.innerHTML = wsImportJars.length
    ? wsImportJars.map(j => `<option value="${j}">${j}</option>`).join('')
    : '<option value="server.jar">server.jar (not found — add it later)</option>';

  checkImportForm();
};
document.getElementById('ws-import-name').addEventListener('input', checkImportForm);

function checkImportForm() {
  const folder = document.getElementById('ws-import-folder').value;
  const name   = document.getElementById('ws-import-name').value.trim();
  document.getElementById('ws-import-confirm').disabled = !(folder && name);
}

document.getElementById('ws-import-confirm').onclick = async () => {
  const folder = document.getElementById('ws-import-folder').value;
  const name   = document.getElementById('ws-import-name').value.trim();
  const jar    = document.getElementById('ws-import-jar').value;
  const ram    = parseInt(document.getElementById('ws-import-ram').value, 10) || 2;
  if (!folder || !name) return;

  showWizardStep('progress');
  document.getElementById('ws-progress-title').textContent = `Importing "${name}"…`;
  document.getElementById('ws-progress-pct').textContent = '0%';
  document.getElementById('ws-progress-msg').textContent = 'Copying files…';
  document.getElementById('ws-progress-bar').style.width = '5%';

  const r = await api.serversImport({ sourceFolder: folder, name, jar, ram });
  if (r.ok) {
    toast(`Server "${name}" imported ✓`);
    S.configured = true;
    showDashMain();
    propsLoaded = false;
    S.currentDir = null; S.dirStack = [];
    _diskCache = { world: 0, ts: 0 };
    initQuickSettings();
    pollDisk();
    switchTab('dashboard');
  } else {
    showWizardStep('import');
    toast(r.error || 'Failed to import server', 'err');
  }
};

api.on('create:progress', ({ pct, msg }) => {
  document.getElementById('ws-progress-bar').style.width = `${pct}%`;
  document.getElementById('ws-progress-pct').textContent = `${pct}%`;
  document.getElementById('ws-progress-msg').textContent = msg;
});
api.on('create:log', ({ msg }) => {
  if (!msg.trim()) return;
  const log = document.getElementById('ws-progress-log');
  log.classList.add('visible');
  log.textContent += msg + '\n';
  log.scrollTop = log.scrollHeight;
});

document.getElementById('nav-servers-btn').onclick = openServerManager;
document.getElementById('sm-close').onclick = () => {
  document.getElementById('server-manager-overlay').style.display = 'none';
};
document.getElementById('server-manager-overlay').onclick = e => {
  if (e.target === document.getElementById('server-manager-overlay'))
    document.getElementById('server-manager-overlay').style.display = 'none';
};
document.getElementById('sm-create-btn').onclick = () => {
  document.getElementById('server-manager-overlay').style.display = 'none';
  document.getElementById('ws-name').value = '';
  document.getElementById('ws-progress-log').textContent = '';
  document.getElementById('ws-progress-log').classList.remove('visible');
  document.getElementById('ws-create-confirm').disabled = true;
  showWizard('create', true);
  loadVersionsForLoader('paper');
  document.querySelectorAll('.loader-card').forEach(c => c.classList.remove('selected'));
  document.querySelector('.loader-card[data-loader="paper"]').classList.add('selected');
  wsSelectedLoader = 'paper';
};
document.getElementById('sm-import-btn').onclick = () => {
  document.getElementById('server-manager-overlay').style.display = 'none';
  showWizard('import', true);
  document.getElementById('ws-import-folder').value = '';
  document.getElementById('ws-import-name').value = '';
  document.getElementById('ws-import-folder-msg').textContent = '';
  wsImportFolder = null;
  document.getElementById('ws-import-confirm').disabled = true;
};

async function openServerManager() {
  document.getElementById('server-manager-overlay').style.display = 'flex';
  await renderServerManager();
}

async function renderServerManager() {
  const list = document.getElementById('sm-server-list');
  list.innerHTML = '<div class="empty" style="padding:20px">Loading…</div>';
  const r = await api.serversList();
  if (!r.ok || !r.servers.length) {
    list.innerHTML = '<div class="empty" style="padding:20px">No managed servers yet. Create one below.</div>';
    return;
  }
  list.innerHTML = '';
  const typeIcon = { paper:'📄', purpur:'🟣', fabric:'🧵', forge:'⚒', vanilla:'🌿', imported:'📦', unknown:'🎮' };
  for (const srv of r.servers) {
    const item = document.createElement('div');
    item.className = `sm-server-item${srv.isActive ? ' active' : ''}`;
    const icon = typeIcon[srv.type] || '🎮';
    const typeName = srv.type ? srv.type.charAt(0).toUpperCase() + srv.type.slice(1) : 'Unknown';
    const verText = srv.mcVersion && srv.mcVersion !== 'unknown' ? ` ${srv.mcVersion}` : '';
    item.innerHTML = `
      <div class="sm-server-icon">${icon}</div>
      <div class="sm-server-info">
        <div class="sm-server-name">
          ${srv.name || srv.folder.split(/[/\\]/).pop()}
          ${srv.isActive ? '<span class="sm-active-badge">● Active</span>' : ''}
        </div>
        <div class="sm-server-meta">${typeName}${verText} &nbsp;·&nbsp; ${srv.folder}</div>
      </div>
      <div class="sm-server-actions">
        ${srv.isActive ? '' : `<button class="btn btn-success btn-sm sm-switch-btn" data-folder="${srv.folder}">Switch</button>`}
        <button class="btn btn-danger btn-sm sm-del-btn" data-folder="${srv.folder}" data-name="${srv.name || ''}">Delete</button>
      </div>`;
    list.appendChild(item);
  }

  list.querySelectorAll('.sm-switch-btn').forEach(btn => {
    btn.onclick = async () => {
      if (S.serverState !== 'stopped') {
        toast('Stop the current server before switching', 'warn'); return;
      }
      const r = await api.serversSwitch({ folder: btn.dataset.folder });
      if (!r.ok) { toast(r.error, 'err'); return; }
      S.configured = true;
      showDashMain();
      propsLoaded = false;
      S.currentDir = null; S.dirStack = [];
      _diskCache = { world: 0, ts: 0 };
      initQuickSettings();
      pollDisk();
      applyState('stopped');
      S.players = []; renderPlayers(); resetStats();
      document.getElementById('server-manager-overlay').style.display = 'none';
      switchTab('dashboard');
      toast(`Switched to "${btn.dataset.folder.split(/[/\\]/).pop()}" ✓`);
    };
  });

  list.querySelectorAll('.sm-del-btn').forEach(btn => {
    btn.onclick = async () => {
      const name = btn.dataset.name || btn.dataset.folder.split(/[/\\]/).pop();
      if (!confirm(`Delete server "${name}"?\n\nThis will permanently delete ALL server files (world, configs, plugins). This cannot be undone.`)) return;
      const r = await api.serversDelete({ folder: btn.dataset.folder });
      if (!r.ok) { toast(r.error, 'err'); return; }
      toast(`Server "${name}" deleted`);
      if (r.newConfig) {
        S.configured = true;
        showDashMain();
        propsLoaded = false;
        S.currentDir = null; S.dirStack = [];
        initQuickSettings();
        pollDisk();
        applyState('stopped');
        S.players = []; renderPlayers(); resetStats();
        document.getElementById('server-manager-overlay').style.display = 'none';
        switchTab('dashboard');
      } else if (r.newConfig === null) {
        S.configured = false;
        S.currentDir = null; S.dirStack = [];
        document.getElementById('server-manager-overlay').style.display = 'none';
        showWizard('pick');
      }
      await renderServerManager();
    };
  });
}

api.on('console:line',    d => appendLine(d));
api.on('server:state',    d => {
  applyState(d.state);
  if (d.state === 'stopped') { S.players = []; renderPlayers(); resetStats(); }
  if (d.state === 'running' && S.tab === 'files') refreshFiles();
});
api.on('players:updated', d => {
  S.players = d;
  renderPlayers();
  if (d.length > 0 && S.serverState === 'stopped') applyState('running');
});
api.on('stats:update',    d => applyStats(d));
api.on('playit:line',     d => appendPlayitLine(d.text));
api.on('playit:address',  d => applyPlayitState({ running: true, address: d.address }));
api.on('playit:state',    d => applyPlayitState({ running: d.running, address: d.running ? undefined : null }));

setInterval(async () => {
  try {
    const sv = await api.serverGetState();
    if (sv.state !== S.serverState) {
      applyState(sv.state);
      if (sv.state === 'stopped') { S.players = []; renderPlayers(); resetStats(); }
    }
    if (Array.isArray(sv.players) && sv.players.length !== S.players.length) {
      S.players = sv.players;
      renderPlayers();
    }
  } catch (_) {}
}, 5000);

async function init() {
  document.querySelectorAll('.tab').forEach(t => { t.style.display = 'none'; });
  document.getElementById('tab-dashboard').style.display = 'flex';

  const state = await api.getState();
  if (state.configured) {
    S.configured = true;
    showDashMain();

    const sv = await api.serverGetState();
    applyState(sv.state);
    S.players = sv.players || [];
    renderPlayers();
    if (sv.uptime) startUptimeTick(sv.uptime);
    initQuickSettings();
    pollDisk();

    if (state.serverRunning || sv.state === 'running') {
      const banner = document.createElement('div');
      banner.id = 'reattach-banner';
      banner.style.cssText = 'background:rgba(255,215,64,0.08);border:1px solid #776000;border-radius:6px;padding:9px 14px;margin:0 22px 4px;font-size:12px;color:var(--yellow);display:flex;align-items:center;justify-content:space-between;';
      banner.innerHTML = `<span>⚠ Server was already running when the app was reopened. Console input is limited — restart from the app to regain full control.</span>
        <button onclick="this.parentElement.remove()" style="background:none;border:none;color:var(--yellow);cursor:pointer;font-size:16px;padding:0 0 0 12px">✕</button>`;
      const dashMain = document.getElementById('dash-main');
      dashMain.insertBefore(banner, dashMain.firstChild);
      if (state.serverRunning) toast('Server detected running — re-attached ✓', 'warn');
    }
  } else {
    showWizard('pick');
  }
}

window.addEventListener('DOMContentLoaded', init);
