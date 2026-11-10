---
name: transit-planner
description: Plan transit trips between stops and read live delay snapshots from open GTFS and GTFS-Realtime feeds, priced per query over x402. Use when an agent needs real departure and delay data.
---

# x402-transit trip planning and delays

Live data from keyless feeds. The default agency is the MBTA. There is no fixture mode: an unreachable feed gives a 502, never invented times. A stop can be a feed stop id (`place-sstat`), a station name (`South Station`) or `lat,lon`.

## Run the server

The repo is a self-hosted Express service. It is not published to npm, so run it from a clone.

```bash
git clone https://github.com/nirholas/x402-transit && cd x402-transit
npm install
cp .env.example .env   # optional: the defaults run out of the box
npm run dev            # listens on http://localhost:4024 (override with PORT)
```

Set `PAY_TO_ADDRESS` (Base) and `SOLANA_PAY_TO_ADDRESS` (Solana) in `.env` to receive payments yourself.
`GET http://localhost:4024/.well-known/x402` lists every route with its price, and `GET /health` is the liveness probe.

## Routes

| Route | Price | Purpose |
|---|---|---|
| `GET /plan` | $0.002 | Query `from`, `to` (required), `departAfter` (ISO 8601, default now), `max` (1 to 10, default 3) |
| `GET /delays` | $0.001 | Query `stop` (required), `route` (routeId filter such as `Red`), `limit` (1 to 100, default 20) |
| `GET /stops?query=...` | free | Search stop names. Never pay to discover a stop id |
| `GET /routes` | free | List route ids |
| `GET /health`, `GET /.well-known/x402` | free | Feed and agency in use, discovery |

The full request and response schemas are in `skill.md` at the repo root (the running server also serves it at `GET /skill.md`).

## Paying

Paid routes answer an unpaid request with HTTP 402 and an `accepts` array with one entry per rail (USDC on Base and USDC on Solana). A client picks an entry, signs, and retries with the `X-PAYMENT` header. The 200 body carries the artifact and an `X-PAYMENT-RESPONSE` header carries the settlement receipt. Any x402 client works (`x402-fetch` with `viem` on the EVM rail). Each paid call spends real USDC on whichever network the server is configured for (`NETWORK`, `SOLANA_NETWORK`), so show the user the route, price and network and get a yes before paying.

## Worked example

```bash
curl -s 'http://localhost:4024/stops?query=South%20Station'
curl -s http://localhost:4024/routes
```

After the user approves the $0.002, pay `GET /plan?from=South%20Station&to=Porter&max=2` with an x402 client. For lateness, pay `GET /delays?stop=South%20Station&route=Red&limit=4` ($0.001).
