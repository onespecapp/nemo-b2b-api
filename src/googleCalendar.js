import { google } from "googleapis";
import crypto from "crypto";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
const CALENDAR_ENCRYPTION_KEY = process.env.CALENDAR_ENCRYPTION_KEY || ""; // 32-byte hex

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/userinfo.email",
];

// ── Encryption helpers (AES-256-GCM) ──

function encryptToken(plaintext) {
  if (!CALENDAR_ENCRYPTION_KEY) throw new Error("CALENDAR_ENCRYPTION_KEY not set");
  const key = Buffer.from(CALENDAR_ENCRYPTION_KEY, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptToken(ciphertext) {
  if (!CALENDAR_ENCRYPTION_KEY) throw new Error("CALENDAR_ENCRYPTION_KEY not set");
  const key = Buffer.from(CALENDAR_ENCRYPTION_KEY, "hex");
  const [ivHex, tagHex, encHex] = ciphertext.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

// ── OAuth state encryption (protects businessId/userId in callback) ──

function encryptState(obj) {
  return encryptToken(JSON.stringify(obj));
}

function decryptState(stateStr) {
  return JSON.parse(decryptToken(stateStr));
}

// ── OAuth2 client factory ──

function createOAuth2Client() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

// ── Public API ──

export function isConfigured() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI && CALENDAR_ENCRYPTION_KEY);
}

/**
 * Generate Google OAuth consent URL.
 */
export function getAuthUrl(businessId, userId) {
  const oauth2Client = createOAuth2Client();
  const state = encryptState({ businessId, userId, timestamp: Date.now() });
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

/**
 * Exchange authorization code for tokens, return structured data.
 */
export async function handleCallback(code, stateStr) {
  const state = decryptState(stateStr);
  const { businessId, userId, timestamp } = state;

  // Reject if state is older than 10 minutes
  if (Date.now() - timestamp > 10 * 60 * 1000) {
    throw new Error("OAuth state expired");
  }

  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Fetch user email
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data: userInfo } = await oauth2.userinfo.get();

  return {
    businessId,
    userId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    scopes: tokens.scope || SCOPES.join(" "),
    email: userInfo.email,
  };
}

/**
 * Get an authenticated Google Calendar client for a business.
 * Auto-refreshes expired tokens.
 */
export async function getCalendarClient(supabaseAdmin, businessId) {
  const { data: integration, error } = await supabaseAdmin
    .from("b2b_calendar_integrations")
    .select("*")
    .eq("business_id", businessId)
    .eq("provider", "google_calendar")
    .eq("status", "active")
    .maybeSingle();

  if (error || !integration) return null;

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: integration.access_token,
    refresh_token: integration.refresh_token_encrypted
      ? decryptToken(integration.refresh_token_encrypted)
      : null,
  });

  // Check if token needs refresh (within 5 min of expiry)
  const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at) : null;
  const needsRefresh = !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

  if (needsRefresh) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Update stored tokens
      await supabaseAdmin
        .from("b2b_calendar_integrations")
        .update({
          access_token: credentials.access_token,
          token_expires_at: credentials.expiry_date
            ? new Date(credentials.expiry_date).toISOString()
            : null,
        })
        .eq("id", integration.id);
    } catch (refreshErr) {
      // Mark integration as errored
      await supabaseAdmin
        .from("b2b_calendar_integrations")
        .update({
          status: "error",
          last_sync_error: `Token refresh failed: ${refreshErr.message}`,
        })
        .eq("id", integration.id);
      return null;
    }
  }

  return {
    calendar: google.calendar({ version: "v3", auth: oauth2Client }),
    calendarId: integration.google_calendar_id || "primary",
  };
}

/**
 * Query Google FreeBusy API for busy intervals.
 * Returns array of { start: Date, end: Date }.
 */
export async function getGoogleBusyTimes(supabaseAdmin, businessId, timeMin, timeMax) {
  const client = await getCalendarClient(supabaseAdmin, businessId);
  if (!client) return [];

  const { data } = await client.calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: client.calendarId }],
    },
  });

  const busy = data.calendars?.[client.calendarId]?.busy || [];
  return busy.map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
}

/**
 * Create a Google Calendar event.
 * Returns the event ID.
 */
export async function createCalendarEvent(supabaseAdmin, businessId, { summary, description, start, end, timezone }) {
  const client = await getCalendarClient(supabaseAdmin, businessId);
  if (!client) return null;

  const { data: event } = await client.calendar.events.insert({
    calendarId: client.calendarId,
    requestBody: {
      summary,
      description: description || undefined,
      start: { dateTime: start, timeZone: timezone },
      end: { dateTime: end, timeZone: timezone },
    },
  });

  return event.id;
}

/**
 * Update a Google Calendar event.
 */
export async function updateCalendarEvent(supabaseAdmin, businessId, eventId, updates) {
  const client = await getCalendarClient(supabaseAdmin, businessId);
  if (!client) return;

  await client.calendar.events.patch({
    calendarId: client.calendarId,
    eventId,
    requestBody: updates,
  });
}

/**
 * Delete a Google Calendar event.
 */
export async function deleteCalendarEvent(supabaseAdmin, businessId, eventId) {
  const client = await getCalendarClient(supabaseAdmin, businessId);
  if (!client) return;

  await client.calendar.events.delete({
    calendarId: client.calendarId,
    eventId,
  });
}

/**
 * Revoke integration: revoke Google token + delete DB row.
 */
export async function revokeIntegration(supabaseAdmin, businessId) {
  const { data: integration } = await supabaseAdmin
    .from("b2b_calendar_integrations")
    .select("access_token")
    .eq("business_id", businessId)
    .eq("provider", "google_calendar")
    .maybeSingle();

  if (integration?.access_token) {
    try {
      const oauth2Client = createOAuth2Client();
      await oauth2Client.revokeToken(integration.access_token);
    } catch {
      // Best-effort revocation
    }
  }

  await supabaseAdmin
    .from("b2b_calendar_integrations")
    .delete()
    .eq("business_id", businessId)
    .eq("provider", "google_calendar");
}

/**
 * Upsert integration row after successful OAuth callback.
 */
export async function upsertIntegration(supabaseAdmin, { businessId, accessToken, refreshToken, expiresAt, scopes, email }) {
  const row = {
    business_id: businessId,
    provider: "google_calendar",
    google_account_email: email,
    access_token: accessToken,
    refresh_token_encrypted: refreshToken ? encryptToken(refreshToken) : null,
    token_expires_at: expiresAt ? expiresAt.toISOString() : null,
    scopes: scopes || SCOPES.join(" "),
    status: "active",
    last_sync_error: null,
  };

  // Upsert by business_id + provider
  const { data: existing } = await supabaseAdmin
    .from("b2b_calendar_integrations")
    .select("id")
    .eq("business_id", businessId)
    .eq("provider", "google_calendar")
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from("b2b_calendar_integrations")
      .update(row)
      .eq("id", existing.id);
  } else {
    await supabaseAdmin
      .from("b2b_calendar_integrations")
      .insert(row);
  }
}

export { encryptToken, decryptToken };
