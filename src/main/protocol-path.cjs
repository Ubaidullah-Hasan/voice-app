const path = require('node:path');

function resolveAppPath(root, requestURL) {
  const url = new URL(requestURL);
  if (url.protocol !== 'app:' || url.hostname !== 'root' || url.port || url.username || url.password) {
    throw new Error('Invalid app origin');
  }
  const decoded = decodeURIComponent(url.pathname);
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) {
    throw new Error('Invalid app path');
  }
  const resolved = path.resolve(root, '.' + decoded);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Path outside application');
  }
  if (!['src/renderer/', 'assets/', 'runtime/'].some(prefix => relative.split(path.sep).join('/').startsWith(prefix))) {
    throw new Error('Private application path');
  }
  return resolved;
}
module.exports = { resolveAppPath };
