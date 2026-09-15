param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$ReleasePath,
  [Parameter(Mandatory=$true)][string]$PythonPath
)
# Update only the existing dedicated viewer task. No account, password, network,
# research settings, trigger or protected-directory permission changes.
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$release = (Resolve-Path -LiteralPath $ReleasePath).Path
$config = Join-Path $root 'config.json'
$script = Join-Path $release 'fulltext_viewer.py'
$report = Join-Path $root 'update-result.json'
$probe = Join-Path $root 'access-check.json'
$name = 'UroDailyPick-Original-Viewer'
$changed = $false
$stage = 'validate'
try {
  if (-not $release.StartsWith($root + '\releases\') -or -not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'Unexpected release path' }
  $task = Get-ScheduledTask -TaskName $name
  $reader = Get-LocalUser -Name UroDailyPickReader
  if ($task.Principal.RunLevel -ne 'Limited' -or $task.Principal.LogonType -ne 'Password') { throw 'Unexpected viewer principal' }
  if ($task.Principal.UserId -notin @($reader.Name, $reader.SID.Value, ($env:COMPUTERNAME + '\' + $reader.Name))) { throw 'Viewer identity changed' }
  if ($task.Actions.Count -ne 1 -or -not $task.Actions[0].WorkingDirectory.StartsWith($root + '\releases\')) { throw 'Unexpected installed viewer action' }
  $oldAction = $task.Actions
  [xml]$before = Export-ScheduledTask -TaskName $name
  $before.Save((Join-Path $root ('task-before-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.xml')))
  & $PythonPath -I -B $script --config $config --check
  if ($LASTEXITCODE -ne 0) { throw 'Release configuration validation failed' }
  & icacls.exe $release /grant ('*' + $reader.SID.Value + ':(OI)(CI)(RX)') /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Release read access failed' }
  '{}' | Set-Content -LiteralPath $probe -Encoding utf8
  & icacls.exe $probe /grant ('*' + $reader.SID.Value + ':(R,W)') /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Probe report access failed' }
  $pythonw = Join-Path (Split-Path -Parent $PythonPath) 'pythonw.exe'
  $arguments = '-I -B "' + $script + '" --config "' + $config + '"'
  Stop-ScheduledTask -TaskName $name
  $changed = $true
  $stage = 'probe-action'
  $check = New-ScheduledTaskAction -Execute $pythonw -Argument ($arguments + ' --access-report "' + $probe + '"') -WorkingDirectory $release
  Set-ScheduledTask -TaskName $name -Action $check | Out-Null
  $stage = 'probe-start'
  Start-ScheduledTask -TaskName $name
  $access = $null
  for ($attempt=0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    $value = Get-Content -LiteralPath $probe -Raw | ConvertFrom-Json
    if ($null -ne $value.images_readable) { $access=$value; break }
  }
  if (-not ($access.archive_readable -and $access.archive_read_only -and $access.private_paths_denied -and $access.images_readable)) { throw 'Dedicated reader access check failed' }
  $stage = 'server-action'
  Stop-ScheduledTask -TaskName $name
  $action = New-ScheduledTaskAction -Execute $pythonw -Argument $arguments -WorkingDirectory $release
  Set-ScheduledTask -TaskName $name -Action $action | Out-Null
  [xml]$after = Export-ScheduledTask -TaskName $name
  foreach ($section in @('Principals','Triggers','Settings')) {
    if ($before.Task.$section.OuterXml -ne $after.Task.$section.OuterXml) { throw ('Unexpected task change: ' + $section) }
  }
  Start-ScheduledTask -TaskName $name
  $healthy=$false
  for ($attempt=0; $attempt -lt 10; $attempt++) {
    try { if ((Invoke-RestMethod -Uri 'http://127.0.0.1:18451/health' -TimeoutSec 2).status -eq 'ok') { $healthy=$true;break } } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) { throw 'Updated viewer did not become healthy' }
  @{status='updated';release=$release;health=$healthy;access=$access;schedule_preserved=$true} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $report -Encoding utf8
} catch {
  $failure=[string]$_.Exception.Message
  $result=@{status='failed';stage=$stage;error=$failure;previous_action_restored=$false}
  $result | ConvertTo-Json | Set-Content -LiteralPath $report -Encoding utf8
  if ($changed) {
    try {
      Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      Set-ScheduledTask -TaskName $name -Action $oldAction | Out-Null
      Start-ScheduledTask -TaskName $name
      $result.previous_action_restored=$true
    } catch { $result.rollback_error=[string]$_.Exception.Message }
  }
  $result | ConvertTo-Json | Set-Content -LiteralPath $report -Encoding utf8
  throw
}
