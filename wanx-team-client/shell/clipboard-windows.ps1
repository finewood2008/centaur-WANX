param([ValidateSet('read','write')][string]$Action)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
try {
    if ($Action -eq 'read') {
        $paths = @()
        if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
            $paths = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string]$_ })
        }
        $virtual = $paths.Count -eq 0 -and ([System.Windows.Forms.Clipboard]::ContainsData('FileGroupDescriptorW') -or [System.Windows.Forms.Clipboard]::ContainsData('FileContents'))
        @{paths=$paths;virtual=$virtual} | ConvertTo-Json -Compress
    } else {
        $inputPaths = @(ConvertFrom-Json ([Console]::In.ReadToEnd()))
        if ($inputPaths.Count -eq 0 -or $inputPaths.Count -gt 20) { throw 'invalid' }
        $list = New-Object System.Collections.Specialized.StringCollection
        foreach ($item in $inputPaths) {
            if (-not [System.IO.File]::Exists($item)) { throw 'missing' }
            [void]$list.Add([string]$item)
        }
        [System.Windows.Forms.Clipboard]::SetFileDropList($list)
        @{copied=$true} | ConvertTo-Json -Compress
    }
} catch { [Console]::Error.Write('CLIPBOARD_NATIVE_FAILED'); exit 1 }
