<#
  High-FPS screen capture for the perf suite (Windows, ffmpeg + Desktop
  Duplication). Desktop Duplication (ddagrab) is GPU-side and sustains high FPS.

    .\capture_win.ps1 -Out rec.mkv -Seconds 12 -Fps 60

  For SCROLL frame rate, prefer PresentMon (run_word_win.ps1 wires it up) — it
  reads true per-frame present times from the app process. Use this recording
  for the marker + content-stable timing (open/nav) and as a visual record.
#>
param(
  [string]$Out = "rec.mkv",
  [int]$Seconds = 12,
  [int]$Fps = 60
)
$ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue)
if (-not $ff) { throw "ffmpeg not found on PATH (winget install Gyan.FFmpeg)" }

# ddagrab needs the lavfi/hwaccel path; gdigrab is the simpler fallback.
& ffmpeg -y `
  -f gdigrab -framerate $Fps -i desktop `
  -t $Seconds `
  -c:v libx264 -preset ultrafast -qp 0 -pix_fmt yuv420p `
  $Out
Write-Host "wrote $Out ($Seconds s @ ${Fps}fps target)"
