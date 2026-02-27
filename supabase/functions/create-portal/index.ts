// Supabase Edge Function: Create Stripe Customer Portal Session
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get("PROJECT_URL") || "https://ibipazkspglvzrdzngdo.supabase.co"
const supabaseServiceKey = Deno.env.get("SERVICE_ROLE_KEY") || ""
const appUrl = Deno.env.get("APP_URL") || "alfred://dashboard"

serve(async (req) => {
  console.log("=== PORTAL FUNCTION CALLED ===")
  console.log("Method:", req.method)
  console.log("URL:", req.url)
  
  try {
    // Get user ID from request body
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
    
    // Get user profile with Stripe customer ID
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
    
    if (!profile.stripe_customer_id) {
      console.error("User has no Stripe customer ID")
      return new Response(
        JSON.stringify({ error: "No subscription found", message: "You don't have an active subscription" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }
    
    console.log("Customer ID:", profile.stripe_customer_id)
    
    // Create Stripe Customer Portal session
    // The return_url is where Stripe redirects after the customer finishes in the portal
    // Since we can't use custom protocols, we'll use a generic URL and handle it via deep link
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: "https://example.com/portal-return", // Generic URL - we'll handle via deep link
    })
    
    console.log("Portal session created:", portalSession.id)
    console.log("Portal URL:", portalSession.url)
    
    if (!portalSession.url) {
      console.error("Portal session created but URL is missing!")
      return new Response(
        JSON.stringify({ error: "Portal session created but URL is missing" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }
    
    return new Response(
      JSON.stringify({ url: portalSession.url }),
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
