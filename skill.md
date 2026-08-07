# x402-transit — agent skill

Transit trip planning and live delay snapshots, priced per query. Ask how to get
from one stop to another, or how late the next departures actually are — each as
a single paid HTTP call with the answer in the response body. No account, no API
key: you pay a fifth of a cent in USDC per query over the x402 protocol.

The data comes from **open, keyless GTFS / GTFS-Realtime feeds and is called
live**. The default agency is the MBTA, whose V3 API is a public JSON projection
of its GTFS static feed plus GTFS-Realtime TripUpdates. **There is no fixture
mode** — if the feed is unreachable you get a `502`, never invented departure
times.

**Base URL**: `{BASE_URL}` (e.g. `http://localhost:4024` when self-hosted)

Machine-readable price sheet: `{BASE_URL}/.well-known/x402`

## Naming a stop

Three forms work everywhere a stop is accepted:

| Form | Example |
| --- | --- |
| Feed stop id | `place-sstat`, `70080` |
| Station name | `South Station`, `Porter` |
| Coordinates | `42.3601,-71.0589` (nearest station wins) |

`GET /stops?query=…` searches names **for free** — never pay to discover a stop id.

## Endpoints

### GET /plan — $0.002
Itinerary options between two stops.

| Param | Required | Notes |
| --- | --- | --- |
| `from` | yes | Stop id, station name, or `lat,lon` |
| `to` | yes | Same forms |
| `departAfter` | no | ISO 8601 timestamp; defaults to now |
| `max` | no | 1–10 itineraries, default 3 |

```
GET /plan?from=South%20Station&to=Porter&max=2
```

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

How to read it:

- `kind` is `direct` (one route serves both stops) or `one-transfer`.
- **`realtime` tells you whether to trust the predicted times.** When it is
  `false` the feed had no live update for that trip, and only the `scheduled*`
  fields are meaningful.
- Prefer `predictedDeparture` / `predictedArrival` when present; fall back to the
  `scheduled*` values.
- All timestamps carry the agency's local UTC offset.
- Transfer itineraries enforce a minimum 2-minute connection.
- Two or more transfers are not searched. If the stops need them, `itineraries`
  comes back empty and `note` says so — that is an honest empty answer, not a
  failure.

### GET /delays — $0.001
Live delay snapshot for a stop, optionally filtered to one route.

| Param | Required | Notes |
| --- | --- | --- |
| `stop` | yes | Stop id, station name, or `lat,lon` |
| `route` | no | routeId filter, e.g. `Red`. `GET /routes` lists them free. |
| `limit` | no | 1–100 upcoming arrivals, default 20 |

```
GET /delays?stop=South%20Station&route=Red&limit=4
```

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

How to read it:

- **`delaySeconds` is measured, not modelled**: realtime prediction minus the
  scheduled time for that same trip at that stop.
- `status` is `late` (>60s behind), `early` (>60s ahead), `on-time` (within 60s),
  or `unknown`.
- **`unknown` is common and not an error.** Added or unscheduled service has no
  scheduled time to compare against. `summary.withSchedule` tells you how many of
  the `predictions` could actually be measured — read the verdict against that,
  not against the raw count.
- `verdict` summarises the median: `running-well` (≤60s), `minor-delays`
  (60–300s), `significant-delays` (>300s), or `no-data`.
- `uncertaintySeconds` is the feed's own confidence on that prediction.

### GET /health, GET /stops, GET /routes — free
`/health` reports the feed and agency in use. `/stops?query=` searches station
names. `/routes?stop=` lists routes, optionally just those at one stop — use it
to find a `routeId` for `/delays`.

## Payment

**Pay in USDC on Base or Solana — your client picks the rail.**

- Protocol: **x402** (HTTP 402 → signed USDC authorization → retry with `X-PAYMENT`)
- Asset: **USDC** on both rails
- Facilitators are rail-specific: `https://x402.org/facilitator` settles the EVM
  rail (override: `FACILITATOR_URL`), `https://facilitator.payai.network` settles
  the Solana rail (override: `SOLANA_FACILITATOR_URL`)

| Rail | Network | payTo |
| --- | --- | --- |
| EVM | `base-sepolia` (default) or `base` via `NETWORK=base` | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` |
| Solana | `solana` (default) or `solana-devnet` via `SOLANA_NETWORK=devnet` | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` |

The first unpaid request returns `402` with an `accepts[]` array holding **one
entry per rail**. Pick either, sign for that network, and retry with
`X-PAYMENT: <base64 payload>`:

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header required — pay in USDC on Base or Solana, your pick.",
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402", "maxAmountRequired": "2000",
      "resource": "http://localhost:4024/plan", "mimeType": "application/json" },
    { "scheme": "exact", "network": "solana", "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW", "maxAmountRequired": "2000",
      "resource": "http://localhost:4024/plan", "mimeType": "application/json" }
  ]
}
```

`maxAmountRequired` is atomic USDC (6 decimals): `2000` = $0.002. The settlement
receipt — including which rail settled it — arrives in the `X-PAYMENT-RESPONSE`
response header.

## Errors

| Status | Meaning |
| --- | --- |
| 400 | Missing `from`/`to`/`stop`, malformed `departAfter`, or both places resolve to the same stop |
| 402 | Payment required or payment invalid — body carries `accepts[]` for both rails |
| 404 | A place could not be resolved to a stop in this feed |
| 502 | The public GTFS feed is unreachable or rate-limiting. **There is no fallback by design** — you get an error rather than invented times. |

## Budgeting notes for agents

- Resolving stops is free (`/stops`, `/routes`). Only `/plan` and `/delays` cost.
- A plan is $0.002; a delay look is $0.001. Polling delays is cheap by design —
  bound the loop in your agent, since nothing rate-limits you but the feed.
- Read `maxAmountRequired` from the 402 rather than hardcoding, so an operator's
  repricing never surprises you.

Discovery: this file (`skill.md`, also served at `{BASE_URL}/skill.md`) +
[`/.well-known/x402`]({BASE_URL}/.well-known/x402) + `openapi.json`.

Contact: nichxbt@gmail.com
