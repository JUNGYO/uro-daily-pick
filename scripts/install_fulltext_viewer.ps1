param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$ReleasePath,
  [Parameter(Mandatory=$true)][string]$PythonPath,
  [Parameter(Mandatory=$true)][string]$ConfigPath
)
# Run once as administrator. Installs no runtime/model and never configures Funnel.
$ErrorActionPreference = 'Stop'
$readerName = 'UroDailyPickReader'
$readerTask = 'UroDailyPick-Original-Viewer'
$readerRoot = [IO.Path]::GetFullPath($InstallRoot)
$readerRelease = [IO.Path]::GetFullPath($ReleasePath)
$readerConfigFile = [IO.Path]::GetFullPath($ConfigPath)
if (-not $readerRelease.StartsWith($readerRoot + '\releases\') -or $readerConfigFile -ne (Join-Path $readerRoot 'config.json')) {
  throw 'Unexpected viewer installation paths'
}
$readerResult = Join-Path $readerRoot 'installation-result.json'
$readerStage = 'validate'
try {
  if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) {
    throw 'Administrator approval is required to create the dedicated service identity'
  }
  $readerConfig = Get-Content -LiteralPath $readerConfigFile -Raw -Encoding utf8 | ConvertFrom-Json
  if ($readerConfig.port -ne 18451 -or $readerConfig.origin -ne 'https://jungyo.github.io') { throw 'Unexpected viewer configuration' }
  $readerScript = Join-Path $readerRelease 'fulltext_viewer.py'
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'viewer_account_rights.ps1') -PathType Leaf)) {
    throw 'The viewer batch-logon helper must be staged beside the installer'
  }
  & $PythonPath -I -B $readerScript --config $readerConfigFile --check
  if ($LASTEXITCODE -ne 0) { throw 'Viewer configuration check failed' }
  $readerExisting = Get-LocalUser -Name $readerName -ErrorAction SilentlyContinue
  if ($readerExisting) { throw 'Dedicated account already exists; inspect before updating' }
  if (Get-ScheduledTask -TaskName $readerTask -ErrorAction SilentlyContinue) { throw 'Viewer task already exists' }
  $readerStage = 'identity'
  $readerRandom = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($readerRandom)
  $readerPassword = [Convert]::ToBase64String($readerRandom) + '!aA1'
  $readerSecure = ConvertTo-SecureString $readerPassword -AsPlainText -Force
  $readerUser = New-LocalUser -Name $readerName -Password $readerSecure -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description 'Read-only Uro Daily Pick article server'
  $readerSid = $readerUser.SID.Value
  # No administrator membership. Grant only the runtime and article/config directories.
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $readerUser -ErrorAction SilentlyContinue
  $readerStage = 'batch-logon'
  . (Join-Path $PSScriptRoot 'viewer_account_rights.ps1')
  Enable-ViewerBatchLogon -Sid $readerSid | Out-Null
  $readerStage = 'read-only-access'
  foreach ($readerDirectory in @($readerRelease, (Join-Path $readerConfig.state_dir 'documents'), (Join-Path $readerConfig.state_dir 'cloud-archive'))) {
    $readerResolved = (Resolve-Path -LiteralPath $readerDirectory).Path
    & icacls.exe $readerResolved /grant ('*' + $readerSid + ':(OI)(CI)(RX)') /Q
    if ($LASTEXITCODE -ne 0) { throw 'Read-only archive permission failed' }
  }
  & icacls.exe $readerConfigFile /grant ('*' + $readerSid + ':(R)') /Q
  if ($LASTEXITCODE -ne 0) { throw 'Configuration permission failed' }
  foreach ($readerParent in @($readerRoot, $readerConfig.state_dir)) {
    & icacls.exe $readerParent /grant ('*' + $readerSid + ':(RX)') /Q
    if ($LASTEXITCODE -ne 0) { throw 'Archive traversal permission failed' }
  }
  # Denies apply only to this newly created identity. Existing users retain their ACLs.
  foreach ($readerProtected in $readerConfig.protected_paths) {
    $readerResolved = (Resolve-Path -LiteralPath $readerProtected).Path
    if ($readerResolved.Length -lt 5 -or $readerRoot.StartsWith($readerResolved + '\')) { throw 'Invalid protected path' }
    & icacls.exe $readerResolved /deny ('*' + $readerSid + ':(OI)(CI)(F)') /Q
    if ($LASTEXITCODE -ne 0) { throw 'Private workspace protection failed' }
  }
  $readerStage = 'verify-identity-permissions'
  $readerProbe = Join-Path $readerRoot 'access-check.json'
  '{}' | Set-Content -LiteralPath $readerProbe -Encoding utf8
  & icacls.exe $readerProbe /grant ('*' + $readerSid + ':(R,W)') /Q
  if ($LASTEXITCODE -ne 0) { throw 'Verification report permission failed' }
  $readerCredential = [pscredential]::new(('.\' + $readerName), $readerSecure)
  $readerCheck = Start-Process -FilePath $PythonPath -ArgumentList @('-I','-B',('"' + $readerScript + '"'),'--config',('"' + $readerConfigFile + '"'),'--access-report',('"' + $readerProbe + '"')) -WorkingDirectory $readerRelease -Credential $readerCredential -WindowStyle Hidden -PassThru -Wait
  if ($readerCheck.ExitCode -ne 0) { throw 'Dedicated identity failed access checks; no public server was started' }
  $readerChecks = Get-Content -LiteralPath $readerProbe -Raw | ConvertFrom-Json
  if (-not ($readerChecks.archive_readable -and $readerChecks.archive_read_only -and $readerChecks.private_paths_denied)) { throw 'Incomplete identity verification' }
  $readerStage = 'task'
  $readerPythonWindowless = Join-Path (Split-Path -Parent $PythonPath) 'pythonw.exe'
  $readerAction = New-ScheduledTaskAction -Execute $readerPythonWindowless -Argument ('-I -B "' + $readerScript + '" --config "' + $readerConfigFile + '"') -WorkingDirectory $readerRelease
  $readerTriggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)))
  $readerSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $readerPrincipal = New-ScheduledTaskPrincipal -UserId $readerName -LogonType Password -RunLevel Limited
  $readerDefinition = New-ScheduledTask -Action $readerAction -Trigger $readerTriggers -Settings $readerSettings -Principal $readerPrincipal -Description 'Read-only original article API; requires the existing verified service account. Loopback only.'
  Register-ScheduledTask -TaskName $readerTask -InputObject $readerDefinition -User $readerName -Password $readerPassword | Out-Null
  $readerPassword = $null
  Start-ScheduledTask -TaskName $readerTask
  $readerStage = 'health'
  $readerHealthy = $false
  for ($readerAttempt=0; $readerAttempt -lt 10; $readerAttempt++) {
    try {
      $readerHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:18451/health' -TimeoutSec 2
      if ($readerHealth.status -eq 'ok') { $readerHealthy=$true; break }
    } catch {}
    Start-Sleep -Seconds 2
  }
  if (-not $readerHealthy) { throw 'Viewer task registered but did not start; inspect the task result before enabling public access' }
  @{status='installed';task=$readerTask;identity=$readerSid;release=$readerRelease} | ConvertTo-Json | Set-Content -LiteralPath $readerResult -Encoding utf8
} catch {
  @{status='failed';stage=$readerStage;message=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $readerResult -Encoding utf8
  throw
} finally {
  $readerPassword = $null
  $readerSecure = $null
}
