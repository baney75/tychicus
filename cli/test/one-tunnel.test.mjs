// One tunnel per machine (docs/decisions.md, D57). Local Studio owns it on every route and writes the route record; Tychicus only
// reads the record and joins (`remote join`), and `remote setup` defers to `local-studio tunnel setup` where Local Studio is. Without
// Local Studio, Tychicus keeps its own route with the same exact paths: a Cloudflare ingress of its nine paths, or the tailnet route.
// Serve answers OAuth on each alias host as its own address. tailscale, cloudflared, local-studio, launchctl and systemctl are stubs in
// a temp HOME; nothing here touches a real Tailscale, Cloudflare, service manager, ~/.config/tychicus or ~/.local-studio.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTs } from "./helpers/bundle-ts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const JOIN_HOOKS = join(here, "helpers", "join-proof-hooks.mjs");
const root = mkdtempSync(join(tmpdir(), "tychicus-one-tunnel-"));
after(() => rmSync(root, { recursive: true, force: true }));

const unixOnly = process.platform === "win32" && "the stub tools are #! scripts, which Windows cannot run";
// .invalid never resolves, so a tailnet proof's system lookup answers at once and never reaches a real tailnet.
const DNS = "box.tail0000.invalid";
const STUDIO = "studio.example.com";
const OLD = "old.example.com";
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const TYCHICUS_PATHS = [
	"/mcp",
	"/.well-known/oauth-protected-resource",
	"/.well-known/oauth-protected-resource/mcp",
	"/.well-known/oauth-authorization-server",
	"/.well-known/oauth-authorization-server/mcp",
	"/authorize",
	"/token",
	"/register",
	"/revoke",
];
const STUDIO_PATHS = ["/v1/health", "/v1/ws"];

const mod = await loadTs(`
export * as record from "@src/route-record.ts";
export { cloudflareIngress, renderCloudflareConfig } from "@src/cloudflare.ts";
export { planMounts, wantedMounts } from "@src/tailnet.ts";
export { tailnetDnsCheck } from "@src/remote-test.ts";
export { agentStep } from "@src/remote-state.ts";
export { oauthForHost } from "@src/oauth.ts";
`);

// ---------- the record: read only ----------

const good = { v: 1, owner: "local-studio", route: "cloudflare", hostname: STUDIO, aliases: [OLD], ports: { mcp: 8787, serve: 18094 } };

test("the path list is the eleven paths of the route, Tychicus's nine and Local Studio's two", () => {
	assert.deepEqual([...mod.record.TYCHICUS_PATHS], TYCHICUS_PATHS);
	assert.deepEqual([...mod.record.LOCAL_STUDIO_PATHS], STUDIO_PATHS);
	assert.deepEqual([...mod.record.ROUTE_PATHS], [...TYCHICUS_PATHS, ...STUDIO_PATHS]);
});

