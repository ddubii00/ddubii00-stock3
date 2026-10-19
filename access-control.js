'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
// Default access PIN is checked on the server only. This is not a KIS credential.
const DEFAULT_PASSWORD_HASH = '16a3e9e922b41fde13be3ae377b18e08d44fb136594e7f9819ff2ac75bab5516';
const digest = (value) => createHash('sha256').update(value).digest();
function authorized(req, env = process.env) {
  const value = req?.headers?.['x-stock3-password'];
  if (typeof value !== 'string' || !value || value.length > 128) return false;
  const configured = env.STOCK3_PASSWORD || env.STOCK5_PASSWORD;
  const expected = configured ? digest(configured) : Buffer.from(DEFAULT_PASSWORD_HASH, 'hex');
  const actual = digest(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function requireAccess(req, res) {
  if (authorized(req)) return true;
  const body = JSON.stringify({ok:false,error:'접속 암호를 확인하세요.'});
  res.statusCode = 401;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(body);
  return false;
}
function requestHeaders(env = process.env) {
  return {'x-stock3-password':env.STOCK3_PASSWORD || env.STOCK5_PASSWORD || '1222'};
}
module.exports = { authorized, requireAccess, requestHeaders };
