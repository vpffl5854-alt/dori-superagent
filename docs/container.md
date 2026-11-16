# Running dori-superagent in a container

A container recipe for one long-lived container running the dori harness. There is no
published image: you build it locally from `examples/container/` and keep your own
credentials out of it — logins happen once, inside the running container, and persist in
volumes.

The image builds for `linux/amd64` and `linux/arm64`; the builder picks your host
architecture automatically. Every downloaded binary (gh, node, bun, herdr or hc) is verified
against a pinned sha256; npm packages and the harness are pinned by version and commit.

## Files

- `examples/container/Dockerfile` — Ubuntu 24.04 with gh, node, bun and herdr
  sha256-verified, plus agent-messenger, omo and the dori harness pinned by version
  and commit.
- `examples/container/compose.yaml` — one `dori` service with named volumes for all
  state, sized like a small dev machine.
- `examples/container/entrypoint.sh` — starts the runtime's server (`hc server start`
  when the image carries hc, `herdr server` otherwise), then runs the command.

Ubuntu, not Alpine: bun and herdr need glibc.

## Build

```sh
cd examples/container
docker compose build
```

To move to a newer harness commit or tool version, pass the matching build arg (for
example `--build-arg DORI_REF=<sha>`) and rebuild; the volumes keep lanes, inbox and
auth untouched. `DORI_REF` pins the harness commit the image ships — grab the sha you
want from the repo's commit history and pass it at build time when you want to move
forward; when a tool moves, update its version and both sha256 build args (the values
come from the tool's published checksums).

### hc instead of herdr

The image carries herdr by default. Build with `HC=1` to carry hc (herdr-core) in its
place:

```sh
docker compose build --build-arg HC=1
```

The Dockerfile then downloads the `HC_VERSION` release tarball for your architecture,
checks it against `HC_SHA256_AMD64` or `HC_SHA256_ARM64` (the values in the release's
`manifest.json` at `https://releases.herdr.dev/core/<version>/`), installs it as
`/usr/local/bin/herdr-core` with `hc` beside it, and writes `notes = false` to
`~/.config/herdr-core/config.toml` so hc types nothing into a parent agent on its own.
herdr is left out, so the harness finds hc as the one runtime on PATH and no `runtime`
setting is needed. The entrypoint runs `hc server start` in place of `herdr server`.
hc reads an agent's status only from the agent's own OSC 7501 report, so use an omo
build that sends it; see [`runtime.md`](runtime.md).

The default `DORI_REF` predates hc support: `dori status` in that image prints no
`RUNTIME` line and the harness still drives herdr. Pass a `DORI_REF` that contains
`src/runtime/` together with `HC=1`.

## First run

```sh
docker compose up -d
docker exec -it dori bash
```

Inside the container, do the interactive logins once — they persist in the volumes:

```sh
gh auth login                      # gh-auth volume
agent-messenger auth telegram      # messenger-auth volume (per your platform)
# omo providers: /login inside omo, or your provider's API key path — omo-state volume
```

Clone the repos the Dori should work on into `~/projects` (the `projects` volume), then
bring the harness up from the project directory, exactly like on a VM:

```sh
cd ~/projects/<your-repo>
dori up
```

herdr panes are hosted by the herdr server inside the container, so you can attach from
any number of exec sessions and they survive detach:

```sh
docker exec -it dori herdr
```

In an `HC=1` image the sessions are hc terminals, hosted by the hc core the same way:

```sh
docker exec -it dori hc ls      # the sessions, with their dori.* labels
docker exec -it dori hc         # pick one and attach (ctrl+\ detaches)
```

## What survives a restart

All volume state, because nothing lives in the container filesystem. Running panes
do not survive a restart; run `dori up` again:

- `~/.dori` — harness state, lanes, inbox (`dori-state`)
- `~/.omo` — omo config, auth, memory (`omo-state`)
- `~/.config/gh` — GitHub auth (`gh-auth`)
- `~/.config/agent-messenger` — messenger auth (`messenger-auth`)
- `~/projects` — repo checkouts (`projects`)

`docker compose restart` (or `down` + `up -d`) keeps all of it; only the image and the
pinned tools are rebuilt when you ask for it.

## Sizing

The container runs the omo sessions plus their builds and tests, so size it like a dev
machine, not like a microservice. The compose file starts at 4 CPUs and 8 GB; scale to
your lanes. Disk grows with the `projects` volume (checkouts, build artifacts) — give
the docker data root tens of gigabytes.

## When a VM is the simpler choice

A container adds a layer over the host with no benefit for a single Dori: a plain VM
(or bare metal box) with bun, herdr or hc, omo, gh and agent-messenger installed gives the
same layout, the same `dori up`, and one less abstraction when something breaks. Reach
for the container when you want the recipe reproducible from a Dockerfile, want to run
several Doris isolated on one host, or cannot hand out VMs.

## Acceptance (what this recipe is tested against)

- `docker compose build` succeeds, with and without `--build-arg HC=1`.
- `dori up` inside the container opens the lead/duty/loop panes, visible through
  `docker exec -it dori herdr` (or the four terminals in `docker exec -it dori hc ls`
  on an `HC=1` image).
- A container restart keeps lanes, inbox and auth (all state is in volumes).
- No credentials in the image or in any example file.
