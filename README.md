# chickenFlow

Automated chicken-coop door control and camera-based flock monitoring, running on my k3s homelab cluster.

- **Door automation** — ESP32 firmware (`esp32-firmware/`) drives the physical door; a TypeScript door-state service tracks and controls open/closed state.
- **Flock counting** — camera frames processed by vision inference; inputs and outputs validated with zod.
- **Ops** — containerised and deployed to k3s. See [`DEPLOYMENT.md`](DEPLOYMENT.md) and `docs/`.

Layout: `chickenFlow/` (service) · `esp32-firmware/` (device) · `scripts/` · `Makefile`.
