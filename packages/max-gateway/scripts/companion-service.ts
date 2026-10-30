// @effect-diagnostics nodeBuiltinImport:off - Standalone Node installer without an Effect runtime.
// @effect-diagnostics globalConsole:off - Operator-facing installer output.
// @effect-diagnostics globalDate:off - Bounded launchd startup deadline.
// @effect-diagnostics globalTimers:off - Bounded launchd startup check.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const LABEL = "com.t3mc.max-companion";
const ROOT = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));

export function servicePaths(home: string, override?: string) {
  const base = NodePath.resolve(override ?? NodePath.join(home, ".t3/max-companion"));
  return {
    home: NodePath.resolve(home),
    base,
    app: NodePath.join(base, "app"),
    previous: NodePath.join(base, "app.prev"),
    runner: NodePath.join(base, "run.sh"),
    log: NodePath.join(base, "logs/companion.log"),
    plist: NodePath.join(home, "Library/LaunchAgents", `${LABEL}.plist`),
    env: NodePath.join(home, ".t3/max-gateway.env"),
  };
}
type Paths = ReturnType<typeof servicePaths>;
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function servicePlist(paths: Paths) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(paths.runner)}</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(paths.home)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(paths.log)}</string>
<key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict></plist>\n`;
}

export function serviceRunner(paths: Paths, node: string) {
  return `#!/bin/sh
