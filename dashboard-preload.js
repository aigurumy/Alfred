/**
 * dashboard-preload.js
 *
 * Runs in the RENDERER process (Chromium), so fetch uses Chromium's network
 * stack — no SSL or undici issues.  This is where all Supabase calls live.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const config = require('./config');

// ── Constants ─────────────────────────────────────────────────────────────────
const SUPABASE_URL      = config.SUPABASE_URL;
const SUPABASE_ANON_KEY = config.SUPABASE_ANON_KEY;

// ── File-based session storage ────────────────────────────────────────────────
// NOTE: app.getPath() is main-process only — use os.homedir() here instead
const SESSION_DIR  = path.join(os.homedir(), '.alfred');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

// Ensure the directory exists at startup
try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (_) {}

function getSessionFilePath() {
  return SESSION_FILE;
}

const fileStorage = {
  getItem(key) {
    try {
      const fp = getSessionFilePath();
      if (!fs.existsSync(fp)) return null;
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      return data[key] ?? null;
    } catch { return null; }
  },
  setItem(key, value) {
    try {
      const fp = getSessionFilePath();
      let data = {};
      try { if (fs.existsSync(fp)) data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
      data[key] = value;
      fs.writeFileSync(fp, JSON.stringify(data));
    } catch (e) { console.error('[preload] session write:', e.message); }
  },
  removeItem(key) {
    try {
      const fp = getSessionFilePath();
      if (!fs.existsSync(fp)) return;
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      delete data[key];
      fs.writeFileSync(fp, JSON.stringify(data));
    } catch (e) { console.error('[preload] session remove:', e.message); }
  }
};

// ── Supabase client ───────────────────────────────────────────────────────────
// Runs in renderer process → uses Chromium's fetch → works perfectly on Windows
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage:            fileStorage,
    autoRefreshToken:   true,
    persistSession:     true,
    detectSessionInUrl: false,
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) { console.error('[preload] fetchProfile:', error.message); return null; }
  return data;
}

/** Push current user + profile to the main-process in-memory cache. */
function syncToMain(user, profile) {
  ipcRenderer.send('cache-auth-state', { user: user || null, profile: profile || null });
}

// ── Auth-change callbacks (registered by dashboard renderer) ─────────────────
const authCallbacks = [];
function fireCallbacks(data) {
  authCallbacks.forEach(cb => { try { cb(data); } catch (e) {} });
}

// ── Initialise on load ────────────────────────────────────────────────────────
(async () => {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const profile = await fetchProfile(user.id);
      syncToMain(user, profile);
    } else {
      syncToMain(null, null);
    }
  } catch (e) {
    console.error('[preload] init error:', e.message);
    syncToMain(null, null);
  }
})();

// ── Deep-link handler (main → preload) ────────────────────────────────────────
ipcRenderer.on('handle-deep-link', async (event, url) => {
  console.log('[preload] handling deep-link:', url);
  
  // Handle checkout success/cancel
  if (url.startsWith('alfred://checkout/success')) {
    const urlObj = new URL(url);
    const sessionId = urlObj.searchParams.get('session_id');
    console.log('[preload] Checkout success, session:', sessionId);
    
    // Refresh profile to get updated plan (webhook should have updated it)
    setTimeout(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const profile = await fetchProfile(user.id);
        syncToMain(user, profile);
        fireCallbacks({ user, profile });
        // Notify dashboard
        window.postMessage({ type: 'checkout-success' }, '*');
      }
    }, 2000); // Wait 2 seconds for webhook to process
    return;
  }
  
  if (url.startsWith('alfred://checkout/cancel')) {
    console.log('[preload] Checkout canceled');
    window.postMessage({ type: 'checkout-cancel' }, '*');
    return;
  }
  
  // Handle OAuth callback
  try {
    const urlObj  = new URL(url);
    const raw     = urlObj.hash ? urlObj.hash.slice(1) : urlObj.search.slice(1);
    const params  = new URLSearchParams(raw);
    const access  = params.get('access_token');
    const refresh = params.get('refresh_token');

    if (!access || !refresh) throw new Error('No tokens in deep-link URL');

    const { data, error } = await supabase.auth.setSession({ access_token: access, refresh_token: refresh });
    if (error) throw error;

    const profile = await fetchProfile(data.user.id);
    syncToMain(data.user, profile);
    fireCallbacks({ user: data.user, profile });
    console.log('[preload] deep-link auth success:', data.user.email);
  } catch (err) {
    console.error('[preload] deep-link error:', err.message);
  }
});

// ── Increment token count (main → preload) ────────────────────────────────────
ipcRenderer.on('do-increment-tokens', async (event, tokenCount) => {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Fetch profile first to determine which counter to increment
    const profile  = await fetchProfile(user.id);
    const isCasual = profile?.subscription_status === 'active' || profile?.plan === 'casual';

    if (isCasual) {
      // Casual users: increment monthly rolling counter (with auto-reset logic in RPC)
      const { error: rpcError } = await supabase.rpc('increment_monthly_tokens', { user_id: user.id, token_count: tokenCount || 0 });
      if (rpcError) console.error('[preload] increment monthly tokens RPC error:', rpcError.message);
    } else {
      // Trial users: increment one-time total counter
      const { error: rpcError } = await supabase.rpc('increment_tokens_used', { user_id: user.id, token_count: tokenCount || 0 });
      if (rpcError) console.error('[preload] increment tokens RPC error:', rpcError.message);
    }

    const updatedProfile = await fetchProfile(user.id);
    syncToMain(user, updatedProfile);
    fireCallbacks({ user, profile: updatedProfile }); // Update usage bar in dashboard UI
  } catch (e) {
    console.error('[preload] increment tokens error:', e.message);
  }
});

