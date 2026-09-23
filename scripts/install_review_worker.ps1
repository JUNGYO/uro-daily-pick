param(
 [Parameter(Mandatory=$true)][string]$ReleasePath,
 [Parameter(Mandatory=$true)][string]$PythonPath,
 [Parameter(Mandatory=$true)][string]$WorkerDirectory
)
# Separate CPU worker. Never changes collection, inference, or viewer tasks.
$ErrorActionPreference='Stop'
$release=(Resolve-Path -LiteralPath $ReleasePath).Path
$python=(Resolve-Path -LiteralPath $PythonPath).Path
$worker=(Resolve-Path -LiteralPath $WorkerDirectory).Path
$allowedRoot=[IO.Path]::GetFullPath('D:\UroDailyPick\review\releases').TrimEnd('\')
if(-not $release.StartsWith($allowedRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected review release'}
if($worker -ne 'D:\UroDailyPick\state'){throw 'Unexpected enrollment directory'}
if(-not (Test-Path -LiteralPath (Join-Path $worker 'worker-token.dpapi') -PathType Leaf)){throw 'Existing enrollment required'}
foreach($file in @('review_service.py','review_analysis.py','review_documents.py','review_figures.py','requirements-analysis.txt')){
 if(-not(Test-Path -LiteralPath (Join-Path $release $file) -PathType Leaf)){throw 'Incomplete review release'}
}
& $python -I -c "import numpy,scipy;assert numpy.__version__=='1.26.4';assert scipy.__version__=='1.14.1'"
if($LASTEXITCODE -ne 0){throw 'Analysis runtime verification failed'}
$existing=Get-ScheduledTask -TaskName 'UroDailyPick-Institution-Fulltext'
if($existing.Principal.LogonType -ne 'Interactive' -or $existing.Principal.RunLevel -ne 'Limited'){throw 'Unexpected existing worker identity'}
$name='UroDailyPick-Review-Analysis'
if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){throw 'Review worker already installed; inspect its state before updating'}
$backgroundPython=Join-Path (Split-Path -Parent $python) 'pythonw.exe'
if(-not(Test-Path -LiteralPath $backgroundPython -PathType Leaf)){throw 'Background Python executable required'}
$action=New-ScheduledTaskAction -Execute $backgroundPython -Argument ('-I -B "'+(Join-Path $release 'review_service.py')+'" --worker-only --worker-dir "'+$worker+'"') -WorkingDirectory $release
$principal=New-ScheduledTaskPrincipal -UserId $existing.Principal.UserId -LogonType Interactive -RunLevel Limited
$logon=New-ScheduledTaskTrigger -AtLogOn -User $existing.Principal.UserId
$retry=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Trigger @($logon,$retry) -Settings $settings -Description 'Typed Python meta-analysis queue; no LLM or provider keys' | Out-Null
Start-ScheduledTask -TaskName $name
Get-ScheduledTask -TaskName $name | Select-Object TaskName,State
