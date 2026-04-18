import { createRoot } from 'react-dom/client';
import './index.css';

import App from './App.tsx';

const element = document.getElementById('root') as HTMLElement;
createRoot(element).render(<App />);
