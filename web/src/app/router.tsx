import { Navigate, createBrowserRouter } from 'react-router'
import { routerBasename } from '../lib/api'
import { ConnectPage } from './connect/ConnectPage'
import { WorkspaceRoute } from './Workspace'

export const router = createBrowserRouter(
  [
    { path: '/', element: <ConnectPage /> },
    { path: '/c/:conn/:view?', element: <WorkspaceRoute /> },
    { path: '*', element: <Navigate to="/" replace /> },
  ],
  { basename: routerBasename() },
)
