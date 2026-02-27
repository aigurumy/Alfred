// Chat interface for Alfred
let conversationHistory = [];
let currentSessionId = null; // Track current session
let isLoadingSession = false; // Flag to prevent auto-save during session load
let wordCheckInterval = null;
let pendingContent = null; // Store content ready to be typed
let lastUserQuery = ''; // Track the latest user query for humanization purpose classification

// ─── File Upload State ────────────────────────────────────────────────────────
// Stores processed file objects ready to be sent with the next message
let pendingFiles = [];

const FILE_ICONS = {
  image: '🖼️',
  pdf:   '📄',
  word:  '📝',
  text:  '📃',
  unknown: '📁'
};

const FILE_TYPE_LABELS = {
  image: 'Image',
  pdf:   'PDF',
  word:  'Word',
  text:  'Text',
  unknown: 'File'
};
// ─────────────────────────────────────────────────────────────────────────────

// Welcome overlay handling (kept for backwards compatibility)
function closeWelcome() {
  const overlay = document.getElementById('welcomeOverlay');
  if (!overlay) return; // No welcome screen in dashboard mode
  const chatContainer = document.getElementById('chatContainer');
  const inputArea = document.querySelector('.input-area');
  overlay.classList.add('hidden');
  chatContainer.classList.remove('hidden');
  if (inputArea) inputArea.classList.remove('hidden');
  if (window.electronAPI && window.electronAPI.resizeToChatMode) {
    window.electronAPI.resizeToChatMode();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const welcomeOverlay = document.getElementById('welcomeOverlay');
  const chatContainer = document.getElementById('chatContainer');
  const inputArea = document.querySelector('.input-area');

  if (welcomeOverlay) {
    // Legacy welcome screen present — show it, hide chat
    welcomeOverlay.classList.remove('hidden');
    chatContainer.classList.add('hidden');
    if (inputArea) inputArea.classList.add('hidden');
  } else {
    // Dashboard mode — chat starts visible immediately
    if (chatContainer) chatContainer.classList.remove('hidden');
    if (inputArea) inputArea.classList.remove('hidden');
  }

  // Wait for electronAPI to be available
  if (window.electronAPI) {
    // Check Word status on load
    checkWordStatus();
    
    // Auto-check Word status every 5 seconds
    wordCheckInterval = setInterval(() => {
      checkWordStatus(true); // Silent check
    }, 5000);
    
    // Set up research status listener
    if (window.electronAPI.onResearchStatus) {
      window.electronAPI.onResearchStatus((data) => {
        if (data.researching) {
          showResearchIndicator();
        } else {
          hideResearchIndicator();
        }
      });
    }
    
    // Set up streaming listener
    if (window.electronAPI.onChatStream) {
      window.electronAPI.onChatStream((data) => {
        if (data.type === 'chunk') {
          appendStreamingChunk(data.content);
        } else if (data.type === 'done') {
          finalizeStreamingMessage();
        }
      });
    }
    
    // Set up session loading listener
    if (window.electronAPI.onLoadSession) {
      window.electronAPI.onLoadSession((session) => {
        if (session) {
          currentSessionId = session.id;
          isLoadingSession = true;
          console.log('[Session] Loading session:', session.id, 'Messages:', session.messages?.length || 0);
          // Load messages from session
          if (session.messages && session.messages.length > 0) {
            conversationHistory = [];
            session.messages.forEach(msg => {
              console.log('[Session] Loading message:', msg.role, msg.content.substring(0, 50));
              addMessage(msg.role, msg.content, false);
            });
          }
          isLoadingSession = false;
          console.log('[Session] Loaded', conversationHistory.length, 'messages into conversationHistory');
        }
      });
    }
  } else {
    console.error('electronAPI not available - preload script may not have loaded');
    addMessage('system', 'Error: Application not properly initialized. Please restart the app.');
  }

  // Track user scroll so we don't hijack scroll during generation
  // Note: chatContainer is already declared above in this same scope
  if (chatContainer) {
    chatContainer.addEventListener('scroll', () => {
      const distFromBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
      userScrolled = distFromBottom > 150;
    });
  }

  // Set up drag-and-drop and file input listener
  setupDragAndDrop();

  // Auto-resize textarea
  const chatInput = document.getElementById('chatInput');
  chatInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // Send on Enter (but allow Shift+Enter for new line)
  chatInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
});

