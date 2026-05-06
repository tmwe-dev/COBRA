// modules/security/body-parser.js — Body size limiter
// Source: server.js lines 1035-1047

const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB

function readBodyWithLimit(req, maxBytes = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Payload too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

module.exports = { MAX_BODY_SIZE, readBodyWithLimit };
