set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

pack:
    ./scripts/pack.sh

pack-windows:
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/pack.ps1

bump part:
    node scripts/bump-version.js {{part}}

bump-major:
    node scripts/bump-version.js major

bump-minor:
    node scripts/bump-version.js minor

bump-patch:
    node scripts/bump-version.js patch
