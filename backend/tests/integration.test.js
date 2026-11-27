const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { after, before, describe, test } = require('node:test');
const net = require('node:net');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const User = require('../models/User');
const Tourist = require('../models/Tourist');
const Incident = require('../models/Incident');
const { createRateLimiter } = require('../rateLimit');

const mongoUri = process.env.MONGODB_URI;
const secret = process.env.JWT_SECRET || 'integration-test-secret-at-least-32-chars';
const port = Number(process.env.TEST_PORT || 5057);
const baseUrl = `http://127.0.0.1:${port}`;
const backendDir = path.resolve(__dirname, '..');
const userIds = [];
const usernames = [];
const incidentIds = [];
let backend;
let backendOutput = '';
const password = 'Integration-Pass-123!';

// A stand-in mail server on this machine, so the tests can count the emails the
// backend really sends without anything leaving the computer.
const deliveredTo = [];
let rejectEmails = false;
let rejectedEmails = 0;
const mailServer = net.createServer((connection) => {
  let buffered = '';
  let readingBody = false;
  let recipient;
  connection.setEncoding('utf8');
  connection.on('error', () => {});
  connection.write('220 mail.test ready\r\n');
  connection.on('data', (chunk) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf('\r\n')) !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      if (readingBody) {
        if (line !== '.') continue;
        readingBody = false;
        if (rejectEmails) rejectedEmails += 1;
        else deliveredTo.push(recipient);
        connection.write(rejectEmails ? '451 Try again later\r\n' : '250 Queued\r\n');
        continue;
      }
      const command = line.slice(0, 4).toUpperCase();
      if (command === 'EHLO') connection.write('250-mail.test\r\n250 AUTH PLAIN\r\n');
      else if (command === 'AUTH') connection.write('235 Authenticated\r\n');
      else if (command === 'DATA') { readingBody = true; connection.write('354 Send the message\r\n'); }
      else if (command === 'QUIT') connection.end('221 Bye\r\n');
      else {
        if (command === 'RCPT') recipient = line.slice(line.indexOf('<') + 1, line.indexOf('>'));
        connection.write('250 OK\r\n');
      }
    }
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emailsTo = (address) => deliveredTo.filter((to) => to === address).length;
const uniqueSuffix = () => new mongoose.Types.ObjectId().toString().slice(-8);

async function waitFor(condition, description) {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}. Backend log:\n${backendOutput}`);
    await sleep(50);
  }
}

function signToken(role, overrides = {}) {
  return jwt.sign({
    userId: new mongoose.Types.ObjectId().toString(),
    username: `it_${role}`,
    role,
    status: 'active',
    ...overrides,
  }, secret, { expiresIn: overrides.expiresIn || '5m' });
}

async function api(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() };
}

async function registerTourist(label) {
  const username = `it_${label}_${uniqueSuffix()}`;
  const result = await api('/api/register', {
    method: 'POST',
    body: { username, email: `${username}@example.test`, password },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  userIds.push(new mongoose.Types.ObjectId(result.body.user.id));
  usernames.push(username);
  return { ...result.body, username };
}

// A registered tourist who also has a monitoring record.
async function trackedTourist(label) {
  const account = await registerTourist(label);
  const record = await Tourist.create({
    touristId: `it-${uniqueSuffix()}`,
    userId: account.user.id,
    name: account.username,
    location: { lat: 12.97, lng: 77.59 },
  });
  return { ...account, touristId: record.touristId };
}

async function createIncident(touristId) {
  const incidentId = `IT-${uniqueSuffix()}`;
  incidentIds.push(incidentId);
  await Incident.create({
    incidentId, touristId, type: 'Theft', location: 'Test market',
    severity: 'Low', description: 'access control test',
  });
  return incidentId;
}

function assertForbidden({ response, body }, description) {
  assert.equal(response.status, 403, `${description}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.code, 'FORBIDDEN');
}

