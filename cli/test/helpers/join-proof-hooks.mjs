// Preloaded with `node --import` by the one-tunnel tests, never by the CLI itself: `remote join`'s outside proof, replaced, because
// no public server stands behind a test record's hostname. Each address proved is appended to JOIN_PROOF_LOG, and a hostname listed
// in JOIN_PROOF_FAIL (comma separated) fails its resource metadata check. A normal run has no way to load it.
import { appendFileSync } from "node:fs";

globalThis[Symbol.for("polycarp.remote-test.hooks")] = {
	proof: async (url) => {
		const host = new URL(url).hostname;
		if (process.env.JOIN_PROOF_LOG) appendFileSync(process.env.JOIN_PROOF_LOG, `${url}\n`);
		const failing = (process.env.JOIN_PROOF_FAIL ?? "").split(",").filter(Boolean).includes(host);
		return [
			{ name: "dns", status: "ok", detail: `${host} resolves` },
			{ name: "tls", status: "ok", detail: "certificate valid" },
			failing ? { name: "resource_metadata", status: "fail", detail: "answered 404" } : { name: "resource_metadata", status: "ok", detail: `resource ${url}/mcp` },
		];
	},
};
