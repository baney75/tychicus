/**
 * Joining Local Studio's tunnel (docs/decisions.md, D57; baney75/local-studio docs/tunnel.md). Local Studio owns a machine's one
 * public route on every route (hosted, cloudflare, tailnet) and writes the route record; Tychicus reads it and serves on its port.
 *
 * - `remote join`: read the record, save remote.json on the custom route (`https://<hostname>`, plus the record's aliases), move serve
 *   onto `ports.mcp`, take down any tunnel of Tychicus's own (its Cloudflare service, Funnel or tailnet mounts) without deleting the
 *   Cloudflare tunnel, its credentials or its DNS, which Local Studio adopts, then prove the address from outside. Any failure puts
 *   remote.json, serve and Tychicus's own tunnel back as they were and exits non-zero.
 * - `remote setup` on a machine with Local Studio: with a record it joins; without one it runs `local-studio tunnel setup` with the
 *   route asked for, then joins. Tychicus starts no tunnel of its own there. Local Studio's tunnel setup is dev-channel only: a
 *   stable or nightly build answers `{"state": "waitlist", "message": ...}`, which is passed through unchanged as the result.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { CLOUDFLARE_SERVICE, cloudflareConfigFile, topLevelValue } from "./cloudflare.ts";
import { launcherBinary, launcherValid, which } from "./harness.ts";
import { hubFile } from "./hub-state.ts";
import { passcodeSet } from "./oauth.ts";
import { loadRemoteConfig, type RemoteConfig, remoteFile, saveRemoteConfig } from "./remote-config.ts";
import { funnelOff, openFunnel, proofLines, type SetupOptions, serveWaitMs, tailnetOff, waitForServe } from "./remote-setup.ts";
import { agentStep, EXIT_NEEDS_PERSON, printReport, type SetupReport, setupExitCode } from "./remote-state.ts";
import { type ProofCheck, preloadedHooks, publicChecks } from "./remote-test.ts";
import { localStudioDataDir, type RouteRecord, readRouteRecord, routeRecordFile } from "./route-record.ts";
import { COMMAND_NAME } from "./self.ts";
import { installService, removeService, SERVE_SERVICE, serviceFile, serviceLogHint, serviceOfOtherConfig, writeAtomic } from "./service.ts";
import { applyMounts, planMounts, readServeState, wantedMounts } from "./tailnet.ts";
import { tailscaleBinary } from "./tailscale.ts";
import { c, sym } from "./ui.ts";

/** Is Local Studio on this machine? Its command on PATH, or its data folder ($LOCAL_STUDIO_DATA_DIR or ~/.local-studio). */
export function localStudioPresent(): boolean {
	return which("local-studio") !== undefined || existsSync(localStudioDataDir());
}

/**
 * For Local Studio's adopt step (`remote status --json`): where Tychicus's own Cloudflare tunnel is, by path only. Undefined when
 * this install has no Cloudflare route or no cloudflared.yml. Never reads the credentials file.
 */
export function cloudflareTunnelPaths(config: RemoteConfig | undefined): { tunnelId: string; credentialsFile: string; configFile: string } | undefined {
	if (config?.route !== "cloudflare") return undefined;
	let text: string;
	try {
		text = readFileSync(cloudflareConfigFile(), "utf8");
	} catch {
		return undefined;
	}
	const tunnelId = topLevelValue(text, "tunnel");
	const credentialsFile = topLevelValue(text, "credentials-file");
	return tunnelId && credentialsFile ? { tunnelId, credentialsFile, configFile: cloudflareConfigFile() } : undefined;
}

export interface JoinOptions {
	json?: boolean;
	report?: (report: SetupReport) => void;
	/** False (--no-service): serve is already running by hand on the record's port with the record's address; it isn't installed or restarted. */
	service?: boolean;
	/** Setup's --port: must be the record's ports.mcp. */
	port?: number;
}

