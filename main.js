const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { exec, spawn } = require('child_process');
const https = require('https');
const http  = require('http');

// Set app name before any getPath() calls so %APPDATA% folder is correct
app.setName('MehhServerManager');



let mainWindow    = null;
let serverProcess = null;
let playitProcess = null;
let serverFolder  = null;
let serverConfig  = {};
let serverState   = 'stopped';
let serverStartTime = null;
let onlinePlayers = new Map();
let statsInterval = null;
let playitAddress = null;
const customTunnelProcesses = new Map(); 

const CONFIG_FILE  = path.join(app.getPath('userData'), 'mehhservermanager-config.json');
const RUNTIME_FILE = path.join(app.getPath('userData'), 'mehhservermanager-runtime.json');
const SERVERS_DIR  = path.join(app.getPath('userData'), 'servers');

let detachedPid = null;

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (_) {}
  return null;
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (_) {}
}

function saveRuntime(data) {
  try { fs.writeFileSync(RUNTIME_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
}
function loadRuntime() {
  try { if (fs.existsSync(RUNTIME_FILE)) return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')); }
  catch (_) {}
  return null;
}
function clearRuntime() {
  try { if (fs.existsSync(RUNTIME_FILE)) fs.unlinkSync(RUNTIME_FILE); } catch (_) {}
}

function isPidAliveJava(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve(false);
    try { process.kill(pid, 0); } catch { return resolve(false); }
    
    if (process.platform === 'win32') {
      exec(`powershell -NoProfile -Command "(Get-Process -Id ${pid} -EA SilentlyContinue).Name"`,
        { windowsHide: true }, (err, out) => {
          resolve(!err && /java/i.test(out.trim()));
        });
    } else {
      exec(`ps -o comm= -p ${pid}`, (err, out) => {
        resolve(!err && /java/i.test(out.trim()));
      });
    }
  });
}

function parseProperties(content) {
  const props = {};
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    props[t.substring(0, idx).trim()] = t.substring(idx + 1);
  }
  return props;
}
function writeProperties(original, updates) {
  const seen = new Set();
  const out = original.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const idx = t.indexOf('=');
    if (idx === -1) return line;
    const key = t.substring(0, idx).trim();
    seen.add(key);
    return key in updates ? `${key}=${updates[key]}` : line;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  return out.join('\n');
}

// Strip ANSI escape codes AND Minecraft § color/format codes from player names.
// Paper/Purpur emit colored console output so captured names can contain junk like
// \x1b[38;2;255;255;85m or §6 before the actual username.
function stripPlayerName(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // ANSI escape sequences
    .replace(/§[0-9a-fklmnorx]/gi, '')           // §X Minecraft color codes
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')   // other control chars
    .trim();
}

function parseLogLine(line) {
  const joinMatch  = line.match(/\]: (.+?) joined the game/);
  const leaveMatch = line.match(/\]: (.+?) left the game/);
  if (joinMatch)  {
    const name = stripPlayerName(joinMatch[1]);
    if (name) { onlinePlayers.set(name, { name }); broadcastPlayers(); }
  }
  if (leaveMatch) {
    const name = stripPlayerName(leaveMatch[1]);
    if (name) { onlinePlayers.delete(name); broadcastPlayers(); }
  }
  if (line.includes('Done (') && line.includes('For help, type')) {
    serverState = 'running'; serverStartTime = Date.now();
    send('server:state', { state: 'running' });
  }
  if (line.includes('Stopping server') || line.includes('Closing Server')) {
    serverState = 'stopping'; send('server:state', { state: 'stopping' });
  }
}
function classifyLine(line) {
  if (/ERROR|Exception|SEVERE/.test(line))               return 'error';
  if (line.includes('WARN'))                              return 'warn';
  if (line.includes('joined the game'))                   return 'join';
  if (line.includes('left the game'))                     return 'leave';
  if (line.includes('Done (') && line.includes('For help')) return 'success';
  if (/\[.*?\/INFO\].*?<.+?>/.test(line))                return 'chat';
  return 'info';
}
function broadcastPlayers() { send('players:updated', Array.from(onlinePlayers.values())); }
function send(ch, data) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data); }

let _lastCpuSec = 0, _lastCpuAt = 0;
function resetCpuState() { _lastCpuSec = 0; _lastCpuAt = 0; }

function getProcessCPU(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve(0);
    if (process.platform === 'win32') {
      exec(
        `powershell -NoProfile -Command "(Get-Process -Id ${pid} -EA SilentlyContinue).CPU"`,
        { windowsHide: true, timeout: 4000 },
        (err, stdout) => {
          if (err || !stdout.trim()) return resolve(0);
          const cpuSec = parseFloat(stdout.trim());
          if (isNaN(cpuSec) || cpuSec < 0) return resolve(0);
          const now = Date.now();
          let pct = 0;
          if (_lastCpuAt > 0 && cpuSec >= _lastCpuSec) {
            const elapsed = (now - _lastCpuAt) / 1000;
            if (elapsed >= 0.5) {
              const delta = cpuSec - _lastCpuSec;
              pct = Math.max(0, Math.min(100, Math.round((delta / elapsed) * 100)));
            }
          }
          _lastCpuSec = cpuSec; _lastCpuAt = now;
          resolve(pct);
        }
      );
    } else {
      exec(`ps -o %cpu= -p ${pid}`, { timeout: 4000 }, (err, out) =>
        resolve(err ? 0 : Math.max(0, Math.round(parseFloat(out.trim()) || 0))));
    }
  });
}

function getProcessRAM(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve({ used: 0 });
    if (process.platform === 'win32') {
      exec(
        `powershell -NoProfile -Command "$p=Get-Process -Id ${pid} -EA SilentlyContinue; if($p){$p.PrivateMemorySize64}else{0}"`,
        { windowsHide: true, timeout: 4000 },
        (err, stdout) => {
          if (err || !stdout.trim()) return resolve({ used: 0 });
          const bytes = parseInt(stdout.trim(), 10);
          resolve({ used: isNaN(bytes) ? 0 : Math.round(bytes / 1024 / 1024) });
        }
      );
    } else {
      exec(`ps -o rss= -p ${pid}`, { timeout: 4000 }, (err, out) => {
        resolve({ used: err ? 0 : Math.round(parseInt(out.trim(), 10) / 1024) });
      });
    }
  });
}

