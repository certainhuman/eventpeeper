$ScriptDir = $PSScriptRoot
$SrcDir = Join-Path $ScriptDir "src"
$BuildDir = Join-Path $ScriptDir "build"

if (-not (Test-Path $SrcDir)) {
    Write-Host "Error: src directory not found at $SrcDir" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $BuildDir)) {
    New-Item -ItemType Directory -Path $BuildDir | Out-Null
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Create-Package {
    param(
        [string]$ManifestFile,
        [string]$OutputFile
    )

    Write-Host "Creating $OutputFile..." -ForegroundColor Yellow

    if (Test-Path $OutputFile) {
        Remove-Item $OutputFile -Force
    }

    Push-Location $SrcDir

    try {
        $files = Get-ChildItem -Recurse -File | Where-Object {
            $_.Name -ne "firefox.manifest.json" -and $_.Name -ne "chrome.manifest.json"
        }

        $zip = [System.IO.Compression.ZipFile]::Open($OutputFile, [System.IO.Compression.ZipArchiveMode]::Create)

        $manifestPath = Join-Path $SrcDir $ManifestFile
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $manifestPath, "manifest.json") | Out-Null
        Write-Host "  Added: manifest.json (from $ManifestFile)" -ForegroundColor Gray

        foreach ($file in $files) {
            $relativePath = $file.FullName.Substring($PWD.Path.Length + 1).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relativePath) | Out-Null
            Write-Host "  Added: $relativePath" -ForegroundColor Gray
        }

        $zip.Dispose()

        $fileSize = (Get-Item $OutputFile).Length
        $fileSizeReadable = if ($fileSize -gt 1MB) {
            "{0:N2} MB" -f ($fileSize / 1MB)
        } elseif ($fileSize -gt 1KB) {
            "{0:N2} KB" -f ($fileSize / 1KB)
        } else {
            "$fileSize bytes"
        }

        Write-Host "Successfully created: $OutputFile" -ForegroundColor Green
        Write-Host "  File size: $fileSizeReadable" -ForegroundColor Cyan

    } catch {
        Write-Host "Error creating package: $_" -ForegroundColor Red
        $zip.Dispose()
        exit 1
    } finally {
        Pop-Location
    }
}

# Package Firefox version
Write-Host ""
$XpiPath = Join-Path $BuildDir "event_peeper_firefox.xpi"
Create-Package -ManifestFile "firefox.manifest.json" -OutputFile $XpiPath

# Package Chrome version
Write-Host ""
$ZipPath = Join-Path $BuildDir "event_peeper_chrome.zip"
Create-Package -ManifestFile "chrome.manifest.json" -OutputFile $ZipPath

Write-Host ""
Write-Host "Packaging complete!" -ForegroundColor Green
Write-Host "Firefox package: $XpiPath" -ForegroundColor Cyan
Write-Host "Chrome package: $ZipPath" -ForegroundColor Cyan