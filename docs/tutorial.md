# Tutorial: from clone to your first paid transit query

Install → env → run → first 402 → paid call → reading the artifact → mainnet.

## 1. Install

```bash
git clone https://github.com/nirholas/x402-transit
cd x402-transit
npm install
```

Requires Node 18+.

## 2. Configure

```bash
cp .env.example .env
```

`.env.example` ships with working defaults for **both payment rails**, so the
service runs immediately. Change these two to receive funds yourself:

```
# EVM (Base / Base Sepolia) USDC receive address
PAY_TO_ADDRESS=0x40252CFDF8B20Ed757D61ff157719F33Ec332402
# Solana USDC receive address
SOLANA_PAY_TO_ADDRESS=WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW
```

Every paid route offers both rails and the caller picks. If you only want one,
delete the other address — that rail is dropped from the 402 challenge with a
warning, and the remaining rail keeps working.

### The transit feed needs no key

Unlike the keyed APIs elsewhere in the suite, the GTFS feeds here are public.
The default is the MBTA's V3 API — a JSON projection of its GTFS static feed
plus GTFS-Realtime TripUpdates — and it is called live out of the box.

```
#GTFS_API_BASE=https://api-v3.mbta.com
#GTFS_AGENCY_NAME=MBTA (Massachusetts Bay Transportation Authority)
#GTFS_TIMEZONE=America/New_York
#GTFS_API_KEY=
```

`GTFS_API_KEY` is optional: anonymous requests work, a free key just raises the
rate limit. `GTFS_TIMEZONE` matters because GTFS schedule filters are expressed
in the agency's local service day, not UTC — set it if you point at another city.

**There is no fixture mode here, on purpose.** If the feed is unreachable the
service returns `502`. A wrong departure time is worse than no departure time.

## 3. Run the server

```bash
npm run dev
```

The startup banner shows both rails, the feed in use, and every paid route:

```
  Payment rails (USDC — the client picks):
    evm    base-sepolia   USDC → 0x40252CFDF8B20Ed757D61ff157719F33Ec332402  via https://x402.org/facilitator
    solana solana         USDC → WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW  via https://facilitator.payai.network

  Feed: https://api-v3.mbta.com
  Agency: MBTA (Massachusetts Bay Transportation Authority)
  Public and keyless — called live, no fixture mode.

  Paid routes (x402, USDC on Base or Solana):
    GET /plan                $0.002  itinerary options
    GET /delays              $0.001  live delay snapshot
```

## 4. Find a stop — for free

```bash
curl -s "http://localhost:4024/stops?query=Porter" | jq '.stops[0]'
```

```json
{ "id": "place-portr", "name": "Porter", "latitude": 42.3884, "longitude": -71.119149, "municipality": "Cambridge" }
```

Stop and route lookup is free. Anywhere a stop is accepted you can also pass a
station name (`South Station`) or coordinates (`42.3601,-71.0589`) directly, so
this step is a convenience rather than a requirement.

## 5. Your first 402

```bash
curl -s "http://localhost:4024/plan?from=South%20Station&to=Porter" \
  | jq '.accepts[] | {network, asset, payTo, maxAmountRequired}'
```

```json
{
  "network": "base-sepolia",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
  "maxAmountRequired": "2000"
}
{
  "network": "solana",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
  "maxAmountRequired": "2000"
}
```

`HTTP/1.1 402 Payment Required` with an `accepts[]` array holding **one entry per
rail** — price in atomic USDC (6 decimals, so `2000` = $0.002), the network, the
`payTo` address, and the USDC contract or mint.

## 6. A paid call

### Base (EVM)

