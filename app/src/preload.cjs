// The only bridge between the window and the app: one call channel in, one state channel out.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tap', {
  call: (name, ...args) => ipcRenderer.invoke('tap', name, ...args),
  onState: listener => ipcRenderer.on('state', (_event, state) => listener(state)),
  onShowSettings: listener => ipcRenderer.on('show-settings', () => listener()),
});
