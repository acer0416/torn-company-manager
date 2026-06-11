$bytes = [System.IO.File]::ReadAllBytes('.\TrainingManager.exe')
$text = [System.Text.Encoding]::UTF8.GetString($bytes)

Write-Host '========================================'
Write-Host '=== PYTHON MODULES (dotted names) ==='
Write-Host '========================================'
$utf8strings = [regex]::Matches($text, '[\x20-\x7E]{4,}') | ForEach-Object { $_.Value }
$pyModules = $utf8strings | Where-Object { $_ -match '^\w+(\.\w+)+$' } | Sort-Object -Unique | Select-Object -First 150
$pyModules

Write-Host ''
Write-Host '========================================'
Write-Host '=== TKINTER / GUI REFERENCES ==='
Write-Host '========================================'
$gui = $utf8strings | Where-Object { $_ -match 'tkinter|Tkinter|Toplevel|Frame|Canvas|Button|Label|Entry|Text|Scrollbar|Menu|Notebook|treeview|ttk|MessageBox|askstring|askinteger' }
$gui | Sort-Object -Unique | Select-Object -First 30

Write-Host ''
Write-Host '========================================'
Write-Host '=== REQUESTS / HTTP / NETWORK ==='
Write-Host '========================================'
$http = $utf8strings | Where-Object { $_ -match 'requests\.|urllib|aiohttp|httpx|Session|beautifulsoup|selenium|playwright|socket|websocket' }
$http | Sort-Object -Unique | Select-Object -First 30

Write-Host ''
Write-Host '========================================'
Write-Host '=== APPLICATION-SPECIFIC STRINGS ==='
Write-Host '========================================'
$appStrings = $utf8strings | Where-Object { $_ -match '(?i)torn|company|employee|stat|energy|happy|nerve|faction|attack|defend|hospital|jail|bazaar|market|trade|inventory|loadout|boost|applicant|networth|respect' }
$appStrings | Sort-Object -Unique | Select-Object -First 100

Write-Host ''
Write-Host '========================================'
Write-Host '=== DATABASE / STORAGE ==='
Write-Host '========================================'
$db = $utf8strings | Where-Object { $_ -match 'sqlite|database|\.db|pymongo|redis|peewee|sqlalchemy|mysql|postgres|pickle|shelve|json\.dump|json\.load|openpyxl|xlsxwriter|pandas|csv' }
$db | Sort-Object -Unique | Select-Object -First 30

Write-Host ''
Write-Host '========================================'
Write-Host '=== SCHEDULING / AUTOMATION ==='
Write-Host '========================================'
$sched = $utf8strings | Where-Object { $_ -match 'schedule|cron|timer|interval|threading|asyncio|subprocess|os\.system|multiprocessing|concurrent' }
$sched | Sort-Object -Unique | Select-Object -First 30

Write-Host ''
Write-Host '========================================'
Write-Host '=== CRYPTO / AUTH ==='
Write-Host '========================================'
$crypto = $utf8strings | Where-Object { $_ -match 'hashlib|hmac|jwt|oauth|bearer|encrypt|decrypt|ssl|tls|certificate|secret|apikey|api_key|api-key|Authorization' }
$crypto | Sort-Object -Unique | Select-Object -First 30

Write-Host ''
Write-Host '========================================'
Write-Host '=== ALL PYTHON MODULES (comprehensive) ==='
Write-Host '========================================'
$allModules = $utf8strings | Where-Object { $_ -match '^(tkinter|json|os|sys|re|time|datetime|logging|pathlib|shutil|argparse|configparser|typing|collections|functools|itertools|copy|math|random|hashlib|base64|urllib|http|email|html|xml|csv|zipfile|tarfile|gzip|sqlite3|threading|multiprocessing|subprocess|socket|ssl|select|signal|struct|array|io|abc|enum|dataclasses|contextlib|warnings|traceback|inspect|unittest|pdb|profile|cProfile)' }
$allModules | Sort-Object -Unique | Select-Object -First 50

Write-Host ''
Write-Host '========================================'
Write-Host '=== TRAINING-SPECIFIC LOGIC STRINGS ==='
Write-Host '========================================'
$trainLogic = $utf8strings | Where-Object { $_ -match '(?i)train_|_train|training_|_training|trainee|trainer|work_stat|battle_stat|manual|train_x|train_str|train_def|train_dex|train_spd|happy_bonus|energy_cost|train_cost' }
$trainLogic | Sort-Object -Unique | Select-Object -First 50

Write-Host ''
Write-Host '========================================'
Write-Host '=== WINDOW/DIALOG CLASS NAMES ==='
Write-Host '========================================'
$winClasses = $utf8strings | Where-Object { $_ -match '(?i)(Window|Dialog|Panel|Form|View|Controller|Manager|Service|Client|Worker|Bot|Engine|Core|Handler|Processor)$' }
$winClasses | Sort-Object -Unique | Select-Object -First 50
