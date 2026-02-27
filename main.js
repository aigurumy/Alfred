const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const OpenAI = require('openai');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const config = require('./config');

// ── In-memory auth cache (populated by dashboard-preload via IPC) ─────────────
// Supabase runs in the dashboard renderer/preload (uses Chromium fetch).
// The main process only caches the result so chat renderer can do limit-checks.
let cachedUser    = null;
let cachedProfile = null;
let pendingDeepLink = null; // Deep-link URL that arrived before the window was ready
const FREE_TRIAL_TOKEN_LIMIT    = 15000;  // 15,000 tokens for free trial (one-time)
const CASUAL_MONTHLY_TOKEN_LIMIT = 250000; // 250,000 tokens per month for Casual plan

// API keys loaded from config.js (gitignored — never committed to GitHub)
const DEFAULT_API_KEY      = config.OPENROUTER_API_KEY;
const UNDETECTABLE_API_KEY = config.UNDETECTABLE_API_KEY;


let mainWindow;       // The floating chat overlay
let dashboardWindow;  // The launcher dashboard
let typingProcess = null; // Store reference to typing process for cancellation

// ── Single-instance lock + deep-link (alfred://) ──────────────────────────────
// Register alfred:// protocol for deep-link auth callbacks
if (process.defaultApp) {
  // Dev mode — pass script path so the protocol works correctly
  app.setAsDefaultProtocolClient('alfred', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('alfred');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance is already running — hand off and quit
  app.quit();
} else {
  // A second launch (e.g. deep-link click) arrives here
  app.on('second-instance', (event, commandLine) => {
    const url = commandLine.find(arg => arg.startsWith('alfred://'));
    if (url) handleDeepLink(url);
    // Bring dashboard back into focus
    if (dashboardWindow) {
      if (dashboardWindow.isMinimized()) dashboardWindow.restore();
      dashboardWindow.show();
      dashboardWindow.focus();
    }
  });
}

/**
 * Forwards the alfred://auth/callback URL to the dashboard window.
 * The dashboard-preload handles the actual Supabase setSession call
 * (it runs in the renderer process and has Chromium's fetch).
 */
function handleDeepLink(url) {
  console.log('[deep-link] received:', url);
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('handle-deep-link', url);
  } else {
    // Window not ready yet — store it and send once the window loads
    pendingDeepLink = url;
  }
}

/**
 * Start local HTTP server for OAuth callbacks (avoids browser prompt)
 * This is what apps like Google Drive use - redirects to localhost instead of custom protocol
 */
