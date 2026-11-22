import { terminalCommand, LINUX_TERMINAL_LAUNCHERS } from "./terminal-command";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
	isEditorId,
	isTerminalId,
	type ChatPathActionInput,
	type EditorHandoffState,
	type EditorHandoffStateOptions,
	type EditorId,
	type EditorPreferenceState,
	isBrowserArtifactPath,
	type OpenArtifactInBrowserInput,
	type OpenSessionArtifactsInput,
	type OpenSessionTargetInput,
	type OpenSessionTargetResult,
	type OpenTarget,
	type TerminalId,
} from "../shared/editor-handoff";
import type { MacTerminalApp } from "./mac-terminal-apps";

type Platform = NodeJS.Platform;

type ResolvedCommand = {
	command: string;
	iconPath?: string;
	argsForWorkspace: (workspacePath: string) => string[];
	argsForFile?: (filePath: string) => string[];
};

type EditorCandidate = {
	id: EditorId;
	name: string;
	commands: string[];
	/** CLI arguments for file handoff; workspace launches keep their existing behavior. */
	fileArgs?: string[];
	macApps?: string[];
	requiresTerminal?: boolean;
	/**
	 * Windows-only fallback install locations, relative to a resolved root
	 * (e.g. `%LOCALAPPDATA%\Programs\Cursor\bin`). These are probed only on
	 * win32 and only AFTER a PATH scan fails, so an explicit PATH install
	 * always wins. Paths are built from environment variables at resolve time,
	 * never hard-coded to a specific machine.
	 */
	winInstallDirs?: string[][];
};

const PROGRAM_FILES = "%ProgramFiles%";
const PROGRAM_FILES_X86 = "%ProgramFiles(x86)%";
const LOCAL_APPDATA_PROGRAMS = "%LOCALAPPDATA%\\Programs";

const EDITOR_CANDIDATES: EditorCandidate[] = [
	{ id: "cursor", name: "Cursor", commands: ["cursor"], fileArgs: ["--new-window"], macApps: ["Cursor"], winInstallDirs: [[LOCAL_APPDATA_PROGRAMS, "Cursor", "resources", "app", "bin"], [PROGRAM_FILES, "Cursor", "bin"]] },
	{ id: "vscode", name: "VS Code", commands: ["code"], fileArgs: ["--new-window"], macApps: ["Visual Studio Code"], winInstallDirs: [[LOCAL_APPDATA_PROGRAMS, "Microsoft VS Code", "bin"], [PROGRAM_FILES, "Microsoft VS Code", "bin"]] },
	{ id: "neovim", name: "Neovim", commands: ["nvim"], requiresTerminal: true },
	{ id: "windsurf", name: "Windsurf", commands: ["windsurf"], macApps: ["Windsurf"], winInstallDirs: [[LOCAL_APPDATA_PROGRAMS, "Windsurf", "resources", "app", "bin"], [PROGRAM_FILES, "Windsurf", "bin"]] },
	{ id: "zed", name: "Zed", commands: ["zed"], macApps: ["Zed"], winInstallDirs: [[LOCAL_APPDATA_PROGRAMS, "Zed", "bin"]] },
	{ id: "trae", name: "Trae", commands: ["trae"], macApps: ["Trae"], winInstallDirs: [[LOCAL_APPDATA_PROGRAMS, "Trae", "resources", "app", "bin"], [PROGRAM_FILES, "Trae", "bin"]] },
	{ id: "kiro", name: "Kiro", commands: ["kiro"], macApps: ["Kiro"], winInstallDirs: [[LOCAL_APPDATA_PROGRAMS, "Kiro", "bin"]] },
	{ id: "positron", name: "Positron", commands: ["positron"], macApps: ["Positron"], winInstallDirs: [[LOCAL_APPDATA_PROGRAMS, "Positron", "resources", "app", "bin"]] },
	{ id: "vscodium", name: "VSCodium", commands: ["codium"], macApps: ["VSCodium"], winInstallDirs: [[LOCAL_APPDATA_PROGRAMS, "VSCodium", "resources", "app", "bin"], [PROGRAM_FILES, "VSCodium", "bin"]] },
	{ id: "vscode-insiders", name: "VS Code Insiders", commands: ["code-insiders"], macApps: ["Visual Studio Code - Insiders"], winInstallDirs: [[LOCAL_APPDATA_PROGRAMS, "Microsoft VS Code Insiders", "bin"], [PROGRAM_FILES, "Microsoft VS Code Insiders", "bin"]] },
	{ id: "sublime", name: "Sublime Text", commands: ["subl"], macApps: ["Sublime Text"], winInstallDirs: [[PROGRAM_FILES, "Sublime Text"], [PROGRAM_FILES, "Sublime Text 3"], [LOCAL_APPDATA_PROGRAMS, "Sublime Text"]] },
	{ id: "intellij", name: "IntelliJ IDEA", commands: ["idea"], macApps: ["IntelliJ IDEA", "IntelliJ IDEA CE"], winInstallDirs: [[PROGRAM_FILES, "JetBrains", "IntelliJ IDEA", "bin"], [LOCAL_APPDATA_PROGRAMS, "JetBrains", "IntelliJ IDEA", "bin"]] },
	{ id: "webstorm", name: "WebStorm", commands: ["webstorm"], macApps: ["WebStorm"], winInstallDirs: [[PROGRAM_FILES, "JetBrains", "WebStorm", "bin"], [LOCAL_APPDATA_PROGRAMS, "JetBrains", "WebStorm", "bin"]] },
	{ id: "pycharm", name: "PyCharm", commands: ["pycharm"], macApps: ["PyCharm", "PyCharm CE"], winInstallDirs: [[PROGRAM_FILES, "JetBrains", "PyCharm", "bin"], [LOCAL_APPDATA_PROGRAMS, "JetBrains", "PyCharm", "bin"]] },
	{ id: "goland", name: "GoLand", commands: ["goland"], macApps: ["GoLand"], winInstallDirs: [[PROGRAM_FILES, "JetBrains", "GoLand", "bin"], [LOCAL_APPDATA_PROGRAMS, "JetBrains", "GoLand", "bin"]] },
	{ id: "phpstorm", name: "PhpStorm", commands: ["phpstorm"], macApps: ["PhpStorm"], winInstallDirs: [[PROGRAM_FILES, "JetBrains", "PhpStorm", "bin"], [LOCAL_APPDATA_PROGRAMS, "JetBrains", "PhpStorm", "bin"]] },
	{ id: "rubymine", name: "RubyMine", commands: ["rubymine"], macApps: ["RubyMine"], winInstallDirs: [[PROGRAM_FILES, "JetBrains", "RubyMine", "bin"], [LOCAL_APPDATA_PROGRAMS, "JetBrains", "RubyMine", "bin"]] },
	{ id: "clion", name: "CLion", commands: ["clion"], macApps: ["CLion"], winInstallDirs: [[PROGRAM_FILES, "JetBrains", "CLion", "bin"], [LOCAL_APPDATA_PROGRAMS, "JetBrains", "CLion", "bin"]] },
	{ id: "rider", name: "Rider", commands: ["rider"], macApps: ["Rider"], winInstallDirs: [[PROGRAM_FILES, "JetBrains", "Rider", "bin"], [LOCAL_APPDATA_PROGRAMS, "JetBrains", "Rider", "bin"]] },
	{ id: "android-studio", name: "Android Studio", commands: ["studio"], macApps: ["Android Studio"], winInstallDirs: [[PROGRAM_FILES, "Android", "Android Studio", "bin"]] },
	{ id: "fleet", name: "Fleet", commands: ["fleet"], macApps: ["Fleet"], winInstallDirs: [[PROGRAM_FILES, "JetBrains", "Fleet", "bin"]] },
	{ id: "antigravity", name: "Antigravity IDE", commands: ["antigravity-ide", "antigravity"], macApps: ["Antigravity IDE", "Antigravity"], winInstallDirs: [[LOCAL_APPDATA_PROGRAMS, "Antigravity IDE", "bin"], [PROGRAM_FILES, "Antigravity IDE", "bin"]] },
];

