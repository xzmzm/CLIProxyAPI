# Local Codex API setup

## macOS

Run these commands from the checkout root. Install Go 1.26 or newer using
`brew install go`. The helper also requires `jq` and `python3`; install them
with `brew install jq python` if needed. Python detaches the server
from the launching terminal so closing it does not stop the proxy.

```bash
./local-setup/proxy.sh init
./local-setup/proxy.sh build
./local-setup/proxy.sh start
./local-setup/proxy.sh status
```

`init` generates two distinct random keys, creates private `config.yaml` and
`local-setup/credentials.json` files, and restricts access to the auth and log
directories. It refuses to overwrite either configuration file. The proxy binds
to `127.0.0.1:8317`. Configuration, credentials, auth tokens, logs, and the binary
are ignored by Git.

Sign in to enable upstream model requests:

```bash
./local-setup/proxy.sh login
# If browser callback login fails:
./local-setup/proxy.sh devicelogin
./local-setup/proxy.sh status
./local-setup/proxy.sh test
# Or: ./local-setup/proxy.sh test MODEL_FROM_STATUS
```

Complete sign-in in your browser and leave the login command running until it
reports success. A fresh setup can serve the local UI before any account is
connected; its model list will be empty until a provider is configured.

- Request log viewer: <http://127.0.0.1:8317/logs>
- Management panel: <http://127.0.0.1:8317/management.html>
- Application API base URL: `http://127.0.0.1:8317/v1`
- Keys: `api_key` and `management_key` in `local-setup/credentials.json`.

To copy the management key without displaying it in terminal output:

```bash
jq -j .management_key local-setup/credentials.json | pbcopy
```

Start runs in the background and prints the path to a fresh server log under
`local-setup/run-*`. It does not configure automatic startup after reboot.
Use `./local-setup/proxy.sh stop` to stop it. After source updates, run `stop`,
`build`, then `start`. Actions are case-insensitive and the helper also works
when invoked by its absolute path from another directory.

## Windows

Run commands below from the root of your checkout. This wrapper is for Windows,
binds the proxy to this PC, and uses port 8317.

## First-time setup

Install Go 1.26 or newer and make `go` available on PATH. The optional existing
`D:\Tools\go` installation is also supported by `go-env.ps1`.

Create your private configuration files only if they do not already exist:

```powershell
if (-not (Test-Path .\config.yaml)) {
    Copy-Item .\local-setup\config.example.yaml .\config.yaml
}
if (-not (Test-Path .\local-setup\credentials.json)) {
    Copy-Item .\local-setup\credentials.example.json .\local-setup\credentials.json
}
```

Replace the placeholders in both files with two distinct, randomly generated
local keys. The `api_key` in `credentials.json` must match the entry under
`api-keys` in `config.yaml`; `management_key` must match
`remote-management.secret-key`. Do not use the placeholder values as credentials.
Keep the example's loopback host and base URL. For different ports or advanced
configuration, run the server directly instead of this wrapper.

```powershell
.\local-setup\proxy.cmd Build
```

The committed examples contain no real credentials. Your populated `config.yaml`,
`credentials.json`, OAuth tokens, logs, and binaries are ignored by Git.

## Start and sign in

```powershell
.\local-setup\proxy.cmd Start
.\local-setup\proxy.cmd Login
```

Complete the OpenAI sign-in in your browser. The proxy saves its own OAuth
credentials under `auths` in your checkout and loads them automatically.
Keep the login command running until it reports success. If browser callback
login does not work, try `DeviceLogin` instead of `Login`.

```powershell
.\local-setup\proxy.cmd Status
.\local-setup\proxy.cmd Test
```

`Test` makes one small model request. Its default model is `gpt-5.4-mini`.
To use a different model returned by `Status`:

```powershell
.\local-setup\proxy.cmd Test -Model gpt-5.6-terra
```

An available model name alone does not prove your account can run it; a
successful model response is the end-to-end check.

## Connect your application

