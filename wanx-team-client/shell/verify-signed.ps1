param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true, ParameterSetName='single')][string]$PublisherName,
  [Parameter(Mandatory=$true, ParameterSetName='multiple')][string]$PublisherNamesJson
)
$ErrorActionPreference = 'Stop'
$publishers = if ($PSCmdlet.ParameterSetName -eq 'multiple') { @(ConvertFrom-Json -InputObject $PublisherNamesJson) } else { @($PublisherName) }
if ($publishers.Count -eq 0) { throw 'WINDOWS_SIGNATURE_PUBLISHER_REQUIRED' }
foreach ($publisher in $publishers) {
  if ($publisher -isnot [string] -or [string]::IsNullOrWhiteSpace($publisher)) { throw 'WINDOWS_SIGNATURE_PUBLISHER_REQUIRED' }
}
$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
  throw 'WINDOWS_SIGNATURE_INVALID'
}
$certificate = $signature.SignerCertificate
$commonName = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
$matchesPublisher = $false
foreach ($publisher in $publishers) {
  if ($publisher -ceq $commonName -or $publisher -ceq $certificate.Subject) { $matchesPublisher = $true }
}
if (-not $matchesPublisher) {
  throw 'WINDOWS_SIGNATURE_PUBLISHER_MISMATCH'
}
if ($null -eq $signature.TimeStamperCertificate) {
  throw 'WINDOWS_SIGNATURE_TIMESTAMP_REQUIRED'
}
Write-Output 'WINDOWS_SIGNATURE_VERIFIED'
