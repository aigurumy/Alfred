// Supabase Edge Function: Stripe Webhook Handler
// Handles both one-time token packs and recurring subscription tiers.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get("PROJECT_URL") || "https://ibipazkspglvzrdzngdo.supabase.co"
const supabaseServiceKey = Deno.env.get("SERVICE_ROLE_KEY") || ""
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || ""

// One-time pack tier → tokens credited
const PACK_TOKENS: Record<string, number> = {
  "1000":  1300,
  "3000":  3900,
  "5000":  6500,
  "10000": 13000,
}

// Subscription tier → monthly token allowance
const SUBSCRIPTION_TOKENS: Record<string, number> = {
  "lite":     3000,
  "standard": 8000,
  "pro":      20000,
}

// Resolve a Stripe Price → tier name. Tier should be in price.metadata.tier or
// product.metadata.tier (set when you create the product). Falls back to looking
// up by price.unit_amount as a last resort.
async function resolveTierFromPrice(priceId: string): Promise<string | null> {
  try {
    const price = await stripe.prices.retrieve(priceId, { expand: ["product"] })
    const tier = price.metadata?.tier
      || (typeof price.product === "object" ? (price.product as Stripe.Product).metadata?.tier : undefined)
    return tier || null
  } catch (err) {
    console.error("resolveTierFromPrice failed:", err)
    return null
  }
}

// Look up the supabase user_id for a Stripe customer.
async function userIdFromCustomer(supabase: any, customerId: string): Promise<string | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single()
  return profile?.id || null
}

