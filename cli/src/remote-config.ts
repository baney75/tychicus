/**
 * remote.json: the route `remote setup` saved, which `serve` and the tunnel runner read. A leaf module, so cloudflare.ts can read it
 * without importing remote-setup.ts (which imports cloudflare.ts).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./files.ts";
import { validHostname } from "./route-record.ts";
import { COMMAND_NAME } from "./self.ts";
import { writeAtomic } from "./service.ts";

/**
 * route: funnel (Tailscale Funnel on 8443), custom (the person's own front door, or Local Studio's tunnel joined with `remote join`),
 * cloudflare (a named tunnel on their account) or tailnet (`tailscale serve` on 443, their own tailnet only). aliases: extra
 * hostnames serve answers OAuth on, each as its own https origin, while a connector moves from one name to publicUrl's.
 */
export interface RemoteConfig {
	publicUrl: string;
	port: number;
	route: "funnel" | "custom" | "cloudflare" | "tailnet";
	redirectHosts?: string[];
	allowHosts?: string[];
	aliases?: string[];
}

export const REMOTE_ROUTES: readonly RemoteConfig["route"][] = ["funnel", "custom", "cloudflare", "tailnet"];

export const remoteFile = () => join(configDir(), "remote.json");

const stringList = (value: unknown, field: string): string[] | undefined => {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) throw new Error(`${remoteFile()}: ${field} must be a list of strings.`);
	return value as string[];
};

/**
 * remote.json (or `file`, another config folder's, such as the one a service was set up with), or undefined when it doesn't
 * exist. A file that exists but is wrong throws, so serve never silently drops it.
 */
export function loadRemoteConfig(file: string = remoteFile()): RemoteConfig | undefined {
	if (!existsSync(file)) return undefined;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		throw new Error(`${file} isn't valid JSON. Run ${COMMAND_NAME} remote off to remove it, then ${COMMAND_NAME} remote setup again.`);
	}
	if (!raw || typeof raw !== "object") throw new Error(`${file} isn't a Tychicus remote file.`);
	if (typeof raw.publicUrl !== "string" || !raw.publicUrl) throw new Error(`${file}: publicUrl is missing.`);
	if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) throw new Error(`${file}: port must be a port number.`);
	if (!REMOTE_ROUTES.includes(raw.route as RemoteConfig["route"])) throw new Error(`${file}: route must be funnel, custom, cloudflare or tailnet.`);
	const redirectHosts = stringList(raw.redirectHosts, "redirectHosts");
	const allowHosts = stringList(raw.allowHosts, "allowHosts");
	const aliases = stringList(raw.aliases, "aliases");
	if (aliases?.some((a) => !validHostname(a))) throw new Error(`${file}: aliases must be lowercase DNS names such as old.example.com.`);
	return {
		publicUrl: raw.publicUrl,
		port: raw.port,
		route: raw.route as RemoteConfig["route"],
		...(redirectHosts ? { redirectHosts } : {}),
		...(allowHosts ? { allowHosts } : {}),
		...(aliases?.length ? { aliases } : {}),
	};
}

export function saveRemoteConfig(config: RemoteConfig): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	writeAtomic(remoteFile(), `${JSON.stringify(config, null, "\t")}\n`, 0o600);
}
