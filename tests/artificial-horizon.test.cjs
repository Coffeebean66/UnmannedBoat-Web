const test = require('node:test');
const assert = require('node:assert/strict');
const { ArtificialHorizon, horizonPose, unwrapAngle, pitchOffset } =
  require('../public/artificial-horizon');

function fakeHost() {
  const document = {
    createElement: makeNode,
    createElementNS: (_namespace, name) => makeNode(name)
  };
  function makeNode(name) {
    return { name, ownerDocument: document, attributes: {}, children: [],
      classList: { add() {} },
      setAttribute(key, value) { this.attributes[key] = value; },
      appendChild(node) { this.children.push(node); return node; } };
  }
  return makeNode('div');
}

test('horizon accepts only fresh, finite raw Euler angles', () => {
  assert.deepEqual(horizonPose({ eulerFresh: true, rollDegrees: 12, pitchDegrees: -6 }),
    { roll: 12, pitch: -6 });
  for (const view of [null, { eulerFresh: false, rollDegrees: 12, pitchDegrees: -6 },
    { eulerFresh: true, roll: '0.00', pitch: '0.00' },
    { eulerFresh: true, rollDegrees: '--', pitchDegrees: 0 },
    { eulerFresh: true, rollDegrees: '0', pitchDegrees: 0 },
    { eulerFresh: true, rollDegrees: NaN, pitchDegrees: 0 },
    { eulerFresh: true, rollDegrees: 0, pitchDegrees: Infinity },
    { eulerFresh: true, rollDegrees: 181, pitchDegrees: 0 },
    { eulerFresh: true, rollDegrees: 0, pitchDegrees: -91 }]) {
    assert.equal(horizonPose(view), null);
  }
});

test('crossing the roll wrap follows the shortest direction', () => {
  assert.equal(unwrapAngle(179, -179), 181);
  assert.equal(unwrapAngle(-179, 179), -181);
  assert.equal(unwrapAngle(539, -179), 541);
  assert.equal(unwrapAngle(NaN, -120), -120);
  assert.equal(pitchOffset(15), -30, 'body-frame positive pitch lowers the bow and raises the horizon');
});

test('SVG freezes the last pose on stale data and resets to an explicitly invalid neutral view', () => {
  const host = fakeHost();
  const instrument = new ArtificialHorizon(host);
  assert.equal(host.attributes['data-valid'], 'false');
  assert.equal(host.attributes['data-state'], 'waiting');
  assert.equal(host.attributes['data-roll'], '--');
  instrument.update({ eulerFresh: true, rollDegrees: 179, pitchDegrees: 15 });
  assert.equal(instrument.pitchGroup.attributes.transform, 'translate(0 -30)');
  assert.equal(instrument.rollGroup.attributes.transform, 'rotate(-179 120 120)');
  instrument.update({ eulerFresh: true, rollDegrees: -179, pitchDegrees: 15 });
  assert.equal(instrument.rollGroup.attributes.transform, 'rotate(-181 120 120)');
  assert.equal(instrument.bankPointer.attributes.transform, 'rotate(181 120 120)');
  instrument.update({ eulerFresh: false, rollDegrees: 0, pitchDegrees: 0, status: '欧拉角无效' });
  assert.equal(host.attributes['data-valid'], 'false');
  assert.equal(host.attributes['data-state'], 'stale');
  assert.equal(instrument.rollGroup.attributes.transform, 'rotate(-181 120 120)');
  assert.equal(instrument.pitchGroup.attributes.transform, 'translate(0 -30)');
  assert.match(instrument.svg.attributes['aria-label'], /欧拉角无效.*保持最后姿态/);
  instrument.reset();
  assert.equal(host.attributes['data-state'], 'waiting');
  assert.equal(host.attributes['data-roll'], '--');
  assert.equal(instrument.rollGroup.attributes.transform, 'rotate(0 120 120)');
});

test('multiple instruments have separate clip paths and all requested scales', () => {
  const first = new ArtificialHorizon(fakeHost());
  const second = new ArtificialHorizon(fakeHost());
  assert.notEqual(first.clipId, second.clipId);
  function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
  const nodes = descendants(first.svg);
  const rolls = nodes.filter(node => (node.attributes.class || '').includes('ah-roll-tick'));
  assert.deepEqual(rolls.map(node => node.attributes['data-angle']),
    ['-60', '-45', '-30', '-20', '-10', '0', '10', '20', '30', '45', '60']);
  const pitches = nodes.filter(node => (node.attributes.class || '').includes('ah-pitch-line'));
  assert.ok(pitches.some(node => node.attributes['data-angle'] === '5'));
  for (const angle of ['10', '20', '30'])
    assert.ok(pitches.some(node => node.attributes['data-angle'] === angle));
});
