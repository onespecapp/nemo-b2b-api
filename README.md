# Nemo B2B API

Automated appointment reminder calls for businesses. Part of the Nemo ecosystem.

## Overview

Nemo B2B helps businesses reduce no-shows by automatically calling customers to remind them about upcoming appointments. The AI voice agent can:

- Deliver personalized reminder messages
- Confirm appointments (press 1)
- Handle reschedule requests (press 2)
- Leave voicemails when customers don't answer
- Track all call outcomes

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js
- **Database**: Supabase (PostgreSQL)
- **Voice Calls**: Telnyx SIP + LiveKit (optional)
- **ORM**: Prisma

## Quick Start

### Prerequisites

- Node.js 18+
- Supabase account
- Telnyx account with phone number

### Installation

```bash
# Clone the repo
git clone https://github.com/onespecapp/nemo-b2b-api.git
cd nemo-b2b-api

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your credentials

# Generate Prisma client
npx prisma generate

# Push schema to database
npx prisma db push

# Build and run
npm run build
npm start
```

### Development

```bash
npm run dev
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SUPABASE_URL` | Your Supabase project URL | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (not anon key) | Yes |
| `DATABASE_URL` | Postgres connection string (from Supabase) | Yes |
| `DIRECT_URL` | Direct Postgres URL for migrations | Yes |
| `TELNYX_API_KEY` | Telnyx API key | Yes |
| `TELNYX_CONNECTION_ID` | Telnyx SIP connection ID | Yes |
| `TELNYX_PHONE_NUMBER` | Your Telnyx phone number | Yes |
| `PORT` | API port (default: 6001) | No |
| `API_URL` | Public URL for webhooks | Yes |

## API Endpoints

### Health Check
```
GET /health
```

### Appointments

```
GET /api/appointments/pending-reminders
```
Returns appointments that need reminder calls.

```
POST /api/appointments/:id/trigger-call
```
Triggers a reminder call for a specific appointment.

### Call Logs

```
GET /api/call-logs?business_id=xxx
```
Returns call history for a business.

### Test Call

```
POST /api/test-call
Body: { "phone": "+1234567890", "message": "optional" }
```
Makes a test call to verify setup.

### Webhooks

```
POST /api/webhooks/telnyx/call-events
```
Receives Telnyx call events (answer, hangup, DTMF, etc.)

## Database Schema

The API uses these tables (with `b2b_` prefix):

- `b2b_businesses` - Companies using the service
- `b2b_customers` - People to call
- `b2b_appointments` - Scheduled appointments
- `b2b_call_logs` - Call history

See `prisma/schema.prisma` for full schema.

## Deployment

### Railway

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```

### Render

1. Connect your GitHub repo
2. Set environment variables
3. Deploy

### Fly.io

```bash
fly launch
fly secrets set SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx ...
fly deploy
```

## Supabase Setup

1. Create a new Supabase project
2. Run the migration SQL in `supabase/migrations/001_create_tables_and_rls.sql`
3. Or use Prisma: `npx prisma db push`

The migration includes:
- Table creation
- Indexes for performance
- Row Level Security (RLS) policies
- Triggers for `updated_at`
- Auto-create business on user signup

## Related Projects

- [nemo-b2b-web](https://github.com/onespecapp/nemo-b2b-web) - Next.js frontend
- [Nemo Cares](https://meetnemo.com) - Consumer app for senior care

## License

ISC
