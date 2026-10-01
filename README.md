# server-remote-control

An MCP server you install on a hard-to-reach box so Claude Code can administer it over
plain HTTPS — shell, files, Docker and systemd — without going through PAM, MFA or
jump hosts every time.

It runs as one container behind the reverse proxy you already have.

---

## Read this before installing

This gives anyone holding the bearer token **root on the host**, over HTTPS, with no MFA.
That is the entire point, and it is also the entire risk. Concretely:

- The container runs `--privileged` with `--pid=host` and mounts `/` and the Docker socket.
  It uses `nsenter` to execute commands in the host's namespaces. That is root, by design.
- **The token is a root password.** Treat it exactly that way: 64 random hex characters,
  never in a repo, never in a chat message, rotated if exposed.
- It is a **parallel access path that bypasses your PAM/MFA controls.** If that server
  belongs to an employer or a client, the MFA is someone's deliberate decision and this
  routes around it. Get agreement before you install it.
- **Always put it behind TLS.** Over plain HTTP the token crosses the network in cleartext
  and anyone who sees it owns the box.

The containment controls below (`RC_READONLY`, `RC_ALLOWED_PATHS`, `RC_TOOLSETS`) are real
and tested, and worth using. The catastrophic-command guard is **not** a security boundary —
it is a seatbelt against a mistake. Anyone with the token can trivially write around it.

---

## Install

On the server:

```bash
git clone <this-repo> server-remote-control
cd server-remote-control
sudo ./scripts/install.sh
```

The installer generates a token, writes `.env` with `600` permissions, builds the image,
starts the container on `127.0.0.1:8723`, waits for health, and prints the exact
`claude mcp add` command to run on your laptop.

Nothing is published to the network: the port binds to loopback, and your reverse proxy
is what exposes it.

---

## Reverse proxy

The transport is Streamable HTTP, which uses SSE for server-to-client messages. **Response
buffering must be off** or responses will arrive in stalled chunks and long commands will
appear to hang.

### nginx

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8723/mcp;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Required for SSE. Without these the stream is buffered and appears to hang.
    proxy_buffering     off;
    proxy_cache         off;
    chunked_transfer_encoding on;

    # Long enough for slow commands (docker pull, apt upgrade).
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
}
```

### Caddy

```caddy
your-domain.com {
    handle /mcp* {
        reverse_proxy 127.0.0.1:8723 {
            # -1 disables response buffering, which SSE needs.
            flush_interval -1
        }
    }
}
```

### Traefik (labels on the compose service)

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.rc.rule=Host(`your-domain.com`) && PathPrefix(`/mcp`)"
  - "traefik.http.routers.rc.entrypoints=websecure"
  - "traefik.http.routers.rc.tls.certresolver=le"
  - "traefik.http.services.rc.loadbalancer.server.port=8723"
```

Traefik does not buffer responses by default, so no extra option is needed.

Once the proxy is up, set `RC_ALLOWED_HOSTS` in `.env` to your hostname and restart. That
turns on DNS-rebinding protection.

---

## Connect Claude Code

```bash
claude mcp add --transport http my-server https://your-domain.com/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

Scope it with `--scope user` to use it from any project, or `--scope local` (the default)
for just the current one. Check it with `claude mcp list`, or `/mcp` inside Claude Code.

A note on the token: Claude Code deliberately refuses to expand credential-looking
environment variables such as `${API_TOKEN}` inside remote-server headers. Put the literal
token in the config — it lives in `~/.claude.json`, which is already sensitive and should
be `600`.

Then just talk to it:

> why is nginx throwing 502s?

> disk is filling up on the app server, find what's eating it

> pull the latest image for the api service and restart it

---

## Tools

25 tools in four groups, settable with `RC_TOOLSETS`.

**shell** — `run_command`

**files** — `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `file_info`,
`download_file`, `upload_file`, `delete_path`

**docker** — `docker_ps`, `docker_logs`, `docker_inspect`, `docker_action`, `docker_exec`,
`docker_compose`, `docker_stats`, `docker_images`

**system** — `system_overview`, `service_status`, `service_control`, `journal_logs`,
`list_processes`, `list_ports`, `tail_file`