test("Tychicus only reads the record: no write or remove, and a malformed record is refused naming its file", () => {
	assert.equal(mod.record.writeRouteRecord, undefined);
	assert.equal(mod.record.removeRouteRecord, undefined);
	const v = (raw) => mod.record.validateRouteRecord(raw, "/x/route.json");
	assert.deepEqual(v(good), good);
	const { aliases, ...noAliases } = good;
	assert.deepEqual(v(noAliases), noAliases, "aliases are optional");
	assert.deepEqual(v({ ...good, ports: { mcp: 8787 } }).ports, { mcp: 8787 });
	const bad = [
		[null, /isn't a JSON object/],
		[{ ...good, v: 2 }, /only version 1/],
		[{ ...good, extra: true }, /fields version 1 doesn't define \(extra\)/],
		[{ ...good, owner: "someone" }, /owner must be/],
		[{ ...good, route: "funnel" }, /route must be hosted, cloudflare or tailnet/],
		[{ ...good, hostname: "Studio.Example.com" }, /hostname must be/],
		[{ ...good, aliases: "old.example.com" }, /aliases must be a list/],
		[{ ...good, aliases: ["https://old.example.com"] }, /aliases must be a list of lowercase DNS names/],
		[{ ...good, aliases: [STUDIO] }, /aliases must not repeat hostname/],
		[{ ...good, aliases: [OLD, OLD] }, /same name twice/],
		[{ ...good, ports: { mcp: 80 } }, /ports\.mcp must be a port from 1024 to 65535/],
		[{ ...good, ports: { mcp: 18091 } }, /must not be 18091/],
		[{ ...good, ports: { mcp: 8787, serve: 8787 } }, /must be different ports/],
		[{ ...good, ports: { mcp: 8787, controller: 1 } }, /ports has fields version 1 doesn't define/],
	];
	for (const [raw, why] of bad) assert.throws(() => v(raw), (err) => err instanceof mod.record.RouteRecordError && why.test(err.message) && err.message.includes("/x/route.json"), JSON.stringify(raw));
	const file = join(root, "read", "route.json");
	assert.equal(mod.record.readRouteRecord(file), undefined);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "{not json");
	assert.throws(() => mod.record.readRouteRecord(file), (err) => err instanceof mod.record.RouteRecordError && err.message.includes(file));
});

// ---------- the agent step ----------

test("every setup and join report names the agent's next step", () => {
	const s = mod.agentStep;
	assert.equal(s({ ok: true, state: "on" }), "ready");
	assert.equal(s({ ok: true, state: "on" }, true), "joined");
	assert.equal(s({ ok: false, state: "waitlist" }), "waitlist");
	assert.equal(s({ ok: false, state: "tailscale_signed_out" }), "needs_signin");
	assert.equal(s({ ok: false, state: "problem", code: "cloudflare_login" }), "needs_signin");
	assert.equal(s({ ok: false, state: "problem", next: { kind: "sign_in" } }), "needs_signin");
	for (const code of ["dns", "dns_lookup", "cloudflare_dns", "cloudflare_zone"]) assert.equal(s({ ok: false, state: "problem", code }), "needs_dns", code);
	assert.equal(s({ ok: false, state: "problem", code: "service" }), "error");
	assert.equal(s({ ok: false, state: "cloudflared_missing" }), "error");
});

// ---------- the Cloudflare ingress, for Tychicus's own route ----------

test("the ingress regex matches exactly Tychicus's nine paths and refuses Local Studio's two and every neighbor", () => {
	const tychicus = new RegExp(mod.record.TYCHICUS_PATH_REGEX);
	for (const path of TYCHICUS_PATHS) assert.ok(tychicus.test(path), path);
	for (const path of [...STUDIO_PATHS, "/", "/mcpx", "/mcp/x", "/v1/healthz", "/v1/ws/x", "/.well-known/openid-configuration", "/xmcp", "/token/", "/.well-known/oauth-protected-resourcex", "/authorizeX"]) {
		assert.ok(!tychicus.test(path), path);
	}
	// cloudflared reads it as a Go regexp: only syntax RE2 and JavaScript read the same way.
	assert.doesNotMatch(mod.record.TYCHICUS_PATH_REGEX, /\(\?[=!<]|\\[dDsSwWbB]/);
});

const HEAD = ["tunnel: c0ffee00-1234-4abc-8def-0123456789ab", "credentials-file: /kept/imported/c0ffee00.json", "logfile: /kept/cloudflared.log", "no-autoupdate: true"];
const OLD_INGRESS = ["ingress:", "  - hostname: tychicus.example.com", "    service: http://127.0.0.1:8787", "  - service: http_status:404", ""];

test("rendering keeps every line but the ingress, which becomes the nine paths then 404", () => {
	const r = mod.renderCloudflareConfig([...HEAD, ...OLD_INGRESS].join("\n"), "tychicus.example.com", 8787);
	assert.equal(r.ok, true);
	assert.equal(r.text, [...HEAD, "ingress:", "  - hostname: tychicus.example.com", `    path: ${mod.record.TYCHICUS_PATH_REGEX}`, "    service: http://127.0.0.1:8787", "  - service: http_status:404", ""].join("\n"));
	assert.equal(mod.renderCloudflareConfig(r.text, "tychicus.example.com", 8787).text, r.text, "rendering is stable");
	const later = mod.renderCloudflareConfig([...HEAD.slice(0, 2), ...OLD_INGRESS.slice(0, -1), "protocol: http2", ""].join("\n"), "tychicus.example.com", 9000);
	assert.match(later.text, /^protocol: http2$/m, "a key after the ingress block stays");
	assert.match(later.text, /^no-autoupdate: true$/m);
	const headless = mod.renderCloudflareConfig("ingress:\n  - service: http_status:404\n", "tychicus.example.com", 8787);
	assert.equal(headless.ok, false);
	assert.match(headless.message, /no tunnel: or credentials-file: line/);
});

// ---------- the CLI, with stub tools ----------

/** A stub `tailscale`: serve status is a JSON file it keeps, so mounts and `off` behave the way tailscale 1.104 does. */
const TAILSCALE_STUB = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [state, log, opts] = [process.env.TS_STATE, process.env.TS_LOG, JSON.parse(process.env.TS_OPTS || "{}")];
const args = process.argv.slice(2);
appendFileSync(log, "tailscale " + args.join(" ") + "\\n");
const key = opts.dns + ":443";
const s = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {};
if (args[0] === "status") { console.log(opts.signedOut ? "{}" : JSON.stringify({ Self: { DNSName: opts.dns + "." } })); process.exit(0); }
if (args[0] === "lock") { console.log("Tailnet lock is NOT enabled."); process.exit(0); }
if (args[0] === "serve" && args[1] === "status") { console.log(JSON.stringify(s, null, 2)); process.exit(0); }
if (args[0] === "serve") {
	const path = (args.find((a) => a.startsWith("--set-path=")) || "").slice(11);
	if (args[args.length - 1] === "off") {
		const handlers = s.Web?.[key]?.Handlers;
		if ((opts.failOff || []).includes(path)) { console.error("error: something broke"); process.exit(1); }
		if (!handlers?.[path]) { console.error("error: failed to remove web serve: handler does not exist"); process.exit(1); }
		delete handlers[path];
		if (!Object.keys(handlers).length) { delete s.Web[key]; if (!Object.keys(s.Web).length) delete s.Web; if (s.TCP) { delete s.TCP["443"]; if (!Object.keys(s.TCP).length) delete s.TCP; } }
		writeFileSync(state, JSON.stringify(s));
		process.exit(0);
	}
	if ((opts.failMount || []).includes(path)) { console.error("error: something broke"); process.exit(1); }
	s.TCP = { ...s.TCP, 443: { HTTPS: true } };
	s.Web = s.Web || {};
	s.Web[key] = s.Web[key] || { Handlers: {} };
	s.Web[key].Handlers[path] = { Proxy: args[args.length - 1] };
	writeFileSync(state, JSON.stringify(s));
	process.exit(0);
}
process.exit(0);
`;

function scenario(name, { tailscale = true, ts = {}, serveState } = {}) {
	const dir = join(root, name);
	const bin = join(dir, "bin");
	const home = join(dir, "home");
	const log = join(dir, "calls.log");
	const studio = join(dir, "studio");
	mkdirSync(bin, { recursive: true });
	mkdirSync(home, { recursive: true });
	symlinkSync(process.execPath, join(bin, "node"));
	const script = (file, body) => {
		writeFileSync(join(bin, file), `#!/bin/sh\n${body}`);
		chmodSync(join(bin, file), 0o755);
	};
	const tsState = join(dir, "ts-state.json");
	if (serveState) writeFileSync(tsState, JSON.stringify(serveState));
	if (tailscale) {
		writeFileSync(join(dir, "tailscale-stub.mjs"), TAILSCALE_STUB);
		script("tailscale", `exec "${process.execPath}" "${join(dir, "tailscale-stub.mjs")}" "$@"\n`);
	}
	script("launchctl", `echo "launchctl $*" >> ${log}\ncase "$1" in\nprint) echo "state = running" ;;\nesac\n`);
	script("systemctl", `echo "systemctl $*" >> ${log}\ncase "$2" in\nis-active) echo active ;;\nesac\n`);
	script("cloudflared", `echo "cloudflared $*" >> ${log}\nexit 0\n`);
	const sock = join(dir, "sock");
	mkdirSync(sock, { recursive: true, mode: 0o700 });
	const env = {
		HOME: home,
		TABKYRA_CONFIG_DIR: join(home, "cfg"),
		TABKYRA_SOCKET_DIR: sock,
		TABKYRA_APPLICATIONS_DIR: join(dir, "apps"),
		TABKYRA_DOH_URL: "http://127.0.0.1:9/dns-query",
		TABKYRA_SERVE_WAIT_MS: "3000",
		LOCAL_STUDIO_DATA_DIR: studio,
		NO_COLOR: "1",
		PATH: bin,
		TS_STATE: tsState,
		TS_LOG: log,
		TS_OPTS: JSON.stringify({ dns: DNS, ...ts }),
		JOIN_PROOF_LOG: join(dir, "proved.log"),
	};
	mkdirSync(env.TABKYRA_CONFIG_DIR, { recursive: true });
	const runAsync = (args, extra = {}, { hooks = false } = {}) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [...(hooks ? ["--import", JOIN_HOOKS] : []), cli, ...args], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("close", (code) => resolve({ code, stdout, stderr, out: stdout + stderr, json: () => JSON.parse(stdout) }));
		});
	const recordFile = join(studio, "tunnel", "route.json");
	const remoteJson = join(env.TABKYRA_CONFIG_DIR, "remote.json");
	const serviceFileOf = (which) =>
		process.platform === "darwin" ? join(home, "Library", "LaunchAgents", `com.tychicus.${which}.plist`) : join(home, ".config", "systemd", "user", `tychicus-${which}.service`);
	return {
		dir,
		home,
		env,
		script,
		runAsync,
		studio,
		config: env.TABKYRA_CONFIG_DIR,
		recordFile,
		serviceFileOf,
		launcher: () => {
			const path = join(env.TABKYRA_CONFIG_DIR, "tychicus");
			writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
			chmodSync(path, 0o755);
			return path;
		},
		writeRecord: (r) => {
			mkdirSync(dirname(recordFile), { recursive: true, mode: 0o700 });
			writeFileSync(recordFile, JSON.stringify(r), { mode: 0o600 });
		},
		remoteJsonText: () => (existsSync(remoteJson) ? readFileSync(remoteJson, "utf8") : undefined),
		remoteJson: () => (existsSync(remoteJson) ? JSON.parse(readFileSync(remoteJson, "utf8")) : undefined),
		serve: () => (existsSync(tsState) ? JSON.parse(readFileSync(tsState, "utf8")) : {}),
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
		proved: () => (existsSync(env.JOIN_PROOF_LOG) ? readFileSync(env.JOIN_PROOF_LOG, "utf8").split("\n").filter(Boolean) : []),
	};
}

