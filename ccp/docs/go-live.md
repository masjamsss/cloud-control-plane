# Go live with Cloud Control Plane

This is the plain-language runbook for standing up the **real** Cloud Control Plane — the
actual governance tool your team signs into, not the demo. If you can copy a file,
edit a few lines, and run one command, you can do this.

What you are bringing up:

- **the api** — the backend that holds accounts, second-factor (2FA) secrets, and
  the tamper-evident audit log, saved to a disk that survives restarts;
- **the app** — the web page your team opens, built to talk to that backend.

One `docker compose up` starts both. A reverse proxy you put in front adds HTTPS.

---

## What is still yours to provide

Cloud Control Plane cannot invent these for you. Have them ready:

1. **A hostname and HTTPS** — a domain (e.g. `ccp.example.com`) and a **TLS
   certificate** for it, terminated by a **reverse proxy** you run in front
   (nginx, Caddy, Traefik, or a cloud load balancer). Cloud Control Plane deliberately does
   **not** do HTTPS itself; the proxy does, and forwards plain traffic to the
   containers. (This matches the estate's existing pattern — the wildcard cert on
   ACM. Whoever owns cert renewal still owns it.)
2. **A persistent disk mounted at `/data`** — the one place every piece of durable
   state lives: the governance store, the real `.env` (including the TOTP key
   below), and the self-update history. `scripts/setup.sh data` lays out that tree
   with the right owners/modes (see Step 1). Trialling on a laptop instead? Skip
   this — `scripts/run-local.sh` doesn't need it.
3. **A strong TOTP key** — one random secret Cloud Control Plane uses to protect enrolled 2FA.
   You generate it (a one-liner below) and paste it into `.env`. Keep it stable and
   private; changing it later logs everyone out of their 2FA.
4. **Your AWS / estate credentials stay yours** — Cloud Control Plane proposes changes and
   records approvals. The API token it eventually uses to open pull requests
   against the estate is provided and rotated by you, out of band. Nothing here
   asks for, or stores, your cloud passwords.

