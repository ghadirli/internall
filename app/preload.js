'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('internall', {
  getState: () => ipcRenderer.invoke('state:get'),
  listModels: (provider) => ipcRenderer.invoke('models:list', provider),

  saveAgent: (agent) => ipcRenderer.invoke('agent:save', agent),
  deleteAgent: (id) => ipcRenderer.invoke('agent:delete', id),
  clearAgent: (id) => ipcRenderer.invoke('agent:clear', id),
  activateAgent: (id) => ipcRenderer.invoke('agent:activate', id),
  markRead: (id) => ipcRenderer.invoke('agent:read', id),
  saveDraft: (id, text) => ipcRenderer.invoke('agent:draft', { id, text }),

  send: (agentId, text) => ipcRenderer.invoke('chat:send', { agentId, text }),
  stop: (agentId) => ipcRenderer.invoke('chat:stop', agentId),

  setApiKey: (provider, key) => ipcRenderer.invoke('key:set', { provider, key }),
  testApiKey: (provider, key) => ipcRenderer.invoke('key:test', { provider, key }),
  appInfo: (appId) => ipcRenderer.invoke('app:info', appId),
  appThumb: (appId) => ipcRenderer.invoke('app:thumb', appId),
  appSend: (agentId, text) => ipcRenderer.invoke('app:send', { agentId, text }),
  listUsage: () => ipcRenderer.invoke('usage:list'),
  resetUsage: (id) => ipcRenderer.invoke('usage:reset', id),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),
  toggleTask: (id) => ipcRenderer.invoke('tasks:toggle', id),
  respondConfirm: (id, ok) => ipcRenderer.invoke('confirm:respond', { id, ok }),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  voiceInfo: () => ipcRenderer.invoke('voice:info'),
  transcribe: (data, mime) => ipcRenderer.invoke('voice:transcribe', { data, mime }),
  speak: (text, voice) => ipcRenderer.invoke('voice:speak', { text, voice }),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  onStreamStart: on('stream:start'),
  onStreamBlock: on('stream:block'),
  onStreamDelta: on('stream:delta'),
  onStreamTool: on('stream:tool'),
  onStreamMessage: on('stream:message'),
  onStreamError: on('stream:error'),
  onStreamReset: on('stream:reset'),
  onStreamStatus: on('stream:status'),
  onStreamEnd: on('stream:end'),
  onAgentNavigate: on('browser:agent-navigate'),
  onAgentAction: on('browser:agent-action'),
  onConfirm: on('confirm:request'),
  onAppCreated: on('app:created'),
  onTasksChanged: on('tasks:changed'),
  onAgentFocus: on('agent:focus'),
  onUserMessage: on('chat:user-message'),
  onMenu: on('menu'),
});
