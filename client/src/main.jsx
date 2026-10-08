import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Phone from './Phone.jsx';
import './styles.css';

// No router: /phone is the SMS simulator, everything else the dashboard.
const Page = window.location.pathname.replace(/\/+$/, '') === '/phone' ? Phone : App;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
