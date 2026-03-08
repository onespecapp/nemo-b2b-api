import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { postProcessTranscriptWithGemini } from "./transcriptPostprocess.js";
import { SipClient } from "livekit-server-sdk";
import Stripe from "stripe";
import { checkAndSendTrialEmails } from "./trialEmails.js";

dotenv.config();

const app = express();

const port = Number(process.env.PORT || 6001);
const telnyxApiKey = process.env.TELNYX_API_KEY || "";
const telnyxBaseUrl = process.env.TELNYX_BASE_URL || "https://api.telnyx.com/v2";
const telnyxConnectionId = process.env.TELNYX_CONNECTION_ID || "";
const telnyxOutboundFromNumber = process.env.TELNYX_TEST_FROM_NUMBER || "";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "";
const testCallWebhookUrl = process.env.TEST_CALL_WEBHOOK_URL || "";

const greetingText = process.env.GREETING_TEXT || "Hi, how are you?";
const greetingVoice = process.env.GREETING_VOICE || "female";
const greetingLanguage = process.env.GREETING_LANGUAGE || "en-US";

const geminiApiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const transcriptPostprocessModel = process.env.TRANSCRIPT_POSTPROCESS_MODEL || "gemini-2.5-flash";
const geminiSystemPrompt =
  process.env.GEMINI_SYSTEM_PROMPT ||
  "You are a warm, natural-sounding AI receptionist for a business.";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || "";
const defaultBusinessId = process.env.DEFAULT_BUSINESS_ID || "";
const internalApiToken = process.env.INTERNAL_API_TOKEN || "";

const testCallMaxPerMinute = Number.parseInt(process.env.TEST_CALL_RATE_LIMIT_PER_MINUTE || "5", 10);

const livekitUrl = process.env.LIVEKIT_URL || "";
const livekitApiKey = process.env.LIVEKIT_API_KEY || "";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET || "";
const livekitSipOutboundTrunkId = process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID || "";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripeStarterPriceId = process.env.STRIPE_STARTER_PRICE_ID || "";
const stripeProPriceId = process.env.STRIPE_PRO_PRICE_ID || "";
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";

const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

function stripePriceToTier(priceId) {
  if (priceId === stripeStarterPriceId) return "STARTER";
  if (priceId === stripeProPriceId) return "PRO";
  return "FREE";
}

function stripeStatusToSubscriptionStatus(status) {
  switch (status) {
    case "active": return "ACTIVE";
    case "trialing": return "TRIALING";
    case "past_due": return "PAST_DUE";
    case "canceled":
    case "unpaid": return "CANCELED";
    default: return "CANCELED";
  }
}

function isSubscriptionActive(business) {
  const status = business?.subscription_status;
  if (status === "ACTIVE") return true;
  if (status === "TRIALING") {
    const trialEnd = business?.trial_ends_at;
    if (!trialEnd) return true; // no expiry set = active trial
    return new Date(trialEnd) > new Date();
  }
  return false;
}

const supabaseAdmin =
  supabaseUrl && supabaseSecretKey
    ? createClient(supabaseUrl, supabaseSecretKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      })
    : null;

const rateLimitState = new Map();

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((value) => value.trim())
  : true;

app.use(
  cors({
    origin: corsOrigin,
    credentials: true
  })
);
// Stripe webhook must be registered BEFORE express.json() — requires raw body for signature verification
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) {
    res.status(500).json({ error: "stripe_not_configured" });
    return;
  }

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    log("stripe_webhook_signature_failed", { message: err.message });
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  const admin = requireSupabase();

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const businessId = session.metadata?.business_id;
        if (!businessId || !session.subscription) break;

        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = subscription.items.data[0]?.price?.id;
        const tier = stripePriceToTier(priceId);
        const status = stripeStatusToSubscriptionStatus(subscription.status);

        const { error } = await admin
          .from("b2b_businesses")
          .update({
            stripe_customer_id: session.customer,
            subscription_tier: tier,
            subscription_status: status,
            trial_ends_at: null,
          })
          .eq("id", businessId);

        if (error) {
          log("stripe_webhook_db_error", { event: event.type, message: error.message });
        } else {
          log("stripe_checkout_completed", { businessId, tier, status });
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const priceId = subscription.items.data[0]?.price?.id;
        const tier = stripePriceToTier(priceId);
        const status = stripeStatusToSubscriptionStatus(subscription.status);

        const { error } = await admin
          .from("b2b_businesses")
          .update({
            subscription_tier: tier,
            subscription_status: status,
          })
          .eq("stripe_customer_id", customerId);

        if (error) {
          log("stripe_webhook_db_error", { event: event.type, message: error.message });
        } else {
          log("stripe_subscription_updated", { customerId, tier, status });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const { error } = await admin
          .from("b2b_businesses")
          .update({
            subscription_tier: "FREE",
            subscription_status: "CANCELED",
          })
          .eq("stripe_customer_id", customerId);

        if (error) {
          log("stripe_webhook_db_error", { event: event.type, message: error.message });
        } else {
          log("stripe_subscription_deleted", { customerId });
        }
        break;
      }
    }
  } catch (err) {
    log("stripe_webhook_handler_error", { event: event.type, message: err.message });
    res.status(500).json({ error: "webhook_handler_failed" });
    return;
  }

  res.json({ received: true });
});

app.use(express.json({ limit: "1mb" }));

function log(event, details = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...details
    })
  );
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return "";
  }
  return header.slice("Bearer ".length).trim();
}

function isValidE164(value) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

function normalizePhone(rawValue) {
  if (!rawValue || typeof rawValue !== "string") {
    return "";
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    const value = `+${digits}`;
    return isValidE164(value) ? value : "";
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  return "";
}

function candidatePhoneValues(rawValue) {
  const values = new Set();
  const normalized = normalizePhone(rawValue);
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";

  if (raw) {
    values.add(raw);
    values.add(raw.replace(/[\s\-().]/g, ""));
  }
  if (normalized) {
    values.add(normalized);
    values.add(normalized.replace(/^\+/, ""));
  }

  return Array.from(values).filter(Boolean);
}

function sanitizeTranscriptEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map((entry) => {
      const role =
        entry?.role === "assistant" || entry?.role === "system" || entry?.role === "user"
          ? entry.role
          : "user";
      const content = typeof entry?.content === "string" ? entry.content.trim() : "";
      if (!content) {
        return null;
      }
      const at = typeof entry?.at === "string" && entry.at.trim() ? entry.at.trim() : new Date().toISOString();

      return {
        role,
        content: content.slice(0, 4000),
        at
      };
    })
    .filter(Boolean);
}

function sanitizeCallQualityPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const sanitized = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!key || typeof key !== "string") {
      continue;
    }

    if (typeof raw === "boolean") {
      sanitized[key.slice(0, 64)] = raw;
      continue;
    }

    if (typeof raw === "number" && Number.isFinite(raw)) {
      sanitized[key.slice(0, 64)] = Math.round(raw);
      continue;
    }

    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) {
        sanitized[key.slice(0, 64)] = trimmed.slice(0, 200);
      }
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function buildSummaryFromTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return null;
  }

  const userLast = [...transcript].reverse().find((item) => item?.role === "user" && item?.content);
  const assistantLast = [...transcript]
    .reverse()
    .find((item) => item?.role === "assistant" && item?.content);

  if (!userLast && !assistantLast) {
    return null;
  }

  if (userLast && assistantLast) {
    return `Caller: ${userLast.content.slice(0, 160)} | Agent: ${assistantLast.content.slice(0, 160)}`;
  }

  if (userLast) {
    return `Caller said: ${userLast.content.slice(0, 220)}`;
  }

  return `Agent said: ${assistantLast.content.slice(0, 220)}`;
}

function inferMessageFromTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return null;
  }

  const lastUser = [...transcript].reverse().find((item) => item?.role === "user" && item?.content);
  if (!lastUser) {
    return null;
  }

  const text = lastUser.content;
  const likelyMessage = /(message|call(?:\s+me)?\s?back|callback|reach me|let .* know|contact me)/i.test(text);
  if (!likelyMessage) {
    return null;
  }

  return {
    message: text.slice(0, 2000),
    reason: "Caller requested follow-up",
    urgency: /urgent|asap|immediately|emergency/i.test(text) ? "urgent" : "normal"
  };
}

function trackRateLimit(key, windowMs, limit) {
  const now = Date.now();
  const current = rateLimitState.get(key) || [];
  const recent = current.filter((value) => now - value < windowMs);
  if (recent.length >= limit) {
    rateLimitState.set(key, recent);
    return false;
  }
  recent.push(now);
  rateLimitState.set(key, recent);
  return true;
}

function extractCallControlId(body) {
  return (
    body?.data?.payload?.call_control_id ||
    body?.data?.call_control_id ||
    body?.payload?.call_control_id ||
    body?.call_control_id ||
    ""
  );
}

function extractEventType(body) {
  return body?.data?.event_type || body?.event_type || "";
}

function extractCallerNumber(body) {
  return (
    body?.data?.payload?.from ||
    body?.data?.payload?.from_number ||
    body?.data?.payload?.caller_id_number ||
    "unknown caller"
  );
}

function extractGeminiText(responseData) {
  const parts = responseData?.candidates?.[0]?.content?.parts || [];
  const firstTextPart = parts.find((part) => typeof part?.text === "string");
  return (firstTextPart?.text || "").trim();
}

async function buildGeminiGreeting(callerNumber) {
  if (!geminiApiKey) {
    return { text: greetingText, source: "static" };
  }

  const prompt = [
    geminiSystemPrompt,
    `The caller number is: ${callerNumber}.`,
    "Respond with exactly one short greeting sentence suitable for voice.",
    "Keep it under 12 words and avoid emojis."
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    geminiModel
  )}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

  try {
    const response = await axios.post(
      url,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 60
        }
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 8000
      }
    );

    const geminiText = extractGeminiText(response.data);
    if (geminiText) {
      return { text: geminiText, source: "gemini" };
    }
    return { text: greetingText, source: "gemini_empty_fallback" };
  } catch (error) {
    log("gemini_greeting_failed", {
      status: error?.response?.status,
      details: error?.response?.data || error?.message
    });
    return { text: greetingText, source: "gemini_error_fallback" };
  }
}

function extractTelnyxCallId(responseData) {
  return (
    responseData?.data?.call_control_id ||
    responseData?.data?.call_leg_id ||
    responseData?.data?.id ||
    responseData?.call_control_id ||
    ""
  );
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "";
}

function isLocalIp(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function requireSupabase() {
  if (!supabaseAdmin) {
    throw new Error("Supabase admin client is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY.");
  }
  return supabaseAdmin;
}

async function requireAuth(req, res, next) {
  try {
    const admin = requireSupabase();
    const accessToken = getBearerToken(req);
    if (!accessToken) {
      res.status(401).json({ error: "missing_bearer_token" });
      return;
    }

    const { data, error } = await admin.auth.getUser(accessToken);
    if (error || !data?.user) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }

    req.auth = {
      accessToken,
      user: data.user
    };

    next();
  } catch (error) {
    log("auth_middleware_failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "auth_middleware_failed", message: error?.message || "unknown_error" });
  }
}

function requireInternalAuth(req, res, next) {
  if (internalApiToken) {
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || provided !== internalApiToken) {
      res.status(401).json({ error: "invalid_internal_token" });
      return;
    }
    next();
    return;
  }

  const ip = getClientIp(req);
  if (!isLocalIp(ip)) {
    res.status(401).json({ error: "internal_token_required" });
    return;
  }

  next();
}

async function findBusinessForOwner(admin, ownerId, businessId) {
  let query = admin.from("b2b_businesses").select("id, owner_id, name").eq("owner_id", ownerId);

  if (businessId) {
    query = query.eq("id", businessId);
  }

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) {
    throw new Error(`business_lookup_failed: ${error.message}`);
  }

  return data || null;
}