// Clean up interval and save session when page unloads
window.addEventListener('beforeunload', () => {
  if (wordCheckInterval) {
    clearInterval(wordCheckInterval);
  }
  // Force save session before closing (synchronous if possible)
  if (currentSessionId && conversationHistory.length > 0) {
    // Try to save synchronously, but don't block if it fails
    try {
      const messagesToSave = conversationHistory.filter(msg => msg.role !== 'system');
      if (window.electronAPI?.saveSession) {
        // Use sendSync if available, otherwise just try async (may not complete)
        window.electronAPI.saveSession(currentSessionId, messagesToSave).catch(() => {});
      }
    } catch (e) {
      // Ignore errors on unload
    }
  }
});

async function checkWordStatus(silent = false) {
  const statusEl = document.getElementById('wordStatus');
  
  if (!window.electronAPI) {
    if (!silent) {
      statusEl.className = 'word-status not-ready';
      statusEl.innerHTML = '<span class="status-indicator"></span>API not available';
    }
    return;
  }

  try {
    const isRunning = await window.electronAPI.checkWordRunning();
    if (isRunning) {
      statusEl.className = 'word-status ready';
      statusEl.innerHTML = '<span class="status-indicator"></span>Word Connected';
      statusEl.title = 'Microsoft Word is running and ready';
    } else {
      statusEl.className = 'word-status not-ready';
      statusEl.innerHTML = '<span class="status-indicator"></span>Word Not Running';
      statusEl.title = 'Please open Microsoft Word';
    }
  } catch (error) {
    if (!silent) {
      statusEl.className = 'word-status not-ready';
      statusEl.innerHTML = '<span class="status-indicator"></span>Error checking Word';
      statusEl.title = 'Failed to check Word status';
    }
  }
}

// Make closeWelcome globally available
window.closeWelcome = closeWelcome;

// Variant of addMessage that also shows attachment chips above the text
function addMessageWithFiles(role, content, files = []) {
  const chatContainer = document.getElementById('chatContainer');
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;

  const isUser = role === 'user';
  const avatar = isUser ? '👤' : '';

  const attachmentsHtml = files.length > 0 ? buildAttachmentChips(files) : '';

  messageDiv.innerHTML = `
    ${isUser ? `<div class="message-avatar">${avatar}</div>` : ''}
    <div>
      ${attachmentsHtml}
      <div class="message-content">${formatMessage(content)}</div>
    </div>
  `;

  chatContainer.appendChild(messageDiv);
  scrollToBottom(true); // Always scroll for new messages

  // Store plain text in conversation history (files are handled separately in send)
  conversationHistory.push({ role, content });
  
  // Auto-save session after adding message (debounced, but not during load)
  if (currentSessionId && role !== 'system' && !isLoadingSession) {
    setTimeout(() => saveCurrentSession(), 500);
  }
}

// Save current session
async function saveCurrentSession() {
  if (!currentSessionId || !window.electronAPI?.saveSession) return;
  
  try {
    // Filter out system messages for storage (keep them in UI but not in session)
    const messagesToSave = conversationHistory.filter(msg => msg.role !== 'system');
    console.log('[Session] Saving session:', currentSessionId, 'Messages:', messagesToSave.length, messagesToSave.map(m => m.role));
    await window.electronAPI.saveSession(currentSessionId, messagesToSave);
  } catch (error) {
    console.error('Error saving session:', error);
  }
}

