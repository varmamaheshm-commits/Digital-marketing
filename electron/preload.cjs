/** The only bridge between the page and the desktop shell: two calls for background mode. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getBackground: () => ipcRenderer.invoke('background:get'),
  setBackground: (on) => ipcRenderer.invoke('background:set', on === true),
});
