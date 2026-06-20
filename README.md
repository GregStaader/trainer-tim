# Trainer Tim — Trail Running Coaching Dashboard

A Strava-connected running dashboard for tracking trail running performance, built with Cloudflare Workers and vanilla JavaScript.

## What It Does

- **Dashboard** — Weekly stats at a glance: distance, elevation, time, pace, vert/km, longest run
- **Activities** — Browse all Strava activities with filtering by type, click for full detail
- **Stats** — Weekly/monthly/yearly trends with bar charts
- **Activity Detail** — Full activity view with Leaflet map, elevation profile, lap splits, achievements
- **Multi-Athlete** — Switch between profiles (e.g. Greg and Son) with separate Strava connections
- **OAuth Flow** — Secure Strava OAuth 2.0 connection with automatic token refresh

## Architecture

```
trainer-tim/
├── index.html          # Dashboard HTML (SPA shell)
├── styles.css          # All styling (earthy trail palette, responsive)
├── app.js              # Frontend app (state, routing, rendering, API client)
├── worker/
│   └── index.js        # Cloudflare Worker (API routes, OAuth, KV caching)
├── wrangler.jsonc      # Wrangler config
└── README.md           # This file
```

**Frontend:** Vanilla JS SPA with localStorage caching, auto-refresh, and Leaflet maps.
**Backend:** Cloudflare Worker handling API routes, Strava OAuth, token management, and KV caching.
**Data:** Strava API v3 for athlete data, activities, and stats.

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/) with Workers Paid plan (for KV)
- [Strava API application](https://www.strava.com/settings/api)
- [Node.js](https://nodejs.org/) 18+ and [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

## Setup

### Step 1: Create a Strava API App

1. Go to https://www.strava.com/settings/api
2. Create a new application:
   - **Application Name:** Trainer Tim
   - **Website:** Your deployed URL (e.g. `https://tim.cape-agent.com`)
   - **Authorization Callback Domain:** Your deployed domain (e.g. `tim.cape-agent.com`)
3. Note your **Client ID** and **Client Secret**

### Step 2: Create a KV Namespace

```bash
wrangler kv namespace create TRAINER_TIM_KV
```

Copy the generated namespace ID.

### Step 3: Set Secrets

```bash
wrangler secret put STRAVA_CLIENT_SECRET
# Paste your Strava Client Secret when prompted
```

### Step 4: Update wrangler.jsonc

Edit `wrangler.jsonc` and replace:
- `REPLACE_WITH_KV_NAMESPACE_ID` → Your KV namespace ID from Step 2
- `REPLACE_WITH_STRAVA_CLIENT_ID` → Your Strava Client ID from Step 1

### Step 5: Deploy

```bash
npm install           # Install wrangler dependency
wrangler deploy
```

### Step 6: Configure Custom Domain

1. In Cloudflare Dashboard → Workers & Pages → trainer-tim
2. Go to **Settings** → **Domains & Routes**
3. Add your custom domain (e.g. `tim.cape-agent.com`)
4. Update DNS to point to Cloudflare

## Local Development

```bash
# Install dependencies
npm install

# Start dev server
wrangler dev

# Or with remote KV data
wrangler dev --remote
```

The dev server runs at `http://localhost:8787`.

For OAuth to work locally, update your Strava API app's callback domain to `localhost` temporarily.

## Strava API Scopes

The app requests:
- `read` — Read public profile
- `activity:read_all` — Read all activity data (including private)

These are read-only scopes. Trainer Tim never modifies your Strava data.

## Caching Strategy

| Endpoint | Cache TTL | Storage |
|----------|-----------|---------|
| `/api/athlete` | 1 hour | KV |
| `/api/activities` | 5 minutes | KV |
| `/api/activity/:id` | 1 hour | KV |
| `/api/stats` | 5 minutes | KV |
| Frontend | 30 minutes | localStorage |

## Rate Limits

Strava API limits: 100 requests per 15 minutes, 1,000 per day.
The worker respects rate limit headers and caches aggressively to stay within limits.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `STRAVA_CLIENT_ID` | Strava API Client ID (in wrangler.jsonc vars) |
| `STRAVA_CLIENT_SECRET` | Strava API Client Secret (set via `wrangler secret`) |

## KV Structure

| Key | Value | TTL |
|-----|-------|-----|
| `athlete:greg:tokens` | OAuth tokens (access, refresh, expiry) | Permanent |
| `athlete:son:tokens` | OAuth tokens (access, refresh, expiry) | Permanent |
| `cache:athlete:greg` | Athlete profile data | 1 hour |
| `cache:activities:greg:p1:n10` | Activities page | 5 minutes |
| `cache:activity:greg:12345` | Single activity detail | 1 hour |
| `cache:stats:greg:weekly` | Computed stats | 5 minutes |

## License

MIT
