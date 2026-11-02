import React, { useEffect, useState } from 'react';
import { WebApp } from '@telegram-apps/sdk';
import UploadScreen from './components/UploadScreen';
import UploadsListScreen from './components/UploadsListScreen';
import SettingsScreen from './components/SettingsScreen';
import HelpScreen from './components/HelpScreen';

type Screen = 'upload' | 'uploads' | 'settings' | 'help';

function App() {
  const [screen, setScreen] = useState<Screen>('upload');
  const [user, setUser] = useState<WebApp.User | null>(null);
  const [initData, setInitData] = useState<string>('');

  useEffect(() => {
    WebApp.init();
    WebApp.expand();
    WebApp.ready();

    const user = WebApp.initDataUnsafe?.user || null;
    const initData = WebApp.initData || '';

    setUser(user);
    setInitData(initData);

    const params = new URLSearchParams(window.location.search);
    const uploadId = params.get('upload_id');
    if (uploadId) {
      setScreen('upload');
    }
  }, []);

  if (!user) {
    return (
      <div className="app loading">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Video Clipper</h1>
        <div className="user-info">
          {user.first_name} {user.last_name || ''}
        </div>
      </header>
      <main className="main">
        {screen === 'upload' && <UploadScreen initData={initData} uploadId={new URLSearchParams(window.location.search).get('upload_id')} onNavigate={setScreen} />}
        {screen === 'uploads' && <UploadsListScreen initData={initData} onNavigate={setScreen} />}
        {screen === 'settings' && <SettingsScreen initData={initData} user={user} />}
        {screen === 'help' && <HelpScreen />}
      </main>
      <nav className="bottom-nav">
        <button className={screen === 'upload' ? 'active' : ''} onClick={() => setScreen('upload')}>
          <span className="icon">🎬</span>
          <span>Upload</span>
        </button>
        <button className={screen === 'uploads' ? 'active' : ''} onClick={() => setScreen('uploads')}>
          <span className="icon">📂</span>
          <span>My Uploads</span>
        </button>
        <button className={screen === 'settings' ? 'active' : ''} onClick={() => setScreen('settings')}>
          <span className="icon">⚙️</span>
          <span>Settings</span>
        </button>
        <button className={screen === 'help' ? 'active' : ''} onClick={() => setScreen('help')}>
          <span className="icon">❓</span>
          <span>Help</span>
        </button>
      </nav>
    </div>
  );
}

export default App;