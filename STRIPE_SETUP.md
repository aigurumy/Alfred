# Stripe Integration Setup Guide

This guide will walk you through setting up Stripe payment integration for Alfred.

## Prerequisites

- Stripe account with API keys
- Supabase project with Edge Functions enabled
- Product ID: `prod_U0yBmJbqXFlIpn` (Casual Plan)

## Step 1: Run Database Migration

1. Go to your Supabase Dashboard → SQL Editor
2. Run the migration file: `supabase/migrations/001_add_stripe_fields.sql`
   - This adds `stripe_customer_id`, `stripe_subscription_id`, and `subscription_status` columns to the `profiles` table

## Step 2: Deploy Supabase Edge Functions

### Install Supabase CLI (if not already installed)

```bash
npm install -g supabase
```

### Login to Supabase

```bash
supabase login
```

### Link your project

```bash
supabase link --project-ref ibipazkspglvzrdzngdo
```

### Set Environment Variables

You need to set these secrets in Supabase:

```bash
# Stripe Secret Key (from your Stripe Dashboard)
supabase secrets set STRIPE_SECRET_KEY=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

# Supabase Service Role Key (from Supabase Dashboard → Settings → API)
# Note: Cannot use SUPABASE_ prefix - use SERVICE_ROLE_KEY instead
supabase secrets set SERVICE_ROLE_KEY=your_service_role_key_here

# Project URL (cannot use SUPABASE_ prefix - use PROJECT_URL instead)
supabase secrets set PROJECT_URL=https://ibipazkspglvzrdzngdo.supabase.co

# App URL for redirects
supabase secrets set APP_URL=alfred://
```

### Deploy Functions

```bash
# Deploy checkout function
supabase functions deploy create-checkout

# Deploy webhook function
supabase functions deploy stripe-webhook
```

## Step 3: Verify Product ID

The checkout function automatically looks up the price from your product ID. Make sure:
- Your Product ID is correct: `prod_U0yBmJbqXFlIpn`
- The product has at least one active recurring price in Stripe

The function will automatically find and use the first active recurring price for your product. No manual Price ID needed!

## Step 4: Set Up Stripe Webhook

1. Go to Stripe Dashboard → Developers → Webhooks
2. Click "Add endpoint"
3. Endpoint URL: `https://ibipazkspglvzrdzngdo.supabase.co/functions/v1/stripe-webhook`
4. Select events to listen to:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copy the **Webhook Signing Secret** (starts with `whsec_`)
6. Set it as a Supabase secret:

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here
```

## Step 5: Update Frontend (Already Done)

The frontend code has been updated to:
- Call the checkout function when "Upgrade" button is clicked
- Handle success/cancel redirects via `alfred://` deep links
- Refresh user profile after successful payment

## Step 6: Test the Integration

1. **Test Mode**: Switch to Stripe test mode first
   - Update `STRIPE_SECRET_KEY` to your test key (`sk_test_...`)
   - Use test product/price IDs
   - Test the full flow

2. **Production Mode**: Once tested, switch back to live keys

## Troubleshooting

### Checkout not opening
- Verify Edge Function is deployed: `supabase functions list`
- Check function logs: `supabase functions logs create-checkout`
- Ensure user is authenticated before clicking upgrade

### Webhook not updating user plan
- Verify webhook endpoint is correct in Stripe Dashboard
- Check webhook logs in Stripe Dashboard
- Check Edge Function logs: `supabase functions logs stripe-webhook`
- Verify `STRIPE_WEBHOOK_SECRET` is set correctly

### User plan not updating after payment
- Check Supabase logs for webhook events
- Verify database migration was run
- Check that `stripe_customer_id` is being saved to profile

## Security Notes

- Never commit API keys to git
- Use Supabase secrets for all sensitive values
- Webhook secret must match between Stripe and Supabase
- Service Role Key has full database access - keep it secret

## Next Steps

- Add subscription management (cancel, update payment method)
- Add invoice history
- Add usage analytics for paid users
- Add trial period extension for paid users
