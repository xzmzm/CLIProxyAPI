# Preserve the original D:\Tools installation when present. Other machines can
# use a normal Go installation on PATH without creating this directory layout.
if (Test-Path -LiteralPath 'D:\Tools\go\bin\go.exe') {
    $env:GOPATH = 'D:\Tools\gopath'
    $env:GOCACHE = 'D:\Tools\go-cache'
    $env:GOTMPDIR = 'D:\Tools\go-tmp'
    $env:GOENV = 'D:\Tools\go-env'
    $env:PATH = 'D:\Tools\go\bin;D:\Tools\gopath\bin;' + $env:PATH
    foreach ($directory in @($env:GOPATH, $env:GOCACHE, $env:GOTMPDIR)) {
        if (-not (Test-Path -LiteralPath $directory)) {
            $null = New-Item -ItemType Directory -Path $directory -Force
        }
    }
}

if (-not (Get-Command go -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Install Go 1.26 or newer and add its bin directory to PATH.'
}
