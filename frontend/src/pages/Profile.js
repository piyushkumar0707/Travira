import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

const EmergencyContact = () => {
  const { apiRequest } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null); // { text, isError }

  useEffect(() => {
    const load = async () => {
      const result = await apiRequest('/api/profile/emergency-contact');
      if (result.error) setMessage({ text: result.error, isError: true });
      else setEmail(result.data.email);
      setLoading(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    const result = await apiRequest('/api/profile/emergency-contact', {
      method: 'PUT',
      body: JSON.stringify({ email: email.trim() }),
    });
    if (result.error) {
      setMessage({ text: result.error, isError: true });
    } else {
      setEmail(result.data.email);
      setMessage({ text: result.data.email ? 'Emergency contact saved.' : 'Emergency contact removed.', isError: false });
    }
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white shadow rounded-lg p-6 space-y-4 mt-6">
      <div>
        <label htmlFor="emergency-email" className="block text-sm font-medium text-gray-700">Emergency contact email</label>
        <p className="text-sm text-gray-500">This address is emailed if you press the panic button or enter a restricted zone. Leave it empty to turn these emails off.</p>
        <input
          id="emergency-email"
          type="email"
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm"
          placeholder="family@example.com"
        />
      </div>
      {message && (
        <p role="status" className={`text-sm ${message.isError ? 'text-red-700' : 'text-green-700'}`}>{message.text}</p>
      )}
      <button type="submit" disabled={loading || saving} className="px-4 py-2 rounded-md bg-blue-600 text-white disabled:opacity-50">
        {saving ? 'Saving...' : 'Save contact'}
      </button>
    </form>
  );
};

const Profile = () => {
  const { user } = useAuth();

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-xl font-semibold mb-4">Profile Settings</h2>
      {user?.role === 'tourist' ? (
        <dl className="bg-white shadow rounded-lg p-6 space-y-4">
          <div>
            <dt className="text-sm font-medium text-gray-700">Username</dt>
            <dd className="text-gray-900">{user.username}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-700">Email</dt>
            <dd className="text-gray-900 break-all">{user.email}</dd>
          </div>
        </dl>
      ) : (
      <div className="bg-white shadow rounded-lg p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Username</label>
          <input className="mt-1 block w-full border-gray-300 rounded-md shadow-sm" placeholder="admin" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Email</label>
          <input type="email" className="mt-1 block w-full border-gray-300 rounded-md shadow-sm" placeholder="admin@example.com" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Change Password</label>
          <input type="password" className="mt-1 block w-full border-gray-300 rounded-md shadow-sm" placeholder="New password" />
        </div>
        <button className="px-4 py-2 rounded-md bg-blue-600 text-white">Save Changes</button>
      </div>
      )}
      {user?.role === 'tourist' && <EmergencyContact />}
    </div>
  );
};

export default Profile;