/** A loopback stand-in for serve: protected-resource metadata naming `resource`, and POST /mcp answering 401 with WWW-Authenticate. */
async function localServe(resource) {
	const srv = createServer((req, res) => {
		if (req.url === METADATA_PATH && req.method === "GET") {
			res.setHeader("content-type", "application/json");
			return res.end(JSON.stringify({ resource }));
		}
		if (req.url === "/mcp") {
			req.resume();
			res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${resource.replace(/\/mcp$/, "")}${METADATA_PATH}"` });
			return res.end("{}");
		}
		res.statusCode = 404;
		res.end();
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	return { port: srv.address().port, close: () => new Promise((resolve) => srv.close(resolve)) };
}

const handlers = (s) => s.serve().Web?.[`${DNS}:443`]?.Handlers ?? {};
const mountCalls = (s) => s.calls().filter((x) => /^tailscale serve (--bg|--https)/.test(x));

// ---------- the tailnet route, standalone ----------

test("tailnet planning refuses Funnel on 443, raw TCP on 443 and a path served elsewhere; keeps and moves its own", () => {
	const state = (web = {}, extra = {}) => ({ dns: DNS, web: { [`${DNS}:443`]: { Handlers: web } }, tcp: {}, allowFunnel: {}, ...extra });
	const wanted = mod.wantedMounts(8787);
	assert.deepEqual(
		wanted.map((m) => `${m.path} ${m.target}`),
		TYCHICUS_PATHS.map((p) => `${p} http://127.0.0.1:8787${p}`),
		"Tychicus's nine paths only, never /v1",
	);
	assert.equal(mod.planMounts(state(), wanted).add.length, 9);
	assert.equal(mod.planMounts(state({}, { allowFunnel: { [`${DNS}:443`]: true } }), wanted).code, "tailnet_funnel");
	assert.equal(mod.planMounts(state({}, { tcp: { 443: { TCPForward: "127.0.0.1:22" } } }), wanted).code, "tailscale_port");
	const taken = mod.planMounts(state({ "/token": { Proxy: "http://127.0.0.1:3000" } }), wanted);
	assert.equal(taken.code, "tailnet_path");
	assert.match(taken.message, /\/token \(http:\/\/127\.0\.0\.1:3000\)/);
	assert.equal(mod.planMounts(state({ "/mcp": { Path: "/srv/www" } }), wanted).code, "tailnet_path");
	const shared = mod.planMounts(state({ "/": { Proxy: "http://127.0.0.1:3000" }, "/mcp": { Proxy: "http://127.0.0.1:8787/mcp" } }), wanted);
	assert.deepEqual(shared.keep.map((m) => m.path), ["/mcp"]);
	assert.equal(shared.add.length, 8);
	const moved = mod.planMounts(state({ "/mcp": { Proxy: "http://127.0.0.1:9000/mcp" } }), wanted, (path, proxy) => proxy === `http://127.0.0.1:9000${path}`);
	assert.deepEqual(moved.replace.map((m) => `${m.old} -> ${m.target}`), ["http://127.0.0.1:9000/mcp -> http://127.0.0.1:8787/mcp"]);
});

test("the tailnet proof's dns step uses this computer's resolver, needs a tailnet address and says it ran inside the tailnet", async () => {
	const inside = await mod.tailnetDnsCheck("box.tail1.ts.net", { resolve: async () => ["fd7a:115c:a1e0::1", "100.101.102.103"] });
	assert.equal(inside.check.status, "ok");
	assert.equal(inside.address, "100.101.102.103", "IPv4 first");
	assert.match(inside.check.detail, /checked from inside the tailnet/);
	const outside = await mod.tailnetDnsCheck("box.tail1.ts.net", { resolve: async () => ["192.168.1.5"] });
	assert.equal(outside.check.status, "fail");
	assert.match(outside.check.detail, /not a tailnet address \(checked from inside your tailnet/);
	const none = await mod.tailnetDnsCheck("box.tail1.ts.net", { resolve: async () => Promise.reject(new Error("ENOTFOUND")) });
	assert.equal(none.check.pending, true);
});

test("without Local Studio, remote setup --tailnet mounts the nine paths on 443, never Funnel or /v1, writes no record, and off removes only its own", { skip: unixOnly }, async () => {
	const other = { "/": { Proxy: "http://127.0.0.1:3000" } };
	const s = scenario("tailnet-setup", { serveState: { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { ...other } } } } });
	const local = await localServe(`https://${DNS}/mcp`);
	try {
		const r = await s.runAsync(["remote", "setup", "--tailnet", "--no-service", "--no-passcode", "--json", "--port", String(local.port)]);
		assert.ok(r.json().state, r.out);
		assert.deepEqual(s.remoteJson(), { publicUrl: `https://${DNS}`, port: local.port, route: "tailnet" });
		assert.equal(existsSync(s.studio), false, "Tychicus never makes Local Studio's folder");
		const mounted = handlers(s);
		assert.deepEqual(Object.keys(mounted).sort(), ["/", ...TYCHICUS_PATHS].sort());
		for (const path of TYCHICUS_PATHS) assert.equal(mounted[path].Proxy, `http://127.0.0.1:${local.port}${path}`);
		assert.deepEqual(mounted["/"], other["/"]);
		assert.ok(!s.calls().some((x) => x.startsWith("tailscale funnel")), "Funnel is never touched");
		const text = await s.runAsync(["remote", "test"]);
		assert.match(text.out, /from inside your tailnet/);
		const status = (await s.runAsync(["remote", "status", "--json"])).json();
		assert.equal(status.route, "tailnet");
		assert.equal(status.localStudio, null);
		assert.equal(status.cloudflare, null);
		const off = await s.runAsync(["remote", "off"]);
		assert.equal(off.code, 0, off.out);
		assert.match(off.out, /Took down the tailnet route's 9 paths/);
		assert.deepEqual(handlers(s), other, "every other handler stays");
		assert.equal(s.remoteJson(), undefined);
	} finally {
		await local.close();
	}
});

test("remote setup --tailnet in text mode says it checked from inside the tailnet, and that internet assistants can't reach it", { skip: unixOnly }, async () => {
	const s = scenario("tailnet-text");
	const local = await localServe(`https://${DNS}/mcp`);
	try {
		const r = await s.runAsync(["remote", "setup", "--tailnet", "--no-service", "--no-passcode", "--port", String(local.port)]);
		assert.match(r.out, /From inside your tailnet/);
		assert.match(r.out, /Tailnet only: claude\.ai, ChatGPT and grok\.com/);
	} finally {
		await local.close();
	}
});

test("remote setup --tailnet refuses Funnel on 443, a path served elsewhere, a signed-out or missing Tailscale, and changes nothing", { skip: unixOnly }, async () => {
	const local = await localServe(`https://${DNS}/mcp`);
	try {
		const setup = (s) => s.runAsync(["remote", "setup", "--tailnet", "--no-service", "--no-passcode", "--json", "--port", String(local.port)]);
		const funnel = scenario("tailnet-funnel", { serveState: { AllowFunnel: { [`${DNS}:443`]: true } } });
		const f = (await setup(funnel)).json();
		assert.equal(f.code, "tailnet_funnel");
		assert.equal(f.step, "error");
		assert.deepEqual(mountCalls(funnel), []);
		assert.equal(funnel.remoteJson(), undefined);

		const taken = scenario("tailnet-taken", { serveState: { Web: { [`${DNS}:443`]: { Handlers: { "/authorize": { Proxy: "http://127.0.0.1:4000/login" } } } } } });
		const t = (await setup(taken)).json();
		assert.equal(t.state, "port_busy");
		assert.match(t.message, /\/authorize \(http:\/\/127\.0\.0\.1:4000\/login\)/);
		assert.deepEqual(mountCalls(taken), []);

		const out = scenario("tailnet-signed-out", { ts: { signedOut: true } });
		const o = await setup(out);
		assert.equal(o.code, 3, o.out);
		assert.equal(o.json().state, "tailscale_signed_out");
		assert.equal(o.json().step, "needs_signin");

		const missing = scenario("tailnet-missing", { tailscale: false });
		const m = await setup(missing);
		assert.equal(m.code, 3, m.out);
		assert.equal(m.json().state, "tailscale_missing");

		const half = scenario("tailnet-half", { ts: { failMount: ["/token"] } });
		const h = (await setup(half)).json();
		assert.equal(h.code, "tailnet");
		assert.deepEqual(half.serve(), {}, "what this run mounted was taken down again");
	} finally {
		await local.close();
	}
});

// ---------- the runner ----------

const TUNNEL_ID = "c0ffee00-1234-4abc-8def-0123456789ab";
const CF_HOST = "cf.example.com";

/** Tychicus's own Cloudflare route: remote.json, cloudflared.yml (credentials kept elsewhere, as an import leaves them), the service file. */
function cloudflareRoute(s, port) {
	writeFileSync(join(s.config, "remote.json"), JSON.stringify({ publicUrl: `https://${CF_HOST}`, port, route: "cloudflare" }));
	const yml = [`tunnel: ${TUNNEL_ID}`, `credentials-file: /imported/${TUNNEL_ID}.json`, "logfile: /imported/cloudflared.log", "no-autoupdate: true", "ingress:", `  - hostname: ${CF_HOST}`, `    service: http://127.0.0.1:${port}`, "  - service: http_status:404", ""].join("\n");
	writeFileSync(join(s.config, "cloudflared.yml"), yml, { mode: 0o600 });
	const launcher = s.launcher();
	const file = s.serviceFileOf("cloudflared");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		process.platform === "darwin"
			? `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>com.tychicus.cloudflared</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${launcher}</string>\n\t\t<string>remote</string>\n\t\t<string>cloudflare</string>\n\t\t<string>run</string>\n\t</array>\n</dict>\n</plist>\n`
			: `[Service]\nExecStart=${launcher} remote cloudflare run\n`,
	);
	return yml;
}

test("the runner re-renders the ingress before it starts, keeping the tunnel, credentials and log lines", { skip: unixOnly }, async () => {
	const s = scenario("runner");
	const old = cloudflareRoute(s, 8787);
	s.script("cloudflared", `/bin/cat "$3" > ${join(s.dir, "ran.yml")}\nexit 0\n`);
	const r = await s.runAsync(["remote", "cloudflare", "run"]);
	assert.equal(r.code, 0, r.out);
	const now = readFileSync(join(s.config, "cloudflared.yml"), "utf8");
	assert.equal(readFileSync(join(s.dir, "ran.yml"), "utf8"), now, "cloudflared ran the re-rendered file");
	for (const line of old.split("\n").slice(0, 4)) assert.ok(now.split("\n").includes(line), `kept: ${line}`);
	assert.ok(now.endsWith(`  - hostname: ${CF_HOST}\n    path: ${mod.record.TYCHICUS_PATH_REGEX}\n    service: http://127.0.0.1:8787\n  - service: http_status:404\n`), now);
	assert.doesNotMatch(now, /v1/);
	assert.equal(statSync(join(s.config, "cloudflared.yml")).mode & 0o777, 0o600);
	// For Local Studio's adopt step: where the tunnel is, by path, never the credentials' contents.
	const status = (await s.runAsync(["remote", "status", "--json"])).json();
	assert.deepEqual(status.cloudflare, { tunnelId: TUNNEL_ID, credentialsFile: `/imported/${TUNNEL_ID}.json`, configFile: join(s.config, "cloudflared.yml") });
});

// ---------- joining Local Studio's tunnel ----------

test("remote join: serve moves to the record's port and address with its aliases, Tychicus's own tunnel service stops, the tunnel stays", { skip: unixOnly }, async () => {
	const s = scenario("join-cloudflare");
	const local = await localServe(`https://${STUDIO}/mcp`);
	try {
		const yml = cloudflareRoute(s, 8787);
		s.writeRecord({ v: 1, owner: "local-studio", route: "cloudflare", hostname: STUDIO, aliases: [OLD], ports: { mcp: local.port, serve: 18094 } });
		const r = await s.runAsync(["remote", "join", "--json"], {}, { hooks: true });
		assert.equal(r.code, 0, r.out);
		const report = r.json();
		assert.equal(report.state, "on");
		assert.equal(report.step, "joined");
		assert.equal(report.connectorUrl, `https://${STUDIO}/mcp`);
		assert.deepEqual(s.remoteJson(), { publicUrl: `https://${STUDIO}`, port: local.port, route: "custom", aliases: [OLD] });
		assert.deepEqual(s.proved(), [`https://${STUDIO}`, `https://${OLD}`], "the proof covers the hostname and each alias");
		assert.equal(existsSync(s.serviceFileOf("cloudflared")), false, "Tychicus's tunnel service is gone");
		assert.ok(existsSync(s.serviceFileOf("serve")), "serve runs as a service on the new port");
		assert.equal(readFileSync(join(s.config, "cloudflared.yml"), "utf8"), yml, "the tunnel's config stays for Local Studio");
		assert.deepEqual(s.calls().filter((x) => x.startsWith("cloudflared")), [], "no tunnel or DNS record is deleted");
		const status = (await s.runAsync(["remote", "status", "--json"])).json();
		assert.deepEqual(status.localStudio, { route: "cloudflare", hostname: STUDIO, aliases: [OLD], mcpPort: local.port, joined: true });
		const off = await s.runAsync(["remote", "off"]);
		assert.match(off.out, /Local Studio's cloudflare route for studio\.example\.com keeps running/);
		assert.ok(existsSync(s.recordFile), "off never touches Local Studio's record");
	} finally {
		await local.close();
	}
});

test("remote join puts remote.json, serve and Tychicus's own tunnel back when the proof fails, and exits non-zero", { skip: unixOnly }, async () => {
	const s = scenario("join-rollback");
	const local = await localServe(`https://${STUDIO}/mcp`);
	try {
		cloudflareRoute(s, 8787);
		const before = s.remoteJsonText();
		s.writeRecord({ v: 1, owner: "local-studio", route: "cloudflare", hostname: STUDIO, aliases: [OLD], ports: { mcp: local.port } });
		const r = await s.runAsync(["remote", "join", "--json"], { JOIN_PROOF_FAIL: OLD }, { hooks: true });
		assert.equal(r.code, 1, r.out);
		const report = r.json();
		assert.equal(report.state, "problem");
		assert.equal(report.step, "error");
		assert.equal(report.code, "resource_metadata");
		assert.match(report.message, /https:\/\/old\.example\.com\/mcp doesn't work through Local Studio's cloudflare route.*put back as they were/);
		assert.equal(s.remoteJsonText(), before, "remote.json is back, byte for byte");
		assert.ok(existsSync(s.serviceFileOf("cloudflared")), "Tychicus's tunnel service is back");
		assert.equal(existsSync(s.serviceFileOf("serve")), false, "the serve service this run installed is gone again");
	} finally {
		await local.close();
	}
});

test("remote join on the tailnet leaves mounts Local Studio now shares, and removes Tychicus's own on another port", { skip: unixOnly }, async () => {
	const local = await localServe(`https://${DNS}/mcp`);
	try {
		const mounts = (port) => Object.fromEntries(TYCHICUS_PATHS.map((p) => [p, { Proxy: `http://127.0.0.1:${port}${p}` }]));
		const same = scenario("join-tailnet-same", { serveState: { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: mounts(local.port) } } } });
		writeFileSync(join(same.config, "remote.json"), JSON.stringify({ publicUrl: `https://${DNS}`, port: local.port, route: "tailnet" }));
		same.writeRecord({ v: 1, owner: "local-studio", route: "tailnet", hostname: DNS, ports: { mcp: local.port, serve: 18093 } });
		const a = await same.runAsync(["remote", "join", "--no-service", "--json"], {}, { hooks: true });
		assert.equal(a.code, 0, a.out);
		assert.deepEqual(handlers(same), mounts(local.port), "the shared mounts stay");

		const moved = scenario("join-tailnet-moved", { serveState: { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: mounts(9001) } } } });
		writeFileSync(join(moved.config, "remote.json"), JSON.stringify({ publicUrl: `https://${DNS}`, port: 9001, route: "tailnet" }));
		moved.writeRecord({ v: 1, owner: "local-studio", route: "tailnet", hostname: DNS, ports: { mcp: local.port } });
		const b = await moved.runAsync(["remote", "join", "--no-service", "--json"], {}, { hooks: true });
		assert.equal(b.code, 0, b.out);
		assert.deepEqual(handlers(moved), {}, "Tychicus's mounts on its old port are gone");
		assert.equal(moved.remoteJson().route, "custom");
	} finally {
		await local.close();
	}
});

