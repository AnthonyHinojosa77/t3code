# Mini companion login service

The companion keeps an outbound connection from the Mac Mini to the MAX gateway,
so the gateway can reach the local T3 server. The login service starts when you
sign in and launchd restarts it if it exits. It does not start the T3 server.

Use Node 22.13 or newer and install the repository dependencies first. From the
repository root, install or update the companion with:

```sh
pnpm --filter @t3tools/max-gateway companion:install
```

The installer bundles the companion and its dependencies into one file. The
installed service no longer depends on this checkout or its node_modules. It
loads `~/.t3/max-gateway.env`, which must contain `MAX_TUNNEL_SECRET`. Keep that
file private. The gateway URL defaults to
`https://max-gateway-production.up.railway.app` and T3 defaults to `~/.t3/bin/t3`.
The installer prefers `/Users/owner/.local/bin/node` if present, otherwise Node
on PATH; retain that executable after installation.

Check the service, restart it, or read its logs:

```sh
pnpm --filter @t3tools/max-gateway companion:status
pnpm --filter @t3tools/max-gateway companion:restart
pnpm --filter @t3tools/max-gateway companion:logs
```

Status includes launchd's state, PID and last exit status (when available), the
last five log lines, and whether its process has an established TCP connection.
That socket is a tunnel candidate; the `max companion tunnel connected` message
confirms the handshake. Installation waits up to 20 seconds for a new connection
message. If it times out, inspect status and logs; the service remains installed.

To stop automatic startup, uninstall the login service; to start it again, install:

```sh
pnpm --filter @t3tools/max-gateway companion:uninstall
pnpm --filter @t3tools/max-gateway companion:install
```

Uninstall removes the LaunchAgent, keeping the app, logs and environment file.
Updates retain the previous app at `~/.t3/max-companion/app.prev`. To roll back,
check out the previous known-good repository revision and run `companion:install`.
Logs above 10 MB rotate to `companion.log.1` at install/restart.

## Move to the Mac Mini

Clone the repository on the Mini, install dependencies there, and securely copy
`~/.t3/max-gateway.env` to the same path under the Mini user's home (permissions
0600). Do not paste it into chat or commit it. Install Node 22.13 or newer, ensure
T3 is running there, then run the same install and status commands on the Mini.
Stop the old machine's companion with `companion:uninstall` when ready to move the
connection. This is a per-user login service, so the Mini user must be signed in.

## Safe installer check

```sh
test_home=$(mktemp -d)
pnpm --filter @t3tools/max-gateway companion:install --dry-run --home "$test_home"
```

Dry run requires a separate home, writes only beneath it, validates the plist,
and runs the bundle with an empty environment. Success requires a nonzero exit
with `MAX_TUNNEL_SECRET is required`; it never contacts the gateway or launchd.
All subcommands accept `--dry-run --home <dir>`. `MAX_COMPANION_HOME` overrides
only the app/log directory; for dry runs it must be unset or inside the test home.