function startAuthServer() {
  if (authServer) {
    console.log('[auth-server] Already running');
    return;
  }

  authServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${AUTH_PORT}`);
    console.log('[auth-server] Request:', url.pathname);

    // Handle OAuth callback
    if (url.pathname === '/auth/callback') {
      // Extract tokens from query string or hash
      const hash = url.hash ? url.hash.slice(1) : '';
      const query = url.search ? url.search.slice(1) : '';
      const params = new URLSearchParams(hash || query);
      
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const error = params.get('error');
      const errorDescription = params.get('error_description');

      // Build callback URL in alfred:// format for existing handler
      let callbackUrl = 'alfred://auth/callback';
      if (hash) {
        callbackUrl += '#' + hash;
      } else if (query) {
        callbackUrl += '?' + query;
      }

      // Forward to dashboard window (same as deep link handler)
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('handle-deep-link', callbackUrl);
      } else {
        pendingDeepLink = callbackUrl;
      }

      // Send success page to browser
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Alfred - Authentication Successful</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
            }
            .container {
              text-align: center;
              padding: 40px;
            }
            h1 { margin: 0 0 10px 0; }
            p { margin: 0; opacity: 0.9; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✓ Authentication Successful!</h1>
            <p>You can close this window and return to Alfred.</p>
          </div>
          <script>
            // Auto-close after 2 seconds
            setTimeout(() => window.close(), 2000);
          </script>
        </body>
        </html>
      `);
      return;
    }

    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  authServer.listen(AUTH_PORT, 'localhost', () => {
    console.log(`[auth-server] Listening on http://localhost:${AUTH_PORT}`);
  });

  authServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[auth-server] Port ${AUTH_PORT} is already in use. Please close the application using that port or restart your computer.`);
    } else {
      console.error('[auth-server] Error:', err);
    }
  });
}

// Window sizes
const CHAT_SIZE = { width: 550, height: 450 };
const DASHBOARD_SIZE = { width: 920, height: 600 };

// Catch unhandled errors to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// ── Dashboard window (primary launcher) ──────────────────────────────────────
function createDashboardWindow() {
  const dashboardPreloadPath = path.join(__dirname, 'dashboard-preload.js');
  const iconPath = path.join(__dirname, 'Alfred Official Logo.png');

  dashboardWindow = new BrowserWindow({
    width: DASHBOARD_SIZE.width,
    height: DASHBOARD_SIZE.height,
    minWidth: 700,
    minHeight: 500,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,          // Allow preload to require npm packages (e.g. @supabase/supabase-js)
      preload: dashboardPreloadPath
    },
    resizable: true,
    frame: false,
    transparent: false,
    backgroundColor: '#0d0d12',
    alwaysOnTop: false,
    roundedCorners: true,
    hasShadow: true,
    title: 'Alfred'
  });

  dashboardWindow.loadFile('dashboard.html');

  // Enable DevTools with Ctrl+Shift+I (for debugging)
  dashboardWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      dashboardWindow.webContents.toggleDevTools();
    }
  });

  // Once the dashboard is ready, flush any deep-link URL that arrived early
  dashboardWindow.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) {
      setTimeout(() => {
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('handle-deep-link', pendingDeepLink);
          pendingDeepLink = null;
        }
      }, 800); // Give the preload's Supabase client time to initialize
    }
  });

  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
    // If chat is open, close it too when dashboard closes
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });
}

// ── Chat overlay window (launched from dashboard) ─────────────────────────────
function createChatWindow(sessionId = null) {
  const preloadPath = path.join(__dirname, 'preload.js');
  const iconPath = path.join(__dirname, 'Alfred Official Logo.png');

  mainWindow = new BrowserWindow({
    width: CHAT_SIZE.width,
    height: CHAT_SIZE.height,
    minWidth: 380,
    minHeight: 300,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath
    },
    resizable: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    roundedCorners: true,
    hasShadow: true
  });

  // Position in bottom-right corner
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  mainWindow.setPosition(
    screenWidth - CHAT_SIZE.width - 20,
    screenHeight - CHAT_SIZE.height - 20
  );

  mainWindow.setBackgroundColor('#00000000');
  mainWindow.once('ready-to-show', () => {
    mainWindow.setBackgroundColor('#00000000');
  });

  mainWindow.loadFile('index.html');

  // Enable DevTools with Ctrl+Shift+I (for debugging)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Chat window loaded');
    mainWindow.setBackgroundColor('#00000000');
    
    // Forward main process console logs to renderer for debugging
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => {
      originalLog.apply(console, args);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('main-console-log', args.map(a => 
          typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
        ).join(' '));
      }
    };
    console.error = (...args) => {
      originalError.apply(console, args);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('main-console-error', args.map(a => 
          typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
        ).join(' '));
      }
    };
    
    // Send session data to renderer if resuming
    if (sessionId) {
      const session = loadSession(sessionId);
      if (session) {
        mainWindow.webContents.send('load-session', session);
      }
    } else {
      // Create new session and send to renderer
      const userId = cachedUser?.id || null;
      const newSession = createSession(userId);
      mainWindow.webContents.send('load-session', newSession);
    }
  });

  // When chat closes, show dashboard again
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.show();
      dashboardWindow.focus();
      // Refresh sessions list in dashboard
      dashboardWindow.webContents.send('refresh-sessions');
    }
  });
}

// IPC Handlers
ipcMain.handle('generate-content', async (event, request, apiKey) => {
  try {
    console.log('Generating content for request:', request);
    const key = apiKey || DEFAULT_API_KEY;
    
    if (!key) {
      throw new Error('No API key provided');
    }
    
    console.log('Creating OpenAI client with OpenRouter...');
    const openai = new OpenAI({
      apiKey: key,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/report-butler',
        'X-Title': 'Alfred'
      },
      timeout: 60000 // 60 second timeout
    });
    
    console.log('Sending request to OpenRouter API...');
    const response = await openai.chat.completions.create({
      model: "openai/gpt-4", // Try gpt-4 first, fallback to gpt-4o if needed
      messages: [
        { 
          role: "system", 
          content: "You are a helpful writing assistant. Write clear, professional content for reports and documents." 
        },
        { role: "user", content: request }
      ],
      max_tokens: 2000
    });
    
    console.log('Response received:', response.choices[0] ? 'Success' : 'No choices');
    
    if (!response.choices || !response.choices[0] || !response.choices[0].message) {
      throw new Error('Invalid response from API');
    }
    
    return response.choices[0].message.content;
  } catch (error) {
    console.error('AI Error details:', error);
    const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
    throw new Error(`AI Error: ${errorMessage}`);
  }
});

// Extract number of results requested from query (e.g., "give me 2 news" → 2)
function extractRequestedCount(query) {
  const lowerQuery = query.toLowerCase();
  
  // Match patterns like "2 news", "3 latest", "top 5", etc.
  const patterns = [
    /(\d+)\s+(news|articles?|results?|items?|sources?|updates?|stories)/,
    /(top|first|latest)\s+(\d+)/,
    /give me\s+(\d+)/,
    /show me\s+(\d+)/,
    /find\s+(\d+)/
  ];
  
  for (const pattern of patterns) {
    const match = lowerQuery.match(pattern);
    if (match) {
      const num = parseInt(match[1] || match[2]);
      if (num >= 1 && num <= 10) { // Cap at 10 for performance
        console.log('Extracted requested count:', num);
        return num;
      }
    }
  }
  
  return 5; // Default to 5 if not specified
}

// Detect if query needs current information - if yes, we FORCE search before answering
function needsCurrentInfo(query) {
  const lowerQuery = query.toLowerCase();
  
  // Keywords that indicate need for current/recent information
  const currentInfoKeywords = [
    'current', 'latest', 'recent', 'today', 'this week', 'this month', 'this year',
    'now', 'news', 'stock market', 'weather', 'price', 'update', 'happening',
    '2026', 'february 2026', 'what happened', 'what is happening'
  ];
  
  const needsSearch = currentInfoKeywords.some(keyword => lowerQuery.includes(keyword));
  console.log('Current info check:', { query: lowerQuery, needsSearch });
  return needsSearch;
}

// Pattern matching: Skip search entirely for obvious conversational queries
function isConversational(query) {
  const trimmed = query.trim().toLowerCase();
  
  // Very short queries (greetings, single words)
  if (trimmed.length < 5) return true;
  
  // Greetings and conversational
  const conversationalPatterns = [
    /^(hi|hey|hello|hola|yo|sup)(\s|!|,|$)/,
    /^(thanks|thank you|thx|ty|cheers)(\s|!|,|$)/,
    /^(bye|goodbye|see you|later)(\s|!|,|$)/,
    /^(ok|okay|sure|yes|no|yep|nope|alright)(\s|!|,|$)/,
    /^(good morning|good night|good evening|good afternoon)(\s|!|,|$)/,
    /^how are you/,
    /^what can you do/,
    /^who are you/
  ];
  
  const isConv = conversationalPatterns.some(pattern => pattern.test(trimmed));
  console.log('Conversational check:', { query: trimmed, isConversational: isConv });
  return isConv;
}


// Detect if a query needs live research (time-sensitive or factual lookup)
function requiresResearch(message) {
  if (!message) return false;
  const lower = message.toLowerCase();

  const timeKeywords     = ['latest', 'current', 'recent', 'today', 'now', 'this week',
    'this month', 'this year', 'right now', 'just released'];

  const newsKeywords     = ['news', 'happened', 'announcement', 'update', 'released',
    'launched', 'new version', 'who won', 'what happened'];

  const dataKeywords     = ['price', 'cost', 'stock', 'weather', 'score', 'result',
    'statistics', 'how much'];

  const researchKeywords = ['research', 'find sources', 'essay', 'report', 'write about',
    'sources on', 'cite', 'citation', 'bibliography', 'find information',
    'look up', 'search for', 'what is', 'how does', 'explain', 'analyze',
    'overview of', 'summary of', 'tell me about'];

  const yearPattern      = /202[5-9]|203\d/;

  const allKeywords = [...timeKeywords, ...newsKeywords, ...dataKeywords, ...researchKeywords];
  return allKeywords.some(kw => lower.includes(kw)) || yearPattern.test(lower);
}

// Classify source intent using Claude Haiku — returns 'academic' or 'web'
async function classifySourceIntent(userMessage) {
  try {
    const dns = require('dns');
    dns.setDefaultResultOrder('ipv4first');

    const haikuClient = new OpenAI({
      apiKey: DEFAULT_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/report-butler',
        'X-Title': 'Alfred'
      },
      timeout: 10000, // Fast timeout for quick classification
      httpAgent: new https.Agent({ family: 4 })
    });

    const response = await haikuClient.chat.completions.create({
      model: 'anthropic/claude-haiku-4-5',
      messages: [
        {
          role: 'system',
          content: 'You are a classifier. Reply with ONLY one word: "academic" or "web". Do not include any explanation, punctuation, or other text.'
        },
        {
          role: 'user',
          content: `Does this query need academic/peer-reviewed sources or general web sources? Query: "${userMessage}"`
        }
      ],
      max_tokens: 5, // Just need one word
      temperature: 0 // Deterministic
    });

    const classification = response.choices[0]?.message?.content?.trim().toLowerCase() || '';
    
    // Strict parsing — only accept 'academic', default to 'web' for anything else
    if (classification === 'academic') {
      console.log('Source intent classified as: academic');
      return 'academic';
    } else {
      console.log('Source intent classified as: web (default)');
      return 'web';
    }

  } catch (error) {
    console.error('Error classifying source intent:', error.message);
    // Fallback to 'web' on any error
    return 'web';
  }
}

// Build optimized Sonar query based on source intent classification
async function buildSonarQuery(userMessage) {
  const sourceIntent = await classifySourceIntent(userMessage);

  if (sourceIntent === 'academic') {
    return `${userMessage} peer reviewed academic journal`;
  }

  // 'web' intent — return as-is for general web sources
  return userMessage;
}

// Call Perplexity Sonar Pro via OpenRouter for live research — returns { content, citations }
async function searchWithSonar(query) {
  try {
    // Classify intent and enhance query accordingly
    const enhancedQuery = await buildSonarQuery(query);
    console.log('Calling Sonar Pro (via OpenRouter) for:', enhancedQuery);

    const dns = require('dns');
    dns.setDefaultResultOrder('ipv4first');

    const sonarClient = new OpenAI({
      apiKey: DEFAULT_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/report-butler',
        'X-Title': 'Alfred'
      },
      timeout: 20000,
      httpAgent: new https.Agent({ family: 4 })
    });

    const response = await sonarClient.chat.completions.create({
      model: 'perplexity/sonar-pro',
      messages: [
        {
          role: 'system',
          content: 'You are a research assistant. Provide accurate, comprehensive, well-sourced information. Be factual and thorough.'
        },
        {
          role: 'user',
          content: enhancedQuery
        }
      ],
      max_tokens: 1500
    });

    const content   = response.choices[0]?.message?.content || '';
    const citations = response.citations || [];

    console.log('Sonar Pro response received, citations:', citations.length);
    return { content, citations };

  } catch (error) {
    console.error('Sonar Pro error:', error.message);
    return null;
  }
}

// ── Humanize via Undetectable.ai ─────────────────────────────────────────────
ipcMain.handle('humanize-text', async (event, textToHumanize, originalQuery) => {
  try {
    console.log('[Humanize] Request received');

    // Step 1: Split off references section so they don't get rewritten
    const refPattern = /\n\n(References|Bibliography|Works Cited|Sources)\s*\n([\s\S]*)$/i;
    const refMatch = textToHumanize.match(refPattern);
    let bodyText = textToHumanize;
    let refsSection = '';
    if (refMatch) {
      bodyText = textToHumanize.slice(0, refMatch.index).trim();
      refsSection = '\n\n' + refMatch[0].trim();
    }

    // Step 2: Use Haiku to classify writing purpose from the original query
    let purpose = 'General Writing';
    try {
      const dns = require('dns');
      dns.setDefaultResultOrder('ipv4first');
      const haikuClient = new OpenAI({
        apiKey: DEFAULT_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/report-butler',
          'X-Title': 'Alfred'
        },
        timeout: 10000,
        httpAgent: new https.Agent({ family: 4 })
      });
      const purposeResponse = await haikuClient.chat.completions.create({
        model: 'anthropic/claude-haiku-4-5',
        messages: [
          {
            role: 'system',
            content: 'You are a classifier. Reply with ONLY one of these exact words (no punctuation, no explanation): Essay, Report, Article, Story, General Writing, Business Material, Legal Material. Pick the best match for the user\'s request.'
          },
          {
            role: 'user',
            content: `What type of writing is this request? Query: "${originalQuery || ''}"`
          }
        ],
        max_tokens: 10,
        temperature: 0
      });
      const rawPurpose = purposeResponse.choices[0]?.message?.content?.trim() || '';
      const validPurposes = ['Essay', 'Report', 'Article', 'Story', 'General Writing', 'Business Material', 'Legal Material'];
      if (validPurposes.includes(rawPurpose)) {
        purpose = rawPurpose;
      }
      console.log('[Humanize] Classified purpose:', purpose);
    } catch (classifyErr) {
      console.error('[Humanize] Purpose classification failed, defaulting to General Writing:', classifyErr.message);
    }

    // Step 3: Submit body to Undetectable.ai
    const submitResponse = await new Promise((resolve, reject) => {
      const submitData = JSON.stringify({
        content: bodyText,
        readability: 'University',
        purpose: purpose,
        strength: 'More Human',
        model: 'v11sr'
      });
      const options = {
        hostname: 'humanize.undetectable.ai',
        path: '/submit',
        method: 'POST',
        headers: {
          'apikey': UNDETECTABLE_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(submitData)
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Failed to parse submit response: ' + data)); }
        });
      });
      req.on('error', reject);
      req.write(submitData);
      req.end();
    });

    if (!submitResponse.id) {
      throw new Error('No document ID returned from Undetectable.ai: ' + JSON.stringify(submitResponse));
    }
    console.log('[Humanize] Submitted — document ID:', submitResponse.id);

    // Step 4: Poll every 2s until output is ready (max 60s)
    const docId = submitResponse.id;
    let output = null;
    const maxAttempts = 30;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(r => setTimeout(r, 2000));

      const pollResponse = await new Promise((resolve, reject) => {
        const pollData = JSON.stringify({ id: docId });
        const options = {
          hostname: 'humanize.undetectable.ai',
          path: '/document',
          method: 'POST',
          headers: {
            'apikey': UNDETECTABLE_API_KEY,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(pollData)
          }
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('Failed to parse poll response: ' + data)); }
          });
        });
        req.on('error', reject);
        req.write(pollData);
        req.end();
      });

      console.log('[Humanize] Poll attempt', attempt + 1, '— output:', pollResponse.output ? 'ready' : 'pending');
      if (pollResponse.output) {
        output = pollResponse.output;
        break;
      }
    }

    if (!output) {
      throw new Error('Humanization timed out after 60 seconds');
    }

    // Step 5: Reattach references unchanged
    const finalText = output + refsSection;
    console.log('[Humanize] Done');
    return finalText;

  } catch (error) {
    console.error('[Humanize] Error:', error.message);
    throw new Error(`Humanize Error: ${error.message}`);
  }
});

// ── Session Storage Management ──────────────────────────────────────────────
const sessionsDir = path.join(app.getPath('userData'), 'sessions');
const sessionsIndexPath = path.join(sessionsDir, 'index.json');

// Ensure sessions directory exists
function ensureSessionsDir() {
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }
}

// Get sessions index (list of all sessions)
function getSessionsIndex() {
  ensureSessionsDir();
  if (!fs.existsSync(sessionsIndexPath)) {
    return [];
  }
  try {
    const data = fs.readFileSync(sessionsIndexPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading sessions index:', error);
    return [];
  }
}

// Save sessions index
function saveSessionsIndex(index) {
  ensureSessionsDir();
  try {
    fs.writeFileSync(sessionsIndexPath, JSON.stringify(index, null, 2));
  } catch (error) {
    console.error('Error saving sessions index:', error);
  }
}

// Generate session title from first user message
function generateSessionTitle(firstMessage) {
  if (!firstMessage || typeof firstMessage !== 'string') return 'New Chat';
  // Take first 50 characters, remove newlines, trim
  const title = firstMessage.replace(/\n/g, ' ').trim().substring(0, 50);
  return title || 'New Chat';
}

// Create a new session
function createSession(userId = null) {
  ensureSessionsDir();
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();
  
  const session = {
    id: sessionId,
    userId: userId,
    title: 'New Chat',
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  
  // Save session file
  const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  
  // Add to index
  const index = getSessionsIndex();
  index.unshift({
    id: sessionId,
    userId: userId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: 0
  });
  saveSessionsIndex(index);
  
  return session;
}

// Load a session
function loadSession(sessionId) {
  const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
  if (!fs.existsSync(sessionPath)) {
    return null;
  }
  try {
    const data = fs.readFileSync(sessionPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading session:', error);
    return null;
  }
}

// Save session messages
function saveSession(sessionId, messages, title = null) {
  const session = loadSession(sessionId);
  if (!session) {
    console.error('Session not found:', sessionId);
    return false;
  }
  
  session.messages = messages;
  session.updatedAt = new Date().toISOString();
  
  // Update title if provided or generate from first user message
  if (title) {
    session.title = title;
  } else if (messages.length > 0) {
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (firstUserMsg && session.title === 'New Chat') {
      session.title = generateSessionTitle(firstUserMsg.content);
    }
  }
  
  // Save session file
  const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  
  // Update index
  const index = getSessionsIndex();
  const indexEntry = index.find(s => s.id === sessionId);
  if (indexEntry) {
    indexEntry.title = session.title;
    indexEntry.updatedAt = session.updatedAt;
    indexEntry.messageCount = messages.length;
    // Move to top (most recent)
    const idx = index.indexOf(indexEntry);
    index.splice(idx, 1);
    index.unshift(indexEntry);
    saveSessionsIndex(index);
  }
  
  return true;
}

// Delete a session
function deleteSession(sessionId) {
  const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
  
  // Remove from index
  const index = getSessionsIndex();
  const filtered = index.filter(s => s.id !== sessionId);
  saveSessionsIndex(filtered);
  
  return true;
}

// Get all sessions for a user (or all if userId is null)
function getUserSessions(userId = null) {
  const index = getSessionsIndex();
  if (!userId) {
    return index; // Return all sessions if no user filter
  }
  return index.filter(s => s.userId === userId);
}

// Chat handler — Sonar Pro (research) → Claude Sonnet 4.5 (write/format) → Stream
ipcMain.handle('send-chat-message', async (event, conversationHistory, newMessage, uploadedFiles = []) => {
  try {
    console.log('Sending chat message:', newMessage);
    const key = DEFAULT_API_KEY;

    if (!key) {
      throw new Error('No API key provided');
    }

    // Force IPv4 to avoid IPv6 hanging issues
    const dns = require('dns');
    dns.setDefaultResultOrder('ipv4first');

    const openai = new OpenAI({
      apiKey: key,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/report-butler',
        'X-Title': 'Alfred'
      },
      timeout: 30000,
      httpAgent: new https.Agent({ family: 4 })
    });

    // Get current date
    const currentDate   = new Date();
    const formattedDate = currentDate.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    // STEP 1: Detect if query needs live research
    const needsResearch = requiresResearch(newMessage);
    let sonarContext  = null;
    let sonarCitations = [];

    if (needsResearch) {
      console.log('Research needed — calling Sonar Pro...');
      if (event && event.sender) {
        event.sender.send('research-status', { researching: true });
      }

      const sonarResult = await searchWithSonar(newMessage);

      if (event && event.sender) {
        event.sender.send('research-status', { researching: false });
      }

      if (sonarResult) {
        sonarContext   = sonarResult.content;
        sonarCitations = sonarResult.citations || [];
        console.log('Sonar Pro context received, citations:', sonarCitations.length);
      }
    }

    // STEP 2: Build system prompt
    let systemPrompt = `You are Alfred, a helpful AI assistant for students. Help them write reports, research topics, and find reliable information.