test("remote join puts back every tailnet mount it took down when teardown fails partway", { skip: unixOnly }, async () => {
	const local = await localServe(`https://${DNS}/mcp`);
	try {
		const mounts = (port) => Object.fromEntries(TYCHICUS_PATHS.map((p) => [p, { Proxy: `http://127.0.0.1:${port}${p}` }]));
		const s = scenario("join-tailnet-half-off", { ts: { failOff: ["/authorize"] }, serveState: { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: mounts(9001) } } } });
		writeFileSync(join(s.config, "remote.json"), JSON.stringify({ publicUrl: `https://${DNS}`, port: 9001, route: "tailnet" }));
		const before = s.remoteJsonText();
		s.writeRecord({ v: 1, owner: "local-studio", route: "tailnet", hostname: DNS, ports: { mcp: local.port } });
		const r = await s.runAsync(["remote", "join", "--no-service", "--json"], {}, { hooks: true });
		assert.equal(r.code, 1, r.out);
		assert.equal(r.json().code, "tailnet");
		assert.match(r.json().message, /put back as they were/);
		assert.deepEqual(handlers(s), mounts(9001), "the mounts removed before the failure are back");
		assert.equal(s.remoteJsonText(), before);
	} finally {
		await local.close();
	}
});

test("remote test and remote fix check a joined tailnet route from inside the tailnet", { skip: unixOnly }, async () => {
	const s = scenario("joined-tailnet-checks");
	const local = await localServe(`https://${DNS}/mcp`);
	try {
		writeFileSync(join(s.config, "remote.json"), JSON.stringify({ publicUrl: `https://${DNS}`, port: local.port, route: "custom" }));
		s.writeRecord({ v: 1, owner: "local-studio", route: "tailnet", hostname: DNS, ports: { mcp: local.port } });
		const t = (await s.runAsync(["remote", "test", "--json"])).json();
		assert.match(t.checks.find((x) => x.name === "dns").detail, /checked from inside your tailnet/, JSON.stringify(t.checks));
		const f = (await s.runAsync(["remote", "fix", "--json", "--yes"])).json();
		assert.match(f.checks.find((x) => x.name === "dns").detail, /checked from inside your tailnet/, JSON.stringify(f));
	} finally {
		await local.close();
	}
});

