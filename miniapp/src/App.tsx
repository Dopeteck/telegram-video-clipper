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
  ready: () => void;
  expand: () => void;
  close: () => void;
  initData: string;
  initDataUnsafe: {
    user?: TelegramUser;
  } | null;
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  viewportHeight: number;
  viewportStableHeight: number;
  headerColor: string;
  backgroundColor: string;
  isExpanded: boolean;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  onEvent: (eventType: string, eventHandler: () => void) => void;
  offEvent: (eventType: string, eventHandler: () => void) => void;
  sendData: (data: string) => void;
  openTelegramLink: (url: string) => void;
  openLink: (url: string, options?: { try_instant_view?: boolean }) => void;
  openInvoice: (url: string, callback?: (status: string) => void) => void;
  showPopup: (params: { title?: string; message: string; buttons?: Array<{ id: string; type?: 'default' | 'ok' | 'close' | 'cancel' | 'destructive'; text: string }> }, callback?: (buttonId: string) => void) => void;
  showAlert: (message: string, callback?: () => void) => void;
  showConfirm: (message: string, callback?: (confirmed: boolean) => void) => void;
  showScanQrPopup: (params: { text?: string }, callback?: (data: string) => void) => void;
  closeScanQrPopup: () => void;
  readTextFromClipboard: (callback?: (text: string) => void) => void;
  requestWriteAccess: (callback?: (granted: boolean) => void) => void;
  requestContact: (callback?: (granted: boolean) => void) => void;
  setBottomBarColor: (color: string) => void;
}

declare global {
  interface Window {
    Telegram: {
      WebApp: TelegramWebApp;
    };
  }
}

type Screen = 'upload' | 'uploads' | 'settings' | 'help';

type NavigateFn = (screen: Screen) => void;

interface AppProps {
  apiBaseUrl: string;
}

type AppState = 
  | { status: 'loading' }
  | { status: 'outside_telegram' }
  | { status: 'missing_user_data' }
  | { status: 'error'; message: string }
  | { status: 'ready'; user: TelegramUser; initData: string };

function App({ apiBaseUrl }: AppProps) {
  const [state, setState] = useState<AppState>({ status: 'loading' });
  const [screen, setScreen] = useState<Screen>('upload');

  useEffect(() => {
    let mounted = true;

    const initialize = () => {
      try {
        const tg = window.Telegram?.WebApp;
        
        if (!tg) {
          if (mounted) {
            setState({ status: 'outside_telegram' });
          }
          return;
        }

        // Call documented lifecycle methods
        tg.ready();
        tg.expand();

        const user = tg.initDataUnsafe?.user;
        const initData = tg.initData || '';

        if (!user) {
          if (mounted) {
            setState({ status: 'missing_user_data' });
          }
          return;
        }

        if (mounted) {
          setState({ status: 'ready', user, initData });
        }
      } catch (error) {
        if (mounted) {
          setState({ 
            status: 'error', 
            message: error instanceof Error ? error.message : 'Initialization failed' 
          });
        }
      }
    };

    initialize();

    return () => {
      mounted = false;
    };
  }, []);

  const navigate: NavigateFn = (newScreen) => {
    setScreen(newScreen);
  };

  // Render based on state
  if (state.status === 'loading') {
    return (
      <div className="app loading">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  if (state.status === 'outside_telegram') {
    return (
      <div className="app error-screen">
        <div className="error-content">
          <div className="error-icon">📱</div>
          <h2>Open in Telegram</h2>
          <p>
            This application must be opened from the Telegram bot.
            <br />
            Please open the bot <b>@your_bot_username</b> and tap 
            <b>"🎬 Upload Video"</b> to launch the Mini App.
          </p>
          <p className="hint">
            The Mini App will not work in a regular browser.
          </p>
        </div>
      </div>
    );
  }

  if (state.status === 'missing_user_data') {
    return (
      <div className="app error-screen">
        <div className="error-content">
          <div className="error-icon">⚠️</div>
          <h2>Authentication Required</h2>
          <p>
            Unable to retrieve your Telegram account information.
            <br />
            Please reopen the Mini App from the bot or restart Telegram.
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="app error-screen">
        <div className="error-content">
          <div className="error-icon">💥</div>
          <h2>Initialization Error</h2>
          <p>{state.message}</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  // state.status === 'ready'
  const user = state.user;
  const initData = state.initData;
  const uploadMode = new URLSearchParams(window.location.search).get('mode') === 'broll' ? 'broll' : 'video';

  return (
    <div className="app">
      <header className="header">
        <h1>{uploadMode === 'broll' ? 'B-roll Library' : 'Video Clipper'}</h1>
        <div className="user-info">
          {user.first_name} {user.last_name || ''}
        </div>
      </header>
      <main className="main">
        {screen === 'upload' && <UploadScreen apiBaseUrl={apiBaseUrl} initData={initData} uploadId={new URLSearchParams(window.location.search).get('upload_id')} mode={uploadMode} onNavigate={navigate} />}
        {screen === 'uploads' && <UploadsListScreen apiBaseUrl={apiBaseUrl} initData={initData} onNavigate={navigate} />}
        {screen === 'settings' && <SettingsScreen apiBaseUrl={apiBaseUrl} initData={initData} user={user} />}
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