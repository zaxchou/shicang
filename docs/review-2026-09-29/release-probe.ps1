# Isolated release check. Run from project root. Writes only a fresh OS-temp fixture.
$original = (Get-Location).Path
$tempProject = Join-Path ([IO.Path]::GetTempPath()) ('myinfobase-review-release-' + [guid]::NewGuid().ToString('N'))
foreach($sub in @('scripts','deploy','dist/server','dist/web','server')) {
  New-Item -ItemType Directory -Path (Join-Path $tempProject $sub) -Force | Out-Null
}
Copy-Item -LiteralPath (Join-Path $original 'scripts/release.ps1') -Destination (Join-Path $tempProject 'scripts/release.ps1')
Copy-Item -LiteralPath (Join-Path $original 'deploy/Dockerfile') -Destination (Join-Path $tempProject 'deploy/Dockerfile')
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $tempProject 'package.json'),'{"name":"review-fixture","version": "9.9.9","engines":{"node":">=22"}}',$utf8)
[IO.File]::WriteAllText((Join-Path $tempProject 'package-lock.json'),'{"version": "9.9.9","packages":{"":{"version": "9.9.9"}}}',$utf8)
[IO.File]::WriteAllText((Join-Path $tempProject 'dist/server/index.js'),'// OLD_BUILD_SENTINEL',$utf8)
[IO.File]::WriteAllText((Join-Path $tempProject 'dist/web/index.html'),'<p>OLD_BUILD_SENTINEL</p>',$utf8)
[IO.File]::WriteAllText((Join-Path $tempProject 'server/index.ts'),'// NEW_SOURCE_SENTINEL',$utf8)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tempProject 'scripts/release.ps1') -SkipChecks
$rc = $LASTEXITCODE
[pscustomobject]@{
 ExitCode=$rc
 PublishedVersion=(Get-Content -LiteralPath (Join-Path $tempProject 'releases/9.9.9/VERSION'))
 PackedBuild=(Get-Content -LiteralPath (Join-Path $tempProject 'releases/9.9.9/dist/server/index.js'))
 CurrentSource=(Get-Content -LiteralPath (Join-Path $tempProject 'server/index.ts'))
 Fixture=$tempProject
} | ConvertTo-Json
exit $rc