// In Stripe API 2024-01-16+, current_period_end moved from the subscription
// to the subscription items. Fall back through known locations and Stripe
// versions to keep this resilient.
function periodEndIso(subscription: Stripe.Subscription): string | null {
  const subAny = subscription as any
  const candidates = [
    subAny.current_period_end,
    subscription.items?.data?.[0]?.current_period_end,
    (subscription.items?.data?.[0] as any)?.current_period?.end,
  ]
  for (const ts of candidates) {
    if (typeof ts === "number" && ts > 0) {
      return new Date(ts * 1000).toISOString()
    }
  }
  return null
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "stripe-signature, content-type",
      },
    })
  }

  console.log("=== WEBHOOK CALLED ===")

  const signature = req.headers.get("stripe-signature")
  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing stripe-signature header" }),
      { status: 400, headers: { "Content-Type": "application/json" } })
  }
  if (!webhookSecret) {
    return new Response(JSON.stringify({ error: "Webhook secret not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } })
  }

  try {
    const body  = await req.text()
    const event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret)
    console.log("Event verified:", event.type, event.id)

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    switch (event.type) {

      // ── One-time pack purchase ──────────────────────────────────────────────
      // Subscription checkouts also fire this, but invoice.paid handles those —
      // we only credit tokens here for one-time payments.
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const userId  = session.metadata?.supabase_user_id
        const tier    = session.metadata?.tier
        const type    = session.metadata?.type

        console.log("Checkout completed — user:", userId, "type:", type, "tier:", tier, "mode:", session.mode)

        if (!userId) {
          console.warn("Missing userId in session metadata")
          break
        }

        if (session.mode === "payment" && type === "pack" && tier) {
          const tokensToAdd = PACK_TOKENS[tier]
          if (!tokensToAdd) {
            console.error("Unknown pack tier:", tier)
            break
          }

          const { error: rpcError } = await supabase.rpc("add_balance", {
            user_id:        userId,
            tokens_to_add:  tokensToAdd,
          })
          if (rpcError) {
            console.error("Failed to add balance:", rpcError)
          } else {
            console.log(`Credited ${tokensToAdd} pack tokens to user ${userId} (tier: ${tier})`)
          }

          const { error: purchaseError } = await supabase
            .from("purchases")
            .insert({
              user_id:      userId,
              tier:         tier,
              amount_paid:  session.amount_total || 0,
              tokens_added: tokensToAdd,
            })
          if (purchaseError) console.error("Failed to record purchase:", purchaseError)
        }
        break
      }

      // ── New subscription created ────────────────────────────────────────────
      case "customer.subscription.created": {
        const subscription = event.data.object as Stripe.Subscription
        const customerId   = subscription.customer as string
        const priceId      = subscription.items.data[0]?.price?.id
        const periodEnd    = periodEndIso(subscription)

        const userId = subscription.metadata?.supabase_user_id
          || await userIdFromCustomer(supabase, customerId)
        if (!userId) {
          console.warn("subscription.created: could not resolve userId for customer", customerId)
          break
        }

        const tier = subscription.metadata?.tier || (priceId ? await resolveTierFromPrice(priceId) : null)
        if (!tier || !SUBSCRIPTION_TOKENS[tier]) {
          console.error("subscription.created: unknown tier:", tier)
          break
        }

        const { error: rpcError } = await supabase.rpc("set_subscription_tier", {
          user_id:        userId,
          tier:           tier,
          tier_tokens:    SUBSCRIPTION_TOKENS[tier],
          stripe_sub_id:  subscription.id,
          period_end:     periodEnd,
        })
        if (rpcError) {
          console.error("set_subscription_tier failed:", rpcError)
        } else {
          console.log(`Subscription created for ${userId}: tier=${tier} tokens=${SUBSCRIPTION_TOKENS[tier]}`)
        }
        break
      }

      // ── Tier change: user upgraded/downgraded their subscription ───────────
      // Fires both for tier changes and routine status updates. We only act
      // when the price (tier) actually changed.
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription
        const previous     = (event.data as any).previous_attributes || {}
        const customerId   = subscription.customer as string
        const priceId      = subscription.items.data[0]?.price?.id
        const periodEnd    = periodEndIso(subscription)

        const userId = subscription.metadata?.supabase_user_id
          || await userIdFromCustomer(supabase, customerId)
        if (!userId) {
          console.warn("subscription.updated: could not resolve userId for customer", customerId)
          break
        }

        // Detect a tier change by comparing price IDs against previous_attributes
        const prevItems  = previous?.items?.data
        const oldPriceId = prevItems?.[0]?.price?.id
        const tierChanged = oldPriceId && priceId && oldPriceId !== priceId

        if (subscription.status === "canceled" || subscription.status === "unpaid") {
          await supabase
            .from("profiles")
            .update({ subscription_status: subscription.status })
            .eq("id", userId)
          break
        }

        if (tierChanged) {
          const tier = subscription.metadata?.tier || await resolveTierFromPrice(priceId!)
          if (!tier || !SUBSCRIPTION_TOKENS[tier]) {
            console.error("subscription.updated: unknown new tier:", tier)
            break
          }

          // Tier change → credit the full new tier amount immediately.
          const { error: rpcError } = await supabase.rpc("set_subscription_tier", {
            user_id:        userId,
            tier:           tier,
            tier_tokens:    SUBSCRIPTION_TOKENS[tier],
            stripe_sub_id:  subscription.id,
            period_end:     periodEnd,
          })
          if (rpcError) {
            console.error("set_subscription_tier failed on tier change:", rpcError)
          } else {
            console.log(`Tier changed for ${userId}: → ${tier} (${SUBSCRIPTION_TOKENS[tier]} tokens)`)
          }
        } else {
          // No tier change — just sync status + period_end
          await supabase
            .from("profiles")
            .update({
              subscription_status:     subscription.status,
              subscription_period_end: periodEnd,
            })
            .eq("id", userId)
        }
        break
      }

      // ── Subscription canceled / ended ──────────────────────────────────────
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription
        const customerId   = subscription.customer as string

        const userId = subscription.metadata?.supabase_user_id
          || await userIdFromCustomer(supabase, customerId)
        if (!userId) {
          console.warn("subscription.deleted: could not resolve userId for customer", customerId)
          break
        }

        const { error: rpcError } = await supabase.rpc("clear_subscription", { user_id: userId })
        if (rpcError) {
          console.error("clear_subscription failed:", rpcError)
        } else {
          console.log(`Subscription cleared for ${userId} — pack tokens preserved`)
        }
        break
      }

      // ── Renewal: monthly invoice paid → reset subscription_tokens ──────────
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice
        // Only renewals — skip the initial subscription invoice (handled by .created)
        // and skip non-subscription invoices (e.g. one-off charges).
        if (invoice.billing_reason !== "subscription_cycle") break

        const subscriptionId = invoice.subscription as string | null
        if (!subscriptionId) break

        const subscription = await stripe.subscriptions.retrieve(subscriptionId)
        const customerId   = subscription.customer as string
        const priceId      = subscription.items.data[0]?.price?.id
        const periodEnd    = periodEndIso(subscription)

        const userId = subscription.metadata?.supabase_user_id
          || await userIdFromCustomer(supabase, customerId)
        if (!userId) {
          console.warn("invoice.paid: could not resolve userId for customer", customerId)
          break
        }

        const tier = subscription.metadata?.tier || (priceId ? await resolveTierFromPrice(priceId) : null)
        if (!tier || !SUBSCRIPTION_TOKENS[tier]) {
          console.error("invoice.paid: unknown tier:", tier)
          break
        }

        const { error: rpcError } = await supabase.rpc("reset_subscription_tokens", {
          user_id:      userId,
          tier_tokens:  SUBSCRIPTION_TOKENS[tier],
          period_end:   periodEnd,
        })
        if (rpcError) {
          console.error("reset_subscription_tokens failed:", rpcError)
        } else {
          console.log(`Renewal: reset ${SUBSCRIPTION_TOKENS[tier]} tokens for ${userId} (tier: ${tier})`)
        }
        break
      }

      // ── Payment failed ─────────────────────────────────────────────────────
      case "invoice.payment_failed": {
        const invoice        = event.data.object as Stripe.Invoice
        const subscriptionId = invoice.subscription as string | null
        if (!subscriptionId) break

        const subscription = await stripe.subscriptions.retrieve(subscriptionId)
        const customerId   = subscription.customer as string

        const userId = await userIdFromCustomer(supabase, customerId)
        if (!userId) break

        await supabase
          .from("profiles")
          .update({ subscription_status: "past_due" })
          .eq("id", userId)
        console.log(`Payment failed for ${userId} — marked past_due`)
        break
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("Webhook error:", error)
    return new Response(JSON.stringify({ error: error.message }),
      { status: 400, headers: { "Content-Type": "application/json" } })
  }
})