function addMessage(role, content, showActions = false) {
  const chatContainer = document.getElementById('chatContainer');
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;

  const avatar = role === 'user' ? '👤' : '';
  const isUser = role === 'user';

  messageDiv.innerHTML = `
    ${isUser ? `<div class="message-avatar">${avatar}</div>` : ''}
    <div>
      <div class="message-content">${formatMessage(content)}</div>
      ${showActions && !isUser ? `
        <div class="message-actions">
          <button class="btn-small btn-type-word">
            Paste into Word
          </button>
          <button class="btn-small btn-humanize">
            ✨ Humanize
          </button>
        </div>
      ` : ''}
    </div>
  `;

  chatContainer.appendChild(messageDiv);
  
  // Attach content to the buttons using closures
  if (showActions && !isUser) {
    const typeBtn = messageDiv.querySelector('.btn-type-word');
    if (typeBtn) {
      typeBtn.onclick = (event) => typeContentIntoWord(event, content);
    }
    const humanizeBtn = messageDiv.querySelector('.btn-humanize');
    if (humanizeBtn) {
      const queryForHumanize = lastUserQuery;
      humanizeBtn.onclick = () => window.humanizeMessage(humanizeBtn, messageDiv, content, queryForHumanize);
    }
  }
  
  scrollToBottom(true); // Always scroll for new messages

  // Store in conversation history
  conversationHistory.push({ role, content });
  
  // Auto-save session after adding message (debounced, but not during load)
  if (currentSessionId && role !== 'system' && !isLoadingSession) {
    setTimeout(() => saveCurrentSession(), 500);
  }
}

