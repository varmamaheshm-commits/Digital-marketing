/** The only bridge between the page and the desktop shell: background mode and social publishing. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getBackground: () => ipcRenderer.invoke('background:get'),
  setBackground: (on) => ipcRenderer.invoke('background:set', on === true),
  voice: {
    speak: (text, opts) => ipcRenderer.invoke('voice:speak', text, opts),
    voices: () => ipcRenderer.invoke('voice:list'),
  },
  link: {
    start: (cfg) => ipcRenderer.invoke('link:start', cfg),
    stop: () => ipcRenderer.invoke('link:stop'),
    notify: (url, signingKey, event, data) => ipcRenderer.invoke('link:notify', url, signingKey, event, data),
    // The app answers each incoming request; only one handler is kept.
    onRequest: (handler) => {
      ipcRenderer.removeAllListeners('link:request');
      ipcRenderer.on('link:request', async (_e, id, req) => {
        let reply;
        try { reply = await handler(req); } catch { reply = { status: 500, json: { error: 'The app could not answer this request.' } }; }
        ipcRenderer.send('link:reply', id, reply);
      });
    },
  },
  social: {
    connect: (provider, creds) => ipcRenderer.invoke('social:connect', provider, creds),
    publish: (target, account, job) => ipcRenderer.invoke('social:publish', target, account, job),
  },
});
