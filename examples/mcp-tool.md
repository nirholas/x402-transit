# Exposing x402-transit as an MCP tool for Claude

Any MCP server can wrap this service so Claude (or another MCP client) can plan
transit trips and check live delays with a funded wallet. The pattern: one tool
per route, `x402-fetch` for payment, the artifact returned as the tool result.

The service is dual-rail — every 402 quotes USDC on **Base** and on **Solana**.
`x402-fetch` settles the EVM rail, which is what this server uses; swap in a
Solana x402 client if your agent's wallet holds USDC there instead. Nothing else
changes: same routes, same prices, same artifacts.

## Minimal MCP server (TypeScript)

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.TRANSIT_URL ?? "http://localhost:4024";
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
// Cap each call at $0.05 so a polling loop can never run away.
const payFetch = wrapFetchWithPayment(fetch, account, 50_000n);

const server = new McpServer({ name: "x402-transit", version: "0.1.0" });

// Free — resolve names to stop ids before spending anything.
server.tool(
  "find_stop",
  "Search transit stops by name. Free — always use this before plan_trip or check_delays.",
  { query: z.string().describe("Part of a station name, e.g. 'Porter'") },
  async ({ query }) => {
    const r = await fetch(`${BASE_URL}/stops?query=${encodeURIComponent(query)}`);
    return { content: [{ type: "text", text: await r.text() }] };
  },
);

server.tool(
  "plan_trip",
  "Plan a transit trip between two stops. Returns direct or one-transfer itineraries with scheduled and realtime times. Costs $0.002 in USDC.",
  {
    from: z.string().describe("Stop id, station name, or 'lat,lon'"),
    to: z.string().describe("Stop id, station name, or 'lat,lon'"),
    departAfter: z.string().optional().describe("ISO 8601 timestamp; defaults to now"),
    max: z.number().int().min(1).max(10).optional(),
  },
  async ({ from, to, departAfter, max }) => {
    const qs = new URLSearchParams({ from, to });
    if (departAfter) qs.set("departAfter", departAfter);
    if (max) qs.set("max", String(max));
    const r = await payFetch(`${BASE_URL}/plan?${qs}`);
    return { content: [{ type: "text", text: await r.text() }] };
  },
);

server.tool(
  "check_delays",
  "Live delay snapshot for a stop: realtime prediction minus scheduled time per upcoming arrival, plus a summary verdict. Costs $0.001 in USDC.",
  {
    stop: z.string().describe("Stop id, station name, or 'lat,lon'"),
    route: z.string().optional().describe("Optional routeId filter, e.g. 'Red'"),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async ({ stop, route, limit }) => {
    const qs = new URLSearchParams({ stop });
    if (route) qs.set("route", route);
    if (limit) qs.set("limit", String(limit));
    const r = await payFetch(`${BASE_URL}/delays?${qs}`);
    return { content: [{ type: "text", text: await r.text() }] };
  },
);

// Free — which feed and agency is this deployment reading?
server.tool("service_info", "Feed, agency, and accepted payment rails (free)", {}, async () => {
  const r = await fetch(`${BASE_URL}/health`);
  return { content: [{ type: "text", text: await r.text() }] };
});

await server.connect(new StdioServerTransport());
```

## claude_desktop_config.json

```json
{
  "mcpServers": {
    "x402-transit": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-server.ts"],
      "env": {
        "TRANSIT_URL": "http://localhost:4024",
        "PRIVATE_KEY": "0x… funded Base Sepolia key"
      }
    }
  }
}
```

## Two things to put in your system prompt

**Use `find_stop` first.** It is free, and it turns "Porter" into `place-portr`.
A model that guesses stop ids will burn paid calls on 404s.

**Respect `realtime` and `status`.** In a plan, `realtime: false` on a leg means
the feed had no live update for that trip — only the `scheduled*` times mean
anything, and the model should say "scheduled" rather than implying it knows the
train is on time. In a delay snapshot, `status: "unknown"` is added or
unscheduled service with nothing to compare against; it is not a delay of zero.
`summary.withSchedule` says how many predictions could actually be measured.

## Spending safety

`wrapFetchWithPayment(fetch, account, 50_000n)` refuses any single call above
$0.05. `check_delays` is the one to watch: at $0.001 it is cheap enough that a
model can happily poll it in a loop, so bound the loop in your agent rather than
relying on the per-call cap. For budgets, per-merchant caps, and approval
thresholds see the x402-agent-wallet pattern in the
[x402 Suite](https://github.com/nirholas/x402-suite).
