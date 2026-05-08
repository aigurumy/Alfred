// Supabase Edge Function: Stripe Webhook Handler (Pay-Per-Use)
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

// Tier to token mapping (must match Stripe product metadata)
const TIER_TOKENS: Record<string, number> = {
  "1000":  1300,
  "3000":  3900,
  "5000":  6500,
  "10000": 13000,
}

serve(async (req) => {
  // Handle CORS preflight
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
    return new Response(
      JSON.stringify({ error: "Missing stripe-signature header" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  if (!webhookSecret) {
    return new Response(
      JSON.stringify({ error: "Webhook secret not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  try {
    const body = await req.text()
    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret
    )

    console.log("Event verified:", event.type, event.id)

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.metadata?.supabase_user_id
        const tier = session.metadata?.tier

        console.log("Checkout completed — User:", userId, "Tier:", tier, "Mode:", session.mode)

        if (!userId) {
          console.warn("Missing userId in session metadata")
          break
        }

        // One-time payment: credit tokens to user balance
        if (session.mode === "payment" && tier) {
          const tokensToAdd = TIER_TOKENS[tier]
          if (!tokensToAdd) {
            console.error("Unknown tier:", tier)
            break
          }

          // Credit the user's balance using the RPC function
          const { error: rpcError } = await supabase.rpc("add_balance", {
            user_id: userId,
            tokens_to_add: tokensToAdd,
          })

          if (rpcError) {
            console.error("Failed to add balance:", rpcError)
          } else {
            console.log(`Credited ${tokensToAdd} tokens to user ${userId} (tier: ${tier})`)
          }

          // Record the purchase
          const amountPaid = session.amount_total || 0
          const { error: purchaseError } = await supabase
            .from("purchases")
            .insert({
              user_id: userId,
              tier: tier,
              amount_paid: amountPaid,
              tokens_added: tokensToAdd,
            })

          if (purchaseError) {
            console.error("Failed to record purchase:", purchaseError)
          }

          // Update plan to 'paid' if user was on trial
          const { error: planError } = await supabase
            .from("profiles")
            .update({ plan: "paid" })
            .eq("id", userId)
            .eq("plan", "trial")

          if (planError) {
            console.error("Failed to update plan:", planError)
          }
        }

        // Legacy: handle subscription checkout (in case old subscriptions still trigger)
        if (session.mode === "subscription" && session.subscription) {
          const { error: updateError } = await supabase
            .from("profiles")
            .update({
              plan: "casual",
              stripe_subscription_id: session.subscription as string,
              subscription_status: "active",
            })
            .eq("id", userId)

          if (updateError) {
            console.error("Failed to update subscription profile:", updateError)
          }
        }
        break
      }

      // Legacy: keep subscription handlers for existing subscribers
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        const { data: profile } = await supabase
          .from("profiles")
          .select("id")
          .eq("stripe_customer_id", customerId)
          .single()

        if (profile) {
          const status = subscription.status
          const activeStatuses = ["active", "trialing"]
          const shouldBeCasual = activeStatuses.includes(status)

          await supabase
            .from("profiles")
            .update({
              subscription_status: status,
              plan: shouldBeCasual ? "casual" : "trial",
            })
            .eq("id", profile.id)
        }
        break
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        const { data: profile } = await supabase
          .from("profiles")
          .select("id")
          .eq("stripe_customer_id", customerId)
          .single()

        if (profile) {
          await supabase
            .from("profiles")
            .update({
              plan: "trial",
              subscription_status: "canceled",
              stripe_subscription_id: null,
            })
            .eq("id", profile.id)
        }
        break
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("Webhook error:", error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }
})
