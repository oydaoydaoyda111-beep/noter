import './styles/tokens.css';
import './styles/app.css';
import './styles/editor.css';
import './styles/database.css';
import './styles/finance.css';
import './styles/planner.css';
import { startApp } from './app';

import { prepareWorkspace, showWorkspaceSetup } from './desktop/startup';
const mount = document.querySelector<HTMLElement>('#app')!;
void prepareWorkspace(mount).then(ready => ready ? startApp(mount) : undefined).catch(error => showWorkspaceSetup(mount, error));
