const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sik', {
  init: () => ipcRenderer.invoke('app:init'),
  listPorts: () => ipcRenderer.invoke('ports:list'),
  connectRadio: (role, portPath) => ipcRenderer.invoke('radio:connect', role, portPath),
  disconnectRadio: (role) => ipcRenderer.invoke('radio:disconnect', role),
  refreshRadioStats: (role) => ipcRenderer.invoke('radio:refreshStats', role),
  setPreferredPort: (role, portPath) => ipcRenderer.invoke('settings:setPreferredPort', role, portPath),
  setCustomColor: (color) => ipcRenderer.invoke('settings:setCustomColor', color),
  pickFirmwareFile: () => ipcRenderer.invoke('settings:pickFirmwareFile'),
  resetFirmwareFile: () => ipcRenderer.invoke('settings:resetFirmwareFile'),
  setDutyCycle: (role, dutyCycle) => ipcRenderer.invoke('radio:setDutyCycle', role, dutyCycle),
  uploadFirmware: (role, portPath) => ipcRenderer.invoke('radio:uploadFirmware', role, portPath),
  sendLedCommand: (color, customColor) => ipcRenderer.invoke('radio:sendLed', color, customColor),
  sendPowerCommand: (command) => ipcRenderer.invoke('radio:sendPowerCommand', command),
  onPortsChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('ports:changed', handler);
    return () => ipcRenderer.removeListener('ports:changed', handler);
  },
  onRadioStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('radio:status', handler);
    return () => ipcRenderer.removeListener('radio:status', handler);
  },
  onSerialData: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('serial:data', handler);
    return () => ipcRenderer.removeListener('serial:data', handler);
  },
  onCommandReceived: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('radio:commandReceived', handler);
    return () => ipcRenderer.removeListener('radio:commandReceived', handler);
  },
  onUploadProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('radio:uploadProgress', handler);
    return () => ipcRenderer.removeListener('radio:uploadProgress', handler);
  },
  onStatsDebug: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('radio:statsDebug', handler);
    return () => ipcRenderer.removeListener('radio:statsDebug', handler);
  }
});
