const mongoose = require('mongoose');

const touristSchema = new mongoose.Schema({
  touristId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: false 
  },
  name: { 
    type: String, 
    required: true 
  },
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  safetyScore: { 
    type: Number, 
    default: 85,
    min: 0,
    max: 100
  },
  status: { 
    type: String, 
    enum: ['active', 'high-risk', 'emergency', 'inactive'],
    default: 'active'
  },
  lastUpdated: { 
    type: Date, 
    default: Date.now 
  },
  accuracy: { 
    type: Number, 
    default: 0 
  },
  deviceId: {
    type: String
  },
  emergencyContact: {
    name: String,
    phone: String,
    email: String
  },
  // Restricted zones the tourist is inside and has already been emailed about.
  emailedZoneIds: {
    type: [String],
    default: []
  },
  scoreHistory: {
    type: [{
      score: { type: Number },
      timestamp: { type: Date, default: Date.now }
    }],
    default: []
  },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true
});

// location is deliberately not geo-indexed: a 2dsphere index reads {lat, lng} as
// [longitude, latitude] and rejects any longitude beyond ±90. Earlier versions
// created that index and MongoDB keeps it, so it has to be removed explicitly.
touristSchema.statics.dropLegacyLocationIndex = async function() {
  try {
    await this.collection.dropIndex('location_2dsphere');
    return true;
  } catch (err) {
    if (['IndexNotFound', 'NamespaceNotFound'].includes(err.codeName)) return false;
    throw err;
  }
};

// Index for efficient queries
touristSchema.index({ status: 1, safetyScore: 1 });
touristSchema.index({ userId: 1 });

// Method to update location
touristSchema.methods.updateLocation = function(lat, lng, accuracy) {
  this.location = { lat, lng };
  this.accuracy = accuracy || 0;
  this.lastUpdated = new Date();
  return this.save();
};

// Update the score and bounded history atomically. Concurrent location requests
// can hold stale Tourist documents, so saving scoreHistory through document.save()
// would trigger Mongoose's array version check and reject valid updates.
// The status is decided inside the update, from the value stored at that moment,
// so a new score can never overwrite an emergency raised by a panic alert.
touristSchema.methods.updateSafetyScore = async function(score) {
  const safeScore = Math.max(0, Math.min(100, score));
  // An update pipeline skips schema validation, so reject a non-number here.
  if (!Number.isFinite(safeScore)) throw new TypeError('Safety score must be a number');
  const entry = { _id: new mongoose.Types.ObjectId(), score: safeScore, timestamp: new Date() };
  return this.constructor.findOneAndUpdate(
    { _id: this._id },
    [{
      $set: {
        safetyScore: safeScore,
        status: {
          $cond: [{ $eq: ['$status', 'emergency'] }, 'emergency', safeScore < 50 ? 'high-risk' : 'active']
        },
        scoreHistory: { $slice: [{ $concatArrays: [{ $ifNull: ['$scoreHistory', []] }, [entry]] }, -24] }
      }
    }],
    { new: true }
  );
};

// Record the zones the tourist is in now and return the ones just entered. The
// single atomic update means concurrent requests cannot both claim an entry.
// Passing a list without a zone forgets it, so re-entering counts again.
touristSchema.methods.claimZoneEntries = async function(zoneIds) {
  const previous = await this.constructor.findOneAndUpdate(
    { _id: this._id },
    { $set: { emailedZoneIds: zoneIds } },
    { new: false, projection: { emailedZoneIds: 1 } }
  );
  if (!previous) return [];
  return zoneIds.filter((id) => !previous.emailedZoneIds.includes(id));
};

// Undo claims whose email could not be sent, so a later update retries.
touristSchema.methods.releaseZoneEntries = function(zoneIds) {
  return this.constructor.updateOne(
    { _id: this._id },
    { $pull: { emailedZoneIds: { $in: zoneIds } } }
  );
};

// Static method to get high-risk tourists
touristSchema.statics.getHighRiskTourists = function() {
  return this.find({ 
    $or: [
      { safetyScore: { $lt: 70 } },
      { status: 'high-risk' },
      { status: 'emergency' }
    ]
  });
};

// Static method to get active tourists count
touristSchema.statics.getActiveCount = function() {
  return this.countDocuments({ status: 'active' });
};

module.exports = mongoose.model('Tourist', touristSchema);
