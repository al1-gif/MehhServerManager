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
  customTunnels: [],   
  tunnelRunning: {},   
  tunnelOutput: {},    
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
      // Re-render existing dir to catch any new files
      api.filesList(S.currentDir).then(renderFiles);
    }
  }
  if (name === 'download-mods')    initDlMods();
  if (name === 'download-plugins') initDlPlugins();
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
  const ds   = document.getElementById('d-status');
  const bS   = document.getElementById('btn-start');
  const bSp  = document.getElementById('btn-stop');
  const bR   = document.getElementById('btn-restart');

  const map = {
    stopped:  { cls: '',         lbl: 'Offline',   val: 'Offline',   valCls: '' },
    starting: { cls: 'starting', lbl: 'Starting…', val: 'Starting…', valCls: 'starting' },
    running:  { cls: 'online',   lbl: 'Online',    val: 'Online',    valCls: 'online' },
    stopping: { cls: 'stopping', lbl: 'Stopping…', val: 'Stopping…', valCls: 'stopping' },
  };
  const info = map[state] || map.stopped;

  dot.className = `sdot ${info.cls}`;
  lbl.textContent = info.lbl;
  if (ds) { ds.textContent = info.val; ds.className = `stat-val ${info.valCls}`; }

  if (bS)  bS.style.display  = state === 'stopped'  ? '' : 'none';
  if (bSp) bSp.style.display = (state === 'running' || state === 'stopping') ? '' : 'none';
  if (bR)  bR.style.display  = state === 'running'  ? '' : 'none';
}

document.getElementById('btn-start').onclick   = async () => { const r = await api.serverStart();   if (!r.ok) toast(r.error, 'err'); };
document.getElementById('btn-stop').onclick    = async () => { const r = await api.serverStop();    if (!r.ok) toast(r.error, 'err'); };
document.getElementById('btn-restart').onclick = async () => { const r = await api.serverRestart(); if (!r.ok) toast(r.error, 'err'); };

