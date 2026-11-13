import assert from 'node:assert/strict';
import { formatTenths, parseTenths } from '../../web/timeline-time.js';

assert.equal(formatTenths(72.1), '1:12.1');
assert.equal(formatTenths(5), '0:05.0');
assert.equal(formatTenths(59.96), '1:00.0');
for (const text of ['1:12.1', '1:12,1', '72.1', '72,1', ' 01:12.1 ']) assert.ok(Math.abs(parseTenths(text) - 72.1) < 1e-9, text);
for (const text of ['', 'abc', '1:75', '1:2:3', '-3']) assert.equal(parseTenths(text), null, text);