async function resolveBusinessForCall(admin, payload) {
  console.log("[resolveBusinessForCall] payload.business_id:", payload.business_id, "payload.called_phone:", payload.called_phone);
  if (payload.business_id) {
    const { data, error } = await admin
      .from("b2b_businesses")
      .select("id, name, category, voice_preference, telnyx_phone_number, agent_config, transfer_phone, subscription_status, trial_ends_at")
      .eq("id", payload.business_id)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`business_lookup_failed: ${error.message}`);
    }

    if (data) {
      return data;
    }
  }

  const calledCandidates = candidatePhoneValues(payload.called_phone);
  console.log("[resolveBusinessForCall] calledCandidates:", calledCandidates);
  if (calledCandidates.length > 0) {
    const { data, error } = await admin
      .from("b2b_businesses")
      .select("id, name, category, voice_preference, telnyx_phone_number, agent_config, transfer_phone, subscription_status, trial_ends_at")
      .in("telnyx_phone_number", calledCandidates)
      .limit(1);

    if (error) {
      throw new Error(`business_lookup_by_phone_failed: ${error.message}`);
    }

    console.log("[resolveBusinessForCall] phone lookup result:", data?.length, data?.[0]?.name);
    if (data && data.length > 0) {
      return data[0];
    }
  }

  console.log("[resolveBusinessForCall] phone lookup missed, falling back. DEFAULT_BUSINESS_ID:", defaultBusinessId);
  if (defaultBusinessId) {
    const { data, error } = await admin
      .from("b2b_businesses")
      .select("id, name, category, voice_preference, telnyx_phone_number, agent_config, transfer_phone, subscription_status, trial_ends_at")
      .eq("id", defaultBusinessId)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`default_business_lookup_failed: ${error.message}`);
    }

    if (data) {
      return data;
    }
  }

  const { data, error } = await admin
    .from("b2b_businesses")
    .select("id, name, category, voice_preference, telnyx_phone_number, agent_config, transfer_phone, subscription_status, trial_ends_at")
    .order("created_at", { ascending: true })
    .limit(2);

  if (error) {
    throw new Error(`fallback_business_lookup_failed: ${error.message}`);
  }

  if (data && data.length === 1) {
    return data[0];
  }

  return null;
}

async function findOrCreateCustomer(admin, businessId, callerPhone, callerName) {
  const phoneCandidates = candidatePhoneValues(callerPhone);
  if (phoneCandidates.length === 0) {
    return null;
  }

  const { data: existing, error: fetchError } = await admin
    .from("b2b_customers")
    .select("id, name, phone")
    .eq("business_id", businessId)
    .in("phone", phoneCandidates)
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`customer_lookup_failed: ${fetchError.message}`);
  }

  if (existing) {
    return existing;
  }

  const normalized = normalizePhone(callerPhone) || phoneCandidates[0];
  const suffix = normalized.slice(-4);
  const fallbackName = suffix ? `Caller ${suffix}` : "Unknown Caller";

  const { data: inserted, error: insertError } = await admin
    .from("b2b_customers")
    .insert({
      business_id: businessId,
      name: (callerName || "").trim() || fallbackName,
      phone: normalized
    })
    .select("id, name, phone")
    .single();

  if (insertError) {
    throw new Error(`customer_create_failed: ${insertError.message}`);
  }

  return inserted;
}

async function findExistingCallLog(admin, businessId, telnyxCallId, roomName) {
  if (telnyxCallId) {
    const { data, error } = await admin
      .from("b2b_call_logs")
      .select("id")
      .eq("business_id", businessId)
      .eq("telnyx_call_id", telnyxCallId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`call_log_lookup_failed: ${error.message}`);
    }

    if (data) {
      return data;
    }
  }

  if (roomName && roomName !== "unknown") {
    const { data, error } = await admin
      .from("b2b_call_logs")
      .select("id")
      .eq("business_id", businessId)
      .eq("room_name", roomName)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`call_log_lookup_failed: ${error.message}`);
    }

    if (data) {
      return data;
    }
  }

  return null;
}

async function appendTranscriptByCallLogId(admin, callLogId, newEntries) {
  const entries = sanitizeTranscriptEntries(newEntries);
  if (entries.length === 0) {
    const { data, error } = await admin
      .from("b2b_call_logs")
      .select("id, transcript")
      .eq("id", callLogId)
      .maybeSingle();

    if (error) {
      throw new Error(`call_log_fetch_failed: ${error.message}`);
    }

    return Array.isArray(data?.transcript) ? data.transcript : [];
  }

  const { data: existing, error: fetchError } = await admin
    .from("b2b_call_logs")
    .select("id, transcript")
    .eq("id", callLogId)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`call_log_fetch_failed: ${fetchError.message}`);
  }

  if (!existing) {
    throw new Error("call_log_not_found");
  }

  const transcript = Array.isArray(existing.transcript) ? existing.transcript : [];
  const merged = transcript.concat(entries).slice(-1000);

  const { error: updateError } = await admin
    .from("b2b_call_logs")
    .update({ transcript: merged })
    .eq("id", callLogId);

  if (updateError) {
    throw new Error(`call_log_transcript_update_failed: ${updateError.message}`);
  }

  return merged;
}

