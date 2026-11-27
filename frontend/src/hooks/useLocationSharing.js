import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export const SEND_INTERVAL_MS = 15000;
const GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 };
const PERMISSION_DENIED = 1;
const TIMEOUT = 3;

const geolocationProblem = () => {
  if (!window.isSecureContext) return 'Location only works on a secure (https) page or on localhost.';
  if (!navigator.geolocation) return 'This browser does not support location sharing.';
  return null;
};

const toPoint = ({ coords }) => ({
  lat: coords.latitude,
  lng: coords.longitude,
  accuracy: coords.accuracy,
});

// One fresh position, or null if it cannot be had quickly. The extra timer is
// needed because the browser's own timeout does not run while it is still
// waiting for the user to answer the permission prompt.
const requestPoint = () => new Promise((resolve) => {
  if (geolocationProblem()) {
    resolve(null);
    return;
  }
  const giveUp = setTimeout(() => resolve(null), 8000);
  const finish = (point) => {
    clearTimeout(giveUp);
    resolve(point);
  };
  navigator.geolocation.getCurrentPosition(
    (position) => finish(toPoint(position)),
    () => finish(null),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 7000 },
  );
});

/**
 * Watches the browser's position and sends it to the backend: once when the
 * first position arrives, then every SEND_INTERVAL_MS until stopped.
 */
const useLocationSharing = () => {
  const { apiRequest } = useAuth();
  const [sharing, setSharing] = useState(false);
  const [point, setPoint] = useState(null);
  const [locationError, setLocationError] = useState(null);
  const [sendError, setSendError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null); // { at, safetyScore, zones }
  // Everything belonging to the current sharing run. A reply that arrives after
  // its run has ended is ignored.
  const run = useRef(null);

  const stop = useCallback(() => {
    const current = run.current;
    if (!current) return;
    run.current = null;
    navigator.geolocation.clearWatch(current.watchId);
    clearInterval(current.timerId);
    setSharing(false);
    setPoint(null);
    setSendError(null);
  }, []);

  // Called on every new position and once a second; sends at most once per
  // interval, so a failed request is retried at the next one.
  const sendIfDue = async (current) => {
    // One request at a time, so a slow reply cannot overwrite a newer one.
    if (run.current !== current || current.sending || !current.point) return;
    if (Date.now() - current.sentAt < SEND_INTERVAL_MS) return;
    current.sending = true;
    current.sentAt = Date.now();
    const { lat, lng, accuracy } = current.point;
    const result = await apiRequest('/api/mobile/location/update', {
      method: 'POST',
      // The API rejects an accuracy above 10 km, which coarse desktop fixes can exceed.
      body: { lat, lng, accuracy: Math.min(accuracy, 10000) },
      timeout: 60000,
    });
    current.sending = false;
    if (run.current !== current) return;
    if (result.error) {
      setSendError(result.error);
      return;
    }
    setSendError(null);
    setLastUpdate({
      at: new Date(),
      safetyScore: result.data.tourist?.safetyScore,
      zones: result.data.geofenceCheck?.violations || [],
    });
  };

  const start = () => {
    if (run.current) return;
    const problem = geolocationProblem();
    if (problem) {
      setLocationError(problem);
      return;
    }
    setLocationError(null);
    setSendError(null);

    const current = { point: null, sending: false, sentAt: 0 };
    run.current = current;
    setSharing(true);

    current.watchId = navigator.geolocation.watchPosition(
      (position) => {
        if (run.current !== current) return;
        current.point = toPoint(position);
        setPoint(current.point);
        setLocationError(null);
        sendIfDue(current);
      },
      (error) => {
        if (run.current !== current) return;
        if (error.code === PERMISSION_DENIED) {
          stop();
          setLocationError('Location permission was denied. Allow location for this site in your browser settings, then press "Share my location" again.');
          return;
        }
        // A timeout after a good fix usually just means the device has not moved.
        if (error.code === TIMEOUT && current.point) return;
        // Do not keep sending a position the device can no longer confirm.
        current.point = null;
        setPoint(null);
        setLocationError('Your device cannot find your location right now. Check that location services are on. Sharing continues when a position is found.');
      },
      GEO_OPTIONS,
    );
    current.timerId = setInterval(() => sendIfDue(current), 1000);
  };

  // Leaving the page ends sharing.
  useEffect(() => stop, [stop]);

  // The live position while sharing, otherwise a one-off fresh one.
  const getPoint = () => (run.current?.point ? Promise.resolve(run.current.point) : requestPoint());

  return { sharing, point, locationError, sendError, lastUpdate, start, stop, getPoint };
};

export default useLocationSharing;
