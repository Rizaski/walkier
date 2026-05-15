# WalkieR — serve on all interfaces so phones on the same Wi-Fi can connect
$Port = 8000
$Root = $PSScriptRoot

Write-Host ""
Write-Host "WalkieR mobile server" -ForegroundColor Green
Write-Host "=====================" -ForegroundColor Green

# Allow inbound TCP on this port (requires Administrator once)
$ruleName = "WalkieR HTTP $Port"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
  try {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
    Write-Host "Firewall: added rule for port $Port" -ForegroundColor Yellow
  } catch {
    Write-Host "Firewall: could not add rule (run PowerShell as Administrator):" -ForegroundColor Red
    Write-Host "  New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port"
  }
} else {
  Write-Host "Firewall: rule already exists for port $Port"
}

Write-Host ""
Write-Host "Open on your phone (same Wi-Fi):" -ForegroundColor Cyan
Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.IPAddress -notlike "127.*" -and $_.InterfaceAlias -notmatch "Loopback"
} | ForEach-Object {
  Write-Host "  http://$($_.IPAddress):$Port/" -ForegroundColor White
}

Write-Host ""
Write-Host "Important for mobile:" -ForegroundColor Yellow
Write-Host "  - Google sign-in does NOT work on raw IP addresses."
Write-Host "  - Microphone needs HTTPS on phones. Use Firebase Hosting or:"
Write-Host "    npx localtunnel --port $Port"
Write-Host ""
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

Set-Location $Root
py -m http.server $Port --bind 0.0.0.0
