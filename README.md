# ChatLingua

ChatLingua is a one-to-one WebRTC video calling app with translated captions.

## Make a call

Open the [hosted app](https://chatlingua.pcarenza.workers.dev/) or install the Android build. Create a room, share its invite link, and have the second person open the link. In the Android app, **Join with invite** also accepts a pasted link.

Choose **I speak** and **Show captions in** on each side. The app fills in **They speak** from the other caller’s settings if captions are off. Both callers should turn on **Captions**. Completed phrases appear over the video and in the caption history. Model downloads may take a moment on first use.

Translated captions on the web use desktop Chrome’s speech recognition and Translator API. The Android app requires Android 13 or later, a current Android System WebView, and a device speech recognition service that supports externally supplied audio. Android uses ML Kit for on-device translation. Speech recognition can use a network service depending on the browser or device configuration.

## Android build

With JDK 17, Gradle 8.9, Android SDK Platform 34, and the Android build tools installed, run `gradle -p android assembleDebug` from the project root. The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. The debug APK is for sideloading.

## Hosting and local development

The primary public version runs on Cloudflare. The legacy Sites version uses D1 for temporary signaling, with its schema under `drizzle` and deployment manifest in `.openai/hosting.json`.

For local web development with Node.js 24, run `npm start` and open [localhost](http://localhost:3000). The local server uses in-memory signaling. The Android app connects to the hosted origin.

WebRTC media and caption messages travel through the peer connection. The room service exchanges connection metadata and expires inactive rooms. The default configuration uses STUN. To relay calls when direct connections are blocked, configure `ICE_SERVERS` with a TURN service and short-lived credentials.

## Cloudflare deployment

The Cloudflare build uses a SQLite-backed Durable Object for temporary room state. The original Sites build uses D1. The two deployments have separate room IDs and invite URLs.

- The primary HTTPS origin is [ChatLingua on Cloudflare](https://chatlingua.pcarenza.workers.dev/).
- Run `npm run build:worker` to generate the Worker bundle inputs, `npm run dev:cloudflare` to start Wrangler locally, or `npm run deploy:cloudflare` to deploy to the Cloudflare account in `wrangler.toml`.
- Relay configuration is the `ICE_SERVERS` Worker secret. Update it with `npx --yes wrangler@4.167.0 secret put ICE_SERVERS` using your Metered ICE server array. Keep the credentials out of Git.
- Run `gradle -p android assembleDebug` to build **ChatLingua Cloudflare**. Look for the orange cloud icon. It has a separate application ID and can coexist with the original app. For a legacy build that targets the original site, pass `-PchatlinguaCloudflare=false`.
- To continue in Claude Code, open the repository folder and run `claude`. The project guidance is in `CLAUDE.md`.

### Android APK download

The [Cloudflare APK download](https://chatlingua-download.pcarenza.workers.dev/ChatLingua-Cloudflare.apk) is hosted by a separate Worker. To refresh it, build with `gradle -p android assembleDebug -PchatlinguaArm64=true`, copy the signed APK to `outputs/apk-public/ChatLingua-Cloudflare.apk`, copy `downloads/_headers` into that same directory, and run `npx --yes wrangler@4.167.0 deploy --config downloads/wrangler.toml`. The linked build supports ARM64 Android devices such as the Pixel 9a.