Today's date is ${formattedDate}.

Be natural and conversational. For greetings, keep it brief. For research and writing tasks, be thorough and professional.

When a user requests a specific citation style, always follow it precisely throughout the entire response including in-text citations and the reference list. Never default to numbered bracket citations unless explicitly asked.

When using research context, prioritize academic and primary sources over aggregator websites like Wikipedia, Scribbr, Grammarly, or HelpfulProfessor. If only secondary sources are available in the research context, note this limitation to the user.`;

    // If research was fetched, inject it — Claude only writes, never searches
    if (sonarContext) {
      systemPrompt += `\n\n---\nResearch context for this query (use as factual source only, rewrite completely in your own words and apply whatever formatting or citation style the user requested):\n\n${sonarContext}`;

      if (sonarCitations.length > 0) {
        systemPrompt += '\n\nAvailable sources:\n' + sonarCitations.map((url, i) => `[${i + 1}] ${url}`).join('\n');
        systemPrompt += '\n\nUse these sources when citing but format citations exactly as the user requested. If the user asked for Chicago 17th, use Chicago 17th. If APA, use APA. Never use Sonar\'s original formatting.';
        systemPrompt += '\n\nIMPORTANT: Prefer citing academic sources (journals, university publications, scholarly books) over aggregator sites (Wikipedia, Scribbr, etc.). If the research context only contains secondary sources, acknowledge this limitation.';
      }

      systemPrompt += '\n---';
    }

    // STEP 3: Build messages array
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    // Add conversation history (excluding system messages)
    conversationHistory.forEach(msg => {
      if (msg.role !== 'system') {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        });
      }
    });

    // Add the new user message — with files if present
    if (uploadedFiles && uploadedFiles.length > 0) {
      const userContent = [];

      if (newMessage && newMessage.trim()) {
        userContent.push({ type: 'text', text: newMessage });
      }

      for (const file of uploadedFiles) {
        if (file.error) continue;

        if (file.type === 'image') {
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:${file.mimeType};base64,${file.data}` }
          });
        } else {
          const label = file.type === 'pdf' ? 'PDF' :
                        file.type === 'word' ? 'Word Document' : 'Text File';
          userContent.push({
            type: 'text',
            text: `\n[Attached ${label}: ${file.name}]\n${file.data}\n[/End of ${file.name}]\n`
          });
        }
      }

      messages.push({ role: 'user', content: userContent });
    } else {
      messages.push({ role: 'user', content: newMessage });
    }

    // Append file context hints to system prompt if needed
    if (uploadedFiles && uploadedFiles.length > 0) {
      const hasImages = uploadedFiles.some(f => f.type === 'image' && !f.error);
      const hasDocs   = uploadedFiles.some(f => ['pdf', 'word', 'text'].includes(f.type) && !f.error);

      let fileContext = '';
      if (hasImages) fileContext += '\n- The user has attached image(s). Analyze them carefully and reference them in your response.';
      if (hasDocs)   fileContext += '\n- The user has attached document(s). Use the extracted text as context for your writing or analysis.';

      messages[0] = { role: 'system', content: systemPrompt + fileContext };
    }

    // STEP 4: Stream Claude's response — no tools, just write and format
    console.log(needsResearch ? 'Calling Claude to format Sonar research (streaming)...' : 'Calling Claude directly (streaming)...');

    const stream = await openai.chat.completions.create({
      model: 'anthropic/claude-sonnet-4.5',
      messages: messages,
      max_tokens: 2000,
      temperature: 0.7,
      stream: true,
      stream_options: { include_usage: true }
    });

    let streamedContent = '';
    let totalTokensUsed = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        streamedContent += delta;
        if (event && event.sender) {
          event.sender.send('chat-stream', { type: 'chunk', content: delta });
        }
      }
      // Capture token usage from the final chunk (OpenRouter returns this with include_usage)
      if (chunk.usage && chunk.usage.total_tokens) {
        totalTokensUsed = chunk.usage.total_tokens;
      }
    }

    if (event && event.sender) {
      event.sender.send('chat-stream', { type: 'done' });
    }

    // Fall back to character-based estimate if API didn't return token count
    // (~4 chars per token is a standard rough estimate)
    if (totalTokensUsed === 0) {
      totalTokensUsed = Math.ceil(streamedContent.length / 4);
      console.log(`[tokens] API did not return usage — estimated ${totalTokensUsed} tokens from content length`);
    } else {
      console.log(`[tokens] API reported ${totalTokensUsed} total tokens used`);
    }

    // Increment token usage counter
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('do-increment-tokens', totalTokensUsed);
    }

    return {
      content: streamedContent,
      role: 'assistant',
      sources: sonarCitations.length > 0
        ? sonarCitations.map((url, i) => ({ index: i + 1, url }))
        : null
    };

  } catch (error) {
    console.error('Chat Error details:', error);
    const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
    throw new Error(`AI Error: ${errorMessage}`);
  }
});

