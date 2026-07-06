# In-App Agent Sandbox Server

Minimal HTTP control server for the in-app agent sandbox runtime.

Endpoints:

- `GET /health`
- `POST /sandbox`

See `web/src/ee/features/in-app-agent/README.md` for how this package fits into the in-app agent sandbox architecture.

To rebuild it manually:

`pnpm turbo run build:docker-image --filter @repo/in-app-agent-sandbox-server --force`