function getConfiguredMaxRam() {
  const m = (serverConfig.javaArgs || '').match(/-Xmx(\d+)([gGmM])/);
  if (!m) return null;
  const val = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  return unit === 'g' ? { mb: val * 1024, label: `${val} GB` } : { mb: val, label: `${val} MB` };
}
let _diskCache = { world: 0, ts: 0 };
function getDiskUsage(folder) {
  return new Promise(resolve => {
    if (!folder) return resolve(0);
    if (Date.now() - _diskCache.ts < 30000) return resolve(_diskCache.world);
    if (process.platform === 'win32') {
      exec(`powershell -NoProfile -Command "(Get-ChildItem -Path '${folder}' -Recurse -File -EA SilentlyContinue | Measure-Object -Property Length -Sum).Sum"`,
        { windowsHide: true, timeout: 15000 }, (err, stdout) => {
          const bytes = parseInt(stdout.trim(), 10) || 0;
          _diskCache = { world: bytes, ts: Date.now() }; resolve(bytes);
        });
    } else {
      exec(`du -sb "${folder}" 2>/dev/null | cut -f1`, (err, out) => {
        const bytes = parseInt(out.trim(), 10) || 0;
        _diskCache = { world: bytes, ts: Date.now() }; resolve(bytes);
      });
    }
  });
}

function startStatsPolling() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    const pid = serverProcess ? serverProcess.pid : detachedPid;
    if (!pid) return;

    // If state is stuck at 'stopped' but a pid exists, verify the process is alive
    // and self-heal the state so the UI reflects reality
    if (serverState === 'stopped') {
      const alive = await isPidAliveJava(pid);
      if (alive) {
        serverState = 'running';
        if (!serverStartTime) serverStartTime = Date.now();
        send('server:state', { state: 'running' });
      } else {
        return; // truly stopped — nothing to poll
      }
    }

    const [ramData, cpu] = await Promise.all([getProcessRAM(pid), getProcessCPU(pid)]);
    const uptime = serverStartTime ? Math.floor((Date.now() - serverStartTime) / 1000) : 0;
    const maxRam = getConfiguredMaxRam();
    send('stats:update', { ram: ramData.used, maxRam: maxRam ? maxRam.label : null, cpu, uptime, state: serverState });
  }, 2000);
}

