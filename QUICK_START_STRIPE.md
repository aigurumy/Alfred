# Quick Start: Stripe Integration

## What You Need to Do

### 1. Run Database Migration (5 minutes)

Go to Supabase Dashboard → SQL Editor and run:

```sql
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer ON profiles(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_subscription ON profiles(stripe_subscription_id);
```

### 2. Install Supabase CLI (if needed)

```bash
npm install -g supabase
```

### 3. Login and Link Project

```bash
supabase login
supabase link --project-ref ibipazkspglvzrdzngdo
```

### 4. Set Secrets (5 minutes)

Get your Supabase Service Role Key from: Supabase Dashboard → Settings → API → service_role key

```bash
supabase secrets set STRIPE_SECRET_KEY=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

supabase secrets set SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY_HERE

supabase secrets set PROJECT_URL=https://ibipazkspglvzrdzngdo.supabase.co

supabase secrets set APP_URL=alfred://
```

### 5. Deploy Functions (2 minutes)

```bash
supabase functions deploy create-checkout
supabase functions deploy stripe-webhook
```

### 6. Set Up Webhook in Stripe (5 minutes)

1. Go to Stripe Dashboard → Developers → Webhooks
2. Click "Add endpoint"
3. Endpoint URL: `https://ibipazkspglvzrdzngdo.supabase.co/functions/v1/stripe-webhook`
4. Select events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copy the Webhook Signing Secret
6. Set it:

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_YOUR_WEBHOOK_SECRET
```

### 7. Test It!

1. Open Alfred Dashboard
2. Click "Upgrade" button
3. Complete checkout in browser
4. You should be redirected back to Alfred
5. Your plan should update to "Casual Plan"

## Troubleshooting

**Checkout not opening?**
- Check function logs: `supabase functions logs create-checkout`
- Make sure user is logged in

**Plan not updating after payment?**
- Check webhook logs: `supabase functions logs stripe-webhook`
- Verify webhook secret is correct
- Check Stripe Dashboard → Webhooks for delivery status

**Need help?**
- Check `STRIPE_SETUP.md` for detailed instructions
- Check Supabase function logs for errors
