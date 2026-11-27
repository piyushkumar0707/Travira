const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const mongoose = require('mongoose');
const Geofence = require('../models/Geofence');
const Tourist = require('../models/Tourist');
const { validators } = require('../validation');

const mongoUri = process.env.MONGODB_URI;
const skip = mongoUri ? false : 'Set MONGODB_URI to a disposable MongoDB test database';
const runId = new mongoose.Types.ObjectId().toString();
// Far from the coordinates the integration suite uses, which runs alongside this one.
const lat = -42;
const lng = 140;

before(async () => {
  if (skip) return;
  await mongoose.connect(mongoUri);
  await Geofence.init();
});

after(async () => {
  if (skip) return;
  await Geofence.deleteMany({ name: new RegExp(runId) });
  await Tourist.deleteMany({ touristId: new RegExp(runId) });
  await mongoose.disconnect();
});

const matches = async (atLat, atLng) => (await Geofence.findContainingPoint(atLat, atLng))
  .filter((fence) => fence.name.includes(runId))
  .map((fence) => fence.name.split(' ')[0])
  .sort();

test('circle and polygon geofences match only the points inside them', { skip }, async () => {
  const d = 0.005;
  await Geofence.create([
    { name: `circle ${runId}`, type: 'restricted_area', geometry: { type: 'Point', coordinates: [lng, lat], radius: 500 } },
    { name: `inactive ${runId}`, type: 'restricted_area', active: false, geometry: { type: 'Point', coordinates: [lng, lat], radius: 500 } },
    { name: `polygon ${runId}`, type: 'restricted_area', geometry: { type: 'Polygon', coordinates: [[
      [lng + 1 - d, lat - d], [lng + 1 + d, lat - d], [lng + 1 + d, lat + d], [lng + 1 - d, lat + d], [lng + 1 - d, lat - d],
    ]] } },
  ]);

  assert.deepEqual(await matches(lat, lng), ['circle']);
  assert.deepEqual(await matches(lat + 0.001, lng), ['circle'], 'about 110 m from the center');
  assert.deepEqual(await matches(lat + 0.01, lng), [], 'about 1.1 km from the center');
  assert.deepEqual(await matches(lat, lng + 1), ['polygon']);
  assert.deepEqual(await matches(lat + 0.01, lng + 1), []);
});

test('removing the old location index lets any longitude be saved', { skip }, async () => {
  // A separate database, so a backend started by another suite cannot drop the index mid-test.
  const database = mongoose.connection.useDb(`legacy_index_${runId}`);
  const Legacy = database.model('Tourist', Tourist.schema);
  const farEast = () => Legacy.create({ touristId: `far-${runId}`, name: 'Far east', location: { lat, lng } });
  try {
    await Legacy.init();
    // Recreate what an existing database still has.
    await Legacy.collection.createIndex({ location: '2dsphere' });
    await assert.rejects(farEast, /Can't extract geo keys/);

    assert.equal(await Legacy.dropLegacyLocationIndex(), true);
    assert.equal(await Legacy.dropLegacyLocationIndex(), false, 'safe to run on every start');
    assert.equal((await farEast()).location.lng, lng);
  } finally {
    await database.dropDatabase();
  }
});

test('a zone entry is claimed once until the tourist leaves or the email fails', { skip }, async () => {
  const tourist = await Tourist.create({ touristId: `zones-${runId}`, name: 'Zone test', location: { lat, lng } });

  const concurrent = await Promise.all(Array.from({ length: 10 }, () => tourist.claimZoneEntries(['zone-a'])));
  assert.deepEqual(concurrent.flat(), ['zone-a'], 'only one concurrent request may send');
  assert.deepEqual(await tourist.claimZoneEntries(['zone-a', 'zone-b']), ['zone-b']);

  await tourist.claimZoneEntries([]);
  assert.deepEqual(await tourist.claimZoneEntries(['zone-a']), ['zone-a'], 're-entry counts again');

  await tourist.releaseZoneEntries(['zone-a']);
  assert.deepEqual(await tourist.claimZoneEntries(['zone-a']), ['zone-a'], 'failed email is retried');
});

test('emergency contact accepts one address or an empty string', () => {
  const check = validators.emergencyContact;
  assert.equal(check({ email: 'family@example.test' }), null);
  assert.equal(check({ email: '' }), null);
  for (const email of [undefined, 5, 'not-an-email', 'a@example.test,b@example.test', 'Name <a@example.test>']) {
    assert.ok(check({ email }), `${email} must be rejected`);
  }
});
