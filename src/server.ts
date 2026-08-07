/**
 * x402-transit — transit trip planning and live delay snapshots from open
 * GTFS / GTFS-RT feeds, priced per query.
 *
 * Free routes:  GET /health, GET /stops, GET /routes, GET /.well-known/x402, GET /skill.md
 * Paid routes:  GET /plan     $0.002  itinerary options
 *               GET /delays   $0.001  live delay snapshot for a stop (optionally one route)
 *
 * The feeds are public and keyless, so both paid routes call a real feed live —
 * there is no fixture mode. Every paid response carries the artifact in its 200
 * body; nothing is queued.
 */
import "dotenv/config";
import express from "express";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRails, describeRails, paywall, type RoutePrices } from "./payments.js";
import { AGENCY_NAME, API_BASE, attr, feedGet, searchStations, stations } from "./gtfs.js";
import {
  BadRequestError,
  NotFoundError,
  UpstreamError,
  delaySnapshot,
  planTrip,
  resolvePlace,
} from "./service.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rails = buildRails();

const PRICES = { plan: "$0.002", delays: "$0.001" } as const;

const routePrices: RoutePrices = {
  "GET /plan": {
    price: PRICES.plan,
    description:
      "Transit itinerary options between two stops — legs, routes, scheduled times, and realtime predictions where the feed has them",
    mimeType: "application/json",
  },
  "GET /delays": {
    price: PRICES.delays,
    description:
      "Live delay snapshot for a stop (optionally one route) — realtime prediction minus scheduled time per upcoming arrival, plus a summary",
    mimeType: "application/json",
  },
};

const app = express();
app.use(express.json());

/** Dual-rail paywall — pay in USDC on Base or Solana, the client picks. */
app.use(paywall(routePrices, rails));

// ————— Free routes —————

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "x402-transit",
    source: "gtfs-live",
    agency: AGENCY_NAME,
    feed: API_BASE,
    rails: rails.map((r) => r.network),
  });
});

/** Free stop lookup, so a caller never pays to discover a stop id. */
app.get("/stops", async (req, res) => {
  try {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    const all = await stations();
    if (!query) {
      res.json({
        agency: AGENCY_NAME,
        note: "Pass ?query= to search by name. These are the feed's parent stations; /plan and /delays also accept a raw stop id or a \"lat,lon\" pair.",
        count: all.length,
        stops: all.slice(0, 50),
      });
      return;
    }
    const matches = await searchStations(query, 25);
    res.json({ agency: AGENCY_NAME, query, count: matches.length, stops: matches });
  } catch (err) {
    handleError(err, res);
  }
});

/** Free route list, so a caller can find a routeId to filter /delays by. */
app.get("/routes", async (req, res) => {
  try {
    const params: Record<string, string> = { "page[limit]": "300" };
    if (typeof req.query.stop === "string" && req.query.stop) params["filter[stop]"] = req.query.stop;
    const doc = await feedGet("/routes", params);
    res.json({
      agency: AGENCY_NAME,
      count: doc.data.length,
      routes: doc.data.map((r) => ({
        routeId: r.id,
        name: attr<string>(r, "long_name") || attr<string>(r, "short_name") || r.id,
        description: attr<string>(r, "description") ?? "",
        type: attr<number>(r, "type") ?? null,
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

// ————— Paid routes —————

app.get("/plan", async (req, res) => {
  try {
    const fromRaw = str(req.query.from);
    const toRaw = str(req.query.to);
    if (!fromRaw || !toRaw) {
      throw new BadRequestError(
        'from and to are required. Each accepts a stop id ("place-sstat"), a station name ("South Station"), or "lat,lon".',
      );
    }
    const max = clamp(Number(req.query.max ?? 3) || 3, 1, 10);
    const departAfter = parseWhen(str(req.query.departAfter));

    const [from, to] = await Promise.all([
      resolvePlace(fromRaw, "from"),
      resolvePlace(toRaw, "to"),
    ]);
    res.json(await planTrip(from, to, departAfter, max));
  } catch (err) {
    handleError(err, res);
  }
});

app.get("/delays", async (req, res) => {
  try {
    const stopRaw = str(req.query.stop);
    if (!stopRaw) {
      throw new BadRequestError(
        'stop is required. It accepts a stop id ("place-sstat"), a station name ("South Station"), or "lat,lon". GET /stops?query=… searches names for free.',
      );
    }
    const routeId = str(req.query.route) ?? null;
    const limit = clamp(Number(req.query.limit ?? 20) || 20, 1, 100);
    const stop = await resolvePlace(stopRaw, "stop");
    res.json(await delaySnapshot(stop, routeId, limit));
  } catch (err) {
    handleError(err, res);
  }
});

// ————— Discovery —————

app.get("/.well-known/x402", (_req, res) => {
  res.type("application/json").sendFile(join(ROOT, "public", ".well-known", "x402"));
});
app.get("/skill.md", (_req, res) => {
  res.type("text/markdown").sendFile(join(ROOT, "skill.md"));
});
app.use(express.static(join(ROOT, "public")));

// ————— helpers —————

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** `departAfter` accepts an ISO timestamp; anything else means "now". */
function parseWhen(raw: string | undefined): Date {
  if (!raw) return new Date();
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new BadRequestError("departAfter must be an ISO 8601 timestamp, e.g. 2026-08-07T14:30:00Z");
  }
  return new Date(t);
}

function handleError(err: unknown, res: express.Response): void {
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: "bad_request", message: err.message });
  } else if (err instanceof NotFoundError) {
    res.status(404).json({ error: "not_found", message: err.message });
  } else if (err instanceof UpstreamError) {
    console.error(err);
    res.status(502).json({
      error: "upstream_error",
      message: err.message,
      hint: "The public GTFS feed is unreachable or rate-limiting. There is no fixture fallback here by design — you get an error rather than invented departure times.",
    });
  } else {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
}

const port = Number(process.env.PORT ?? 4024);
app.listen(port, () => {
  console.log(`\nx402-transit listening on http://localhost:${port}\n`);
  console.log("  Payment rails (USDC — the client picks):");
  for (const line of describeRails(rails)) console.log(`    ${line}`);
  console.log(`\n  Feed: ${API_BASE}`);
  console.log(`  Agency: ${AGENCY_NAME}`);
  console.log("  Public and keyless — called live, no fixture mode.\n");
  console.log("  Free routes:");
  console.log("    GET /health              service + feed");
  console.log("    GET /stops?query=        search stops by name");
  console.log("    GET /routes?stop=        routes, optionally at one stop");
  console.log("    GET /.well-known/x402    machine-readable price sheet");
  console.log("    GET /skill.md            agent instructions\n");
  console.log("  Paid routes (x402, USDC on Base or Solana):");
  console.log(`    GET /plan                ${PRICES.plan}  itinerary options`);
  console.log(`    GET /delays              ${PRICES.delays}  live delay snapshot\n`);
});
