$bytes = [System.IO.File]::ReadAllBytes('.\TrainingManager.exe')

Write-Host '========================================'
Write-Host '=== obfuscated module names (short random) ==='
Write-Host '========================================'
$text = [System.Text.Encoding]::ASCII.GetString($bytes)
$strings = [regex]::Matches($text, '[\x20-\x7E]{6,}') | ForEach-Object { $_.Value }

# Look for the "trainer)" string specifically
Write-Host ''
Write-Host '=== trainer context ==='
$strings | Where-Object { $_ -match 'trainer' } | ForEach-Object { $_ }

Write-Host ''
Write-Host '=== pyinstaller _internal content ==='
$strings | Where-Object { $_ -match '_internal|_internal/|_internal\\' } | Sort-Object -Unique | Select-Object -First 20

Write-Host ''
Write-Host '=== .pyd files (compiled Python extensions) ==='
$strings | Where-Object { $_ -match '\.pyd' } | Sort-Object -Unique

Write-Host ''
Write-Host '=== .so / .dll files ==='
$strings | Where-Object { $_ -match '\.so$|\.dll$|\.dylib$' } | Sort-Object -Unique | Select-Object -First 30

Write-Host ''
Write-Host '=== base_library.zip contents ==='
$strings | Where-Object { $_ -match 'base_library' } | Sort-Object -Unique

Write-Host ''
Write-Host '=== PE section names ==='
$peOffset = [BitConverter]::ToUInt32($bytes, 0x3C)
$numSections = [BitConverter]::ToUInt16($bytes, [int]$peOffset + 6)
$sectionHeaderStart = [int]$peOffset + 24 + [BitConverter]::ToUInt16($bytes, [int]$peOffset + 20)
Write-Host "Number of sections: $numSections"
for ($i = 0; $i -lt $numSections; $i++) {
    $offset = $sectionHeaderStart + ($i * 40)
    $nameBytes = $bytes[$offset..($offset + 7)]
    $name = [System.Text.Encoding]::ASCII.GetString($nameBytes).Trim([char]0)
    $virtualSize = [BitConverter]::ToUInt32($bytes, $offset + 8)
    $rawSize = [BitConverter]::ToUInt32($bytes, $offset + 16)
    Write-Host "  Section '$name': VirtualSize=$virtualSize, RawSize=$rawSize"
}

Write-Host ''
Write-Host '=== Import DLLs ==='
# Search for common DLL names
$strings | Where-Object { $_ -match '\.dll$' -and $_ -notmatch '^b' -and $_ -notmatch 'api-ms' } | Sort-Object -Unique | Select-Object -First 30
