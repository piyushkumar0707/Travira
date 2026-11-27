const mongoose = require('mongoose');
const Incident = require('../models/Incident');
const Tourist = require('../models/Tourist');

// A panic alert keeps its tourist in 'emergency' until staff resolve or close
// every panic incident raised by that tourist.

const CLOSED_STATUSES = ['Resolved', 'Closed'];
const STAND_IN_PREFIX = 'UNREGISTERED-';

// Used on an incident when the tourist had no monitoring record yet. It must
// never look like a real tourist ID.
const standInId = (userId) => `${STAND_IN_PREFIX}${userId}`;

const isPanicIncident = (incident) => incident.incidentId.startsWith('PANIC-');

const findTouristForIncident = ({ touristId }) => {
  if (!touristId) return null;
  if (!touristId.startsWith(STAND_IN_PREFIX)) return Tourist.findOne({ touristId });
  const userId = touristId.slice(STAND_IN_PREFIX.length);
  return mongoose.isValidObjectId(userId) ? Tourist.findOne({ userId }) : null;
};

const hasOpenPanic = (tourist) => Incident.exists({
  incidentId: /^PANIC-/,
  touristId: { $in: [tourist.touristId, ...(tourist.userId ? [standInId(tourist.userId)] : [])] },
  status: { $nin: CLOSED_STATUSES },
});

// Make the tourist's status agree with their panic incidents. Returns the
// updated tourist, or null if nothing needed to change.
async function syncEmergencyStatus(tourist) {
  let updated = null;
  if (!await hasOpenPanic(tourist)) {
    // The emergency is over, so the status follows the current score again.
    updated = await Tourist.findOneAndUpdate(
      { _id: tourist._id, status: 'emergency' },
      [{ $set: { status: { $cond: [{ $lt: ['$safetyScore', 50] }, 'high-risk', 'active'] } } }],
      { new: true }
    );
  }
  // Checked after clearing, so an alert raised in the meantime is not lost.
  if (await hasOpenPanic(tourist)) {
    updated = await Tourist.findOneAndUpdate(
      { _id: tourist._id, status: { $ne: 'emergency' } },
      { $set: { status: 'emergency' } },
      { new: true }
    ) || updated;
  }
  return updated;
}

module.exports = { standInId, isPanicIncident, findTouristForIncident, syncEmergencyStatus };
