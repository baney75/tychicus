/**
 * The tailnet route (`remote setup --tailnet`, issue #31) on a machine without Local Studio: `tailscale serve` on https 443, never
 * Funnel, so only the person's own tailnet devices reach it. Each of Tychicus's nine paths is its own mount, `--set-path=<p> http://127.0.0.1:<port><p>`, and nothing
 * else on 443 is touched: a path this machine already serves elsewhere is a refusal, and turning it off removes exactly these.
 *
 * What Tailscale does with such a mount (checked on tailscale 1.104.5, docs/remote.md): it matches the mount path and anything
 * below it at a `/` boundary (`/mcp` and `/mcp/x`, never `/mcpx`), strips the mount path and appends the rest to the target's
 * path, so with the target ending in the same path the request path and query arrive unchanged. The Host header arrives as the
 * machine's DNS name with no port (the publicUrl's host, which serve accepts), with X-Forwarded-Host, X-Forwarded-Proto https,
 * X-Forwarded-For (the caller's tailnet address) and Tailscale's identity headers added. A path nothing is mounted on answers 404.
 */
import { TYCHICUS_PATHS } from "./route-record.ts";
import { run } from "./service.ts";

export const TAILNET_HTTPS_PORT = 443;

export interface Mount {
	path: string;
	target: string;
}

type Handler = { Proxy?: string; Path?: string; Text?: string };
export interface ServeState {
	dns: string;
	web: Record<string, { Handlers?: Record<string, Handler> }>;
	tcp: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
	allowFunnel: Record<string, boolean>;
}

export const mountTarget = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;

/** The mounts the route wants: Tychicus's nine paths, each to the same path on serve. */
export function wantedMounts(port: number): Mount[] {
	return TYCHICUS_PATHS.map((path) => ({ path, target: mountTarget(port, path) }));
}

/** What 443 serves for this machine's name, path by path. */
export function handlersOn443(state: ServeState): Record<string, Handler> {
	return state.web[`${state.dns}:${TAILNET_HTTPS_PORT}`]?.Handlers ?? {};
}

/** Is Funnel on for any name's 443 here? Then a mount there would be public, not tailnet-only. */
export const funnelOn443 = (state: ServeState) => Object.entries(state.allowFunnel).some(([hostPort, on]) => on && hostPort.endsWith(`:${TAILNET_HTTPS_PORT}`));

export type MountPlan =
	| { ok: true; add: Mount[]; replace: (Mount & { old: string })[]; keep: Mount[] }
	| { ok: false; code: "tailnet_funnel" | "tailscale_port" | "tailnet_path"; message: string };

/**
 * Everything that can refuse, before anything changes. `wanted` are the mounts the route needs; `replaceable(path, proxy)` says an
 * existing handler is one of ours from before (an earlier port), which this plan moves. Funnel on 443, raw TCP forwarding on 443,
 * and any wanted path already served by something else are refusals.
 */
export function planMounts(state: ServeState, wanted: Mount[], replaceable: (path: string, proxy: string | undefined) => boolean = () => false): MountPlan {
	if (funnelOn443(state)) {
		return { ok: false, code: "tailnet_funnel", message: `Funnel is on for port ${TAILNET_HTTPS_PORT} on this machine, so these paths would be public, not tailnet-only. Nothing was changed. Turn Funnel off for port ${TAILNET_HTTPS_PORT} in Tailscale first.` };
	}
	const tcp = state.tcp[String(TAILNET_HTTPS_PORT)];
	if (tcp && tcp.HTTPS !== true) {
		return { ok: false, code: "tailscale_port", message: `Port ${TAILNET_HTTPS_PORT} on this machine forwards raw TCP${tcp.TCPForward ? ` to ${tcp.TCPForward}` : ""}, so it can't serve these paths. Nothing was changed.` };
	}
	const handlers = handlersOn443(state);
	const add: Mount[] = [];
	const replace: (Mount & { old: string })[] = [];
	const keep: Mount[] = [];
	const taken: string[] = [];
	for (const mount of wanted) {
		const existing = handlers[mount.path];
		if (!existing) add.push(mount);
		else if (existing.Proxy === mount.target) keep.push(mount);
		else if (existing.Proxy !== undefined && replaceable(mount.path, existing.Proxy)) replace.push({ ...mount, old: existing.Proxy });
		else taken.push(`${mount.path} (${existing.Proxy ?? (existing.Path ? `files in ${existing.Path}` : "text")})`);
	}
	if (taken.length) {
		return { ok: false, code: "tailnet_path", message: `Port ${TAILNET_HTTPS_PORT} on this machine already serves ${taken.join(", ")} somewhere else, and the route needs ${taken.length === 1 ? "that path" : "those paths"}. Nothing was changed. Turn ${taken.length === 1 ? "it" : "them"} off in Tailscale first.` };
	}
	return { ok: true, add, replace, keep };
}

