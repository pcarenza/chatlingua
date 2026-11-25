# ChatLingua

See [README.md](README.md) for build commands and deployment details.

- The project is a two-person WebRTC call app with room chat and on-device speech captions and translation.
- The primary deployment uses the user's Cloudflare Worker at https://chatlingua.pcarenza.workers.dev. Apply future deployments to Cloudflare. The original ChatGPT Sites deployment remains available during live testing.
- `app.js` and `android-bridge.js` are the shared frontend. `worker.js` implements the signaling protocol. `cloudflare-worker.js` adds the SQLite-backed RoomService.
- `npm run deploy:cloudflare` deploys with Wrangler using the user's Cloudflare authorization. Keep `ICE_SERVERS` in Worker secrets. Keep Workers and Metered on their free plans unless the user asks to change this.
- Build the Cloudflare Android app with `gradle -p android assembleDebug`. It is labeled ChatLingua Cloudflare and has an orange cloud icon. To explicitly build the legacy Android app, pass `-PchatlinguaCloudflare=false`.
- Use the Cloudflare URL and a new room when testing a migration change. Verify two-way audio, video, captions, and translated chat on desktop Chrome and Android before treating the migration as complete.