ipcMain.handle('check-word-running', async () => {
  console.log('[Word Detection] Starting Word detection check...');
  
  try {
    // Method 1: Check via tasklist (primary method)
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq WINWORD.EXE"');
    console.log('[Word Detection] Tasklist output length:', stdout.length);
    console.log('[Word Detection] Tasklist output preview:', stdout.substring(0, 200));
    
    // Check if Word is running - handle different output formats
    // tasklist returns "INFO: No tasks" when process not found
    // or includes "WINWORD.EXE" in the process list when found
    if (stdout.includes('INFO: No tasks') || stdout.trim().length < 50) {
      console.log('[Word Detection] Tasklist: No Word found, trying WMIC...');
      
      // Method 2: Fallback - try wmic (more reliable, works with different locales)
      try {
        const { stdout: wmicOutput } = await execAsync('wmic process where "name=\'WINWORD.EXE\'" get name 2>nul');
        console.log('[Word Detection] WMIC output length:', wmicOutput?.length || 0);
        console.log('[Word Detection] WMIC output preview:', wmicOutput?.substring(0, 200) || 'null');
        
        if (wmicOutput && wmicOutput.includes('WINWORD.EXE')) {
          console.log('[Word Detection] WMIC: Word found!');
          return true;
        } else {
          console.log('[Word Detection] WMIC: Word not found');
        }
      } catch (wmicError) {
        console.log('[Word Detection] WMIC failed:', wmicError.message);
      }
      
      console.log('[Word Detection] Trying PowerShell fallback...');
      // Try PowerShell before giving up
      try {
        const { stdout: psOutput } = await execAsync('powershell -Command "Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Select-Object -First 1"');
        console.log('[Word Detection] PowerShell output length:', psOutput?.length || 0);
        console.log('[Word Detection] PowerShell output:', psOutput?.trim() || 'empty');
        
        if (psOutput && psOutput.trim().length > 0 && !psOutput.includes('Get-Process')) {
          console.log('[Word Detection] PowerShell: Word found!');
          return true;
        } else {
          console.log('[Word Detection] PowerShell: Word not found');
        }
      } catch (psError) {
        console.log('[Word Detection] PowerShell failed:', psError.message);
      }
      
      console.log('[Word Detection] All methods failed - Word not detected');
      return false;
    }
    
    // Word process found in tasklist output
    const found = stdout.includes('WINWORD.EXE');
    console.log('[Word Detection] Tasklist: Word', found ? 'FOUND' : 'NOT FOUND');
    return found;
    
  } catch (error) {
    console.error('[Word Detection] Error checking Word status:', error.message);
    console.error('[Word Detection] Error stack:', error.stack);
    
    // Final fallback: Try PowerShell Get-Process (most reliable)
    try {
      const { stdout: psOutput } = await execAsync('powershell -Command "Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Select-Object -First 1"');
      console.log('[Word Detection] Fallback PowerShell output:', psOutput?.trim() || 'empty');
      const result = psOutput && psOutput.trim().length > 0 && !psOutput.includes('Get-Process');
      console.log('[Word Detection] Fallback result:', result);
      return result;
    } catch (psError) {
      console.error('[Word Detection] PowerShell check also failed:', psError.message);
      return false;
    }
  }
});

