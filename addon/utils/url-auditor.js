// utils/url-auditor.js

// A list of property keys that we know are supposed to be URLs.
const URL_KEYS = ['poster', 'background', 'logo', 'thumbnail', 'photo', 'url'];

/**
 * Recursively scans an object to find any property values that are relative URLs.
 * @param {object} obj The object to scan.
 * @param {string} [path=''] The current path for logging purposes.
 */
function findRelativeUrls(obj, path = '') {
  if (!obj || typeof obj !== 'object') {
    return;
  }

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const newPath = path ? `${path}.${key}` : key;
      const value = obj[key];

      if (typeof value === 'string' && URL_KEYS.includes(key.toLowerCase())) {
        // This is a string property that we know should be a URL.
        if (value.startsWith('/')) {
          console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
          console.error('FATAL: RELATIVE URL DETECTED');
          console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
          console.error(`Path: ${newPath}`);
          console.error(`Value: "${value}"`);
        }
      } else if (typeof value === 'object') {
        // Recurse into nested objects and arrays.
        findRelativeUrls(value, newPath);
      }
    }
  }
}

module.exports = { findRelativeUrls };
