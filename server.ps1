param(
  [int]$Port = 8765,
  [string]$Root = "$(Split-Path -Parent $PSScriptRoot)\app"
)

$ErrorActionPreference = 'Stop'
$Root = [System.IO.Path]::GetFullPath($Root)
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

function Get-ContentType([string]$Path) {
  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    '.html' { 'text/html; charset=utf-8' }
    '.css' { 'text/css; charset=utf-8' }
    '.js' { 'application/javascript; charset=utf-8' }
    '.json' { 'application/json; charset=utf-8' }
    '.webmanifest' { 'application/manifest+json; charset=utf-8' }
    '.png' { 'image/png' }
    '.svg' { 'image/svg+xml' }
    default { 'application/octet-stream' }
  }
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }

      while ($true) {
        $line = $reader.ReadLine()
        if ([string]::IsNullOrEmpty($line)) { break }
      }

      $parts = $requestLine.Split(' ')
      $requestPath = if ($parts.Count -ge 2) { $parts[1] } else { '/' }
      $requestPath = $requestPath.Split('?')[0]
      $requestPath = [System.Uri]::UnescapeDataString($requestPath).TrimStart('/')
      if ([string]::IsNullOrWhiteSpace($requestPath)) { $requestPath = 'index.html' }

      $candidate = [System.IO.Path]::GetFullPath((Join-Path $Root $requestPath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
      if (-not $candidate.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $candidate = Join-Path $Root 'index.html'
      }

      $body = [System.IO.File]::ReadAllBytes($candidate)
      $contentType = Get-ContentType $candidate
      $header = "HTTP/1.1 200 OK`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
      $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      $stream.Write($body, 0, $body.Length)
      $stream.Flush()
    }
    catch {
      try {
        $message = [System.Text.Encoding]::UTF8.GetBytes('Erro interno')
        $header = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 500 Internal Server Error`r`nContent-Length: $($message.Length)`r`nConnection: close`r`n`r`n")
        $client.GetStream().Write($header, 0, $header.Length)
        $client.GetStream().Write($message, 0, $message.Length)
      } catch {}
    }
    finally {
      $client.Dispose()
    }
  }
}
finally {
  $listener.Stop()
}
