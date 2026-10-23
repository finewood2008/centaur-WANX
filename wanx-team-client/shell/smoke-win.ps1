param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Report,
  [Parameter(Mandatory = $true)][string]$InstallRoot
)
$ErrorActionPreference = 'Stop'
$installerPath = [IO.Path]::GetFullPath($Installer)
$reportPath = [IO.Path]::GetFullPath($Report)
if (-not [IO.File]::Exists($installerPath)) { throw 'INSTALLER_MISSING' }
$suffix = ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($installerPath)) | ForEach-Object { $_.ToString('x2') }) -join ''
$chineseName = ([string][char]0x4E07) + ([char]0x8C61) + ' ' + ([char]0x6D4B) + ([char]0x8BD5)
$target = [IO.Path]::Combine([IO.Path]::GetFullPath($InstallRoot), ($chineseName + '-' + $suffix.Substring(0, 8)))
$userData = [IO.Path]::Combine([IO.Path]::GetDirectoryName($reportPath), 'smoke-user-data')
if ($target.Length -gt 85 -or [IO.Directory]::Exists($target) -or [IO.Directory]::Exists($userData)) { throw 'SMOKE_PATH_UNAVAILABLE' }
[IO.Directory]::CreateDirectory($userData) | Out-Null
$result = [ordered]@{
  ok = $false; installPath = $target; installed = $false; enginePresent = $false
  aclVerified = $false; privateAclVerified = $false; safeStorageRoundTrip = $false; launched = $false
  upgraded = $false; launchedAfterUpgrade = $false; uninstalled = $false
  userDataPreserved = $false; liveBoxTested = $false
}
$app = $null
$oldUserData = $env:WANX_SMOKE_USER_DATA
try {
  $install = Start-Process -FilePath $installerPath -ArgumentList @('/S', ('/D=' + $target)) -Wait -PassThru -WindowStyle Hidden
  if ($install.ExitCode -ne 0) { throw ('INSTALL_FAILED:' + $install.ExitCode) }
  $exe = [IO.Path]::Combine($target, 'WANX.exe')
  $engine = [IO.Path]::Combine($target, 'resources', 'network', 'wanx-netbird-win32-x64.exe')
  if (-not [IO.File]::Exists($exe) -or -not [IO.File]::Exists([IO.Path]::Combine($target, 'resources', 'app.asar'))) { throw 'APP_CONTENT_MISSING' }
  if (-not [IO.File]::Exists($engine)) { throw 'ENGINE_MISSING' }
  $result.enginePresent = $true
  $aclScript = [IO.Path]::Combine($PSScriptRoot, 'windows-install-acl.ps1')
  & powershell.exe -NoLogo -NoProfile -NonInteractive -File $aclScript -Mode VerifyTree -Path $target | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'INSTALL_ACL_INVALID' }
  $result.aclVerified = $true
  $result.installed = $true

  $env:WANX_SMOKE_USER_DATA = $userData
  $dpapi = Start-Process -FilePath $exe -ArgumentList '--wanx-smoke-safe-storage' -Wait -PassThru -WindowStyle Hidden
  if ($dpapi.ExitCode -ne 0 -or -not [IO.File]::Exists([IO.Path]::Combine($userData, 'smoke-storage-ready.marker')) -or [IO.File]::Exists([IO.Path]::Combine($userData, 'smoke-account.enc'))) { throw 'SAFE_STORAGE_ROUNDTRIP_FAILED' }
  $result.safeStorageRoundTrip = $true
  $privateAclScript = [IO.Path]::Combine($target, 'resources', 'security', 'windows-private-acl.ps1')
  & powershell.exe -NoLogo -NoProfile -NonInteractive -File $privateAclScript -Path $userData -Mode Verify | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'PRIVATE_ACL_INVALID' }
  $result.privateAclVerified = $true

  $ready = [IO.Path]::Combine($userData, 'smoke-ui-ready.marker')
  if ([IO.File]::Exists($ready)) { [IO.File]::Delete($ready) }
  $app = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 7
  $app.Refresh()
  if ($app.HasExited -or -not [IO.File]::Exists($ready)) { throw 'APP_START_FAILED' }
  $result.launched = $true
  Stop-Process -Id $app.Id
  $app.WaitForExit(10000) | Out-Null
  $app = $null

  $marker = [IO.Path]::Combine($userData, 'smoke-preserve.marker')
  [IO.File]::WriteAllText($marker, 'preserve')
  $upgrade = Start-Process -FilePath $installerPath -ArgumentList @('/S', ('/D=' + $target)) -Wait -PassThru -WindowStyle Hidden
  if ($upgrade.ExitCode -ne 0 -or -not [IO.File]::Exists($exe)) { throw ('UPGRADE_FAILED:' + $upgrade.ExitCode) }
  & powershell.exe -NoLogo -NoProfile -NonInteractive -File $aclScript -Mode VerifyTree -Path $target | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($marker)) { throw 'UPGRADE_STATE_INVALID' }
  $result.upgraded = $true
  if ([IO.File]::Exists($ready)) { [IO.File]::Delete($ready) }
  $app = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 7
  $app.Refresh()
  if ($app.HasExited -or -not [IO.File]::Exists($ready)) { throw 'UPGRADED_APP_START_FAILED' }
  $result.launchedAfterUpgrade = $true
  Stop-Process -Id $app.Id
  $app.WaitForExit(10000) | Out-Null
  $app = $null

  $uninstallers = @(Get-ChildItem -LiteralPath $target -File -Filter 'Uninstall*.exe')
  if ($uninstallers.Count -ne 1) { throw 'UNINSTALLER_MISSING' }
  $uninstall = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
  if ($uninstall.ExitCode -ne 0 -or [IO.File]::Exists($exe)) { throw 'UNINSTALL_FAILED' }
  $result.uninstalled = $true
  $result.userDataPreserved = [IO.File]::Exists($marker)
  if (-not $result.userDataPreserved) { throw 'USER_DATA_REMOVED' }
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
  throw
} finally {
  $env:WANX_SMOKE_USER_DATA = $oldUserData
  if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id; $app.WaitForExit(10000) | Out-Null }
  [IO.File]::WriteAllText($reportPath, ($result | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
}
