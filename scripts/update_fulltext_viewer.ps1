param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$ReleasePath,
  [Parameter(Mandatory=$true)][string]$PythonPath
)
# Password-logon tasks cannot change actions without re-entering a password.
# Preserve the entire registered task and update its existing script after backup.
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$source=(Resolve-Path -LiteralPath (Join-Path $ReleasePath 'fulltext_viewer.py')).Path
$sourceEvidence=(Resolve-Path -LiteralPath (Join-Path $ReleasePath 'evidence.py')).Path
$sourceLayout=(Resolve-Path -LiteralPath (Join-Path $ReleasePath 'document_layout.py')).Path
$name='UroDailyPick-Original-Viewer'
$config=Join-Path $root 'config.json'
$report=Join-Path $root 'update-result.json'
$probe=Join-Path $root 'access-check.json'
$changed=$false
try {
 if(-not $source.StartsWith($root+'\releases\')){throw 'Unexpected prepared release'}
 $task=Get-ScheduledTask -TaskName $name
 $reader=Get-LocalUser -Name UroDailyPickReader
 if($task.Principal.RunLevel -ne 'Limited' -or $task.Principal.LogonType -ne 'Password'){throw 'Unexpected viewer principal'}
 if($task.Principal.UserId -notin @($reader.Name,$reader.SID.Value,($env:COMPUTERNAME+'\'+$reader.Name))){throw 'Viewer identity changed'}
 if($task.Actions.Count -ne 1){throw 'Unexpected viewer actions'}
 $active=(Resolve-Path -LiteralPath (Join-Path $task.Actions[0].WorkingDirectory 'fulltext_viewer.py')).Path
 if(-not $active.StartsWith($root+'\releases\') -or $active -eq $source -or -not $task.Actions[0].Arguments.Contains('"'+$active+'"')){throw 'Unexpected active viewer script'}
 $definition=Export-ScheduledTask -TaskName $name
 $expectedHash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
 $stamp=Get-Date -Format yyyyMMddHHmmss
 $backup=Join-Path $root ('viewer-before-'+$stamp+'.py')
 $activeEvidence=Join-Path (Split-Path -Parent $active) 'evidence.py'
 $activeLayout=Join-Path (Split-Path -Parent $active) 'document_layout.py'
 $layoutBackup=Join-Path $root ('layout-before-'+$stamp+'.py')
 if(Test-Path -LiteralPath $activeLayout){Copy-Item -LiteralPath $activeLayout -Destination $layoutBackup}
 $evidenceBackup=Join-Path $root ('evidence-before-'+$stamp+'.py')
 if(Test-Path -LiteralPath $activeEvidence){Copy-Item -LiteralPath $activeEvidence -Destination $evidenceBackup}
 $configBackup=Join-Path $root ('config-before-'+$stamp+'.json')
 Copy-Item -LiteralPath $active -Destination $backup
 Copy-Item -LiteralPath $config -Destination $configBackup
 $settings=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
 $settings | Add-Member -NotePropertyName startup_access_report -NotePropertyValue $probe -Force
 '{}' | Set-Content -LiteralPath $probe -Encoding utf8
 & icacls.exe $probe /grant ('*'+$reader.SID.Value+':(R,W)') /Q | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Access report permission failed'}
 Stop-ScheduledTask -TaskName $name
 $changed=$true
 Copy-Item -LiteralPath $source -Destination $active -Force
 Copy-Item -LiteralPath $sourceEvidence -Destination $activeEvidence -Force
 Copy-Item -LiteralPath $sourceLayout -Destination $activeLayout -Force
 if((Get-FileHash -LiteralPath $activeLayout -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $sourceLayout -Algorithm SHA256).Hash){throw 'Layout module hash mismatch'}
 if((Get-FileHash -LiteralPath $activeEvidence -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $sourceEvidence -Algorithm SHA256).Hash){throw 'Evidence module hash mismatch'}
 if((Get-FileHash -LiteralPath $active -Algorithm SHA256).Hash -ne $expectedHash){throw 'Installed script hash mismatch'}
 $settings | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $config -Encoding utf8
 Start-ScheduledTask -TaskName $name
 $healthy=$false
 for($attempt=0;$attempt -lt 15;$attempt++){
  Start-Sleep -Seconds 1
  try {
   $access=Get-Content -LiteralPath $probe -Raw | ConvertFrom-Json
   if($access.archive_readable -and $access.archive_read_only -and $access.private_paths_denied -and $access.images_readable -and (Invoke-RestMethod -Uri 'http://127.0.0.1:18451/health' -TimeoutSec 2).status -eq 'ok'){$healthy=$true;break}
  } catch {}
 }
 if(-not $healthy){throw 'Updated viewer failed its startup access/health checks'}
 if((Export-ScheduledTask -TaskName $name) -ne $definition){throw 'Registered task changed unexpectedly'}
 @{status='updated';script=$active;source=$source;sha256=$expectedHash;health=$true;access=$access;task_preserved=$true;backup=$backup} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $report -Encoding utf8
} catch {
 $result=@{status='failed';error=[string]$_.Exception.Message;restored=$false}
 if($changed){
  try {
   Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
   Copy-Item -LiteralPath $backup -Destination $active -Force
   if(Test-Path -LiteralPath $evidenceBackup){Copy-Item -LiteralPath $evidenceBackup -Destination $activeEvidence -Force}
   if(Test-Path -LiteralPath $layoutBackup){Copy-Item -LiteralPath $layoutBackup -Destination $activeLayout -Force}
   Copy-Item -LiteralPath $configBackup -Destination $config -Force
   Start-ScheduledTask -TaskName $name
   $result.restored=$true
  } catch {$result.restore_error=[string]$_.Exception.Message}
 } else {Start-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue}
 $result | ConvertTo-Json | Set-Content -LiteralPath $report -Encoding utf8
 throw
}
