/**
 * Public GTFS / GTFS-RT feed adapter.
 *
 * The default agency is the **MBTA**, whose V3 API is a public, keyless JSON
 * projection of its GTFS static feed plus its GTFS-Realtime TripUpdates. That
 * means this service calls a real feed live out of the box — there is no fixture
 * mode and no API key to obtain.
 *
 * Set `GTFS_API_BASE` to point at another agency running the same MBTA-style V3
 * API. `GTFS_API_KEY` is optional everywhere: the MBTA serves anonymous requests
 * at a lower rate limit, and a free key simply raises it.
 */

export const API_BASE = (process.env.GTFS_API_BASE ?? "https://api-v3.mbta.com").replace(/\/$/, "");
export const AGENCY_NAME = process.env.GTFS_AGENCY_NAME ?? "MBTA (Massachusetts Bay Transportation Authority)";

const TIMEOUT_MS = Number(process.env.GTFS_TIMEOUT_MS ?? 12_000);

export class UpstreamError extends Error {}

/** JSON:API document shape — only the parts we read. */
export interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}

export interface JsonApiDoc {
  data: JsonApiResource[];
  included?: JsonApiResource[];
}

/**
 * GET a feed endpoint. Query values are URL-encoded, including the `filter[...]`
 * bracket syntax the V3 API uses.
 */
export async function feedGet(path: string, params: Record<string, string>): Promise<JsonApiDoc> {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = { Accept: "application/vnd.api+json" };
  if (process.env.GTFS_API_KEY) headers["x-api-key"] = process.env.GTFS_API_KEY;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new UpstreamError(`Feed GET ${path} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    const doc = (await res.json()) as Partial<JsonApiDoc>;
    return { data: doc.data ?? [], included: doc.included ?? [] };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new UpstreamError(`Feed GET ${path} timed out after ${TIMEOUT_MS}ms`);
    }
    throw new UpstreamError(`Feed GET ${path} failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Index `included[]` by `type:id` so relationships can be resolved cheaply. */
export function indexIncluded(doc: JsonApiDoc): Map<string, JsonApiResource> {
  const map = new Map<string, JsonApiResource>();
  for (const r of doc.included ?? []) map.set(`${r.type}:${r.id}`, r);
  return map;
}

export function related(
  resource: JsonApiResource,
  name: string,
  index: Map<string, JsonApiResource>,
): JsonApiResource | undefined {
  const ref = resource.relationships?.[name]?.data;
  if (!ref) return undefined;
  return index.get(`${ref.type}:${ref.id}`);
}

export function relatedId(resource: JsonApiResource, name: string): string | undefined {
  return resource.relationships?.[name]?.data?.id ?? undefined;
}

export function attr<T>(resource: JsonApiResource | undefined, name: string): T | undefined {
  return resource?.attributes?.[name] as T | undefined;
}

// ————— Parent-station cache, for resolving human stop names —————

export interface Station {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  municipality: string;
}

let stationCache: { stations: Station[]; fetchedAt: number } | null = null;
const STATION_TTL_MS = 60 * 60 * 1000; // static GTFS data; an hour is plenty

/** All parent stations in the feed. Cached for an hour — this is static data. */
export async function stations(): Promise<Station[]> {
  if (stationCache && Date.now() - stationCache.fetchedAt < STATION_TTL_MS) {
    return stationCache.stations;
  }
  const doc = await feedGet("/stops", { "filter[location_type]": "1", "page[limit]": "500" });
  const stations = doc.data.map((s) => ({
    id: s.id,
    name: String(attr<string>(s, "name") ?? s.id),
    latitude: Number(attr<number>(s, "latitude") ?? 0),
    longitude: Number(attr<number>(s, "longitude") ?? 0),
    municipality: String(attr<string>(s, "municipality") ?? ""),
  }));
  stationCache = { stations, fetchedAt: Date.now() };
  return stations;
}

/** Case-insensitive substring search over station names. */
export async function searchStations(query: string, limit = 10): Promise<Station[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = await stations();
  const exact = all.filter((s) => s.name.toLowerCase() === q);
  const prefix = all.filter((s) => s.name.toLowerCase().startsWith(q) && !exact.includes(s));
  const contains = all.filter(
    (s) => s.name.toLowerCase().includes(q) && !exact.includes(s) && !prefix.includes(s),
  );
  return [...exact, ...prefix, ...contains].slice(0, limit);
}

/** Nearest station to a coordinate, by great-circle distance. */
export async function nearestStation(lat: number, lon: number): Promise<Station | undefined> {
  const all = await stations();
  let best: Station | undefined;
  let bestDist = Infinity;
  for (const s of all) {
    const d = haversineKm(lat, lon, s.latitude, s.longitude);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

// ————— agency-local time —————

/**
 * GTFS schedule filters are expressed in the agency's local service day, not
 * UTC. Default is the MBTA's zone; override with `GTFS_TIMEZONE` when pointing
 * at another agency.
 */
export const AGENCY_TIMEZONE = process.env.GTFS_TIMEZONE ?? "America/New_York";

function localParts(when: Date): { date: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: AGENCY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(when).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** The agency service date (`YYYY-MM-DD`) for a moment in time. */
export function serviceDate(when: Date): string {
  return localParts(when).date;
}

/** `HH:MM` in agency-local time, for the feed's `filter[min_time]`. */
export function serviceTime(when: Date): string {
  const { hour, minute } = localParts(when);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
