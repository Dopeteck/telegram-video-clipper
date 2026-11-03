import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// Set API base URL from environment variable or default to current origin
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || window.location.origin;
console.log('API Base URL:', API_BASE_URL);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App apiBaseUrl={API_BASE_URL} />
  </React.StrictMode>
);