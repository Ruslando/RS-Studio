import assert from 'node:assert/strict';
import { zoneFrameEdge } from '../../web/zone-frame.js';

const frame = { x: 20, y: 30, width: 80, height: 40 };
assert.equal(zoneFrameEdge(frame, 20, 30), 'tl');
assert.equal(zoneFrameEdge(frame, 100, 70), 'br');
assert.equal(zoneFrameEdge(frame, 60, 30), 't');
assert.equal(zoneFrameEdge(frame, 20, 50), 'l');
assert.equal(zoneFrameEdge(frame, 60, 50), '');
assert.equal(zoneFrameEdge(frame, 10, 50), '', 'points outside the common hover tolerance do not light a zone');
console.log('Zone frame hover edges passed');
