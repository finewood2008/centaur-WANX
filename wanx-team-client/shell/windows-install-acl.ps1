param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Preflight', 'ProtectTree', 'VerifyTree')]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'
$writeRights = 2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor 524288 -bor 0x10000000 -bor 0x40000000
$fullControl = [long][Security.AccessControl.FileSystemRights]::FullControl
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$currentSid = $currentIdentity.Value
$trustedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
$acceptedOwners = @($currentSid, 'S-1-5-18', 'S-1-5-32-544',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')

function Stop-WithCode([int]$Code, [string]$Reason) {
  [Console]::Error.WriteLine("WANX_INSTALL_ACL_FAILED|$Code|$Reason")
  exit $Code
}

function Get-SupportedPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { Stop-WithCode 10 'PATH_REQUIRED' }
  $full = [IO.Path]::GetFullPath($Value)
  if ($full.StartsWith('\\')) { Stop-WithCode 11 'LOCAL_PATH_REQUIRED' }
  $root = [IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrWhiteSpace($root)) { Stop-WithCode 11 'LOCAL_PATH_REQUIRED' }
  $drive = [IO.DriveInfo]::new($root)
  if (-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed) { Stop-WithCode 12 'FIXED_DRIVE_REQUIRED' }
  if ($drive.DriveFormat -ne 'NTFS') { Stop-WithCode 13 'NTFS_REQUIRED' }

  $cursor = $full
  while (-not [IO.Directory]::Exists($cursor)) {
    if ([IO.File]::Exists($cursor)) { Stop-WithCode 14 'DIRECTORY_REQUIRED' }
    $next = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrWhiteSpace($next) -or $next -eq $cursor) { Stop-WithCode 14 'DIRECTORY_REQUIRED' }
    $cursor = $next
  }
  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Stop-WithCode 15 'REPARSE_POINT_REJECTED'
    }
    if ($cursor -eq $root.TrimEnd('\')) { break }
    $next = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrWhiteSpace($next) -or $next -eq $cursor) { break }
    $cursor = $next
  }
  return $full.TrimEnd('\')
}

function New-PrivateAcl([bool]$Directory) {
  $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sidValue in $trustedSids) {
    $identity = [Security.Principal.SecurityIdentifier]::new($sidValue)
    if ($Directory) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl',
        'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow')
    }
    [void]$acl.AddAccessRule($rule)
  }
  return $acl
}

function Assert-EffectiveAcl([IO.FileSystemInfo]$Item, [bool]$RequireProtection) {
  $Item.Refresh()
  if (-not $Item.Exists -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Stop-WithCode 20 'ITEM_INVALID'
  }
  $acl = $Item.GetAccessControl()
  # Only the protected root disables inheritance; every child is expected to
  # inherit that root's rules instead of carrying its own explicit ACL.
  if ($RequireProtection -and -not $acl.AreAccessRulesProtected) { Stop-WithCode 21 'INHERITANCE_ENABLED' }
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($acceptedOwners -notcontains $owner) { Stop-WithCode 22 'OWNER_INVALID' }
  $found = @{}
  foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
    $sidValue = $rule.IdentityReference.Value
    $rights = [long]$rule.FileSystemRights
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      if (($rights -band $writeRights) -ne 0 -and $acceptedOwners -notcontains $sidValue) {
        Stop-WithCode 23 'UNTRUSTED_WRITER'
      }
      if ($trustedSids -contains $sidValue -and ($rights -band $fullControl) -eq $fullControl) { $found[$sidValue] = $true }
    }
  }
  foreach ($sidValue in $trustedSids) {
    if (-not $found.ContainsKey($sidValue)) { Stop-WithCode 24 'TRUSTED_RULE_MISSING' }
  }
}

function Protect-Root([string]$Root) {
  $item = [IO.DirectoryInfo]::new($Root)
  if (-not $item.Exists) { Stop-WithCode 16 'INSTALL_DIRECTORY_MISSING' }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-WithCode 15 'REPARSE_POINT_REJECTED' }
  # A single protected root DACL with inheritable rules is enforced by Windows
  # for the whole tree, which avoids rewriting ~24k individual ACLs per install.
  $item.SetAccessControl((New-PrivateAcl $true))
  Assert-EffectiveAcl $item $true
}

function Assert-EffectiveTree([string]$Root) {
  $rootItem = [IO.DirectoryInfo]::new($Root)
  if (-not $rootItem.Exists) { Stop-WithCode 16 'INSTALL_DIRECTORY_MISSING' }
  Assert-EffectiveAcl $rootItem $true
  $queue = [Collections.Generic.Queue[IO.DirectoryInfo]]::new()
  $queue.Enqueue($rootItem)
  $count = 1
  while ($queue.Count -gt 0) {
    $directory = $queue.Dequeue()
    foreach ($entry in $directory.EnumerateFileSystemInfos()) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-WithCode 15 'REPARSE_POINT_REJECTED' }
      $isDirectory = ($entry.Attributes -band [IO.FileAttributes]::Directory) -ne 0
      Assert-EffectiveAcl $entry $false
      if ($isDirectory) { $queue.Enqueue([IO.DirectoryInfo]$entry) }
      $count++
    }
  }
  return $count
}

try {
  $target = Get-SupportedPath $Path
  if ($Mode -eq 'Preflight') {
    $container = $target
    while (-not [IO.Directory]::Exists($container)) { $container = [IO.Path]::GetDirectoryName($container) }
    $probe = [IO.Path]::Combine($container, '.wanx-acl-probe-' + [guid]::NewGuid().ToString('N'))
    try {
      [IO.Directory]::CreateDirectory($probe) | Out-Null
      Protect-Root $probe
    } finally {
      if ([IO.Directory]::Exists($probe)) { [IO.Directory]::Delete($probe, $true) }
    }
    [Console]::Out.Write("WANX_INSTALL_ACL_OK|$Mode|NTFS|$currentSid")
    exit 0
  }

  foreach ($relative in @('resources', 'resources\app.asar', 'WANX.exe')) {
    $required = [IO.Path]::Combine($target, $relative)
    if (-not [IO.Directory]::Exists($required) -and -not [IO.File]::Exists($required)) { Stop-WithCode 17 'REQUIRED_FILE_MISSING' }
  }
  if ($Mode -eq 'ProtectTree') {
    Protect-Root $target
    [Console]::Out.Write("WANX_INSTALL_ACL_OK|$Mode|NTFS|$currentSid|root")
    exit 0
  }
  $count = Assert-EffectiveTree $target
  [Console]::Out.Write("WANX_INSTALL_ACL_OK|$Mode|NTFS|$currentSid|$count")
  exit 0
} catch [UnauthorizedAccessException] {
  Stop-WithCode 30 'ACCESS_DENIED'
} catch [Security.SecurityException] {
  Stop-WithCode 30 'ACCESS_DENIED'
} catch {
  Stop-WithCode 31 $_.Exception.GetType().Name
}
