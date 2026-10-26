# AI Status Embed

Self-hosted, iframe-friendly status pages for OpenAI, Claude, Gemini, DeepSeek, and Kimi. The service fetches public official status data server-side, normalizes it into a small local API, and serves five self-contained English pages with embedded CSS, JavaScript, and brand artwork.

## Included providers

- OpenAI — OpenAI API and ChatGPT status data from `status.openai.com`
- Claude — Claude API and Claude.ai status data from `status.claude.com`
- Gemini — Gemini API and Google AI Studio incident history from the official Google AI Studio status service
- DeepSeek — DeepSeek service status from `status.deepseek.com`
- Kimi — Kimi and Moonshot AI status data from `status.moonshot.cn`

The Gemini page is intentionally scoped to the Gemini API and Google AI Studio. It does not claim to represent consumer Gemini, Vertex AI, or Google Workspace availability.

## Features

- Official current status and historical data, with provider-specific status colors
- Preserved official historical chart fills, including provider-specific interpolated colors
- English, responsive pages designed for direct use or iframe embedding
- Light and dark themes via `?theme=light` or `?theme=dark`
- Read-only server with fixed official upstream allowlists
- Per-provider caching, concurrent request coalescing, bounded upstream responses, timeout, and retry handling
- Safe default iframe policy with optional exact-origin restrictions through `EMBED_ORIGINS`
- No client API key or user authentication required

## Requirements

- Node.js 22 or newer
- npm

## Run locally

```bash
npm ci
npm test
npm start
```

The server listens on `127.0.0.1:8099` by default. Set `HOST` and `PORT` to change the bind address and port:

```bash
HOST=0.0.0.0 PORT=8099 npm start
```

Open `http://127.0.0.1:8099/` or one of the direct pages:

- `/openai.html`
- `/claude.html`
- `/gemini.html`
- `/deepseek.html`
- `/kimi.html`

To restrict iframe embedding to exact origins, use a space-separated list of HTTP(S) origins or `'self'`:

```bash
EMBED_ORIGINS="https://example.com https://admin.example.com" npm start
```

The default `EMBED_ORIGINS=*` allows embedding from any website. Do not add credentials, tokens, or arbitrary upstream URLs to client requests; the server intentionally ignores them.

## Docker

Build and run the included image:

```bash
docker build -t ai-status-embed:local .
docker compose up -d --force-recreate
```

The compose file binds the container to `127.0.0.1:8099`. Put an existing reverse proxy in front of it if the service must be exposed externally. Keep the proxy's frame policy compatible with the `EMBED_ORIGINS` setting.

### Automatic Docker Hub publishing

`.github/workflows/docker-publish.yml` builds and publishes the image from GitHub Actions on pushes to `main`, version tags such as `v1.6.10`, or a manual workflow run. It publishes these tags:

- `docker.io/<Docker Hub username>/ai-status-embed:latest` for `main`
- `docker.io/<Docker Hub username>/ai-status-embed:<version>` for `v*.*.*` tags
- `docker.io/<Docker Hub username>/ai-status-embed:sha-<commit>` for every run

Before using the workflow, add these repository settings on GitHub:

1. Repository variable `DOCKERHUB_USERNAME` — your Docker Hub username.
2. Repository secret `DOCKERHUB_TOKEN` — a Docker Hub access token with permission to push this repository.

The workflow currently targets `linux/amd64`, matching the usual x86 server deployment. After the first successful publish, the server can use the published image instead of building locally:

```yaml
services:
  ai-status-embed:
    image: docker.io/<your-dockerhub-username>/ai-status-embed:latest
    pull_policy: always
    restart: unless-stopped
    ports:
      - "127.0.0.1:8099:8099"
```

Then update the server with:

```bash
docker compose pull
docker compose up -d --force-recreate
```

## Project layout

- `server.mjs` — HTTP server, fixed upstream routes, caching, security headers, and API normalization
- `history.mjs` — OpenAI and Claude history parsing and official fill preservation
- `gemini.mjs` — Gemini API / AI Studio incident history adapter
- `deepseek.mjs` — DeepSeek SSR status and chart adapter
- `kimi.mjs` — Kimi Statuspage adapter
- `*.html` — self-contained provider pages and the provider selector
- `*.test.mjs` — parser, server, provider, and page regression tests
- `Dockerfile`, `docker-compose.yml` — container deployment

## Security notes

- Upstream destinations are fixed in source code and are never taken from client-provided URLs.
- Client query parameters, authorization headers, cookies, and embedding credentials are not forwarded upstream.
- Responses are size-limited and fetched with an 8-second timeout and `redirect: 'error'`.
- The service does not log request URLs or authentication material.
- This project displays third-party service status and is not operated by, endorsed by, or affiliated with the listed providers.

## License

MIT. See [LICENSE](LICENSE).
