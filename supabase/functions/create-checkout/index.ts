// Supabase Edge Function: Create Stripe Checkout Session
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get("PROJECT_URL") || "https://ibipazkspglvzrdzngdo.supabase.co"
const supabaseServiceKey = Deno.env.get("SERVICE_ROLE_KEY") || ""

serve(async (req) => {
  // CRITICAL: Log immediately to verify function is called
  console.log("=== FUNCTION CALLED ===")
  console.log("Method:", req.method)
  console.log("URL:", req.url)
  
  try {
    // Get user ID from request body (bypassing gateway JWT verification)
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
    
    console.log("Parsed request body:", body)
    
    const userId = body?.userId
    if (!userId) {
      console.log("No userId in body, returning 400")
      return new Response(
        JSON.stringify({ error: "Missing userId in request body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }
    
    console.log("User ID from body:", userId)
    
    // Use service role key for database operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    
    // Verify user exists by querying profiles table (email is in auth.users, not profiles)
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, stripe_customer_id")
      .eq("id", userId)
      .single()
    
    if (profileError || !profile) {
      console.error("User not found in profiles:", profileError)
      return new Response(
        JSON.stringify({ error: "Unauthorized", message: "User not found" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    }
    
    // Get user email from auth.users table
    const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(userId)
    const userEmail = authUser?.user?.email || null
    
    console.log("User verified:", profile.id, userEmail || "no email")

      // Get or create Stripe customer

      let customerId = profile.stripe_customer_id
      console.log("Customer ID from profile:", customerId || "None - will create")

      if (!customerId) {
        // Create Stripe customer
        const customer = await stripe.customers.create({
          email: userEmail || undefined, // Email is optional in Stripe
          metadata: {
            supabase_user_id: profile.id,
          },
        })
        customerId = customer.id
        console.log("Created Stripe customer:", customerId)

        // Save customer ID to profile
        await supabase
          .from("profiles")
          .update({ stripe_customer_id: customerId })
          .eq("id", profile.id)
      }

      // Get the price ID from the product
      const productId = "prod_U0yBmJbqXFlIpn"
      console.log("Getting prices for product:", productId)
      
      const prices = await stripe.prices.list({
        product: productId,
        active: true,
        type: "recurring",
      })

      if (prices.data.length === 0) {
        console.error("No prices found for product")
        return new Response(
          JSON.stringify({ error: "No active price found for product" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      }

      const priceId = prices.data[0].id
      console.log("Using price ID:", priceId)

      // Create checkout session
      console.log("Creating Stripe checkout session...")
      
      // Stripe requires HTTP/HTTPS URLs, not custom protocols like alfred://
      // The webhook will handle the subscription update, so any valid URL works
      const successUrl = "https://example.com/success?session_id={CHECKOUT_SESSION_ID}"
      const cancelUrl = "https://example.com/cancel"
      
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          supabase_user_id: profile.id,
        },
      })

      console.log("Checkout session created:", session.id)
      console.log("Checkout URL:", session.url)
      
      if (!session.url) {
        console.error("Stripe session created but URL is missing!")
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
    console.error("Error stack:", error.stack)
    return new Response(
      JSON.stringify({ error: error.message, stack: error.stack }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
})