You need a wallet with Base Sepolia USDC (free from the
[Circle faucet](https://faucet.circle.com)). Base Sepolia ETH is **not** needed —
x402 uses gasless EIP-3009 transfers.

```bash
export PRIVATE_KEY=0xYourTestKey
npm run client
```

`examples/agent-client.ts` looks up a stop for free, plans South Station → Porter
($0.002), checks live Red Line delays ($0.001), and prints the decoded
`X-PAYMENT-RESPONSE` settlement receipt. Total: a third of a cent.

### Solana

Pick the `solana` entry from `accepts[]` instead, sign an SPL USDC transfer to
its `payTo`, and send the same base64 `X-PAYMENT` envelope. Any Solana-capable
x402 client does this. Both rails end at the same 200 and the same artifact —
only `X-PAYMENT-RESPONSE` differs, naming the rail that settled.

## 7. Reading the artifacts

### `/plan`

```json
{
  "kind": "direct",
  "departure": "2026-08-06T23:47:26-04:00",
  "arrival": "2026-08-07T00:03:00-04:00",
  "durationMinutes": 16,
  "transfers": 0,
  "legs": [
    {
      "routeId": "Red", "routeName": "Red Line", "routeType": "subway",
      "headsign": "Alewife", "tripId": "76734649",
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
```

The field that matters most is **`realtime`**. When it is `true` the feed had a
live update for that trip and the `predicted*` times mean something. When it is
`false` you are looking at the timetable only — say "scheduled", not "on time".

Timestamps carry the agency's local UTC offset. `kind` is `direct` or
`one-transfer`; transfer itineraries enforce a minimum 2-minute connection. Trips
needing two or more transfers are not searched, and you get an empty
`itineraries` array with an explanatory `note` rather than a wrong answer.

### `/delays`

```json
{
  "summary": {
    "predictions": 4, "withSchedule": 3,
    "onTime": 1, "late": 2, "early": 0,
    "medianDelaySeconds": 648, "worstDelaySeconds": 1194,
    "verdict": "significant-delays"
  },
  "arrivals": [
    { "routeName": "Red Line", "headsign": "Alewife",
      "scheduled": "2026-08-06T23:27:00-04:00",
      "predicted": "2026-08-06T23:37:48-04:00",
      "delaySeconds": 648, "delayMinutes": 11, "status": "late" },
    { "routeName": "Red Line", "headsign": "Braintree",
      "scheduled": null, "predicted": "2026-08-06T23:37:15-04:00",
      "delaySeconds": null, "status": "unknown" }
  ]
}
```

`delaySeconds` is the realtime prediction minus the scheduled time for that same
trip at that stop. It is **measured from the feed, not modelled**.

Note the second arrival: `status: "unknown"` with `scheduled: null`. That is
added or unscheduled service — there is no timetable entry to compare against, so
no delay can be computed. It is normal, not an error. `summary.withSchedule`
tells you how many of the `predictions` could actually be measured, which is the
denominator the `verdict` is really about.

## 8. Going to mainnet

```
NETWORK=base                     # EVM rail: base-sepolia -> base mainnet
SOLANA_NETWORK=mainnet-beta      # Solana rail (already the default)
FACILITATOR_URL=https://your-mainnet-facilitator.example   # EVM rail
SOLANA_FACILITATOR_URL=https://facilitator.payai.network    # Solana rail (default)
PUBLIC_BASE_URL=https://transit.example.com
GTFS_API_KEY=<free key, raises the feed rate limit>
```

- Facilitators are rail-specific. `FACILITATOR_URL` must settle Base mainnet
  (e.g. Coinbase CDP's x402 facilitator); `SOLANA_FACILITATOR_URL` must settle
  Solana and defaults to PayAI (`https://facilitator.payai.network`), since
  x402.org does not settle Solana at all.
- `PAY_TO_ADDRESS` and `SOLANA_PAY_TO_ADDRESS` now receive real USDC.
- `PUBLIC_BASE_URL` makes the `resource` field in your 402 quotes match your
  public URL — agents and facilitators check it.
- Get a free `GTFS_API_KEY` before you take real traffic. Anonymous feed access
  is rate-limited, and a throttled feed turns into 502s for your paying callers.

## Pointing at another city

Any agency exposing the same MBTA-style V3 API works:

```
GTFS_API_BASE=https://api.example-transit.org
GTFS_AGENCY_NAME=Example Regional Transit
GTFS_TIMEZONE=America/Los_Angeles
```

Set `GTFS_TIMEZONE` to the agency's zone — schedule queries are filtered by local
service day, and getting it wrong silently returns the wrong day's trips.

## Where to next

- [API reference](api.md)
- [For AI agents](agents.md) — discovery, MCP, listings
- [examples/curl.md](https://github.com/nirholas/x402-transit/blob/main/examples/curl.md) — the raw wire flow
