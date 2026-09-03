param(
    [ValidateSet('Start', 'Stop', 'Status', 'Login', 'DeviceLogin', 'Test', 'Build')]
    [string]$Action = 'Status',
    [string]$Model = 'gpt-5.4-mini'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$binary = Join-Path $projectRoot 'cli-proxy-api.exe'
$configPath = Join-Path $projectRoot 'config.yaml'
$credentials = $null
$headers = @{}
if ($Action -in @('Start', 'Status', 'Test')) {
    $credentialsPath = Join-Path $PSScriptRoot 'credentials.json'
    if (-not (Test-Path -LiteralPath $credentialsPath)) {
        throw 'Create local-setup\credentials.json from credentials.example.json first. See local-setup\README.md.'
    }
    $credentials = Get-Content -Raw $credentialsPath | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($credentials.api_key) -or $credentials.api_key -like 'REPLACE_WITH_*') {
        throw 'Set your own local API key in credentials.json and config.yaml before starting.'
    }
    $baseUri = [uri]$credentials.base_url
    if (-not $baseUri.IsAbsoluteUri -or $baseUri.Scheme -ne 'http' -or -not $baseUri.IsLoopback -or $baseUri.Port -ne 8317 -or $baseUri.AbsolutePath.TrimEnd('/') -ne '/v1' -or $baseUri.UserInfo -or $baseUri.Query -or $baseUri.Fragment) {
        throw 'This local wrapper requires a loopback HTTP base_url on port 8317 with path /v1.'
    }
    $headers = @{ Authorization = 'Bearer ' + $credentials.api_key }
}

function Get-ProxyProcess {
    Get-Process -Name 'cli-proxy-api' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $binary -and $_.Id -in @(
            Get-NetTCPConnection -LocalPort 8317 -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess
        ) }
}

Push-Location $projectRoot
try {
    switch ($Action) {
        'Build' {
            if (Get-ProxyProcess) { throw 'Stop the proxy before rebuilding.' }
            . (Join-Path $PSScriptRoot 'go-env.ps1')
            if ($env:GOTMPDIR) {
                $env:TEMP = $env:GOTMPDIR
                $env:TMP = $env:GOTMPDIR
            }
            & go build -o $binary ./cmd/server
            if ($LASTEXITCODE -ne 0) { throw 'Go build failed.' }
            Write-Output "Built $binary"
        }
        'Start' {
            if (Get-ProxyProcess) { Write-Output 'Proxy is already running.'; break }
            if (-not (Test-Path -LiteralPath $binary)) { throw 'Run the Build action first.' }
            if (-not (Test-Path -LiteralPath $configPath)) { throw 'Create config.yaml from local-setup\config.example.yaml first.' }
            if (Get-NetTCPConnection -LocalPort 8317 -State Listen -ErrorAction SilentlyContinue) {
                throw 'Port 8317 is occupied by another process.'
            }
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
            $stdout = Join-Path $PSScriptRoot "server-$stamp.stdout.log"
            $stderr = Join-Path $PSScriptRoot "server-$stamp.stderr.log"
            $serverProcess = Start-Process -FilePath $binary -ArgumentList @('--config', ('"' + $configPath + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
            $ready = $false
            for ($attempt = 0; $attempt -lt 40; $attempt++) {
                if ($serverProcess.HasExited) { throw "Proxy exited. Inspect $stderr and $stdout" }
                try {
                    $null = Invoke-RestMethod ($credentials.base_url + '/models') -Headers $headers
                    $ready = $true
                    break
                } catch { Start-Sleep -Milliseconds 250 }
            }
            if (-not $ready) { throw "Proxy did not become ready. Inspect $stderr and $stdout" }
            Write-Output "Proxy running at $($credentials.base_url) (PID $($serverProcess.Id))."
        }
        'Stop' {
            $serverProcesses = @(Get-ProxyProcess)
            if ($serverProcesses.Count -eq 0) { Write-Output 'Proxy is already stopped.'; break }
            $serverProcesses | Stop-Process
            Write-Output 'Proxy stopped.'
        }
        'Login' {
            & $binary --config $configPath --codex-login
            if ($LASTEXITCODE -ne 0) { throw 'Codex login failed.' }
        }
        'DeviceLogin' {
            & $binary --config $configPath --codex-device-login
            if ($LASTEXITCODE -ne 0) { throw 'Codex device login failed.' }
        }
        'Status' {
            $models = Invoke-RestMethod ($credentials.base_url + '/models') -Headers $headers
            Write-Output "Proxy is reachable at $($credentials.base_url)."
            Write-Output "Available models: $(@($models.data).Count)"
            $models.data | Select-Object -ExpandProperty id
        }
        'Test' {
            $models = Invoke-RestMethod ($credentials.base_url + '/models') -Headers $headers
            if ($Model -notin @($models.data.id)) { throw "Model $Model is unavailable. Complete Login, then use Status to list models." }
            $body = @{ model = $Model; input = 'Reply with exactly: proxy-ok'; stream = $false } | ConvertTo-Json
            $response = Invoke-RestMethod ($credentials.base_url + '/responses') -Headers $headers -Method Post -ContentType 'application/json' -Body $body
            $responseText = @($response.output | ForEach-Object { $_.content } | Where-Object { $_.type -eq 'output_text' } | ForEach-Object { $_.text }) -join "`n"
            if ($response.status -ne 'completed' -or [string]::IsNullOrWhiteSpace($responseText)) { throw 'The upstream response did not complete with text.' }
            Write-Output "Upstream response ($Model): $responseText"
        }
    }
} finally {
    Pop-Location
}
