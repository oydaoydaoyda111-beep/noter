import './styles/tokens.css';
import './styles/app.css';
import './styles/editor.css';
import './styles/database.css';
import { startApp } from './app';

startApp(document.querySelector<HTMLElement>('#app')!);
