/**
 * One public route per machine (docs/decisions.md, D57; baney75/local-studio docs/tunnel.md). Local Studio owns it on every route
 * (hosted, cloudflare, tailnet): it carries Tychicus's nine paths to serve and Local Studio's two to local-studio-serve, and anything
 * else is a 404. Local Studio writes the route record, `<Local Studio data dir>/tunnel/route.json`; Tychicus only reads it, to join
 * that route (`remote join`). A machine without Local Studio keeps Tychicus's own route, with the same exact paths.
 *
 * A leaf module: it imports nothing of Tychicus's, so cloudflare.ts, the tailnet mounts and remote setup all read the same list.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What Tychicus serve answers on the route: MCP and the OAuth paths a connector signs in with. */
export const TYCHICUS_PATHS = [
	"/mcp",
	"/.well-known/oauth-protected-resource",
	"/.well-known/oauth-protected-resource/mcp",
	"/.well-known/oauth-authorization-server",
	"/.well-known/oauth-authorization-server/mcp",
	"/authorize",
	"/token",
	"/register",
	"/revoke",
] as const;

/** What local-studio-serve answers on the route: its health check and the device sync socket. */
export const LOCAL_STUDIO_PATHS = ["/v1/health", "/v1/ws"] as const;

/** The eleven paths of the route, in the order the ingress lists them. */
export const ROUTE_PATHS: readonly string[] = [...TYCHICUS_PATHS, ...LOCAL_STUDIO_PATHS];

/** Local Studio's controller port. It never goes on a public route. */
export const CONTROLLER_PORT = 18091;

const escapeRegex = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An anchored regex that matches exactly these paths (cloudflared's ingress `path` is a Go regexp matched against the path). */
export function exactPathsRegex(paths: readonly string[]): string {
	return `^(?:${paths.map(escapeRegex).join("|")})$`;
}

/** The ingress `path` rule for Tychicus serve: exactly its nine paths. */
export const TYCHICUS_PATH_REGEX = exactPathsRegex(TYCHICUS_PATHS);

export type RouteOwner = "tychicus" | "local-studio";
export type RouteKind = "hosted" | "cloudflare" | "tailnet";

export interface RouteRecord {
	v: 1;
	owner: RouteOwner;
	route: RouteKind;
	hostname: string;
	/** Extra hostnames on the same tunnel with the same paths, kept while a connector moves to `hostname`. */
	aliases?: string[];
	ports: { mcp: number; serve?: number };
}

/** A record that exists and can't be used. Its message names the file. Tychicus never writes or removes it. */
export class RouteRecordError extends Error {}

/** Local Studio's data folder: $LOCAL_STUDIO_DATA_DIR, else ~/.local-studio (Local Studio's core/src/plugins.rs). */
export function localStudioDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const data = env.LOCAL_STUDIO_DATA_DIR;
	return data ? data : join(homedir(), ".local-studio");
}

export const routeRecordFile = () => join(localStudioDataDir(), "tunnel", "route.json");

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A lowercase DNS name with at least one dot, such as studio.example.com. */
export function validHostname(value: string): boolean {
	return value.length <= 253 && value.includes(".") && value === value.toLowerCase() && value.split(".").every((label) => HOSTNAME_LABEL.test(label));
}

/** A port a record may name: an integer from 1024 to 65535, and never the controller's. */
export function routePortProblem(port: unknown): string | undefined {
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) return "must be a port from 1024 to 65535";
	if (port === CONTROLLER_PORT) return `must not be ${CONTROLLER_PORT}, Local Studio's controller`;
	return undefined;
}

/** The record in `raw`, checked field by field. Throws a RouteRecordError naming `file` and the first thing wrong. */
export function validateRouteRecord(raw: unknown, file: string = routeRecordFile()): RouteRecord {
	const bad = (why: string): never => {
		throw new RouteRecordError(`${file} isn't a route record Tychicus can use: ${why}. Nothing was changed.`);
	};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("it isn't a JSON object");
	const r = raw as Record<string, unknown>;
	const extra = Object.keys(r).filter((k) => !["v", "owner", "route", "hostname", "aliases", "ports"].includes(k));
	if (extra.length) bad(`it has fields version 1 doesn't define (${extra.join(", ")})`);
	if (r.v !== 1) bad(`v is ${JSON.stringify(r.v)}, and only version 1 is known`);
	if (r.owner !== "tychicus" && r.owner !== "local-studio") bad("owner must be tychicus or local-studio");
	if (r.route !== "hosted" && r.route !== "cloudflare" && r.route !== "tailnet") bad("route must be hosted, cloudflare or tailnet");
	if (typeof r.hostname !== "string" || !validHostname(r.hostname)) bad("hostname must be a lowercase DNS name such as tychicus.example.com");
	const aliases = r.aliases;
	if (aliases !== undefined) {
		if (!Array.isArray(aliases) || !aliases.every((a) => typeof a === "string" && validHostname(a))) bad("aliases must be a list of lowercase DNS names");
		const list = aliases as string[];
		if (list.includes(r.hostname as string)) bad("aliases must not repeat hostname");
		if (new Set(list).size !== list.length) bad("aliases has the same name twice");
	}
	const ports = r.ports;
	if (!ports || typeof ports !== "object" || Array.isArray(ports)) return bad("ports must be an object with mcp and an optional serve");
	const p = ports as Record<string, unknown>;
	const extraPorts = Object.keys(p).filter((k) => k !== "mcp" && k !== "serve");
	if (extraPorts.length) bad(`ports has fields version 1 doesn't define (${extraPorts.join(", ")})`);
	const mcpProblem = routePortProblem(p.mcp);
	if (mcpProblem) bad(`ports.mcp ${mcpProblem}`);
	if (p.serve !== undefined) {
		const serveProblem = routePortProblem(p.serve);
		if (serveProblem) bad(`ports.serve ${serveProblem}`);
		if (p.serve === p.mcp) bad("ports.serve and ports.mcp must be different ports");
	}
	return {
		v: 1,
		owner: r.owner as RouteOwner,
		route: r.route as RouteKind,
		hostname: r.hostname as string,
		...(aliases !== undefined ? { aliases: aliases as string[] } : {}),
		ports: { mcp: p.mcp as number, ...(p.serve !== undefined ? { serve: p.serve as number } : {}) },
	};
}

/** The record, or undefined when there is none. A file that exists and isn't a valid record throws a RouteRecordError. */
export function readRouteRecord(file: string = routeRecordFile()): RouteRecord | undefined {
	if (!existsSync(file)) return undefined;
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		throw new RouteRecordError(`${file} can't be read (${err instanceof Error ? err.message : String(err)}). Nothing was changed.`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new RouteRecordError(`${file} isn't valid JSON, so it isn't a route record Tychicus can use. Nothing was changed.`);
	}
	return validateRouteRecord(raw, file);
}