test("remote join refuses without a record, with a record that isn't Local Studio's, or with another --port, and changes nothing", { skip: unixOnly }, async () => {
	const s = scenario("join-refuse");
	const none = await s.runAsync(["remote", "join", "--json"]);
	assert.equal(none.json().code, "route_record");
	assert.match(none.json().message, /no route record/);
	s.writeRecord({ v: 1, owner: "tychicus", route: "cloudflare", hostname: CF_HOST, ports: { mcp: 8787 } });
	assert.match((await s.runAsync(["remote", "join"])).stderr, /only Local Studio's route can be joined/);
	s.writeRecord({ v: 1, owner: "local-studio", route: "hosted", hostname: STUDIO, ports: { mcp: 8787 } });
	const port = await s.runAsync(["remote", "join", "--json", "--port", "9999"]);
	assert.equal(port.json().code, "local_port");
	writeFileSync(s.recordFile, "[]");
	const bad = (await s.runAsync(["remote", "join", "--json"])).json();
	assert.equal(bad.code, "route_record");
	assert.ok(bad.message.includes(s.recordFile));
	assert.equal(s.remoteJson(), undefined);
});

// ---------- remote setup where Local Studio is ----------

/** A stub `local-studio`: logs its arguments, and on `tunnel setup` answers `answer` (JSON on stdout), writing `record` first when given. */
function localStudioStub(s, { record, answer = { ok: true, state: "on", message: "Tunnel on." }, exit = 0 } = {}) {
	const write = record ? `/bin/mkdir -p "${dirname(s.recordFile)}"\n/bin/cat > "${s.recordFile}" <<'JSON'\n${JSON.stringify(record)}\nJSON\n` : "";
	s.script("local-studio", `echo "local-studio $*" >> ${join(s.dir, "calls.log")}\n${write}/bin/cat <<'JSON'\n${JSON.stringify(answer)}\nJSON\nexit ${exit}\n`);
}

test("a Local Studio folder with no record and no tunnel command is no reason to leave Tychicus's own Funnel route", { skip: unixOnly }, async () => {
	// `tychicus install --local-studio` makes this folder itself, and stable Local Studio has no tunnel setup.
	const s = scenario("defer-plugins-only");
	mkdirSync(join(s.studio, "plugins"), { recursive: true });
	const local = await localServe(`https://${DNS}:8443/mcp`);
	try {
		const r = (await s.runAsync(["remote", "setup", "--tailscale", "--json", "--no-service", "--no-passcode", "--port", String(local.port)])).json();
		assert.notEqual(r.code, "local_studio", r.message);
		assert.doesNotMatch(r.message, /Local Studio/);
		assert.ok(s.calls().some((x) => x.startsWith("tailscale funnel")), `${r.message}\n${s.calls().join("\n")}`);
	} finally {
		await local.close();
	}
});

test("a re-run on Tychicus's own Cloudflare route with no record stays Tychicus's, even with a local-studio that has tunnel setup", { skip: unixOnly }, async () => {
	const s = scenario("defer-own-route");
	cloudflareRoute(s, 8787);
	localStudioStub(s, { record: { v: 1, owner: "local-studio", route: "cloudflare", hostname: STUDIO, ports: { mcp: 8787 } } });
	const r = (await s.runAsync(["remote", "setup", "--cloudflare", CF_HOST, "--json", "--no-service", "--no-passcode"])).json();
	assert.notEqual(r.code, "local_studio", r.message);
	assert.deepEqual(s.calls().filter((x) => x.startsWith("local-studio")), [], "local-studio isn't run");
	assert.equal(existsSync(s.recordFile), false);
});

test("with Local Studio, setup --tailnet runs local-studio tunnel setup --tailnet --json, then joins its route", { skip: unixOnly }, async () => {
	const s = scenario("defer-tailnet");
	const local = await localServe(`https://${DNS}/mcp`);
	try {
		localStudioStub(s, { record: { v: 1, owner: "local-studio", route: "tailnet", hostname: DNS, ports: { mcp: local.port, serve: 18093 } } });
		const r = await s.runAsync(["remote", "setup", "--tailnet", "--no-service", "--json"], {}, { hooks: true });
		assert.equal(r.code, 0, r.out);
		assert.equal(r.json().step, "joined");
		assert.deepEqual(s.calls().filter((x) => x.startsWith("local-studio")), ["local-studio tunnel setup --tailnet --json"]);
		assert.deepEqual(mountCalls(s), [], "Tychicus mounts nothing itself");
		assert.deepEqual(s.remoteJson(), { publicUrl: `https://${DNS}`, port: local.port, route: "custom" });
	} finally {
		await local.close();
	}
});

test("setup through Local Studio mints the passcode and the connect code the way its own setup does", { skip: unixOnly }, async () => {
	const s = scenario("defer-connect-code");
	const local = await localServe(`https://${DNS}/mcp`);
	try {
		localStudioStub(s, { record: { v: 1, owner: "local-studio", route: "tailnet", hostname: DNS, ports: { mcp: local.port } } });
		const r = await s.runAsync(["remote", "setup", "--tailnet", "--no-service", "--connect-code", "--json"], {}, { hooks: true });
		assert.equal(r.code, 0, r.out);
		const report = r.json();
		assert.equal(report.step, "joined");
		assert.match(report.connectCode ?? "", /^TK-/, r.out);
		assert.ok(report.connectCodeExpiresAt > Date.now(), r.out);
		assert.equal(typeof report.passcode, "string", "a passcode is made without --no-passcode");
		assert.equal(report.passcodeSet, true);
		assert.deepEqual(report.next, { kind: "add_connector", url: `https://${DNS}/mcp` });
		const again = (await s.runAsync(["remote", "setup", "--tailnet", "--no-service", "--json"], {}, { hooks: true })).json();
		assert.equal(again.passcode, undefined, "a passcode is made once");
		assert.equal(again.connectCode, undefined, "no code unasked in an agent's shell");
	} finally {
		await local.close();
	}
});

test("with Local Studio's record already there, setup --cloudflare joins it without running local-studio", { skip: unixOnly }, async () => {
	const s = scenario("defer-record");
	const local = await localServe(`https://${STUDIO}/mcp`);
	try {
		localStudioStub(s);
		s.writeRecord({ v: 1, owner: "local-studio", route: "hosted", hostname: STUDIO, ports: { mcp: local.port } });
		const r = await s.runAsync(["remote", "setup", "--cloudflare", "other.example.com", "--no-service"], {}, { hooks: true });
		assert.equal(r.code, 0, r.out);
		assert.match(r.out, /Local Studio already runs a hosted route for studio\.example\.com/);
		assert.deepEqual(s.calls().filter((x) => x.startsWith("local-studio") || x.startsWith("cloudflared")), []);
	} finally {
		await local.close();
	}
});

const WAITLIST = "https://local-studio-waitlist.magnus-b37.workers.dev";

test("on Local Studio's waitlist, setup says the tunnel is dev-channel only, gives the waitlist and sets up Tychicus's own route", { skip: unixOnly }, async () => {
	const s = scenario("defer-waitlist");
	const answer = { state: "waitlist", next: { kind: "open_page", url: WAITLIST }, url: WAITLIST, channel: "stable" };
	localStudioStub(s, { answer, exit: 3 });
	const local = await localServe(`https://${DNS}/mcp`);
	try {
		const args = ["remote", "setup", "--tailnet", "--no-service", "--no-passcode", "--port", String(local.port)];
		const r = await s.runAsync([...args, "--json"]);
		const report = r.json();
		assert.notEqual(report.state, "waitlist", r.out);
		assert.deepEqual(report.localStudio, answer);
		assert.deepEqual(s.calls().filter((x) => x.startsWith("local-studio")), ["local-studio tunnel setup --tailnet --json"]);
		assert.deepEqual(s.remoteJson(), { publicUrl: `https://${DNS}`, port: local.port, route: "tailnet" }, "Tychicus's own tailnet route");
		assert.equal(Object.keys(handlers(s)).length, TYCHICUS_PATHS.length);
		const text = await s.runAsync(args);
		assert.match(text.out, /dev channel only/);
		assert.match(text.out, /stable channel/);
		assert.ok(text.out.includes(WAITLIST), text.out);
		assert.doesNotMatch(text.out, /undefined/);
	} finally {
		await local.close();
	}
});

test("a local-studio without tunnel setup leaves Tychicus its own route; one whose tunnel setup fails is a refusal", { skip: unixOnly }, async () => {
	const local = await localServe(`https://${DNS}/mcp`);
	try {
		const old = scenario("defer-old");
		old.script("local-studio", `echo "local-studio $*" >> ${join(old.dir, "calls.log")}\necho "unknown command: tunnel setup" >&2\nexit 2\n`);
		const o = (await old.runAsync(["remote", "setup", "--tailnet", "--json", "--no-service", "--no-passcode", "--port", String(local.port)])).json();
		assert.notEqual(o.code, "local_studio", o.message);
		assert.equal(old.remoteJson()?.route, "tailnet");

		const broken = scenario("defer-broken");
		localStudioStub(broken, { answer: { state: "error", code: "tailscale", message: "Tailscale isn't running." }, exit: 1 });
		const b = (await broken.runAsync(["remote", "setup", "--tailnet", "--json", "--no-service"])).json();
		assert.equal(b.code, "local_studio");
		assert.match(b.message, /failed \(exit 1\): Tailscale isn't running/);
		assert.equal(broken.remoteJson(), undefined);
		assert.deepEqual(mountCalls(broken), []);
	} finally {
		await local.close();
	}
});

// ---------- aliases: OAuth on each host, tokens bound to the host they were issued on ----------

const freePort = () =>
	new Promise((resolve) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});

/** One request to serve on loopback with the Host header a tunnel would pass on. */
function call(port, host, method, path, { form, json, headers = {} } = {}) {
	const body = form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined;
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: "127.0.0.1", port, method, path, headers: { host, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : json ? { "content-type": "application/json" } : {}), ...headers } },
			(res) => {
				let text = "";
				res.on("data", (d) => (text += d));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

test("serve answers OAuth on the address and on each alias as its own, and a token works only on the host it was issued on", { skip: unixOnly }, async () => {
	const config = { publicUrl: `https://${STUDIO}`, aliases: [OLD], redirectHosts: [], scopes: {} };
	assert.equal(mod.oauthForHost(config, OLD).publicUrl, `https://${OLD}`);
	assert.equal(mod.oauthForHost(config, "127.0.0.1:1").publicUrl, `https://${STUDIO}`);
	const s = scenario("aliases");
	const port = await freePort();
	writeFileSync(join(s.config, "remote.json"), JSON.stringify({ publicUrl: `https://${STUDIO}`, port, route: "custom", aliases: [OLD] }));
	const run = (args) => spawnSync(process.execPath, [cli, ...args], { env: s.env, encoding: "utf8" });
	const srv = spawn(process.execPath, [cli, "serve"], { env: s.env });
	try {
		await new Promise((resolve, reject) => {
			let out = "";
			srv.stdout.on("data", (d) => {
				out += d;
				if (/Also answering OAuth on https:\/\/old\.example\.com\/mcp/.test(out)) resolve();
			});
			srv.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
			setTimeout(() => reject(new Error(`serve didn't start: ${out}`)), 15_000);
		});
		assert.equal((await call(port, "evil.example", "GET", METADATA_PATH)).status, 421, "a foreign Host is still refused");
		const callback = "https://claude.ai/api/mcp/auth_callback";
		const mint = () => /TK-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(run(["token", "approval-code"]).stdout)?.[0];
		const tokenFor = async (host) => {
			const base = `https://${host}`;
			const prm = (await call(port, host, "GET", METADATA_PATH)).json();
			assert.equal(prm.resource, `${base}/mcp`);
			assert.deepEqual(prm.authorization_servers, [base]);
			const asm = (await call(port, host, "GET", "/.well-known/oauth-authorization-server")).json();
			assert.equal(asm.issuer, base);
			assert.equal(asm.token_endpoint, `${base}/token`);
			const challenge401 = await call(port, host, "POST", "/mcp", { json: {} });
			assert.equal(challenge401.status, 401);
			assert.equal(challenge401.headers["www-authenticate"], `Bearer realm="tabkyra", resource_metadata="${base}${METADATA_PATH}"`);
			const reg = await call(port, host, "POST", "/register", { json: { client_name: "Claude", redirect_uris: [callback] } });
			assert.equal(reg.status, 201, reg.text);
			const { client_id } = reg.json();
			const verifier = randomBytes(32).toString("base64url");
			const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: callback, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "s1", resource: `${base}/mcp` });
			const consent = await call(port, host, "GET", `/authorize?${q}`);
			assert.equal(consent.status, 200, consent.text);
			const signed = /name="request" value="([^"]+)"/.exec(consent.text)[1];
			const ok = await call(port, host, "POST", "/authorize", { form: [["request", signed], ["passcode", mint()], ["scope", "browser.read"], ["decision", "allow"]] });
			assert.equal(ok.status, 302, ok.text);
			const back = new URL(ok.headers.location);
			assert.equal(back.searchParams.get("iss"), base);
			const grant = (await call(port, host, "POST", "/token", { form: { grant_type: "authorization_code", code: back.searchParams.get("code"), client_id, redirect_uri: callback, code_verifier: verifier } })).json();
			assert.match(grant.access_token, /^tko_/);
			return { token: grant.access_token, signed };
		};
		const accepted = async (host, token) => (await call(port, host, "POST", "/mcp", { json: {}, headers: { authorization: `Bearer ${token}` } })).status;
		const onAlias = await tokenFor(OLD);
		const onPrimary = await tokenFor(STUDIO);
		// Past the token check, a non-initialize body is a 400; a token for another address is a 401.
		assert.equal(await accepted(OLD, onAlias.token), 400);
		assert.equal(await accepted(STUDIO, onPrimary.token), 400);
		assert.equal(await accepted(STUDIO, onAlias.token), 401, "a token from the alias isn't valid on the primary");
		assert.equal(await accepted(OLD, onPrimary.token), 401, "a token from the primary isn't valid on the alias");
		// An approval form opened on the alias can't be approved on the primary.
		const crossed = await call(port, STUDIO, "POST", "/authorize", { form: [["request", onAlias.signed], ["passcode", mint()], ["scope", "browser.read"], ["decision", "allow"]] });
		assert.equal(crossed.status, 400);
		assert.match(crossed.text, /another address/);
	} finally {
		srv.kill("SIGKILL");
	}
});

