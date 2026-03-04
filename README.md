# Backend API (Call Logs + Test Call + Ingestion)

This service now provides:
- `POST /api/test-call` for frontend Settings page
- internal ingestion endpoints for LiveKit worker (`/internal/calls/*`)
- persistence to Supabase `b2b_call_logs` and `b2b_messages`
- transcript post-processing via Gemini (`gemini-2.5-flash` by default)
- legacy Telnyx webhook fallback greeting endpoints

## 1) Setup

```bash
cd backend-api
cp .env.example .env
npm install
npm run dev
```

Default local port is `6001`.

## 2) Required env

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_PUBLISHABLE_KEY` (kept for parity with shared config)
- `INTERNAL_API_TOKEN` (shared with livekit service)

Optional but recommended:
- `DEFAULT_BUSINESS_ID` fallback when business can't be resolved from called number
- `CORS_ORIGIN=http://localhost:3001`
- `TRANSCRIPT_POSTPROCESS_MODEL=gemini-2.5-flash`

## 3) Frontend endpoint

`POST /api/test-call` expects:

```json
{
  "phone": "+15551234567",
  "voice_preference": "Aoede",
  "business_id": "<business-id>"
}
```

Requires `Authorization: Bearer <supabase-access-token>`.

## 4) Internal endpoints (for livekit)

Protected by header `x-internal-token: <INTERNAL_API_TOKEN>`.

- `POST /internal/calls/start`
- `POST /internal/calls/transcript`
- `POST /internal/calls/end`

These create/update `b2b_call_logs` and optionally insert `b2b_messages`.

## 5) Legacy webhook fallback

Still supported:
- `POST /webhooks/telnyx/voice`
- `POST /api/webhooks/telnyx/inbound`

Flow:
- `call.initiated` => answer
- `call.answered` => speak Gemini-generated greeting

## 6) Health

- `GET /health`
