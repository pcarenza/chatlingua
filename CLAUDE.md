# ChatLingua

See [README.md](README.md) for build commands and deployment details.

- The project is a two-person WebRTC call app with room chat and on-device speech captions and translation.
- The primary deployment uses the user's Cloudflare Worker at https://chatlingua.pcarenza.workers.dev. Apply future deployments to Cloudflare. The original ChatGPT Sites deployment remains available during live testing.
- `app.js` and `android-bridge.js` are the shared frontend. `worker.js` implements the signaling protocol. `cloudflare-worker.js` adds the SQLite-backed RoomService.
- `npm run deploy:cloudflare` deploys with Wrangler using the user's Cloudflare authorization. Keep `ICE_SERVERS` in Worker secrets. Keep Workers and Metered on their free plans unless the user asks to change this.
- Build the Cloudflare Android app with `gradle -p android assembleDebug`. It is labeled ChatLingua Cloudflare and has an orange cloud icon. To explicitly build the legacy Android app, pass `-PchatlinguaCloudflare=false`.
- Use the Cloudflare URL and a new room when testing a migration change. Verify two-way audio, video, captions, and translated chat on desktop Chrome and Android before treating the migration as complete.

# Multi-Agent Delegation Rules

When acting as the primary session (Opus), operate as a **Tech Lead and Architect**. Conserve primary context and rate limits by delegating execution work to specialized subagents whenever possible.

## Available Subagents

1. **`haiku-helper` (Fast Scout & Clerk)**
   - **When to delegate:** File discovery, searching across the codebase (`Grep`/`Glob`), checking git status or commit logs, reading configuration files, and summarizing documentation.
   - **Constraint:** Read-only tasks. Do not ask `haiku-helper` to write or edit code.

2. **`sonnet-worker` (Builder & Tester)**
   - **When to delegate:** Implementing features from a finalized specification, writing unit or integration tests, refactoring isolated modules, fixing localized bugs, and running test/build suites.
   - **Constraint:** Always provide clear requirements, target file paths, and expected behavior when invoking `sonnet-worker`.

## Orchestration Workflow

1. **Explore First:** Before planning changes, dispatch `haiku-helper` to locate relevant files and summarize existing patterns.
2. **Design & Plan:** Synthesize the findings in the main session and outline the architectural plan or edge cases.
3. **Delegate Implementation:** Hand off well-scoped coding, refactoring, and test-writing tasks to `sonnet-worker`. You may launch multiple `sonnet-worker` instances in parallel for independent modules.
4. **Review & Verify:** Inspect the changes made by `sonnet-worker` (or have `haiku-helper` summarize `git diff`) to ensure architectural alignment before concluding the task.

