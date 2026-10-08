import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Import from './Import.jsx';
import Phone from './Phone.jsx';
import './styles.css';

// No router: /phone is the SMS simulator, /import the teacher photo import,
// everything else the dashboard.
const PAGES = { '/phone': Phone, '/import': Import };
const Page = PAGES[window.location.pathname.replace(/\/+$/, '')] ?? App;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