function reporter(options: { json?: boolean; report?: (report: SetupReport) => void }) {
	const json = options.json === true || options.report !== undefined;
	const emit = options.report ?? printReport;
	const say = (line: string) => {
		if (!json) console.log(line);
	};
	const finish = (report: SetupReport, checks: ProofCheck[] = [], joined = false): number => {
		if (json) emit({ ...report, step: agentStep(report, joined), ...(checks.length ? { checks } : {}) });
		else {
			for (const line of proofLines(checks)) (report.ok ? console.log : console.error)(line);
			if (report.ok) console.log(`${sym.ok} ${report.message}`);
			else console.error(`${sym.fail} ${report.message}`);
		}
		return setupExitCode(report);
	};
	const fail = (message: string, code: string, checks?: ProofCheck[]) => finish({ ok: false, state: "problem", message, code, passcodeSet: passcodeSet() }, checks);
	/** Local Studio's waitlist answer, passed through unchanged: its message, and its whole report under localStudio. Exit 3: it waits on someone. */
	const waitlist = (answer: Record<string, unknown>): number => {
		const message = typeof answer.message === "string" ? answer.message : "Local Studio's tunnel is waitlist only on this build.";
		if (json) emit({ ok: false, state: "waitlist", step: "waitlist", message, passcodeSet: passcodeSet(), localStudio: answer });
		else console.error(`${sym.warn} ${message}`);
		return EXIT_NEEDS_PERSON;
	};
	return { json, say, finish, fail, waitlist };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The proof for one address: the preloaded test hook when a test loaded one, else `remote test`'s outside checks. */
async function prove(url: string, tailnet: boolean): Promise<ProofCheck[]> {
	const hooks = preloadedHooks();
	return hooks.proof ? hooks.proof(url) : publicChecks(url, { tailnet });
}

export async function remoteJoin(options: JoinOptions = {}): Promise<number> {
	const { say, finish, fail } = reporter(options);
	if (existsSync(hubFile())) return fail(`This install is set up as a hub (${hubFile()}), and an install has one public route. Run ${COMMAND_NAME} hub off first. Nothing was changed.`, "hub");
	const foreign = serviceOfOtherConfig([SERVE_SERVICE, CLOUDFLARE_SERVICE]);
	if (foreign) return fail(foreign.message, foreign.code);
	let record: RouteRecord | undefined;
	try {
		record = readRouteRecord();
	} catch (err) {
		return fail(errorText(err), "route_record");
	}
	if (!record) return fail(`There is no route record (${routeRecordFile()}), so there is no Local Studio tunnel to join. local-studio tunnel setup makes one. Nothing was changed.`, "route_record");
	if (record.owner !== "local-studio") return fail(`${routeRecordFile()} says ${record.owner} runs the route; only Local Studio's route can be joined. Nothing was changed.`, "route_record");
	const port = record.ports.mcp;
	if (options.port !== undefined && options.port !== port) return fail(`Local Studio's route sends /mcp to 127.0.0.1:${port}, not ${options.port}. Run it without --port. Nothing was changed.`, "local_port");
	let previous: RemoteConfig | undefined;
	let previousText: string | undefined;
	try {
		previous = loadRemoteConfig();
		previousText = previous ? readFileSync(remoteFile(), "utf8") : undefined;
	} catch (err) {
		return fail(`${errorText(err)} Nothing was changed; run ${COMMAND_NAME} remote off first.`, "config");
	}
	const publicUrl = `https://${record.hostname}`;
	const aliases = record.aliases ?? [];
	const tailnet = record.route === "tailnet";

	// Plan: everything that can refuse, before anything changes.
	const service = options.service !== false;
	const serveFile = serviceFile(SERVE_SERVICE);
	const serveInstalled = Boolean(serveFile && existsSync(serveFile));
	if (!service && serveInstalled) {
		return fail(`A service from an earlier setup is installed (${serveFile}), and --no-service would leave it running on the old address. Run ${COMMAND_NAME} remote join without --no-service, or ${COMMAND_NAME} remote off first. Nothing was changed.`, "service");
	}
	if (service && !launcherValid()) return fail(`${launcherBinary()} isn't a working launcher, so the service would have nothing to start. Run ${COMMAND_NAME} install first. Nothing was changed.`, "launcher");
	const cloudflareFile = serviceFile(CLOUDFLARE_SERVICE);
	const ownCloudflare = Boolean(cloudflareFile && existsSync(cloudflareFile));
	const ownFunnel = previous?.route === "funnel" ? previous : undefined;
	// On the tailnet, Local Studio's route mounts the same paths to the same port on the same name: those mounts are its now, and stay.
	const sharedMounts = previous?.route === "tailnet" && tailnet && new URL(previous.publicUrl).hostname === record.hostname && previous.port === port;
	const ownTailnet = previous?.route === "tailnet" && !sharedMounts ? previous : undefined;
	const tsBin = tailscaleBinary();
	let funnelDns = "";
	if (ownFunnel || ownTailnet) {
		if (!tsBin) return fail(`Tailscale isn't installed, so this install's ${ownFunnel ? "Funnel" : "tailnet"} route can't be taken down. Nothing was changed.`, "tailscale_missing");
		if (ownFunnel) funnelDns = new URL(ownFunnel.publicUrl).hostname;
	}

	// What this run changed, put back in order on any failure: remote.json, then serve (which reads it), then Tychicus's own tunnel.
	let wroteConfig = false;
	let touchedServe = false;
	let removedCloudflare = false;
	let closedFunnel = false;
	let removedTailnet = false;
	const rollback = async (why: string, code: string, checks?: ProofCheck[]): Promise<number> => {
		const failed: string[] = [];
		if (wroteConfig) {
			try {
				if (previousText === undefined) rmSync(remoteFile(), { force: true });
				else writeAtomic(remoteFile(), previousText, 0o600);
			} catch {
				failed.push("remote.json");
			}
		}
		if (touchedServe && !(serveInstalled ? (await installService()).ok : removeService(SERVE_SERVICE).ok)) failed.push("the serve service");
		if (removedCloudflare && !(await installService(CLOUDFLARE_SERVICE)).ok) failed.push("the Cloudflare tunnel's service");
		if (closedFunnel && ownFunnel && tsBin && (await openFunnel(tsBin, funnelDns, ownFunnel.port)).kind !== "opened") failed.push("Funnel");
		if (removedTailnet && ownTailnet && tsBin) {
			const state = readServeState(tsBin);
			const wanted = wantedMounts(ownTailnet.port);
			const plan = state ? planMounts(state, wanted) : undefined;
			if (!plan?.ok || !applyMounts(tsBin, plan, wanted).ok) failed.push("the tailnet mounts");
		}
		const back = failed.length ? ` Putting back ${failed.join(", ")} failed; run ${COMMAND_NAME} remote status.` : " remote.json, serve and this install's own route were put back as they were.";
		return fail(`${why}${back}`, code, checks);
	};

	saveRemoteConfig({
		publicUrl,
		port,
		route: "custom",
		...(previous?.redirectHosts ? { redirectHosts: previous.redirectHosts } : {}),
		...(previous?.allowHosts ? { allowHosts: previous.allowHosts } : {}),
		...(aliases.length ? { aliases } : {}),
	});
	wroteConfig = true;
	say(`${sym.ok} Wrote ${c.dim(remoteFile())}: ${publicUrl}/mcp on 127.0.0.1:${port}${aliases.length ? `, also answering on ${aliases.join(", ")}` : ""}`);

	if (service) {
		touchedServe = true;
		const installed = await installService();
		if (!installed.ok) return rollback(`The serve service didn't restart on 127.0.0.1:${port}: ${installed.message}.`, "service");
	}
	if (!(await waitForServe(port, publicUrl, serveWaitMs()))) {
		const where = service ? `Look in ${serviceLogHint()}.` : `Start ${COMMAND_NAME} serve --public-url ${publicUrl} --port ${port} first, then run ${COMMAND_NAME} remote join --no-service again.`;
		return rollback(`${COMMAND_NAME} serve isn't answering on 127.0.0.1:${port} with ${publicUrl}/mcp. ${where}`, "serve");
	}
	say(`${sym.ok} serve answers on 127.0.0.1:${port} for ${publicUrl}/mcp`);

	// Tychicus's own route goes away: the machine has one tunnel, Local Studio's. The Cloudflare tunnel, its credentials and DNS stay.
	if (ownCloudflare) {
		const r = removeService(CLOUDFLARE_SERVICE);
		removedCloudflare = r.ok;
		if (!r.ok) return rollback(`This install's Cloudflare tunnel service couldn't be stopped: ${r.failure ?? r.notes.join(" ")}.`, "service");
		say(`${sym.ok} Stopped this install's Cloudflare tunnel service. The tunnel, its credentials and its DNS record stay for Local Studio.`);
	}
	if (ownFunnel) {
		const r = funnelOff(tsBin);
		closedFunnel = r.ok;
		if (!r.ok) return rollback(r.message, "funnel");
		say(`${sym.ok} ${r.message}`);
	}
	if (sharedMounts) say(`${sym.dot} The tailnet mounts on ${record.hostname} send the same paths to the same port, so they stay as Local Studio's route.`);
	if (ownTailnet) {
		const r = tailnetOff(tsBin, ownTailnet);
		removedTailnet = r.ok;
		if (!r.ok) return rollback(r.message, "tailnet");
		say(`${sym.ok} ${r.message}`);
	}

	// The proof, through Local Studio's route alone, for the hostname and each alias.
	say(tailnet ? `\nFrom inside your tailnet, through Local Studio's route:` : `\nFrom the internet, through Local Studio's route:`);
	const all: ProofCheck[] = [];
	for (const url of [publicUrl, ...aliases.map((a) => `https://${a}`)]) {
		const checks = await prove(url, tailnet);
		all.push(...checks.map((check) => (url === publicUrl ? check : { ...check, detail: `${new URL(url).hostname}: ${check.detail}` })));
		const failed = checks.find((check) => check.status === "fail");
		if (failed) return rollback(`${url}/mcp doesn't work through Local Studio's ${record.route} route: ${failed.name} failed (${failed.detail}).`, failed.name, all);
	}
	return finish({
		ok: true,
		state: "on",
		message: `Joined Local Studio's ${record.route} route: ${publicUrl}/mcp reaches serve on 127.0.0.1:${port}${aliases.length ? `, and so ${aliases.length === 1 ? "does" : "do"} ${aliases.map((a) => `https://${a}/mcp`).join(", ")} while connectors move` : ""}. No tunnel of Tychicus's own runs now.`,
		connectorUrl: `${publicUrl}/mcp`,
		passcodeSet: passcodeSet(),
	}, all, true);
}

/**
 * Run `local-studio <args> --json`. Its stdout is one JSON object (`state`, `message`), read here, never shown; its stderr is the
 * person's to see in a terminal. It reads stdin only from a person at a terminal, so an agent's run never waits on a prompt.
 */
function runLocalStudio(bin: string, args: string[], quiet: boolean): Promise<{ code: number; out: string; answer?: Record<string, unknown> }> {
	const person = !quiet && process.stdin.isTTY === true;
	return new Promise((resolve) => {
		const child = spawn(bin, [...args, "--json"], { stdio: [person ? "inherit" : "ignore", "pipe", quiet ? "pipe" : "inherit"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (stdout += d));
		child.stderr?.on("data", (d) => (stderr += d));
		child.on("error", (err) => resolve({ code: 127, out: err.message }));
		child.on("close", (code) => {
			let answer: Record<string, unknown> | undefined;
			try {
				const parsed = JSON.parse(stdout.trim()) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) answer = parsed as Record<string, unknown>;
			} catch {
				answer = undefined;
			}
			const said = typeof answer?.message === "string" ? answer.message : `${stdout}${stderr}`.trim();
			resolve({ code: code ?? 1, out: said, ...(answer ? { answer } : {}) });
		});
	});
}

/**
 * `remote setup` on a machine with Local Studio: Local Studio runs the tunnel. With a route record, join it. Without one, run
 * `local-studio tunnel setup --cloudflare <name>` or `--tailnet`, then join. Funnel and setup without a route aren't Local Studio's.
 */
export async function setupThroughLocalStudio(options: SetupOptions): Promise<number> {
	const { json, say, fail, waitlist } = reporter(options);
	const foreign = serviceOfOtherConfig([SERVE_SERVICE, CLOUDFLARE_SERVICE]);
	if (foreign) return fail(foreign.message, foreign.code);
	let record: RouteRecord | undefined;
	try {
		record = readRouteRecord();
	} catch (err) {
		return fail(errorText(err), "route_record");
	}
	if (record) {
		const asked = options.cloudflare !== undefined ? "cloudflare" : options.tailnet ? "tailnet" : options.tailscale ? "funnel" : undefined;
		if (asked && asked !== record.route) say(`${sym.dot} Local Studio already runs a ${record.route} route for ${record.hostname}; a machine has one tunnel, so ${COMMAND_NAME} joins that one.`);
	} else {
		const args = options.cloudflare ? ["tunnel", "setup", "--cloudflare", options.cloudflare] : options.tailnet ? ["tunnel", "setup", "--tailnet"] : undefined;
		if (!args) {
			return fail(
				`Local Studio is on this machine (${localStudioDataDir()}) and runs its one tunnel, so ${COMMAND_NAME} joins that tunnel instead of starting its own${options.tailscale ? ", and Local Studio doesn't use Funnel" : ""}. Run ${COMMAND_NAME} remote setup --cloudflare <name> (a name on your Cloudflare domain) or --tailnet (your tailnet only). Nothing was changed.`,
				"local_studio",
			);
		}
		const bin = which("local-studio");
		if (!bin) {
			return fail(`Local Studio is on this machine (${localStudioDataDir()}), but its local-studio command isn't on PATH, so its tunnel can't be set up from here. Update Local Studio, then run this again. Nothing was changed.`, "local_studio");
		}
		say(`${sym.dot} Local Studio runs this machine's tunnel. Running: local-studio ${args.join(" ")}`);
		const r = await runLocalStudio(bin, args, json);
		// Stable and nightly Local Studio offer the tunnel by waitlist only: that answer is the result, never a reason to start Tychicus's own.
		if (r.answer?.state === "waitlist") return waitlist(r.answer);
		if (r.code !== 0) {
			return fail(
				`local-studio ${args.join(" ")} failed (exit ${r.code})${r.out ? `: ${r.out.slice(-400)}` : ""}. If it doesn't know the tunnel command, update Local Studio. ${COMMAND_NAME} changed nothing.`,
				"local_studio",
			);
		}
		try {
			record = readRouteRecord();
		} catch (err) {
			return fail(errorText(err), "route_record");
		}
		if (!record) return fail(`local-studio ${args.join(" ")} finished but wrote no route record (${routeRecordFile()}), so there is nothing to join. Update Local Studio. ${COMMAND_NAME} changed nothing.`, "local_studio");
	}
	return remoteJoin({ json: options.json, report: options.report, service: options.service, port: options.port });
}
