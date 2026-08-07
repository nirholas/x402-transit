/**
 * Transit domain logic over a live public GTFS / GTFS-RT feed.
 *
 *  - `planTrip`  builds direct and one-transfer itineraries from the static
 *                schedule, then overlays realtime predictions where the feed has
 *                them.
 *  - `delaySnapshot` compares realtime predictions against the scheduled times
 *                for the same trips at a stop. That difference *is* the delay —
 *                it is not estimated or modelled.
 *
 * Feeds are keyless and called live; there is no fixture mode. When the upstream
 * feed is down the caller gets a 502 rather than invented data.
 */
import {
  AGENCY_NAME,
  API_BASE,
  UpstreamError,
  attr,
  feedGet,
  indexIncluded,
  nearestStation,
  related,
  relatedId,
  searchStations,
  serviceDate,
  serviceTime,
  type JsonApiResource,
  type Station,
} from "./gtfs.js";

export class BadRequestError extends Error {}
export class NotFoundError extends Error {}
export { UpstreamError };

const LATLON = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

export interface ResolvedPlace {
  stopId: string;
  name: string;
  matchedBy: "stop-id" | "coordinates" | "name";
  latitude?: number;
  longitude?: number;
}

/**
 * Turn a caller's `from`/`to` into a stop id. Accepts a feed stop id
 * (`place-sstat`, `70065`), a `lat,lon` pair, or a station name.
 */
