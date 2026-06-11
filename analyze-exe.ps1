$ExePath = '.\TrainingManager.exe'

Write-Host '========================================'
Write-Host '=== 1. FILE METADATA ==='
Write-Host '========================================'
Get-Item $ExePath | Select-Object Name, Length, CreationTime, LastWriteTime, LastAccessTime | Format-List

Write-Host '========================================'
Write-Host '=== 2. VERSION INFO ==='
Write-Host '========================================'
try {
    Get-Item $ExePath | Select-Object -ExpandProperty VersionInfo | Format-List *
} catch {
    Write-Host 'No version info available'
}

Write-Host '========================================'
Write-Host '=== 3. .NET ASSEMBLY CHECK ==='
Write-Host '========================================'
try {
    $fullPath = (Resolve-Path $ExePath).Path
    [System.Reflection.Assembly]::LoadFile($fullPath)
    Write-Host 'It IS a .NET assembly'
} catch {
    Write-Host "Not a .NET assembly: $($_.Exception.Message)"
}

Write-Host '========================================'
Write-Host '=== 4. PE HEADER INFO ==='
Write-Host '========================================'
$bytes = [System.IO.File]::ReadAllBytes($ExePath)
$peOffset = [BitConverter]::ToUInt32($bytes, 0x3C)
$subsystem = [BitConverter]::ToUInt16($bytes, [int]$peOffset + 0x5C)
$magic = [BitConverter]::ToUInt16($bytes, [int]$peOffset + 0x18)
$machine = [BitConverter]::ToUInt16($bytes, [int]$peOffset + 4)

$subsystemName = switch ($subsystem) { 2 {'GUI (Windows)'} 3 {'Console'} default {"Unknown ($subsystem)"} }
$magicName = switch ($magic) { 0x10B {'PE32 (32-bit)'} 0x20B {'PE32+ (64-bit)'} default {"Unknown ($magic)"} }
$machineName = switch ($machine) { 0x14C {'x86 (32-bit)'} 0x8664 {'x64 (64-bit)'} default {"Unknown ($machine)"} }

Write-Host "Subsystem: $subsystem - $subsystemName"
Write-Host "PE Magic: $magic - $magicName"
Write-Host "Machine: $machine - $machineName"
Write-Host "PE Offset: 0x$($peOffset.ToString('X'))"

Write-Host '========================================'
Write-Host '=== 5. EXTRACTED ASCII STRINGS (first 300) ==='
Write-Host '========================================'
$text = [System.Text.Encoding]::ASCII.GetString($bytes)
$strings = [regex]::Matches($text, '[\x20-\x7E]{6,}') | ForEach-Object { $_.Value }
Write-Host "Total strings found: $($strings.Count)"
Write-Host ''
$strings | Select-Object -First 300 | ForEach-Object { $_ }

Write-Host '========================================'
Write-Host '=== 6. URLS AND ENDPOINTS ==='
Write-Host '========================================'
$utf8text = [System.Text.Encoding]::UTF8.GetString($bytes)
$urls = [regex]::Matches($utf8text, 'https?://[^\x00-\x1F\x7F]{5,}') | ForEach-Object { $_.Value }
if ($urls) {
    $urls | Sort-Object -Unique
} else {
    Write-Host 'No URLs found'
}

Write-Host '========================================'
Write-Host '=== 7. TORN/GAME RELATED STRINGS ==='
Write-Host '========================================'
$relevant = $strings | Where-Object { $_ -match 'torn|api|train|company|employee|manager|key|token|http|login|password|faction|money|stats|level|player' }
if ($relevant) {
    $relevant | Sort-Object -Unique
} else {
    Write-Host 'No Torn-related strings found'
}

Write-Host '========================================'
Write-Host '=== 8. FILE EXTENSION REFERENCES ==='
Write-Host '========================================'
$fileRefs = $strings | Where-Object { $_ -match '\.(exe|dll|json|xml|config|ini|txt|log|csv|db|sqlite|html|js|css|py|cs|cpp|h)' }
if ($fileRefs) {
    $fileRefs | Sort-Object -Unique | Select-Object -First 50
} else {
    Write-Host 'No file extension references found'
}

Write-Host '========================================'
Write-Host '=== 9. CLASS/NAMESPACE HINTS ==='
Write-Host '========================================'
$classHints = $strings | Where-Object { $_ -match '(class|namespace|function|method|module|import|require|from|const|var|let)\s' }
if ($classHints) {
    $classHints | Sort-Object -Unique | Select-Object -First 50
} else {
    Write-Host 'No class/namespace hints found'
}

Write-Host '========================================'
Write-Host '=== 10. POTENTIAL ERROR/STATUS MESSAGES ==='
Write-Host '========================================'
$msgs = $strings | Where-Object { $_ -match '(error|fail|success|warning|unable|cannot|could not|invalid|missing|not found|denied|exception|crash)' }
if ($msgs) {
    $msgs | Sort-Object -Unique | Select-Object -First 50
} else {
    Write-Host 'No error/status messages found'
}

Write-Host '========================================'
Write-Host '=== ANALYSIS COMPLETE ==='
Write-Host '========================================'
