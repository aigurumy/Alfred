const { contextBridge, ipcRenderer } = require('electron');

// Debug: Log that preload is loading
console.log('Preload script loading...');

// Expose protected methods to renderer via IPC
try {
  contextBridge.exposeInMainWorld('electronAPI', {
    // AI Content Generation using OpenRouter (legacy, kept for compatibility)
    generateContent: async (request, apiKey) => {
      return await ipcRenderer.invoke('generate-content', request, apiKey);
    },

    // Chat interface - send message with conversation history (+ optional files)
    sendChatMessage: async (conversationHistory, newMessage, uploadedFiles = []) => {
      return await ipcRenderer.invoke('send-chat-message', conversationHistory, newMessage, uploadedFiles);
    },

    // Process uploaded files (extract text from PDFs/Word, convert images to base64)
    processUploadedFiles: async (filePaths) => {
      return await ipcRenderer.invoke('process-uploaded-files', filePaths);
    },

    // Open native file picker dialog
    showOpenFileDialog: async () => {
      return await ipcRenderer.invoke('show-open-file-dialog');
    },

    // Check if Word is running
    checkWordRunning: async () => {
      return await ipcRenderer.invoke('check-word-running');
    },

    // Type content into Word using VBScript
    typeIntoWordVBS: async (content, insertAtCursor = false) => {
      return await ipcRenderer.invoke('type-into-word-vbs', content, insertAtCursor);
    },

    // Window controls
    minimize: () => {
      ipcRenderer.send('window-minimize');
    },
    toggleMaximize: () => {
      ipcRenderer.send('window-toggle-maximize');
    },
    resizeToChatMode: () => {
      ipcRenderer.send('window-resize-to-chat');
    },
    stopTyping: () => {
      ipcRenderer.send('stop-typing');
    },

    // Listen for research status updates
    onResearchStatus: (callback) => {
      ipcRenderer.on('research-status', (event, data) => {
        callback(data);
      });
    },
    
    // Listen for streaming chat chunks
    onChatStream: (callback) => {
      ipcRenderer.on('chat-stream', (event, data) => {
        callback(data);
      });
    },

    // Open a URL in the system's default browser
    openExternal: (url) => {
      ipcRenderer.send('open-external', url);
    },

    // Check if the user can send a message (login + usage limit)
    checkCanSend: async () => ipcRenderer.invoke('auth-check-can-send'),

    // Session management
    createSession: async () => ipcRenderer.invoke('session-create'),
    loadSession: async (sessionId) => ipcRenderer.invoke('session-load', sessionId),
    saveSession: async (sessionId, messages, title) => ipcRenderer.invoke('session-save', sessionId, messages, title),
    deleteSession: async (sessionId) => ipcRenderer.invoke('session-delete', sessionId),
    listSessions: async () => ipcRenderer.invoke('session-list'),
    
    // Listen for session load event (when window opens with a session)
    onLoadSession: (callback) => {
      ipcRenderer.on('load-session', (event, session) => {
        callback(session);
      });
    },

    // Humanize text via Undetectable.ai
    humanizeText: async (text, originalQuery) => {
      return await ipcRenderer.invoke('humanize-text', text, originalQuery);
    },

  });
  
  console.log('Preload script loaded successfully - electronAPI exposed');
  
  // Forward main process console logs to renderer
  ipcRenderer.on('main-console-log', (event, message) => {
    console.log('[MAIN]', message);
  });
  ipcRenderer.on('main-console-error', (event, message) => {
    console.error('[MAIN ERROR]', message);
  });
} catch (error) {
  console.error('Error in preload script:', error);
}
