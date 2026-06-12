<#
  verbatim-flow.ps1 — CardMirror ↔ Verbatim Flow bridge (Windows only).

  Reproduces, from an external process, exactly what the Verbatim Word
  add-in does to talk to Verbatim Flow (the Excel template): drive the
  STANDARD Excel object model over COM. Requires NO modification to
  Verbatim Flow — it is a passive recipient of active-cell writes.

  Runs as a PERSISTENT host. apps/desktop/src/flow-bridge.ts spawns it
  once:
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
      -File verbatim-flow.ps1
  then speaks newline-delimited JSON over stdin/stdout — one request line
  in, one response line out. Keeping the process (and its warm CLR) alive
  across requests turns a multi-second per-send cold start into a COM call
  of a few milliseconds.

  Request line:  { "id": N, "verb": "available|send|pull|create|ping",
                   "payload": { ... }, "force": true|false }
  Response line: a compact JSON object, echoing "id".

  Payload (send): { "cells": ["...", ...] } — values written DOWN the
  column from the current active cell (cell mode = one element; column
  mode = one per paragraph). Never quits the user's Excel; only
  reads/writes its cells.
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

# = VBA GetObject(, "Excel.Application") — the RUNNING instance, no launch.
function Get-RunningExcel {
  try { return [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application') }
  catch { return $null }
}

# = VBA: For Each w In Workbooks: If InStr(LCase(w.Name),"flow")
function Find-FlowWorkbook($xl) {
  foreach ($wb in $xl.Workbooks) {
    if ($wb.Name.ToLower().Contains('flow')) { return $wb }
  }
  return $null
}

# Dispatch one request object → a result hashtable. Throws on COM errors
# (caught by the loop, which turns them into an error response without
# killing the host).
function Invoke-FlowVerb($req) {
  switch ([string]$req.verb) {

    'ping' { return @{ ok = $true; pong = $true } }

    'available' {
      $xl = Get-RunningExcel
      if ($null -eq $xl) { return @{ available = $false; reason = 'excel-not-open' } }
      $wb = Find-FlowWorkbook $xl
      if ($null -eq $wb) { return @{ available = $false; reason = 'no-flow-workbook' } }
      return @{ available = $true; workbook = $wb.Name }
    }

    'send' {
      $xl = Get-RunningExcel
      if ($null -eq $xl) { return @{ ok = $false; error = 'excel-not-open' } }
      $wb = Find-FlowWorkbook $xl
      if ($null -eq $wb) { return @{ ok = $false; error = 'no-flow-workbook' } }
      [void]$wb.Activate()
      $sheet = $wb.ActiveSheet
      if ($null -eq $sheet) { return @{ ok = $false; error = 'no-active-sheet' } }

      $cells = @($req.payload.cells)
      if ($cells.Count -eq 0) { return @{ ok = $true; written = 0 } }

      # Overwrite guard (= Verbatim's "already text where you're sending"
      # prompt) — checked on the first target cell.
      $target = $xl.ActiveCell
      if (-not $req.force -and ("$($target.Value2)").Length -gt 0) {
        return @{ ok = $false; needsConfirm = $true; cell = $target.Address($false, $false) }
      }

      $written = 0
      foreach ($c in $cells) {
        $xl.ActiveCell.Value2 = [string]$c
        $xl.ActiveCell.Offset(1, 0).Select() | Out-Null   # advance down one row
        $written++
      }
      return @{ ok = $true; written = $written }
    }

    'pull' {
      $xl = Get-RunningExcel
      if ($null -eq $xl) { return @{ ok = $false; error = 'excel-not-open' } }
      $wb = Find-FlowWorkbook $xl
      if ($null -eq $wb) { return @{ ok = $false; error = 'no-flow-workbook' } }
      $out = New-Object System.Collections.Generic.List[string]
      foreach ($cell in $xl.Selection.Cells) {
        $v = "$($cell.Value2)"
        if ($v.Length -gt 0) { $out.Add($v) }
      }
      return @{ ok = $true; cells = $out.ToArray() }
    }

    'create' {
      # = Verbatim CreateFlow: launch Excel, open Debate.xltm from Word's
      # user-templates folder. We can't read Word's NormalTemplate.Path
      # here, so try the conventional Office user-templates locations.
      $candidates = @()
      if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'Microsoft\Templates\Debate.xltm') }
      $payloadPath = ''
      if ($req.payload -and $req.payload.templatePath) { $payloadPath = [string]$req.payload.templatePath }
      if ($payloadPath -ne '') { $candidates = @($payloadPath) + $candidates }
      $template = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($null -eq $template) { return @{ ok = $false; error = 'template-not-found'; tried = $candidates } }
      $xl = New-Object -ComObject Excel.Application
      $xl.Visible = $true
      $xl.Workbooks.Add($template) | Out-Null
      return @{ ok = $true; template = $template }
    }

    default { return @{ ok = $false; error = "unknown-verb:$([string]$req.verb)" } }
  }
}

# Persistent request loop: one JSON request per line, one JSON response
# per line. Exits when stdin closes (the parent process going away).
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Trim() -eq '') { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = Invoke-FlowVerb $req
  }
  catch {
    $result = @{ ok = $false; error = $_.Exception.Message }
  }
  if ($null -ne $id) { $result['id'] = $id }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
