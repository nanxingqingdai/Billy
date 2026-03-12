# BillyCode - Sync data folder from Mac Mini on startup

$PROJECT  = "C:\Users\rongh\Desktop\BillyCode"
$MAC_HOST = "wen@192.168.31.109"
$MAC_DATA = "wen@192.168.31.109:~/BillyCode/data"
$LOG_FILE = "$PROJECT\deploy\sync.log"

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host $line
  Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
}

Write-Log "[Billy] === Sync start ==="

# 1. git pull (watchlist.json / risk-config.json)
Set-Location $PROJECT
$gitOut = (git pull origin main 2>&1) -join " "
Write-Log "[git] $gitOut"

# 2. Ensure data/ exists
New-Item -ItemType Directory -Force -Path "$PROJECT\data" | Out-Null

# 3. scp runtime files (gitignored)
$files = @("positions.json", "moonshot-seen.json")
foreach ($f in $files) {
  $dest = "$PROJECT\data\$f"
  $src  = "${MAC_DATA}/${f}"
  scp -o StrictHostKeyChecking=no -o ConnectTimeout=10 $src $dest 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Log "[scp] $f - OK"
  } else {
    Write-Log "[scp] $f - skipped (not found or unreachable)"
  }
}

Write-Log "[Billy] === Sync done ==="
