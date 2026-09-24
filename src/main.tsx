import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {FloatingAvatarApp} from './components/FloatingAvatarApp.tsx';
import {RemoteMobileApp} from './components/remote/RemoteMobileApp.tsx';
import {ApiKeyGate} from './components/ApiKeyGate.tsx';
import './index.css';

const params = new URLSearchParams(window.location.search);
const isFloating = params.get('mode') === 'floating' || window.location.hash.includes('floating');
const isRemote =
  params.get('mode') === 'remote' ||
  window.location.pathname === '/remote' ||
  window.location.pathname.startsWith('/remote/') ||
  window.location.hash.includes('remote');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isRemote ? (
      <RemoteMobileApp />
    ) : isFloating ? (
      <FloatingAvatarApp />
    ) : (
      <ApiKeyGate>
        <App />
      </ApiKeyGate>
    )}
  </StrictMode>,
);
