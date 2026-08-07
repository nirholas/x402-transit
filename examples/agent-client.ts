/**
 * Agent client example: resolve two stops for free, plan a trip, then check how
 * late the next departures actually are — paying per query with x402.
 *
 * This service is dual-rail: every 402 quotes USDC on **Base** and on **Solana**,
 * and the client picks. `x402-fetch` settles the EVM rail, which is what this
 * example uses; the commented section at the bottom shows the Solana form, and
 * examples/curl.md has the raw wire format for both.
 *
 * Usage:
 *   export PRIVATE_KEY=0x…                  # testnet wallet with Base Sepolia USDC
 *   export BASE_URL=http://localhost:4024   # optional
 *   npm run client
 *
 * Free testnet USDC on Base Sepolia: https://faucet.circle.com
 */
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4024";
const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.error(
    "Set PRIVATE_KEY to a funded Base Sepolia wallet key (free USDC: https://faucet.circle.com)",
  );
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
// Third argument caps spend at 100000 atomic USDC units = $0.10 per call.
const payFetch = wrapFetchWithPayment(fetch, account, 100_000n);

// 1. Free: which feed is this deployment reading?
const health = await (await fetch(`${BASE_URL}/health`)).json();
console.log(`Service: ${health.service}  agency: ${health.agency}`);
console.log(`Feed: ${health.feed}  rails: ${health.rails}`);

// 2. Free: resolve stop names to ids. Never pay for this.
const found = await (await fetch(`${BASE_URL}/stops?query=Porter`)).json();
console.log(`\nFree stop lookup "Porter" → ${found.count} match(es):`);
for (const s of found.stops.slice(0, 3)) {
  console.log(`  ${s.id.padEnd(18)} ${s.name} (${s.municipality})`);
}

// 3. Free: inspect the unpaid 402 to see both rails and the exact price.
const planQuery = "from=South Station&to=Porter&max=2";
const quote = await (await fetch(`${BASE_URL}/plan?${new URLSearchParams(planQuery)}`)).json();
console.log("\n402 quote — accepted rails:");
for (const a of quote.accepts ?? []) {
  console.log(
    `  ${String(a.network).padEnd(14)} ${String(a.maxAmountRequired).padStart(8)} atomic USDC → ${a.payTo}`,
  );
}

// 4. Paid ($0.002): plan the trip.
console.log("\nPlanning South Station → Porter …");
const planRes = await payFetch(`${BASE_URL}/plan?${new URLSearchParams(planQuery)}`);
if (!planRes.ok) {
  console.error(`Plan failed: ${planRes.status}`, await planRes.text());
  process.exit(1);
}
const plan = await planRes.json();
console.log(`${plan.itineraries.length} itinerar(y/ies). ${plan.note}`);
for (const it of plan.itineraries) {
  console.log(`\n  ${it.kind}  ${it.durationMinutes} min, ${it.transfers} transfer(s)`);
  for (const leg of it.legs) {
    // `realtime: false` means the feed had no live update — trust only the schedule.
    const dep = leg.from.predictedDeparture ?? leg.from.scheduledDeparture;
    const arr = leg.to.predictedArrival ?? leg.to.scheduledArrival;
    console.log(
      `    ${leg.routeName} → ${leg.headsign}: ${leg.from.name} ${time(dep)} → ${leg.to.name} ${time(arr)}` +
        `  ${leg.realtime ? "(realtime)" : "(scheduled only)"}`,
    );
  }
}

const receipt = planRes.headers.get("x-payment-response");
if (receipt) {
  console.log("\nX-PAYMENT-RESPONSE (settlement receipt):");
  console.log(JSON.stringify(decodeXPaymentResponse(receipt), null, 2));
}

// 5. Paid ($0.001): how late is the service at the origin right now?
console.log("\nChecking live delays at South Station on the Red Line …");
const delays = await (
  await payFetch(`${BASE_URL}/delays?${new URLSearchParams("stop=South Station&route=Red&limit=6")}`)
).json();
const s = delays.summary;
console.log(
  `  verdict: ${s.verdict}  (${s.withSchedule} of ${s.predictions} predictions had a scheduled time to compare against)`,
);
console.log(`  on-time ${s.onTime} · late ${s.late} · early ${s.early}`);
if (s.medianDelaySeconds !== null) {
  console.log(`  median delay ${Math.round(s.medianDelaySeconds / 60)} min, worst ${Math.round((s.worstDelaySeconds ?? 0) / 60)} min`);
}
for (const a of delays.arrivals.slice(0, 5)) {
  const label =
    a.status === "unknown"
      ? "unknown (added/unscheduled service — nothing to compare against)"
      : `${a.delayMinutes >= 0 ? "+" : ""}${a.delayMinutes} min ${a.status}`;
  console.log(`    ${a.routeName} → ${a.headsign.padEnd(12)} ${time(a.predicted)}  ${label}`);
}

console.log("\nTotal spent this run: $0.003 (plan $0.002 + delays $0.001)");

function time(iso: string | null): string {
  return iso ? iso.slice(11, 16) : "--:--";
}

// ————— Paying on the Solana rail instead —————
//
// Same routes, same prices, same artifacts — only the signature differs. Pick
// the Solana entry out of `accepts`, sign an SPL USDC transfer for it, and send
// the envelope in X-PAYMENT:
//
//   const unpaid = await fetch(`${BASE_URL}/delays?stop=South%20Station`);
//   const { accepts } = await unpaid.json();
//   const sol = accepts.find((a) => String(a.network).startsWith("solana"));
//   //   sol.asset             → the USDC SPL mint
//   //   sol.payTo             → the operator's Solana address
//   //   sol.maxAmountRequired → atomic USDC (6 decimals), e.g. "1000" = $0.001
//   //   sol.extra?.feePayer   → sponsor paying the SOL network fee, if offered
//
//   // Build + sign the SPL transfer with your Solana wallet or @solana/kit,
//   // then base64-wrap it:
//   const header = Buffer.from(JSON.stringify({
//     x402Version: 1,
//     scheme: "exact",
//     network: sol.network,
//     payload: { transaction: signedTxBase64 },
//   })).toString("base64");
//
//   const res = await fetch(`${BASE_URL}/delays?stop=South%20Station`, {
//     headers: { "X-PAYMENT": header },
//   });
//   const snapshot = await res.json();   // identical shape to the EVM path