// ── Dashboard IPC handlers ────────────────────────────────────────────────────
ipcMain.on('launch-alfred', (event, sessionId = null) => {
  console.log('Launching Alfred chat window...', sessionId ? `(resuming session: ${sessionId})` : '(new session)');
  if (!mainWindow || mainWindow.isDestroyed()) {
    createChatWindow(sessionId);
  } else {
    // If window exists, close it and create new one with session
    mainWindow.close();
    createChatWindow(sessionId);
  }
  // Hide dashboard while Alfred is open
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.hide();
  }
});

ipcMain.on('dashboard-minimize', () => {
  if (dashboardWindow) dashboardWindow.minimize();
});

ipcMain.on('dashboard-toggle-maximize', () => {
  if (dashboardWindow) {
    if (dashboardWindow.isMaximized()) dashboardWindow.unmaximize();
    else dashboardWindow.maximize();
  }
});

ipcMain.on('dashboard-close', () => {
  if (dashboardWindow) dashboardWindow.close();
});

// ── Chat window control handlers ──────────────────────────────────────────────
ipcMain.on('window-minimize', () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.on('window-toggle-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

// Open URLs in the system default browser
ipcMain.on('open-external', (event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

// Resize window to chat mode
ipcMain.on('window-resize-to-chat', () => {
  console.log('🔄 Resize to chat mode triggered');
  console.log('CHAT_SIZE:', CHAT_SIZE);
  
  if (mainWindow) {
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
    
    console.log('Setting window size to:', CHAT_SIZE.width, 'x', CHAT_SIZE.height);
    
    // Allow free horizontal resize — only enforce a minimum width
    mainWindow.setMinimumSize(380, 300);
    mainWindow.setMaximumSize(0, 0); // 0,0 means no maximum (Electron treats it as unlimited)
    
    // Animate resize and reposition
    mainWindow.setSize(CHAT_SIZE.width, CHAT_SIZE.height, true);
    mainWindow.setPosition(
      screenWidth - CHAT_SIZE.width - 20,
      screenHeight - CHAT_SIZE.height - 20,
      true
    );
    
    console.log('✅ Window resized and repositioned');
  }
});

// Stop typing handler
ipcMain.on('stop-typing', () => {
  if (typingProcess) {
    console.log('Stopping typing process...');
    try {
      // Mark that we're stopping (before killing)
      const processToKill = typingProcess;
      typingProcess = null; // Set to null first so close handler knows it was stopped
      
      // On Windows, kill the process and its children
      if (process.platform === 'win32') {
        // Kill the process tree on Windows
        const killProcess = spawn('taskkill', ['/F', '/T', '/PID', processToKill.pid.toString()], {
          windowsVerbatimArguments: false,
          shell: false
        });
        
        killProcess.on('error', (err) => {
          // If taskkill fails, try regular kill
          console.log('taskkill failed, trying regular kill:', err);
          try {
            processToKill.kill('SIGTERM');
          } catch (killError) {
            console.error('Failed to kill process:', killError);
          }
        });
      } else {
        processToKill.kill('SIGTERM');
      }
    } catch (error) {
      console.error('Error stopping typing process:', error);
      typingProcess = null;
    }
  } else {
    console.log('No typing process to stop');
  }
});

// Normalize and escape text for VBScript
// Returns a VBScript expression that builds the string with proper Unicode support
function escapeTextForVBScript(text) {
  if (!text) return '""';
  
  // Replace smart quotes and apostrophes with regular ones
  // This handles all Unicode variants of quotes and apostrophes
  let normalized = text
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")  // All smart apostrophe variants to regular apostrophe
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')  // All smart double quote variants to regular double quote
    .replace(/[\u2013\u2014]/g, '-')  // En/em dashes to regular hyphen
    .replace(/[\u2026]/g, '...');    // Ellipsis to three dots
  
  // Build VBScript string expression using ChrW() for non-ASCII characters
  // This ensures proper Unicode handling regardless of file encoding
  let parts = [];
  let currentAscii = '';
  
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const code = char.charCodeAt(0);
    
    if (code <= 127) {
      // ASCII character - accumulate in currentAscii
      if (char === '"') {
        // Escape double quotes for VBScript
        currentAscii += '""';
      } else {
        currentAscii += char;
      }
    } else {
      // Non-ASCII character - flush currentAscii and add ChrW()
      if (currentAscii) {
        parts.push('"' + currentAscii + '"');
        currentAscii = '';
      }
      parts.push('ChrW(' + code + ')');
    }
  }
  
  // Flush any remaining ASCII characters
  if (currentAscii) {
    parts.push('"' + currentAscii + '"');
  }
  
  // Join all parts with & operator
  if (parts.length === 0) {
    return '""';
  } else if (parts.length === 1) {
    return parts[0];
  } else {
    return parts.join(' & ');
  }
}

// Parse bold formatting into segments
function parseBoldSegments(text) {
  const segments = [];
  let currentText = '';
  let i = 0;
  let isBold = false;
  
  while (i < text.length) {
    // Check for ** bold marker
    if (i < text.length - 1 && text[i] === '*' && text[i + 1] === '*') {
      // Save current text if any
      if (currentText) {
        segments.push({ text: currentText, bold: isBold });
        currentText = '';
      }
      // Toggle bold
      isBold = !isBold;
      i += 2; // Skip **
    } else {
      currentText += text[i];
      i++;
    }
  }
  
  // Add remaining text
  if (currentText) {
    segments.push({ text: currentText, bold: isBold });
  }
  
  return segments;
}

// Parse markdown and convert to Word formatting instructions
function parseMarkdownForWord(content) {
  const lines = content.split('\n');
  const formatted = [];
  
  for (let line of lines) {
    const trimmed = line.trim();
    
    // Skip horizontal rule markers (---, ----, etc.)
    if (/^-{3,}$/.test(trimmed)) {
      continue;
    }
    
    // Detect headings (look for markdown # or common patterns like "Title:")
    if (trimmed.startsWith('# ')) {
      formatted.push({ type: 'heading1', text: trimmed.substring(2) });
    } else if (trimmed.startsWith('## ')) {
      formatted.push({ type: 'heading2', text: trimmed.substring(3) });
    } else if (trimmed.startsWith('### ')) {
      formatted.push({ type: 'heading3', text: trimmed.substring(4) });
    }
    // Detect "Title:" pattern as heading1
    else if (/^Title:/i.test(trimmed)) {
      formatted.push({ type: 'heading1', text: trimmed });
    }
    // Detect numbered headings like "1.0 Introduction"
    else if (/^\d+\.?\d*\s+[A-Z]/.test(trimmed)) {
      formatted.push({ type: 'heading2', text: trimmed });
    }
    // Detect bullet lists
    else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const bulletText = trimmed.substring(2);
      formatted.push({ type: 'bullet', text: bulletText, segments: parseBoldSegments(bulletText) });
    }
    // Detect numbered lists (like "1. " or "a. ")
    else if (/^[\da-z]+\.\s/.test(trimmed) && !/^\d+\.?\d*\s+[A-Z]/.test(trimmed)) {
      const numberedText = trimmed.replace(/^[\da-z]+\.\s/, '');
      formatted.push({ type: 'numbered', text: numberedText, segments: parseBoldSegments(numberedText) });
    }
    // Regular paragraph with inline formatting
    else if (trimmed.length > 0) {
      formatted.push({ type: 'paragraph', text: line, segments: parseBoldSegments(line) });
    }
    // Empty line
    else {
      formatted.push({ type: 'empty' });
    }
  }
  
  return formatted;
}

// Native file open dialog
ipcMain.handle('show-open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach Files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Supported', extensions: ['jpg','jpeg','png','gif','webp','pdf','docx','doc','txt','md','rtf'] },
      { name: 'Images',        extensions: ['jpg','jpeg','png','gif','webp'] },
      { name: 'Documents',     extensions: ['pdf','docx','doc'] },
      { name: 'Text Files',    extensions: ['txt','md','rtf'] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

// ─── File Processing Handler ────────────────────────────────────────────────

// Detect file type from extension
function detectFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (['.docx', '.doc'].includes(ext)) return 'word';
  if (['.txt', '.md', '.rtf'].includes(ext)) return 'text';
  return 'unknown';
}

// Get MIME type for images
function getImageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp'
  };
  return mimeMap[ext] || 'image/jpeg';
}