// ---------- another setup's services ----------

/** A service file the way setup writes it, naming `config` as its config folder. */
function serviceFor(s, which, config) {
	const file = s.serviceFileOf(which);
	mkdirSync(dirname(file), { recursive: true });
	const args = which === "serve" ? ["serve"] : ["remote", "cloudflare", "run"];
	writeFileSync(
		file,
		process.platform === "darwin"
			? `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>com.tychicus.${which}</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${config}/tychicus</string>\n${args.map((a) => `\t\t<string>${a}</string>\n`).join("")}\t</array>\n\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>POLYCARP_BROWSER_CONFIG_DIR</key>\n\t\t<string>${config}</string>\n\t\t<key>TABKYRA_CONFIG_DIR</key>\n\t\t<string>${config}</string>\n\t</dict>\n</dict>\n</plist>\n`
			: `[Service]\nExecStart=${config}/tychicus ${args.join(" ")}\nEnvironment="POLYCARP_BROWSER_CONFIG_DIR=${config}"\nEnvironment="TABKYRA_CONFIG_DIR=${config}"\n`,
	);
	return file;
}

test("off, setup, fix and join refuse a service set up for another config folder, and change nothing", { skip: unixOnly }, async () => {
	const s = scenario("other-config");
	const other = join(s.home, ".config", "tychicus");
	const files = ["serve", "cloudflared"].map((which) => serviceFor(s, which, other));
	const before = files.map((f) => readFileSync(f, "utf8"));
	writeFileSync(join(s.config, "remote.json"), JSON.stringify({ publicUrl: `https://${CF_HOST}`, port: 18787, route: "cloudflare" }));
	const remoteBefore = s.remoteJsonText();
	s.writeRecord({ v: 1, owner: "local-studio", route: "hosted", hostname: STUDIO, ports: { mcp: 18787 } });
	const runs = [
		["remote", "off", "--json"],
		["remote", "setup", "--tailnet", "--no-service", "--json"],
		["remote", "setup", "--public-url", "https://me.example.com", "--no-service", "--json"],
		["remote", "fix", "--json"],
		["remote", "join", "--json"],
	];
	for (const args of runs) {
		const r = await s.runAsync(args);
		assert.notEqual(r.code, 0, `${args.join(" ")}: ${r.out}`);
		const report = r.json();
		assert.equal(report.code, "service_belongs_to_other_config", `${args.join(" ")}: ${r.out}`);
		assert.ok(report.message.includes(other) && report.message.includes(s.config), report.message);
	}
	// Local Studio's deferral refuses too, before it runs local-studio.
	mkdirSync(s.studio, { recursive: true });
	localStudioStub(s);
	rmSync(s.recordFile);
	const deferred = await s.runAsync(["remote", "setup", "--tailnet", "--json"]);
	assert.equal(deferred.json().code, "service_belongs_to_other_config", deferred.out);
	assert.deepEqual(files.map((f) => readFileSync(f, "utf8")), before, "both service files are untouched");
	assert.equal(s.remoteJsonText(), remoteBefore);
	assert.deepEqual(s.calls().filter((x) => /^(launchctl|systemctl|cloudflared|tailscale serve --|tailscale funnel|local-studio)/.test(x)), [], s.calls().join("\n"));
	const text = await s.runAsync(["remote", "off"]);
	assert.equal(text.code, 1);
	assert.match(text.stderr, /belongs to another setup\. Nothing was changed/);
});

test("a service set up for this config folder is still this setup's to turn off", { skip: unixOnly }, async () => {
	const s = scenario("same-config");
	const file = serviceFor(s, "serve", s.config);
	const off = await s.runAsync(["remote", "off", "--json"]);
	assert.equal(off.code, 0, off.out);
	assert.equal(existsSync(file), false);
});
