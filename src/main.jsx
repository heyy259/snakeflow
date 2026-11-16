import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App.jsx';
import { installApiSession } from './se/session.js';

installApiSession();

createRoot(document.getElementById('root')).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>
);