Everything else has a sensible default. For the complete list — every secret, its
format, and where it belongs (including the per-project CI upload token) — see
[**Credentials and secrets** in `api/README.md`](../api/README.md#credentials-and-secrets).

---

## Step 1 — Fill in the settings

> **Shortcut:** on a host with a persistent disk at `/data` (see
> [prerequisites](#what-is-still-yours-to-provide)), run `sudo scripts/setup.sh data` once
> to lay out its tree with the right owners/modes. Then `scripts/setup.sh env` does the
> copy below **and** fills in a freshly generated `CCP_TOTP_KEY` — written straight to
> `/data/ccp/config/ccp.env` and symlinked to `ccp/.env` when `/data` exists —
> leaving you only `VITE_API_BASE` + the topology to set. (`scripts/setup.sh` with no
> argument also checks your toolchains, installs deps, and runs the `data` step itself
> when `/data` exists — see [the README](../README.md#set-up-from-zero).) Prefer to do it
> by hand? Continue below.

From the `ccp/` folder:

```bash
cp .env.example .env
```

Open `.env` and set:

- **`VITE_API_BASE`** — the address the browser will use to reach the api, through
  your proxy. Two common shapes (pick one and note it for Step 2):
  - **Same host** (simplest): the app and api share one domain, and the proxy sends
    `/api/*` to the api. Use `https://ccp.example.com/api`, keep
    `CCP_SAME_ORIGIN=1`.
  - **Separate host**: the api has its own domain. Use `https://api.ccp.example.com`,
    and switch to the "Topology B" lines in `.env` (they set `CCP_CORS_ORIGIN`
    to the app's address and `CCP_COOKIE_SAMESITE=None`).
- **`CCP_TOTP_KEY`** — generate one and paste the output in:

  ```bash
  openssl rand -base64 48
  ```

Leave the rest at their defaults for now.

---

## Step 2 — Put a reverse proxy (HTTPS) in front

> **Shortcut (nginx):** `sudo scripts/nginx-vhost.sh --host ccp.example.com --cert … --key …`
> drops in the vhost below for you — **without disturbing any other site** on that nginx (it
> writes a new file, validates with `nginx -t`, rolls back on failure, and reloads gracefully).
> Add `--topology split --api-host api.ccp.example.com` for the split-host shape, or `--print`
> to preview. Prefer to write it by hand? The example below is exactly what it generates.

The containers listen on your machine at `127.0.0.1:8800` (the app) and
`127.0.0.1:8801` (the api). Your proxy terminates HTTPS for your domain and
forwards to those. A minimal nginx example for the **same-host** shape:

```nginx
server {
    listen 443 ssl;
    server_name ccp.example.com;

    ssl_certificate     /path/to/fullchain.pem;   # your cert
    ssl_certificate_key /path/to/privkey.pem;      # your key

    # the app (the web page)
    location / {
        proxy_pass http://127.0.0.1:8800;
    }

    # the api — note: strip the /api prefix before forwarding
    location /api/ {
        proxy_pass http://127.0.0.1:8801/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

The one rule that matters: the browser must always reach Cloud Control Plane over **https://**.
That is what lets the secure sign-in cookie work.

---

## Intranet access (IP + self-signed TLS)

No public domain and no certificate authority — Cloud Control Plane only needs to be
reachable **inside** your network, by an intranet hostname **and** by raw IP? Skip Steps 1–2
above and run the guided installer instead, then pick back up at Step 3:

```bash
sudo ccp/scripts/intranet-setup.sh
```

It is an interactive wizard on a terminal, and **every deploy parameter can be customized** —
starting with the hostname, front and center: it is the very first question, and it is
**fully free-form**. `ccp.local.com` is only a suggestion (press Enter to take it) — name
it anything your team will actually type: `ccp.corp.internal`, `portal.acme`, whatever fits.
IP and TLS follow, then a single gate —

```
Customize advanced settings — ports, topology, API base URL, cookie posture? [y/N]:
```

— covers everything else. Answer **No** (the default, so the common path stays exactly as
easy as before — one Enter per question) and every advanced value gets a safe smart default.
Answer **Yes** and each becomes its own prompt with that same default pre-filled, so Enter
still reproduces it and typing replaces it. A full preview of **every** chosen value is shown
before anything is touched. Give it any flag (`--host`, `--ip`, `--tls self-signed|ca|http`,
`--yes`, `--print` to preview only, `-h` for the full list) and it runs non-interactively
instead, filling in a sensible default for anything you didn't pass. What it does, in order:

1. **Detects the intranet IP** (`ip route get 1`, falling back to `hostname -I`) and lets
   you confirm or override it.
2. **Adds `/etc/hosts` on this host** — `<IP>  <hostname>` — idempotently (a stale mapping
   from an earlier run is corrected, not silently dropped).
3. **Generates a small local Certificate Authority** under `/data/ccp/config/tls/` — a
   10-year root (`ca.crt`/`ca.key`) you import into each client **once** — and a leaf
   certificate (`ccp.crt`/`ccp.key`, ≤397 days, renewable with `--renew` without ever
   re-importing the root) whose Subject Alternative Names cover the hostname and the IP (plus
   `localhost`/`127.0.0.1`, and the api's own hostname too under split-origin — see below), so
   nothing name-mismatches. (Already have a certificate, e.g. from a corporate CA? `--tls ca
   --ca-cert … --ca-key …` uses it as-is. `--tls http` skips TLS entirely — not
   recommended, kept only as a last resort.)
4. **Sets `VITE_API_BASE`** — `/api` (relative, same-origin) by default instead of a fixed
   hostname — and rebuilds the app (`docker compose up -d --build app`), then refreshes the
   api container so it picks up the new ports/topology/cookie settings too. The relative
   default is what lets a *single* build correctly serve both the hostname and the raw IP:
   the browser's own fetches stay same-origin (`/api/...`) no matter which name it used to
   reach the page, so there is nothing left baked in to mismatch — the mechanism behind the
   classic "Failed to fetch" when a static `https://some-other-host/api` was baked in
   instead. Override it under "advanced settings" if you need to — if the override would
   break same-origin (anything other than a relative `/api` path), the wizard prints a clear
   **WARNING** explaining exactly why, but still lets you proceed; it never silently allows
   the foot-gun.
5. **Installs the nginx vhost** with `server_name <hostname> <IP>;` (plus a second server
   block for the api's own hostname under split-origin), via `nginx-vhost.sh`'s `--alias
   "<names/ips>"`, `--app-port`, `--api-port`, `--topology`, and `--api-host` flags —
   everything else about that script (additive-only, `nginx -t` validate-then-rollback,
   graceful reload) is unchanged.
6. **Prints the access URLs** and the exact CA-import steps below.

Re-running it is safe — it pre-fills from the existing certificate/`.env` and only changes
what you change (a new `--host`, `--ip`, `--renew`, or any advanced value).

### Every customizable parameter, and its flag

Each of these is a prompt with a smart default under "advanced settings" (or a flag, for the
non-interactive path) — pressing Enter / omitting the flag reproduces exactly what the wizard
did before this existed:

| Parameter | Prompt / flag | Default |
|---|---|---|
| Hostname (always prompted, first) | `--host FQDN` | `ccp.local.com`, or the existing leaf's CN on a re-run |
| Intranet IP (always prompted) | `--ip ADDR` | auto-detected |
| TLS mode (always prompted) | `--tls self-signed\|ca\|http` | `self-signed` |
| App port | `--app-port N` | `8800`, or the existing `.env`'s `APP_PORT` on a re-run |
| API port | `--api-port N` | `8801`, or the existing `.env`'s `PORT` on a re-run |
| Topology | `--topology same\|split` | `same` |
| API hostname (split-origin only) | `--api-host FQDN` | `api.<hostname>`, or derived from the existing `.env` on a re-run |
| API base URL (`VITE_API_BASE`) | `--api-base URL` | `/api` (same-origin), `https://<api-host>` (split) |
| Cookie `SameSite` | `--cookie-samesite Lax\|Strict\|None` | `Lax` (same-origin), `None` (split-origin) |
| Secure cookies | `--secure-cookies 0\|1` | `1`, empty for `--tls http` |

Split-origin also folds the api's hostname into the SAME certificate's SAN and adds a second
`server_name` block in the nginx vhost, so `https://<api-host>` works over HTTPS too — it
needs its own `/etc/hosts`/DNS entry on every client, same as the app's hostname does.

### Trusting the self-signed root (once per client)

The browser warning goes away once a client trusts the **root**, not the leaf — so renewing
the leaf later (`intranet-setup.sh --renew`) never needs re-importing anything:

- **Linux** (also covers curl/CLI tools): `sudo cp ca.crt
  /usr/local/share/ca-certificates/ccp-intranet.crt && sudo update-ca-certificates`
- **macOS**: Keychain Access → File → Import Items → `ca.crt` → double-click it → *Trust* →
  *Always Trust* for SSL.
- **Windows**: double-click `ca.crt` → *Install Certificate* → *Local Machine* → *Place all
  certificates in the following store* → *Trusted Root Certification Authorities*.
- **Firefox** (keeps its own store, separate from the OS): Settings → Privacy & Security →
  Certificates → *View Certificates* → Authorities → *Import* → check "Trust this CA to
  identify websites".
- **Mobile**: transfer `ca.crt` to the device (email/AirDrop/file share) and install it as a
  trusted certificate profile, to reach the intranet host from a phone on the same network.

### Reaching it from other machines

This host's own `/etc/hosts` line only resolves the hostname *on this host*. Other clients
need the same mapping to use the hostname — add the identical `<IP>  <hostname>` line to
each client's own hosts file, or point an intranet DNS server at it — but the **raw IP
always works with no extra client setup**, since both the certificate's SAN and the nginx
`server_name` already cover it.

---

## Step 3 — First boot (creates your admin)

The very first time only, tell Cloud Control Plane to create the first administrator. In `.env`
set:

```
CCP_BOOTSTRAP=1
```

Then start everything:

```bash
docker compose up -d --build
```

Read the one-time password out of the api's log:

```bash
docker compose logs api | grep -A3 "bootstrap"
```

You will see something like:

```
ccp-api bootstrap: Lead created.
  username: putra
  one-time password: <a random string shown ONCE>
```

Copy that password now — it is shown **once** and never again.

> If you see `bootstrap refused — data file already exists`, the store was already
> set up. That is the safety catch working: it will not create a second admin over
> a live system. Skip to Step 5 (turn bootstrap off).

---

## Step 4 — Sign in, set a real password, turn on 2FA

1. Open `https://ccp.example.com` in a browser.
2. Sign in with username `putra` and the one-time password from Step 3.
3. It will require you to **change the password** immediately. Choose a strong one.
4. **Enrol 2FA**: open a phone authenticator app (Google Authenticator, 1Password,
   Authy, …), scan the QR code Cloud Control Plane shows, and enter the 6-digit code to confirm.

You are now the real, protected administrator. Create the rest of the team from the
Users area.

---

## Step 5 — Turn first-boot back off

Edit `.env` and set it back to empty:

```
CCP_BOOTSTRAP=
```

Apply it:

```bash
docker compose up -d
```

This matters: leaving it on means the container will refuse to restart cleanly once
the store exists. Off is the normal, everyday setting.

---

## Confirm it is really live

The api answers two unauthenticated health URLs (through your proxy, or directly on
the host):

- `GET /healthz` → `{"ok":true}` — the process is up.
- `GET /readyz` → `200` with `"ready":true` — the store loaded, has your admin
  account, and the audit log verifies. **This is the one that proves it is real and
  not empty.** A blank or damaged store returns `503` here on purpose.

From the host:

```bash
curl -s http://127.0.0.1:8801/readyz
# {"ready":true,"storeLoaded":true,"accounts":1,"chains":[...],"reasons":[]}
```

Docker also uses `/readyz` as the api container's health check, so
`docker compose ps` will show `api` as **healthy** only once it is genuinely ready.

---

## Your first day (after sign-in)

Four things to do in the first hour — a fresh install has exactly **one** admin, and
several protections deliberately refuse to work until you fix that:

1. **Create your teammates** in the Users area (requesters, approvers, leads).
2. **Stand up a second admin.** Many privilege-loosening changes require a *second*
   admin's acknowledgement (dual-control), and an admin cannot acknowledge their own
   change — with only one admin those actions simply refuse. Follow your deployment's
   second-approver runbook (the offline path is
   [`api/scripts/grant-admin.ts`](../api/scripts/grant-admin.ts)).
3. **Take your first verified backup** — the two commands under
   [Everyday operations](#everyday-operations) below. The backup verifies the audit
   chain as it copies; do it once now so a disk loss on day 2 is a non-event.
4. **Know your two switches:** `GET /readyz` (is it really serving my data?) and the
   global **change freeze** (`freeze.global` in Admin → Settings — stops new requests
   instantly; freezing is immediate, *un*freezing needs that second admin).

---

## Everyday operations

- **Back up `/data/ccp` — the one backup parent.** Everything durable lives under
  it: the governance store (accounts, 2FA, the audit log, and activated
  `projects/<id>/v<N>/…` data), the real `.env` (including the TOTP key), and the
  self-update history. Restoring this one directory is a complete disaster
  recovery. Everything else under `/data` (`scratch/`, `runner/`) is transient or
  re-creatable and doesn't need backing up:

  ```bash
  # 1. the chain-verified store snapshot (validates the audit log as it copies).
  #    Written straight into /data/ccp/store — a bind mount, not a volume — so
  #    step 2 below captures it automatically; no `docker compose cp` needed.
  docker compose exec api npm run backup
  # 2. the whole backup parent — the snapshot above, live store data (incl.
  #    projects/), config (.env / the TOTP key), and update history, in one archive
  sudo tar czf ccp-backup-$(date +%F).tar.gz -C /data ccp
  ```

- **Restart / update**: `docker compose up -d --build` again. The store survives;
  accounts, 2FA, the audit log, and activated project data are all preserved — `up`
  never touches the `/data` bind. (**Never** run `docker compose down -v` on a live
  install. The default compose here binds `/data/ccp/store` from the host, so
  there's no named volume to lose day-to-day — but a host mid-migration, or one
  still running the rollback override, does have a real volume behind it. Treat
  `-v` as permanently forbidden regardless.)
- **Restore** after a disk loss: stop the api, restore into `/data/ccp/store`
  with `npm run restore -- --from <backup>` (store file) and/or un-tar the full
  `/data/ccp` backup, then start it. See
  [api/README.md → "Backup & restore"](../api/README.md#backup--restore-diskhost-recovery)
  for the full procedure.

### Staying up to date (optional, guarded)

Manual update stays the base case: `git pull` + `docker compose up -d --build`.
To do it on a schedule, use the guarded updater instead of a bare cron line:

```bash
scripts/self-update.sh --check           # what would change? (touches nothing)
CCP_UPDATE_REF=main scripts/self-update.sh    # one guarded cycle
scripts/self-update.sh --print-systemd   # the systemd service+timer to install
```

What it guarantees, in one breath: **verified backup first** (a chain-verified store
snapshot plus a full tar of the store directory — `/data/ccp/store` — which
includes the activated project data), fast-forward-only pull of the ref **you**
name (`CCP_UPDATE_REF` — deliberately no default), rebuild via `up -d --build`
only (the `/data/ccp/store` bind is never touched; `down -v` is a forbidden
verb), then a **health gate** on `/readyz` **plus a data-integrity probe** —
every project-data file must still be present and byte-identical, because
`/readyz` alone does not check project data. Any failure rolls back to the
previous commit and alerts; a failed rollback writes a hold file so the timer
stops retrying. It never runs `terraform`, never touches AWS, and never re-runs
first-boot. During an incident or change freeze, pause it: touch the hold file
or `systemctl disable --now ccp-update.timer`.

Its state (history log, hold file, pre-update backups) lives under
`/data/ccp/update` by default once that tree exists — see
[Migrating an existing install to /data](#migrating-an-existing-install-to-data)
below. The legacy default `/var/lib/ccp-update` still works on hosts that
haven't migrated (and migration leaves `/var/lib/ccp-update` symlinked to the
new location, so paths you already had memorized keep working).
`CCP_UPDATE_STATE` always overrides both.

**Running self-update on a host that hasn't migrated to `/data` yet:** self-update
refuses rather than risk it. Once a host is on this code, its own pre-flight guard
checks that the compose config binds `/data/ccp/store` and that
`/data/ccp/store/ccp.json` exists before it touches anything else, and
refuses up front — naming the migration — if not. The one cycle that first
*pulls* this code can't run that new guard yet (it's mid-pull); that cycle instead
rebuilds onto the new compose, finds the `/data/ccp/store` bind empty,
`/readyz` stays red, and the ordinary health gate rolls the whole update back
automatically. Either path: nothing is lost — the old volume is never touched —
and the update is refused, with a line written to the history file recording why.
Run [the migration](#migrating-an-existing-install-to-data) first to skip the
extra round-trip.

---

## Maintenance

**Where are the logs:**

| Piece | Where |
|---|---|
| api / app / runner | `docker compose logs <service>` (`-f` to follow, `--tail 200` to limit) |
| self-update | `journalctl -t ccp-update` (falls back quietly if there's no journald/`logger`) + the state dir's `history` file — `/data/ccp/update/history` once migrated, else `/var/lib/ccp-update/history` |
| nginx | host logs — nginx runs on the host, outside compose (your distro's usual path, e.g. `/var/log/nginx/`) |

**Restart one piece:**

```bash
docker compose up -d api         # recreate just the api (add --build after a code change)
docker compose restart runner    # restart the runner without rebuilding
```

Never `docker compose down -v` — see [Everyday operations](#everyday-operations) above.

**Roll back:**

- **Code:** `git reset --hard <previous-sha> && docker compose up -d --build`.
- **Data:** stop the api, restore the pre-update tar or the chain-verified backup
  into `/data/ccp/store`, then start the api again — see
  [api/README.md → "Backup & restore"](../api/README.md#backup--restore-diskhost-recovery).
- **A migration you want to undo:** re-point the api at the old volume with the
  rollback override `migrate-data.sh` wrote — see
  [Migrating an existing install to /data](#migrating-an-existing-install-to-data):
  ```bash
  docker compose -f docker-compose.yml -f /data/ccp/update/rollback-volume.yml up -d api
  ```

**Watch disk space** — `/data` holds everything durable; a full disk fails writes
silently until it doesn't:

```bash
df -h /data
```

---

## CI runner

A self-hosted GitHub Actions runner for this repo, opt-in via the `runner` compose
profile. Every workflow already reads
`runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`, so bringing one online is the
**entire** cutover — zero workflow-file edits — and rollback is deleting one repo
variable.

### Register

```bash
# 1. mint a short-lived (1h) registration token — either from the repo UI
#    (Settings → Actions → Runners → New self-hosted runner), or:
gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token

# 2. register + start (the token is used ONCE and is NEVER stored in .env):
cd ccp && RUNNER_TOKEN=<token> docker compose --profile runner up -d --build runner

# 3. verify: container healthy + the runner shows "Idle" on the repo's Runners page
docker compose --profile runner ps runner

# 4. route CI to it (instant, reversible):
gh variable set CI_RUNNER --body ccp        # rollback: gh variable delete CI_RUNNER
```

`RUNNER_TOKEN` is passed once on the shell and never written to `.env` (see
`.env.example`). Registration state lands at `/data/runner`, alongside the
extracted runner distribution — it survives container recreation and image
upgrades.

Want the runner to come up automatically on every `docker compose up -d --build`
(including `self-update.sh` cycles), instead of passing `--profile runner` by hand
each time? Set `COMPOSE_PROFILES=runner` in `.env`.

### Upgrade

Bump the pinned `RUNNER_VERSION` (and its sha256s) in `runner/Dockerfile`, then:

```bash
docker compose --profile runner up -d --build runner
```

The entrypoint detects the version bump and re-extracts the new distribution into
`/data/runner` on start; the existing registration (`.runner`/`.credentials`) is
untouched, so it comes back already registered — no re-registration needed for a
version bump.

### Unregister

```bash
docker compose --profile runner run --rm --entrypoint ./config.sh runner remove \
  --token <removal-token>          # minted the same way as the registration token
docker compose --profile runner stop runner
```

### Security notes

- **Private repo only.** Never attach a self-hosted runner to a public repository —
  a fork PR would get arbitrary code execution on this host.
- The runner user is unprivileged and the container has **no docker socket** (no
  workflow under `.github/workflows/` uses Docker).
- CI jobs on this runner see this repo's secrets, so the host running it is
  trusted infra — the same host that already holds the portal's governance data.

---

## Toolbox + armed lanes

The **toolbox** image (`ccp-toolbox:local`, built from `toolbox/Dockerfile`)
bundles a pinned Terraform (`1.15.7`, matching CI) and the built `catalogctl` —
everything an armed operator command needs, without installing anything on the
host. It's a run-on-demand image, not a daemon (compose profile `toolbox`,
`restart: "no"`):

```bash
docker compose --profile toolbox build toolbox   # build/refresh the image
docker run --rm ccp-toolbox:local             # toolbox-selfcheck: prints the
                                                  # terraform/catalogctl/git versions
```

`toolbox-selfcheck` (the image's default command) is also what `doctor.sh` runs to
confirm the image is healthy — there's no long-running healthcheck for a one-shot
tool image.

### Arming CCP_BUNDLE_GATE_CMD / CCP_DRIFT_GEN_CMD

These two operator-configured commands
([`api/README.md`](../api/README.md#environment-variables) is the canonical doc
for what they are and what arms them) run **inside the api container**. Arming
them means giving that container what it needs to shell out to
Terraform/`catalogctl`: the opt-in overlay `docker-compose.armed.yml`. First set
`CCP_DOCKER_GID` in `.env` (`stat -c %g /var/run/docker.sock` — the overlay
refuses to start without it; see `.env.example`), then:

```bash
docker compose -f docker-compose.yml -f docker-compose.armed.yml up -d
```

> **SECURITY.** This overlay mounts the docker socket into the api container,
> which makes that container **root-equivalent on the host** — it can run
> `docker run` with any mount, including the host root. Arm this only on a host
> dedicated to the portal, never one that also runs anything else sensitive. The
> api itself stays loopback-only either way. A socket proxy that allows only
> `container run` is a hardening option.

The overlay also sets `TMPDIR=/data/scratch` in the api container and
bind-mounts `/data/scratch:/data/scratch` at the **same path** on the host and in
the container. The armed lanes create their checkouts under `TMPDIR`
(`$BUNDLE_CHECKOUT`/`$DRIFT_CHECKOUT`, and the files `$DRIFT_ENVELOPE`/`$DRIFT_OUT`
alongside it), so that path is valid on **both** sides — which is what lets an
operator command launch the toolbox as a sibling container against the very same
checkout the api just created:

```bash
# Example CCP_DRIFT_GEN_CMD (yours will differ — see api/README.md):
CCP_DRIFT_GEN_CMD='docker run --rm -u 1000:1000 -v /data/scratch:/data/scratch \
  -e DRIFT_CHECKOUT -e DRIFT_ENVELOPE -e DRIFT_OUT -w "$DRIFT_CHECKOUT" \
  ccp-toolbox:local bash -lc "catalogctl drift-propose … --out \"$DRIFT_OUT\""'
```

Mount **only** `/data/scratch` into the toolbox — never the store, never the
socket. Run it `-u 1000:1000` (the api's uid) so files it writes stay readable by
the api process.

---

## Migrating an existing install to /data

If you deployed before this consolidation, the durable store is a **named Docker
volume** (`ccp_ccp-data`) instead of the `/data/ccp/store` bind the rest
of this doc assumes. `scripts/migrate-data.sh` moves you over — once,
idempotently, with the same backup-first / verify / refuse-on-mismatch discipline
as `self-update.sh`. `--check` reports what it *would* do without changing
anything.

```bash
touch /var/lib/ccp-update/hold      # pause auto-updates during the migration
cd <repo> && git pull --ff-only        # brings the new compose + this script
sudo ccp/scripts/migrate-data.sh    # the guarded migration
rm /var/lib/ccp-update/hold         # resume auto-updates
```

What it does, briefly: writes a rollback override
(`/data/ccp/update/rollback-volume.yml`) that can re-point the api at the old
volume at any time before you remove it; refuses if `/data` doesn't have enough
free space for a copy of the volume; takes the same verified backups
`self-update.sh` takes (`npm run backup` plus a full `tar` of the volume) while
the api is still up and green; stops the api and copies the volume to
`/data/ccp/store` with the **source mounted read-only** (it cannot be
corrupted); hashes every file on both sides and refuses to proceed on any
mismatch, restarting the api on the old volume instead; and only then brings the
new compose up and re-verifies inside the running container. Already migrated? It
detects that and exits immediately — safe to run again.

Once you've confirmed the portal looks right **and** done a restore drill — not
the same day — remove the old volume by hand. This is the **only** destructive
step, and it is never scripted:

```bash
# …days later, after confirming the portal + a backup restore drill:
docker volume rm ccp_ccp-data
```

If a migration attempt fails partway, `migrate-data.sh` has already restarted the
api on the old volume for you — nothing to do but read the error and re-run once
it's fixed. The rollback override stays available as a manual escape hatch too,
until you delete the old volume:

```bash
docker compose -f docker-compose.yml -f /data/ccp/update/rollback-volume.yml up -d api
```

---

## No Docker? Trial it on a laptop

To see the real tool without Docker or a proxy (local http only — a trial, not a
production server):

```bash
scripts/run-local.sh
```

It starts the api on a throwaway store, builds the app pointed at it, prints the
one-time admin password and the URLs, and stays up until you press Ctrl-C. The
throwaway store is deleted on exit. (`scripts/run-local.sh --smoke` does the same
non-interactively and just checks it all comes up, then exits.)
