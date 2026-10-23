param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
  throw ('UNEXPECTED_AUTHENTICODE_STATUS:' + $signature.Status)
}
