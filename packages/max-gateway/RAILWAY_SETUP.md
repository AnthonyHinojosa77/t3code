# Railway setup for the T3 MAX tunnel (Task 0)

This is a runbook, not a deploy. Nobody in this task signs in to Railway, installs the Railway CLI, or creates a project. Dashboard values are the source of truth for a new service. `railway.json` at the repo root is a reference copy only.

Checked 2026-10-29: [Using Config as Code](https://docs.railway.com/guides/config-as-code) says config-as-code is deprecated, existing `railway.json` files work until 2026-12-01, and new services cannot opt in. A new service will not take its settings from `railway.json`.

## 1. Owner sign-in (Anthony only)

1. Sign in to Railway in the browser, or run `railway login` on a machine he controls.
2. Stop there. The manager does every step below after that sign-in exists.

This is the only account step. Do not put a token, a session cookie, or the tunnel secret in the repo, the PR, or chat.

## 2. Manager steps after sign-in

Do these in order. The service root is the repository root.

### 2.1 Create the project and service

1. Create a Railway project whose service deploys GitHub repo `AnthonyHinojosa77/t3code`.
2. Set the service branch to `feat/t3mc-task0-tunnel`.
3. When later Task 0 work has merged, repoint that service at the branch the merge landed on. Do that as the work merges. Do not deploy from `main` for this proof.

### 2.2 Builder, build, and start

Enter these on the service in the dashboard.

- Builder: Railpack. That is Railway's builder for a new service. The `NIXPACKS` value in `railway.json` is reference only.
- Build command: `pnpm --filter @t3tools/web build && pnpm --filter @t3tools/max-gateway build`
- Start command: `node --experimental-strip-types packages/max-gateway/src/start.ts`
- Healthcheck path: `/__max/health`
- Healthcheck timeout: 30 seconds
- Restart: on failure, 3 retries (`railway.json` uses `ON_FAILURE` and `restartPolicyMaxRetries` 3)

`pnpm --filter @t3tools/max-gateway build` is `tsc --noEmit`. It does not emit JavaScript. The start command runs the TypeScript file with Node's type stripper. That local typecheck was run; see the PR validation.

The `apps/web` half of the build command was not run on the build machine (disk was too full). Whether that web build succeeds on Railway is unverified. `packages/max-gateway/src/start.ts` does not serve `apps/web/dist`. The phone sees the responses from T3 on the Mac Mini, proxied through this gateway. The Railway web build is not what the phone renders.

### 2.3 Node version

The start command needs Node's `--experimental-strip-types`. Root `package.json` `engines.node` is `26.12.1`.

For this new service, set a Railway variable `RAILPACK_NODE_VERSION` to `26.12.1`. [Railpack's Node docs](https://railpack.com/languages/node/) resolve the version in this order: `RAILPACK_NODE_VERSION`, then `devEngines.runtime` in `package.json`, then `engines.node`, then `.nvmrc`, `.node-version`, `mise.toml` or `.tool-versions`, otherwise `lts`. The root manifest already has the exact `engines.node` value, so Railpack still sees `26.12.1` if the variable is left unset. [Railpack package resolution](https://railpack.com/architecture/package-resolution/) says an exact version pins, and a range is collapsed to the major before Mise picks a release. Whether the Mise registry serving that build has Node `26.12.1` is unverified until the build log prints `node --version`.

Nixpacks is not the path for this new service. [Nixpacks' Node provider](https://nixpacks.com/docs/providers/node) accepts a major version only (`NIXPACKS_NODE_VERSION`, `engines.node`, or `.nvmrc`), and its published major list does not include 26. Do not expect the `railway.json` Nixpacks builder to install `26.12.1`.

### 2.4 Volume at `/data`

Create the volume in the dashboard, or with the CLI after the owner is signed in:

```bash
railway volume add --mount-path /data
```

Dashboard path: create a volume, connect it to this service, set the mount path to `/data`. [Using Volumes](https://docs.railway.com/guides/volumes) describes the dashboard. [railway volume](https://docs.railway.com/cli/volume) documents the command above.

`railway.json` contains `deploy.requiredMountPath` set to `/data`. The schema at `https://railway.com/railway.schema.json` (fetched from `https://backboard.railway.app/railway.schema.json`) describes that field only as "Required mount path for the deployment". Whether setting the field provisions a volume was not observed. Do not treat the field as the create step. Config-as-code is also not applied to a new service.

Task 0 gateway code does not read or write `/data`. The companion's token file lives on the Mini, under `T3CODE_HOME` or `~/.t3`. Attach the volume anyway; the plan calls for it.

### 2.5 Environment variables

Names only. Values stay empty in git. The lists match `packages/max-gateway/.env.example`.

Gateway, on the Railway service:

| Name                          | Role                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_TUNNEL_SECRET`           | Required. Shared with the Mini. See 2.6.                                                                                                        |
| `PORT`                        | Leave unset. Railway injects it. `start.ts` uses it, and falls back to `8080` only when it is absent. It must be a positive integer.            |
| `HOST`                        | Optional. `start.ts` defaults to `0.0.0.0`, which is what Railway's proxy needs.                                                                |
| `MAX_OWNER_SESSION_ALLOWLIST` | Task 0 stand-in for MAX login. Comma-separated `maximus_session` cookie values. Empty means every proxied request is 401. Task 1 replaces this. |

Mac Mini companion. Run this on the Mini, not on Railway. Same secret as the gateway.

| Name                         | Role                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_GATEWAY_URL`            | Public Railway origin, `https://<service-domain>`. A full `wss://.../__max/tunnel` URL is also accepted.                         |
| `MAX_TUNNEL_URL`             | Optional alias of `MAX_GATEWAY_URL`.                                                                                             |
| `MAX_TUNNEL_SECRET`          | Same value as the gateway.                                                                                                       |
| `T3_UPSTREAM_HTTP`           | Optional. Default `http://127.0.0.1:3773`.                                                                                       |
| `T3_UPSTREAM_WS`             | Optional. Default `ws://127.0.0.1:3773`.                                                                                         |
| `MAX_COMPANION_BEARER_TOKEN` | Optional. If set, the companion uses this bearer and does not call `t3`. Leave unset on the Mini so the token is issued locally. |
| `MAX_COMPANION_TOKEN_PATH`   | Optional. Default `$T3CODE_HOME/max-companion-token.json`, or `~/.t3/max-companion-token.json`. The file mode is `0600`.         |
| `MAX_COMPANION_TOKEN_TTL`    | Optional. Default `365d`. The companion re-issues when expiry is inside 7 days.                                                  |
| `T3_BIN`                     | Optional path to the `t3` binary. Default `t3` on `PATH`.                                                                        |
| `T3CODE_HOME`                | Optional T3 home directory. Default `~/.t3`.                                                                                     |

The local issue command, from `packages/max-gateway/src/bearerToken.ts`, is `t3 auth session issue` with `--scope` repeated (not `--scopes`), `--ttl`, `--token-only`, and `--label max-companion`. Scopes: `orchestration:read`, `orchestration:operate`, `filesystem:read`, `filesystem:write`, `source-control:write`, `terminal:operate`, `settings:write`.

### 2.6 Generate the tunnel secret

On a machine that already has Railway access, generate one value and do not print it into chat, a commit, or the PR:

```bash
openssl rand -hex 32
```

Put that value in two places only:

1. The Railway service variable `MAX_TUNNEL_SECRET`.
2. The Mini's environment variable `MAX_TUNNEL_SECRET` for the companion process.

### 2.7 Start the companion on the Mini

T3 must already be listening on port 3773 on the Mini. From a checkout of this repo on the Mini, with the variables above exported and no secret written into the shell history if that can be avoided:

```bash
node --experimental-strip-types packages/max-gateway/src/miniCompanion.ts
```

The process logs `max companion tunnel connected` on success. It does not log the bearer token or the tunnel secret.

### 2.8 Phone check (live pass mark)

This check is not done by the PR. After the service is healthy and the companion log says the tunnel is connected:

1. On a phone, open the Railway HTTPS URL.
2. Sign-in stand-in: Task 1 is what issues a `maximus_session` cookie. Until that exists, a normal MAX login will not pass this gateway. A proxied request is allowed only when that cookie's value is listed in `MAX_OWNER_SESSION_ALLOWLIST`. Getting a real cookie into the phone is an owner step at live time, not part of this PR.
3. Confirm providers and usage are visible. Those pages are served by T3 on the Mini and proxied. Unverified until this check is run.
4. Confirm an attachment round-trip: upload a file and download it back through the proxied app. Unverified until this check is run.

`/__max/health` returning `{"ok":true}` only proves the gateway process is up. It does not prove the tunnel, the Mini, or the phone path.
