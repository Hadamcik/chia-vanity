import { createRoot } from 'react-dom/client';

import App from './App.tsx';

const element = document.getElementById('root') as HTMLElement;
createRoot(element).render(<App />);
