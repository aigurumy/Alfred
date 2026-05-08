/**
 * config.example.js — Alfred configuration template
 *
 * Copy this file to config.js and fill in your real API keys.
 * config.js is gitignored — this example file is safe to commit.
 *
 *   cp config.example.js config.js
 */

module.exports = {
  // OpenRouter API key (https://openrouter.ai)
  OPENROUTER_API_KEY: 'sk-or-v1-YOUR_KEY_HERE',

  // Undetectable.ai API key (https://undetectable.ai)
  UNDETECTABLE_API_KEY: 'YOUR_UNDETECTABLE_KEY_HERE',

  // Supabase project credentials (https://supabase.com → Project Settings → API)
  SUPABASE_URL:      'https://YOUR_PROJECT_ID.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY_HERE',

  // GitHub Personal Access Token (repo scope) — for electron-updater private repo access
  GH_TOKEN: 'ghp_YOUR_TOKEN_HERE',
};
