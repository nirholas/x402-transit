# API reference

Base URL: your deployment (default `http://localhost:4024`).
Machine-readable versions: [`openapi.json`](https://github.com/nirholas/x402-transit/blob/main/openapi.json) ·
[`/.well-known/x402`](https://github.com/nirholas/x402-transit/blob/main/public/.well-known/x402)

Paid routes speak x402: an unpaid request returns **402** with an `accepts[]`
array holding **one entry per payment rail**; retry with a signed `X-PAYMENT`
header to get **200**.

**Pay in USDC on Base or Solana — your client picks the rail.**

| Rail | Network | Asset | payTo | Facilitator |
| --- | --- | --- | --- | --- |
| EVM | `base-sepolia` (default) / `base` | USDC `0x036CbD…F7e` (sepolia) | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | `x402.org/facilitator` |
| Solana | `solana` (default) / `solana-devnet` | USDC `EPjFWdd5…Dt1v` | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | `facilitator.payai.network` |

Every 402 body looks like this (amounts are atomic USDC, 6 decimals):

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header required — pay in USDC on Base or Solana, your pick.",
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "2000",
      "resource": "http://localhost:4024/plan",
      "description": "Transit itinerary options between two stops — legs, routes, scheduled times, and realtime predictions where the feed has them",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "mimeType": "application/json", "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "version": "2" } },
    { "scheme": "exact", "network": "solana", "maxAmountRequired": "2000",
      "resource": "http://localhost:4024/plan",
      "description": "Transit itinerary options between two stops — legs, routes, scheduled times, and realtime predictions where the feed has them",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "mimeType": "application/json", "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "decimals": 6 } }
  ]
}
```

On success, `X-PAYMENT-RESPONSE` is base64 JSON:
`{ "success": true, "rail": "evm" | "solana", "network", "transaction", "payer" }`.

## Data source

There is **one** source and it is live: an open GTFS / GTFS-Realtime feed,
default MBTA. `source` is `"gtfs-live"` on `/plan` and `"gtfs-rt-live"` on
`/delays`. There is no fixture mode — an unreachable feed returns `502` rather
than invented times.

## Naming a stop

Three forms work anywhere a stop is accepted:

| Form | Example | Notes |
| --- | --- | --- |
| Feed stop id | `place-sstat`, `70080` | Exact |
| Station name | `South Station` | Case-insensitive; exact match wins, then prefix, then substring |
| Coordinates | `42.3601,-71.0589` | Nearest parent station by great-circle distance |

`GET /stops?query=…` searches names for free.

---

## GET /plan — paid, $0.002

Itinerary options between two stops.

| Param | In | Required | Notes |
| --- | --- | --- | --- |
| `from` | query | yes | Stop id, station name, or `lat,lon` |
| `to` | query | yes | Same forms |
| `departAfter` | query | no | ISO 8601 timestamp; defaults to now |
| `max` | query | no | 1–10 itineraries, default 3 |

```
GET /plan?from=South%20Station&to=Porter&max=2
```

**200**

```json
{
  "source": "gtfs-live",
  "agency": "MBTA (Massachusetts Bay Transportation Authority)",
  "feed": "https://api-v3.mbta.com",
  "query": {
    "from": { "stopId": "place-sstat", "name": "South Station", "matchedBy": "name",
              "latitude": 42.352271, "longitude": -71.055242 },
    "to": { "stopId": "place-portr", "name": "Porter", "matchedBy": "name",
            "latitude": 42.3884, "longitude": -71.119149 },
    "departAfter": "2026-08-07T03:37:23.050Z",
    "max": 2
  },
  "itineraries": [
    {
      "kind": "direct",
      "departure": "2026-08-06T23:47:26-04:00",
      "arrival": "2026-08-07T00:03:00-04:00",
      "durationMinutes": 16,
      "transfers": 0,
      "legs": [
        {
          "routeId": "Red",
          "routeName": "Red Line",
          "routeType": "subway",
          "headsign": "Alewife",
          "tripId": "76734649",
          "from": { "stopId": "70080", "name": "South Station",
                    "scheduledDeparture": "2026-08-06T23:45:00-04:00",
                    "predictedDeparture": "2026-08-06T23:47:26-04:00" },
          "to": { "stopId": "70066", "name": "Porter",
                  "scheduledArrival": "2026-08-07T00:01:00-04:00",
                  "predictedArrival": "2026-08-07T00:03:00-04:00" },
          "durationMinutes": 16,
          "realtime": true
        }
      ]
    }
  ],
  "note": "1 route(s) serve both stops directly. Times are scheduled; predictedDeparture/predictedArrival are filled in where the realtime feed has an update for that trip.",
  "retrievedAt": "2026-08-07T03:37:23.577Z"
}
```

Field notes:

- **`realtime`** — `true` when the feed had a live update for that trip, so
  `predictedDeparture` / `predictedArrival` are meaningful. `false` means the
  timetable only.
- `predictedArrival` is the scheduled arrival shifted by the same drift observed
  at the origin, keeping the agency's local UTC offset. It is an inference from
  the feed's departure prediction, not a separate arrival prediction.
- `kind` is `direct` (one route serves both stops) or `one-transfer`.
- `routeType` is `subway` | `light-rail` | `commuter-rail` | `bus` | `ferry` | `transit`.
- Transfer itineraries enforce a minimum 2-minute connection.
- Trips needing **two or more transfers are not searched**. You get an empty
  `itineraries` array and a `note` explaining why — an honest empty answer.
- Up to 3 shared routes are expanded, so one paid call stays bounded.

**Errors**

| Status | Case |
| --- | --- |
| 400 | Missing `from`/`to`, malformed `departAfter`, or both resolve to the same stop |
| 402 | No/invalid payment — body carries `accepts[]` for both rails |
| 404 | A place could not be resolved to a stop in this feed |
| 502 | The public GTFS feed is unreachable or rate-limiting |

---

## GET /delays — paid, $0.001

Live delay snapshot for a stop, optionally filtered to one route.

| Param | In | Required | Notes |
| --- | --- | --- | --- |
| `stop` | query | yes | Stop id, station name, or `lat,lon` |
| `route` | query | no | routeId filter, e.g. `Red` |
| `limit` | query | no | 1–100 upcoming arrivals, default 20 |

```
GET /delays?stop=South%20Station&route=Red&limit=4
```

**200**

```json
{
  "source": "gtfs-rt-live",
  "agency": "MBTA (Massachusetts Bay Transportation Authority)",
  "feed": "https://api-v3.mbta.com",
  "query": { "stop": { "stopId": "place-sstat", "name": "South Station" }, "routeId": "Red" },
  "summary": {
    "predictions": 4,
    "withSchedule": 3,
    "onTime": 1,
    "late": 2,
    "early": 0,
    "medianDelaySeconds": 648,
    "worstDelaySeconds": 1194,
    "verdict": "significant-delays"
  },
  "arrivals": [
    { "routeId": "Red", "routeName": "Red Line", "tripId": "76734535",
      "headsign": "Alewife", "directionId": 1, "stopId": "70080",
      "scheduled": "2026-08-06T23:27:00-04:00",
      "predicted": "2026-08-06T23:37:48-04:00",
      "delaySeconds": 648, "delayMinutes": 11, "status": "late",
      "uncertaintySeconds": 60 },
    { "routeId": "Red", "routeName": "Red Line", "tripId": "ADDED-1584702608",
      "headsign": "Braintree", "directionId": 0, "stopId": "70079",
      "scheduled": null, "predicted": "2026-08-06T23:37:15-04:00",
      "delaySeconds": null, "delayMinutes": null, "status": "unknown",
      "uncertaintySeconds": 60 }
  ],
  "note": "delaySeconds is the realtime prediction minus the scheduled time for the same trip at this stop — measured from the feed, not modelled. Predictions without a matching scheduled trip (added or unscheduled service) have delaySeconds: null and status: \"unknown\".",
  "retrievedAt": "2026-08-07T03:37:23.649Z"
}
```

Field notes:

- **`delaySeconds` is measured, not modelled** — realtime prediction minus the
  scheduled time for that same trip at that stop.
- `status`: `late` (>60s behind), `early` (>60s ahead), `on-time` (within 60s),
  `unknown` (no scheduled time to compare against).
- **`unknown` is normal.** Added or unscheduled service has no timetable entry.
  Use `summary.withSchedule` — not `summary.predictions` — as the denominator
  when reasoning about how the line is running.
- `verdict`: `running-well` (median ≤60s), `minor-delays` (60–300s),
  `significant-delays` (>300s), `no-data` (nothing measurable).
- `uncertaintySeconds` is the feed's own confidence on that prediction.

**Errors**

| Status | Case |
| --- | --- |
| 400 | Missing `stop` |
| 402 | No/invalid payment |
| 404 | The stop could not be resolved in this feed |
| 502 | The public GTFS feed is unreachable or rate-limiting |

---

## GET /health — free

```json
{
  "ok": true,
  "service": "x402-transit",
  "source": "gtfs-live",
  "agency": "MBTA (Massachusetts Bay Transportation Authority)",
  "feed": "https://api-v3.mbta.com",
  "rails": ["base-sepolia", "solana"]
}
```

## GET /stops — free

`?query=` searches parent-station names. Without a query you get the first 50
stations and a count. This exists so a caller never pays to discover a stop id.

```json
{ "id": "place-portr", "name": "Porter", "latitude": 42.3884, "longitude": -71.119149, "municipality": "Cambridge" }
```

## GET /routes — free

All routes, or just those at one stop with `?stop=place-sstat`. Use it to find a
`routeId` for the `/delays` filter.

```json
{ "routeId": "Red", "name": "Red Line", "description": "Rapid Transit", "type": 1 }
```

## GET /.well-known/x402 — free

The x402 discovery manifest: every paid resource with its price, both networks,
an `accepts[]` preview of the live challenge, and input/output schemas.
Index-ready for x402scan.com, the x402 Bazaar, and agentic.market.

## GET /skill.md — free

The agent-facing instruction file, served from the running host.

---

## Upstream errors

```json
{
  "error": "upstream_error",
  "message": "Feed GET /predictions timed out after 12000ms",
  "hint": "The public GTFS feed is unreachable or rate-limiting. There is no fixture fallback here by design — you get an error rather than invented departure times."
}
```

A free `GTFS_API_KEY` raises the feed's rate limit and is worth setting before
taking real traffic.
