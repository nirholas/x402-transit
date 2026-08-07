/**
 * Regenerate `src/schemas.ts` from `public/openapi.json`.
 *
 *     npm run schemas
 *
 * The OpenAPI document is the single source of truth for this service's
 * contract. Two things are derived from it here:
 *
 *  1. `ROUTE_SCHEMAS` — the `outputSchema` pair (`input` + `output`) that the
 *     x402 402 challenge publishes for every paid route, in the x402 Bazaar
 *     `type: "http"` shape. The x402scan discovery spec treats the runtime 402
 *     response as authoritative, so deriving it from the same document is what
 *     keeps runtime and metadata from contradicting each other.
 *  2. `"security": []` on every free operation, which marks those routes as
 *     explicitly public rather than merely undocumented.
 *
 * Local `$ref`s are inlined, because a client reading the 402 challenge has no
 * way to resolve a pointer into a document it has not fetched.
 *
 * Run this after any edit to `public/openapi.json`; the generated file is
 * committed so that neither running the server nor installing the package
 * depends on this script.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

type Json = Record<string, any>;

/** Inline every local `$ref`. A cycle collapses to a plain object, not a hang. */
function deref(node: unknown, root: Json, seen: readonly string[] = []): any {
  if (Array.isArray(node)) return node.map((v) => deref(v, root, seen));
  if (node === null || typeof node !== "object") return node;

  const obj = node as Json;
  const ref = obj.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    if (seen.includes(ref)) {
      return { type: "object", description: `recursive reference to ${ref.split("/").pop()}` };
    }
    let target: any = root;
    for (const part of ref.slice(2).split("/")) {
      target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    const resolved = deref(target, root, [...seen, ref]);
    const siblings = Object.fromEntries(
      Object.entries(obj)
        .filter(([k]) => k !== "$ref")
        .map(([k, v]) => [k, deref(v, root, seen)]),
    );
    return resolved && typeof resolved === "object" && !Array.isArray(resolved)
      ? { ...resolved, ...siblings }
      : resolved;
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deref(v, root, seen)]));
}

/** OpenAPI `/price/{offerId}` + `get` → the paywall's key, `GET /price/:offerId`. */
function routeKey(method: string, path: string): string {
  const converted = path
    .split("/")
    .map((seg) => (seg.startsWith("{") && seg.endsWith("}") ? `:${seg.slice(1, -1)}` : seg))
    .join("/");
  return `${method.toUpperCase()} ${converted}`;
}

/** Prefix a description so a caller can see at a glance what it must supply. */
function markRequired(schema: Json): Json {
  const description = `Required. ${schema.description ?? ""}`.trim();
  return { ...schema, description };
}

/** One OpenAPI parameter → the JSON Schema published for it. */
function paramSchema(param: Json): Json {
  const schema: Json = { ...(param.schema ?? { type: "string" }) };
  if (param.description) schema.description = param.description;
  return schema;
}

function buildInput(op: Json, method: string, root: Json): Json {
  const params: Json[] = (op.parameters ?? []).map((p: Json) => deref(p, root));
  const input: Json = { type: "http", method: method.toUpperCase() };

  // Path parameters are required by construction, so they carry no marker.
  const pathParams = params.filter((p) => p.in === "path");
  if (pathParams.length > 0) {
    input.pathParams = Object.fromEntries(pathParams.map((p) => [p.name, paramSchema(p)]));
  }

  const body = op.requestBody?.content?.["application/json"];
  if (body) {
    const schema: Json = deref(body.schema ?? {}, root);
    const required: string[] = schema.required ?? [];
    input.bodyType = "json";
    input.bodyFields = Object.fromEntries(
      Object.entries<Json>(schema.properties ?? {}).map(([name, value]) => [
        name,
        required.includes(name) ? markRequired(value) : value,
      ]),
    );
    return input;
  }

  input.queryParams = Object.fromEntries(
    params
      .filter((p) => p.in === "query")
      .map((p) => [p.name, p.required ? markRequired(paramSchema(p)) : paramSchema(p)]),
  );
  return input;
}

function buildOutput(op: Json, root: Json): Json {
  const ok: Json = deref(op.responses?.["200"] ?? op.responses?.["201"] ?? {}, root);
  const schema = ok.content?.["application/json"]?.schema;
  if (schema) return schema;
  return { type: "object", description: ok.description ?? "Successful response" };
}

// ————— Generate —————

const openapiPath = join(ROOT, "public", "openapi.json");
const spec: Json = JSON.parse(readFileSync(openapiPath, "utf8"));

const schemas: Record<string, { input: Json; output: Json }> = {};
let freeOps = 0;

for (const [path, operations] of Object.entries<Json>(spec.paths ?? {})) {
  for (const [method, op] of Object.entries<Json>(operations)) {
    if (!HTTP_METHODS.includes(method) || typeof op !== "object" || op === null) continue;
    if (op["x-payment-info"]) {
      schemas[routeKey(method, path)] = {
        input: buildInput(op, method, spec),
        output: buildOutput(op, spec),
      };
    } else if (!("security" in op)) {
      op.security = []; // explicitly public: no auth mode, by design
      freeOps++;
    }
  }
}

if (Object.keys(schemas).length === 0) {
  throw new Error(`No operations carry x-payment-info in ${openapiPath}`);
}

// The document is served verbatim from public/ and mirrored at the repo root.
const serialized = `${JSON.stringify(spec, null, 2)}\n`;
for (const target of [openapiPath, join(ROOT, "openapi.json")]) {
  if (existsSync(target)) writeFileSync(target, serialized);
}

const keyList = Object.keys(schemas)
  .map((k) => ` *   ${k}`)
  .join("\n");

const generated = `/**
 * Per-route request/response contracts published inside the x402 402 challenge.
 *
 * GENERATED FROM \`public/openapi.json\` — do not hand-edit. Run \`npm run schemas\`
 * after changing the OpenAPI document so the runtime challenge and the published
 * metadata cannot drift apart.
 *
 * The x402scan discovery spec requires every \`accepts[]\` entry to carry
 * \`outputSchema.input\` and \`outputSchema.output\`. Together they are how an agent
 * calls a route it has never seen before: \`input\` describes the request in the
 * x402 Bazaar \`type: "http"\` shape, and \`output\` is the JSON Schema of the 200
 * body the agent receives once it has paid. All \`$ref\`s are inlined, since a
 * client reading the challenge has not fetched the OpenAPI document.
 *
 * Keys match the paywall route map exactly:
${keyList}
 */

/**
 * One paid route's published request/response contract.
 *
 * Declared as a type alias rather than an interface so that it keeps an
 * implicit index signature and stays assignable to the paywall's
 * \`outputSchema?: Record<string, unknown>\`.
 */
export type RouteSchema = {
  /** How to call the route: method, path/query parameters or JSON body fields. */
  input: Record<string, unknown>;
  /** JSON Schema of the 200 response body. */
  output: Record<string, unknown>;
};

export const ROUTE_SCHEMAS: Record<string, RouteSchema> = ${JSON.stringify(schemas, null, 2)};
`;

writeFileSync(join(ROOT, "src", "schemas.ts"), generated);

console.log(`openapi.json  security: [] on ${freeOps} free operation(s)`);
console.log(`src/schemas.ts ${Object.keys(schemas).length} paid route(s):`);
for (const key of Object.keys(schemas)) console.log(`  ${key}`);