const WIN_INSTALL_ROOTS: Record<string, (env: NodeJS.ProcessEnv) => string | undefined> = {
	[LOCAL_APPDATA_PROGRAMS]: (env) => {
		const localAppData = env.LOCALAPPDATA;
		return localAppData ? path.win32.join(localAppData, "Programs") : undefined;
	},
	[PROGRAM_FILES]: (env) => env.ProgramFiles || env.PROGRAMFILES,
	[PROGRAM_FILES_X86]: (env) => env["ProgramFiles(x86)"] || env.PROGRAMFILES_X86,
};

export type EditorHandoffDeps = {
	platform: Platform;
	env: NodeJS.ProcessEnv;
	homeDir: string;
	resolveWorkspace: (sessionId: string) => Promise<string>;
	/** The session's artifact directory, which lives outside its workspace. */
	resolveArtifactDir: (sessionId: string) => Promise<string>;
	readPreference: () => Promise<EditorId>;
	writePreference: (editorId: EditorId) => Promise<void>;
	launch: (command: string, args: readonly string[], cwd: string) => Promise<void>;
	openDirectory: (workspacePath: string) => Promise<void>;
	/** Shows one file selected in the system file manager. */
	revealPath: (filePath: string) => Promise<void>;
	/** Opens one file in the system's default browser. */
	openInBrowser?: (filePath: string) => Promise<void>;
	/** Resolves symlinks in an existing path. */
	realPath: (candidatePath: string) => Promise<string>;
	/** Puts text on the system clipboard. The workspace path never reaches the renderer. */
	copyText?: (text: string) => void | Promise<void>;
	/** Reads a native app icon as a data URL; installation paths stay in main. */
	readIcon?: (appPath: string) => Promise<string>;
	/** Registered macOS shell apps that accept folder-open events. */
	discoverTerminalApps?: () => Promise<MacTerminalApp[]>;
	/**
	 * The names in a directory. An empty list means nothing can be found there;
	 * undefined means it could not be read but may still hold a named file.
	 */
	listDirectory?: (directory: string) => Promise<string[] | undefined>;
	isExecutable?: (candidatePath: string) => boolean | Promise<boolean>;
	isDirectory?: (candidatePath: string) => boolean | Promise<boolean>;
	/** Reads the first bytes of a file as text, or undefined when unreadable. */
	readFileHead?: (candidatePath: string) => string | undefined | Promise<string | undefined>;
	logError?: (message: string, error: unknown) => void;
};

export type EditorHandoff = {
	getState(sessionId: string, options?: EditorHandoffStateOptions): Promise<EditorHandoffState>;
	pathAction(input: ChatPathActionInput): Promise<void>;
	getEditors(): Promise<EditorPreferenceState>;
	setPreferredEditor(editorId: unknown): Promise<EditorId>;
	open(input: OpenSessionTargetInput): Promise<OpenSessionTargetResult>;
	openArtifacts(input: OpenSessionArtifactsInput): Promise<OpenSessionTargetResult>;
	openArtifactInBrowser(input: OpenArtifactInBrowserInput): Promise<void>;
	copyWorkspacePath(sessionId: string): Promise<void>;
};

