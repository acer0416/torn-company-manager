$baseUrl = 'https://raw.githubusercontent.com/Belfast-1937/TornCompanyTool/main/Tools/TrainingManager'
$files = @('main.py', 'api.py', 'config.py', 'efficiency.py', 'gui.py', 'report.py', 'trainer.py', 'constants.py')

foreach ($file in $files) {
    $outName = "_train_$file"
    Write-Host "Downloading $file..."
    try {
        Invoke-WebRequest -Uri "$baseUrl/$file" -OutFile $outName -UseBasicParsing
        $size = (Get-Item $outName).Length
        Write-Host "  -> $outName ($size bytes)"
    } catch {
        Write-Host "  -> FAILED: $_"
    }
}
Write-Host 'Done!'
