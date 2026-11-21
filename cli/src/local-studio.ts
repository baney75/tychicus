/**
 * `tychicus install --local-studio`: the Local Studio plugins (plugins/ in the repository, bundled into the program as
 * text) go to Local Studio's plugin folder, and Eukhe's `mcpServers` setting gets the `tychicus` entry that gives the
 * plugins' skills their tools. Local Studio's v0 plugin manifest has no way to start a server itself (capabilities
 * fail the load), so this entry is how the tools arrive until the core gains an `[mcp]` table.
 *
 * Only Tychicus's own plugin folders and its own `tychicus` entry are written. Eukhe's settings file is backed up
 * before a change, every other key and server is kept, and a file that is not a JSON object is left alone.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cliLauncherPath, ensureLauncherIsSelf } from "./install.ts";
import { localStudioDataDir } from "./route-record.ts";
import { COMPILED, selfExec, stableReleaseProgram } from "./self.ts";
import browserPrompt from "../../plugins/tychicus-browser/prompts/page-text.md";
import browserToml from "../../plugins/tychicus-browser/plugin.toml";
import browserSkill from "../../plugins/tychicus-browser/skills/tychicus-browser/SKILL.md";
import computerToml from "../../plugins/tychicus-computer/plugin.toml";
import computerSkill from "../../plugins/tychicus-computer/skills/tychicus-computer/SKILL.md";

/** Each plugin's files by path inside its folder. A new file in plugins/ must be added here. */
export const PLUGINS: Record<string, Record<string, string>> = {
	"tychicus-browser": {
		"plugin.toml": browserToml,
		"skills/tychicus-browser/SKILL.md": browserSkill,
		"prompts/page-text.md": browserPrompt,
	},
	"tychicus-computer": {
		"plugin.toml": computerToml,
		"skills/tychicus-computer/SKILL.md": computerSkill,
	},
};

/** The name of the Eukhe server entry. */
export const MCP_ENTRY_NAME = "tychicus";

export class LocalStudioError extends Error {}

/** Local Studio's plugin folder: $LOCAL_STUDIO_DATA_DIR/plugins, else ~/.local-studio/plugins (core/src/plugins.rs). */
export function localStudioPluginsDir(): string {
	return join(localStudioDataDir(), "plugins");
}

/** Eukhe's global settings file: $EUKHE_CODING_AGENT_DIR/settings.json, else ~/.eukhe/settings.json. */
export function eukheSettingsPath(): string {
	const chosen = process.env.EUKHE_CODING_AGENT_DIR;
	let dir = join(homedir(), ".eukhe");
	if (chosen) dir = chosen === "~" ? homedir() : chosen.startsWith("~/") ? join(homedir(), chosen.slice(2)) : chosen;
	return join(dir, "settings.json");
}

/** The stdio entry Eukhe starts: the small tool profile, since Local Studio sessions mostly run local models (D53). */
export function mcpEntry(command: string): { type: "stdio"; command: string; args: string[] } {
	return { type: "stdio", command, args: ["mcp", "--name", MCP_ENTRY_NAME, "--profile", "small"] };
}

/**
 * What Eukhe runs: a release's program through the `release` pointer, so the entry outlives the version folder it
 * was written from, else the agent launcher, which pins Node by path so a GUI-started daemon needs no node on PATH.
 * A dry run writes no launcher.
 */
export function localStudioCommand(dryRun = false): string {
	if (COMPILED) return stableReleaseProgram(selfExec());
	if (!dryRun) ensureLauncherIsSelf();
	return cliLauncherPath();
}

function filesIn(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...filesIn(join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out.sort();
}

/** True when the folder holds exactly these files with this content. */
function pluginCurrent(dir: string, files: Record<string, string>): boolean {
	try {
		if (JSON.stringify(filesIn(dir)) !== JSON.stringify(Object.keys(files).sort())) return false;
		return Object.entries(files).every(([rel, text]) => readFileSync(join(dir, rel), "utf8") === text);
	} catch {
		return false;
	}
}

export interface LocalStudioResult {
	written: string[];
	current: string[];
	backup?: string;
}

function stamp(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/** Copy the plugins and write the Eukhe entry that runs `command`. `dryRun` lists what would be written. */
export function installLocalStudio(options: { command: string; dryRun?: boolean }): LocalStudioResult {
	const result: LocalStudioResult = { written: [], current: [] };
	const settingsPath = eukheSettingsPath();
	// Read the settings first: a file we can't parse stops the install before any plugin is copied.
	let settings: Record<string, unknown> = {};
	const exists = existsSync(settingsPath);
	if (exists) {
		const text = readFileSync(settingsPath, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			throw new LocalStudioError(`${settingsPath} is not valid JSON (${(err as Error).message}). Fix it, then run this again; it was not changed.`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LocalStudioError(`${settingsPath} is not a JSON object; it was not changed.`);
		settings = parsed as Record<string, unknown>;
	}
	const servers = settings.mcpServers ?? {};
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new LocalStudioError(`mcpServers in ${settingsPath} is not an object; it was not changed.`);

	const root = localStudioPluginsDir();
	for (const [id, files] of Object.entries(PLUGINS)) {
		const dir = join(root, id);
		if (pluginCurrent(dir, files)) {
			result.current.push(dir);
			continue;
		}
		result.written.push(dir);
		if (options.dryRun) continue;
		// Build the new copy beside the old one, then swap, so Local Studio never scans half a plugin.
		const staging = join(root, `.${id}.new-${process.pid}`);
		rmSync(staging, { recursive: true, force: true });
		for (const [rel, text] of Object.entries(files)) {
			mkdirSync(dirname(join(staging, rel)), { recursive: true });
			writeFileSync(join(staging, rel), text);
		}
		const old = join(root, `.${id}.old-${process.pid}`);
		if (existsSync(dir)) renameSync(dir, old);
		renameSync(staging, dir);
		rmSync(old, { recursive: true, force: true });
	}

	const entry = mcpEntry(options.command);
	const have = (servers as Record<string, unknown>)[MCP_ENTRY_NAME];
	if (JSON.stringify(have) === JSON.stringify(entry)) {
		result.current.push(`${settingsPath} (mcpServers.${MCP_ENTRY_NAME})`);
		return result;
	}
	result.written.push(`${settingsPath} (mcpServers.${MCP_ENTRY_NAME})`);
	if (options.dryRun) return result;
	mkdirSync(dirname(settingsPath), { recursive: true });
	let mode: number | undefined;
	let indent: string | number = "\t";
	if (exists) {
		result.backup = `${settingsPath}.tychicus-backup-${stamp()}`;
		copyFileSync(settingsPath, result.backup);
		mode = statSync(settingsPath).mode & 0o777;
		const sample = readFileSync(settingsPath, "utf8").match(/\n([ \t]+)"/);
		if (sample) indent = sample[1].startsWith("\t") ? "\t" : sample[1].length;
	}
	const next = { ...settings, mcpServers: { ...(servers as Record<string, unknown>), [MCP_ENTRY_NAME]: entry } };
	const tmp = `${settingsPath}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, indent)}\n`, { mode: mode ?? 0o600 });
	renameSync(tmp, settingsPath);
	return result;
}
