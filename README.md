# ZernFlow

The open-source ManyChat alternative. Visual flow builder for Instagram, Facebook, Telegram, Twitter/X, Bluesky & Reddit.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Website](https://img.shields.io/badge/Website-zernflow.com-indigo)](https://zernflow.com)

**Live at [zernflow.com](https://zernflow.com)**

> **This fork** (`aleclezio/zernflow`) hardens upstream for multi-client use:
> profile-scoped workspaces, encrypted key custody, signed webhooks with
> replay defense, tenant-isolation lockdown, SSRF-guarded HTTP nodes, and a
> full test suite + CI. See [Security model (this fork)](#security-model-this-fork).

## What is ZernFlow?

ZernFlow is an open-source alternative to ManyChat. Build visual chatbot flows, manage contacts, send broadcasts, run drip campaigns, and handle live chat conversations across 6 social media platforms.

**Powered by [Zernio](https://zernio.com)** for OAuth, token refresh, rate limiting, and cross-platform messaging.

### Features

- **Visual Flow Builder** - Drag-and-drop chatbot builder with 15+ node types
- **AI Response Node** - AI-powered replies via OpenAI, Anthropic, or Google (Vercel AI SDK)
- **Live Chat Inbox** - Real-time inbox with human takeover and conversation assignment
- **Contact CRM** - Tags, custom fields, segments, and contact management
- **Broadcasting** - Send targeted messages to contact segments
- **Sequences** - Drip campaigns with timed message series and automatic enrollment
- **Team Management** - Invite members, assign roles, manage permissions
- **Multi-Platform** - Instagram, Facebook, Telegram, Twitter/X, Bluesky, Reddit
- **Connect Channels** - OAuth connection flow directly from ZernFlow (powered by Zernio)
- **Rich Messaging** - Buttons, quick replies, and carousel cards
- **Comment-to-DM** - Automatically DM users who comment specific keywords
- **Growth Tools** - Conversation starter links for each connected platform
- **A/B Testing** - Split test different message paths
- **Webhooks & HTTP** - Connect to external APIs from your flows

## Quick Start

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project (free tier works)
- A [Zernio](https://zernio.com) API key (entered in Settings after setup)
- A [Vercel AI Gateway](https://vercel.com/ai-gateway) key (optional, for AI node, entered in Settings or env)

### Setup

1. **Clone the repo**

```bash
git clone https://github.com/zernio-dev/zernflow.git
cd zernflow
npm install
```

2. **Set up Supabase**

Create a free project at [supabase.com](https://supabase.com). Then run the SQL migrations in the Supabase SQL editor:

```bash
# Run each file in supabase/migrations/ in order (00001 through 00014),
# or paste supabase/migrations/ALL_MIGRATIONS.sql in one shot.
# Local development: `npx supabase start && npx supabase migration up`,
# then `node scripts/dev-env.mjs` to generate .env.local.
```

3. **Configure environment**

```bash
cp .env.example .env
```

Fill in your Supabase credentials:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
CRON_SECRET=your-cron-secret              # For sequence processor + job scheduler (Bearer header only)
APP_ENCRYPTION_KEY=base64-32-bytes        # Encrypts workspace secrets at rest (see .env.example)
# AI_GATEWAY_API_KEY=...                  # Optional, for self-hosted (Vercel handles this automatically)
```

After starting the app, go to **Settings** to enter your Zernio API key and (optionally) AI Gateway key.

4. **Run**

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign up, and start building flows.

## Architecture

```
Browser (Flow Builder, Inbox, CRM, Sequences)
        |
   Next.js App Router
        |
   +----+----+----+----+----+
   |    |    |    |    |    |
Webhook Flow CRM  Live  Broadcast Sequence
Recv.  Engine     Chat           Processor
   |    |    |    |    |    |
   +----+----+----+----+----+
        |         |         |
    Supabase   Zernio API AI SDK
  (PG + Auth   (6 platforms) (OpenAI /
  + Realtime)              Anthropic /
                           Google)
```

## Stack

| Layer | Tool |
|-------|------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Database + Auth + Realtime | Supabase |
| Flow Builder | React Flow (@xyflow/react) |
| AI | Vercel AI SDK + [AI Gateway](https://vercel.com/ai-gateway) |
| UI | Tailwind CSS 4 |
| Icons | @icons-pack/react-simple-icons |
| Messaging | [Zernio API](https://zernio.com) |

## Flow Node Types

| Node | Description |
|------|-------------|
| Trigger | Keyword, postback, quick reply, welcome, default |
| Send Message | Text, images, buttons, quick replies, carousels |
| AI Response | AI-powered replies with conversation context (OpenAI, Anthropic, Google) |
| Condition | If/else on tags, fields, platform, variables |
| Delay | Wait seconds/minutes/hours/days |
| Add/Remove Tag | Manage contact tags |
| Set Custom Field | Set contact field values with variable interpolation |
| HTTP Request | Call external APIs, store responses |
| Go To Flow | Jump to another flow (with return stack) |
| Human Takeover | Pause automation, alert inbox |
| Enroll in Sequence | Add contact to a drip campaign |
| Subscribe/Unsubscribe | Toggle contact subscription |
| A/B Split | Randomly route contacts for testing |
| Smart Delay | Wait for user response or timeout |
| Comment Reply | Public reply to comments |
| Private Reply | Instagram comment-to-DM |

## Project Structure

```
zernflow/
├── app/
│   ├── (auth)/             # Login, register pages
│   ├── (dashboard)/        # Flows, inbox, contacts, sequences, settings
│   ├── invite/             # Team invite acceptance page
│   └── api/
│       ├── webhooks/late/   # Webhook receiver
│       ├── cron/jobs/       # Job scheduler
│       ├── cron/sequences/  # Sequence step processor
│       └── v1/              # CRUD API routes
├── components/
│   ├── flow-builder/        # Canvas, nodes, panels
│   ├── inbox/               # Conversation list, thread, contact panel
│   ├── sequences/           # Sequence editor, enrollment list
│   ├── settings/            # Team management
│   └── ui/                  # Shared UI components
├── lib/
│   ├── supabase/            # Server/client/middleware
│   ├── flow-engine/         # Engine, trigger matcher, platform adapter, AI node
│   ├── actions/             # Server actions (team, sequences, workspace)
│   └── types/               # TypeScript types
└── supabase/
    └── migrations/          # SQL schema + RLS policies (00001-00009)
```

## Security model (this fork)

### Per-client onboarding (the scoped-key ritual)

Each workspace is bound to exactly ONE Zernio profile — that binding is the
multi-client foundation. To onboard a client:

1. In the **Zernio dashboard**, create a profile for the client (if missing)
   and an **API key scoped to ONLY that profile** (`scope: profiles`,
   read-write). Never paste the master key into a workspace.
2. In ZernFlow **Settings → Test Connection**, paste the scoped key.
   - The key auto-binds when it sees exactly one profile; if it sees several
     you'll be asked to pick (and warned — a multi-profile key weakens
     isolation).
   - The key is stored encrypted (AES-256-GCM, AAD = workspace id); the
     profile binding is 1:1 and enforced by a unique index.
3. Channel sync and OAuth connect only ever see the bound profile's accounts.

### Webhooks

- One webhook per workspace at `/api/webhooks/zernio/<token>` — the token is
  a capability URL (only its sha256 is stored). The HMAC secret is mandatory;
  unsigned or mis-signed deliveries are rejected before any parsing.
- Replays are deduped by event id (`webhook_events`, insert-before-process,
  7-day retention).
- Registration happens automatically on key save. If the scoped key is not
  allowed to manage webhooks, run the operator fallback (the admin key never
  enters the app database):

```bash
ZERNIO_ADMIN_KEY=... node scripts/register-webhook.mjs <workspace-id> https://your-public-url
```

### Key rotation

- **Zernio key**: paste the new key in Settings (owner only). It must see the
  already-bound profile, otherwise it is rejected (409).
- **APP_ENCRYPTION_KEY**: rotating it invalidates every stored secret —
  ciphertexts fail closed and each workspace owner re-enters their key in
  Settings. There is no re-encryption tool yet (single-key deployment).
- **Webhook secret/token**: re-saving the key re-registers the webhook with
  fresh credentials; the old registration is deleted best-effort.

### Verification

```bash
npm run lint && npm run typecheck   # static gates
npm test                            # unit + integration (needs `npx supabase start`)
bash scripts/check-key-access.sh    # key columns only via lib/workspace-keys.ts
node scripts/smoke-test.mjs         # live e2e against a running app
```

### Known residual risks (accepted, tracked)

- **DNS rebinding** against the SSRF guard's resolve-then-fetch window —
  closed at the deployment layer by a container egress firewall.
- **Key breadth is unprovable client-side**: a pasted key claiming one
  profile could still be broader server-side; the scoped-key ritual plus the
  multi-profile warning are the control.
- **In-memory rate limits** reset on restart and assume a single node.
- **At-most-once processing**: a webhook that fails mid-processing is not
  retried (the dedupe row already exists). Better to drop one event than
  double-send DMs; an async queue is on the roadmap.
- 2 `npm audit` moderates in next's bundled postcss (build-time only; the
  "fix" downgrades next to 9.x).

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

MIT
