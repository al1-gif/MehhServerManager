const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState:          ()      => ipcRenderer.invoke('app:get-state'),
  chooseFolder:      ()      => ipcRenderer.invoke('setup:choose-folder'),
  saveSetup:         data    => ipcRenderer.invoke('setup:save', data),
  serverStart:       ()      => ipcRenderer.invoke('server:start'),
  serverStop:        ()      => ipcRenderer.invoke('server:stop'),
  serverRestart:     ()      => ipcRenderer.invoke('server:restart'),
  serverGetState:    ()      => ipcRenderer.invoke('server:get-state'),
  consoleSend:       cmd     => ipcRenderer.invoke('console:send', cmd),
  propertiesGet:     ()      => ipcRenderer.invoke('properties:get'),
  propertiesSave:    data    => ipcRenderer.invoke('properties:save', data),
  playersGet:        ()      => ipcRenderer.invoke('players:get'),
  playerAction:      data    => ipcRenderer.invoke('player:action', data),
  modsList:          ()      => ipcRenderer.invoke('mods:list'),
  modsDelete:        p       => ipcRenderer.invoke('mods:delete', p),
  modsAdd:           paths   => ipcRenderer.invoke('mods:add', paths),
  modsOpenDialog:    ()      => ipcRenderer.invoke('mods:open-dialog'),
  playitGetStatus:   ()      => ipcRenderer.invoke('playit:get-status'),
  playitStart:       ()      => ipcRenderer.invoke('playit:start'),
  playitStop:        ()      => ipcRenderer.invoke('playit:stop'),
  playitBrowsePath:  ()      => ipcRenderer.invoke('playit:browse-path'),
  playitSavePath:    p       => ipcRenderer.invoke('playit:save-path', p),
  updateRam:         data    => ipcRenderer.invoke('config:update-ram', data),
  getDisk:           ()      => ipcRenderer.invoke('stats:get-disk'),
  getConfig:         ()      => ipcRenderer.invoke('config:get'),

  tunnelList:        ()      => ipcRenderer.invoke('tunnel:list'),
  tunnelSaveAll:     tunnels => ipcRenderer.invoke('tunnel:save-all', tunnels),
  tunnelStart:       data    => ipcRenderer.invoke('tunnel:start', data),
  tunnelStop:        data    => ipcRenderer.invoke('tunnel:stop', data),
  tunnelBrowseExe:   ()      => ipcRenderer.invoke('tunnel:browse-exe'),
  tunnelRunningIds:  ()      => ipcRenderer.invoke('tunnel:running-ids'),

  filesList:         dir     => ipcRenderer.invoke('files:list', dir),
  filesRead:         p       => ipcRenderer.invoke('files:read', p),
  filesWrite:        data    => ipcRenderer.invoke('files:write', data),
  filesOpen:         p       => ipcRenderer.invoke('files:open', p),
  filesShowExplorer: p       => ipcRenderer.invoke('files:show-in-explorer', p),
  filesGetRoot:      ()      => ipcRenderer.invoke('files:get-server-folder'),

  // Server management
  mcGetVersions:     data    => ipcRenderer.invoke('mc:get-versions', data),
  serversList:       ()      => ipcRenderer.invoke('servers:list'),
  serversCreate:     data    => ipcRenderer.invoke('servers:create', data),
  serversImport:     data    => ipcRenderer.invoke('servers:import', data),
  serversDelete:     data    => ipcRenderer.invoke('servers:delete', data),
  serversSwitch:     data    => ipcRenderer.invoke('servers:switch', data),

  modsDownloadUrl:   data    => ipcRenderer.invoke('mods:download-url', data),
  configSaveSettings:data    => ipcRenderer.invoke('config:save-settings', data),

  minimize:          ()      => ipcRenderer.invoke('window:minimize'),
  close:             ()      => ipcRenderer.invoke('window:close'),
  toggleMaximize:    ()      => ipcRenderer.invoke('window:toggle-maximize'),

  on: (channel, cb) => {
    const allowed = ['console:line','server:state','players:updated','stats:update',
                     'playit:line','playit:address','playit:state',
                     'tunnel:output','tunnel:state','player:inventory',
                     'create:progress','create:log','download:progress'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, data) => cb(data));
  },
  off: channel => ipcRenderer.removeAllListeners(channel),
});
