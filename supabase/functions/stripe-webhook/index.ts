// Supabase Edge Function: Stripe Webhook Handler
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

  // Log immediately - if we see this, the function is being called
  console.log("=== WEBHOOK CALLED ===")
  console.log("Method:", req.method)
  console.log("URL:", req.url)
  
  // Try to log headers (might fail if request is blocked)
  try {
    const headers = Object.fromEntries(req.headers.entries())
    console.log("Headers received:", JSON.stringify(headers))
  } catch (e) {
    console.log("Could not log headers:", e)
  }
  
  const signature = req.headers.get("stripe-signature")
  console.log("Stripe signature present:", !!signature)
  console.log("Webhook secret present:", !!webhookSecret)
  
  if (!signature) {
    console.error("Missing stripe-signature header")
    return new Response(
      JSON.stringify({ error: "Missing stripe-signature header" }),
      { 
        status: 400, 
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        } 
      }
    )
  }

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set!")
    return new Response(
      JSON.stringify({ error: "Webhook secret not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  try {
    const body = await req.text()
    console.log("Request body length:", body.length)
    
    // Use constructEventAsync for Deno (required in Supabase Edge Functions)
    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret
    )
    
    console.log("Event verified:", event.type, event.id)

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Handle different event types
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.metadata?.supabase_user_id
        console.log("Processing checkout.session.completed")
        console.log("User ID from metadata:", userId)
        console.log("Subscription ID:", session.subscription)

        if (userId && session.subscription) {
          // Update user profile to casual plan
          const { error: updateError } = await supabase
            .from("profiles")
            .update({
              plan: "casual",
              stripe_subscription_id: session.subscription as string,
              subscription_status: "active",
            })
            .eq("id", userId)
          
          if (updateError) {
            console.error("Failed to update profile:", updateError)
          } else {
            console.log("Profile updated successfully to casual plan")
          }
        } else {
          console.warn("Missing userId or subscription in session")
        }
        break
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        console.log("Processing subscription.updated", {
          status: subscription.status,
          cancel_at_period_end: subscription.cancel_at_period_end,
          current_period_end: subscription.current_period_end,
          canceled_at: subscription.canceled_at
        })

        // Find user by customer ID
        const { data: profile } = await supabase
          .from("profiles")
          .select("id")
          .eq("stripe_customer_id", customerId)
          .single()

        if (profile) {
          const status = subscription.status
          
          // Determine if user should have casual plan access:
          // - Status must be "active" (even if cancel_at_period_end is true, they keep access until period ends)
          // - If status is "canceled", "past_due", "unpaid", "incomplete", or "incomplete_expired", downgrade to trial
          // When period ends, Stripe sends status "canceled" in this event, then sends deleted event
          const activeStatuses = ["active", "trialing"]
          const shouldBeCasual = activeStatuses.includes(status)
          
          console.log("Updating profile", {
            userId: profile.id,
            status,
            shouldBeCasual,
            cancel_at_period_end: subscription.cancel_at_period_end,
            willDowngrade: !shouldBeCasual
          })
          
          const updateData: any = {
            subscription_status: status,
            plan: shouldBeCasual ? "casual" : "trial",
          }
          
          // If subscription is canceled/deleted, clear the subscription ID
          // (customer.subscription.deleted will also handle this, but this ensures it happens)
          if (!shouldBeCasual && status === "canceled") {
            updateData.stripe_subscription_id = null
          }
          
          await supabase
            .from("profiles")
            .update(updateData)
            .eq("id", profile.id)
        }
        break
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        console.log("Processing subscription.deleted", {
          customerId,
          subscriptionId: subscription.id,
          status: subscription.status
        })

        // Find user by customer ID
        const { data: profile } = await supabase
          .from("profiles")
          .select("id")
          .eq("stripe_customer_id", customerId)
          .single()

        if (profile) {
          console.log("Downgrading user to trial plan", { userId: profile.id })
          
          // Final step: Subscription has been fully deleted
          // This event fires when the billing period ends for subscriptions with cancel_at_period_end=true
          // Revert to trial plan and clear subscription reference
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