set -eu
export HOME=${quote(paths.home)}
set -a
. ${quote(paths.env)}
set +a
export MAX_GATEWAY_URL="\${MAX_GATEWAY_URL:-https://max-gateway-production.up.railway.app}"
export T3_BIN="\${T3_BIN:-$HOME/.t3/bin/t3}"
cd ${quote(paths.app)}
exec ${quote(node)} ${quote(NodePath.join(paths.app, "companion.mjs"))}
`;
}

function command(binary: string, args: string[], allowFailure = false) {
  const result = NodeChildProcess.spawnSync(binary, args, { encoding: "utf8" });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `${binary} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout ?? "";
}
async function readLog(paths: Paths) {
  try {
    return await NodeFSP.readFile(paths.log, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
async function rotateLog(paths: Paths) {
  if (NodeFS.existsSync(paths.log) && (await NodeFSP.stat(paths.log)).size > 10 * 1024 * 1024) {
    await NodeFSP.rename(paths.log, `${paths.log}.1`);
  }
}
function nodeExecutable() {
  const node = NodeFS.existsSync("/Users/owner/.local/bin/node")
    ? "/Users/owner/.local/bin/node"
    : command("/bin/sh", ["-c", "command -v node"]).trim();
  const version = command(node, ["--version"]).trim();
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13))
    throw new Error(`Node 22.13 or newer is required; found ${version}.`);
  return node;
}
async function status(paths: Paths, domain: string, dryRun: boolean) {
  if (dryRun) {
    console.log(`Dry run: launchd status and socket inspection skipped (${LABEL}).`);
  } else {
    const state = command("launchctl", ["print", `${domain}/${LABEL}`], true);
    console.log(state || "Service is not loaded.");
    const pid = /\bpid = (\d+)/.exec(state)?.[1];
    const sockets = pid
      ? command("/usr/sbin/lsof", ["-a", "-p", pid, "-iTCP", "-sTCP:ESTABLISHED", "-nP"], true)
      : "";
    console.log(
      `Established TCP socket: ${sockets.includes("ESTABLISHED") ? "yes (tunnel candidate; verify connected log)" : "no"}`,
    );
  }
  console.log(
    (await readLog(paths)).trimEnd().split("\n").slice(-5).join("\n") || "No log entries.",
  );
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = NodeUtil.parseArgs({
    args,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      home: { type: "string", default: NodeOS.homedir() },
    },
  });
  const action = positionals[0];
  if (
    positionals.length !== 1 ||
    !["install", "uninstall", "restart", "status", "logs"].includes(action ?? "")
  ) {
    throw new Error(
      "Usage: companion-service.ts install|uninstall|restart|status|logs [--dry-run --home <dir>]",
    );
  }
  const dryRun = values["dry-run"];
  const home = NodePath.resolve(values.home);
  // An inherited override must never redirect a dry run into the live installation.
  const paths = servicePaths(home, process.env.MAX_COMPANION_HOME);
  if (dryRun && (home === NodeOS.homedir() || !paths.base.startsWith(`${home}${NodePath.sep}`))) {
    throw new Error(
      "--dry-run requires a separate --home directory and MAX_COMPANION_HOME inside it (or unset).",
    );
  }
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const launch = (args: string[], allowFailure = false) => {
    if (dryRun) console.log(`Dry run: launchctl ${args.join(" ")}`);
    else command("launchctl", args, allowFailure);
  };
  if (action === "install") {
    const node = nodeExecutable();
    const stage = NodePath.join(paths.base, "app.next");
    await NodeFSP.mkdir(stage, { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(paths.log), { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(paths.plist), { recursive: true });
    const require = NodeModule.createRequire(NodePath.join(ROOT, "scripts/package.json"));
    const { build } = require("esbuild") as {
      build: (options: Record<string, unknown>) => Promise<unknown>;
    };
    await build({
      entryPoints: [NodePath.join(ROOT, "packages/max-gateway/src/miniCompanion.ts")],
      outfile: NodePath.join(stage, "companion.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22.13",
      packages: "bundle",
      external: ["node:*"],
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
    });
    // Validate the staged artifact without credentials or access to the live engine.
    const probe = NodeChildProcess.spawnSync(node, [NodePath.join(stage, "companion.mjs")], {
      env: {},
      encoding: "utf8",
      timeout: 10_000,
    });
    if (probe.status === 0 || !probe.stderr?.includes("MAX_TUNNEL_SECRET is required"))
      throw new Error(`Bundle load check failed: ${probe.error?.message ?? probe.stderr}`);
    const plistStage = `${paths.plist}.next`;
    await NodeFSP.writeFile(plistStage, servicePlist(paths), { mode: 0o600 });
    command("plutil", ["-lint", plistStage]);
    launch(["bootout", `${domain}/${LABEL}`], true);
    if (NodeFS.existsSync(paths.app)) {
      await NodeFSP.rm(paths.previous, { recursive: true, force: true });
      await NodeFSP.rename(paths.app, paths.previous);
    }
    await NodeFSP.rename(stage, paths.app);
    await NodeFSP.writeFile(paths.runner, serviceRunner(paths, node), { mode: 0o700 });
    await NodeFSP.chmod(paths.runner, 0o700);
    await NodeFSP.rename(plistStage, paths.plist);
    await rotateLog(paths);
    const offset = (await readLog(paths)).length;
    launch(["bootstrap", domain, paths.plist]);
    if (!dryRun) {
      const deadline = Date.now() + 20_000;
      while (!(await readLog(paths)).slice(offset).includes("max companion tunnel connected")) {
        if (Date.now() >= deadline)
          throw new Error(
            "No tunnel-connected message within 20 seconds. Check companion:status and companion:logs; app.prev retains the previous app.",
          );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    console.log(
      dryRun
        ? "Dry run: bundle loads, empty-environment check passes, plist valid; no live service changed."
        : "Companion installed and tunnel connected.",
    );
    await status(paths, domain, dryRun);
  } else if (action === "uninstall") {
    launch(["bootout", `${domain}/${LABEL}`], true);
    await NodeFSP.rm(paths.plist, { force: true });
    console.log("LaunchAgent removed; app, logs and environment file retained.");
  } else if (action === "restart") {
    await rotateLog(paths);
    launch(["kickstart", "-k", `${domain}/${LABEL}`]);
    await status(paths, domain, dryRun);
  } else if (action === "status") await status(paths, domain, dryRun);
  else console.log((await readLog(paths)).trimEnd().split("\n").slice(-100).join("\n"));
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodeFS.realpathSync(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
