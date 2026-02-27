-- Add Stripe-related fields to profiles table
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer ON profiles(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_subscription ON profiles(stripe_subscription_id);

-- Add comment
COMMENT ON COLUMN profiles.stripe_customer_id IS 'Stripe customer ID for payment processing';
COMMENT ON COLUMN profiles.stripe_subscription_id IS 'Stripe subscription ID';
COMMENT ON COLUMN profiles.subscription_status IS 'Subscription status: trial, active, canceled, past_due, etc.';
