const fs = require('fs');
const path = require('path');

const part = process.argv[2];
if (!['major', 'minor', 'patch'].includes(part)) {
    console.error('Usage: node scripts/bump-version.js <major|minor|patch>');
    process.exit(1);
}

const root = path.resolve(__dirname, '..');
const manifestFiles = ['src/chrome.manifest.json', 'src/firefox.manifest.json'];
const versionPattern = /"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"/;
const versions = manifestFiles.map(file => {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const match = content.match(versionPattern);
    if (!match) throw new Error(`Could not find a semantic version in ${file}`);
    return {file, content, version: match.slice(1).map(Number)};
});

const [major, minor, patch] = versions[0].version;
if (versions.some(entry => entry.version.join('.') !== [major, minor, patch].join('.'))) {
    throw new Error('Manifest versions do not match');
}

const next = {
    major: [major + 1, 0, 0],
    minor: [major, minor + 1, 0],
    patch: [major, minor, patch + 1]
}[part].join('.');

for (const entry of versions) {
    const updated = entry.content.replace(versionPattern, `"version": "${next}"`);
    fs.writeFileSync(path.join(root, entry.file), updated);
}

const popupPath = path.join(root, 'src/popup.html');
const popup = fs.readFileSync(popupPath, 'utf8');
const updatedPopup = popup.replace(/(id="versionText"[^>]*>v)\d+\.\d+\.\d+(<\/small>)/, `$1${next}$2`);
if (updatedPopup === popup) throw new Error('Could not find the popup version label');
fs.writeFileSync(popupPath, updatedPopup);

console.log(`${major}.${minor}.${patch} -> ${next}`);
