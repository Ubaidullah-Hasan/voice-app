const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, typed API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Get the Electron userData path for model caching
   * @returns {Promise<string>}
   */
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),

  /**
   * Show native save file dialog and write the text to disk
   * @param {string} text - The transcript text to save
   * @param {string} [suggestedName] - Default filename suggestion
   * @returns {Promise<{success: boolean, filePath?: string, error?: string, canceled?: boolean}>}
   */
  saveFile: (text, suggestedName) => ipcRenderer.invoke('save-file', { text, suggestedName }),

  /**
   * Show a native OS notification
   * @param {string} title
   * @param {string} body
   */
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', { title, body }),

  /**
   * Listen for menu-triggered save events
   * @param {Function} callback
   */
  onMenuSave: (callback) => {
    ipcRenderer.on('menu-save', callback);
    // Return cleanup function
    return () => ipcRenderer.removeListener('menu-save', callback);
  }
});