function formatMessage(text) {
  // Convert markdown-style formatting to HTML
  // Process headings first (before line breaks)
  let formatted = text
    // Headings (must be at start of line)
    .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    // Line breaks
    .replace(/\n/g, '<br>')
    // Bold and italic
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Clickable links — must run last to avoid conflicting with other replacements
    .replace(/(https?:\/\/[^\s<>"')\]]+)/g, (url) => {
      const safeUrl = url.replace(/'/g, '%27');
      return `<a class="chat-link" href="#" onclick="window.openLink('${safeUrl}');return false;">${url}</a>`;
    });
  
  return formatted;
}

// Open a URL in the system's default browser via Electron shell
function openLink(url) {
  if (window.electronAPI && window.electronAPI.openExternal) {
    window.electronAPI.openExternal(url);
  }
}
window.openLink = openLink;

function addTypingIndicator() {
  const chatContainer = document.getElementById('chatContainer');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'message ai';
  typingDiv.id = 'typingIndicator';
  typingDiv.innerHTML = `
    <div class="typing-indicator">
      <div class="loading-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <span>Alfred is thinking...</span>
    </div>
  `;
  chatContainer.appendChild(typingDiv);
  scrollToBottom(true); // Force scroll when typing indicator appears
}

function removeTypingIndicator() {
  const indicator = document.getElementById('typingIndicator');
  if (indicator) {
    indicator.remove();
  }
}

let researchIndicator = null;

function showResearchIndicator() {
  const chatContainer = document.getElementById('chatContainer');
  // Remove existing if any
  if (researchIndicator) {
    researchIndicator.remove();
  }
  
  researchIndicator = document.createElement('div');
  researchIndicator.className = 'message system';
  researchIndicator.id = 'researchIndicator';
  researchIndicator.innerHTML = `
    <div class="message-avatar">🔍</div>
    <div class="message-content">
      <span>Researching reliable sources...</span>
    </div>
  `;
  chatContainer.appendChild(researchIndicator);
  scrollToBottom(true);
}

function hideResearchIndicator() {
  if (researchIndicator) {
    researchIndicator.remove();
    researchIndicator = null;
  }
}

// Track whether user has manually scrolled up during generation
let userScrolled = false;

function scrollToBottom(force = false) {
  const chatContainer = document.getElementById('chatContainer');
  // If forced (new message sent/received) OR user hasn't scrolled up, auto-scroll
  if (force || !userScrolled) {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }
}

function removeTrailingConversational(text) {
  // Patterns to detect trailing conversational messages
  const trailingPatterns = [
    /\n\n(if\s+(?:you\s+)?(?:think\s+)?(?:you\s+)?(?:want\s+to\s+)?(?:change|modify|edit|adjust|revise|update).*?)$/i,
    /\n\n(if\s+(?:you\s+)?(?:need|want|would\s+like).*?(?:let\s+me\s+know|tell\s+me|just\s+ask).*?)$/i,
    /\n\n(feel\s+free\s+to.*?)$/i,
    /\n\n(please\s+(?:let\s+me\s+know|tell\s+me|feel\s+free).*?)$/i,
    /\n\n(i\s+(?:hope|trust|think).*?(?:helpful|useful|good).*?)$/i,
    /\n\n(.*?(?:let\s+me\s+know|tell\s+me|just\s+ask|feel\s+free).*?)$/i,
    /\n\n(.*?(?:if\s+you\s+have\s+any\s+questions|if\s+you\s+need\s+anything).*?)$/i
  ];

  let cleanedText = text;
  let trailingMessage = null;

  for (const pattern of trailingPatterns) {
    const match = cleanedText.match(pattern);
    if (match) {
      const trailing = match[1].trim();
      // Only remove if trailing message is relatively short (conversational, not content)
      if (trailing.length < 150 && trailing.split('\n').length <= 2) {
        cleanedText = cleanedText.replace(pattern, '').trim();
        trailingMessage = trailing;
        break; // Remove only the first match
      }
    }
  }

  return { content: cleanedText, trailing: trailingMessage };
}

function splitConversationalAndContent(text) {
  if (!text || text.trim().length === 0) {
    return { intro: null, content: null, trailing: null };
  }

  const trimmedText = text.trim();
  const minContentLength = 50; // Lower threshold for content detection
  
  // First, remove any trailing conversational messages
  const { content: textWithoutTrailing, trailing } = removeTrailingConversational(trimmedText);
  
  // Detect if response has conversational intro + content
  // Patterns to detect: "Here is", "Here's", "Below is", etc.
  const splitPatterns = [
    /^(.*?(?:here\s+is|here's|below\s+is|i've\s+written|i've\s+prepared|let\s+me\s+write|i'll\s+write|i'll\s+create)[^\n]*\n+)([\s\S]+)$/i,
    /^(.*?(?:sure|okay|alright|here|below)[^\n]*:\s*\n+)([\s\S]+)$/i,  // "Sure:" or "Here:" followed by content
    /^(.*?:\s*\n+)([\s\S]+)$/,  // Split at colon followed by newlines
    /^(.*?\n\n)([\s\S]+)$/      // Split at double newline
  ];

  for (const pattern of splitPatterns) {
    const match = textWithoutTrailing.match(pattern);
    if (match) {
      const intro = match[1].trim();
      const content = match[2].trim();
      
      // Only split if content is substantial
      if (content.length >= minContentLength) {
        return { intro, content, trailing };
      }
    }
  }

  // No split detected - check if entire response is content
  // More lenient: if it's substantial text, treat as content
  if (textWithoutTrailing.length >= minContentLength) {
    // Check if it looks like content (has structure, not just a short reply)
    const hasStructure = textWithoutTrailing.includes('\n') || 
                        textWithoutTrailing.split('.').length > 2 || 
                        textWithoutTrailing.split(' ').length > 20;
    
    if (hasStructure || textWithoutTrailing.length > 150) {
      // Likely all content, no intro
      return { intro: null, content: textWithoutTrailing, trailing };
    }
  }

  // Very short response or conversational only (less than minContentLength)
  if (textWithoutTrailing.length < minContentLength) {
    return { intro: textWithoutTrailing, content: null, trailing };
  }

  // Fallback: if we have substantial text but no clear pattern, treat as content
  return { intro: null, content: textWithoutTrailing, trailing };
}

let currentStreamingMessage = null;
let streamingContent = '';
let streamingOccurred = false;

function startStreamingMessage() {
  removeTypingIndicator();
  streamingOccurred = true;
  const chatContainer = document.getElementById('chatContainer');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message ai';
  messageDiv.id = 'streamingMessage';
  
  messageDiv.innerHTML = `
    <div>
      <div class="message-content"></div>
    </div>
  `;
  
  chatContainer.appendChild(messageDiv);
  currentStreamingMessage = messageDiv.querySelector('.message-content');
  streamingContent = '';
  userScrolled = false; // Reset scroll tracking when new AI response starts
  scrollToBottom(true);
}

function appendStreamingChunk(chunk) {
  if (!currentStreamingMessage) {
    startStreamingMessage();
  }
  streamingContent += chunk;
  currentStreamingMessage.innerHTML = formatMessage(streamingContent);
  scrollToBottom();
}

function finalizeStreamingMessage() {
  if (currentStreamingMessage) {
    const messageDiv = document.getElementById('streamingMessage');
    if (messageDiv) {
      messageDiv.id = ''; // Remove streaming ID
      
      // Split conversational intro from actual content (same logic as non-streaming path)
      const splitResult = splitConversationalAndContent(streamingContent);
      
      // Determine which content to use for typing into Word
      let contentForTyping;
      if (splitResult.content) {
        contentForTyping = splitResult.content;
        console.log('Content stored for typing (intro removed):', contentForTyping.substring(0, 50) + '...');
      } else if (splitResult.intro && splitResult.intro.length >= 50) {
        // If no content split but intro is substantial, use it
        contentForTyping = splitResult.intro;
        console.log('Intro treated as content for typing');
      } else {
        // Fallback: use full content if no split detected
        contentForTyping = streamingContent;
        console.log('No split detected, using full streaming content');
      }
      
      // Add "Paste into Word" and "Humanize" buttons
      const contentDiv = messageDiv.querySelector('div:last-child');
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'message-actions';

      const typeBtn = document.createElement('button');
      typeBtn.className = 'btn-small btn-type-word';
      typeBtn.textContent = 'Paste into Word';
      typeBtn.onclick = (event) => typeContentIntoWord(event, contentForTyping);

      const humanizeBtn = document.createElement('button');
      humanizeBtn.className = 'btn-small btn-humanize';
      humanizeBtn.textContent = '✨ Humanize';
      const queryForHumanize = lastUserQuery;
      humanizeBtn.onclick = () => window.humanizeMessage(humanizeBtn, messageDiv, contentForTyping, queryForHumanize);

      actionsDiv.appendChild(typeBtn);
      actionsDiv.appendChild(humanizeBtn);
      contentDiv.appendChild(actionsDiv);
      
      // Legacy support: keep global pendingContent for backward compatibility
      pendingContent = contentForTyping;
    }
    
    conversationHistory.push({ role: 'ai', content: streamingContent });
    currentStreamingMessage = null;
    streamingContent = '';
    
    // Save session after streaming message is finalized
    if (currentSessionId && !isLoadingSession) {
      setTimeout(() => saveCurrentSession(), 500);
    }
  }
}

function resetStreamingState() {
  streamingOccurred = false;
}

// ─── File Upload Functions ───────────────────────────────────────────────────

// Trigger native file picker (via Electron dialog)
async function triggerFileUpload() {
  if (!window.electronAPI) return;
  try {
    const filePaths = await window.electronAPI.showOpenFileDialog();
    if (filePaths && filePaths.length > 0) {
      await processFiles(filePaths);
    }
  } catch (err) {
    console.error('File dialog error:', err);
  }
}
window.triggerFileUpload = triggerFileUpload;

// Process file paths through the backend, then update the preview area
async function processFiles(filePaths) {
  if (!window.electronAPI) return;

  // Enforce max 5 files total
  const remaining = 5 - pendingFiles.length;
  if (remaining <= 0) {
    alert('You can attach a maximum of 5 files per message.');
    return;
  }
  const pathsToProcess = filePaths.slice(0, remaining);

  try {
    const processed = await window.electronAPI.processUploadedFiles(pathsToProcess);
    for (const file of processed) {
      if (file.error) {
        addMessage('system', `⚠ Could not attach "${file.name}": ${file.error}`);
        continue;
      }
      pendingFiles.push(file);
    }
    renderFilePreviews();
  } catch (err) {
    console.error('Error processing files:', err);
    addMessage('system', `⚠ Error processing files: ${err.message}`);
  }
}

// Render file preview cards in the #filePreviews container
function renderFilePreviews() {
  const container = document.getElementById('filePreviews');
  const uploadBtn = document.getElementById('uploadBtn');
  if (!container) return;

  container.innerHTML = '';

  pendingFiles.forEach((file, idx) => {
    const card = document.createElement('div');
    card.className = 'file-preview-card';

    let iconOrThumb;
    if (file.type === 'image' && file.preview) {
      iconOrThumb = `<img class="file-thumb" src="${file.preview}" alt="${file.name}">`;
    } else {
      iconOrThumb = `<span class="file-icon">${FILE_ICONS[file.type] || FILE_ICONS.unknown}</span>`;
    }

    card.innerHTML = `
      ${iconOrThumb}
      <div class="file-info">
        <div class="file-name" title="${file.name}">${file.name}</div>
        <div class="file-type-badge">${FILE_TYPE_LABELS[file.type] || 'File'}</div>
      </div>
      <button class="file-remove" title="Remove" onclick="removeFile(${idx})">✕</button>
    `;
    container.appendChild(card);
  });

  // Update upload button state
  if (uploadBtn) {
    uploadBtn.classList.toggle('has-files', pendingFiles.length > 0);
  }
}

// Remove a file from the pending list
function removeFile(index) {
  pendingFiles.splice(index, 1);
  renderFilePreviews();
}
window.removeFile = removeFile;

// Build attachment chips for the user message bubble
function buildAttachmentChips(files) {
  if (!files || files.length === 0) return '';
  const chips = files.map(f => {
    if (f.type === 'image' && f.preview) {
      return `<span class="attachment-chip"><img class="chip-thumb" src="${f.preview}" alt="${f.name}">${f.name}</span>`;
    }
    return `<span class="attachment-chip">${FILE_ICONS[f.type] || '📁'} ${f.name}</span>`;
  }).join('');
  return `<div class="message-attachments">${chips}</div>`;
}

// Set up drag-and-drop on the input area
function setupDragAndDrop() {
  const inputArea = document.getElementById('inputArea');
  if (!inputArea) return;

  inputArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    inputArea.classList.add('drag-over');
  });

  inputArea.addEventListener('dragleave', (e) => {
    if (!inputArea.contains(e.relatedTarget)) {
      inputArea.classList.remove('drag-over');
    }
  });

  inputArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    inputArea.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    const filePaths = files.map(f => f.path).filter(Boolean);
    if (filePaths.length > 0) {
      await processFiles(filePaths);
    }
  });

  // Also wire the hidden <input type="file">
  const fileInput = document.getElementById('fileInput');
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files);
      const filePaths = files.map(f => f.path).filter(Boolean);
      if (filePaths.length > 0) {
        await processFiles(filePaths);
      }
      fileInput.value = ''; // reset so same file can be re-selected
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function sendMessage() {
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const message = chatInput.value.trim();

  // Allow sending with files even if text is empty
  if (!message && pendingFiles.length === 0) return;

  // Track query for humanization purpose classification
  lastUserQuery = message;

  // Check if electronAPI is available
  if (!window.electronAPI) {
    addMessage('system', 'Error: Application API not available. Please restart the app.');
    return;
  }

  // ── Usage / auth check ──────────────────────────────────────────────────
  if (window.electronAPI && window.electronAPI.checkCanSend) {
    let limitCheck;
    try {
      limitCheck = await window.electronAPI.checkCanSend();
    } catch (e) {
      limitCheck = { canSend: true }; // If check fails, allow (fail-open to avoid locking users out on network issues)
    }

    if (!limitCheck.canSend) {
      if (limitCheck.reason === 'not-logged-in') {
        addMessage('system', '🔒 You need to sign in to use Alfred. Open the Alfred Dashboard and log in.');
      } else if (limitCheck.reason === 'trial-exhausted') {
        addMessage('system', '⚡ You\'ve used all your free trial tokens. Upgrade to Casual in the Alfred Dashboard for unlimited access — RM 7.99/month.');
      } else if (limitCheck.reason === 'monthly-limit-reached') {
        const resetDate = limitCheck.resetAt
          ? new Date(limitCheck.resetAt).toLocaleDateString('en-MY', { day: 'numeric', month: 'long' })
          : 'next month';
        addMessage('system', `⏳ You've reached your monthly token limit. Your usage resets on ${resetDate}. Contact us if you need more.`);
      } else {
        addMessage('system', '⚠ Unable to send message. Please check your account in the Alfred Dashboard.');
      }
      sendBtn.disabled = false;
      chatInput.focus();
      return;
    }

    // Warn when trial is running low (less than 3,000 tokens remaining ≈ ~1-2 responses left)
    if (limitCheck.plan === 'trial' && limitCheck.remaining <= 3000 && limitCheck.remaining > 0) {
      const remaining = limitCheck.remaining.toLocaleString();
      addMessage('system', `⚠ Only ~${remaining} free tokens remaining. Upgrade in the Dashboard to keep going.`);
    }

    // Warn casual users when running low on monthly tokens (~25,000 left ≈ ~5 responses)
    if (limitCheck.plan === 'casual' && limitCheck.remaining <= 25000 && limitCheck.remaining > 0) {
      const remaining = limitCheck.remaining.toLocaleString();
      const resetDate = limitCheck.resetAt
        ? new Date(limitCheck.resetAt).toLocaleDateString('en-MY', { day: 'numeric', month: 'long' })
        : 'next month';
      addMessage('system', `⚠ Running low — ~${remaining} tokens left this month. Resets on ${resetDate}.`);
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  // Snapshot files to send, then clear pending
  const filesToSend = [...pendingFiles];
  pendingFiles = [];
  renderFilePreviews();

  // Add user message to chat (with attachment chips if any)
  addMessageWithFiles('user', message || '(attached files)', filesToSend);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  sendBtn.disabled = true;

  // Reset scroll state so user sees the typing indicator and start of response
  userScrolled = false;

  // Show typing indicator
  addTypingIndicator();
  resetStreamingState();

  try {
    // Send conversation to AI
    const historyWithoutLast = conversationHistory.slice(0, -1);
    const response = await window.electronAPI.sendChatMessage(historyWithoutLast, message, filesToSend);
    
    // Check if streaming occurred - if yes, content is already displayed
    if (!streamingOccurred) {
      // No streaming occurred (maybe search only, greeting, or error), show response normally
      removeTypingIndicator();

      // Split conversational intro from actual content
      const fullResponse = response.content || '';
      const splitResult = splitConversationalAndContent(fullResponse);
      
      console.log('AI Response split:', { 
        hasIntro: !!splitResult.intro, 
        hasContent: !!splitResult.content,
        hasTrailing: !!splitResult.trailing,
        introLength: splitResult.intro?.length || 0,
        contentLength: splitResult.content?.length || 0,
        trailingLength: splitResult.trailing?.length || 0
      });
      
      // Add intro message if present (only if we also have content to show separately)
      if (splitResult.intro && splitResult.content) {
        addMessage('ai', splitResult.intro, false);
      }
      
      // Add content message if present (with button) - this is what gets typed into Word
      if (splitResult.content) {
        addMessage('ai', splitResult.content, true);
        pendingContent = splitResult.content; // Store clean content without trailing messages
        console.log('Content stored for typing (trailing removed):', pendingContent.substring(0, 50) + '...');
      } else if (splitResult.intro) {
        // Only intro - check if it's substantial enough to be typed
        const isSubstantial = splitResult.intro.length >= 50;
        addMessage('ai', splitResult.intro, isSubstantial);
        if (isSubstantial) {
          pendingContent = splitResult.intro;
          console.log('Intro treated as content for typing');
        } else {
          pendingContent = null;
        }
      } else {
        // No split detected - show full response
        const isSubstantial = fullResponse.trim().length >= 50;
        addMessage('ai', fullResponse, isSubstantial);
        if (isSubstantial) {
          pendingContent = fullResponse;
        } else {
          pendingContent = null;
        }
      }
      
      // Add trailing conversational message separately (no button)
      if (splitResult.trailing) {
        addMessage('ai', splitResult.trailing, false);
        console.log('Trailing message shown separately:', splitResult.trailing.substring(0, 50) + '...');
      }
    }
    // If streaming occurred, content is already handled by finalizeStreamingMessage

  } catch (error) {
    removeTypingIndicator();
    addMessage('ai', `Sorry, I encountered an error: ${error.message}`);
    console.error('Error:', error);
  } finally {
    sendBtn.disabled = false;
    chatInput.focus();
  }
}

// Global variable to track typing state
let isTyping = false;
let currentTypeButton = null;

function stopTyping() {
  console.log('stopTyping called', { isTyping, hasAPI: !!window.electronAPI, hasStopTyping: !!(window.electronAPI && window.electronAPI.stopTyping) });
  
  if (isTyping && window.electronAPI && window.electronAPI.stopTyping) {
    console.log('Calling stopTyping API...');
    window.electronAPI.stopTyping();
    isTyping = false;
    
    if (currentTypeButton) {
      currentTypeButton.disabled = false;
      currentTypeButton.textContent = 'Paste into Word';
      currentTypeButton.onclick = (e) => typeContentIntoWord(e);
      currentTypeButton.classList.remove('btn-stop-typing');
      currentTypeButton.classList.add('btn-type-word');
    }
    
    addMessage('system', '⏹ Typing stopped by user.');
  } else {
    console.warn('Cannot stop typing:', { isTyping, hasAPI: !!window.electronAPI });
    addMessage('system', '⚠ Unable to stop typing. Process may have already completed.');
  }
}

// Make stopTyping globally available
window.stopTyping = stopTyping;

// ── Humanize ─────────────────────────────────────────────────────────────────

async function humanizeMessage(btn, messageDiv, content, originalQuery) {
  if (!content) {
    addMessage('system', '⚠ No content to humanize.');
    return;
  }

  // Enter loading state
  btn.disabled = true;
  btn.textContent = '⏳ Humanizing...';

  try {
    const humanized = await window.electronAPI.humanizeText(content, originalQuery);

    // Update the displayed message content
    const contentEl = messageDiv.querySelector('.message-content');
    if (contentEl) {
      contentEl.innerHTML = formatMessage(humanized);
    }

    // Re-wire "Paste into Word" button with the new humanized text
    const typeBtn = messageDiv.querySelector('.btn-type-word');
    if (typeBtn) {
      typeBtn.onclick = (event) => typeContentIntoWord(event, humanized);
    }

    // Re-wire this Humanize button so clicking again re-humanizes the new text
    btn.onclick = () => window.humanizeMessage(btn, messageDiv, humanized, originalQuery);

    btn.disabled = false;
    btn.textContent = '✨ Humanize';

    addMessage('system', '✨ Content has been humanized.');

  } catch (error) {
    console.error('[Humanize] Error:', error);
    addMessage('system', `⚠ Humanize failed: ${error.message}`);
    btn.disabled = false;
    btn.textContent = '✨ Humanize';
  }
}

window.humanizeMessage = humanizeMessage;

async function typeContentIntoWord(event, content) {
  console.log('typeContentIntoWord called', { content: content ? content.substring(0, 50) + '...' : null });
  
  if (!content) {
    addMessage('system', 'No content available to type. Please ask me to write something first.');
    return;
  }

  // Get the button that was clicked
  const typeBtn = event ? event.target : document.querySelector('.btn-type-word:not(:disabled)');
  currentTypeButton = typeBtn;
  
  if (typeBtn) {
    typeBtn.disabled = false; // Keep enabled so user can click stop
    typeBtn.textContent = 'Stop Pasting';
    typeBtn.onclick = stopTyping;
    typeBtn.classList.remove('btn-type-word');
    typeBtn.classList.add('btn-stop-typing');
    isTyping = true;
  }

  // Check Word first
  try {
    const isRunning = await window.electronAPI.checkWordRunning();
    if (!isRunning) {
      addMessage('system', '⚠ Word is not running. Please open Microsoft Word first.');
      if (typeBtn) {
        typeBtn.disabled = false;
        typeBtn.textContent = 'Paste into Word';
        typeBtn.onclick = (e) => typeContentIntoWord(e, content);
        typeBtn.classList.remove('btn-stop-typing');
        typeBtn.classList.add('btn-type-word');
        isTyping = false;
      }
      return;
    }

    // Always insert at cursor position (no option to change)
    console.log('Pasting into Word:', { contentLength: content.length, insertAtCursor: true });

    await window.electronAPI.typeIntoWordVBS(content, true);
    
    if (isTyping) { // Only show success if paste wasn't stopped
      addMessage('system', `✓ Content pasted into Word at cursor position.`);
    }
  } catch (error) {
    console.error('Error typing into Word:', error);
    // Check if error message contains "stopped" (case insensitive)
    if (error.message && error.message.toLowerCase().includes('stopped')) {
      // Already handled by stopTyping function - don't show error
      return;
    }
    addMessage('system', `Error: Failed to paste into Word - ${error.message}`);
  } finally {
    isTyping = false;
    if (typeBtn) {
      typeBtn.disabled = false;
      typeBtn.textContent = 'Paste into Word';
      typeBtn.onclick = (e) => typeContentIntoWord(e, content);
      typeBtn.classList.remove('btn-stop-typing');
      typeBtn.classList.add('btn-type-word');
    }
  }
}
