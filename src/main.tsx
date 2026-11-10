import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ExecutionRecords } from './components/ExecutionRecords';
import { SharedTestReport } from './components/SharedTestReport';
import './styles.css';

const sharePath = window.location.pathname.match(/^\/share(?:\/([^/]*))?\/?$/);
const recordsPath = window.location.pathname.match(/^\/records(?:\/([^/]*))?\/?$/);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {sharePath
      ? <SharedTestReport token={sharePath[1] || ''} />
      : recordsPath
        ? <ExecutionRecords initialRunId={recordsPath[1] || ''} />
        : <App />}
  </StrictMode>,
);