// ── Expose API to dashboard renderer ─────────────────────────────────────────
contextBridge.exposeInMainWorld('dashboardAPI', {

  // Window controls
  launchAlfred:   (sessionId) => ipcRenderer.send('launch-alfred', sessionId),
  minimize:       () => ipcRenderer.send('dashboard-minimize'),
  toggleMaximize: () => ipcRenderer.send('dashboard-toggle-maximize'),
  close:          () => ipcRenderer.send('dashboard-close'),

  // Word status
  checkWordRunning: async () => ipcRenderer.invoke('check-word-running'),

  // Session management
  listSessions: async () => ipcRenderer.invoke('session-list'),
  deleteSession: async (sessionId) => ipcRenderer.invoke('session-delete', sessionId),
  
  // Listen for session refresh
  onRefreshSessions: (callback) => {
    ipcRenderer.on('refresh-sessions', () => {
      callback();
    });
  },

  // External links
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // ── Auth (all handled here in preload — Chromium fetch) ────────────────────

  /** Open Google OAuth in the system browser, then handle via deep-link */
  signInWithGoogle: async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'alfred://auth/callback', // Back to custom protocol (this works reliably)
        skipBrowserRedirect: true, // We open the URL ourselves
        queryParams: {
          // Force Google to show account chooser screen
          prompt: 'select_account',
          access_type: 'offline',
        }
      }
    });
    if (error) throw new Error(error.message);
    if (data?.url) {
      // Ensure prompt=select_account is in the URL (in case Supabase doesn't pass it through)
      let oauthUrl = data.url;
      if (!oauthUrl.includes('prompt=')) {
        oauthUrl += (oauthUrl.includes('?') ? '&' : '?') + 'prompt=select_account';
      }
      // Open in external browser (standard approach)
      ipcRenderer.send('open-external', oauthUrl);
    }
  },

  /** Sign in with email + password */
  signIn: async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    const profile = await fetchProfile(data.user.id);
    syncToMain(data.user, profile);
    return { user: data.user, profile };
  },

  /** Create a new account with email + password */
  signUp: async (email, password) => {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw new Error(error.message);
    // Profile is auto-created by the DB trigger — poll briefly until it appears
    let profile = null;
    for (let i = 0; i < 5; i++) {
      profile = await fetchProfile(data.user.id);
      if (profile) break;
      await new Promise(r => setTimeout(r, 600));
    }
    syncToMain(data.user, profile);
    return { user: data.user, profile };
  },

  /** Get the currently logged-in Supabase user, or null */
  getUser: async () => {
    const { data: { user } } = await supabase.auth.getUser();
    return user || null;
  },

  /** Get the user's profile row (plan, messages_used, etc.) */
  getProfile: async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    return await fetchProfile(user.id);
  },

  /** Sign out and clear local session */
  signOut: async () => {
    await supabase.auth.signOut();
    syncToMain(null, null);
  },

  /**
   * Register a callback that fires whenever auth state changes
   * (login, increment update, etc.)
   */
  onAuthStateChanged: (callback) => {
    authCallbacks.push(callback);
  },

  /** Create Stripe Checkout Session */
  createCheckoutSession: async () => {
    try {
      // Get and refresh session to ensure we have a valid token
      const { data: { session: currentSession }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !currentSession) throw new Error('Not authenticated');

      // Refresh the session to get a fresh token
      const { data: { session }, error: refreshError } = await supabase.auth.refreshSession(currentSession);
      if (refreshError || !session) {
        console.error('Failed to refresh session:', refreshError);
        throw new Error('Failed to refresh authentication');
      }

      // Get user ID from session
      const userId = session.user?.id;
      if (!userId) {
        throw new Error('User ID not found in session');
      }

      console.log('Calling checkout with user ID:', userId);

      // Call Supabase Edge Function - pass user ID in body
      // Use anon key as Bearer token to satisfy gateway (but function will verify userId server-side)
      const response = await fetch(`${SUPABASE_URL}/functions/v1/smart-processor`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = 'Failed to create checkout session';
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorJson.message || errorMessage;
        } catch (e) {
          errorMessage = errorText || errorMessage;
        }
        console.error('Checkout error response:', errorText);
        throw new Error(errorMessage);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Error creating checkout session:', error);
      throw error;
    }
  },

  /** Create Stripe Customer Portal Session */
  createPortalSession: async () => {
    try {
      // Get and refresh session to ensure we have a valid token
      const { data: { session: currentSession }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !currentSession) throw new Error('Not authenticated');

      // Refresh the session to get a fresh token
      const { data: { session }, error: refreshError } = await supabase.auth.refreshSession(currentSession);
      if (refreshError || !session) {
        console.error('Failed to refresh session:', refreshError);
        throw new Error('Failed to refresh authentication');
      }

      // Get user ID from session
      const userId = session.user?.id;
      if (!userId) {
        throw new Error('User ID not found in session');
      }

      console.log('Calling portal with user ID:', userId);

      // Call Supabase Edge Function - pass user ID in body
      const response = await fetch(`${SUPABASE_URL}/functions/v1/create-portal`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = 'Failed to create portal session';
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorJson.message || errorMessage;
        } catch (e) {
          errorMessage = errorText || errorMessage;
        }
        console.error('Portal error response:', errorText);
        throw new Error(errorMessage);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Error creating portal session:', error);
      throw error;
    }
  },
});
