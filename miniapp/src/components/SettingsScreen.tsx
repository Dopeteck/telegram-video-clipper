import React, { useState, useEffect, useCallback } from 'react';

interface User {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface Profile {
  telegram_user_id: number;
  preferred_aspect_ratio: string;
  preferred_caption_style: string;
  enable_tighten: number;
  enable_loudnorm: number;
}

interface Props {
  initData: string;
  user: User;
}

const SettingsScreen: React.FC<Props> = ({ initData, user }) => {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const apiRequest = useCallback(async (endpoint: string, options: RequestInit = {}) => {
    const response = await fetch(endpoint, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${initData}`,
        ...options.headers,
      },
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data.data;
  }, [initData]);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      const data = await apiRequest('/api/user/profile');
      setProfile(data);
    } catch (e) {
      console.error('Failed to load profile', e);
    } finally {
      setLoading(false);
    }
  };

  const saveProfile = async (updates: Partial<Profile>) => {
    if (!profile) return;
    setSaving(true);
    try {
      await apiRequest('/api/user/profile', {
        method: 'POST',
        body: JSON.stringify(updates),
      });
      setProfile({ ...profile, ...updates });
    } catch (e) {
      console.error('Failed to save profile', e);
    } finally {
      setSaving(false);
    }
  };

  const toggleSetting = (key: 'enable_tighten' | 'enable_loudnorm', value: number) => {
    saveProfile({ [key]: value });
  };

  if (loading) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <div className="spinner" style={{ margin: '0 auto 16px' }}></div>
        <p>Loading settings...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2 className="card-title">Processing Preferences</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
          These settings will be applied to future video processing jobs.
        </p>
        
        <div className="setting-item">
          <div>
            <div className="setting-label">Aspect Ratio</div>
            <div className="setting-value">Vertical 9:16 (Shorts/Reels/TikTok)</div>
          </div>
        </div>
        
        <div className="setting-item">
          <div>
            <div className="setting-label">Caption Style</div>
            <div className="setting-value">Default</div>
          </div>
        </div>
        
        <div className="setting-item">
          <div>
            <div className="setting-label">Remove Filler Words</div>
            <div className="setting-value">Automatically remove "um", "uh", and long silences</div>
          </div>
          <button
            className={`toggle ${profile?.enable_tighten ? 'active' : ''}`}
            onClick={() => toggleSetting('enable_tighten', profile?.enable_tighten ? 0 : 1)}
          />
        </div>
        
        <div className="setting-item">
          <div>
            <div className="setting-label">Audio Normalization</div>
            <div className="setting-value">Normalize audio to -14 LUFS (platform standard)</div>
          </div>
          <button
            className={`toggle ${profile?.enable_loudnorm ? 'active' : ''}`}
            onClick={() => toggleSetting('enable_loudnorm', profile?.enable_loudnorm ? 0 : 1)}
          />
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Account</h2>
        <div className="setting-item">
          <div>
            <div className="setting-label">Name</div>
            <div className="setting-value">{user.first_name} {user.last_name || ''}</div>
          </div>
        </div>
        {user.username && (
          <div className="setting-item">
            <div>
              <div className="setting-label">Username</div>
              <div className="setting-value">@{user.username}</div>
            </div>
          </div>
        )}
        <div className="setting-item">
          <div>
            <div className="setting-label">User ID</div>
            <div className="setting-value">{user.id}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">About</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>
          <strong>Telegram Video Clipper</strong> uses <strong>Chopify</strong> — a free, local, open-source video clipping engine.
          Videos are uploaded to private Cloudflare R2 storage and processed locally using your Chopify instance.
        </p>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 12 }}>
          Version 0.1.0 • MIT License
        </p>
      </div>
    </div>
  );
};

export default SettingsScreen;