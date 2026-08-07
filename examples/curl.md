# Raw x402 flow with curl

Exactly what happens on the wire: 402 → pay → 200.

## 1. Free routes first

```bash
curl -s http://localhost:4024/health | jq
curl -s "http://localhost:4024/stops?query=Porter" | jq '.stops[] | {id, name, municipality}'
curl -s "http://localhost:4024/routes?stop=place-sstat" | jq '.routes[] | {routeId, name}'
```

Stop and route lookup is **free** — never pay to discover a stop id.

```json
{ "id": "place-portr", "name": "Porter", "municipality": "Cambridge" }
```

## 2. Hit a paid route without payment → HTTP 402

```bash
curl -si "http://localhost:4024/plan?from=South%20Station&to=Porter" | head -40
```

You get `402 Payment Required` and a JSON body with **one payment-requirements
object per rail** — Base and Solana:

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header required — pay in USDC on Base or Solana, your pick.",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "2000",
      "resource": "http://localhost:4024/plan",
      "description": "Transit itinerary options between two stops — legs, routes, scheduled times, and realtime predictions where the feed has them",
      "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "maxTimeoutSeconds": 60,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact",
      "network": "solana",
      "maxAmountRequired": "2000",
      "resource": "http://localhost:4024/plan",
      "description": "Transit itinerary options between two stops — legs, routes, scheduled times, and realtime predictions where the feed has them",
      "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "maxTimeoutSeconds": 60,
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USDC", "decimals": 6 }
    }
  ]
}
```

`maxAmountRequired` is atomic USDC (6 decimals): `2000` = $0.002 — the same price
on either rail. Filter to the rail you can pay:

```bash
curl -s "http://localhost:4024/plan?from=South%20Station&to=Porter" \
  | jq '.accepts[] | select(.network | startswith("solana"))'
```

## 3. Pay

The `X-PAYMENT` header is base64 JSON wrapping a signature for the rail you
picked — an EIP-3009 USDC transfer authorization on Base, or a signed SPL USDC
transfer on Solana. Neither is practical to produce with curl alone, so use the
bundled client, which does the 402 → sign → retry loop for you (EVM rail):

```bash
export PRIVATE_KEY=0x…   # funded Base Sepolia wallet (https://faucet.circle.com)
npm run client
```

Under the hood it re-sends the same request as:

```bash
curl -s "http://localhost:4024/plan?from=South%20Station&to=Porter" \
  -H "X-PAYMENT: <base64 signed payment payload>"
```

The envelope it base64-encodes looks like this — swap `network` and the payload
shape to settle on Solana instead:

```json
{ "x402Version": 1, "scheme": "exact", "network": "base-sepolia",
  "payload": { "signature": "0x…", "authorization": { "from": "0x…", "to": "0x40252C…", "value": "2000", "…": "…" } } }
```

```json
{ "x402Version": 1, "scheme": "exact", "network": "solana",
  "payload": { "transaction": "<base64 signed SPL transfer>" } }
```

The server reads `network`, matches it to the rail you were quoted, then verifies
and settles through that rail's facilitator — `x402.org` for Base, PayAI for
Solana.

## 4. HTTP 200 with the artifact and settlement receipt

The 200 body is the itineraries themselves. The `X-PAYMENT-RESPONSE` header is
the base64 settlement receipt:

```bash
curl -si … | grep -i x-payment-response | cut -d' ' -f2 | base64 -d | jq
```

```json
{ "success": true, "rail": "solana", "network": "solana",
  "transaction": "5v8…", "payer": "9xQ…" }
```

`rail` tells you which chain settled it.

## 5. Reading a plan

```bash
curl -s "http://localhost:4024/plan?from=South%20Station&to=Porter&max=2" \
  -H "X-PAYMENT: <base64 payload>" \
  | jq '.itineraries[] | {kind, departure, arrival, durationMinutes,
        legs: [.legs[] | {route: .routeName, headsign, realtime}]}'
```

```json
{
  "kind": "direct",
  "departure": "2026-08-06T23:47:26-04:00",
  "arrival": "2026-08-07T00:03:00-04:00",
  "durationMinutes": 16,
  "legs": [ { "route": "Red Line", "headsign": "Alewife", "realtime": true } ]
}
```

`realtime: false` means the feed had no live update for that trip — only the
`scheduled*` fields are meaningful there. Timestamps carry the agency's local
UTC offset.

## 6. Live delays ($0.001)

```bash
curl -s "http://localhost:4024/delays?stop=South%20Station&route=Red&limit=4" \
  -H "X-PAYMENT: <base64 payload>" | jq '{summary, first: .arrivals[0]}'
```

```json
{
  "summary": {
    "predictions": 4, "withSchedule": 3,
    "onTime": 1, "late": 2, "early": 0,
    "medianDelaySeconds": 648, "worstDelaySeconds": 1194,
    "verdict": "significant-delays"
  },
  "first": {
    "routeName": "Red Line", "headsign": "Alewife",
    "scheduled": "2026-08-06T23:27:00-04:00",
    "predicted": "2026-08-06T23:37:48-04:00",
    "delaySeconds": 648, "delayMinutes": 11, "status": "late",
    "uncertaintySeconds": 60
  }
}
```

`delaySeconds` is the realtime prediction minus the scheduled time for that same
trip — measured from the feed, not modelled. Arrivals with
`status: "unknown"` are added or unscheduled service with no scheduled time to
compare against; `summary.withSchedule` tells you how many could be measured.

## 7. When the feed is down

```json
{
  "error": "upstream_error",
  "message": "Feed GET /predictions timed out after 12000ms",
  "hint": "The public GTFS feed is unreachable or rate-limiting. There is no fixture fallback here by design — you get an error rather than invented departure times."
}
```

HTTP `502`. This service has no fixture mode on purpose: wrong departure times
are worse than no departure times.
