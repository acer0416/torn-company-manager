$bytes = [System.IO.File]::ReadAllBytes('.\TrainingManager.exe')
$text = [System.Text.Encoding]::ASCII.GetString($bytes)
$strings = [regex]::Matches($text, '[\x20-\x7E]{6,}') | ForEach-Object { $_.Value }

Write-Host '========================================'
Write-Host '=== PYINSTALLER SPECIFIC ==='
Write-Host '========================================'
$strings | Where-Object { $_ -match 'pyinstaller|_MEIPASS|MEI\w+|pkg_archive|PYI-' } | Sort-Object -Unique

Write-Host ''
Write-Host '========================================'
Write-Host '=== EMBEDDED FILE PATHS (b_ prefix = bundled) ==='
Write-Host '========================================'
$strings | Where-Object { $_ -match '^b_[a-zA-Z]' } | Sort-Object -Unique | Select-Object -First 80

Write-Host ''
Write-Host '========================================'
Write-Host '=== PYTHON DLL EMBEDDED ==='
Write-Host '========================================'
$strings | Where-Object { $_ -match 'python\d+\.dll|python\d+' } | Sort-Object -Unique

Write-Host ''
Write-Host '========================================'
Write-Host '=== TK VERSION ==='
Write-Host '========================================'
$strings | Where-Object { $_ -match '^tk\d|^tcl\d' } | Sort-Object -Unique | Select-Object -First 20

Write-Host ''
Write-Host '========================================'
Write-Host '=== GUI TOOLKIT (beyond tkinter) ==='
Write-Host '========================================'
$strings | Where-Object { $_ -match 'PyQt|PySide|wxPython|kivy|customtkinter|ttkbootstrap|flet|nicegui|streamlit|gradio|flask|django|fastapi|bottle' } | Sort-Object -Unique | Select-Object -First 20

Write-Host ''
Write-Host '========================================'
Write-Host '=== NUMPY / PANDAS / DATA SCIENCE ==='
Write-Host '========================================'
$strings | Where-Object { $_ -match 'numpy|pandas|scipy|matplotlib|seaborn|sklearn|torch|tensorflow' } | Sort-Object -Unique | Select-Object -First 20

Write-Host ''
Write-Host '========================================'
Write-Host '=== PYTHON VERSION ==='
Write-Host '========================================'
$strings | Where-Object { $_ -match 'python3\d|PYTHONPATH|PYTHONHOME|pyconfig|pyvenv' } | Sort-Object -Unique | Select-Object -First 20

Write-Host ''
Write-Host '========================================'
Write-Host '=== TORN API REGEX SCAN ==='
Write-Host '========================================'
$utf8text = [System.Text.Encoding]::UTF8.GetString($bytes)
$matches = [regex]::Matches($utf8text, '(?i)(torn[a-z]*|api[_.]?key|api[_.]?token|torn[_.]?api|torn[_.]?key)')
foreach ($m in $matches) { Write-Host "$($m.Value) at offset $($m.Index)" }

Write-Host ''
Write-Host '========================================'
Write-Host '=== STATUS TEXT / UI MESSAGES ==='
Write-Host '========================================'
$strings | Where-Object { $_ -match 'status_text|ready|loading|connecting|error|success|failed|complete|progress|idle|running|stopped|paused' } | Sort-Object -Unique | Select-Object -First 30

Write-Host ''
Write-Host '========================================'
Write-Host '=== CONFIG / SETTINGS PATTERNS ==='
Write-Host '========================================'
$strings | Where-Object { $_ -match '\.json|\.yaml|\.yml|\.toml|\.ini|\.cfg|\.conf|config|settings|\.env' } | Sort-Object -Unique | Select-Object -First 30
