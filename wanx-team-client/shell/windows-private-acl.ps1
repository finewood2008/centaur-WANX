param(
  [Parameter(Mandatory = $true)][string]$Path,
  [ValidateSet('Protect', 'Verify')][string]$Mode = 'Protect'
)
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($Path)
if ($target.StartsWith('\\')) { throw 'LOCAL_PATH_REQUIRED' }
$root = [IO.Path]::GetPathRoot($target)
$drive = [IO.DriveInfo]::new($root)
if (-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { throw 'NTFS_REQUIRED' }
$cursor = $target
while (-not [IO.Directory]::Exists($cursor)) { throw 'DIRECTORY_REQUIRED' }
while ($cursor) {
  if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_POINT_REJECTED' }
  $parent = [IO.Path]::GetDirectoryName($cursor)
  if (-not $parent -or $parent -eq $cursor) { break }
  $cursor = $parent
}
$sids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
$fullControl = [long][Security.AccessControl.FileSystemRights]::FullControl
function New-Acl([bool]$IsDirectory) {
  $acl = if ($IsDirectory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $sids) {
    $id = [Security.Principal.SecurityIdentifier]::new($sid)
    if ($IsDirectory) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($id, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($id, 'FullControl', 'Allow')
    }
    [void]$acl.AddAccessRule($rule)
  }
  return $acl
}
$queue = [Collections.Generic.Queue[IO.FileSystemInfo]]::new()
$queue.Enqueue([IO.DirectoryInfo]::new($target))
while ($queue.Count -gt 0) {
  $item = $queue.Dequeue()
  $item.Refresh()
  if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ITEM_INVALID' }
  $directory = ($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0
  if ($Mode -eq 'Protect') { $item.SetAccessControl((New-Acl $directory)) }
  $actual = $item.GetAccessControl()
  # Electron may create files after the root is protected. Those children
  # inherit only the root's trusted rules and need not disable inheritance.
  if ($item.FullName -eq $target -and -not $actual.AreAccessRulesProtected) { throw 'ACL_NOT_PROTECTED' }
  $owner = $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($sids -notcontains $owner) { throw 'OWNER_INVALID' }
  $found = @{}
  foreach ($rule in @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      if ($sids -notcontains $sid) { throw 'UNTRUSTED_ACCESS' }
      if (([long]$rule.FileSystemRights -band $fullControl) -eq $fullControl) { $found[$sid] = $true }
    }
  }
  foreach ($sid in $sids) { if (-not $found.ContainsKey($sid)) { throw 'TRUSTED_RULE_MISSING' } }
  if ($directory) {
    foreach ($child in ([IO.DirectoryInfo]$item).EnumerateFileSystemInfos()) { $queue.Enqueue($child) }
  }
}
