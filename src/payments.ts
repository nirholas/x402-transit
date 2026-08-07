/**
 * Dual-rail x402 paywall — pay in USDC on **Base (EVM)** or **Solana**.
 * The client picks the rail; the 402 challenge advertises both.
 *
 * Flow:
 *   1. No `X-PAYMENT` header  → 402 whose `accepts` array holds one payment-
 *      requirements object per enabled rail (Base USDC and Solana USDC).
 *   2. `X-PAYMENT` present    → decode it, select the matching requirements,
 *      then verify + settle through an x402 facilitator.
 *   3. Settled                → `X-PAYMENT-RESPONSE` carries the receipt and the
 *      route handler runs, returning the purchased artifact in the 200 body.
 *   4. Anything else          → 402 again with the reason. A rail whose address
 *      is missing or malformed is dropped from `accepts`, never a crash.
 *
 * Schemas, atomic amounts, and facilitator RPC all come from the official `x402`
 * package, so the wire format matches `x402-express` exactly — x402-fetch, the
 * @three-ws payment modal, or a hand-rolled curl all work against it.
 *
 * This file is intentionally identical in shape across the x402 suite: an agent
 * that can pay one of these services can pay all of them.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  findMatchingPaymentRequirements,
  processPriceToAtomicAmount,
  safeBase64Decode,
  safeBase64Encode,
  toJsonSafe,
} from "x402/shared";
import { useFacilitator } from "x402/verify";
import {
  PaymentPayloadSchema,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  type Resource,
} from "x402/types";

/** Suite default receive addresses. Public receive addresses — safe to ship. */
export const DEFAULT_EVM_PAY_TO = "0x40252CFDF8B20Ed757D61ff157719F33Ec332402";
export const DEFAULT_SOLANA_PAY_TO = "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW";

export const X402_VERSION = 1;

/** One paid route. Keys look like `"GET /search"` or `"GET /buy/:sku"`. */
export interface RouteSpec {
  /** Human price, e.g. `"$0.005"`. Converted to USDC base units (6 decimals). */
  price: string;
  /** Shown in the 402 challenge and in discovery listings. */
  description: string;
  mimeType?: string;
  outputSchema?: Record<string, unknown>;
  maxTimeoutSeconds?: number;
}

export type RoutePrices = Record<string, RouteSpec>;

export interface RailConfig {
  id: "evm" | "solana";
  network: Network;
  payTo: string;
  facilitatorUrl: string;
  /** Solana only: facilitator sponsor account that pays the SOL network fee. */
  feePayer?: string;
}

const env = (key: string, fallback = ""): string => (process.env[key] ?? fallback).trim();

const isEvmAddress = (v: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(v);
/** Base58, 32–44 chars — the shape of a Solana public key. */
const isSolanaAddress = (v: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);

/**
 * Build the enabled rails from the environment. A rail with a missing or
 * malformed address is dropped with a warning — the service keeps selling over
 * whatever rail remains rather than failing to boot.
 */
export function buildRails(): RailConfig[] {
  // Facilitators are rail-specific: x402.org settles base-sepolia only, so the
  // Solana rail defaults to PayAI. Override either with its own env var.
  const facilitator = env("FACILITATOR_URL", "https://x402.org/facilitator");
  const solanaFacilitator = env("SOLANA_FACILITATOR_URL", "https://facilitator.payai.network");
  const out: RailConfig[] = [];

  const evmPayTo = env("PAY_TO_ADDRESS", DEFAULT_EVM_PAY_TO);
  if (isEvmAddress(evmPayTo)) {
    out.push({
      id: "evm",
      network: (env("NETWORK") === "base" ? "base" : "base-sepolia") as Network,
      payTo: evmPayTo,
      facilitatorUrl: facilitator,
    });
  } else {
    console.warn(`[x402] EVM rail disabled — PAY_TO_ADDRESS is not a 0x address: "${evmPayTo}"`);
  }

  const solPayTo = env("SOLANA_PAY_TO_ADDRESS", DEFAULT_SOLANA_PAY_TO);
  if (isSolanaAddress(solPayTo)) {
    const feePayer = env("SOLANA_FEE_PAYER");
    out.push({
      id: "solana",
      network: (env("SOLANA_NETWORK") === "devnet" ? "solana-devnet" : "solana") as Network,
      payTo: solPayTo,
      facilitatorUrl: solanaFacilitator,
      ...(feePayer ? { feePayer } : {}),
    });
  } else {
    console.warn(
      `[x402] Solana rail disabled — SOLANA_PAY_TO_ADDRESS is not base58: "${solPayTo}"`,
    );
  }

  if (out.length === 0) {
    console.warn("[x402] No payment rails enabled — every paid route will answer 402 forever.");
  }
  if (!env("PAY_TO_ADDRESS") || !env("SOLANA_PAY_TO_ADDRESS")) {
    console.log(
      "[x402] Using suite default payTo — set PAY_TO_ADDRESS / SOLANA_PAY_TO_ADDRESS to receive funds yourself.",
    );
  }
  return out;
}

/** `"GET /buy/:sku"` → a method + path matcher. */
function compile(key: string): { method: string; test: (path: string) => boolean } {
  const [rawMethod, rawPath = "/"] = key.trim().split(/\s+/);
  const source =
    "^" +
    rawPath
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/:[A-Za-z0-9_]+/g, "[^/]+")
      .replace(/\*/g, ".*") +
    "/?$";
  const re = new RegExp(source);
  return { method: rawMethod.toUpperCase(), test: (p) => re.test(p) };
}

