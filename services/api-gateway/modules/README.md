# Module manifest registry

This directory is where the API Gateway looks for `*.json` module
manifests at startup (`NORYX_MODULES_MANIFEST_DIR`, see
`ModuleRegistryService`). It's intentionally empty in source control —
populated at build/deploy time, not committed to.

**Local dev:** `docker-compose.yml` bind-mounts each service's own
`noryx.module.json` into this directory, so `docker compose up` gives you
a fully-wired gateway automatically. See the root `docker-compose.yml`.

**CI/CD:** the deploy pipeline copies every deployed service's
`noryx.module.json` into this directory (or an equivalent ConfigMap in
Kubernetes) as a build step, immediately before building/pushing the
gateway's own image — see `.github/workflows/ci.yml`'s `gateway-manifests`
job and `docs/plug-and-play-modules.md` for the full registration
walkthrough new modules should follow.

Do not hand-edit manifests here — edit the owning service's
`noryx.module.json` at its source and let the sync step copy it.