/** `tailscale status --json` and `tailscale serve status --json`, read. Undefined when either can't be read or Tailscale isn't connected. */
export function readServeState(bin: string): ServeState | undefined {
	let dns = "";
	try {
		dns = String((JSON.parse(run(bin, ["status", "--json"], 30_000).out) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "").replace(/\.$/, "");
	} catch {
		return undefined;
	}
	if (!dns) return undefined;
	const r = run(bin, ["serve", "status", "--json"], 30_000);
	if (r.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(r.out || "{}") as { Web?: ServeState["web"]; TCP?: ServeState["tcp"]; AllowFunnel?: Record<string, boolean> };
		return { dns, web: parsed.Web ?? {}, tcp: parsed.TCP ?? {}, allowFunnel: parsed.AllowFunnel ?? {} };
	} catch {
		return undefined;
	}
}

const mountOn = (bin: string, mount: Mount) => run(bin, ["serve", "--bg", "--yes", `--https=${TAILNET_HTTPS_PORT}`, `--set-path=${mount.path}`, mount.target], 30_000);

/** Take one mount down. Tailscale refuses to remove a handler that isn't there, which is the state asked for. */
function mountOff(bin: string, path: string): { ok: boolean; out: string } {
	const r = run(bin, ["serve", `--https=${TAILNET_HTTPS_PORT}`, `--set-path=${path}`, "off"], 30_000);
	return { ok: r.code === 0 || /handler does not exist/i.test(r.out), out: r.out };
}

/** Remove these mounts (the caller passes only its own). What was removed, and any failure. */
export function removeMounts(bin: string, mounts: Mount[]): { ok: boolean; removed: string[]; message?: string } {
	const removed: string[] = [];
	const failures: string[] = [];
	for (const mount of mounts) {
		const r = mountOff(bin, mount.path);
		if (r.ok) removed.push(mount.path);
		else failures.push(`${mount.path}: ${r.out}`);
	}
	return failures.length ? { ok: false, removed, message: failures.join("; ") } : { ok: true, removed };
}

/**
 * Carry out a plan, then read 443 back: every wanted mount must point where it should, and Funnel must still be off for 443. On any
 * failure, what this call changed is put back (added mounts removed, moved ones restored) and the answer says what failed.
 */
export function applyMounts(bin: string, plan: Extract<MountPlan, { ok: true }>, wanted: Mount[]): { ok: true } | { ok: false; message: string } {
	const added: Mount[] = [];
	const undone: (Mount & { old: string })[] = [];
	const rollback = (why: string): { ok: false; message: string } => {
		const problems: string[] = [];
		for (const mount of added) if (!mountOff(bin, mount.path).ok) problems.push(mount.path);
		for (const mount of undone) if (mountOn(bin, { path: mount.path, target: mount.old }).code !== 0) problems.push(mount.path);
		return { ok: false, message: problems.length ? `${why} Putting ${problems.join(", ")} back failed too; check tailscale serve status.` : `${why} What this run changed on port ${TAILNET_HTTPS_PORT} was put back.` };
	};
	for (const mount of plan.replace) {
		const r = mountOff(bin, mount.path);
		if (!r.ok) return rollback(`tailscale serve couldn't remove ${mount.path}: ${r.out}.`);
		undone.push(mount);
	}
	for (const mount of [...plan.replace, ...plan.add]) {
		const r = mountOn(bin, mount);
		if (r.code !== 0) return rollback(`tailscale serve couldn't mount ${mount.path}: ${r.out}.`);
		added.push(mount);
	}
	const after = readServeState(bin);
	if (!after) return rollback("tailscale serve status couldn't be read back after the change.");
	if (funnelOn443(after)) return rollback(`Funnel turned on for port ${TAILNET_HTTPS_PORT} while the paths were mounted, so they would be public.`);
	const handlers = handlersOn443(after);
	const wrong = wanted.filter((m) => handlers[m.path]?.Proxy !== m.target).map((m) => m.path);
	if (wrong.length) return rollback(`After the change, ${wrong.join(", ")} ${wrong.length === 1 ? "doesn't" : "don't"} point where ${wrong.length === 1 ? "it" : "they"} should.`);
	return { ok: true };
}