All file paths are **host** paths (`/etc/nginx/nginx.conf`), never container paths.

Two behaviours worth knowing:

- `edit_file` does exact string replacement and refuses an ambiguous match, so it will not
  silently mangle a config. Prefer it over `write_file` on files that already exist.
- `docker_compose` runs in the container but passes `--project-directory` as the *host*
  path, so relative bind mounts in your compose files resolve correctly on the daemon.

---

## Configuration

Everything is set in `.env`; see `.env.example` for the annotated list. The ones that matter:

| Variable | Default | What it does |
|---|---|---|
| `RC_TOKEN` | *required* | Bearer token, min 32 chars. Root-equivalent. |
| `RC_READONLY` | `false` | Refuse every tool that modifies the host. |
| `RC_TOOLSETS` | all four | Which tool groups to expose. |
| `RC_ALLOWED_PATHS` | `/` | Colon-separated roots the file tools may touch. |
| `RC_DENIED_PATHS` | — | Roots to exclude from the above. |
| `RC_ALLOW_DELETE` | `false` | Enable `delete_path`. |
| `RC_ALLOW_SERVICE_CONTROL` | `true` | Enable `service_control`. |
| `RC_EXEC_MODE` | `nsenter` | `nsenter` runs on the host; `container` stays inside. |
| `RC_MAX_OUTPUT_BYTES` | `100000` | Output above this is truncated head+tail. |
| `RC_DEFAULT_TIMEOUT_SEC` | `60` | Default command timeout; max `RC_MAX_TIMEOUT_SEC`. |
| `RC_ALLOWED_HOSTS` | — | Permitted `Host` headers (DNS-rebinding protection). |
| `RC_AUDIT_FILE` | — | Also append the audit log to this path. |

Changes need `docker compose restart`.

### Suggested starting point

Run it read-only for a day and see what you actually reach for:

```ini
RC_READONLY=true
RC_TOOLSETS=files,docker,system
```

Then open it up. If the server has one job, scoping the file tools is the highest-value
restriction you can keep permanently:

```ini
RC_ALLOWED_PATHS=/srv:/etc/nginx:/var/log
RC_DENIED_PATHS=/root/.ssh
```

---

## Auditing

Every tool call is logged as one JSON line to the container log, with the tool name,
arguments, success and duration:

```bash
docker compose logs -f
```

Failed authentication attempts are logged too, with the client IP — worth watching for a
few days after you expose it. Set `RC_AUDIT_FILE` to also append to a file.

The audit log contains command text and file contents, so it is as sensitive as the data
on the box.

---

## Verifying it works

Two test suites run against a live server. Neither is destructive beyond `/tmp`.

```bash
# 43 checks: auth, every toolset, timeouts, the command guard,
# and docker compose bind-mount path resolution.
node scripts/smoke-test.mjs http://127.0.0.1:8723/mcp "$TOKEN"

# 15 checks: read-only mode, toolset gating, and the path sandbox
# including symlink escapes. Needs a server started with those restrictions.
node scripts/test-restrictions.mjs http://127.0.0.1:8724/mcp "$TOKEN"
```

---

## Troubleshooting

**`claude mcp list` says "failed to connect"** — check the server is healthy
(`curl https://your-domain.com/healthz` should return JSON) and that the proxy routes
`/mcp`. A 401 means the token does not match `.env`.

**Commands hang, or output arrives in bursts** — the proxy is buffering. See the SSE
settings above; `proxy_buffering off` in nginx is the usual fix.

**`nsenter: cannot open /proc/1/ns/...`** — the container is not running with `--pid=host`
and `--privileged`. Use the provided `compose.yaml`, or set `RC_EXEC_MODE=container` to
run without host access.

**`docker: command not found` inside a tool** — the Docker socket is not mounted. Check
the `/var/run/docker.sock` volume.

**A command is refused by the guard** — it matched a catastrophic-command pattern
(`rm -rf /`, `mkfs`, `dd` to a raw disk, `shutdown`). Run it yourself on the host, or
adjust `RC_BLOCKED_COMMAND_PATTERNS`.

**Everything is refused as read-only** — `RC_READONLY=true` is set in `.env`.
