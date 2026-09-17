'use strict';

// Preload for agent-built mini-app windows. The generated page is untrusted
// model output, so it gets no node access — only these two calls.
const { contextBridge, ipcRenderer } = require('electron');

/* The app runs inside a <webview> in the conversation, so it talks to the chat
   through its host renderer rather than straight to the main process. */
const bridge = {
  /** Send a message back into the chat, as if the user typed it. */
  send: (text) => ipcRenderer.sendToHost('app', { type: 'send', text: String(text ?? '') }),
  /** Close the expanded view. */
  close: () => ipcRenderer.sendToHost('app', { type: 'close' }),
};

contextBridge.exposeInMainWorld('internall', bridge);
// Apps generated before the rename call window.slavaApp — keep it working.
contextBridge.exposeInMainWorld('slavaApp', bridge);
