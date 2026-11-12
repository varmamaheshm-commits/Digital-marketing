/** The only bridge between the page and the desktop shell: background mode and social publishing. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getBackground: () => ipcRenderer.invoke('background:get'),
  setBackground: (on) => ipcRenderer.invoke('background:set', on === true),
  social: {
    connect: (provider, creds) => ipcRenderer.invoke('social:connect', provider, creds),
    publish: (target, account, job) => ipcRenderer.invoke('social:publish', target, account, job),
  },
});