// Every filesystem lookup here is asynchronous: this runs in Electron's main
// process, where a synchronous scan of the search path freezes the window.
async function defaultIsExecutable(candidatePath: string, platform: Platform): Promise<boolean> {
	try {
		const info = await stat(candidatePath);
		return info.isFile() && (platform === "win32" || (info.mode & constants.X_OK) !== 0);
	} catch {
		return false;
	}
}

async function defaultReadFileHead(candidatePath: string): Promise<string | undefined> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(candidatePath, "r");
		const buffer = Buffer.alloc(4096);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

// The Cursor Agent CLI installer puts a `cursor` shim in ~/.local/bin. Without
// the Cursor IDE it only runs `cursor agent` and exits 1 for anything else, so
// it must not count as an installed editor.
function isCursorAgentShim(fileHead: string | undefined): boolean {
	return fileHead?.includes("No Cursor IDE installation found") === true;
}

async function defaultIsDirectory(candidatePath: string): Promise<boolean> {
	try {
		return (await stat(candidatePath)).isDirectory();
	} catch {
		return false;
	}
}

// A directory that exists but cannot be read (search permission only) can still
// hold a command, so it reports undefined and is probed by name. Any other
// failure, a missing directory above all, leaves nothing to find.
async function defaultListDirectory(directory: string): Promise<string[] | undefined> {
	try {
		return await readdir(directory);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "EACCES" || code === "EPERM" ? undefined : [];
	}
}

type Probes = {
	isExecutable: (candidatePath: string) => Promise<boolean>;
	isDirectory: (candidatePath: string) => Promise<boolean>;
	readFileHead: (candidatePath: string) => Promise<string | undefined>;
};

/**
 * The filesystem as one scan for installed targets sees it. Each search
 * directory is read once and every candidate name is matched against that
 * listing in memory, so a scan costs one read per directory instead of one
 * stat per candidate, per extension, per directory.
 */
type TargetScan = Probes & {
	/** Where commands are looked up, in order, each directory once. */
	searchDirs: string[];
	/**
	 * How a listed name matches a command: case-insensitively on Windows, where
	 * PATHEXT and files on disk spell extensions in either case, exactly elsewhere.
	 */
	nameKey: (name: string) => string;
	/** A directory's names by nameKey, read at most once; undefined when it cannot be listed. */
	entries: (directory: string) => Promise<Map<string, string> | undefined>;
};

function createTargetScan(deps: EditorHandoffDeps, probes: Probes): TargetScan {
	const listDirectory = deps.listDirectory ?? defaultListDirectory;
	const nameKey = (name: string) => (deps.platform === "win32" ? name.toLowerCase() : name);
	const listings = new Map<string, Promise<Map<string, string> | undefined>>();
	return {
		...probes,
		searchDirs: commandSearchDirs(deps.platform, deps.env),
		nameKey,
		entries(directory) {
			let listing = listings.get(directory);
			if (!listing) {
				listing = listDirectory(directory).then((names) => names && new Map(names.map((name) => [nameKey(name), name])));
				listings.set(directory, listing);
			}
			return listing;
		},
	};
}

async function firstMatching<T>(values: readonly T[], matches: (value: T) => Promise<boolean>): Promise<T | undefined> {
	for (const value of values) {
		if (await matches(value)) return value;
	}
	return undefined;
}

function pathAPI(platform: Platform) {
	return platform === "win32" ? path.win32 : path.posix;
}