ipcMain.handle('process-uploaded-files', async (event, filePaths) => {
  const results = [];

  for (const filePath of filePaths) {
    try {
      const fileType = detectFileType(filePath);
      const fileName = path.basename(filePath);
      const stats = fs.statSync(filePath);
      const fileSizeBytes = stats.size;

      if (fileType === 'unknown') {
        results.push({ path: filePath, name: fileName, type: 'unknown', error: 'Unsupported file type' });
        continue;
      }

      // Size limits
      const maxImageSize = 10 * 1024 * 1024;   // 10MB
      const maxDocSize   = 20 * 1024 * 1024;   // 20MB
      const limit = fileType === 'image' ? maxImageSize : maxDocSize;
      if (fileSizeBytes > limit) {
        results.push({ path: filePath, name: fileName, type: fileType, error: `File too large (max ${fileType === 'image' ? '10MB' : '20MB'})` });
        continue;
      }

      if (fileType === 'image') {
        // Read image and convert to base64
        const imageBuffer = fs.readFileSync(filePath);
        const base64Data = imageBuffer.toString('base64');
        const mimeType = getImageMimeType(filePath);
        const dataUrl = `data:${mimeType};base64,${base64Data}`;
        results.push({
          path: filePath,
          name: fileName,
          type: 'image',
          mimeType,
          data: base64Data,   // raw base64 for Claude API
          preview: dataUrl,   // full data URL for <img> preview
          size: fileSizeBytes
        });

      } else if (fileType === 'pdf') {
        // Use pdf2json — pure JS, no canvas/DOM/DOMMatrix dependencies
        const PDFParser = require('pdf2json');
        const { extractedText, pageCount } = await new Promise((resolve, reject) => {
          const pdfParser = new PDFParser();
          pdfParser.on('pdfParser_dataError', errData => reject(new Error(String(errData.parserError))));
          pdfParser.on('pdfParser_dataReady', pdfData => {
            try {
              const pages = pdfData.Pages || [];

              // getRawTextContent() can return empty for some PDFs,
              // so always fall back to manual page-by-page extraction
              let text = '';
              for (const page of pages) {
                for (const textItem of (page.Texts || [])) {
                  for (const r of (textItem.R || [])) {
                    try {
                      text += decodeURIComponent(r.T) + ' ';
                    } catch {
                      text += (r.T || '') + ' ';
                    }
                  }
                }
                text += '\n';
              }

              // If manual extraction also fails, try getRawTextContent as last resort
              const extractedText = text.trim() || pdfParser.getRawTextContent().trim();
              resolve({ extractedText, pageCount: pages.length });
            } catch (e) {
              reject(e);
            }
          });
          pdfParser.loadPDF(filePath);
        });
        results.push({
          path: filePath,
          name: fileName,
          type: 'pdf',
          data: extractedText.substring(0, 50000), // cap at 50k chars
          size: fileSizeBytes,
          pageCount
        });

      } else if (fileType === 'word') {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        const extractedText = result.value || '';
        results.push({
          path: filePath,
          name: fileName,
          type: 'word',
          data: extractedText.substring(0, 50000),
          size: fileSizeBytes
        });

      } else if (fileType === 'text') {
        const textContent = fs.readFileSync(filePath, 'utf8');
        results.push({
          path: filePath,
          name: fileName,
          type: 'text',
          data: textContent.substring(0, 50000),
          size: fileSizeBytes
        });
      }
    } catch (err) {
      console.error('Error processing file:', filePath, err);
      results.push({
        path: filePath,
        name: path.basename(filePath),
        type: detectFileType(filePath),
        error: err.message
      });
    }
  }

  return results;
});

