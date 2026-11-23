# ChatLingua

See [README.md](README.md) for build commands and deployment details.

- The project is a two-person WebRTC call app with room chat and on-device speech captions and translation.
- The independent deployment uses the user's Cloudflare Worker at https://chatlingua.pcarenza.workers.dev. The original ChatGPT Sites deployment is still available during the transition.
- `app.js` and `android-bridge.js` are the shared frontend. `worker.js` implements the signaling protocol. `cloudflare-worker.js` adds the SQLite-backed RoomService.
- `npm run deploy:cloudflare` deploys with Wrangler using the user's Cloudflare authorization. Keep `ICE_SERVERS` in Worker secrets. Keep Workers and Metered on their free plans unless the user asks to change this.
- Build the parallel Android app with `gradle -p android assembleDebug -PchatlinguaCloudflare=true`. It has a separate app ID and can be installed beside the original.
- Use the Cloudflare URL and a new room when testing a migration change. Verify two-way audio, video, captions, and translated chat on desktop Chrome and Android before treating the migration as complete.