function assertRateLimited({ response, body }, description) {
  assert.equal(response.status, 429, `${description}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.code, 'RATE_LIMITED');
  assert.ok(Number(response.headers.get('retry-after')) > 0, 'Retry-After says when to try again');
}

const logIn = (username, attempt = password, route = '/api/login') => api(route, {
  method: 'POST', body: { username, password: attempt },
});

const setContact = (account, email) => api('/api/profile/emergency-contact', {
  method: 'PUT', token: account.token, body: { email },
});

const panic = (account, message = 'access control test') => api('/api/mobile/panic/alert', {
  method: 'POST', token: account.token, body: { lat: 19.076, lng: 72.8777, message },
});

function connectSocket(token) {
  const socket = io(baseUrl, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000,
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 4000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });
  });
}

function nextSocketEvent(socket, name) {
  const observed = [];
  socket.onAny((eventName) => observed.push(eventName));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      `Timed out waiting for ${name}; received [${observed.join(', ')}]. Backend log:\n${backendOutput}`
    )), 8000);
    socket.once(name, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

describe('Node API integration', { concurrency: false }, () => {
  before(async () => {
    assert.ok(mongoUri, 'MONGODB_URI must point to a disposable MongoDB database');
    await mongoose.connect(mongoUri);
    await new Promise((resolve) => mailServer.listen(0, '127.0.0.1', resolve));
    backend = spawn(process.execPath, ['index.js'], {
      cwd: backendDir,
      env: {
        ...process.env,
        PORT: String(port),
        JWT_SECRET: secret,
        MONGODB_URI: mongoUri,
        AI_SAFETY_SCORE_URL: process.env.AI_SAFETY_SCORE_URL || 'http://127.0.0.1:8001',
        AI_CASE_REPORT_URL: process.env.AI_CASE_REPORT_URL || 'http://127.0.0.1:8002',
        BLOCKCHAIN_API_URL: 'http://127.0.0.1:1',
        // Always override real mail and push settings with test-only values.
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(mailServer.address().port),
        EMAIL_USER: 'alerts@example.test',
        EMAIL_PASS: 'local-test-only',
        FIREBASE_SERVICE_ACCOUNT: '',
        TRUST_PROXY_HOPS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backend.stdout.on('data', (chunk) => { backendOutput += chunk.toString(); });
    backend.stderr.on('data', (chunk) => { backendOutput += chunk.toString(); });

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (backend.exitCode !== null) throw new Error(`Backend exited early:\n${backendOutput}`);
      if (backendOutput.includes('Connected to MongoDB Atlas successfully')) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Backend did not connect to MongoDB:\n${backendOutput}`);
  });

  after(async () => {
    for (const socket of activeSockets) socket.close();
    if (userIds.length) {
      await Promise.all([
        User.deleteMany({ _id: { $in: userIds } }),
        Tourist.deleteMany({ userId: { $in: userIds } }),
      ]);
    }
    await Incident.deleteMany({ $or: [{ incidentId: { $in: incidentIds } }, { tourist: { $in: usernames } }] });
    if (backend && backend.exitCode === null) {
      backend.kill('SIGTERM');
      await new Promise((resolve) => backend.once('exit', resolve));
    }
    if (mailServer.listening) mailServer.close();
    if (mongoose.connection.readyState) await mongoose.disconnect();
  });

  const activeSockets = new Set();
  const trackSocket = (socket) => {
    activeSockets.add(socket);
    socket.once('disconnect', () => activeSockets.delete(socket));
    return socket;
  };

  test('auth matrix: missing token returns 401', async () => {
    const { response, body } = await api('/api/tourists');
    assert.equal(response.status, 401);
    assert.deepEqual([body.code, typeof body.error], ['UNAUTHENTICATED', 'string']);
  });

  test('auth matrix: invalid token returns 401', async () => {
    const { response, body } = await api('/api/tourists', { token: 'not-a-jwt' });
    assert.equal(response.status, 401);
    assert.deepEqual([body.code, typeof body.error], ['UNAUTHENTICATED', 'string']);
  });

  test('auth matrix: expired token returns 401', async () => {
    const token = jwt.sign({ userId: 'expired', username: 'expired', role: 'admin', exp: Math.floor(Date.now() / 1000) - 60 }, secret);
    const { response, body } = await api('/api/tourists', { token });
    assert.equal(response.status, 401);
    assert.deepEqual([body.code, typeof body.error], ['UNAUTHENTICATED', 'string']);
  });

  test('auth matrix: wrong role returns 403', async () => {
    const { response, body } = await api('/api/tourists', { token: signToken('tourist') });
    assert.equal(response.status, 403);
    assert.deepEqual([body.code, typeof body.error], ['FORBIDDEN', 'string']);
  });

  test('auth matrix: valid admin token is accepted', async () => {
    const { response } = await api('/api/tourists', { token: signToken('admin') });
    assert.equal(response.status, 200);
  });

  test('public registration cannot create an admin', async () => {
    const username = `it_escalation_${new mongoose.Types.ObjectId().toString().slice(-8)}`;
    const { response, body } = await api('/api/register', {
      method: 'POST',
      body: { username, email: `${username}@example.test`, password: 'Integration-Pass-123!', role: 'admin' },
    });
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.user.role, 'tourist');
    const createdId = new mongoose.Types.ObjectId(body.user.id);
    userIds.push(createdId);
    assert.equal((await User.findById(createdId).lean()).role, 'tourist');
  });

  test('invalid location input returns 400 with {error, code}', async () => {
    const tourist = await registerTourist('validation');
    const { response, body } = await api('/api/mobile/location/update', {
      method: 'POST', token: tourist.token, body: { lat: 91, lng: 10 },
    });
    assert.equal(response.status, 400);
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.equal(typeof body.error, 'string');
  });

  test('location update persists score/history and emits to authenticated staff', async () => {
    const tourist = await registerTourist('location');
    const staffSocket = trackSocket(await connectSocket(signToken('admin')));
    const event = nextSocketEvent(staffSocket, 'tourist:location');
    const { response, body } = await api('/api/mobile/location/update', {
      method: 'POST', token: tourist.token,
      body: { lat: 28.6139, lng: 77.209, accuracy: 4, timestamp: new Date().toISOString() },
    });
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    const eventData = await event;
    assert.equal(eventData.userId, tourist.user.id);
    const saved = await Tourist.findOne({ userId: tourist.user.id }).lean();
    assert.ok(saved, 'tourist location must be persisted');
    assert.equal(saved.location.lat, 28.6139);
    assert.equal(saved.location.lng, 77.209);
    assert.equal(saved.safetyScore, body.tourist.safetyScore);
    assert.ok(saved.scoreHistory.length >= 1, 'score history must be persisted');
    assert.equal(saved.scoreHistory.at(-1).score, saved.safetyScore);
  });

  test('unauthenticated Socket.IO client is rejected', async () => {
    const socket = io(baseUrl, { auth: {}, transports: ['websocket'], reconnection: false, timeout: 3000 });
    const error = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Unauthenticated socket was not rejected')), 4000);
      socket.once('connect_error', (err) => {
        clearTimeout(timeout);
        resolve(err);
      });
      socket.once('connect', () => {
        clearTimeout(timeout);
        reject(new Error('Unauthenticated socket connected'));
      });
    });
    socket.close();
    assert.match(error.message, /Unauthorized/);
  });

  test('panic flow persists an emergency incident and emits the staff event', async () => {
    const tourist = await registerTourist('panic');
    const staffSocket = trackSocket(await connectSocket(signToken('officer')));
    const event = nextSocketEvent(staffSocket, 'alert:panic');
    const { response, body } = await api('/api/mobile/panic/alert', {
      method: 'POST', token: tourist.token,
      body: { lat: 19.076, lng: 72.8777, message: 'integration panic flow' },
    });
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    incidentIds.push(body.incidentId);
    const eventData = await event;
    assert.equal(eventData.incident.incidentId, body.incidentId);
    const savedIncident = await Incident.findOne({ incidentId: body.incidentId }).lean();
    assert.equal(savedIncident.type, 'Emergency Alert');
    assert.equal(savedIncident.description, 'integration panic flow');
    assert.equal(savedIncident.status, 'Open');
  });

  // ===== Emergency status =====

  const shareLocation = (account) => api('/api/mobile/location/update', {
    method: 'POST', token: account.token, body: { lat: 19.2, lng: 72.9 },
  });
  const setIncidentStatus = async (incidentId, status) => {
    const { response, body } = await api(`/api/incidents/${incidentId}`, {
      method: 'PUT', token: signToken('officer'), body: { status },
    });
    assert.equal(response.status, 200, JSON.stringify(body));
  };
  const recordOf = (account) => Tourist.findOne({ userId: account.user.id }).lean();

  test('an emergency survives location updates until staff close every panic alert', async () => {
    const tourist = await trackedTourist('emergency');
    const first = (await panic(tourist)).body.incidentId;
    const second = (await panic(tourist)).body.incidentId;

    const update = await shareLocation(tourist);
    assert.equal(update.response.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.tourist.status, 'emergency');
    assert.deepEqual(update.body.tourist.location, { lat: 19.2, lng: 72.9 });
    assert.equal(update.body.tourist.scoreHistory.length, 1, 'scores are still recorded');

    const scored = await api(`/api/tourists/${tourist.touristId}/safety-score`, {
      method: 'PUT', token: signToken('officer'), body: { safetyScore: 90 },
    });
    assert.equal(scored.response.status, 200);
    assert.equal((await recordOf(tourist)).status, 'emergency', 'a new score does not end it');

    await setIncidentStatus(await createIncident(tourist.touristId), 'Resolved');
    assert.equal((await recordOf(tourist)).status, 'emergency', 'another kind of incident');
    await setIncidentStatus(first, 'Resolved');
    assert.equal((await recordOf(tourist)).status, 'emergency', 'one alert is still open');
    await setIncidentStatus(second, 'Monitoring');
    assert.equal((await recordOf(tourist)).status, 'emergency', 'monitoring is not closed');

    const staffSocket = trackSocket(await connectSocket(signToken('officer')));
    const event = nextSocketEvent(staffSocket, 'tourist:updated');
    await setIncidentStatus(second, 'Closed');
    assert.equal((await recordOf(tourist)).status, 'active');
    assert.equal((await event).status, 'active', 'staff screens are told');

    await setIncidentStatus(first, 'Open');
    assert.equal((await recordOf(tourist)).status, 'emergency', 'reopening restores it');
    await Tourist.updateOne({ userId: tourist.user.id }, { safetyScore: 30 });
    await setIncidentStatus(first, 'Resolved');
    assert.equal((await recordOf(tourist)).status, 'high-risk', 'a low score stays high risk');
  });

  test('an alert sent before the first location update still counts', async () => {
    const account = await registerTourist('early_panic');
    const { body } = await panic(account);

    assert.equal((await shareLocation(account)).body.tourist.status, 'emergency');
    assert.equal((await shareLocation(account)).body.tourist.status, 'emergency');
    await setIncidentStatus(body.incidentId, 'Resolved');
    assert.notEqual((await recordOf(account)).status, 'emergency');
    assert.notEqual((await shareLocation(account)).body.tourist.status, 'emergency');
  });

  test('a caller cannot choose an incident ID to fake a panic alert', async () => {
    const victim = await trackedTourist('spoof_target');
    const attacker = await registerTourist('spoof_sender');
    const chosen = `PANIC-spoof-${uniqueSuffix()}`;

    const { response, body } = await api('/api/incidents', {
      method: 'POST', token: attacker.token,
      body: {
        incidentId: chosen, touristId: victim.touristId, type: 'Emergency Alert',
        location: 'Test market', description: 'spoofed alert',
      },
    });
    incidentIds.push(chosen, body.incidentId);
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.match(body.incidentId, /^INC-/);
    assert.equal(await Incident.countDocuments({ incidentId: chosen }), 0);

    // Closing a real alert must not leave the tourist held by the fake one.
    const real = (await panic(victim)).body.incidentId;
    await setIncidentStatus(real, 'Resolved');
    assert.notEqual((await recordOf(victim)).status, 'emergency');
  });

  // ===== Access control =====

  test('only staff can change a safety score', async () => {
    const owner = await trackedTourist('score_owner');
    const stranger = await trackedTourist('score_other');
    const route = `/api/tourists/${owner.touristId}/safety-score`;
    const change = (token, safetyScore) => api(route, { method: 'PUT', token, body: { safetyScore } });

    assertForbidden(await change(stranger.token, 1), 'another tourist');
    assertForbidden(await change(owner.token, 100), 'the tourist being scored');
    assert.equal((await Tourist.findOne({ touristId: owner.touristId })).safetyScore, 85);

    for (const [role, score] of [['officer', 60], ['admin', 70]]) {
      const { response, body } = await change(signToken(role), score);
      assert.equal(response.status, 200, `${role}: ${JSON.stringify(body)}`);
      assert.equal((await Tourist.findOne({ touristId: owner.touristId })).safetyScore, score);
    }
  });

  test('a tourist record is visible only to its owner and staff', async () => {
    const owner = await trackedTourist('record_owner');
    const stranger = await trackedTourist('record_other');
    const route = `/api/tourists/${owner.touristId}`;

    assertForbidden(await api(route, { token: stranger.token }), 'another tourist');
    assertForbidden(await api('/api/tourists/it-missing', { token: stranger.token }), 'a tourist guessing IDs');
    for (const token of [owner.token, signToken('officer'), signToken('admin')]) {
      const { response, body } = await api(route, { token });
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.touristId, owner.touristId);
    }
    assert.equal((await api('/api/tourists/it-missing', { token: signToken('officer') })).response.status, 404);
  });

  test('only staff can update an incident', async () => {
    const owner = await trackedTourist('update_owner');
    const stranger = await trackedTourist('update_other');
    const incidentId = await createIncident(owner.touristId);
    const update = (token, body) => api(`/api/incidents/${incidentId}`, { method: 'PUT', token, body });

    assertForbidden(await update(stranger.token, { status: 'Closed' }), 'another tourist');
    assertForbidden(await update(owner.token, { status: 'Closed' }), 'the reporting tourist');
    assert.equal((await Incident.findOne({ incidentId })).status, 'Open');

    for (const [role, body] of [['officer', { status: 'In Progress' }], ['admin', { severity: 'High' }]]) {
      const result = await update(signToken(role), body);
      assert.equal(result.response.status, 200, `${role}: ${JSON.stringify(result.body)}`);
    }
    const saved = await Incident.findOne({ incidentId });
    assert.deepEqual([saved.status, saved.severity], ['In Progress', 'High']);
  });

  test('an incident report can be generated only by staff or the tourist it is about', async () => {
    const owner = await trackedTourist('report_owner');
    const stranger = await trackedTourist('report_other');
    const untracked = await registerTourist('report_untracked');
    const incidentId = await createIncident(owner.touristId);
    const unlinkedId = await createIncident(undefined);
    const generate = (id, token) => api(`/api/incidents/${id}/generate-report`, { method: 'POST', token });

    assertForbidden(await generate(incidentId, stranger.token), 'another tourist');
    assertForbidden(await generate(incidentId, untracked.token), 'a tourist without a record');
    assertForbidden(await generate(unlinkedId, stranger.token), 'an incident about nobody');
    assertForbidden(await generate('IT-missing', stranger.token), 'a tourist guessing IDs');
    assert.equal((await Incident.findOne({ incidentId })).reportGenerated, false);

    for (const token of [owner.token, signToken('officer'), signToken('admin')]) {
      const { response, body } = await generate(incidentId, token);
      assert.equal(response.status, 200, `needs the case report service: ${JSON.stringify(body).slice(0, 200)}`);
      assert.ok(body.pdf_base64);
    }
  });

  test('an alert from an untracked user is never treated as another tourist\'s', async () => {
    const untracked = await registerTourist('stand_in');
    const bystander = await registerTourist('stand_in_other');
    // A real tourist whose ID looks like the stand-in once built from the user ID.
    const touristId = `T-${untracked.user.id.slice(-3)}`;
    await Tourist.deleteMany({ touristId });
    await Tourist.create({ touristId, userId: bystander.user.id, name: bystander.username, location: { lat: 1, lng: 1 } });

    const alert = await panic(untracked);
    assert.equal(alert.response.status, 200);
    assertForbidden(await api(`/api/incidents/${alert.body.incidentId}/generate-report`, {
      method: 'POST', token: bystander.token,
    }), 'a tourist with a look-alike ID');
  });

  const staffOnlyRoutes = [
    ['GET', '/api/blockchain/logs'],
    ['GET', '/api/ai/metrics'],
    ['GET', '/api/ai/trends'],
    ['GET', '/api/ai/alerts'],
    ['POST', '/api/ai/safety-score', { geofenceRisk: 1 }],
    ['POST', '/api/ai/generate-report', { description: 'access control test' }],
  ];

  for (const [method, route, body] of staffOnlyRoutes) {
    test(`${method} ${route} is for staff only`, async () => {
      assertForbidden(await api(route, { method, body, token: signToken('tourist') }), 'tourist');
      for (const role of ['officer', 'admin']) {
        const result = await api(route, { method, body, token: signToken(role) });
        assert.equal(result.response.status, 200, `${role}: ${JSON.stringify(result.body).slice(0, 200)}`);
      }
    });
  }

  test('tourists can still use the pages meant for them', async () => {
    const tourist = await trackedTourist('pages');
    for (const route of [
      '/api/dashboard/stats', '/api/incidents', '/api/geofences',
      '/api/profile/emergency-contact', '/api/mobile/tourist/status',
    ]) {
      const { response, body } = await api(route, { token: tourist.token });
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(body).slice(0, 200)}`);
    }
  });

  // ===== Rate limits =====

  test('panic alerts are always recorded and shown to staff, but contact emails are capped', async () => {
    const tourist = await trackedTourist('panic_repeat');
    const contact = `family_${uniqueSuffix()}@example.test`;
    assert.equal((await setContact(tourist, contact)).response.status, 200);
    const staffSocket = trackSocket(await connectSocket(signToken('officer')));
    const shownToStaff = [];
    staffSocket.on('alert:panic', ({ incident }) => {
      if (incident.tourist === tourist.username) shownToStaff.push(incident.incidentId);
    });

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await panic(tourist));
      await sleep(5);
    }

    for (const { response, body } of results) assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(await Incident.countDocuments({ tourist: tourist.username }), 6);
    await waitFor(() => shownToStaff.length === 6, 'all six alerts to reach staff');
    await waitFor(() => emailsTo(contact) >= 3, 'the first three emails');
    await sleep(500);
    assert.equal(emailsTo(contact), 3);
    assert.deepEqual(results.map(({ body }) => body.contactEmail),
      ['sending', 'sending', 'sending', 'recently_sent', 'recently_sent', 'recently_sent']);

    // A newly chosen contact has not heard anything yet, so they must be told.
    const newContact = `friend_${uniqueSuffix()}@example.test`;
    await setContact(tourist, newContact);
    assert.equal((await panic(tourist)).body.contactEmail, 'sending');
    await waitFor(() => emailsTo(newContact) === 1, 'the new contact email');
  });

  test('a panic email that fails does not use up the allowance', async () => {
    const tourist = await trackedTourist('panic_retry');
    const contact = `retry_${uniqueSuffix()}@example.test`;
    await setContact(tourist, contact);

    rejectEmails = true;
    const before = rejectedEmails;
    try {
      for (let i = 1; i <= 4; i++) {
        assert.equal((await panic(tourist)).body.contactEmail, 'sending', `attempt ${i}`);
        await waitFor(() => rejectedEmails === before + i, `rejected email ${i}`);
        await sleep(100);
      }
    } finally {
      rejectEmails = false;
    }
    assert.equal((await panic(tourist)).body.contactEmail, 'sending');
    await waitFor(() => emailsTo(contact) === 1, 'the email after the mail server recovered');
  });

  test('simultaneous panic alerts are all recorded', async () => {
    const tourist = await trackedTourist('panic_burst');
    const results = await Promise.all(Array.from({ length: 100 }, () => panic(tourist)));
    assert.deepEqual(results.map(({ response }) => response.status), Array(100).fill(200));
    assert.equal(new Set(results.map(({ body }) => body.incidentId)).size, 100);
    assert.equal(await Incident.countDocuments({ tourist: tourist.username }), 100);
  });

  test('emergency contact changes are rate limited, but removal always works', async () => {
    const tourist = await registerTourist('contact_limit');
    const other = await registerTourist('contact_other');
    for (let i = 0; i < 5; i++) {
      assert.equal((await setContact(tourist, `contact${i}@example.test`)).response.status, 200, `change ${i + 1}`);
    }
    assertRateLimited(await setContact(tourist, 'one-too-many@example.test'), 'sixth change');
    const current = await api('/api/profile/emergency-contact', { token: tourist.token });
    assert.equal(current.body.email, 'contact4@example.test');
    assert.equal((await setContact(tourist, '')).response.status, 200, 'removal');
    assert.equal((await setContact(other, 'unaffected@example.test')).response.status, 200, 'another user');
  });

  test('repeated wrong passwords are blocked on both login routes', async () => {
    const target = await registerTourist('login_target');
    const bystander = await registerTourist('login_bystander');

    for (let i = 0; i < 10; i++) {
      const route = i % 2 ? '/api/mobile/auth/login' : '/api/login';
      assert.equal((await logIn(target.username, 'wrong-password', route)).response.status, 401, `attempt ${i + 1}`);
    }
    assertRateLimited(await logIn(target.username, 'wrong-password'), 'eleventh attempt');
    assertRateLimited(await logIn(target.username), 'right password while blocked');
    assertRateLimited(await logIn(target.username, password, '/api/mobile/auth/login'), 'mobile route');
    assertRateLimited(await logIn(`${target.username}@example.test`), 'signing in by email instead');
    assert.equal((await logIn(bystander.username)).response.status, 200, 'another account');
  });

  test('successful logins never count toward the limit', async () => {
    const account = await registerTourist('login_regular');
    for (let i = 0; i < 15; i++) {
      assert.equal((await logIn(account.username)).response.status, 200, `login ${i + 1}`);
    }
  });

  test('a burst of simultaneous guesses cannot get past the limit', async () => {
    const account = await registerTourist('login_burst');
    const results = await Promise.all(Array.from({ length: 25 }, () => logIn(account.username, 'wrong-password')));
    const statuses = results.map(({ response }) => response.status);
    assert.equal(statuses.filter((status) => status === 401).length, 10);
    assert.equal(statuses.filter((status) => status === 429).length, 15);
  });

  // Keep this last: it uses up the allowance for this machine's address.
  test('guessing many different accounts from one address is blocked', async () => {
    const statuses = [];
    for (let i = 0; i < 101; i++) {
      statuses.push((await logIn(`it_nobody_${uniqueSuffix()}`, 'wrong-password')).response.status);
    }
    assert.ok(statuses.includes(429), 'the address is eventually blocked');
  });
});

test('a rate limit lifts once its time window has passed', async () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 100 });
  assert.equal(limiter.take('a').allowed, true);
  assert.equal(limiter.take('a').allowed, true);
  assert.equal(limiter.take('a').allowed, false);
  assert.equal(limiter.take('b').allowed, true, 'each key has its own count');
  await sleep(150);
  assert.equal(limiter.take('a').allowed, true);
});