async function sendTelnyxCommand(callControlId, action, payload = {}) {
  if (!telnyxApiKey) {
    throw new Error("TELNYX_API_KEY is not set");
  }

  const url = `${telnyxBaseUrl}/calls/${callControlId}/actions/${action}`;
  await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${telnyxApiKey}`,
      "Content-Type": "application/json"
    }
  });
}

async function sendSmsNotification(toNumber, text, fromNumber) {
  const smsFromNumber = fromNumber || process.env.TELNYX_SMS_FROM_NUMBER;
  if (!telnyxApiKey) {
    log("sms_skip", { reason: "TELNYX_API_KEY not set" });
    return;
  }
  if (!smsFromNumber) {
    log("sms_skip", { reason: "TELNYX_SMS_FROM_NUMBER not set" });
    return;
  }
  if (!toNumber) {
    log("sms_skip", { reason: "missing to number" });
    return;
  }
  try {
    const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID || "";
    const payload = {
      from: smsFromNumber,
      to: toNumber,
      text: text.slice(0, 1600),
    };
    if (messagingProfileId) {
      payload.messaging_profile_id = messagingProfileId;
    }
    await axios.post(`${telnyxBaseUrl}/messages`, payload, {
      headers: {
        Authorization: `Bearer ${telnyxApiKey}`,
        "Content-Type": "application/json",
      },
    });
    log("sms_sent", { from: smsFromNumber, to: toNumber });
  } catch (err) {
    log("sms_send_failed", { from: smsFromNumber, to: toNumber, error: err?.response?.data || err.message });
  }
}

async function telnyxWebhookHandler(req, res) {
  const eventType = extractEventType(req.body);
  const callControlId = extractCallControlId(req.body);
  const callerNumber = extractCallerNumber(req.body);

  log("telnyx_webhook_received", {
    eventType: eventType || "unknown_event_type",
    callControlId: callControlId || "missing"
  });

  if (!callControlId) {
    res.status(200).json({ ok: true, ignored: "missing_call_control_id" });
    return;
  }

  try {
    if (eventType === "call.initiated") {
      await sendTelnyxCommand(callControlId, "answer");
      res.status(200).json({ ok: true, action: "answer" });
      return;
    }

    if (eventType === "call.answered") {
      const greeting = await buildGeminiGreeting(callerNumber);
      await sendTelnyxCommand(callControlId, "speak", {
        payload: greeting.text,
        voice: greetingVoice,
        language: greetingLanguage
      });
      res.status(200).json({ ok: true, action: "speak", source: greeting.source });
      return;
    }

    res.status(200).json({ ok: true, ignored: eventType || "unknown_event_type" });
  } catch (error) {
    log("telnyx_command_failed", {
      eventType,
      callControlId,
      status: error?.response?.status,
      details: error?.response?.data || error?.message
    });
    res.status(200).json({ ok: false, error: "telnyx_command_failed" });
  }
}

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    geminiEnabled: Boolean(geminiApiKey),
    supabaseEnabled: Boolean(supabaseAdmin),
    telnyxEnabled: Boolean(telnyxApiKey)
  });
});

app.post("/api/test-call", requireAuth, async (req, res) => {
  try {
    const admin = requireSupabase();

    const userId = req.auth.user.id;
    const allowed = trackRateLimit(`test_call:${userId}`, 60_000, Number.isInteger(testCallMaxPerMinute) ? testCallMaxPerMinute : 5);
    if (!allowed) {
      res.status(429).json({ error: "rate_limited", message: "Too many test calls. Try again in a minute." });
      return;
    }

    const phone = normalizePhone(typeof req.body?.phone === "string" ? req.body.phone : "");
    const businessId = typeof req.body?.business_id === "string" ? req.body.business_id.trim() : "";
    const voicePreference = typeof req.body?.voice_preference === "string" ? req.body.voice_preference.trim() : "";

    if (!isValidE164(phone)) {
      res.status(400).json({ error: "invalid_phone", message: "Phone must be E.164 format." });
      return;
    }

    const business = await findBusinessForOwner(admin, userId, businessId);
    if (!business) {
      res.status(403).json({ error: "business_access_denied" });
      return;
    }

    // Check subscription is active before allowing test calls
    const { data: bizSub } = await admin
      .from("b2b_businesses")
      .select("subscription_status, trial_ends_at")
      .eq("id", business.id)
      .single();

    if (!isSubscriptionActive(bizSub || business)) {
      res.status(403).json({ error: "subscription_inactive", message: "Your subscription is not active. Please subscribe to make test calls." });
      return;
    }

    const customer = await findOrCreateCustomer(admin, business.id, phone, "Test Recipient");

    const { data: callLog, error: callLogError } = await admin
      .from("b2b_call_logs")
      .insert({
        business_id: business.id,
        customer_id: customer?.id || null,
        call_type: "TEST",
        call_outcome: null,
        summary: `Test call requested${voicePreference ? ` (voice: ${voicePreference})` : ""}`,
        transcript: []
      })
      .select("id")
      .single();

    if (callLogError || !callLog) {
      throw new Error(`test_call_log_insert_failed: ${callLogError?.message || "unknown"}`);
    }

    if (!telnyxApiKey || !telnyxConnectionId || !telnyxOutboundFromNumber) {
      await admin
        .from("b2b_call_logs")
        .update({
          call_outcome: "ANSWERED",
          summary:
            "Test call logged (outbound provider is not fully configured: set TELNYX_CONNECTION_ID and TELNYX_TEST_FROM_NUMBER)."
        })
        .eq("id", callLog.id);

      res.status(200).json({
        success: true,
        simulated: true,
        call_log_id: callLog.id,
        message: "Test call logged. Outbound provider config is missing, so no real call was placed."
      });
      return;
    }

    const outboundWebhookUrl =
      testCallWebhookUrl || (publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/webhooks/telnyx/voice` : "");

    const clientStatePayload = Buffer.from(
      JSON.stringify({
        business_id: business.id,
        call_log_id: callLog.id,
        voice_preference: voicePreference || null,
        requested_by_user_id: userId
      })
    ).toString("base64");

    const telnyxResponse = await axios.post(
      `${telnyxBaseUrl}/calls`,
      {
        connection_id: telnyxConnectionId,
        to: phone,
        from: telnyxOutboundFromNumber,
        webhook_url: outboundWebhookUrl || undefined,
        webhook_url_method: outboundWebhookUrl ? "POST" : undefined,
        client_state: clientStatePayload
      },
      {
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          "Content-Type": "application/json"
        },
        timeout: 10_000
      }
    );

    const telnyxCallId = extractTelnyxCallId(telnyxResponse.data) || null;

    await admin
      .from("b2b_call_logs")
      .update({
        telnyx_call_id: telnyxCallId,
        summary: `Test call initiated${voicePreference ? ` with voice ${voicePreference}` : ""}`
      })
      .eq("id", callLog.id);

    log("test_call_initiated", {
      userId,
      businessId: business.id,
      phone,
      callLogId: callLog.id,
      telnyxCallId: telnyxCallId || "unknown"
    });

    res.status(200).json({
      success: true,
      call_log_id: callLog.id,
      telnyx_call_id: telnyxCallId || null
    });
  } catch (error) {
    log("test_call_failed", {
      message: error?.message || String(error),
      details: error?.response?.data || null
    });
    res.status(500).json({ error: "test_call_failed", message: error?.message || "unknown_error" });
  }
});

