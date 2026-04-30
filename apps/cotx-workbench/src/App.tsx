import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { WorkbenchRoute } from './routes/WorkbenchRoute.js';
import { WorkbenchHomeRoute } from './routes/WorkbenchHomeRoute.js';

function WorkbenchProjectRedirect() {
  const { project = 'default' } = useParams<{ project: string }>();
  return (
    <Navigate
      to={`/workbench/${encodeURIComponent(project)}/overall-architecture`}
      replace
    />
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/workbench" element={<WorkbenchHomeRoute />} />
        <Route path="/workbench/:project" element={<WorkbenchProjectRedirect />} />
        <Route
          path="/workbench/:project/:perspective"
          element={<WorkbenchRoute />}
        />
        <Route path="*" element={<Navigate to="/workbench" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