function applyStats({ ram, maxRam, cpu, uptime, state }) {
  const dr = document.getElementById('d-ram');
  const dc = document.getElementById('d-cpu');
  const du = document.getElementById('d-uptime');
  if (dr) {
    if (ram && maxRam) dr.textContent = `${ram >= 1024 ? (ram/1024).toFixed(1)+' GB' : ram+' MB'} / ${maxRam}`;
    else if (ram) dr.textContent = `${ram} MB`;
    else dr.textContent = '—';
  }
  if (dc) dc.textContent = cpu != null ? `${cpu}%` : '—';
  if (du) du.textContent = fmtUptime(uptime);
  if (state && state !== S.serverState) applyState(state);
}
function resetStats() {
  const d = id => document.getElementById(id);
  if (d('d-ram')) d('d-ram').textContent = '—';
  if (d('d-cpu')) d('d-cpu').textContent = '—';
  if (d('d-uptime')) d('d-uptime').textContent = '—';
  if (d('d-players')) d('d-players').textContent = '0';
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
const miniCon = document.getElementById('mini-con');
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

  const ms = document.createElement('span');
  ms.className = `l-${data.type || 'info'}`;
  ms.textContent = data.text.substring(0, 120) + '\n';
  miniCon.appendChild(ms);
  while (miniCon.children.length > 25) miniCon.firstChild.remove();
  miniCon.scrollTop = miniCon.scrollHeight;
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

const MC_COLOR_MAP = {
  '0':'mc-0','1':'mc-1','2':'mc-2','3':'mc-3','4':'mc-4','5':'mc-5',
  '6':'mc-6','7':'mc-7','8':'mc-8','9':'mc-9','a':'mc-a','b':'mc-b',
  'c':'mc-c','d':'mc-d','e':'mc-e','f':'mc-f',
  'l':'mc-l','o':'mc-o','n':'mc-n','m':'mc-m',
};

function parseMOTD(raw) {
  if (!raw) return '<span style="color:#aaa">No MOTD set</span>';
  
  const parts = raw.split(/(?=§[0-9a-fklmnor])/i);
  let html = '';
  let classes = [];
  for (const part of parts) {
    const match = part.match(/^§([0-9a-fklmnor])/i);
    if (match) {
      const code = match[1].toLowerCase();
      if (code === 'r') { classes = []; }
      else if (MC_COLOR_MAP[code]) {
        
        if ('0123456789abcdef'.includes(code)) {
          classes = classes.filter(c => !c.startsWith('mc-') || c === 'mc-l' || c === 'mc-o' || c === 'mc-n' || c === 'mc-m');
        }
        classes.push(MC_COLOR_MAP[code]);
      }
      const text = esc(part.substring(2));
      if (text) html += `<span class="${classes.join(' ')}">${text}</span>`;
    } else {
      html += `<span style="color:#fff">${esc(part)}</span>`;
    }
  }
  return html || `<span style="color:#fff">${esc(raw)}</span>`;
}

function updateMOTDPreview(value) {
  const preview = document.getElementById('motd-preview-content');
  if (preview) preview.innerHTML = parseMOTD(value);
}

const PROPS = [
  { key:'motd',              name:'Message of the Day', desc:'Message shown in the server list',            type:'text', isMOTD: true },
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

    
    if (def.isMOTD) {
      const prevWrap = document.createElement('div');
      prevWrap.className = 'motd-preview-wrap';
      prevWrap.innerHTML = `<div class="motd-preview-label">In-game Preview</div>
        <div class="motd-preview-box"><span id="motd-preview-content"></span></div>`;
      card.appendChild(prevWrap);
      
      const inp = ctrl.querySelector('input');
      if (inp) {
        inp.addEventListener('input', () => updateMOTDPreview(inp.value));
        
        setTimeout(() => updateMOTDPreview(val), 0);
      }
    }

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

  // mc-heads.net: works by username for both Mojang and offline players — no UUID needed
  try {
    const url = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/42`;
    await tryImageUrl(url);
    return set(url);
  } catch {}

  // ely.by skin system (for players using ely.by auth)
  try {
    const url = `https://skinsystem.ely.by/renders/head/${encodeURIComponent(name)}?size=42`;
    await tryImageUrl(url);
    return set(url);
  } catch {}

  // minotar fallback
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
  const dp    = document.getElementById('d-players');
  const mp    = document.getElementById('mini-players');

  const count = S.players.length;
  if (pc) pc.textContent = count;
  if (dp) dp.textContent = count;
  badge.textContent = count;
  badge.style.display = count > 0 ? '' : 'none';

  
  if (mp) {
    if (count > 0) {
      mp.innerHTML = S.players.map(p => {
        const cached = _skinCache[p.name];
        const img = cached
          ? `<img class="mp-avatar" src="${cached.headUrl}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{style:'font-size:12px',textContent:'👤'}))">`
          : `<span style="font-size:12px">👤</span>`;
        return `<div class="mp-item">${img}${esc(p.name)}</div>`;
      }).join('');
    } else {
      mp.innerHTML = '<div class="empty">No players online</div>';
    }
  }

  
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
          <button class="pbtn kick" data-p="${esc(p.name)}" data-a="kick">Kick</button>
          <button class="pbtn ban"  data-p="${esc(p.name)}" data-a="ban">Ban</button>
        </div>
      </div>`;

    card.querySelectorAll('[data-a]').forEach(btn => {
      btn.onclick = async () => {
        if (btn.dataset.a === 'ban' && !confirm(`Ban ${btn.dataset.p}?`)) return;
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
        
        const mp = document.getElementById('mini-players');
        if (mp && mp.querySelector('.mp-item')) renderPlayers();
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
  
  const cfg = await api.getConfig();
  if (cfg && cfg.playitPath) {
    document.getElementById('playit-path-input').value = cfg.playitPath;
    document.getElementById('playit-path-hint').textContent = '✓ Path saved';
  }
  loadCustomTunnels();
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
document.getElementById('playit-link').onclick = e => {
  e.preventDefault();
  api.filesOpen('https://playit.gg').catch(()=>{});
};

document.getElementById('playit-browse-btn').onclick = async () => {
  const r = await api.playitBrowsePath();
  if (!r.ok) return;
  document.getElementById('playit-path-input').value = r.path;
  document.getElementById('playit-path-hint').textContent = '✓ Path saved — click Start to run';
  toast('playit.exe path saved ✓');
};

async function loadCustomTunnels() {
  const r = await api.tunnelList();
  S.customTunnels = r.tunnels || [];
  const running = await api.tunnelRunningIds();
  (running.ids || []).forEach(id => { S.tunnelRunning[id] = true; });
  renderCustomTunnels();
}

function renderCustomTunnels() {
  const container = document.getElementById('custom-tunnels-list');
  if (!S.customTunnels.length) {
    container.innerHTML = '<div class="empty" style="padding:20px 0">No custom tunnels added yet</div>';
    return;
  }
  container.innerHTML = '';
  for (const t of S.customTunnels) {
    const running = !!S.tunnelRunning[t.id];
    const item = document.createElement('div');
    item.className = 'custom-tunnel-item';
    item.id = `ctunnel-${t.id}`;
    item.innerHTML = `
      <div class="custom-tunnel-top">
        <span class="sdot ${running ? 'online' : ''}" id="ct-dot-${t.id}"></span>
        <span class="custom-tunnel-name">${esc(t.name)}</span>
        <span style="font-size:12px;color:var(--t3)">${running ? 'Running' : 'Stopped'}</span>
      </div>
      <div class="custom-tunnel-exe" title="${esc(t.execPath)}">${esc(t.execPath)}${t.args ? ' ' + esc(t.args) : ''}</div>
      <div class="custom-tunnel-actions">
        ${running
          ? `<button class="btn btn-danger btn-sm" id="ct-stop-${t.id}">■ Stop</button>`
          : `<button class="btn btn-success btn-sm" id="ct-start-${t.id}">▶ Start</button>`}
        <button class="btn btn-secondary btn-sm" id="ct-log-${t.id}">📋 Log</button>
        <button class="ctl-del" id="ct-del-${t.id}">🗑 Remove</button>
      </div>
      <div class="custom-tunnel-con" id="ct-con-${t.id}"></div>`;
    container.appendChild(item);

    
    const startBtn = document.getElementById(`ct-start-${t.id}`);
    const stopBtn  = document.getElementById(`ct-stop-${t.id}`);
    const logBtn   = document.getElementById(`ct-log-${t.id}`);
    const delBtn   = document.getElementById(`ct-del-${t.id}`);
    const con      = document.getElementById(`ct-con-${t.id}`);

    
    if (S.tunnelOutput[t.id]) {
      con.className = 'custom-tunnel-con visible';
      con.textContent = S.tunnelOutput[t.id].join('\n');
      con.scrollTop = con.scrollHeight;
    }

    if (startBtn) startBtn.onclick = async () => {
      const res = await api.tunnelStart({ id: t.id, execPath: t.execPath, args: t.args || '', postCmd: t.postCmd || '' });
      if (!res.ok) toast(res.error, 'err');
      else { S.tunnelRunning[t.id] = true; toast(`${t.name} started`); renderCustomTunnels(); }
    };
    if (stopBtn) stopBtn.onclick = async () => {
      await api.tunnelStop({ id: t.id });
      S.tunnelRunning[t.id] = false;
      toast(`${t.name} stopped`);
      renderCustomTunnels();
    };
    if (logBtn) logBtn.onclick = () => {
      con.classList.toggle('visible');
    };
    if (delBtn) delBtn.onclick = async () => {
      if (running && !confirm(`"${t.name}" is running. Stop and remove it?`)) return;
      if (running) {
        await api.tunnelStop({ id: t.id });
        S.tunnelRunning[t.id] = false;
      }
      S.customTunnels = S.customTunnels.filter(x => x.id !== t.id);
      await api.tunnelSaveAll(S.customTunnels);
      renderCustomTunnels();
      toast('Tunnel removed');
    };
  }
}

document.getElementById('tunnel-add-btn').onclick = () => {
  document.getElementById('tnl-name').value = '';
  document.getElementById('tnl-exe').value = '';
  document.getElementById('tnl-args').value = '';
  document.getElementById('tnl-postcmd').value = '';
  document.getElementById('tnl-confirm').disabled = true;
  document.getElementById('tunnel-add-overlay').style.display = 'flex';
};
document.getElementById('tunnel-add-overlay').onclick = e => {
  if (e.target === document.getElementById('tunnel-add-overlay'))
    document.getElementById('tunnel-add-overlay').style.display = 'none';
};
document.getElementById('tnl-cancel').onclick = () => {
  document.getElementById('tunnel-add-overlay').style.display = 'none';
};
document.getElementById('tnl-browse').onclick = async () => {
  const r = await api.tunnelBrowseExe();
  if (!r.ok) return;
  document.getElementById('tnl-exe').value = r.path;
  checkTnlForm();
};
function checkTnlForm() {
  const name = document.getElementById('tnl-name').value.trim();
  const exe  = document.getElementById('tnl-exe').value.trim();
  document.getElementById('tnl-confirm').disabled = !(name && exe);
}
document.getElementById('tnl-name').addEventListener('input', checkTnlForm);
document.getElementById('tnl-confirm').onclick = async () => {
  const name    = document.getElementById('tnl-name').value.trim();
  const exe     = document.getElementById('tnl-exe').value.trim();
  const args    = document.getElementById('tnl-args').value.trim();
  const postCmd = document.getElementById('tnl-postcmd').value.trim();
  if (!name || !exe) return;
  const newTunnel = { id: `t_${Date.now()}`, name, execPath: exe, args, postCmd };
  S.customTunnels.push(newTunnel);
  await api.tunnelSaveAll(S.customTunnels);
  document.getElementById('tunnel-add-overlay').style.display = 'none';
  renderCustomTunnels();
  toast(`Tunnel "${name}" added ✓`);
};

api.on('tunnel:output', d => {
  if (!S.tunnelOutput[d.id]) S.tunnelOutput[d.id] = [];
  S.tunnelOutput[d.id].push(d.text);
  if (S.tunnelOutput[d.id].length > 200) S.tunnelOutput[d.id].shift();
  const con = document.getElementById(`ct-con-${d.id}`);
  if (con) {
    con.classList.add('visible');
    con.textContent = S.tunnelOutput[d.id].join('\n');
    con.scrollTop = con.scrollHeight;
  }
});
api.on('tunnel:state', d => {
  S.tunnelRunning[d.id] = d.running;
  const dot = document.getElementById(`ct-dot-${d.id}`);
  if (dot) { dot.className = `sdot ${d.running ? 'online' : ''}`; }
  if (!d.running) renderCustomTunnels();
});

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
    <th></th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');

  for (const e of r.entries) {
    const tr = document.createElement('tr');
    tr.className = `ft-row${e.isDir ? ' ft-dir' : ''}`;
    const ext  = e.ext ? e.ext.replace('.','').toUpperCase() : '';
    const type = e.isDir ? 'Folder' : (ext ? `${ext} File` : 'File');
    const editBtn = (!e.isDir && e.editable)
      ? `<button class="ft-edit-btn" data-path="${esc(join(e.name))}" title="Edit">✏ Edit</button>`
      : '';
    tr.innerHTML = `
      <td class="ft-icon-cell">${fileIcon(e)}</td>
      <td class="ft-name-cell" title="${esc(e.name)}">${esc(e.name)}</td>
      <td class="ft-size-cell">${e.isDir ? '' : fmtBytes(e.size)}</td>
      <td class="ft-type-cell">${type}</td>
      <td class="ft-date-cell">${e.modified ? new Date(e.modified).toLocaleString() : '—'}</td>
      <td class="ft-actions-cell">${editBtn}</td>`;
    tr.ondblclick = (ev) => {
      
      if (ev.target.closest('.ft-edit-btn')) return;
      if (e.isDir) navTo(join(e.name));
      else if (e.editable) openEditor(join(e.name));
      else api.filesOpen(join(e.name));
    };
    tr.oncontextmenu = () => api.filesShowExplorer(join(e.name));
    
    const editEl = tr.querySelector('.ft-edit-btn');
    if (editEl) {
      editEl.onclick = (ev) => {
        ev.stopPropagation();
        openEditor(editEl.dataset.path);
      };
    }
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
document.getElementById('files-refresh').onclick = () => refreshFiles();
document.getElementById('files-explorer').onclick = () => {
  if (S.currentDir) api.filesShowExplorer(S.currentDir);
};

let _editorFilePath = null;
let _editorSavedTimer = null;

async function openEditor(filePath) {
  const r = await api.filesRead(filePath);
  if (!r.ok) { toast(`Cannot open file: ${r.error}`, 'err'); return; }
  _editorFilePath = filePath;
  const overlay = document.getElementById('editor-overlay');
  const textarea = document.getElementById('editor-textarea');
  const fpLabel  = document.getElementById('editor-filepath');
  const savedBar = document.getElementById('editor-saved-bar');

  fpLabel.textContent = filePath;
  textarea.value = r.content;
  savedBar.style.display = 'none';
  overlay.style.display = 'flex';
  textarea.focus();
  updateEditorFooter();
}

function updateEditorFooter() {
  const ta = document.getElementById('editor-textarea');
  const pos = ta.selectionStart;
  const text = ta.value.substring(0, pos);
  const lines = text.split('\n');
  const ln = lines.length;
  const col = lines[lines.length - 1].length + 1;
  document.getElementById('editor-line-col').textContent = `Ln ${ln}, Col ${col}`;
  document.getElementById('editor-char-count').textContent = `${ta.value.length} chars`;
}

document.getElementById('editor-textarea').addEventListener('keyup', updateEditorFooter);
document.getElementById('editor-textarea').addEventListener('click', updateEditorFooter);
document.getElementById('editor-textarea').addEventListener('keydown', e => {
  
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + 2;
  }
  
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveEditorFile();
  }
});

async function saveEditorFile() {
  if (!_editorFilePath) return;
  const content = document.getElementById('editor-textarea').value;
  const r = await api.filesWrite({ path: _editorFilePath, content });
  if (r.ok) {
    const bar = document.getElementById('editor-saved-bar');
    bar.style.display = '';
    clearTimeout(_editorSavedTimer);
    _editorSavedTimer = setTimeout(() => { bar.style.display = 'none'; }, 3000);
    toast('File saved ✓');
    
    if (S.currentDir) api.filesList(S.currentDir).then(renderFiles);
  } else {
    toast(`Save failed: ${r.error}`, 'err');
  }
}

document.getElementById('editor-save').onclick = saveEditorFile;
document.getElementById('editor-close').onclick = () => {
  document.getElementById('editor-overlay').style.display = 'none';
  _editorFilePath = null;
};

document.getElementById('editor-overlay').onclick = e => {
  if (e.target === document.getElementById('editor-overlay'))
    document.getElementById('editor-overlay').style.display = 'none';
};
// Re-focus the textarea whenever the user clicks anywhere inside the modal
// (Electron can lose focus when the server process spawns)
document.querySelector('#editor-overlay .editor-modal')?.addEventListener('mousedown', e => {
  if (!e.target.closest('button')) {
    setTimeout(() => document.getElementById('editor-textarea').focus(), 0);
  }
});

async function initQuickSettings() {
  const cfg = await api.getConfig();
  if (!cfg) return;
  const mxG = (cfg.javaArgs || '').match(/-Xmx(\d+)[Gg]/);
  const mxM = (cfg.javaArgs || '').match(/-Xmx(\d+)[Mm]/);
  if (mxG) document.getElementById('qs-ram').value = mxG[1];
  else if (mxM) document.getElementById('qs-ram').value = Math.round(parseInt(mxM[1]) / 1024);
  document.getElementById('qs-ram-hint').textContent = cfg.javaArgs || '';

  // Update server name display
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

// ── Wizard (Server Setup) ──────────────────────────────────────────────────

let wsSelectedLoader = 'paper';

let wizardFromManager = false; // true = opened from Server Manager, back should go to dashboard

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

// Choice cards
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
    // Return to dashboard — they already have a server
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

// Loader selection
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
    resetDlTabs();
    switchTab('dashboard');
  } else {
    showWizardStep('create');
    toast(r.error || 'Failed to create server', 'err');
  }
};

// Import flow
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

  // Auto-fill name from folder name
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
    resetDlTabs();
    switchTab('dashboard');
  } else {
    showWizardStep('import');
    toast(r.error || 'Failed to import server', 'err');
  }
};

// Progress events
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

// ── Server Manager Modal ──────────────────────────────────────────────────

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
  // Clear previous name and progress log
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

  // Bind switch buttons
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
      resetDlTabs();
      document.getElementById('server-manager-overlay').style.display = 'none';
      switchTab('dashboard');
      toast(`Switched to "${btn.dataset.folder.split(/[/\\]/).pop()}" ✓`);
    };
  });

  // Bind delete buttons
  list.querySelectorAll('.sm-del-btn').forEach(btn => {
    btn.onclick = async () => {
      const name = btn.dataset.name || btn.dataset.folder.split(/[/\\]/).pop();
      if (!confirm(`Delete server "${name}"?\n\nThis will permanently delete ALL server files (world, configs, plugins). This cannot be undone.`)) return;
      const r = await api.serversDelete({ folder: btn.dataset.folder });
      if (!r.ok) { toast(r.error, 'err'); return; }
      toast(`Server "${name}" deleted`);
      if (r.newConfig) {
        // Active server deleted, switched to another one
        S.configured = true;
        showDashMain();
        propsLoaded = false;
        S.currentDir = null; S.dirStack = [];
        initQuickSettings();
        pollDisk();
        applyState('stopped');
        S.players = []; renderPlayers(); resetStats();
        resetDlTabs();
        document.getElementById('server-manager-overlay').style.display = 'none';
        switchTab('dashboard');
      } else if (r.newConfig === null) {
        // No servers left — show wizard
        S.configured = false;
        S.currentDir = null; S.dirStack = [];
        resetDlTabs();
        document.getElementById('server-manager-overlay').style.display = 'none';
        showWizard('pick');
      }
      // else: non-active server deleted — just refresh the list
      await renderServerManager();
    };
  });
}

api.on('console:line',    d => appendLine(d));
api.on('server:state',    d => {
  applyState(d.state);
  if (d.state === 'stopped') { S.players = []; renderPlayers(); resetStats(); }
  // Refresh files tab when server finishes starting — first-run creates server.properties etc.
  if (d.state === 'running' && S.tab === 'files') refreshFiles();
});
api.on('players:updated', d => {
  S.players = d;
  renderPlayers();
  // If we have players but state shows offline, self-heal the UI —
  // the main process will correct the true state via stats:update shortly
  if (d.length > 0 && S.serverState === 'stopped') applyState('running');
});
api.on('stats:update',    d => applyStats(d));
api.on('playit:line',     d => appendPlayitLine(d.text));
api.on('playit:address',  d => applyPlayitState({ running: true, address: d.address }));
api.on('playit:state',    d => applyPlayitState({ running: d.running, address: d.running ? undefined : null }));

// Periodic state re-sync: every 5 seconds ask main process for the real state.
// This catches any case where IPC events were missed (restart races, re-attach, etc.)
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
    if (sv.uptime) applyStats({ ram: 0, cpu: 0, uptime: sv.uptime, state: sv.state });
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

// ══════════════════════════════════════════════════════════════════════════════
// ── DOWNLOAD MODS & PLUGINS ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── CurseForge Built-in API Key ───────────────────────────────────────────────
// (Removed — CurseForge and Hangar sources have been removed)

let dlModsTimer     = null;
let dlPluginsTimer  = null;
let dlActiveConfig  = null;
let dlModsInitialized    = false;
let dlPluginsInitialized = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function serverSupportsMods(type)    { return ['fabric','forge','neoforge'].includes(type); }
function serverSupportsPlugins(type) { return ['paper','purpur','spigot','bukkit','imported'].includes(type); }

async function refreshDlConfig() {
  try {
    dlActiveConfig = await api.getConfig();
    _updateDlBadge('dl-mods-badge');
    _updateDlBadge('dl-plugins-badge');
  } catch (_) {}
}
function _updateDlBadge(id) {
  const el = document.getElementById(id);
  if (!el || !dlActiveConfig) return;
  const t = dlActiveConfig.serverType || '';
  const v = dlActiveConfig.mcVersion  || '';
  const label = (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Unknown') + (v && v !== 'unknown' ? ' ' + v : '');
  el.textContent = label;
  el.style.display = t ? '' : 'none';
}

// ── Modrinth API ─────────────────────────────────────────────────────────────
const MR_UA = 'MehhServerManager/1.1 (github.com/mehhh)';

async function modrinthSearch(query, projectType, loader, mcVersion) {
  const facets = [[`project_type:${projectType}`]];
  if (loader)    facets.push([`categories:${loader}`]);
  if (mcVersion && mcVersion !== 'unknown') facets.push([`versions:${mcVersion}`]);
  const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=20&index=relevance`;
  const r = await fetch(url, { headers: { 'User-Agent': MR_UA } });
  if (!r.ok) throw new Error(`Modrinth API ${r.status}`);
  const data = await r.json();
  return data.hits || [];
}

async function modrinthGetVersions(projectId, loader, mcVersion) {
  let url = `https://api.modrinth.com/v2/project/${projectId}/version?`;
  const params = [];
  if (loader)    params.push(`loaders=${encodeURIComponent(JSON.stringify([loader]))}`);
  if (mcVersion && mcVersion !== 'unknown') params.push(`game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`);
  url += params.join('&');
  const r = await fetch(url, { headers: { 'User-Agent': MR_UA } });
  if (!r.ok) throw new Error(`Modrinth API ${r.status}`);
  return r.json();
}

// ── Card renderers ────────────────────────────────────────────────────────────

function makeDlCard({ icon, name, desc, downloads, categories, btnLabel, btnClass, onInstall }) {
  const card = document.createElement('div');
  card.className = 'dl-card';
  const dlFmt = d => d >= 1000000 ? `${(d/1000000).toFixed(1)}M` : d >= 1000 ? `${(d/1000).toFixed(0)}K` : String(d || '?');
  const cats  = (categories || []).slice(0, 3).join(' · ');
  card.innerHTML = `
    <div class="dl-card-icon">
      ${icon ? `<img src="${esc(icon)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=dl-icon-fb>📦</span>'">` : '<span class="dl-icon-fb">📦</span>'}
    </div>
    <div class="dl-card-body">
      <div class="dl-card-name">${esc(name)}</div>
      <div class="dl-card-desc">${esc((desc || '').substring(0, 130))}</div>
      ${cats || downloads ? `<div class="dl-card-meta">${downloads ? `<span>⬇ ${dlFmt(downloads)}</span>` : ''}${cats ? `<span>${esc(cats)}</span>` : ''}</div>` : ''}
    </div>
    <div class="dl-card-actions">
      <button class="btn ${btnClass || 'btn-primary'} btn-sm dl-install-btn">⬇ Install</button>
    </div>`;
  card.querySelector('.dl-install-btn').addEventListener('click', function() { onInstall(this); });
  return card;
}

// ── Install helpers ───────────────────────────────────────────────────────────

async function doInstall(btn, label, getUrlAndFilename) {
  btn.disabled = true;
  btn.textContent = '⏳ Fetching…';
  try {
    const { url, filename } = await getUrlAndFilename();
    btn.textContent = '⬇ 0%';
    const offProgress = api.on('download:progress', ({ filename: fn, pct }) => {
      if (fn === filename) btn.textContent = `⬇ ${pct}%`;
    });
    const r = await api.modsDownloadUrl({ url, filename });
    if (r.ok) {
      btn.textContent = '✓ Installed';
      btn.className = btn.className.replace('btn-primary','btn-success');
      toast(`${label} installed ✓`);
      if (S.tab === 'mods') loadMods();
    } else {
      throw new Error(r.error);
    }
  } catch (e) {
    btn.textContent = '⬇ Install';
    btn.disabled = false;
    btn.className = btn.className.replace('btn-success','btn-primary');
    toast(e.message || 'Install failed', 'err');
  }
}

async function installModrinthMod(projectId, name, loader, mcVersion, btn) {
  await doInstall(btn, name, async () => {
    const versions = await modrinthGetVersions(projectId, loader, mcVersion);
    if (!versions || !versions.length) throw new Error(`No compatible ${loader} ${mcVersion} version found for "${name}"`);
    const ver  = versions[0];
    const file = ver.files.find(f => f.primary) || ver.files[0];
    if (!file) throw new Error('No download file in this version');
    return { url: file.url, filename: file.filename };
  });
}

async function installModrinthPlugin(projectId, name, mcVersion, btn) {
  await doInstall(btn, name, async () => {
    const versions = await modrinthGetVersions(projectId, null, mcVersion);
    if (!versions || !versions.length) throw new Error(`No compatible version found for "${name}"`);
    const ver  = versions[0];
    const file = ver.files.find(f => f.primary) || ver.files[0];
    if (!file) throw new Error('No download file in this version');
    return { url: file.url, filename: file.filename };
  });
}

// ── Search runners ────────────────────────────────────────────────────────────

function setDlStatus(elId, html) { document.getElementById(elId).innerHTML = html; }
function setDlResults(elId, html) { document.getElementById(elId).innerHTML = html; }

async function runDlModsSearch() {
  if (!dlActiveConfig) await refreshDlConfig();
  const query     = (document.getElementById('dl-mods-search').value || '').trim();
  const type      = dlActiveConfig?.serverType  || '';
  const mcVersion = dlActiveConfig?.mcVersion   || '';
  const statusEl  = 'dl-mods-status';
  const resultsEl = 'dl-mods-results';

  if (!S.configured || !type) {
    setDlStatus(statusEl, '<div class="dl-nosupport">⚠ No server active. Create or import a server first.</div>');
    setDlResults(resultsEl, '');
    return;
  }

  if (!serverSupportsMods(type)) {
    const label = type ? type.charAt(0).toUpperCase() + type.slice(1) : 'This server type';
    setDlStatus(statusEl, `<div class="dl-nosupport">📦 <strong>${esc(label)}</strong> servers don't use mods.<br>Switch to a <strong>Fabric</strong> or <strong>Forge</strong> server to download mods.</div>`);
    setDlResults(resultsEl, '');
    return;
  }

  const loader = type;
  setDlStatus(statusEl, '<div class="dl-loading">🔍 Searching…</div>');
  setDlResults(resultsEl, '');

  try {
    const grid = document.getElementById(resultsEl);
    grid.innerHTML = '';
    const hits = await modrinthSearch(query, 'mod', loader, mcVersion);
    setDlStatus(statusEl, '');
    if (!hits.length) { grid.innerHTML = `<div class="empty" style="padding:30px">No ${loader} mods found${mcVersion && mcVersion !== 'unknown' ? ` for MC ${mcVersion}` : ''}${query ? ` matching "${esc(query)}"` : ''}.</div>`; return; }
    for (const h of hits) {
      const card = makeDlCard({ icon: h.icon_url, name: h.title || h.slug, desc: h.description, downloads: h.downloads, categories: h.categories,
        onInstall: btn => installModrinthMod(h.project_id, h.title, loader, mcVersion, btn) });
      grid.appendChild(card);
    }
  } catch (e) {
    setDlStatus(statusEl, `<div class="dl-error">❌ Search failed: ${esc(e.message)}</div>`);
    setDlResults(resultsEl, '');
  }
}

async function runDlPluginsSearch() {
  if (!dlActiveConfig) await refreshDlConfig();
  const query     = (document.getElementById('dl-plugins-search').value || '').trim();
  const type      = dlActiveConfig?.serverType  || '';
  const mcVersion = dlActiveConfig?.mcVersion   || '';
  const statusEl  = 'dl-plugins-status';
  const resultsEl = 'dl-plugins-results';

  if (!S.configured || !type) {
    setDlStatus(statusEl, '<div class="dl-nosupport">⚠ No server active. Create or import a server first.</div>');
    setDlResults(resultsEl, '');
    return;
  }

  if (!serverSupportsPlugins(type)) {
    const label = type ? type.charAt(0).toUpperCase() + type.slice(1) : 'This server type';
    setDlStatus(statusEl, `<div class="dl-nosupport">🔌 <strong>${esc(label)}</strong> servers don't use plugins.<br>Switch to a <strong>Paper</strong> or <strong>Purpur</strong> server to download plugins.</div>`);
    setDlResults(resultsEl, '');
    return;
  }

  setDlStatus(statusEl, '<div class="dl-loading">🔍 Searching…</div>');
  setDlResults(resultsEl, '');

  try {
    const grid = document.getElementById(resultsEl);
    grid.innerHTML = '';
    const hits = await modrinthSearch(query, 'plugin', null, mcVersion);
    setDlStatus(statusEl, '');
    if (!hits.length) { grid.innerHTML = `<div class="empty" style="padding:30px">No plugins found${mcVersion && mcVersion !== 'unknown' ? ` for MC ${mcVersion}` : ''}${query ? ` matching "${esc(query)}"` : ''}.</div>`; return; }
    for (const h of hits) {
      const card = makeDlCard({ icon: h.icon_url, name: h.title || h.slug, desc: h.description, downloads: h.downloads, categories: h.categories,
        onInstall: btn => installModrinthPlugin(h.project_id, h.title, mcVersion, btn) });
      grid.appendChild(card);
    }
  } catch (e) {
    setDlStatus(statusEl, `<div class="dl-error">❌ Search failed: ${esc(e.message)}</div>`);
    setDlResults(resultsEl, '');
  }
}

// ── Tab init ──────────────────────────────────────────────────────────────────

async function initDlMods() {
  const prevType = dlActiveConfig?.serverType;
  const prevVer  = dlActiveConfig?.mcVersion;
  await refreshDlConfig();
  if (!dlModsInitialized || prevType !== dlActiveConfig?.serverType || prevVer !== dlActiveConfig?.mcVersion) {
    dlModsInitialized = true;
    runDlModsSearch();
  }
}

async function initDlPlugins() {
  const prevType = dlActiveConfig?.serverType;
  const prevVer  = dlActiveConfig?.mcVersion;
  await refreshDlConfig();
  if (!dlPluginsInitialized || prevType !== dlActiveConfig?.serverType || prevVer !== dlActiveConfig?.mcVersion) {
    dlPluginsInitialized = true;
    runDlPluginsSearch();
  }
}

// Reset on server switch so new tab switch will re-fetch with the new server's type/version
function resetDlTabs() {
  dlModsInitialized = false;
  dlPluginsInitialized = false;
  dlActiveConfig = null;
}

// Source tab toggles (mods — Modrinth only)
document.getElementById('dl-mods-src-modrinth').addEventListener('click', () => {
  dlModsInitialized = false;
  runDlModsSearch();
});

// Source tab toggles (plugins — Modrinth only)
document.getElementById('dl-plugins-src-modrinth').addEventListener('click', () => {
  dlPluginsInitialized = false;
  runDlPluginsSearch();
});

// ── Search inputs (debounced) ─────────────────────────────────────────────────

document.getElementById('dl-mods-search').addEventListener('input', () => {
  clearTimeout(dlModsTimer);
  dlModsTimer = setTimeout(runDlModsSearch, 400);
});
document.getElementById('dl-mods-search').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(dlModsTimer); runDlModsSearch(); }
});

document.getElementById('dl-plugins-search').addEventListener('input', () => {
  clearTimeout(dlPluginsTimer);
  dlPluginsTimer = setTimeout(runDlPluginsSearch, 400);
});
document.getElementById('dl-plugins-search').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(dlPluginsTimer); runDlPluginsSearch(); }
});