app.post("/internal/calls/start", requireInternalAuth, async (req, res) => {
  try {
    const admin = requireSupabase();

    const payload = {
      business_id: typeof req.body?.business_id === "string" ? req.body.business_id.trim() : "",
      room_name: typeof req.body?.room_name === "string" ? req.body.room_name.trim() : "",
      telnyx_call_id: typeof req.body?.telnyx_call_id === "string" ? req.body.telnyx_call_id.trim() : "",
      caller_phone: typeof req.body?.caller_phone === "string" ? req.body.caller_phone.trim() : "",
      caller_name: typeof req.body?.caller_name === "string" ? req.body.caller_name.trim() : "",
      called_phone: typeof req.body?.called_phone === "string" ? req.body.called_phone.trim() : "",
      call_type: typeof req.body?.call_type === "string" ? req.body.call_type.trim().toUpperCase() : "INBOUND"
    };

    const business = await resolveBusinessForCall(admin, payload);
    if (!business) {
      res.status(400).json({
        error: "business_not_found",
        message:
          "Could not resolve business_id. Provide business_id, map called_phone to b2b_businesses.telnyx_phone_number, or set DEFAULT_BUSINESS_ID."
      });
      return;
    }

    if (!isSubscriptionActive(business)) {
      log("call_blocked_inactive_subscription", {
        businessId: business.id,
        status: business.subscription_status,
        trialEndsAt: business.trial_ends_at || null
      });
      res.status(200).json({
        success: true,
        active: false,
        business_id: business.id,
        reason: "subscription_inactive"
      });
      return;
    }

    const customer = await findOrCreateCustomer(admin, business.id, payload.caller_phone, payload.caller_name);

    const existing = await findExistingCallLog(admin, business.id, payload.telnyx_call_id, payload.room_name);
    if (existing) {
      res.status(200).json({
        success: true,
        active: true,
        call_log_id: existing.id,
        business_id: business.id,
        business_name: business.name || null,
        business_category: business.category || null,
        voice_preference: business.voice_preference || null,
        agent_config: business.agent_config || {},
        transfer_phone: business.transfer_phone || null,
        customer_id: customer?.id || null,
        reused: true
      });
      return;
    }

    const { data: inserted, error: insertError } = await admin
      .from("b2b_call_logs")
      .insert({
        business_id: business.id,
        customer_id: customer?.id || null,
        call_type: payload.call_type || "INBOUND",
        room_name: payload.room_name || null,
        telnyx_call_id: payload.telnyx_call_id || null,
        call_outcome: null,
        transcript: []
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      throw new Error(`call_log_insert_failed: ${insertError?.message || "unknown"}`);
    }

    res.status(200).json({
      success: true,
      active: true,
      call_log_id: inserted.id,
      business_id: business.id,
      business_name: business.name || null,
      business_category: business.category || null,
      voice_preference: business.voice_preference || null,
      agent_config: business.agent_config || {},
      transfer_phone: business.transfer_phone || null,
      customer_id: customer?.id || null,
      reused: false
    });
  } catch (error) {
    log("internal_call_start_failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "internal_call_start_failed", message: error?.message || "unknown_error" });
  }
});

app.post("/internal/calls/transcript", requireInternalAuth, async (req, res) => {
  try {
    const admin = requireSupabase();
    const callLogId = typeof req.body?.call_log_id === "string" ? req.body.call_log_id.trim() : "";

    if (!callLogId) {
      res.status(400).json({ error: "missing_call_log_id" });
      return;
    }

    const merged = await appendTranscriptByCallLogId(admin, callLogId, req.body?.entries);

    res.status(200).json({ success: true, call_log_id: callLogId, transcript_count: merged.length });
  } catch (error) {
    log("internal_call_transcript_failed", { message: error?.message || String(error) });
    res
      .status(500)
      .json({ error: "internal_call_transcript_failed", message: error?.message || "unknown_error" });
  }
});

app.post("/internal/calls/end", requireInternalAuth, async (req, res) => {
  try {
    const admin = requireSupabase();
    const callLogId = typeof req.body?.call_log_id === "string" ? req.body.call_log_id.trim() : "";
    if (!callLogId) {
      res.status(400).json({ error: "missing_call_log_id" });
      return;
    }

    const { data: callLog, error: callLogError } = await admin
      .from("b2b_call_logs")
      .select("id, business_id, customer_id, transcript")
      .eq("id", callLogId)
      .maybeSingle();

    if (callLogError) {
      throw new Error(`call_log_lookup_failed: ${callLogError.message}`);
    }

    if (!callLog) {
      res.status(404).json({ error: "call_log_not_found" });
      return;
    }

    const mergedTranscript = await appendTranscriptByCallLogId(admin, callLogId, req.body?.transcript_entries);
    const providedSummary = typeof req.body?.summary === "string" ? req.body.summary.trim() : "";
    const qualityPayload = sanitizeCallQualityPayload(req.body?.quality);

    let customerName = "";
    let customerPhone = "";
    if (callLog.customer_id) {
      const { data: customerData } = await admin
        .from("b2b_customers")
        .select("name, phone")
        .eq("id", callLog.customer_id)
        .maybeSingle();

      customerName = customerData?.name || "";
      customerPhone = customerData?.phone || "";
    }

    const { data: businessData } = await admin
      .from("b2b_businesses")
      .select("name, category, telnyx_phone_number, transfer_phone, agent_config")
      .eq("id", callLog.business_id)
      .maybeSingle();

    const geminiTranscriptPostprocess = await postProcessTranscriptWithGemini({
      apiKey: geminiApiKey,
      model: transcriptPostprocessModel,
      transcript: mergedTranscript,
      businessName: businessData?.name || "",
      businessCategory: businessData?.category || "",
      callerName: customerName,
      callerPhone: customerPhone,
      timeoutMs: 9000
    });

    const derivedSummary = buildSummaryFromTranscript(mergedTranscript);

    const durationRaw = req.body?.duration_sec;
    const durationSec = Number.isFinite(Number(durationRaw)) ? Math.max(0, Number.parseInt(String(durationRaw), 10)) : null;

    const outcomeRaw = typeof req.body?.call_outcome === "string" ? req.body.call_outcome.trim().toUpperCase() : "";
    const callOutcome = outcomeRaw || geminiTranscriptPostprocess?.callOutcome || "ANSWERED";

    const { error: updateError } = await admin
      .from("b2b_call_logs")
      .update({
        duration_sec: durationSec,
        call_outcome: callOutcome,
        summary: geminiTranscriptPostprocess?.summary || providedSummary || derivedSummary || null,
        transcript: mergedTranscript
      })
      .eq("id", callLogId);

    if (updateError) {
      throw new Error(`call_log_finalize_failed: ${updateError.message}`);
    }

    let messagePayload = req.body?.message;
    if (!messagePayload) {
      messagePayload = geminiTranscriptPostprocess?.message || inferMessageFromTranscript(mergedTranscript);
    }

    if (messagePayload && typeof messagePayload === "object") {
      let callerPhone = typeof messagePayload.caller_phone === "string" ? messagePayload.caller_phone.trim() : "";
      let callerName = typeof messagePayload.caller_name === "string" ? messagePayload.caller_name.trim() : "";

      if (!callerPhone) {
        callerPhone = customerPhone;
      }
      if (!callerName) {
        callerName = customerName;
      }

      const messageText = typeof messagePayload.message === "string" ? messagePayload.message.trim() : "";
      if (messageText) {
        const urgencyRaw = typeof messagePayload.urgency === "string" ? messagePayload.urgency.trim().toLowerCase() : "normal";
        const urgency = urgencyRaw === "urgent" ? "urgent" : "normal";

        const { error: messageError } = await admin.from("b2b_messages").insert({
          business_id: callLog.business_id,
          caller_name: callerName || null,
          caller_phone: callerPhone || null,
          message: messageText,
          reason: typeof messagePayload.reason === "string" ? messagePayload.reason.trim() : null,
          urgency,
          read: false
        });

        if (messageError) {
          log("message_insert_failed", { callLogId, message: messageError.message });
        }
      }
    }

    // Send post-call SMS notifications
    const agentConfig = businessData?.agent_config || {};

    // Owner SMS: call summary to transfer_phone
    if (agentConfig.smsNotifyOwner && businessData?.transfer_phone && businessData?.telnyx_phone_number) {
      const summary = geminiTranscriptPostprocess?.summary || providedSummary || derivedSummary || "No summary available";
      const callerInfo = customerName || customerPhone || "Unknown caller";
      const durationMin = durationSec ? `${Math.ceil(durationSec / 60)} min` : "";
      const smsBody = `Call from ${callerInfo}${durationMin ? ` (${durationMin})` : ""}\n${summary}`;
      sendSmsNotification(businessData.transfer_phone, smsBody, businessData.telnyx_phone_number);
    }

    // Customer SMS: thank-you text to caller from the business's number
    if (agentConfig.smsNotifyCustomer && customerPhone && businessData?.telnyx_phone_number) {
      const bizName = businessData.name || "us";
      const customerSmsBody = `Thanks for calling ${bizName}! We've noted your inquiry and our team will follow up shortly.`;
      sendSmsNotification(customerPhone, customerSmsBody, businessData.telnyx_phone_number);
    }

    if (qualityPayload) {
      log("internal_call_quality", { callLogId, quality: qualityPayload });
    }

    res.status(200).json({ success: true, call_log_id: callLogId, quality: qualityPayload });
  } catch (error) {
    log("internal_call_end_failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "internal_call_end_failed", message: error?.message || "unknown_error" });
  }
});

app.post("/internal/calls/transfer", requireInternalAuth, async (req, res) => {
  try {
    const admin = requireSupabase();
    const roomName = typeof req.body?.room_name === "string" ? req.body.room_name.trim() : "";
    const businessId = typeof req.body?.business_id === "string" ? req.body.business_id.trim() : "";
    const callLogId = typeof req.body?.call_log_id === "string" ? req.body.call_log_id.trim() : "";

    if (!roomName || !businessId) {
      res.status(400).json({ error: "missing_room_name_or_business_id" });
      return;
    }

    const { data: business, error: bizError } = await admin
      .from("b2b_businesses")
      .select("transfer_phone")
      .eq("id", businessId)
      .maybeSingle();

    if (bizError) {
      throw new Error(`business_lookup_failed: ${bizError.message}`);
    }

    if (!business?.transfer_phone) {
      res.status(400).json({ error: "no_transfer_phone", message: "Business does not have a transfer phone number configured." });
      return;
    }

    if (!livekitUrl || !livekitApiKey || !livekitApiSecret || !livekitSipOutboundTrunkId) {
      const missing = [
        !livekitUrl && "LIVEKIT_URL",
        !livekitApiKey && "LIVEKIT_API_KEY",
        !livekitApiSecret && "LIVEKIT_API_SECRET",
        !livekitSipOutboundTrunkId && "LIVEKIT_SIP_OUTBOUND_TRUNK_ID",
      ].filter(Boolean).join(", ");
      throw new Error(`Missing LiveKit SIP env vars: ${missing}`);
    }

    const sipClient = new SipClient(livekitUrl, livekitApiKey, livekitApiSecret);

    // Fire-and-forget: don't block on the human answering.
    // The agent will detect the new participant joining the room.
    sipClient.createSipParticipant(
      livekitSipOutboundTrunkId,
      business.transfer_phone,
      roomName,
      { participantName: "Human Staff", playDialtone: false, playRingtone: false }
    ).catch((err) => {
      log("sip_transfer_dial_failed", { callLogId, businessId, roomName, message: err?.message || String(err) });
    });

    log("call_transfer_initiated", { callLogId, businessId, roomName, transferPhone: business.transfer_phone });
    res.status(200).json({ success: true });
  } catch (error) {
    log("internal_call_transfer_failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "internal_call_transfer_failed", message: error?.message || "unknown_error" });
  }
});

app.post("/api/outbound-call", requireAuth, async (req, res) => {
  try {
    const admin = requireSupabase();
    const userId = req.auth.user.id;

    const allowed = trackRateLimit(`outbound_call:${userId}`, 60_000, 5);
    if (!allowed) {
      res.status(429).json({ error: "rate_limited", message: "Too many outbound calls. Try again in a minute." });
      return;
    }

    const phone = normalizePhone(typeof req.body?.phone === "string" ? req.body.phone : "");
    const businessId = typeof req.body?.business_id === "string" ? req.body.business_id.trim() : "";
    const callPurpose = typeof req.body?.call_purpose === "string" ? req.body.call_purpose.trim() : "follow_up";
    const customerName = typeof req.body?.customer_name === "string" ? req.body.customer_name.trim() : "";
    const context = typeof req.body?.context === "string" ? req.body.context.trim() : "";

    if (!isValidE164(phone)) {
      res.status(400).json({ error: "invalid_phone", message: "Phone must be E.164 format." });
      return;
    }

    const business = await findBusinessForOwner(admin, userId, businessId);
    if (!business) {
      res.status(403).json({ error: "business_access_denied" });
      return;
    }

    if (!livekitUrl || !livekitApiKey || !livekitApiSecret || !livekitSipOutboundTrunkId) {
      res.status(503).json({
        error: "outbound_not_configured",
        message: "Outbound calling is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_SIP_OUTBOUND_TRUNK_ID."
      });
      return;
    }

    const customer = await findOrCreateCustomer(admin, business.id, phone, customerName);

    const { data: callLog, error: callLogError } = await admin
      .from("b2b_call_logs")
      .insert({
        business_id: business.id,
        customer_id: customer?.id || null,
        call_type: "FOLLOW_UP",
        call_outcome: null,
        summary: `Outbound ${callPurpose} call to ${customerName || phone}`,
        transcript: []
      })
      .select("id")
      .single();

    if (callLogError || !callLog) {
      throw new Error(`outbound_call_log_insert_failed: ${callLogError?.message || "unknown"}`);
    }

    const roomName = `outbound-${callLog.id}`;
    const sipClient = new SipClient(livekitUrl, livekitApiKey, livekitApiSecret);

    await sipClient.createSipParticipant(
      livekitSipOutboundTrunkId,
      phone,
      roomName,
      {
        participantName: customerName || `Caller ${phone.slice(-4)}`,
        participantAttributes: {
          "sip.phoneNumber": phone,
          "call_direction": "outbound",
          "call_purpose": callPurpose,
          "customer_name": customerName,
          "context": context,
          "business_id": business.id,
          "call_log_id": callLog.id
        }
      }
    );

    await admin
      .from("b2b_call_logs")
      .update({ room_name: roomName })
      .eq("id", callLog.id);

    log("outbound_call_initiated", {
      userId,
      businessId: business.id,
      phone,
      callLogId: callLog.id,
      roomName,
      callPurpose
    });

    res.status(200).json({
      success: true,
      call_log_id: callLog.id,
      room_name: roomName
    });
  } catch (error) {
    log("outbound_call_failed", {
      message: error?.message || String(error),
      details: error?.response?.data || null
    });
    res.status(500).json({ error: "outbound_call_failed", message: error?.message || "unknown_error" });
  }
});

app.post("/internal/appointments/availability", requireInternalAuth, async (req, res) => {
  try {
    const admin = requireSupabase();
    const businessId = typeof req.body?.business_id === "string" ? req.body.business_id.trim() : "";
    const dateStr = typeof req.body?.date === "string" ? req.body.date.trim() : "";

    if (!businessId) {
      res.status(400).json({ error: "missing_business_id" });
      return;
    }

    if (!dateStr) {
      res.status(400).json({ error: "missing_date" });
      return;
    }

    const { data: business, error: bizError } = await admin
      .from("b2b_businesses")
      .select("id, business_hours, default_appointment_duration, timezone")
      .eq("id", businessId)
      .maybeSingle();

    if (bizError) {
      throw new Error(`business_lookup_failed: ${bizError.message}`);
    }
    if (!business) {
      res.status(404).json({ error: "business_not_found" });
      return;
    }

    const tz = business.timezone || "America/Los_Angeles";
    const requestDate = new Date(dateStr + "T00:00:00");
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const dayName = dayNames[requestDate.getDay()];

    let hours = null;
    if (business.business_hours && typeof business.business_hours === "object") {
      hours = business.business_hours[dayName] || null;
    }

    if (!hours || hours.closed) {
      res.status(200).json({
        available_slots: [],
        business_hours: "Closed",
        message: `Business is closed on ${dayName}.`
      });
      return;
    }

    const openHour = parseInt(hours.open?.split(":")[0] || "9", 10);
    const openMin = parseInt(hours.open?.split(":")[1] || "0", 10);
    const closeHour = parseInt(hours.close?.split(":")[0] || "17", 10);
    const closeMin = parseInt(hours.close?.split(":")[1] || "0", 10);
    const slotDuration = business.default_appointment_duration || 60;

    const { data: existingAppts } = await admin
      .from("b2b_appointments")
      .select("scheduled_at")
      .eq("business_id", businessId)
      .in("status", ["SCHEDULED", "CONFIRMED"])
      .gte("scheduled_at", dateStr + "T00:00:00")
      .lt("scheduled_at", dateStr + "T23:59:59");

    const bookedTimes = new Set(
      (existingAppts || []).map((a) => {
        const d = new Date(a.scheduled_at);
        return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      })
    );

    const slots = [];
    let h = openHour;
    let m = openMin;
    while (h < closeHour || (h === closeHour && m < closeMin)) {
      const timeKey = `${h}:${String(m).padStart(2, "0")}`;
      if (!bookedTimes.has(timeKey)) {
        const startStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        const endM = m + slotDuration;
        const endH = h + Math.floor(endM / 60);
        const endMm = endM % 60;
        const endStr = `${String(endH).padStart(2, "0")}:${String(endMm).padStart(2, "0")}`;
        slots.push({ start: startStr, end: endStr });
      }
      m += slotDuration;
      if (m >= 60) {
        h += Math.floor(m / 60);
        m = m % 60;
      }
    }

    const formatTime12 = (hh, mm) => {
      const ampm = hh >= 12 ? "PM" : "AM";
      const h12 = hh % 12 || 12;
      return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
    };

    res.status(200).json({
      available_slots: slots,
      business_hours: `${formatTime12(openHour, openMin)} - ${formatTime12(closeHour, closeMin)}`,
      slot_duration_minutes: slotDuration
    });
  } catch (error) {
    log("availability_check_failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "availability_check_failed", message: error?.message || "unknown_error" });
  }
});

app.post("/internal/appointments/book", requireInternalAuth, async (req, res) => {
  try {
    const admin = requireSupabase();
    const businessId = typeof req.body?.business_id === "string" ? req.body.business_id.trim() : "";
    const customerName = typeof req.body?.customer_name === "string" ? req.body.customer_name.trim() : "";
    const customerPhone = typeof req.body?.customer_phone === "string" ? req.body.customer_phone.trim() : "";
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const scheduledAt = typeof req.body?.scheduled_at === "string" ? req.body.scheduled_at.trim() : "";
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";

    if (!businessId) {
      res.status(400).json({ error: "missing_business_id" });
      return;
    }
    if (!title) {
      res.status(400).json({ error: "missing_title" });
      return;
    }
    if (!scheduledAt) {
      res.status(400).json({ error: "missing_scheduled_at" });
      return;
    }

    const callLogId = typeof req.body?.call_log_id === "string" ? req.body.call_log_id.trim() : "";

    const customer = await findOrCreateCustomer(admin, businessId, customerPhone, customerName);

    const { data: appointment, error: insertError } = await admin
      .from("b2b_appointments")
      .insert({
        business_id: businessId,
        customer_id: customer?.id || null,
        title,
        description: description || null,
        scheduled_at: scheduledAt,
        status: "SCHEDULED"
      })
      .select("id, scheduled_at, status")
      .single();

    if (insertError || !appointment) {
      throw new Error(`appointment_insert_failed: ${insertError?.message || "unknown"}`);
    }

    // Link the call log to this appointment
    if (callLogId) {
      await admin
        .from("b2b_call_logs")
        .update({ appointment_id: appointment.id })
        .eq("id", callLogId);
    }

    log("appointment_booked", {
      businessId,
      appointmentId: appointment.id,
      callLogId: callLogId || null,
      scheduledAt,
      customerName
    });

    res.status(200).json({
      success: true,
      appointment_id: appointment.id,
      scheduled_at: appointment.scheduled_at,
      status: appointment.status
    });
  } catch (error) {
    log("appointment_booking_failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "appointment_booking_failed", message: error?.message || "unknown_error" });
  }
});

// ── Stripe Billing Routes ──

app.post("/api/billing/create-checkout-session", requireAuth, async (req, res) => {
  if (!stripe) {
    res.status(500).json({ error: "stripe_not_configured" });
    return;
  }

  try {
    const admin = requireSupabase();
    const { price_id } = req.body;

    if (price_id !== stripeStarterPriceId && price_id !== stripeProPriceId) {
      res.status(400).json({ error: "invalid_price_id" });
      return;
    }

    const business = await findBusinessForOwner(admin, req.auth.user.id);
    if (!business) {
      res.status(404).json({ error: "business_not_found" });
      return;
    }

    // Look up existing stripe_customer_id
    const { data: bizData } = await admin
      .from("b2b_businesses")
      .select("stripe_customer_id")
      .eq("id", business.id)
      .single();

    let customerId = bizData?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.auth.user.email,
        metadata: { business_id: business.id },
      });
      customerId = customer.id;

      await admin
        .from("b2b_businesses")
        .update({ stripe_customer_id: customerId })
        .eq("id", business.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: price_id, quantity: 1 }],
      success_url: `${frontendUrl}/dashboard/settings?billing=success`,
      cancel_url: `${frontendUrl}/dashboard/settings?billing=canceled`,
      metadata: { business_id: business.id },
    });

    res.json({ url: session.url });
  } catch (error) {
    log("checkout_session_failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "checkout_session_failed", message: error?.message || "unknown_error" });
  }
});

app.post("/api/billing/create-portal-session", requireAuth, async (req, res) => {
  if (!stripe) {
    res.status(500).json({ error: "stripe_not_configured" });
    return;
  }

  try {
    const admin = requireSupabase();

    const business = await findBusinessForOwner(admin, req.auth.user.id);
    if (!business) {
      res.status(404).json({ error: "business_not_found" });
      return;
    }

    const { data: bizData } = await admin
      .from("b2b_businesses")
      .select("stripe_customer_id")
      .eq("id", business.id)
      .single();

    if (!bizData?.stripe_customer_id) {
      res.status(400).json({ error: "no_stripe_customer" });
      return;
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: bizData.stripe_customer_id,
      return_url: `${frontendUrl}/dashboard/settings`,
    });

    res.json({ url: portalSession.url });
  } catch (error) {
    log("portal_session_failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "portal_session_failed", message: error?.message || "unknown_error" });
  }
});

// ── Trial email check (manual trigger) ──────────────────────────
app.post("/internal/trial/check-emails", requireInternalAuth, async (req, res) => {
  try {
    const admin = requireSupabase();
    await checkAndSendTrialEmails(admin, log);
    res.json({ success: true });
  } catch (error) {
    log("trial_email_manual_check_failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "trial_email_check_failed" });
  }
});

// ── Subscription status ─────────────────────────────────────────
app.get("/api/subscription/status", requireAuth, async (req, res) => {
  try {
    const admin = requireSupabase();
    const business = await findBusinessForOwner(admin, req.auth.user.id);
    if (!business) {
      res.status(404).json({ error: "business_not_found" });
      return;
    }

    const { data: biz } = await admin
      .from("b2b_businesses")
      .select("subscription_tier, subscription_status, trial_ends_at")
      .eq("id", business.id)
      .single();

    if (!biz) {
      res.status(404).json({ error: "business_not_found" });
      return;
    }

    let daysRemaining = null;
    if (biz.subscription_status === "TRIALING" && biz.trial_ends_at) {
      const msLeft = new Date(biz.trial_ends_at).getTime() - Date.now();
      daysRemaining = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
    }

    res.json({
      tier: biz.subscription_tier,
      status: biz.subscription_status,
      trialEndsAt: biz.trial_ends_at || null,
      daysRemaining,
      isActive: isSubscriptionActive(biz),
    });
  } catch (error) {
    log("subscription_status_failed", { message: error?.message || String(error) });
    res.status(500).json({ error: "subscription_status_failed" });
  }
});

// ── Delete account ──────────────────────────────────────────────
app.post("/api/account/delete", requireAuth, async (req, res) => {
  try {
    const admin = requireSupabase();
    const userId = req.auth.user.id;

    const biz = await findBusinessForOwner(admin, userId);
    if (!biz) {
      res.status(404).json({ error: "no_business_found" });
      return;
    }

    // Delete business row — FK cascades handle customers, appointments, call logs, messages.
    // Phone pool trigger releases the number automatically.
    const { error: delErr } = await admin
      .from("b2b_businesses")
      .delete()
      .eq("id", biz.id);

    if (delErr) {
      log("account_delete_business_failed", { userId, businessId: biz.id, message: delErr.message });
      res.status(500).json({ error: "delete_failed" });
      return;
    }

    // Delete auth user
    const { error: authErr } = await admin.auth.admin.deleteUser(userId);
    if (authErr) {
      log("account_delete_auth_failed", { userId, message: authErr.message });
      // Business is already gone, so still return success to the client
    }

    log("account_deleted", { userId, businessId: biz.id });
    res.json({ success: true });
  } catch (error) {
    log("account_delete_error", { message: error?.message || "unknown" });
    res.status(500).json({ error: "delete_failed" });
  }
});

// Keep both endpoints for compatibility:
// - /webhooks/telnyx/voice (local convention)
// - /api/webhooks/telnyx/inbound (existing Railway-style path)
app.post("/webhooks/telnyx/voice", telnyxWebhookHandler);
app.post("/api/webhooks/telnyx/inbound", telnyxWebhookHandler);

app.listen(port, () => {
  log("backend_api_started", {
    port,
    supabaseConfigured: Boolean(supabaseAdmin),
    internalAuthMode: internalApiToken ? "token" : "localhost_only"
  });

  // Trial email cron — check every 6 hours + once on startup
  if (supabaseAdmin && process.env.RESEND_API_KEY) {
    const runTrialEmailCheck = () => {
      try {
        checkAndSendTrialEmails(supabaseAdmin, log);
      } catch (error) {
        log("trial_email_cron_error", { message: error?.message || String(error) });
      }
    };
    setTimeout(runTrialEmailCheck, 5000); // 5s after startup
    setInterval(runTrialEmailCheck, 6 * 60 * 60 * 1000); // every 6 hours
  }
});