// ────────────────────────────────────────────────────────────────────────────

ipcMain.handle('type-into-word-vbs', async (event, content, insertAtCursor = false) => {
  return new Promise((resolve, reject) => {
    const os = require('os');
    const timestamp = Date.now();
    const vbsFile = path.join(os.tmpdir(), `word_butler_${timestamp}.vbs`);
    
    // Parse markdown formatting
    const formattedLines = parseMarkdownForWord(content);
    console.log('Parsed formatting:', formattedLines.length, 'lines');
    console.log('Sample line segments:', JSON.stringify(formattedLines[0], null, 2));
    
    // Build VBScript with formatting
    let vbScript = `On Error Resume Next
Set wordApp = GetObject(, "Word.Application")
If Err.Number <> 0 Then
  Err.Clear
  Set wordApp = CreateObject("Word.Application")
End If
wordApp.Visible = True

' Get active document or create new
If wordApp.Documents.Count = 0 Then
  Set doc = wordApp.Documents.Add
Else
  Set doc = wordApp.ActiveDocument
End If

' Insert at cursor position or end of document
Dim insertAtCursorPos
insertAtCursorPos = ${insertAtCursor ? 'True' : 'False'}

If insertAtCursorPos Then
  Set rng = wordApp.Selection.Range
Else
  Set rng = doc.Content
  rng.Collapse 0
End If

' Helper function to insert text instantly at current range position
Function TypeWordByWord(textToType, wordDelay)
  Dim startPosition
  startPosition = rng.Start
  rng.InsertAfter textToType
  Set rng = doc.Range(rng.End, rng.End)
  TypeWordByWord = startPosition
End Function

`;

    // Add formatted content line by line
    formattedLines.forEach((line, index) => {
      switch (line.type) {
        case 'heading1':
          const h1Text = escapeTextForVBScript(line.text || '');
          vbScript += `
' Heading 1
startPos = TypeWordByWord(${h1Text}, 5)
rng.InsertAfter vbCrLf
Set formatRng = doc.Range(startPos, rng.Start)
formatRng.Font.Bold = True
formatRng.Font.Size = 16
Set rng = doc.Range(rng.Start + 1, rng.Start + 1)
`;
          break;
        case 'heading2':
          const h2Text = escapeTextForVBScript(line.text || '');
          vbScript += `
' Heading 2
startPos = TypeWordByWord(${h2Text}, 5)
rng.InsertAfter vbCrLf
Set formatRng = doc.Range(startPos, rng.Start)
formatRng.Font.Bold = True
formatRng.Font.Size = 14
Set rng = doc.Range(rng.Start + 1, rng.Start + 1)
`;
          break;
        case 'heading3':
          const h3Text = escapeTextForVBScript(line.text || '');
          vbScript += `
' Heading 3
startPos = TypeWordByWord(${h3Text}, 5)
rng.InsertAfter vbCrLf
Set formatRng = doc.Range(startPos, rng.Start)
formatRng.Font.Bold = True
formatRng.Font.Size = 12
Set rng = doc.Range(rng.Start + 1, rng.Start + 1)
`;
          break;
        case 'bullet':
          vbScript += `
' Bullet point
startPos = rng.Start
`;
          // Insert segments with bold formatting
          if (line.segments && line.segments.length > 0) {
            line.segments.forEach(seg => {
              const segText = escapeTextForVBScript(seg.text);
              vbScript += `
segStart = TypeWordByWord(${segText}, 5)
Set segRng = doc.Range(segStart, rng.Start)
${seg.bold ? 'segRng.Font.Bold = True' : 'segRng.Font.Bold = False'}
`;
            });
          }
          vbScript += `
rng.InsertAfter vbCrLf
Set bulletRng = doc.Range(startPos, rng.Start)
bulletRng.ListFormat.ApplyBulletDefault
Set rng = doc.Range(rng.Start + 1, rng.Start + 1)
`;
          break;
        case 'numbered':
          vbScript += `
' Numbered list
startPos = rng.Start
`;
          // Insert segments with bold formatting
          if (line.segments && line.segments.length > 0) {
            line.segments.forEach(seg => {
              const segText = escapeTextForVBScript(seg.text);
              vbScript += `
segStart = TypeWordByWord(${segText}, 5)
Set segRng = doc.Range(segStart, rng.Start)
${seg.bold ? 'segRng.Font.Bold = True' : 'segRng.Font.Bold = False'}
`;
            });
          }
          vbScript += `
rng.InsertAfter vbCrLf
Set rng = doc.Range(rng.Start + 1, rng.Start + 1)
`;
          break;
        case 'paragraph':
          vbScript += `
' Paragraph with inline formatting
`;
          // Insert segments with bold formatting
          if (line.segments && line.segments.length > 0) {
            line.segments.forEach(seg => {
              const segText = escapeTextForVBScript(seg.text);
              vbScript += `
segStart = TypeWordByWord(${segText}, 5)
Set segRng = doc.Range(segStart, rng.Start)
${seg.bold ? 'segRng.Font.Bold = True' : 'segRng.Font.Bold = False'}
`;
            });
          }
          vbScript += `
rng.InsertAfter vbCrLf
Set rng = doc.Range(rng.Start + 1, rng.Start + 1)
`;
          break;
        case 'empty':
          vbScript += `
' Empty line
rng.Text = vbCrLf
Set rng = doc.Range(rng.End, rng.End)
`;
          break;
      }
    });

    vbScript += `

Set rng = Nothing
Set doc = Nothing
Set wordApp = Nothing
`;

    try {
      // Write VBScript to temp file with UTF-16 LE encoding (BOM) for proper Unicode support
      // This ensures special characters like ö, ü, etc. are preserved correctly
      // JavaScript strings are UTF-16 internally, so we convert to UTF-16 LE bytes
      const bom = Buffer.from([0xFF, 0xFE]); // UTF-16 LE BOM
      const vbScriptBytes = Buffer.allocUnsafe(vbScript.length * 2);
      for (let i = 0; i < vbScript.length; i++) {
        const code = vbScript.charCodeAt(i);
        vbScriptBytes[i * 2] = code & 0xFF; // Low byte
        vbScriptBytes[i * 2 + 1] = (code >> 8) & 0xFF; // High byte
      }
      fs.writeFileSync(vbsFile, Buffer.concat([bom, vbScriptBytes]));
      
      console.log('Running VBScript to type into Word...');
      
      // Use spawn for better process control
      const childProcess = spawn('cscript', ['//nologo', vbsFile], {
        windowsVerbatimArguments: false,
        shell: false
      });
      
      let stdout = '';
      let stderr = '';
      
      childProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      childProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      childProcess.on('close', (code, signal) => {
        // Check if this was a user-initiated stop
        const wasStopped = typingProcess === null || signal === 'SIGTERM' || signal === 'SIGKILL';
        
        // Clear process reference
        typingProcess = null;
        
        // Clean up temp file
        try {
          if (fs.existsSync(vbsFile)) fs.unlinkSync(vbsFile);
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        
        if (wasStopped) {
          console.log('Typing process was stopped by user');
          reject(new Error('Typing was stopped'));
        } else if (code !== 0) {
          console.error('VBScript error:', stderr);
          reject(new Error(`Word automation failed: ${stderr || 'Unknown error'}`));
        } else {
          console.log('VBScript completed successfully');
          resolve('Content typed into Word successfully');
        }
      });
      
      childProcess.on('error', (error) => {
        typingProcess = null;
        console.error('Failed to start VBScript:', error);
        reject(new Error(`Failed to start Word automation: ${error.message}`));
      });
      
      // Store process reference for cancellation
      typingProcess = childProcess;
    } catch (writeError) {
      reject(new Error(`Failed to create files: ${writeError.message}`));
    }
  });
});

// ── Auth IPC handlers ─────────────────────────────────────────────────────────

// Dashboard preload sends auth state here whenever it changes
ipcMain.on('cache-auth-state', (event, { user, profile }) => {
  cachedUser    = user    || null;
  cachedProfile = profile || null;
  console.log('[auth-cache] updated:', cachedUser?.email, '| plan:', cachedProfile?.plan, '| tokens_used:', cachedProfile?.tokens_used ?? 0, '| monthly_tokens_used:', cachedProfile?.monthly_tokens_used ?? 0);
});

// Chat renderer asks: can this user send a message right now?
ipcMain.handle('auth-check-can-send', () => {
  if (!cachedUser || !cachedProfile) {
    return { canSend: false, reason: 'not-logged-in' };
  }
  // If subscription_status is "active", user has paid access (even if scheduled to cancel)
  // This handles the case where plan might be "trial" but subscription is still active
  if (cachedProfile.subscription_status === 'active' || cachedProfile.plan === 'casual') {
    const monthlyUsed   = cachedProfile.monthly_tokens_used ?? 0;
    const resetAt       = cachedProfile.monthly_tokens_reset_at ? new Date(cachedProfile.monthly_tokens_reset_at) : null;
    const isResetDue    = !resetAt || (Date.now() - resetAt.getTime()) > 30 * 24 * 60 * 60 * 1000;
    const effectiveUsed = isResetDue ? 0 : monthlyUsed;
    const remaining     = CASUAL_MONTHLY_TOKEN_LIMIT - effectiveUsed;
    const nextReset     = resetAt ? new Date(resetAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;

    if (remaining > 0) {
      return { canSend: true, plan: 'casual', tokensUsed: effectiveUsed, remaining, resetAt: nextReset };
    }
    return { canSend: false, reason: 'monthly-limit-reached', plan: 'casual', tokensUsed: effectiveUsed, remaining: 0, resetAt: nextReset };
  }
  // Token-based free trial
  const tokensUsed = cachedProfile.tokens_used ?? 0;
  const remaining = FREE_TRIAL_TOKEN_LIMIT - tokensUsed;
  if (remaining > 0) {
    return { canSend: true, plan: 'trial', tokensUsed, remaining };
  }
  return { canSend: false, reason: 'trial-exhausted', plan: 'trial', tokensUsed, remaining: 0 };
});

// ── Session Management IPC Handlers ──────────────────────────────────────────
ipcMain.handle('session-create', async (event) => {
  const userId = cachedUser?.id || null;
  const session = createSession(userId);
  return session;
});

ipcMain.handle('session-load', async (event, sessionId) => {
  const session = loadSession(sessionId);
  return session;
});

ipcMain.handle('session-save', async (event, sessionId, messages, title = null) => {
  return saveSession(sessionId, messages, title);
});

ipcMain.handle('session-delete', async (event, sessionId) => {
  return deleteSession(sessionId);
});

ipcMain.handle('session-list', async (event) => {
  const userId = cachedUser?.id || null;
  return getUserSessions(userId);
});

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Handle deep-link if the app was launched directly via alfred://
  const startUrl = process.argv.find(arg => arg.startsWith('alfred://'));
  if (startUrl) handleDeepLink(startUrl);

  createDashboardWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDashboardWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Close auth server when app quits
  if (authServer) {
    console.log('[auth-server] Closing server');
    authServer.close();
    authServer = null;
  }
});
