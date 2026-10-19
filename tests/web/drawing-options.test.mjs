import assert from 'node:assert/strict';
import { normalizeTraceRange } from '../../web/drawing-options.js';
for (const value of ['1',1]) assert.equal(normalizeTraceRange(value), '1');
for (const value of ['2',2,undefined,'',NaN,-1]) assert.equal(normalizeTraceRange(value), '2');
for (const value of ['3',3,'5',5,100]) assert.equal(normalizeTraceRange(value), '3');
console.log('Drawing search range supports only ±1, ±2 and ±3');