function isInside(api: typeof path.posix, dir: string, candidate: string): boolean {
	const relative = api.relative(dir, candidate);
	return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

// An artifact's absolute path with symlinks resolved, which must stay inside
// the artifact directory both as written and once resolved.
async function artifactFilePath(
	api: typeof path.posix,
	realPath: (candidatePath: string) => Promise<string>,
	artifactDir: string,
	relativePath: string,
): Promise<string> {
	if (typeof relativePath !== "string" || !relativePath.trim() || api.isAbsolute(relativePath)) {
		throw new Error("That artifact is not valid.");
	}
	const filePath = api.resolve(artifactDir, relativePath);
	if (!isInside(api, artifactDir, filePath)) throw new Error("That artifact is not valid.");
	const realDir = await realPath(artifactDir);
	const realFile = await realPath(filePath).catch(() => {
		throw new Error("That artifact no longer exists.");
	});
	if (!isInside(api, realDir, realFile)) throw new Error("That artifact is not valid.");
	return realFile;
}

function executableNames(command: string, platform: Platform, env: NodeJS.ProcessEnv): string[] {
	if (platform !== "win32" || pathAPI(platform).extname(command)) return [command];
	const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	const extended = [
		...extensions.map((extension) => command + extension.toLowerCase()),
		...extensions.map((extension) => command + extension.toUpperCase()),
	];
	// On win32, probe Windows-native launchers (.exe/.cmd/.bat/etc.) before the
	// bare, extension-less name. Editors like VS Code and Cursor ship a `.cmd`
	// batch shim and a bare `#!/usr/bin/env sh` script side by side; returning
	// the bare script makes spawn fail because Windows cannot execute an `sh`
	// script directly. Preferring the extension shims keeps the real launcher.
	return [...extended, command];
}

function commandSearchDirs(platform: Platform, env: NodeJS.ProcessEnv): string[] {
	const fromPath = (env.PATH || "").split(pathAPI(platform).delimiter).filter(Boolean);
	const dirs = platform === "darwin" ? [...fromPath, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
		: platform === "linux" ? [...fromPath, "/usr/local/bin", "/usr/bin"]
			: fromPath;
	// PATH often repeats a directory, with or without a trailing separator and,
	// on Windows, in any case. The first mention decides its place; later ones
	// add nothing.
	const seen = new Set<string>();
	return dirs.filter((directory) => {
		const normalized = pathAPI(platform).normalize(directory).replace(/(?<=.)[\\/]+$/, "");
		const key = platform === "win32" ? normalized.toLowerCase() : normalized;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// The first directory holding the command wins, and within it the first name
// in executableNames order: PATHEXT's order on Windows, then the bare name.
async function findCommand(
	command: string,
	directories: readonly string[],
	deps: EditorHandoffDeps,
	scan: TargetScan,
	skip?: (candidatePath: string) => Promise<boolean>,
): Promise<string | undefined> {
	// On Windows the upper- and lower-case PATHEXT spellings are one name.
	const keys = [...new Set(executableNames(command, deps.platform, deps.env).map(scan.nameKey))];
	for (const directory of directories) {
		const entries = await scan.entries(directory);
		// A listing answers for every candidate name at once, in the spelling on
		// disk. A directory that cannot be listed is probed one name at a time.
		const present = entries ? keys.flatMap((key) => entries.get(key) ?? []) : keys;
		for (const name of present) {
			const candidatePath = pathAPI(deps.platform).join(directory, name);
			if ((await scan.isExecutable(candidatePath)) && !(await skip?.(candidatePath))) return candidatePath;
		}
	}
	return undefined;
}

// Linux has no single terminal: these are the launchers found on the search
// path, in preference order. Other platforms use a fixed system terminal.
async function resolveTerminalLaunchers(deps: EditorHandoffDeps, scan: TargetScan): Promise<string[]> {
	if (deps.platform === "darwin" || deps.platform === "win32") return [];
	const found = await Promise.all(LINUX_TERMINAL_LAUNCHERS.map((launcher) => findCommand(launcher.command, scan.searchDirs, deps, scan)));
	return found.filter((command): command is string => command !== undefined);
}

function resolveTerminalEditor(editorCommand: string, deps: EditorHandoffDeps, terminalLaunchers: readonly string[]): ResolvedCommand | undefined {
	// The scan already found the launchers, so building a command line at launch
	// needs no filesystem access.
	const resolve = (target: string) => terminalCommand([editorCommand, target], deps.platform, deps.env, (candidatePath) => terminalLaunchers.includes(candidatePath));
	const spec = resolve(".");
	return spec
		? {
			command: spec.command,
			argsForFile: (filePath) => resolve(filePath)!.args,
			// launch() sets cwd to the workspace, so opening "." on Windows keeps the
			// workspace path out of cmd.exe variable expansion (for example %TEMP%).
			argsForWorkspace: (workspace) => resolve(deps.platform === "win32" ? "." : workspace)!.args,
		}
		: undefined;
}

// Expands a candidate's Windows install locations into real paths. Each entry
// is a sequence of path segments whose root is one of the WIN_INSTALL_ROOTS
// keys (resolved from env) followed by literal segments. Returns the concrete
// directories, skipping any whose root env var is unset.
function winInstallDirsFor(candidate: EditorCandidate, env: NodeJS.ProcessEnv): string[] {
	const dirs: string[] = [];
	for (const segments of candidate.winInstallDirs ?? []) {
		const [rootToken, ...rest] = segments;
		const resolver = WIN_INSTALL_ROOTS[rootToken];
		if (!resolver) continue;
		const root = resolver(env);
		if (!root) continue;
		dirs.push(path.win32.join(root, ...rest));
	}
	return dirs;
}

async function resolveEditor(
	candidate: EditorCandidate,
	deps: EditorHandoffDeps,
	scan: TargetScan,
	terminalLaunchers: readonly string[],
): Promise<ResolvedCommand | undefined> {
	for (const command of candidate.commands) {
		// Keep scanning PATH past the agent shim: a real Cursor CLI may follow it.
		const skip = candidate.id === "cursor"
			? async (candidatePath: string) => isCursorAgentShim(await scan.readFileHead(candidatePath)) : undefined;
		const resolved = await findCommand(command, scan.searchDirs, deps, scan, skip);
		if (resolved) {
			if (candidate.requiresTerminal) {
				const terminal = resolveTerminalEditor(resolved, deps, terminalLaunchers);
				return terminal ? { ...terminal, iconPath: resolved } : undefined;
			}
			const appPath = deps.platform === "darwin" ? await firstMatching((candidate.macApps ?? []).flatMap((name) =>
				["/Applications", path.posix.join(deps.homeDir, "Applications")].map((root) => path.posix.join(root, `${name}.app`)),
			), scan.isDirectory) : undefined;
			return {
				command: resolved,
				iconPath: appPath ?? resolved,
				argsForFile: (filePath) => [...(candidate.fileArgs ?? []), filePath],
				argsForWorkspace: (workspacePath) => [workspacePath],
			};
		}
	}
	// Windows-only fallback: probe standard per-user and system install locations
	// after PATH misses. Keep this on the PATH-first path so an explicit PATH
	// install always wins, and gate strictly on win32 so macOS/Linux are untouched.
	if (deps.platform === "win32") {
		const installDirs = winInstallDirsFor(candidate, deps.env);
		for (const command of candidate.commands) {
			const resolved = await findCommand(command, installDirs, deps, scan);
			if (resolved) return {
				command: resolved, iconPath: resolved,
				argsForFile: (filePath) => [...(candidate.fileArgs ?? []), filePath],
				argsForWorkspace: (workspacePath) => [workspacePath],
			};
		}
	}
	if (deps.platform !== "darwin") return undefined;
	for (const appName of candidate.macApps ?? []) {
		for (const root of ["/Applications", path.posix.join(deps.homeDir, "Applications")]) {
			if (await scan.isDirectory(path.posix.join(root, `${appName}.app`))) {
				return {
					command: "/usr/bin/open",
					iconPath: path.posix.join(root, `${appName}.app`),
					argsForFile: (filePath) => candidate.fileArgs?.length
						? ["-n", "-a", appName, "--args", ...candidate.fileArgs, filePath]
						: ["-a", appName, filePath],
					argsForWorkspace: (workspacePath) => ["-a", appName, workspacePath],
				};
			}
		}
	}
	return undefined;
}

type ResolvedTarget = { target: OpenTarget; command: ResolvedCommand };

function resolveTerminal(deps: EditorHandoffDeps, terminalLaunchers: readonly string[]): ResolvedTarget | undefined {
	if (deps.platform === "darwin") {
		return {
			target: { id: "terminal", name: "Terminal", kind: "terminal" },
			command: {
				command: "/usr/bin/open",
				iconPath: "/System/Applications/Utilities/Terminal.app",
				argsForWorkspace: (workspacePath) => ["-a", "Terminal", workspacePath],
			},
		};
	}
	if (deps.platform === "win32") {
		return {
			target: { id: "terminal", name: "Command Prompt", kind: "terminal" },
			command: {
				command: deps.env.ComSpec || deps.env.COMSPEC || "cmd.exe",
				argsForWorkspace: () => [],
			},
		};
	}
	const [launcher] = terminalLaunchers;
	return launcher ? {
		target: { id: "terminal", name: "Terminal", kind: "terminal" },
		command: { command: launcher, argsForWorkspace: () => [] },
	} : undefined;
}

// Keep per-terminal directory arguments explicit: a GUI terminal may reuse an
// existing process, in which case the launcher's cwd alone is not enough.
const TERMINAL_CANDIDATES: {
	id: TerminalId;
	name: string;
	command: string;
	macApp?: string;
	platforms: Platform[];
	args: (directory: string) => string[];
}[] = [
	{ id: "ghostty", name: "Ghostty", command: "ghostty", macApp: "Ghostty", platforms: ["darwin", "linux"], args: (dir) => [`--working-directory=${dir}`] },
	{ id: "iterm2", name: "iTerm2", command: "", macApp: "iTerm", platforms: ["darwin"], args: (dir) => [dir] },
	{ id: "wezterm", name: "WezTerm", command: "wezterm", macApp: "WezTerm", platforms: ["darwin", "linux", "win32"], args: (dir) => ["start", "--cwd", dir] },
	{ id: "kitty", name: "kitty", command: "kitty", macApp: "kitty", platforms: ["darwin", "linux"], args: (dir) => ["--directory", dir] },
	{ id: "alacritty", name: "Alacritty", command: "alacritty", macApp: "Alacritty", platforms: ["darwin", "linux", "win32"], args: (dir) => ["--working-directory", dir] },
	{ id: "gnome-terminal", name: "GNOME Terminal", command: "gnome-terminal", platforms: ["linux"], args: (dir) => [`--working-directory=${dir}`] },
	{ id: "konsole", name: "Konsole", command: "konsole", platforms: ["linux"], args: (dir) => ["--workdir", dir] },
	{ id: "xfce4-terminal", name: "Xfce Terminal", command: "xfce4-terminal", platforms: ["linux"], args: (dir) => [`--working-directory=${dir}`] },
	{ id: "windows-terminal", name: "Windows Terminal", command: "wt", platforms: ["win32"], args: (dir) => ["-d", dir] },
];

async function resolveInstalledTerminals(deps: EditorHandoffDeps, scan: TargetScan, macApps: MacTerminalApp[]): Promise<ResolvedTarget[]> {
	const claimedApps = new Set<string>();
	const known: ResolvedTarget[] = [];
	// One at a time and in order: each candidate claims apps the next must skip.
	for (const candidate of TERMINAL_CANDIDATES) {
		if (!candidate.platforms.includes(deps.platform)) continue;
		const target: OpenTarget = { id: candidate.id, name: candidate.name, kind: "terminal" };
		if (deps.platform === "darwin" && candidate.macApp) {
			const registered = macApps.filter((app) => path.posix.basename(app.appPath) === `${candidate.macApp}.app`);
			const appPath = await firstMatching([
				...registered.map((app) => app.appPath),
				...["/Applications", path.posix.join(deps.homeDir, "Applications")].map((root) => path.posix.join(root, `${candidate.macApp}.app`)),
			], scan.isDirectory);
			if (appPath) {
				for (const app of registered) claimedApps.add(app.appPath);
				claimedApps.add(appPath);
				const iconDataUrl = registered.find((app) => app.appPath === appPath)?.iconDataUrl;
				if (iconDataUrl) target.iconDataUrl = iconDataUrl;
				known.push({ target, command: {
					command: "/usr/bin/open",
					iconPath: appPath,
					// Ghostty and iTerm set the surface directory from folder-open
					// events, including when already running. Other apps use CLI flags.
					argsForWorkspace: (dir: string) => candidate.id === "iterm2" || candidate.id === "ghostty"
						? ["-a", appPath, dir]
						: ["-n", "-a", appPath, "--args", ...candidate.args(dir)],
				} });
				continue;
			}
			// Ghostty's native macOS app must launch through Launch Services.
			if (candidate.id === "ghostty" || candidate.id === "iterm2") continue;
		}
		const command = candidate.command && await findCommand(candidate.command, scan.searchDirs, deps, scan);
		if (command) known.push({ target, command: { command, argsForWorkspace: candidate.args } });
	}
	const claimedBundleIds = new Set(["com.apple.terminal"]);
	const discovered: ResolvedTarget[] = [];
	for (const app of macApps) {
		if (claimedBundleIds.has(app.bundleId.toLowerCase()) || claimedApps.has(app.appPath) || !(await scan.isDirectory(app.appPath))) continue;
		claimedApps.add(app.appPath);
		claimedBundleIds.add(app.bundleId.toLowerCase());
		// An opaque stable ID crosses IPC; installation paths remain in main.
		const id: TerminalId = `terminal-app:${createHash("sha256").update(app.bundleId.toLowerCase()).digest("hex")}`;
		discovered.push({ target: { id, name: app.name, kind: "terminal", ...(app.iconDataUrl ? { iconDataUrl: app.iconDataUrl } : {}) }, command: {
			command: "/usr/bin/open",
			iconPath: app.appPath,
			argsForWorkspace: (dir: string) => ["-a", app.appPath, dir],
		} });
	}
	return [...known, ...discovered.sort((a, b) => a.target.name.localeCompare(b.target.name))];
}

// Which editors and terminals are installed is the same for every session and
// rarely changes, while finding out means reading every directory on the search
// path. Readiness polling, session events and switching sessions therefore
// share one scan for this long. A menu refresh, the Settings list and every
// launch scan again, so a new install shows up when someone looks for it and a
// removed target is never launched from memory.
export const INSTALLED_TARGETS_TTL_MS = 30_000;

type InstalledTargets = { editors: ResolvedTarget[]; terminals: ResolvedTarget[] };

export function createEditorHandoff(deps: EditorHandoffDeps): EditorHandoff {
	const probes: Probes = {
		isExecutable: async (candidatePath) => (deps.isExecutable ? deps.isExecutable(candidatePath) : defaultIsExecutable(candidatePath, deps.platform)),
		isDirectory: async (candidatePath) => (deps.isDirectory ?? defaultIsDirectory)(candidatePath),
		readFileHead: async (candidatePath) => (deps.readFileHead ?? defaultReadFileHead)(candidatePath),
	};
	const fileManager: OpenTarget = {
		id: "file-manager",
		name: deps.platform === "darwin" ? "Finder" : deps.platform === "win32" ? "File Explorer" : "File Manager",
		kind: "file_manager",
	};
	// Linux opens folders through xdg-open, so there is no single app to take an icon from.
	const fileManagerIconPath = deps.platform === "darwin" ? "/System/Library/CoreServices/Finder.app"
		: deps.platform === "win32" ? path.win32.join(deps.env.SystemRoot || deps.env.windir || "C:\\Windows", "explorer.exe")
			: undefined;

	const icons = new Map<string, Promise<string | undefined>>();
	const readIcon = (iconPath: string) => {
		if (!deps.readIcon) return Promise.resolve(undefined);
		let icon = icons.get(iconPath);
		if (!icon) {
			icon = deps.readIcon(iconPath).then((data) => /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data) ? data : undefined).catch(() => {
				icons.delete(iconPath);
				return undefined;
			});
			icons.set(iconPath, icon);
		}
		return icon;
	};

	// Only an explicit menu refresh queries Launch Services and renders bundle
	// icons. Readiness polling, CDC invalidations, and launches use this shared
	// main-process snapshot; file existence is still checked by each scan.
	let macApps: MacTerminalApp[] = [];
	let terminalRefresh: Promise<void> | undefined;
	const refreshTerminals = () => {
		if (deps.platform !== "darwin" || !deps.discoverTerminalApps) return Promise.resolve();
		if (!terminalRefresh) {
			terminalRefresh = deps.discoverTerminalApps().then((apps) => { macApps = apps; }).catch((error) => {
				deps.logError?.("failed to discover terminal apps", error);
			}).finally(() => { terminalRefresh = undefined; });
		}
		return terminalRefresh;
	};
	const scanInstalledTargets = async (): Promise<InstalledTargets> => {
		const scan = createTargetScan(deps, probes);
		const terminalLaunchers = await resolveTerminalLaunchers(deps, scan);
		const [editors, installedTerminals] = await Promise.all([
			Promise.all(EDITOR_CANDIDATES.map(async (candidate): Promise<ResolvedTarget[]> => {
				const command = await resolveEditor(candidate, deps, scan, terminalLaunchers);
				return command ? [{ target: { id: candidate.id, name: candidate.name, kind: "editor" }, command }] : [];
			})),
			resolveInstalledTerminals(deps, scan, macApps),
		]);
		const terminal = resolveTerminal(deps, terminalLaunchers);
		return { editors: editors.flat(), terminals: [...(terminal ? [terminal] : []), ...installedTerminals] };
	};
	let cached: { targets: Promise<InstalledTargets>; scannedAt: number } | undefined;
	// The cache holds the scan's promise, so calls that arrive while it runs share it.
	const installedTargets = (fresh = false): Promise<InstalledTargets> => {
		// A negative age means the clock went back: scan again instead of trusting it.
		const age = cached ? Date.now() - cached.scannedAt : -1;
		if (!fresh && cached && age >= 0 && age < INSTALLED_TARGETS_TTL_MS) return cached.targets;
		const entry = { targets: scanInstalledTargets(), scannedAt: Date.now() };
		cached = entry;
		// A failed scan is not an answer worth keeping for the next reads.
		entry.targets.catch(() => {
			if (cached === entry) cached = undefined;
		});
		return entry.targets;
	};

	const openTarget = async (target: OpenTarget, resolved: ResolvedCommand | undefined, directory: string, revealPath?: string) => {
		try {
			if (target.kind === "file_manager") {
				await (revealPath ? deps.revealPath(revealPath) : deps.openDirectory(directory));
			} else {
				if (!resolved) throw new Error("target command was not resolved");
				await deps.launch(resolved.command, resolved.argsForWorkspace(directory), directory);
			}
		} catch (error) {
			deps.logError?.(`failed to open session target ${target.id}`, error);
			throw new Error(`Could not open ${target.name}. Check that it is installed and try again.`);
		}
	};

	const workspaceUnavailable = (error: unknown) =>
		error instanceof Error && error.message.trim() ? error.message : "Session workspace is not available.";
	const workspaceUnavailableCode = (error: unknown) => {
		const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
		return typeof code === "string" && code ? code : undefined;
	};

	return {
		async pathAction(input) {
			if (typeof input.sessionId !== "string" || !input.sessionId.trim()) throw new Error("Session is required.");
			if (!["copy", "reveal", "open"].includes(input.action)) throw new Error("That path action is not supported.");
			if (typeof input.path !== "string" || !input.path.trim() || /[\x00-\x1f]/.test(input.path)) throw new Error("That path is not valid.");
			const api = pathAPI(deps.platform);
			const reference = input.path;
			// Only normalized filesystem paths cross this boundary, never URLs or shell commands.
			if ((/^[a-z][a-z\d+.-]*:/i.test(reference) && !(deps.platform === "win32" && /^[a-z]:[\\/]/i.test(reference))) || reference.startsWith("//") || reference.startsWith("\\\\")) {
				throw new Error("That path is not valid.");
			}
			const workspace = await deps.resolveWorkspace(input.sessionId.trim());
			const expanded = reference === "~" ? deps.homeDir : reference.startsWith("~/") ? deps.homeDir + reference.slice(1) : reference;
			const absolute = api.isAbsolute(expanded);
			// Resolve only the root/drive here. Joining or resolving the whole path
			// would collapse parent components before the filesystem follows symlinks.
			const root = api.parse(expanded).root;
			const anchor = absolute ? api.resolve(workspace, root) : workspace;
			const tail = absolute ? expanded.slice(root.length) : expanded;
			const unnormalized = `${anchor}${anchor.endsWith(api.sep) ? "" : api.sep}${tail}`;
			const target = deps.platform === "win32" ? unnormalized.replace(/\//g, "\\") : unnormalized;
			if (input.action === "copy") {
				// Copy is textual and supports missing files; retain their original components.
				if (!absolute) {
					const root = await deps.realPath(workspace);
					let ancestor = target;
					const missing: string[] = [];
					let candidate: string;
					for (;;) {
						try {
							candidate = api.resolve(await deps.realPath(ancestor), ...missing);
							break;
						} catch (error) {
							const parent = api.dirname(ancestor);
							if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === ancestor) throw new Error("That path could not be resolved.");
							// dirname preserves '..': follow existing links before normalizing
							// the suffix whose components do not exist yet.
							missing.unshift(api.basename(ancestor));
							ancestor = parent;
						}
					}
					if (candidate !== root && !isInside(api, root, candidate)) throw new Error("That path is outside the session workspace.");
				}
				if (!deps.copyText) throw new Error("Copying is not available.");
				await deps.copyText(target);
				return;
			}
			const realTarget = await deps.realPath(target).catch(() => { throw new Error("That path no longer exists."); });
			if (!absolute) {
				const realWorkspace = await deps.realPath(workspace);
				if (realTarget !== realWorkspace && !isInside(api, realWorkspace, realTarget)) throw new Error("That path is outside the session workspace.");
			}
			if (input.action === "reveal") {
				await deps.revealPath(realTarget);
				return;
			}
			if (!isEditorId(input.editorId)) throw new Error("That editor is not supported.");
			const editor = (await installedTargets(true)).editors.find(({ target }) => target.id === input.editorId);
			if (!editor) throw new Error("That editor is not installed. Choose another option.");
			// Batch shims and terminal editors use cmd.exe, which expands percent variables even in quotes.
			const command = editor.command.command;
			if (deps.platform === "win32" && /[%!"]/.test(realTarget) && (/\.(?:cmd|bat)$/i.test(command) || api.basename(command).toLowerCase() === "cmd.exe")) {
				throw new Error("That path cannot be passed safely to this editor launcher.");
			}
			const cwd = (await probes.isDirectory(realTarget)) ? realTarget : api.dirname(realTarget);
			await deps.launch(editor.command.command, (editor.command.argsForFile ?? editor.command.argsForWorkspace)(realTarget), cwd);
		},
		async getState(sessionId, options) {
			// Opening a menu asks for a refresh: look again for anything newly installed.
			const refresh = options?.refreshTerminals === true;
			if (refresh) await refreshTerminals();
			const { editors, terminals } = await installedTargets(refresh);
			// Linux's generic launcher may be the same binary (or an alternatives
			// symlink) as a named terminal. Show it only as a fallback in the menu;
			// the generic target remains available to existing shortcut/artifact callers.
			const menuTerminals = deps.platform === "linux" && terminals.some(({ target }) => target.id !== "terminal")
				? terminals.filter(({ target }) => target.id !== "terminal") : terminals;
			const targets = [...editors.map(({ target }) => target), fileManager, ...menuTerminals.map(({ target }) => target)];
			const targetsWithIcons = await Promise.all(targets.map(async (target) => {
				if (target.iconDataUrl) return target;
				const editor = editors.find((entry) => entry.target.id === target.id);
				const terminal = terminals.find((entry) => entry.target.id === target.id);
				let iconPath = editor?.command.iconPath ?? (terminal
					? terminal.command.iconPath ?? terminal.command.command
					: target.kind === "file_manager" ? fileManagerIconPath : undefined);
				if (editor) {
					// CLI shims may point into a relocated .app. Use that actual bundle's
					// native icon before falling back to the registered installation or executable.
					const executable = await deps.realPath(editor.command.command).catch(() => editor.command.command);
					const bundle = deps.platform === "darwin" ? executable.match(/^(.+?\.app)(?:\/|$)/i)?.[1] : undefined;
					iconPath = bundle ?? iconPath ?? executable;
				}
				const iconDataUrl = iconPath ? await readIcon(iconPath) : undefined;
				return iconDataUrl ? { ...target, iconDataUrl } : target;
			}));
			const preferredEditorId = await deps.readPreference();
			try {
				await deps.resolveWorkspace(sessionId);
				return { targets: targetsWithIcons, preferredEditorId, workspaceAvailable: true };
			} catch (error) {
				return {
					targets: targetsWithIcons,
					preferredEditorId,
					workspaceAvailable: false,
					unavailableReason: workspaceUnavailable(error),
					unavailableCode: workspaceUnavailableCode(error),
				};
			}
		},

		async getEditors() {
			const { editors } = await installedTargets(true);
			return { editors: editors.map(({ target }) => target), preferredEditorId: await deps.readPreference() };
		},

		async setPreferredEditor(editorId) {
			if (!isEditorId(editorId)) throw new Error("That editor is not supported.");
			if (!(await installedTargets(true)).editors.some(({ target }) => target.id === editorId)) {
				throw new Error("That editor is not installed. Choose another option.");
			}
			await deps.writePreference(editorId);
			return editorId;
		},

		async open(input) {
			const sessionId = input.sessionId.trim();
			if (!sessionId) throw new Error("Session is required.");
			const preferredEditorId = await deps.readPreference();
			const targetId = input.targetId ?? preferredEditorId;
			if (input.targetId && input.targetId !== "file-manager" && !isTerminalId(input.targetId) && !isEditorId(input.targetId)) {
				throw new Error("That open target is not supported.");
			}
			let entry: ResolvedTarget | undefined;
			if (targetId !== "file-manager") {
				const { editors, terminals } = await installedTargets(true);
				entry = (isTerminalId(targetId) ? terminals : editors).find(({ target }) => target.id === targetId);
			}
			const target = targetId === "file-manager" ? fileManager : entry?.target;
			if (!target) {
				if (isEditorId(targetId)) throw new Error("That editor is not installed. Choose another option.");
				throw new Error("That open target is not available.");
			}
			const workspacePath = await deps.resolveWorkspace(sessionId);
			const resolved = entry?.command;
			await openTarget(target, resolved, workspacePath);
			if (target.kind === "editor") await deps.writePreference(target.id as EditorId);
			return target;
		},

		async openArtifacts(input) {
			const sessionId = input.sessionId.trim();
			if (!sessionId) throw new Error("Session is required.");
			if (input.targetId !== "file-manager" && input.targetId !== "terminal") {
				throw new Error("That open target is not supported.");
			}
			// Only the system terminal opens here, so look up its launchers alone.
			const terminal = input.targetId === "terminal"
				? resolveTerminal(deps, await resolveTerminalLaunchers(deps, createTargetScan(deps, probes))) : undefined;
			const target = input.targetId === "file-manager" ? fileManager : terminal?.target;
			if (!target) throw new Error("That open target is not available.");
			const artifactDir = await deps.resolveArtifactDir(sessionId);
			const filePath = input.path === undefined ? undefined : await artifactFilePath(pathAPI(deps.platform), deps.realPath, artifactDir, input.path);
			await openTarget(target, terminal?.command, filePath ? pathAPI(deps.platform).dirname(filePath) : artifactDir, filePath);
			return target;
		},

		async openArtifactInBrowser(input) {
			const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
			if (!sessionId) throw new Error("Session is required.");
			if (!deps.openInBrowser) throw new Error("Opening in a browser is not available.");
			const api = pathAPI(deps.platform);
			if (typeof input.path !== "string" || !isBrowserArtifactPath(input.path)) {
				throw new Error("This file does not open in a browser.");
			}
			const artifactDir = await deps.resolveArtifactDir(sessionId);
			const filePath = await artifactFilePath(api, deps.realPath, artifactDir, input.path);
			// The resolved file, not just the name asked for, must be one a browser renders.
			if (!isBrowserArtifactPath(filePath)) throw new Error("This file does not open in a browser.");
			await deps.openInBrowser(filePath);
		},

		async copyWorkspacePath(sessionId) {
			const id = sessionId.trim();
			if (!id) throw new Error("Session is required.");
			if (!deps.copyText) throw new Error("Copying is not available.");
			await deps.copyText(await deps.resolveWorkspace(id));
		},
	};
}
