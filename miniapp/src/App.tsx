import { useEffect, useState } from 'react';
import UploadScreen from './components/UploadScreen';
import UploadsListScreen from './components/UploadsListScreen';
import SettingsScreen from './components/SettingsScreen';
import HelpScreen from './components/HelpScreen';

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

interface TelegramWebApp {
  init: () => void;
  expand: () => void;
  ready: () => void;
  close: () => void;
  initData: string;
  initDataUnsafe: {
    user?: TelegramUser;
  } | null;
}

declare global {
  interface Window {
    Telegram: {
      WebApp: TelegramWebApp;
    };
  }
}

type Screen = 'upload' | 'uploads' | 'settings' | 'help';

function App() {
  const [screen, setScreen] = useState<Screen>('upload');
  const [user, setUser] = useState<TelegramUser | null>(null);
  const [initData, setInitData] = useState<string>('');

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    tg.init();
    tg.expand();
    tg.ready();

    const user = tg.initDataUnsafe?.user || null;
    const initData = tg.initData || '';

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

  const navigate = (newScreen: Screen) => {
    setScreen(newScreen);
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Video Clipper</h1>
        <div className="user-info">
          {user.first_name} {user.last_name || ''}
        </div>
      </header>
      <main className="main">
        {screen === 'upload' && <UploadScreen initData={initData} uploadId={new URLSearchParams(window.location.search).get('upload_id')} onNavigate={navigate} />}
        {screen === 'uploads' && <UploadsListScreen initData={initData} onNavigate={navigate} />}
        {screen === 'settings' && <SettingsScreen initData={initData} user={user} />}
        {screen === 'help' && <HelpScreen />}
      </main>
      <nav className="bottom-nav">
        <button className={screen === 'upload' ? 'active' : ''} onClick={() => navigate('upload')}>
          <span className="icon">🎬</span>
          <span>Upload</span>
        </button>
        <button className={screen === 'uploads' ? 'active' : ''} onClick={() => navigate('uploads')}>
          <span className="icon">📂</span>
          <span>My Uploads</span>
        </button>
        <button className={screen === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}>
          <span className="icon">⚙️</span>
          <span>Settings</span>
        </button>
        <button className={screen === 'help' ? 'active' : ''} onClick={() => navigate('help')}>
          <span className="icon">❓</span>
          <span>Help</span>
        </button>
      </nav>
    </div>
  );
}

export default App;