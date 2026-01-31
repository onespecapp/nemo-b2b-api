# Nemo B2B API

Automated appointment reminder calls for businesses.

## Features

- Customer management
- Appointment scheduling
- Automated phone call reminders via Telnyx
- Call logging and tracking

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in your credentials

3. Build and run:
```bash
npm run build
npm start
```

## Environment Variables

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `TELNYX_API_KEY` - Telnyx API key
- `TELNYX_CONNECTION_ID` - Telnyx SIP connection ID
- `TELNYX_PHONE_NUMBER` - Your Telnyx phone number
- `PORT` - API port (default: 6001)
- `API_URL` - Public API URL for webhooks

## API Endpoints

- `GET /health` - Health check
- `GET /api/appointments/pending-reminders` - Get appointments needing reminders
- `POST /api/appointments/:id/trigger-call` - Trigger reminder call
- `GET /api/call-logs` - Get call history
- `POST /api/test-call` - Make a test call
