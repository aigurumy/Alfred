/**
 * Supabase client for Alfred — runs in the main process.
 * Uses file-based session storage so the user stays logged in
 * between app restarts without needing a browser/localStorage.
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs   = require('fs');
const config = require('./config');

const SUPABASE_URL      = config.SUPABASE_URL;
const SUPABASE_ANON_KEY = config.SUPABASE_ANON_KEY;

const FREE_TRIAL_TOKEN_LIMIT = 15000; // 15,000 tokens free trial limit

// ── File-based session storage ────────────────────────────────────────────────
// Lazy-initialised so we don't call app.getPath() before app is ready.
let _sessionFilePath = null;

function getSessionFilePath() {
  if (!_sessionFilePath) {
    const { app } = require('electron');
    _sessionFilePath = path.join(app.getPath('userData'), 'alfred-session.json');
  }
  return _sessionFilePath;
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
    } catch (e) { console.error('[supabase] session write error:', e.message); }
  },
  removeItem(key) {
    try {
      const fp = getSessionFilePath();
      if (!fs.existsSync(fp)) return;
      let data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      delete data[key];
      fs.writeFileSync(fp, JSON.stringify(data));
    } catch (e) { console.error('[supabase] session remove error:', e.message); }
  }
};

// ── Client ────────────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage:             fileStorage,
    autoRefreshToken:    true,
    persistSession:      true,
    detectSessionInUrl:  false,   // We handle deep-link tokens manually
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the current Supabase user or null. */
async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/** Fetches the profile row for the current user. */
async function getProfile() {
  const user = await getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  if (error) { console.error('[supabase] getProfile error:', error.message); return null; }
  return data;
}

/**
 * Sends a magic-link email.  The link redirects back to alfred://auth/callback.
 */
async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: 'alfred://auth/callback' }
  });
  if (error) throw new Error(error.message);
}

/** Signs out the current user and clears the stored session. */
async function signOut() {
  await supabase.auth.signOut();
}

/**
 * Handles the alfred://auth/callback deep-link URL.
 * Extracts access_token + refresh_token from the URL fragment/query
 * and sets the Supabase session.
 * Returns { user, profile } on success, throws on failure.
 */
async function handleAuthCallback(url) {
  // Tokens can be in the fragment (#) or query string (?)
  const urlObj   = new URL(url);
  const fragment = urlObj.hash  ? urlObj.hash.slice(1)   : '';
  const query    = urlObj.search ? urlObj.search.slice(1) : '';
  const params   = new URLSearchParams(fragment || query);

  const accessToken  = params.get('access_token');
  const refreshToken = params.get('refresh_token');

  if (!accessToken || !refreshToken) {
    throw new Error('No tokens found in callback URL');
  }

  const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  if (error) throw new Error(error.message);

  const profile = await getProfile();
  return { user: data.user, profile };
}

/**
 * Checks whether the current user is allowed to send a message.
 * Returns { canSend, plan, tokensUsed, remaining, reason }
 */
async function checkCanSend() {
  const user = await getUser();
  if (!user) return { canSend: false, reason: 'not-logged-in' };

  const profile = await getProfile();
  if (!profile) return { canSend: false, reason: 'no-profile' };

  // If subscription_status is "active", user has paid access (even if scheduled to cancel)
  // This handles the case where plan might be "trial" but subscription is still active
  if (profile.subscription_status === 'active' || profile.plan === 'casual') {
    return { canSend: true, plan: 'casual', tokensUsed: profile.tokens_used ?? 0, remaining: Infinity };
  }

  // Free trial — token-based
  const tokensUsed = profile.tokens_used ?? 0;
  const remaining = FREE_TRIAL_TOKEN_LIMIT - tokensUsed;
  if (remaining > 0) {
    return { canSend: true, plan: 'trial', tokensUsed, remaining };
  }
  return { canSend: false, reason: 'trial-exhausted', plan: 'trial', tokensUsed, remaining: 0 };
}

/** Atomically increments tokens_used for the current user by tokenCount. */
async function incrementTokens(tokenCount) {
  const user = await getUser();
  if (!user) return;
  const { error } = await supabase.rpc('increment_tokens_used', { user_id: user.id, token_count: tokenCount });
  if (error) console.error('[supabase] increment tokens error:', error.message);
}

module.exports = {
  supabase,
  SUPABASE_URL,
  FREE_TRIAL_TOKEN_LIMIT,
  getUser,
  getProfile,
  sendMagicLink,
  signOut,
  handleAuthCallback,
  checkCanSend,
  incrementTokens,
};
