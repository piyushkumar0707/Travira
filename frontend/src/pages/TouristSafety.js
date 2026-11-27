import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExclamationTriangleIcon, MapPinIcon } from '@heroicons/react/24/outline';
import { useAuth } from '../contexts/AuthContext';
import useLocationSharing, { SEND_INTERVAL_MS } from '../hooks/useLocationSharing';

const ZONE_LABELS = { restricted_area: 'Restricted area', high_risk: 'High-risk area' };

// What the server reports about the emergency contact email for one alert.
const CONTACT_MESSAGES = {
  sending: 'We are trying to email your emergency contact. Delivery is not confirmed.',
  recently_sent: 'No new email: emails about your recent alerts were already sent or are being sent.',
  no_contact: 'No emergency contact is saved, so no email was sent.',
};

const PanicButton = ({ getPoint }) => {
  const { apiRequest } = useAuth();
  // idle -> confirming -> sending -> sent | failed
  const [step, setStep] = useState('idle');
  const [outcome, setOutcome] = useState(null);

  const sendAlert = async () => {
    setStep('sending');
    const point = await getPoint();
    const result = await apiRequest('/api/mobile/panic/alert', {
      method: 'POST',
      // Without a position the alert is still sent.
      body: point ? { lat: point.lat, lng: point.lng } : {},
      timeout: 30000,
    });
    if (result.error) {
      setOutcome({ error: result.error });
      setStep('failed');
      return;
    }
    setOutcome({
      incidentId: result.data.incidentId,
      contactMessage: CONTACT_MESSAGES[result.data.contactEmail],
      withLocation: Boolean(point),
      at: new Date(),
    });
    setStep('sent');
  };

  return (
    <section aria-labelledby="panic-heading" className="bg-white rounded-xl shadow-sm border border-red-200 p-6 space-y-4">
      <h3 id="panic-heading" className="text-lg font-semibold text-gray-900">Emergency</h3>

      {step === 'sent' && (
        <div role="status" className="bg-red-50 border border-red-300 text-red-800 rounded-lg p-4 text-sm">
          <p className="font-semibold">Your alert was recorded at {outcome.at.toLocaleTimeString()}.</p>
          <p>Reference: {outcome.incidentId}</p>
          <p>{outcome.withLocation ? 'Your location was included.' : 'Your location could not be read, so the alert was sent without it.'}</p>
          {outcome.contactMessage && <p>{outcome.contactMessage}</p>}
          <p>Your status stays as an emergency until safety staff close your alerts.</p>
          <p className="mt-2">If you are in immediate danger, call your local emergency number.</p>
        </div>
      )}
      {step === 'failed' && (
        <div role="alert" className="bg-red-50 border border-red-300 text-red-800 rounded-lg p-4 text-sm">
          <p className="font-semibold">We could not confirm that your alert was sent ({outcome.error}).</p>
          <p>Call your local emergency number, then try again.</p>
        </div>
      )}

      {step === 'confirming' ? (
        <div role="alertdialog" aria-labelledby="panic-confirm" className="space-y-3">
          <p id="panic-confirm" className="text-sm text-gray-800">
            <strong>Send an emergency alert now?</strong> It is recorded as a high-severity incident for safety staff.
            If you saved an emergency contact, an email to them is attempted, though repeat alerts may not email them again.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <button type="button" onClick={sendAlert} className="px-5 py-3 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold">
              Yes, send alert
            </button>
            <button type="button" autoFocus onClick={() => setStep('idle')} className="px-5 py-3 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setStep('confirming')}
          disabled={step === 'sending'}
          className="w-full flex items-center justify-center gap-2 px-5 py-5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-lg font-bold disabled:opacity-60"
        >
          <ExclamationTriangleIcon className="h-6 w-6" />
          {step === 'sending' ? 'Sending alert...' : step === 'sent' ? 'Send another alert' : 'Panic button'}
        </button>
      )}

      <p className="text-sm text-gray-500">
        <Link to="/profile" className="text-blue-600 hover:underline">Set your emergency contact</Link>
      </p>
    </section>
  );
};

const TouristSafety = () => {
  const { sharing, point, locationError, sendError, lastUpdate, start, stop, getPoint } = useLocationSharing();
  const zones = lastUpdate?.zones || [];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {zones.length > 0 && (
        <div role="alert" className="bg-yellow-50 border-2 border-yellow-500 text-yellow-900 rounded-xl p-5">
          <p className="font-bold">Warning: you were inside a flagged zone at {lastUpdate.at.toLocaleTimeString()}</p>
          <ul className="mt-2 list-disc list-inside text-sm">
            {zones.map((zone) => (
              <li key={zone.geofenceId}>
                {zone.name} ({ZONE_LABELS[zone.type] || zone.type}, risk {zone.riskLevel}/10)
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm">Move to a safer place if you can.</p>
        </div>
      )}

      <PanicButton getPoint={getPoint} />

      <section aria-labelledby="location-heading" className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <MapPinIcon className="h-6 w-6 text-blue-600" />
          <h3 id="location-heading" className="text-lg font-semibold text-gray-900">Location sharing</h3>
        </div>
        <p className="text-sm text-gray-600">
          While sharing is on, your position is sent to safety staff when it is first found and then about every {SEND_INTERVAL_MS / 1000} seconds.
          Keep this page open: leaving it stops sharing, and a hidden tab may update less often.
          Stopping does not delete the last position you shared.
        </p>

        {sharing ? (
          <button type="button" onClick={stop} className="px-5 py-3 rounded-lg bg-gray-800 hover:bg-gray-900 text-white font-medium">
            Stop sharing
          </button>
        ) : (
          <button type="button" onClick={start} className="px-5 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium">
            Share my location
          </button>
        )}

        <p role="status" className="text-sm font-medium text-gray-800">
          {!sharing ? 'Sharing is off.' : point ? 'Sharing is on.' : 'Waiting for your location...'}
        </p>

        {locationError && (
          <p role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">{locationError}</p>
        )}
        {sendError && (
          <p role="alert" className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
            Could not send your location ({sendError}). It will be retried.
          </p>
        )}

        {point && (
          <p className="text-sm text-gray-600">
            Current position: {point.lat.toFixed(5)}, {point.lng.toFixed(5)} (accurate to about {Math.round(point.accuracy)} m)
          </p>
        )}

        {lastUpdate && (
          <dl className="grid grid-cols-2 gap-4 border-t border-gray-100 pt-4">
            <div>
              <dt className="text-sm text-gray-500">Safety score</dt>
              <dd className="text-3xl font-bold text-gray-900">{lastUpdate.safetyScore ?? '-'}<span className="text-base text-gray-500"> / 100</span></dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500">Last shared</dt>
              <dd className="text-lg text-gray-900">{lastUpdate.at.toLocaleTimeString()}</dd>
              {zones.length === 0 && <dd className="text-sm text-gray-500">No restricted-zone warning</dd>}
            </div>
          </dl>
        )}
      </section>
    </div>
  );
};

export default TouristSafety;
