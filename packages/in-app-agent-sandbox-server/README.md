# In-App Agent Sandbox Server

Minimal HTTP control server for the in-app agent sandbox runtime.

Endpoints:

- `GET /health`
- `POST /sandbox`

See `web/src/ee/features/in-app-agent/README.md` for how this package fits into the in-app agent sandbox architecture.

Build the package and local image with:

`pnpm --filter @repo/in-app-agent-sandbox-server build && docker build "packages/in-app-agent-sandbox-server" -t langfuse-in-app-agent-sandbox:latest`