| Setting | Value |
| --- | --- |
| OpenAI-compatible base URL | `http://127.0.0.1:8317/v1` |
| API key | `api_key` in `local-setup\credentials.json` |
| Responses endpoint | `POST /v1/responses` |
| Chat Completions endpoint | `POST /v1/chat/completions` |
| Model list | `GET /v1/models` |

The local API key authenticates your app to the proxy. Your Codex OAuth login
authenticates the proxy to OpenAI. They are separate credentials.

This PowerShell example reads the local key without placing it in command history:

```powershell
$proxyCredentials = Get-Content .\local-setup\credentials.json -Raw | ConvertFrom-Json
$proxyHeaders = @{ Authorization = 'Bearer ' + $proxyCredentials.api_key }
$proxyBody = @{
    model = 'gpt-5.4-mini'
    input = 'Reply with exactly: proxy-ok'
} | ConvertTo-Json
Invoke-RestMethod ($proxyCredentials.base_url + '/responses') `
    -Method Post -Headers $proxyHeaders -ContentType 'application/json' -Body $proxyBody
```

## Management panel

Open <http://127.0.0.1:8317/management.html>. Use the `management_key` from
`local-setup\credentials.json` to log in. The server address, if requested,
is `http://127.0.0.1:8317`. The panel can manage accounts and show usage.
Its first download may take a moment.

## Optional: connect Codex CLI

An optional provider/profile snippet is in `codex-provider.toml`. Merge it into
your Codex CLI configuration, then in the same terminal:

```powershell
$proxyCredentials = Get-Content .\local-setup\credentials.json -Raw | ConvertFrom-Json
$env:CLIPROXY_API_KEY = $proxyCredentials.api_key
codex --profile cliproxy
```

The setup does not change your existing Codex configuration.
Provider configuration follows the [official OpenAI documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers).

## Stop, restart, and rebuild

```powershell
.\local-setup\proxy.cmd Stop
.\local-setup\proxy.cmd Start
```

Start runs in the background. Run it again after restarting Windows; automatic
startup is not configured. Each start creates a new pair of server log files in
`local-setup`. Existing logs are preserved.

After updating source code, stop the server, run `Build`, then `Start`:

```powershell
.\local-setup\proxy.cmd Stop
.\local-setup\proxy.cmd Build
.\local-setup\proxy.cmd Start
```

## Request log viewer

Open <http://127.0.0.1:8317/logs> to browse saved requests. Each entry has Chat,
Tree, and Raw views. Chat renders Markdown; Tree and Raw provide separate
Proxy and API (upstream) subtabs, including request/response payloads, retries,
errors, and WebSocket timelines. Download returns the complete original log.

The local example enables `request-log: true`. Request logs normally live under
`logs` in the checkout; the viewer follows the request logger's resolved directory.
These logs can contain sensitive conversations and are not committed. See the
[viewer documentation](../internal/api/handlers/logviewer/README.md) for access
restrictions and test commands. Rebuild/restart after source changes, then hard
refresh the browser to load updated embedded assets.

## Optional D:\Tools layout

- Go installation: `D:\Tools\go`.
- Go packages and installed Go commands: `D:\Tools\gopath`.
- Go build cache: `D:\Tools\go-cache`.
- Go temporary build files: `D:\Tools\go-tmp`.
- Go environment configuration: `D:\Tools\go-env`.
- Proxy executable: `cli-proxy-api.exe` in the checkout root.
- Proxy configuration: `config.yaml` in the checkout root.

If this installation exists, `Build` loads its Go PATH and environment settings.
In a PowerShell terminal, run `. .\local-setup\go-env.ps1` to load them manually.
Otherwise, the script uses your existing Go installation and environment.

The example listens only on this PC (`127.0.0.1`). Setup scripts, documentation,
and secret-free examples are tracked. The allowlist in `local-setup/.gitignore`
excludes all other local setup files, including credentials and server logs.
Keep `credentials.json` private and restrict access to configuration, logs, and
the auth directory on shared machines. Cloning the repository does not configure
Windows file permissions or automatic startup.
