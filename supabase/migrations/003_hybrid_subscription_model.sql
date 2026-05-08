-- Hybrid pricing model: monthly subscription tiers + one-time token packs
-- Replaces the pay-per-use-only model from migration 002.

-- 1. Add new columns for the hybrid model
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS subscription_tier        TEXT,
  ADD COLUMN IF NOT EXISTS subscription_period_end  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_tokens      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pack_tokens              INTEGER NOT NULL DEFAULT 0;

-- 2. Migrate any existing token_balance into pack_tokens
UPDATE profiles
   SET pack_tokens = COALESCE(token_balance, 0)
 WHERE token_balance IS NOT NULL AND token_balance > 0;

-- 3. Drop legacy balance columns (consolidated into the two above)
ALTER TABLE profiles
  DROP COLUMN IF EXISTS token_balance,
  DROP COLUMN IF EXISTS word_balance;

-- 4. Documentation
COMMENT ON COLUMN profiles.subscription_tier        IS 'Active subscription tier: lite, standard, pro, or NULL';
COMMENT ON COLUMN profiles.subscription_period_end  IS 'Stripe current_period_end — when subscription_tokens reset';
COMMENT ON COLUMN profiles.subscription_tokens      IS 'Tokens from monthly subscription, reset to tier amount on renewal';
COMMENT ON COLUMN profiles.pack_tokens              IS 'Top-up pack tokens, never expire, accumulate across purchases';

-- 5. deduct_tokens: drain subscription_tokens first, then pack_tokens
--    (PostgreSQL evaluates SET expressions against the OLD row, so a single UPDATE works.)
CREATE OR REPLACE FUNCTION deduct_tokens(user_id UUID, token_count INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF token_count IS NULL OR token_count <= 0 THEN RETURN; END IF;

  UPDATE profiles
     SET subscription_tokens = GREATEST(0, subscription_tokens - token_count),
         pack_tokens         = CASE
           WHEN subscription_tokens >= token_count THEN pack_tokens
           ELSE GREATEST(0, pack_tokens - (token_count - subscription_tokens))
         END
   WHERE id = user_id;
END;
$$;

-- 6. add_balance: credits pack_tokens (used for one-time pack purchases)
CREATE OR REPLACE FUNCTION add_balance(user_id UUID, tokens_to_add INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF tokens_to_add IS NULL OR tokens_to_add <= 0 THEN RETURN; END IF;

  UPDATE profiles
     SET pack_tokens = pack_tokens + tokens_to_add,
         plan        = 'paid'
   WHERE id = user_id;
END;
$$;

-- 7. set_subscription_tier: called on customer.subscription.created or .updated
--    Sets the tier and resets subscription_tokens to the tier's full allowance.
--    This handles both initial subscription and tier upgrades/downgrades — on any
--    tier change the user immediately gets the new tier's full token amount.
CREATE OR REPLACE FUNCTION set_subscription_tier(
  user_id        UUID,
  tier           TEXT,
  tier_tokens    INTEGER,
  stripe_sub_id  TEXT,
  period_end     TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
     SET subscription_tier        = tier,
         subscription_tokens      = tier_tokens,
         stripe_subscription_id   = stripe_sub_id,
         subscription_status      = 'active',
         subscription_period_end  = period_end,
         plan                     = 'paid'
   WHERE id = user_id;
END;
$$;

-- 8. reset_subscription_tokens: called on invoice.paid (renewal)
--    Resets subscription_tokens to the tier amount. Pack tokens are untouched.
CREATE OR REPLACE FUNCTION reset_subscription_tokens(
  user_id      UUID,
  tier_tokens  INTEGER,
  period_end   TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
     SET subscription_tokens     = tier_tokens,
         subscription_period_end = period_end,
         subscription_status     = 'active'
   WHERE id = user_id;
END;
$$;

-- 9. clear_subscription: called on customer.subscription.deleted
--    Wipes subscription state but preserves pack_tokens. Plan stays 'paid' if
--    they still have packs, otherwise reverts to 'trial'.
CREATE OR REPLACE FUNCTION clear_subscription(user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
     SET subscription_tier        = NULL,
         subscription_tokens      = 0,
         subscription_status      = 'canceled',
         stripe_subscription_id   = NULL,
         subscription_period_end  = NULL,
         plan                     = CASE WHEN pack_tokens > 0 THEN 'paid' ELSE 'trial' END
   WHERE id = user_id;
END;
$$;