function startServer() {
  if (serverProcess) return { ok: false, error: 'Server already running' };
  if (!serverFolder || !serverConfig.serverJar)
    return { ok: false, error: 'Server not configured. Select your server folder on Dashboard first.' };
  const jar = path.join(serverFolder, serverConfig.serverJar);
  if (!fs.existsSync(jar)) return { ok: false, error: `JAR not found: ${jar}` };

  const args = (serverConfig.javaArgs || '-Xmx2G -Xms1G').split(/\s+/).filter(Boolean);
  args.push('-jar', serverConfig.serverJar, 'nogui');

  serverState = 'starting';
  send('server:state', { state: 'starting' });
  onlinePlayers.clear(); broadcastPlayers();

  try {
    if (serverConfig.useRunScript) {
      // Modern Forge — use run.bat / run.sh
      const runBat = path.join(serverFolder, 'run.bat');
      const runSh  = path.join(serverFolder, 'run.sh');
      if (process.platform === 'win32' && fs.existsSync(runBat)) {
        serverProcess = spawn('cmd', ['/c', 'run.bat', 'nogui'],
          { cwd: serverFolder, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } else if (fs.existsSync(runSh)) {
        serverProcess = spawn('bash', ['run.sh', 'nogui'],
          { cwd: serverFolder, stdio: ['pipe', 'pipe', 'pipe'] });
      } else {
        serverState = 'stopped'; send('server:state', { state: 'stopped' });
        return { ok: false, error: 'Forge run script (run.bat / run.sh) not found in server folder' };
      }
    } else {
      serverProcess = spawn('java', args, { cwd: serverFolder, stdio: ['pipe','pipe','pipe'], windowsHide: true });
    }
  } catch (e) {
    serverState = 'stopped'; send('server:state', { state: 'stopped' });
    return { ok: false, error: `Failed to launch java: ${e.message}` };
  }

  
  detachedPid = serverProcess.pid;
  saveRuntime({ pid: serverProcess.pid, startTime: Date.now(), serverFolder, serverJar: serverConfig.serverJar });

  const handleData = data => {
    for (const rawLine of data.toString('utf8').split('\n')) {
      const line = rawLine.replace(/\r/, '').trim();
      if (!line) continue;
      // Forge run.bat outputs "Press any key to continue..." after the server stops.
      // Auto-dismiss it so the process exits cleanly without waiting for user input.
      if (/Press any key to continue/i.test(line)) {
        try { serverProcess && serverProcess.stdin.write('\r\n'); } catch {}
      }
      parseLogLine(line);
      send('console:line', { text: line, type: classifyLine(line) });
    }
  };
  serverProcess.stdout.on('data', handleData);
  serverProcess.stderr.on('data', handleData);
  serverProcess.on('exit', code => {
    serverProcess = null; detachedPid = null; serverState = 'stopped'; serverStartTime = null;
    onlinePlayers.clear();
    clearRuntime();
    send('server:state', { state: 'stopped' });
    send('console:line',  { text: `[MehhServerManager] Server exited (code ${code})`, type: 'warn' });
    broadcastPlayers();
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  });
  serverProcess.on('error', err => {
    serverProcess = null; detachedPid = null; serverState = 'stopped';
    clearRuntime();
    send('server:state', { state: 'stopped' });
    send('console:line',  { text: `[MehhServerManager] Error: ${err.message}`, type: 'error' });
  });
  startStatsPolling();
  return { ok: true };
}
function stopServer() {
  if (!serverProcess && !detachedPid) return { ok: false, error: 'Not running' };
  serverState = 'stopping'; send('server:state', { state: 'stopping' });
  if (serverProcess) {
    try   { serverProcess.stdin.write('stop\n'); }
    catch { try { serverProcess.kill('SIGTERM'); } catch {} }
  } else if (detachedPid) {
    try { process.kill(detachedPid, 'SIGTERM'); } catch (_) {}
    const startWait = Date.now();
    const checkGone = setInterval(async () => {
      const alive = await isPidAliveJava(detachedPid).catch(() => false);
      const timedOut = Date.now() - startWait > 30000;
      if (!alive || timedOut) {
        clearInterval(checkGone);
        if (alive) forceKillProcess(null, detachedPid);
        detachedPid = null; serverState = 'stopped'; serverStartTime = null;
        clearRuntime();
        send('server:state', { state: 'stopped' });
        if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
      }
    }, 1000);
  }
  return { ok: true };
}
function sendCommand(cmd) {
  if (serverProcess && serverState !== 'stopped') {
    try { serverProcess.stdin.write(cmd + '\n'); send('console:line', { text: `> ${cmd}`, type: 'input' }); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  if (detachedPid) {
    return { ok: false, error: 'Server was re-attached after app restart — console input not available. Restart the server from the app to regain console control.' };
  }
  return { ok: false, error: 'Server not running' };
}

function startPlayit() {
  if (playitProcess) return { ok: false, error: 'Already running' };
  const candidates = [
    serverConfig.playitPath,
    serverFolder && path.join(serverFolder, 'playit.exe'),
    serverFolder && path.join(serverFolder, 'playit_gg.exe'),
    serverFolder && path.join(serverFolder, 'playit'),
  ].filter(p => p && fs.existsSync(p));

  
  const pathCandidates = ['playit.exe', 'playit'];

  let launched = false, lastErr = 'playit executable not found';
  for (const p of [...candidates, ...pathCandidates]) {
    try {
      const cwd = fs.existsSync(p) ? path.dirname(p) : (serverFolder || process.cwd());
      playitProcess = spawn(p, [], { cwd, stdio: ['pipe','pipe','pipe'], windowsHide: false });
      launched = true; break;
    } catch (e) { lastErr = e.message; }
  }
  if (!launched) {
    playitProcess = null;
    return { ok: false, error: `${lastErr}. Use "Browse playit.exe" to locate it.` };
  }

  const ADDR_RE = /((?:[a-z0-9][-a-z0-9]*\.)+(?:joinmc\.link|playit\.gg|ply\.gg)(?::\d+)?)/i;
  const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
  const handleData = data => {
    for (const rawLine of data.toString('utf8').split('\n')) {
      const line = stripAnsi(rawLine).replace(/\r/, '').trim();
      if (!line) continue;
      send('playit:line', { text: line });
      const m = line.match(ADDR_RE);
      if (m) { playitAddress = m[1]; send('playit:address', { address: playitAddress }); }
    }
  };
  playitProcess.stdout.on('data', handleData);
  playitProcess.stderr.on('data', handleData);
  playitProcess.on('exit', code => {
    playitProcess = null; playitAddress = null;
    send('playit:state', { running: false });
    send('playit:line', { text: `[MehhServerManager] playit.gg exited (code ${code})` });
  });
  playitProcess.on('error', e => {
    playitProcess = null;
    send('playit:state', { running: false });
    send('playit:line', { text: `[MehhServerManager] playit error: ${e.message}` });
  });
  send('playit:state', { running: true });
  return { ok: true };
}

function startCustomTunnel(id, execPath, args, postCmd) {
  if (customTunnelProcesses.has(id)) return { ok: false, error: 'Already running' };
  if (!fs.existsSync(execPath)) return { ok: false, error: `Executable not found: ${execPath}` };
  try {
    const argArr = args ? args.trim().split(/\s+/).filter(Boolean) : [];
    const cwd = path.dirname(execPath);
    const proc = spawn(execPath, argArr, { cwd, stdio: ['pipe','pipe','pipe'], windowsHide: false });
    customTunnelProcesses.set(id, proc);
    const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
    const handleData = data => {
      for (const rawLine of data.toString('utf8').split('\n')) {
        const line = stripAnsi(rawLine).replace(/\r/, '').trim();
        if (line) send('tunnel:output', { id, text: line });
      }
    };
    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);
    proc.on('exit', code => {
      customTunnelProcesses.delete(id);
      send('tunnel:state', { id, running: false });
      send('tunnel:output', { id, text: `[Exited with code ${code}]` });
    });
    proc.on('error', e => {
      customTunnelProcesses.delete(id);
      send('tunnel:state', { id, running: false });
      send('tunnel:output', { id, text: `[Error: ${e.message}]` });
    });
    send('tunnel:state', { id, running: true });

    
    if (postCmd && postCmd.trim()) {
      setTimeout(() => {
        send('tunnel:output', { id, text: `[PostCmd] Running: ${postCmd.trim()}` });
        exec(postCmd.trim(), { cwd, windowsHide: true }, (err, stdout, stderr) => {
          if (err) send('tunnel:output', { id, text: `[PostCmd Error] ${err.message}` });
          else send('tunnel:output', { id, text: `[PostCmd] Done` });
        });
      }, 2000);
    }

    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

const EDITABLE_EXTS = new Set(['.properties','.cfg','.conf','.toml','.yml','.yaml','.ini','.txt','.json','.log','.sh','.bat','.cmd','.md','.xml','.js','.ts','.py','.lua','.csv']);

function listDirectory(dirPath) {
  if (!dirPath) return { ok: false, error: 'No path' };
  try {
    return {
      ok: true, path: dirPath,
      entries: fs.readdirSync(dirPath, { withFileTypes: true }).map(e => ({
        name: e.name, isDir: e.isDirectory(),
        size: e.isFile() ? (() => { try { return fs.statSync(path.join(dirPath, e.name)).size; } catch { return 0; } })() : 0,
        ext:  e.isFile() ? path.extname(e.name).toLowerCase() : '',
        modified: (() => { try { return fs.statSync(path.join(dirPath, e.name)).mtime.getTime(); } catch { return 0; } })(),
        editable: e.isFile() ? EDITABLE_EXTS.has(path.extname(e.name).toLowerCase()) : false,
      })).sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name))
    };
  } catch (e) { return { ok: false, error: e.message }; }
}
function listMods(folder) {
  for (const sub of ['mods', 'plugins']) {
    const mp = path.join(folder, sub);
    if (fs.existsSync(mp)) {
      try {
        return { ok: true, type: sub, path: mp,
          mods: fs.readdirSync(mp).filter(f => f.endsWith('.jar')).map(f => ({ name: f, size: fs.statSync(path.join(mp, f)).size, path: path.join(mp, f) })) };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  }
  return { ok: true, type: 'mods', path: path.join(folder, 'mods'), mods: [] };
}
function scanJars(folder) {
  try {
    const pri = ['server.jar','fabric-server','paper','spigot','purpur','forge','mohist'];
    return fs.readdirSync(folder).filter(f => f.endsWith('.jar') && !f.includes('bundler'))
      .sort((a, b) => {
        const ai = pri.findIndex(p => a.toLowerCase().includes(p));
        const bi = pri.findIndex(p => b.toLowerCase().includes(p));
        return ai !== -1 && bi === -1 ? -1 : bi !== -1 && ai === -1 ? 1 : a.localeCompare(b);
      });
  } catch { return []; }
}

// ── Server management helpers ──────────────────────────────────────────────

function ensureServersDir() {
  if (!fs.existsSync(SERVERS_DIR)) fs.mkdirSync(SERVERS_DIR, { recursive: true });
}

// Meta file name — supports both old (.mcdash-meta.json) and new (.server-meta.json) for backward compat
const META_FILE_NAME = '.server-meta.json';
const META_FILE_LEGACY = '.mcdash-meta.json';

function readServerMeta(folder) {
  // Try new name first, then legacy name
  for (const name of [META_FILE_NAME, META_FILE_LEGACY]) {
    const f = path.join(folder, name);
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    }
  }
  return null;
}

function writeServerMeta(folder, meta) {
  fs.writeFileSync(path.join(folder, META_FILE_NAME), JSON.stringify(meta, null, 2));
}

function listManagedServers() {
  if (!fs.existsSync(SERVERS_DIR)) return [];
  const servers = [];
  try {
    for (const entry of fs.readdirSync(SERVERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(SERVERS_DIR, entry.name);
      let meta = readServerMeta(folder) || { name: entry.name, type: 'unknown', mcVersion: '?' };
      servers.push({ folder, ...meta, isActive: serverFolder === folder });
    }
  } catch {}
  return servers;
}

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'MehhServerManager/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGetText(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function httpsGetJson(url) {
  const text = await httpsGetText(url);
  return JSON.parse(text);
}

function downloadFileTo(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const doDownload = (dlUrl) => {
      const lib = dlUrl.startsWith('https') ? https : http;
      const file = fs.createWriteStream(destPath);
      lib.get(dlUrl, { headers: { 'User-Agent': 'MehhServerManager/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          try { fs.unlinkSync(destPath); } catch {}
          return doDownload(res.headers.location);
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        res.on('data', chunk => {
          downloaded += chunk.length;
          if (onProgress && total > 0) onProgress(Math.round(downloaded / total * 100));
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', err => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
      }).on('error', err => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
    };
    doDownload(url);
  });
}

async function getVanillaJarUrl(version) {
  const manifest = await httpsGetJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  const v = manifest.versions.find(x => x.id === version);
  if (!v) throw new Error(`Vanilla version "${version}" not found`);
  const vData = await httpsGetJson(v.url);
  if (!vData.downloads?.server?.url) throw new Error(`No server download for version "${version}"`);
  return vData.downloads.server.url;
}

async function getPaperJarInfo(version) {
  const builds = await httpsGetJson(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds`);
  if (!builds.builds?.length) throw new Error(`No Paper builds for ${version}`);
  const latest = builds.builds[builds.builds.length - 1];
  const jarName = latest.downloads.application.name;
  const url = `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latest.build}/downloads/${jarName}`;
  return { url, jarName };
}

async function getFabricJarInfo(mcVersion) {
  const loaders = await httpsGetJson(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
  if (!loaders.length) throw new Error(`No Fabric loaders available for ${mcVersion}`);
  const loaderVersion = loaders[0].loader.version;
  const installers = await httpsGetJson('https://meta.fabricmc.net/v2/versions/installer');
  if (!installers.length) throw new Error('No Fabric installers found');
  const installerVersion = installers[0].version;
  const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/${installerVersion}/server/jar`;
  const jarName = `fabric-server-mc${mcVersion}.jar`;
  return { url, jarName };
}

async function getPurpurJarInfo(version) {
  const url = `https://api.purpurmc.org/v2/purpur/${version}/latest/download`;
  const jarName = `purpur-${version}.jar`;
  return { url, jarName };
}

async function getForgeInstallerInfo(mcVersion) {
  const promos = await httpsGetJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  const recKey = `${mcVersion}-recommended`;
  const latKey = `${mcVersion}-latest`;
  const forgeVersion = promos.promos[recKey] || promos.promos[latKey];
  if (!forgeVersion) throw new Error(`No Forge build found for MC ${mcVersion}. Try a different version.`);
  const fullVersion = `${mcVersion}-${forgeVersion}`;
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`;
  return { url, installerJar: `forge-${fullVersion}-installer.jar`, forgeVersion, fullVersion };
}

ipcMain.handle('mc:get-versions', async (_, { type }) => {
  try {
    if (type === 'paper') {
      const data = await httpsGetJson('https://api.papermc.io/v2/projects/paper');
      return { ok: true, versions: [...data.versions].reverse() };
    } else if (type === 'purpur') {
      const data = await httpsGetJson('https://api.purpurmc.org/v2/purpur');
      return { ok: true, versions: [...data.versions].reverse() };
    } else if (type === 'fabric') {
      const data = await httpsGetJson('https://meta.fabricmc.net/v2/versions/game');
      const versions = data.filter(v => v.stable).map(v => v.version);
      return { ok: true, versions };
    } else if (type === 'forge') {
      const data = await httpsGetJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const versions = [...new Set(Object.keys(data.promos)
        .map(k => k.replace(/-(latest|recommended)$/, ''))
        .filter(v => /^\d+\.\d+/.test(v))
      )].sort((a, b) => {
        const [ma, mi, pa = 0] = a.split('.').map(Number);
        const [mb, mi2, pb = 0] = b.split('.').map(Number);
        return mb - ma || mi2 - mi || pb - pa;
      });
      return { ok: true, versions };
    } else {
      // vanilla
      const data = await httpsGetJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const versions = data.versions.filter(v => v.type === 'release').map(v => v.id);
      return { ok: true, versions };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('servers:list', () => ({ ok: true, servers: listManagedServers() }));

ipcMain.handle('servers:create', async (_, { name, type, mcVersion, ram }) => {
  ensureServersDir();
  const safeName = name.replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!safeName) return { ok: false, error: 'Invalid server name' };
  const folder = path.join(SERVERS_DIR, safeName);
  if (fs.existsSync(folder)) return { ok: false, error: `A server named "${safeName}" already exists` };
  fs.mkdirSync(folder, { recursive: true });

  const sendProg = (pct, msg) => send('create:progress', { pct, msg });

  try {
    let jarName;
    const ramNum = Math.max(1, parseInt(ram, 10) || 2);
    sendProg(5, 'Fetching version information…');

    if (type === 'vanilla') {
      jarName = 'server.jar';
      const jarUrl = await getVanillaJarUrl(mcVersion);
      sendProg(10, `Downloading Vanilla ${mcVersion}…`);
      await downloadFileTo(jarUrl, path.join(folder, jarName),
        pct => sendProg(10 + Math.round(pct * 0.85), `Downloading: ${pct}%`));

    } else if (type === 'paper') {
      const info = await getPaperJarInfo(mcVersion);
      jarName = info.jarName;
      sendProg(10, `Downloading Paper ${mcVersion}…`);
      await downloadFileTo(info.url, path.join(folder, jarName),
        pct => sendProg(10 + Math.round(pct * 0.85), `Downloading: ${pct}%`));

    } else if (type === 'purpur') {
      const info = await getPurpurJarInfo(mcVersion);
      jarName = info.jarName;
      sendProg(10, `Downloading Purpur ${mcVersion}…`);
      await downloadFileTo(info.url, path.join(folder, jarName),
        pct => sendProg(10 + Math.round(pct * 0.85), `Downloading: ${pct}%`));

    } else if (type === 'fabric') {
      const info = await getFabricJarInfo(mcVersion);
      jarName = info.jarName;
      sendProg(10, `Downloading Fabric ${mcVersion}…`);
      await downloadFileTo(info.url, path.join(folder, jarName),
        pct => sendProg(10 + Math.round(pct * 0.85), `Downloading: ${pct}%`));

    } else if (type === 'forge') {
      sendProg(8, `Finding Forge for MC ${mcVersion}…`);
      const info = await getForgeInstallerInfo(mcVersion);
      const installerPath = path.join(folder, info.installerJar);
      sendProg(12, 'Downloading Forge installer…');
      await downloadFileTo(info.url, installerPath,
        pct => sendProg(12 + Math.round(pct * 0.38), `Downloading installer: ${pct}%`));

      // ── Library cache: pre-seed the libraries/ folder from any existing Forge server
      // so the installer skips re-downloading them (mirrors what happens when you run
      // the installer manually and the folder already exists).
      const FORGE_LIB_CACHE = path.join(app.getPath('userData'), 'forge-lib-cache');
      const destLibs = path.join(folder, 'libraries');
      if (fs.existsSync(FORGE_LIB_CACHE)) {
        try {
          sendProg(52, 'Copying cached Forge libraries (this will be fast)…');
          fs.cpSync(FORGE_LIB_CACHE, destLibs, { recursive: true });
          send('create:log', { msg: '[Cache] Pre-seeded libraries from cache — install will be much faster.' });
        } catch (e) {
          send('create:log', { msg: `[Cache] Could not use library cache: ${e.message}` });
        }
      } else {
        sendProg(52, 'Running Forge installer (first install — downloading libraries, please wait)…');
      }

      sendProg(52, 'Running Forge installer…');
      await new Promise((resolve, reject) => {
        // Pass full environment so Maven can find its cache at %USERPROFILE%\.m2
        // Without inheriting env, Electron's stripped environment causes Maven to
        // re-download every library one-by-one instead of using the local cache.
        // -Dmaven.artifact.threads=8 enables parallel library downloads.
        const proc = spawn('java', [
            '-Djava.net.preferIPv4Stack=true',
            '-Dmaven.artifact.threads=8',
            '-jar', info.installerJar, '--installServer'
          ],
          { cwd: folder, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        proc.stdout.on('data', d => send('create:log', { msg: d.toString().trim() }));
        proc.stderr.on('data', d => send('create:log', { msg: d.toString().trim() }));
        proc.on('exit', code => (code === 0 ? resolve() : reject(new Error(`Forge installer exited with code ${code}`))));
        proc.on('error', reject);
      });

      // ── Save libraries to cache for next time
      if (fs.existsSync(destLibs)) {
        try {
          if (!fs.existsSync(FORGE_LIB_CACHE)) fs.mkdirSync(FORGE_LIB_CACHE, { recursive: true });
          // Merge: only copy files that aren't already in the cache
          const copyNewOnly = (src, dest) => {
            for (const e of fs.readdirSync(src, { withFileTypes: true })) {
              const sp = path.join(src, e.name), dp = path.join(dest, e.name);
              if (e.isDirectory()) { if (!fs.existsSync(dp)) fs.mkdirSync(dp, { recursive: true }); copyNewOnly(sp, dp); }
              else if (!fs.existsSync(dp)) fs.copyFileSync(sp, dp);
            }
          };
          copyNewOnly(destLibs, FORGE_LIB_CACHE);
          send('create:log', { msg: '[Cache] Forge libraries saved to cache for future installs.' });
        } catch (_) {}
      }

      // Clean up installer
      try { fs.unlinkSync(installerPath); } catch {}
      sendProg(90, 'Finalizing Forge setup…');
      // Modern Forge (1.17+) uses run.bat / run.sh
      const runBat = path.join(folder, 'run.bat');
      const runSh  = path.join(folder, 'run.sh');
      if (fs.existsSync(runBat) || fs.existsSync(runSh)) {
        jarName = null; // signals useRunScript
        const jvmArgsFile = path.join(folder, 'user_jvm_args.txt');
        if (fs.existsSync(jvmArgsFile)) {
          let content = fs.readFileSync(jvmArgsFile, 'utf8');
          content = content.replace(/-Xmx\S+/g, `-Xmx${ramNum}G`).replace(/-Xms\S+/g, `-Xms${Math.max(1, Math.floor(ramNum / 2))}G`);
          fs.writeFileSync(jvmArgsFile, content);
        }
      } else {
        // Legacy Forge — find the server jar
        const jars = fs.readdirSync(folder).filter(f => f.startsWith('forge-') && f.endsWith('.jar') && !f.includes('-installer'));
        if (!jars.length) throw new Error('Could not find Forge server jar after installation');
        jarName = jars[0];
      }

    } else {
      throw new Error(`Unknown server type: ${type}`);
    }

    sendProg(96, 'Writing EULA and metadata…');
    fs.writeFileSync(path.join(folder, 'eula.txt'),
      '#By changing the setting below to TRUE you are indicating your agreement to our EULA\neula=true\n');

    const meta = { name, type, mcVersion, jar: jarName, useRunScript: !jarName, created: new Date().toISOString() };
    writeServerMeta(folder, meta);

    const configJar = jarName || 'server.jar';
    const newConfig = {
      serverFolder: folder,
      serverJar: configJar,
      javaArgs: `-Xmx${ramNum}G -Xms${Math.max(1, Math.floor(ramNum / 2))}G`,
      serverName: name,
      serverType: type,
      mcVersion,
      useRunScript: !jarName,
      customTunnels: (serverConfig || {}).customTunnels || [],
    };
    serverFolder = folder;
    serverConfig = newConfig;
    saveConfig(newConfig);
    _diskCache = { world: 0, ts: 0 };

    sendProg(100, 'Server ready!');
    return { ok: true, config: newConfig };
  } catch (e) {
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
    return { ok: false, error: e.message };
  }
});

function detectImportedType(folder, jarName) {
  const j = (jarName || '').toLowerCase();
  let type = 'imported';
  let mcVersion = 'unknown';

  if (/\bpaper\b/.test(j)) {
    type = 'paper';
    const m = j.match(/paper-(\d+\.\d+(?:\.\d+)?)/);
    if (m) mcVersion = m[1];
  } else if (/\bpurpur\b/.test(j)) {
    type = 'purpur';
    const m = j.match(/purpur-(\d+\.\d+(?:\.\d+)?)/);
    if (m) mcVersion = m[1];
  } else if (/\bfabric\b/.test(j)) {
    type = 'fabric';
    const m = j.match(/mc(\d+\.\d+(?:\.\d+)?)/);
    if (m) mcVersion = m[1];
  } else if (/\bneoforge\b/.test(j)) {
    type = 'neoforge';
    const m = j.match(/(\d+\.\d+(?:\.\d+)?)/);
    if (m) mcVersion = m[1];
  } else if (/\bforge\b/.test(j)) {
    type = 'forge';
    const m = j.match(/forge-(\d+\.\d+(?:\.\d+)?)-/);
    if (m) mcVersion = m[1];
  } else if (/\bspigot\b/.test(j)) {
    type = 'spigot';
    const m = j.match(/spigot-(\d+\.\d+(?:\.\d+)?)/);
    if (m) mcVersion = m[1];
  } else if (/\bmohist\b/.test(j)) {
    type = 'mohist';
    const m = j.match(/mohist-(\d+\.\d+(?:\.\d+)?)/);
    if (m) mcVersion = m[1];
  }

  // Fallback: read version.json if MC version still unknown
  if (mcVersion === 'unknown') {
    const vFile = path.join(folder, 'version.json');
    if (fs.existsSync(vFile)) {
      try {
        const vd = JSON.parse(fs.readFileSync(vFile, 'utf8'));
        if (vd.id) mcVersion = vd.id;
      } catch {}
    }
  }
  return { type, mcVersion };
}

ipcMain.handle('servers:import', async (_, { sourceFolder, name, jar, ram }) => {
  ensureServersDir();
  const safeName = name.replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!safeName) return { ok: false, error: 'Invalid server name' };
  const destFolder = path.join(SERVERS_DIR, safeName);
  if (fs.existsSync(destFolder)) return { ok: false, error: `A server named "${safeName}" already exists` };

  const sendProg = (pct, msg) => send('create:progress', { pct, msg });
  sendProg(5, 'Copying server files… (this may take a while for large worlds)');

  try {
    fs.cpSync(sourceFolder, destFolder, { recursive: true });
    sendProg(90, 'Finalizing…');

    // Ensure eula is accepted
    fs.writeFileSync(path.join(destFolder, 'eula.txt'),
      '#By changing the setting below to TRUE you are indicating your agreement to our EULA\neula=true\n');

    const { type: detectedType, mcVersion: detectedVersion } = detectImportedType(destFolder, jar);
    const meta = { name, type: detectedType, mcVersion: detectedVersion, jar, created: new Date().toISOString() };
    writeServerMeta(destFolder, meta);

    const ramNum = Math.max(1, parseInt(ram, 10) || 2);
    const newConfig = {
      serverFolder: destFolder,
      serverJar: jar,
      javaArgs: `-Xmx${ramNum}G -Xms${Math.max(1, Math.floor(ramNum / 2))}G`,
      serverName: name,
      serverType: detectedType,
      mcVersion: detectedVersion,
      customTunnels: (serverConfig || {}).customTunnels || [],
    };
    serverFolder = destFolder;
    serverConfig = newConfig;
    saveConfig(newConfig);
    _diskCache = { world: 0, ts: 0 };

    sendProg(100, 'Server imported!');
    return { ok: true, config: newConfig };
  } catch (e) {
    try { fs.rmSync(destFolder, { recursive: true, force: true }); } catch {}
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('servers:delete', (_, { folder }) => {
  if (!folder || !folder.startsWith(SERVERS_DIR)) return { ok: false, error: 'Invalid server path' };
  if (serverFolder === folder && serverState !== 'stopped') return { ok: false, error: 'Stop the server before deleting it' };
  try {
    fs.rmSync(folder, { recursive: true, force: true });
    if (serverFolder === folder) {
      serverFolder = null; serverConfig = {};
      const remaining = listManagedServers();
      if (remaining.length > 0) {
        const first = remaining[0];
        const meta = readServerMeta(first.folder) || {};
        const cfg = {
          serverFolder: first.folder,
          serverJar: meta.jar || scanJars(first.folder)[0] || 'server.jar',
          javaArgs: '-Xmx2G -Xms1G',
          serverName: meta.name || first.name,
          serverType: meta.type,
          mcVersion: meta.mcVersion,
          useRunScript: meta.useRunScript || false,
        };
        serverFolder = first.folder; serverConfig = cfg; saveConfig(cfg);
        return { ok: true, newConfig: cfg };
      } else {
        saveConfig({});
        return { ok: true, newConfig: null };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('servers:switch', (_, { folder }) => {
  if (!folder || !fs.existsSync(folder)) return { ok: false, error: 'Server folder not found' };
  if (serverState !== 'stopped') return { ok: false, error: 'Stop the current server before switching' };
  const meta = readServerMeta(folder) || {};
  const existing = loadConfig() || {};
  const newConfig = {
    serverFolder: folder,
    serverJar: meta.jar || scanJars(folder)[0] || 'server.jar',
    javaArgs: existing.javaArgs || '-Xmx2G -Xms1G',
    serverName: meta.name,
    serverType: meta.type,
    mcVersion: meta.mcVersion,
    useRunScript: meta.useRunScript || false,
    customTunnels: existing.customTunnels || [],
  };
  serverFolder = folder; serverConfig = newConfig; saveConfig(newConfig);
  _diskCache = { world: 0, ts: 0 };
  return { ok: true, config: newConfig };
});

// ── End server management helpers ──────────────────────────────────────────

ipcMain.handle('app:get-state', async () => {
  const cfg = loadConfig();
  if (!cfg || !cfg.serverFolder || !fs.existsSync(cfg.serverFolder)) {
    return { configured: false, servers: listManagedServers() };
  }

  serverFolder = cfg.serverFolder;
  serverConfig = cfg;

  
  if (!serverConfig.playitPath) {
    const playitNames = ['playit.exe', 'playit_gg.exe', 'playit'];
    const found = playitNames.map(n => path.join(serverFolder, n)).find(p => fs.existsSync(p));
    if (found) {
      serverConfig.playitPath = found;
      saveConfig(serverConfig);
    }
  }

  
  const runtime = loadRuntime();
  if (runtime && runtime.pid) {
    const alive = await isPidAliveJava(runtime.pid);
    if (alive) {
      
      detachedPid = runtime.pid;
      serverState = 'running';
      serverStartTime = runtime.startTime || (Date.now() - 60000);
      resetCpuState();
      startStatsPolling();
      return { configured: true, serverFolder, config: cfg, serverRunning: true, detachedPid: runtime.pid, servers: listManagedServers() };
    } else {
      
      clearRuntime();
    }
  }

  return { configured: true, serverFolder, config: cfg, servers: listManagedServers() };
});
ipcMain.handle('setup:choose-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: 'Select Minecraft Server Folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  const folder = r.filePaths[0];
  const playitNames = ['playit.exe','playit_gg.exe','playit'];
  const playitFound = playitNames.map(n => path.join(folder, n)).find(p => fs.existsSync(p)) || null;
  return { ok: true, folder, jars: scanJars(folder), hasProps: fs.existsSync(path.join(folder, 'server.properties')), playitFound };
});
ipcMain.handle('setup:save', (_, data) => { serverFolder = data.serverFolder; serverConfig = data; saveConfig(data); return { ok: true }; });
ipcMain.handle('properties:get', () => {
  if (!serverFolder) return { ok: false, error: 'No server folder configured' };
  const f = path.join(serverFolder, 'server.properties');
  if (!fs.existsSync(f)) return { ok: false, error: 'server.properties not found' };
  try { const c = fs.readFileSync(f, 'utf8'); return { ok: true, props: parseProperties(c), raw: c }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('properties:save', (_, updates) => {
  if (!serverFolder) return { ok: false, error: 'No server folder' };
  const f = path.join(serverFolder, 'server.properties');
  try { fs.writeFileSync(f, writeProperties(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', updates)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server:start',     ()      => startServer());
ipcMain.handle('server:stop',      ()      => stopServer());
// Windows-safe force kill — uses taskkill which flushes JVM file handles
// before terminating, unlike SIGKILL which can leave locks on log/world files.
function forceKillProcess(proc, pid) {
  if (process.platform === 'win32') {
    const targetPid = (proc && proc.pid) || pid;
    if (targetPid) {
      exec(`taskkill /F /PID ${targetPid} /T`, { windowsHide: true }, () => {});
    }
    if (proc) { try { proc.kill(); } catch {} }
  } else {
    if (proc) { try { proc.kill('SIGKILL'); } catch {} }
    else if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}

ipcMain.handle('server:restart', async () => {
  if (serverProcess || detachedPid) {
    await new Promise(resolve => {
      if (serverProcess) {
        serverProcess.once('exit', resolve);
        // Always try graceful stop — DO NOT force-kill immediately.
        // Killing forcefully leaves JVM file locks (logs/latest.log, session.lock, world files).
        try { serverProcess.stdin.write('stop\n'); } catch { try { serverProcess.kill('SIGTERM'); } catch {} }
        // Safety net: only force-kill after 60s (enough for any world save)
        const safetyTimer = setTimeout(() => {
          if (serverProcess) {
            send('console:line', { text: '[MehhServerManager] Force-stopping server after 60s timeout…', type: 'warn' });
            forceKillProcess(serverProcess, null);
          }
          resolve();
        }, 60000);
        // Clear timer if server exits normally
        serverProcess.once('exit', () => clearTimeout(safetyTimer));
      } else if (detachedPid) {
        try { process.kill(detachedPid, 'SIGTERM'); } catch {}
        const checkGone = setInterval(async () => {
          const alive = await isPidAliveJava(detachedPid);
          if (!alive) { clearInterval(checkGone); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(checkGone); resolve(); }, 30000);
      } else {
        resolve();
      }
    });

    // Null out all state — exit handler may have already done this
    serverProcess = null;
    detachedPid   = null;
    serverState   = 'stopped';
    clearRuntime();

    // On Windows the JVM releases file handles asynchronously after process exit.
    // Without this delay the next spawn races against the OS releasing
    // logs/latest.log, session.lock, level.dat etc.
    const flushDelay = process.platform === 'win32' ? 3000 : 500;
    await new Promise(r => setTimeout(r, flushDelay));
  }
  return startServer();
});
ipcMain.handle('server:get-state', () => ({ state: serverState, players: Array.from(onlinePlayers.values()), uptime: serverStartTime ? Math.floor((Date.now()-serverStartTime)/1000) : 0, detachedPid }));
ipcMain.handle('console:send',     (_, cmd) => sendCommand(cmd));
ipcMain.handle('players:get',      ()      => Array.from(onlinePlayers.values()));
ipcMain.handle('player:action',    (_, {player, action}) => {
  const cmds = { kick:`kick ${player} Kicked by operator`, ban:`ban ${player} Banned by operator`, op:`op ${player}`, deop:`deop ${player}`, pardon:`pardon ${player}` };
  return sendCommand(cmds[action] || `${action} ${player}`);
});

ipcMain.handle('mods:list',        ()       => serverFolder ? listMods(serverFolder) : { ok: false, error: 'No server folder' });
ipcMain.handle('mods:delete',      (_, p)   => { try { fs.unlinkSync(p); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('mods:add',         async (_, srcs) => {
  if (!serverFolder) return { ok: false, error: 'No server folder' };
  const info = listMods(serverFolder); const dest = info.path;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const errs = [];
  for (const s of srcs) { try { fs.copyFileSync(s, path.join(dest, path.basename(s))); } catch (e) { errs.push(e.message); } }
  return errs.length ? { ok: false, error: errs.join('; ') } : { ok: true };
});
ipcMain.handle('mods:open-dialog', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: 'Add Mod / Plugin', filters: [{ name: 'JAR Files', extensions: ['jar'] }], properties: ['openFile','multiSelections'] });
  return r.canceled ? { ok: false } : { ok: true, paths: r.filePaths };
});
ipcMain.handle('config:update-ram', (_, { maxRam }) => {
  const mx = parseInt(maxRam, 10);
  if (!mx || mx < 1) return { ok: false, error: 'Invalid RAM value' };
  const mn = Math.max(1, Math.floor(mx / 2));
  serverConfig.javaArgs = `-Xmx${mx}G -Xms${mn}G`;
  saveConfig(serverConfig);
  return { ok: true, javaArgs: serverConfig.javaArgs };
});
ipcMain.handle('stats:get-disk', async () => ({ bytes: await getDiskUsage(serverFolder) }));
ipcMain.handle('config:get', () => ({ javaArgs: serverConfig.javaArgs || '-Xmx2G -Xms1G', serverFolder, serverJar: serverConfig.serverJar, playitPath: serverConfig.playitPath || '', serverType: serverConfig.serverType || '', mcVersion: serverConfig.mcVersion || '', serverName: serverConfig.serverName || '', curseforgeApiKey: serverConfig.curseforgeApiKey || '' }));
ipcMain.handle('playit:get-status', ()  => ({ running: !!playitProcess, address: playitAddress }));
ipcMain.handle('playit:start',      ()  => startPlayit());
ipcMain.handle('playit:stop',       ()  => { if (playitProcess) { try { playitProcess.kill(); } catch (_) {} playitProcess = null; playitAddress = null; } send('playit:state', { running: false }); return { ok: true }; });
ipcMain.handle('playit:browse-path', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: 'Locate playit.exe / playit executable', properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  const p = r.filePaths[0];
  serverConfig.playitPath = p; saveConfig(serverConfig);
  return { ok: true, path: p };
});
ipcMain.handle('playit:save-path', (_, p) => {
  serverConfig.playitPath = p; saveConfig(serverConfig); return { ok: true };
});

ipcMain.handle('tunnel:list', () => {
  const cfg = loadConfig();
  return { ok: true, tunnels: cfg?.customTunnels || [] };
});
ipcMain.handle('tunnel:save-all', (_, tunnels) => {
  serverConfig.customTunnels = tunnels; saveConfig(serverConfig); return { ok: true };
});
ipcMain.handle('tunnel:start', (_, { id, execPath, args, postCmd }) => startCustomTunnel(id, execPath, args, postCmd));
ipcMain.handle('tunnel:stop',  (_, { id }) => {
  const proc = customTunnelProcesses.get(id);
  if (proc) { try { proc.kill(); } catch (_) {} customTunnelProcesses.delete(id); }
  send('tunnel:state', { id, running: false }); return { ok: true };
});
ipcMain.handle('tunnel:browse-exe', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { title: 'Select Tunnel Executable', properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});
ipcMain.handle('tunnel:running-ids', () => ({ ids: Array.from(customTunnelProcesses.keys()) }));

ipcMain.handle('files:read',  (_, p)             => { try { return { ok: true, content: fs.readFileSync(p, 'utf8') }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('files:write', (_, { path: p, content }) => { try { fs.writeFileSync(p, content, 'utf8'); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('files:list',              (_, d) => listDirectory(d || serverFolder));
ipcMain.handle('files:open',              (_, p) => { shell.openPath(p); return { ok: true }; });
ipcMain.handle('files:show-in-explorer',  (_, p) => { shell.showItemInFolder(p); return { ok: true }; });
ipcMain.handle('files:get-server-folder', ()     => serverFolder);
ipcMain.handle('window:minimize',         ()     => mainWindow?.minimize());
ipcMain.handle('window:close',            ()     => app.quit());
ipcMain.handle('window:toggle-maximize',  ()     => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());


// ── Mod / Plugin Download Handlers ────────────────────────────────────────────

ipcMain.handle('mods:download-url', async (_, { url, filename }) => {
  if (!serverFolder) return { ok: false, error: 'No server folder configured' };
  const info = listMods(serverFolder);
  const dest = info.path;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  // Sanitize filename
  const safeName = path.basename(filename).replace(/[/\\:*?"<>|]/g, '_');
  const destPath = path.join(dest, safeName);
  try {
    await downloadFileTo(url, destPath, pct => send('download:progress', { filename: safeName, pct }));
    return { ok: true, path: destPath };
  } catch (e) {
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('config:save-settings', (_, settings) => {
  if (settings.curseforgeApiKey !== undefined) serverConfig.curseforgeApiKey = settings.curseforgeApiKey;
  saveConfig(serverConfig);
  return { ok: true };
});

let forceQuit = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 960, minHeight: 640,
    frame: false, backgroundColor: '#08090b',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile('index.html');

  
  mainWindow.on('close', async (e) => {
    if (forceQuit) return; 
    const running = serverProcess || (detachedPid && serverState === 'running');
    if (!running) return; 

    e.preventDefault(); 
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Server is running',
      message: 'The Minecraft server is still running.',
      detail: 'What would you like to do?',
      buttons: ['Stop server & close', 'Close app, keep server running', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });

    if (response === 0) {
      if (serverProcess) {
        try { serverProcess.stdin.write('stop\n'); } catch { try { serverProcess.kill('SIGTERM'); } catch {} }
        // Wait up to 15s for graceful stop before force-killing on close
        const maxWait = process.platform === 'win32' ? 15000 : 8000;
        let waited = 0;
        const waitForStop = setInterval(() => {
          waited += 500;
          if (!serverProcess || waited >= maxWait) {
            clearInterval(waitForStop);
            if (serverProcess) forceKillProcess(serverProcess, null);
            setTimeout(() => { forceQuit = true; app.quit(); }, process.platform === 'win32' ? 1500 : 300);
          }
        }, 500);
      } else if (detachedPid) {
        try { process.kill(detachedPid, 'SIGTERM'); } catch {}
        setTimeout(() => { forceQuit = true; app.quit(); }, 3000);
      } else {
        forceQuit = true; app.quit();
      }
    } else if (response === 1) {
      
      
      forceQuit = true;
      app.quit();
    }
    
  });
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  
  if (playitProcess) { try { playitProcess.kill(); } catch (_) {} }
  for (const proc of customTunnelProcesses.values()) { try { proc.kill(); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