export async function resolvePlace(raw: string, label: string): Promise<ResolvedPlace> {
  const value = raw.trim();
  if (!value) throw new BadRequestError(`${label} is required`);

  const coords = value.match(LATLON);
  if (coords) {
    const lat = Number(coords[1]);
    const lon = Number(coords[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new BadRequestError(`${label} coordinates are out of range`);
    }
    const near = await nearestStation(lat, lon);
    if (!near) throw new NotFoundError(`No station found near ${label}=${value}`);
    return {
      stopId: near.id,
      name: near.name,
      matchedBy: "coordinates",
      latitude: near.latitude,
      longitude: near.longitude,
    };
  }

  // A feed stop id, if the feed knows it.
  if (/^[A-Za-z0-9_.:-]+$/.test(value)) {
    try {
      const doc = await feedGet(`/stops/${encodeURIComponent(value)}`, {});
      const found = (Array.isArray(doc.data) ? doc.data[0] : doc.data) as
        | JsonApiResource
        | undefined;
      if (found?.id) {
        return {
          stopId: found.id,
          name: String(attr<string>(found, "name") ?? found.id),
          matchedBy: "stop-id",
          latitude: attr<number>(found, "latitude"),
          longitude: attr<number>(found, "longitude"),
        };
      }
    } catch {
      // Not a stop id — fall through to a name search.
    }
  }

  const matches = await searchStations(value, 1);
  if (matches.length === 0) {
    throw new NotFoundError(
      `Could not resolve ${label}="${value}". Try a station name, a feed stop id, or "lat,lon". GET /stops?query=… searches names for free.`,
    );
  }
  const s = matches[0];
  return {
    stopId: s.id,
    name: s.name,
    matchedBy: "name",
    latitude: s.latitude,
    longitude: s.longitude,
  };
}

// ————— Trip planning —————

export interface ItineraryLeg {
  routeId: string;
  routeName: string;
  routeType: string;
  headsign: string;
  tripId: string;
  from: { stopId: string; name: string; scheduledDeparture: string | null; predictedDeparture: string | null };
  to: { stopId: string; name: string; scheduledArrival: string | null; predictedArrival: string | null };
  durationMinutes: number | null;
  realtime: boolean;
}

export interface Itinerary {
  kind: "direct" | "one-transfer";
  departure: string | null;
  arrival: string | null;
  durationMinutes: number | null;
  transfers: number;
  legs: ItineraryLeg[];
}

export interface PlanResult {
  source: "gtfs-live";
  agency: string;
  feed: string;
  query: { from: ResolvedPlace; to: ResolvedPlace; departAfter: string; max: number };
  itineraries: Itinerary[];
  note: string;
  retrievedAt: string;
}

const ROUTE_TYPES: Record<string, string> = {
  "0": "light-rail",
  "1": "subway",
  "2": "commuter-rail",
  "3": "bus",
  "4": "ferry",
};

interface ScheduleRow {
  tripId: string;
  stopId: string;
  parentId: string;
  sequence: number;
  arrival: string | null;
  departure: string | null;
  directionId: number;
}

function readSchedules(doc: Awaited<ReturnType<typeof feedGet>>): ScheduleRow[] {
  const index = indexIncluded(doc);
  return doc.data.map((s) => {
    const stop = related(s, "stop", index);
    const parent = stop ? relatedId(stop, "parent_station") : undefined;
    const stopId = relatedId(s, "stop") ?? "";
    return {
      tripId: relatedId(s, "trip") ?? "",
      stopId,
      parentId: parent ?? stopId,
      sequence: Number(attr<number>(s, "stop_sequence") ?? 0),
      arrival: (attr<string>(s, "arrival_time") ?? null) as string | null,
      departure: (attr<string>(s, "departure_time") ?? null) as string | null,
      directionId: Number(attr<number>(s, "direction_id") ?? 0),
    };
  });
}

/** Route ids serving a stop, with their display metadata. */
async function routesAtStop(
  stopId: string,
): Promise<Array<{ id: string; name: string; type: string; sortOrder: number }>> {
  const doc = await feedGet("/routes", { "filter[stop]": stopId });
  return doc.data.map((r) => ({
    id: r.id,
    name: String(attr<string>(r, "long_name") || attr<string>(r, "short_name") || r.id),
    type: ROUTE_TYPES[String(attr<number>(r, "type") ?? "")] ?? "transit",
    sortOrder: Number(attr<number>(r, "sort_order") ?? 0),
  }));
}

/**
 * Direct itineraries on one route: a single schedules call returns rows at both
 * stops, and any trip touching both — origin before destination — is a ride.
 */
async function directLegsOnRoute(
  route: { id: string; name: string; type: string },
  from: ResolvedPlace,
  to: ResolvedPlace,
  departAfter: Date,
  limit: number,
): Promise<ItineraryLeg[]> {
  // Schedule filters are in the agency's local service day, so scope the query
  // to that date and start at the requested departure minute. Without this the
  // feed returns the whole day from ~05:00 and the useful rows fall off the page.
  const doc = await feedGet("/schedules", {
    "filter[stop]": `${from.stopId},${to.stopId}`,
    "filter[route]": route.id,
    "filter[date]": serviceDate(departAfter),
    "filter[min_time]": serviceTime(departAfter),
    sort: "departure_time",
    include: "stop,trip",
    "page[limit]": "400",
  });
  const index = indexIncluded(doc);
  const rows = readSchedules(doc);

  const headsigns = new Map<string, string>();
  for (const s of doc.data) {
    const trip = related(s, "trip", index);
    const tripId = relatedId(s, "trip");
    if (trip && tripId) headsigns.set(tripId, String(attr<string>(trip, "headsign") ?? ""));
  }

  // Group rows by trip, then keep trips that visit origin then destination.
  const byTrip = new Map<string, ScheduleRow[]>();
  for (const r of rows) {
    if (!r.tripId) continue;
    const list = byTrip.get(r.tripId) ?? [];
    list.push(r);
    byTrip.set(r.tripId, list);
  }

  const legs: ItineraryLeg[] = [];
  for (const [tripId, tripRows] of byTrip) {
    const origin = tripRows.find((r) => matchesStop(r, from.stopId));
    const dest = tripRows.find((r) => matchesStop(r, to.stopId));
    if (!origin || !dest) continue;
    if (origin.sequence >= dest.sequence) continue; // wrong direction

    const depart = origin.departure ?? origin.arrival;
    if (!depart) continue;
    if (new Date(depart).getTime() < departAfter.getTime()) continue;

    const arrive = dest.arrival ?? dest.departure;
    legs.push({
      routeId: route.id,
      routeName: route.name,
      routeType: route.type,
      headsign: headsigns.get(tripId) ?? "",
      tripId,
      from: { stopId: origin.stopId, name: from.name, scheduledDeparture: depart, predictedDeparture: null },
      to: { stopId: dest.stopId, name: to.name, scheduledArrival: arrive, predictedArrival: null },
      durationMinutes: minutesBetween(depart, arrive),
      realtime: false,
    });
  }

  legs.sort(
    (a, b) =>
      new Date(a.from.scheduledDeparture ?? 0).getTime() -
      new Date(b.from.scheduledDeparture ?? 0).getTime(),
  );
  return legs.slice(0, limit);
}

/** A schedule row matches a requested stop by its own id or its parent station. */
function matchesStop(row: ScheduleRow, wanted: string): boolean {
  return row.stopId === wanted || row.parentId === wanted;
}

function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

/**
 * Move a feed timestamp by N minutes while keeping its UTC-offset suffix, so
 * every time in a response is expressed in the agency's local zone rather than
 * a mix of local and UTC.
 */
function shiftPreservingOffset(iso: string, minutes: number): string {
  const suffix = iso.match(/([+-]\d{2}:\d{2}|Z)$/)?.[1];
  const shifted = new Date(new Date(iso).getTime() + minutes * 60000);
  if (!suffix || suffix === "Z") return shifted.toISOString();
  const sign = suffix.startsWith("-") ? -1 : 1;
  const [oh, om] = suffix.slice(1).split(":").map(Number);
  const offsetMs = sign * (oh * 60 + om) * 60000;
  return new Date(shifted.getTime() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "") + suffix;
}

/**
 * Overlay realtime predictions onto scheduled legs, so a caller sees both the
 * timetable and what the feed currently expects.
 */
async function applyPredictions(legs: ItineraryLeg[], from: ResolvedPlace): Promise<void> {
  if (legs.length === 0) return;
  try {
    const doc = await feedGet("/predictions", {
      "filter[stop]": from.stopId,
      "page[limit]": "150",
    });
    const byTrip = new Map<string, JsonApiResource>();
    for (const p of doc.data) {
      const tripId = relatedId(p, "trip");
      if (tripId) byTrip.set(tripId, p);
    }
    for (const leg of legs) {
      const p = byTrip.get(leg.tripId);
      if (!p) continue;
      const predicted =
        (attr<string>(p, "departure_time") ?? null) || (attr<string>(p, "arrival_time") ?? null);
      if (!predicted) continue;
      leg.from.predictedDeparture = predicted;
      leg.realtime = true;
      // Shift the scheduled arrival by the same amount the departure moved.
      const drift = minutesBetween(leg.from.scheduledDeparture, predicted);
      if (drift !== null && leg.to.scheduledArrival) {
        leg.to.predictedArrival = shiftPreservingOffset(leg.to.scheduledArrival, drift);
      }
    }
  } catch {
    // Realtime is an enhancement; scheduled itineraries still stand without it.
  }
}

function toItinerary(legs: ItineraryLeg[]): Itinerary {
  const first = legs[0];
  const last = legs[legs.length - 1];
  const departure = first.from.predictedDeparture ?? first.from.scheduledDeparture;
  const arrival = last.to.predictedArrival ?? last.to.scheduledArrival;
  return {
    kind: legs.length === 1 ? "direct" : "one-transfer",
    departure,
    arrival,
    durationMinutes: minutesBetween(departure, arrival),
    transfers: legs.length - 1,
    legs,
  };
}

export async function planTrip(
  from: ResolvedPlace,
  to: ResolvedPlace,
  departAfter: Date,
  max: number,
): Promise<PlanResult> {
  if (from.stopId === to.stopId) {
    throw new BadRequestError("from and to resolve to the same stop");
  }

  const [fromRoutes, toRoutes] = await Promise.all([
    routesAtStop(from.stopId),
    routesAtStop(to.stopId),
  ]);
  const toIds = new Set(toRoutes.map((r) => r.id));
  const shared = fromRoutes.filter((r) => toIds.has(r.id)).sort((a, b) => a.sortOrder - b.sortOrder);

  const itineraries: Itinerary[] = [];
  let note: string;

  if (shared.length > 0) {
    // Direct rides. Cap the routes we expand so one paid call stays bounded.
    const perRoute = Math.max(1, Math.ceil(max / Math.min(shared.length, 3)));
    const legSets = await Promise.all(
      shared.slice(0, 3).map((r) => directLegsOnRoute(r, from, to, departAfter, perRoute)),
    );
    const legs = legSets.flat();
    await applyPredictions(legs, from);
    for (const leg of legs) itineraries.push(toItinerary([leg]));
    note = `${shared.length} route(s) serve both stops directly. Times are scheduled; predictedDeparture/predictedArrival are filled in where the realtime feed has an update for that trip.`;
  } else {
    // No shared route — look for a single interchange between the two stops.
    const transfer = await findTransfer(fromRoutes, toRoutes);
    if (!transfer) {
      note =
        "No direct route and no single-transfer interchange found between these stops in this feed. They may need two or more transfers, or lie on unconnected networks.";
    } else {
      const [firstLegs, secondLegsAll] = await Promise.all([
        directLegsOnRoute(transfer.routeA, from, transfer.point, departAfter, max),
        directLegsOnRoute(transfer.routeB, transfer.point, to, departAfter, max * 3),
      ]);
      await applyPredictions(firstLegs, from);

      for (const first of firstLegs) {
        const arrive = first.to.predictedArrival ?? first.to.scheduledArrival;
        if (!arrive) continue;
        // Allow a couple of minutes to change platforms.
        const readyAt = new Date(new Date(arrive).getTime() + 2 * 60000).getTime();
        const second = secondLegsAll.find(
          (l) =>
            l.from.scheduledDeparture !== null &&
            new Date(l.from.scheduledDeparture).getTime() >= readyAt,
        );
        if (!second) continue;
        itineraries.push(toItinerary([first, second]));
        if (itineraries.length >= max) break;
      }
      note = `No direct route; itineraries transfer at ${transfer.point.name}. A minimum 2-minute connection is enforced.`;
    }
  }

  itineraries.sort((a, b) => new Date(a.departure ?? 0).getTime() - new Date(b.departure ?? 0).getTime());

  return {
    source: "gtfs-live",
    agency: AGENCY_NAME,
    feed: API_BASE,
    query: { from, to, departAfter: departAfter.toISOString(), max },
    itineraries: itineraries.slice(0, max),
    note,
    retrievedAt: new Date().toISOString(),
  };
}

/** Find one interchange stop served by a route at the origin and a route at the destination. */
async function findTransfer(
  fromRoutes: Array<{ id: string; name: string; type: string; sortOrder: number }>,
  toRoutes: Array<{ id: string; name: string; type: string; sortOrder: number }>,
): Promise<{ routeA: { id: string; name: string; type: string }; routeB: { id: string; name: string; type: string }; point: ResolvedPlace } | null> {
  const a = [...fromRoutes].sort((x, y) => x.sortOrder - y.sortOrder).slice(0, 2);
  const b = [...toRoutes].sort((x, y) => x.sortOrder - y.sortOrder).slice(0, 2);
  if (a.length === 0 || b.length === 0) return null;

  const stopSets = new Map<string, Map<string, string>>();
  const loadStops = async (routeId: string): Promise<Map<string, string>> => {
    const cached = stopSets.get(routeId);
    if (cached) return cached;
    const doc = await feedGet("/stops", { "filter[route]": routeId, "page[limit]": "300" });
    const map = new Map<string, string>();
    for (const s of doc.data) {
      const parent = relatedId(s, "parent_station") ?? s.id;
      map.set(parent, String(attr<string>(s, "name") ?? parent));
    }
    stopSets.set(routeId, map);
    return map;
  };

  for (const routeA of a) {
    const stopsA = await loadStops(routeA.id);
    for (const routeB of b) {
      if (routeA.id === routeB.id) continue;
      const stopsB = await loadStops(routeB.id);
      for (const [stopId, name] of stopsA) {
        if (stopsB.has(stopId)) {
          return {
            routeA,
            routeB,
            point: { stopId, name, matchedBy: "stop-id" },
          };
        }
      }
    }
  }
  return null;
}

// ————— Live delay snapshot —————

export interface DelayEntry {
  routeId: string;
  routeName: string;
  tripId: string;
  headsign: string;
  directionId: number;
  stopId: string;
  scheduled: string | null;
  predicted: string | null;
  delaySeconds: number | null;
  delayMinutes: number | null;
  status: "early" | "on-time" | "late" | "unknown";
  uncertaintySeconds: number | null;
}

export interface DelaySnapshot {
  source: "gtfs-rt-live";
  agency: string;
  feed: string;
  query: { stop: ResolvedPlace; routeId: string | null };
  summary: {
    predictions: number;
    withSchedule: number;
    onTime: number;
    late: number;
    early: number;
    medianDelaySeconds: number | null;
    worstDelaySeconds: number | null;
    verdict: "no-data" | "running-well" | "minor-delays" | "significant-delays";
  };
  arrivals: DelayEntry[];
  note: string;
  retrievedAt: string;
}

/** Anything inside this window of schedule counts as on time. */
const ON_TIME_SECONDS = 60;

export async function delaySnapshot(
  stop: ResolvedPlace,
  routeId: string | null,
  limit: number,
): Promise<DelaySnapshot> {
  const params: Record<string, string> = {
    "filter[stop]": stop.stopId,
    include: "schedule,route,trip",
    sort: "arrival_time",
    "page[limit]": String(Math.min(Math.max(limit, 1), 100)),
  };
  if (routeId) params["filter[route]"] = routeId;

  const doc = await feedGet("/predictions", params);
  const index = indexIncluded(doc);

  const arrivals: DelayEntry[] = [];
  for (const p of doc.data) {
    const schedule = related(p, "schedule", index);
    const route = related(p, "route", index);
    const trip = related(p, "trip", index);

    const predicted =
      (attr<string>(p, "arrival_time") ?? null) || (attr<string>(p, "departure_time") ?? null);
    const scheduled = schedule
      ? (attr<string>(schedule, "arrival_time") ?? null) ||
        (attr<string>(schedule, "departure_time") ?? null)
      : null;

    let delaySeconds: number | null = null;
    if (predicted && scheduled) {
      delaySeconds = Math.round((new Date(predicted).getTime() - new Date(scheduled).getTime()) / 1000);
    }

    arrivals.push({
      routeId: relatedId(p, "route") ?? "",
      routeName: String(
        attr<string>(route, "long_name") || attr<string>(route, "short_name") || relatedId(p, "route") || "",
      ),
      tripId: relatedId(p, "trip") ?? "",
      headsign: String(attr<string>(p, "trip_headsign") ?? attr<string>(trip, "headsign") ?? ""),
      directionId: Number(attr<number>(p, "direction_id") ?? 0),
      stopId: relatedId(p, "stop") ?? stop.stopId,
      scheduled,
      predicted,
      delaySeconds,
      delayMinutes: delaySeconds === null ? null : Math.round(delaySeconds / 60),
      status:
        delaySeconds === null
          ? "unknown"
          : delaySeconds < -ON_TIME_SECONDS
            ? "early"
            : delaySeconds > ON_TIME_SECONDS
              ? "late"
              : "on-time",
      uncertaintySeconds:
        (attr<number>(p, "arrival_uncertainty") ?? attr<number>(p, "departure_uncertainty") ?? null) as
          | number
          | null,
    });
  }

  const measured = arrivals.filter((a) => a.delaySeconds !== null).map((a) => a.delaySeconds as number);
  const sorted = [...measured].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const worst = sorted.length ? sorted[sorted.length - 1] : null;
  const late = arrivals.filter((a) => a.status === "late").length;
  const early = arrivals.filter((a) => a.status === "early").length;
  const onTime = arrivals.filter((a) => a.status === "on-time").length;

  const verdict: DelaySnapshot["summary"]["verdict"] =
    measured.length === 0
      ? "no-data"
      : (median ?? 0) > 300
        ? "significant-delays"
        : (median ?? 0) > ON_TIME_SECONDS
          ? "minor-delays"
          : "running-well";

  return {
    source: "gtfs-rt-live",
    agency: AGENCY_NAME,
    feed: API_BASE,
    query: { stop, routeId },
    summary: {
      predictions: arrivals.length,
      withSchedule: measured.length,
      onTime,
      late,
      early,
      medianDelaySeconds: median,
      worstDelaySeconds: worst,
      verdict,
    },
    arrivals,
    note:
      "delaySeconds is the realtime prediction minus the scheduled time for the same trip at this stop — measured from the feed, not modelled. Predictions without a matching scheduled trip (added or unscheduled service) have delaySeconds: null and status: \"unknown\".",
    retrievedAt: new Date().toISOString(),
  };
}

export type { Station };