/** Absolute URL of the resource being purchased — goes into the challenge. */
function resourceUrl(req: Request): Resource {
  const base = env("PUBLIC_BASE_URL") || `${req.protocol}://${req.get("host") ?? "localhost"}`;
  return `${base.replace(/\/$/, "")}${req.originalUrl.split("?")[0]}` as Resource;
}

/** One `accepts` entry: this route, priced on this rail. */
function requirementsFor(
  rail: RailConfig,
  route: RouteSpec,
  resource: Resource,
): PaymentRequirements | null {
  const priced = processPriceToAtomicAmount(route.price, rail.network);
  if ("error" in priced) {
    console.warn(`[x402] cannot price ${route.price} on ${rail.network}: ${priced.error}`);
    return null;
  }
  // EVM carries the token's EIP-712 domain; Solana carries mint metadata plus
  // the sponsor that pays the SOL network fee on the buyer's behalf.
  const asset = priced.asset as { address: string; decimals: number; eip712?: object };
  const extra =
    rail.id === "solana"
      ? {
          name: "USDC",
          decimals: asset.decimals,
          ...(rail.feePayer ? { feePayer: rail.feePayer } : {}),
        }
      : { ...(asset.eip712 ?? {}) };

  return {
    scheme: "exact",
    network: rail.network,
    maxAmountRequired: priced.maxAmountRequired,
    resource,
    description: route.description,
    mimeType: route.mimeType ?? "application/json",
    payTo: rail.payTo,
    maxTimeoutSeconds: route.maxTimeoutSeconds ?? 60,
    asset: priced.asset.address,
    ...(route.outputSchema ? { outputSchema: route.outputSchema } : {}),
    extra,
  } as PaymentRequirements;
}

/**
 * The paywall. Mount once with the whole route map; routes absent from the map
 * are free.
 *
 * ```ts
 * app.use(paywall({ "GET /search": { price: "$0.005", description: "Flight offers" } }));
 * ```
 */
export function paywall(
  routePrices: RoutePrices,
  rails: RailConfig[] = buildRails(),
): RequestHandler {
  const compiled = Object.entries(routePrices).map(([key, route]) => ({
    route,
    ...compile(key),
  }));

  // One facilitator client per distinct URL.
  const clients = new Map<string, ReturnType<typeof useFacilitator>>();
  const clientFor = (url: string): ReturnType<typeof useFacilitator> => {
    let client = clients.get(url);
    if (!client) {
      client = useFacilitator({ url: url as Resource });
      clients.set(url, client);
    }
    return client;
  };

  return async function x402Paywall(req: Request, res: Response, next: NextFunction) {
    const match = compiled.find((c) => c.method === req.method.toUpperCase() && c.test(req.path));
    if (!match) return next(); // free route

    const resource = resourceUrl(req);
    const accepts = rails
      .map((rail) => requirementsFor(rail, match.route, resource))
      .filter((r): r is PaymentRequirements => r !== null);

    const challenge = (error: string): void => {
      res.status(402).json({
        x402Version: X402_VERSION,
        error,
        accepts: accepts.map((a) => toJsonSafe(a)),
      });
    };

    const header = req.header("X-PAYMENT");
    if (!header) {
      return challenge("X-PAYMENT header required — pay in USDC on Base or Solana, your pick.");
    }

    let payload: PaymentPayload;
    try {
      payload = PaymentPayloadSchema.parse(JSON.parse(safeBase64Decode(header)));
    } catch (err) {
      return challenge(`Malformed X-PAYMENT header: ${(err as Error).message}`);
    }

    const selected = findMatchingPaymentRequirements(accepts, payload);
    if (!selected) {
      return challenge(
        `No accepted requirements match network "${payload.network}" / scheme "${payload.scheme}".`,
      );
    }

    const rail = rails.find((r) => r.network === selected.network);
    const facilitator = clientFor(
      rail?.facilitatorUrl ?? env("FACILITATOR_URL", "https://x402.org/facilitator"),
    );

    try {
      const verification = await facilitator.verify(payload, selected);
      if (!verification.isValid) {
        return challenge(`Payment invalid: ${verification.invalidReason ?? "unknown reason"}`);
      }
      const settlement = await facilitator.settle(payload, selected);
      if (!settlement.success) {
        return challenge(`Settlement failed: ${settlement.errorReason ?? "unknown reason"}`);
      }
      res.setHeader(
        "X-PAYMENT-RESPONSE",
        safeBase64Encode(
          JSON.stringify({
            success: true,
            rail: rail?.id ?? "unknown",
            network: settlement.network,
            transaction: settlement.transaction,
            payer: settlement.payer,
          }),
        ),
      );
      res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
    } catch (err) {
      return challenge(`Facilitator error: ${(err as Error).message}`);
    }

    return next();
  };
}

/** One line per rail, for the startup banner. */
export function describeRails(rails: RailConfig[]): string[] {
  return rails.map(
    (r) =>
      `${r.id.padEnd(7)}${String(r.network).padEnd(15)}USDC → ${r.payTo}  via ${r.facilitatorUrl}`,
  );
}
