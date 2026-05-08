// Supabase Edge Function: Create Stripe Checkout Session
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

// One-time token pack products (existing).
const PACK_PRODUCTS: Record<string, string> = {
  "1000":  "prod_USHuLP1sgiw8d4",
  "3000":  "prod_USHwAtS5YVIDF2",
  "5000":  "prod_USI1Py7zUNPL5c",
  "10000": "prod_USI2vk8lhWXvqS",
}

// Subscription products (recurring MYR pricing, metadata { tier, tokens }).
const SUBSCRIPTION_PRODUCTS: Record<string, string> = {
  "lite":     "prod_USi4KILEHSBdXz",   // RM 9.99/mo  → 3,000 tokens
  "standard": "prod_USi6nPGifucAlY",   // RM 19.99/mo → 8,000 tokens
  "pro":      "prod_USi8dXsHB7yKKJ",   // RM 39.99/mo → 20,000 tokens
}

serve(async (req) => {
  console.log("=== CHECKOUT FUNCTION CALLED ===")
  console.log("Method:", req.method)

  try {
    let body
    try {
      const bodyText = await req.text()
      console.log("Raw request body:", bodyText)
      body = bodyText ? JSON.parse(bodyText) : {}
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError)
      return new Response(
        JSON.stringify({ error: "Invalid request body", details: parseError.message }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const userId = body?.userId
    const type   = body?.type   // 'pack' | 'subscription'
    const tier   = body?.tier   // pack tier ("1000"...) or sub tier ("lite"...)

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Missing userId in request body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    if (type !== "pack" && type !== "subscription") {
      return new Response(
        JSON.stringify({ error: "Invalid type. Must be 'pack' or 'subscription'" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const productMap = type === "pack" ? PACK_PRODUCTS : SUBSCRIPTION_PRODUCTS
    if (!tier || !productMap[tier]) {
      return new Response(
        JSON.stringify({
          error: `Invalid tier '${tier}' for type '${type}'. Valid tiers: ${Object.keys(productMap).join(", ")}`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    console.log("User ID:", userId, "Type:", type, "Tier:", tier)

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Verify user exists and grab their stripe_customer_id (or create one)
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, stripe_customer_id, stripe_subscription_id")
      .eq("id", userId)
      .single()

    if (profileError || !profile) {
      console.error("User not found:", profileError)
      return new Response(
        JSON.stringify({ error: "Unauthorized", message: "User not found" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    }

    // Get user email
    const { data: authUser } = await supabase.auth.admin.getUserById(userId)
    const userEmail = authUser?.user?.email || null

    // Get or create Stripe customer
    let customerId = profile.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail || undefined,
        metadata: { supabase_user_id: profile.id },
      })
      customerId = customer.id
      console.log("Created Stripe customer:", customerId)

      await supabase
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", profile.id)
    }

    const productId = productMap[tier]
    console.log("Looking up active price for product:", productId)

    const prices = await stripe.prices.list({ product: productId, active: true })
    if (prices.data.length === 0) {
      return new Response(
        JSON.stringify({ error: `No active price found for product ${productId}` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }
    const priceId = prices.data[0].id

    // Subscription path: if user already has an active subscription, swap the
    // price on the existing subscription instead of creating a new checkout —
    // this is how Stripe expects mid-cycle tier upgrades/downgrades to work.
    if (type === "subscription" && profile.stripe_subscription_id) {
      try {
        const existing = await stripe.subscriptions.retrieve(profile.stripe_subscription_id)
        if (["active", "trialing", "past_due"].includes(existing.status)) {
          const itemId = existing.items.data[0]?.id
          if (itemId) {
            await stripe.subscriptions.update(profile.stripe_subscription_id, {
              items: [{ id: itemId, price: priceId }],
              proration_behavior: "create_prorations",
              metadata: {
                supabase_user_id: profile.id,
                tier: tier,
                type: "subscription",
              },
            })
            console.log("Tier change applied to existing subscription:", profile.stripe_subscription_id)
            return new Response(
              JSON.stringify({ tierChanged: true, subscriptionId: profile.stripe_subscription_id }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          }
        }
      } catch (err) {
        console.warn("Existing subscription lookup failed, falling through to new checkout:", err)
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: type === "subscription" ? "subscription" : "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      // Bounce pages on alfred.cool redirect users back to the desktop app via
      // alfred:// deep-links. Stripe forbids custom protocols here, so the page
      // does the protocol switch in the browser.
      success_url: "https://alfred.cool/checkout/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:  "https://alfred.cool/checkout/cancel",
      metadata: {
        supabase_user_id: profile.id,
        tier: tier,
        type: type,
      },
      // Forward metadata onto the subscription itself so webhooks can read it
      ...(type === "subscription"
        ? { subscription_data: { metadata: { supabase_user_id: profile.id, tier: tier } } }
        : {}),
    })

    console.log("Checkout session created:", session.id)

    if (!session.url) {
      return new Response(
        JSON.stringify({ error: "Checkout session created but URL is missing" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    return new Response(
      JSON.stringify({ url: session.url }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("FATAL ERROR:", error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
})
