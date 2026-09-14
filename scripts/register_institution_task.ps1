param([Parameter(Mandatory=$true)][string]$ReleasePath)
$ErrorActionPreference = 'Stop'
$workerRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'UroDailyPick'))
$workerRelease = [IO.Path]::GetFullPath($ReleasePath)
if (-not $workerRelease.StartsWith((Join-Path $workerRoot 'releases') + [IO.Path]::DirectorySeparatorChar)) {
  throw 'Release must be inside the UroDailyPick installation'
}
if (-not (Test-Path -LiteralPath (Join-Path $workerRelease 'installed.json'))) { throw 'Release has not passed installation checks' }
$workerUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$workerAction = New-ScheduledTaskAction -Execute (Join-Path $workerRelease 'python/Scripts/pythonw.exe') -Argument ('"' + (Join-Path $workerRelease 'institution_entry.py') + '"') -WorkingDirectory $workerRelease
$workerTriggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $workerUser),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1))
)
$workerPrincipal = New-ScheduledTaskPrincipal -UserId $workerUser -LogonType Interactive -RunLevel Limited
$workerSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'UroDailyPick-Institution-Fulltext' -Action $workerAction -Trigger $workerTriggers -Principal $workerPrincipal -Settings $workerSettings -Description 'Store article bodies on Z8, summarize with existing Spark, and publish only summaries and metadata to Uro Daily Pick.' -Force | Out-Null
Get-ScheduledTask -TaskName 'UroDailyPick-Institution-Fulltext' | Select-Object TaskName,State
