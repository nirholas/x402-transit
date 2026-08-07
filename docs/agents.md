# For AI agents

How an autonomous agent discovers this service, pays, and what it gets back.

## Discovery

Three artifacts are published for machines:

1. **[`skill.md`](https://github.com/nirholas/x402-transit/blob/main/skill.md)**
   (repo root, also served at `{BASE_URL}/skill.md`) — plain-language
   instructions an LLM can read directly: endpoints, prices, params, response
   schemas, error codes, and budgeting notes.
2. **`{BASE_URL}/.well-known/x402`** — the machine-readable price sheet
   (`x402Version`, `resources[]` with price/networks/asset/input+outputSchema).
   Each resource carries an `accepts[]` array listing **both rails**, so a
   budgeting agent knows before it spends whether it can pay from its Base
   balance, its Solana balance, or either. Registries like
   [x402scan.com](https://x402scan.com), the **x402 Bazaar**, and
   [agentic.market](https://agentic.market) index this format — submit your
   deployment URL there so agents find you without prior knowledge.
3. **`openapi.json`** (OpenAPI 3.1, including the 402 response schema) for
   codegen-style clients.

Every `accepts[]` entry in a 402 also carries an `outputSchema` with two halves:
`input` describes how to build the request (method, path and query parameters)
and `output` is the JSON Schema of the 200 body you get once you have paid. Both
are generated from `openapi.json`, so a single 402 challenge is enough to call
`/plan` or `/delays` correctly without fetching anything else first.

## Protocol version

This service speaks **x402 v1** — `x402Version: 1` in every challenge. That is
what the shipped `x402-fetch` clients expect, so it is the version to code
against today. x402 v2 changes the challenge shape (`extensions.bazaar.schema`,
CAIP-2 network identifiers) and is a planned future upgrade for agentcash
compatibility; it is not served yet.

## Paying — two rails, your pick

Every paid route answers an unpaid request with a 402 whose `accepts[]` array
holds one payment-requirements object per rail:

| Rail | Network | Asset | payTo | Facilitator |
| --- | --- | --- | --- | --- |
| EVM | `base-sepolia` (or `base`) | USDC | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | `x402.org/facilitator` |
| Solana | `solana` (or `solana-devnet`) | USDC | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | `facilitator.payai.network` |

Match on `network`, sign for that chain, and retry with `X-PAYMENT`. The price,
the route, and the returned artifact are identical either way.

### EVM with `x402-fetch`

```ts
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = wrapFetchWithPayment(fetch, privateKeyToAccount(process.env.PRIVATE_KEY), 50_000n);
const res = await payFetch("https://transit.example.com/plan?from=South%20Station&to=Porter");
const { itineraries } = await res.json();   // delivered now, not queued
```

The wrapper handles 402 → sign EIP-3009 USDC authorization → retry. The third
argument caps spend in atomic units: `50_000n` refuses anything over $0.05.

### Solana

```ts
const res = await fetch(url);                        // 402
const { accepts } = await res.json();
const sol = accepts.find(a => a.network.startsWith("solana"));

// Build an SPL USDC transfer of `sol.maxAmountRequired` (atomic, 6 decimals)
// to `sol.payTo` for the mint in `sol.asset`, sign it, and wrap it:
const header = Buffer.from(JSON.stringify({
  x402Version: 1, scheme: "exact", network: sol.network,
  payload: { transaction: signedTxBase64 },
})).toString("base64");

const paid = await fetch(url, { headers: { "X-PAYMENT": header } });
const artifact = await paid.json();
```

If `extra.feePayer` is present on the Solana accept, that sponsor account pays
the SOL network fee — the caller needs only USDC.

## Resolve stops for free first

`GET /stops?query=Porter` turns a name into `place-portr` at no cost, and
`GET /routes?stop=…` gives you a `routeId` for the `/delays` filter. Both paid
routes also accept a bare name or `lat,lon`, so this is a convenience — but
guessing stop ids and paying for 404s is the easiest way to waste money here.

## What you get back

- **`/plan`** — itineraries with full legs: route, headsign, trip id, origin and
  destination stops, scheduled times, realtime predictions where available, and
  per-leg duration.
- **`/delays`** — a per-arrival breakdown plus a summary verdict for the stop.
- The USDC settlement receipt is in the `X-PAYMENT-RESPONSE` response header —
  base64 JSON with `rail` (`evm` | `solana`), `network`, `transaction`, and
  `payer`. Decode with `decodeXPaymentResponse` from `x402-fetch`, or
  `JSON.parse(atob(header))`.

Nothing here is a job you come back for. Every paid response contains the thing
you bought.

## Two fields that determine whether you should trust a time

**`realtime` on a plan leg.** `true` means the feed had a live update for that
trip, so `predictedDeparture` / `predictedArrival` reflect reality. `false` means
you are reading the timetable. Report it as "scheduled", never as "on time".

**`status` on a delay entry.** `"unknown"` with `scheduled: null` is added or
unscheduled service — there is no timetable entry to measure against, so there is
no delay figure. It is not a delay of zero, and it is common. Use
`summary.withSchedule` rather than `summary.predictions` as the denominator when
you characterise how a line is running.

Getting these two wrong is the main way an agent turns correct data into a
confidently wrong answer.

## No fixtures, by design

Unlike the keyed services in this suite, there is no fallback data here. The GTFS
feeds are public and keyless, so they are always called live, and an unreachable
feed produces a `502` with an explanatory `hint`. Treat that as "I don't know"
and retry or degrade — never substitute a timetable guess for it.

## Budgeting

- Stop and route lookup: **free**.
- Plan a trip: **$0.002**.
- Delay snapshot: **$0.001**.
- `/delays` is cheap enough to poll, which makes it the runaway-loop risk. Bound
  the loop in your agent; a per-call spend cap will not catch it.
- Read `maxAmountRequired` from the 402 rather than hardcoding prices, so an
  operator's repricing never surprises you.

## MCP integration

To give Claude these abilities as tools (`find_stop`, `plan_trip`,
`check_delays`, plus a free `service_info`), see
[`examples/mcp-tool.md`](https://github.com/nirholas/x402-transit/blob/main/examples/mcp-tool.md) —
a complete MCP server plus the `claude_desktop_config.json` entry, and the system
prompt lines that keep a model honest about `realtime` and `status`.

## Operator checklist for agent traffic

- Keep `/.well-known/x402` accurate — agents budget from it before paying, and it
  must list both rails if you accept both.
- Keep both `PAY_TO_ADDRESS` and `SOLANA_PAY_TO_ADDRESS` set unless you mean to
  turn a rail off; dropping one halves the wallets that can pay you.
- Set a free `GTFS_API_KEY`. Anonymous feed access is rate-limited, and a
  throttled feed becomes 502s for your paying callers.
- Set `GTFS_TIMEZONE` to the agency's zone if you point at another city —
  schedule queries filter by local service day, and a wrong zone silently returns
  the wrong day's trips.
- Set `PUBLIC_BASE_URL` in production so the `resource` in your 402 matches your
  real URL.
- List the deployment on x402scan.com / the x402 Bazaar / agentic.market.

Questions or listing help: **nichxbt@gmail.com**
