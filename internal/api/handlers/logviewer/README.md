# Local request log viewer

Open `http://localhost:8317/logs` (replace the port if configured differently).
The viewer is embedded in the server binary and needs no frontend build, CDN,
or additional service. Rebuild and restart the server after updating its source.

- The table lists saved request log files newest-first, with 50 entries per page.
  Search matches the filename, which contains the endpoint, timestamp, and request ID.
- **Chat** renders Markdown in messages, instructions, reasoning, and tool descriptions:
  headings, lists, emphasis, tables, blockquotes, task lists, links, and fenced code.
  Role-colored message cards distinguish right-aligned users from assistants and
  instruction blocks. Tool calls/results retain literal payload formatting. Long
  content is rendered on expansion. Attachments are represented as text; logged HTML
  and remote images are never executed or fetched. Markdown uses locally bundled
  Marked and DOMPurify with a restricted tag/URL allowlist.
- **Tree → API (upstream)** (default) shows expandable upstream request and response
  JSON side by side. Each numbered retry and error stays separate, with response
  streams consolidated per attempt. Headers, original events, and recorded sections
  remain available. **Tree → Proxy** shows the incoming client request and the
  response returned by the proxy. WebSocket timelines preserve event order.
- **Raw → API** (default) shows upstream API requests and responses side by side,
  including numbered retries, upstream errors, and API WebSocket timelines.
  **Raw → Proxy** shows the original incoming request and the response sent back
  to the client. Missing sections are explicitly indicated, not substituted with
  traffic from the other side. **Download raw** always returns the complete file.

The viewer reads the file request logger's resolved directory, including the
`WRITABLE_PATH` or auth-directory fallback. It does not modify or delete logs.
`request-log: true` records normal requests; with it disabled, only eligible error
logs may be available. Home-forwarded logs are not stored locally. Refresh to see
newly saved files; in-flight streaming requests may not appear until they complete.

Duration is approximate: log file modification time minus request-start time.
Files over 64 MiB are listed and downloadable, but are not parsed in the viewer.
Unrecognized or incomplete data remains available in Raw view. Only request-log
filenames are listed; `main.log`, rotated application logs, and temp files are excluded.

## Access restrictions

Logs contain sensitive conversations. `/logs` and its API are read-only and accept
only loopback TCP peers with a localhost/loopback Host header. Forwarded IP headers
do not grant access. Cross-origin requests, framing, and browser caching are blocked.
No API key is needed locally. Do not forward this route through a reverse proxy
that rewrites the Host header to localhost, as that would bypass the local boundary.

## Tests

```powershell
go test ./internal/api/handlers/logviewer ./internal/api ./internal/logging
node --test internal/api/handlers/logviewer/parser_test.cjs
```

For Markdown/security and DOM interaction tests, install the test-only dependencies
with a current Node release supported by jsdom, then run:

```powershell
cd internal/api/handlers/logviewer
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
```

The Go server build does not require Node or these development dependencies.
