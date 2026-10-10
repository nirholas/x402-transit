# x402-transit

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![x402](https://img.shields.io/badge/payments-x402-0052ff.svg)](https://x402.org)
[![USDC on Base + Solana](https://img.shields.io/badge/USDC-Base%20%2B%20Solana-2775ca.svg)](https://x402.org)

Transit trip planning and live delay snapshots from **open GTFS / GTFS-Realtime
feeds**, priced per query.

**Pay in USDC on Base or Solana — your client picks the rail.**

## Why x402 for this

The feeds are already open — what is missing is a way to charge for the compute
that turns them into an answer. Planning a trip means resolving stops, finding
shared routes, expanding schedules, and overlaying realtime predictions; that is
several upstream calls and real work per question. The usual way to fund it is an
API key and a monthly plan, which is absurd for an agent that wants to know one
thing once.

x402 makes the price part of the HTTP conversation: the server quotes a fifth of
a cent in the 402, the client signs a USDC transfer and retries, and the 200 body
**is** the itinerary. Stop and route lookup stays free, so you only ever pay for
the part that costs something.

## Quickstart

```bash
git clone https://github.com/nirholas/x402-transit
cd x402-transit && npm install
cp .env.example .env            # ships with working payTo addresses — edit to get paid yourself
npm run dev                     # service at http://localhost:4024
```

**No API key needed** — the transit feed is public and keyless.

Find a stop, free:

```bash
curl -s "http://localhost:4024/stops?query=Porter" | jq '.stops[0]'
```

```json
{ "id": "place-portr", "name": "Porter", "latitude": 42.3884, "longitude": -71.119149, "municipality": "Cambridge" }
```

First 402, no wallet needed:

```bash
curl -s "http://localhost:4024/plan?from=South%20Station&to=Porter" \
  | jq '.accepts[] | {network, payTo, maxAmountRequired}'
```

```json
{ "network": "base-sepolia", "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402", "maxAmountRequired": "2000" }
{ "network": "solana",       "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW", "maxAmountRequired": "2000" }
```

Two rails in one challenge — pay whichever you hold.

Full paid flow (funded Base Sepolia wallet — free USDC at [faucet.circle.com](https://faucet.circle.com)):

```bash
export PRIVATE_KEY=0x…
npm run client
```

## API

| Route | Price | What you get back |
| --- | --- | --- |
| `GET /plan` | $0.002 | Itinerary options — legs, routes, scheduled times, and realtime predictions where the feed has them |
| `GET /delays` | $0.001 | Live delay snapshot for a stop: prediction minus schedule per arrival, plus a summary verdict |
| `GET /health` | free | Feed and agency in use |
| `GET /stops` | free | Search stops by name |
| `GET /routes` | free | Routes, optionally just those at one stop |
| `GET /.well-known/x402` | free | Machine-readable price sheet, both rails |
| `GET /skill.md` | free | Agent-facing instructions |

Anywhere a stop is accepted you can pass a feed stop id (`place-sstat`), a
station name (`South Station`), or coordinates (`42.3601,-71.0589`).

Full details: [docs/api.md](docs/api.md).

## How x402 works

1. `GET /plan` with no payment → **402** + an `accepts[]` array with **one entry per rail** (price, network, payTo, USDC mint/contract).
2. The client picks a rail and signs for it — an EIP-3009 USDC transfer authorization on Base, or an SPL USDC transfer on Solana.
3. Retry with `X-PAYMENT: <base64 signed payload>`.
4. The server verifies + settles through that rail's facilitator and answers **200** with the itineraries. The settlement receipt — tx hash plus which rail settled it — rides in the `X-PAYMENT-RESPONSE` header.

```
GET /plan?…                    402  accepts: [ base-sepolia USDC , solana USDC ]
GET /plan?…  X-PAYMENT: …      200  { source, itineraries: [...] }   +  X-PAYMENT-RESPONSE
```

### Dual-rail configuration

| Rail | Default network | Mainnet switch | payTo env | Facilitator env (default) |
| --- | --- | --- | --- | --- |
| EVM (Base) | `base-sepolia` | `NETWORK=base` | `PAY_TO_ADDRESS` | `FACILITATOR_URL` (`x402.org/facilitator`) |
| Solana | `solana` | already mainnet; `SOLANA_NETWORK=devnet` for testing | `SOLANA_PAY_TO_ADDRESS` | `SOLANA_FACILITATOR_URL` (`facilitator.payai.network`) |

Facilitators are rail-specific: `x402.org` settles base-sepolia and does not
settle Solana at all, which is why the Solana rail defaults to PayAI.

Both addresses default to the x402 Suite's public receive addresses so the demo
runs with zero setup — set your own to receive funds. A rail with a missing or
malformed address is dropped from `accepts` with a warning; the other keeps
working.

## Real backend / API keys

**None required.** The default feed is the MBTA's V3 API — a public, keyless JSON
projection of its GTFS static feed plus GTFS-Realtime TripUpdates — and it is
called live.

| Env | Effect |
| --- | --- |
| `GTFS_API_BASE` | Feed base URL. Default `https://api-v3.mbta.com`. Point at another agency running the same V3 API to switch cities. |
| `GTFS_AGENCY_NAME` | Display name echoed in responses |
| `GTFS_TIMEZONE` | Agency zone, default `America/New_York`. GTFS schedule filters use the local service day, so a wrong zone silently returns the wrong day's trips. |
| `GTFS_API_KEY` | Optional. Anonymous requests work; a free key raises the rate limit. Worth setting before real traffic. |

**There is deliberately no fixture fallback.** Elsewhere in this suite a missing
key degrades to labelled synthetic data; here an unreachable feed returns `502`
with an explanatory hint. A wrong departure time is worse than no departure time.

Two fields carry that honesty into the successful responses too:

- `/plan` marks every leg `realtime: true | false` — `false` means the feed had no
  live update and you are reading the timetable, not a prediction.
- `/delays` reports `status: "unknown"` with `delaySeconds: null` for added or
  unscheduled service that has no schedule to be measured against, and
  `summary.withSchedule` tells you how many predictions could actually be
  measured.

`delaySeconds` itself is the realtime prediction minus the scheduled time for the
same trip at the same stop — measured from the feed, never modelled.

## For AI agents

- **[skill.md](skill.md)** — agent-readable instructions for every endpoint, plus budgeting notes.
- **[/.well-known/x402](public/.well-known/x402)** — machine-readable price sheet with both rails and full input/output schemas, indexable by [x402scan.com](https://x402scan.com), the x402 Bazaar, and [agentic.market](https://agentic.market). List your deployment there so agents can find it.
- **[examples/mcp-tool.md](examples/mcp-tool.md)** — expose the service as MCP tools for Claude, including the system-prompt lines that keep a model honest about `realtime` and `status`.
- **[examples/agent-client.ts](examples/agent-client.ts)** — free stop lookup → plan → delays with `x402-fetch`.
- **[docs/agents.md](docs/agents.md)** — discovery, both payment rails, and what each artifact contains.

## Docs

Site: **https://nirholas.github.io/x402-transit/** —
[tutorial](docs/tutorial.md) · [API reference](docs/api.md) · [for agents](docs/agents.md)

Part of the [x402 Suite](https://github.com/nirholas/x402-suite).

## Support

Questions, bugs, or listing requests: **nichxbt@gmail.com**

## License

[Apache-2.0](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=nirholas/x402-transit&type=Date)](https://www.star-history.com/#nirholas/x402-transit&Date)

<!-- three.ws:growth -->
## Support the project

If x402-transit saves you time, **[star it on GitHub](https://github.com/nirholas/x402-transit)**. Stars are how other developers and AI agents find the repositories worth trusting, and they cost you one click.

Know someone who would use it? [Post on X](https://twitter.com/intent/tweet?text=x402-transit%3A%20Transit%20trip%20planning%20and%20live%20delay%20snapshots%20from%20open%20GTFS%2FGTFS-RT%20feeds%2C%20priced%20per%20query&url=https%3A%2F%2Fgithub.com%2Fnirholas%2Fx402-transit) · [Share on Bluesky](https://bsky.app/intent/compose?text=x402-transit%3A%20Transit%20trip%20planning%20and%20live%20delay%20snapshots%20from%20open%20GTFS%2FGTFS-RT%20feeds%2C%20priced%20per%20query%20https%3A%2F%2Fgithub.com%2Fnirholas%2Fx402-transit) · [Share on LinkedIn](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fgithub.com%2Fnirholas%2Fx402-transit) · [Submit to Hacker News](https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fgithub.com%2Fnirholas%2Fx402-transit&t=x402-transit%3A%20Transit%20trip%20planning%20and%20live%20delay%20snapshots%20from%20open%20GTFS%2FGTFS-RT%20feeds%2C%20priced%20per%20query) · [Share on Reddit](https://www.reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fnirholas%2Fx402-transit&title=x402-transit%3A%20Transit%20trip%20planning%20and%20live%20delay%20snapshots%20from%20open%20GTFS%2FGTFS-RT%20feeds%2C%20priced%20per%20query)

## Built for AI agents too

Coding agents and LLM tooling can read this repo directly: [AGENTS.md](./AGENTS.md), [llms.txt](./llms.txt), [llms-full.txt](./llms-full.txt). Point an agent at `https://github.com/nirholas/x402-transit` and it has the context it needs.

## More from the same author

- [All repositories by nirholas](https://github.com/nirholas/nirholas#readme): the full catalog, grouped by topic
- [three.ws](https://three.ws): the platform for 3D AI agents with Solana wallets, a skill marketplace and x402 payments
- Questions or ideas: [open an issue](https://github.com/nirholas/x402-transit/issues) or [start a discussion](https://github.com/nirholas/x402-transit/discussions)

## Contributors

[![Contributors](https://contrib.rocks/image?repo=nirholas/x402-transit)](https://github.com/nirholas/x402-transit/graphs/contributors)

<!-- /three.ws:growth -->
