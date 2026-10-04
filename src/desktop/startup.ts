import { desktop, selectedFolder, chooseFolder } from './platform';
import { el, button } from '../ui/dom';
export async function prepareWorkspace(mount: HTMLElement) {
  if (!desktop) {
    const shell = el('main', 'desktop-setup'), card = el('section', 'desktop-setup-card');
    card.append(el('h1', '', 'Open Noter on desktop or Android.'), el('p', '', 'Your workspace lives in local files that you can sync with Syncthing. The browser app has been retired.'));
    shell.append(card); mount.replaceChildren(shell);
    return false;
  }
  if (await selectedFolder()) return true;
  showWorkspaceSetup(mount); return false;
}
export function showWorkspaceSetup(mount: HTMLElement, problem?: unknown) {
  mount.replaceChildren();
  const shell = el('main', 'desktop-setup'), card = el('section', 'desktop-setup-card');
  card.append(el('span', 'empty-eyebrow', 'NOTER · YOUR FILES, YOUR WORKSPACE'), el('h1', '', 'Choose a home for your notes.'), el('p', '', 'Open an existing Markdown folder or choose an empty folder. Noter saves notes as .md files, ready to sync with Syncthing.'), el('p', 'setting-description', 'Sync the whole folder, including .noter, to keep settings, databases, and Finance together.'));
  const choose = button('Choose workspace folder', 'button-primary'); choose.textContent = 'Choose workspace folder';
  const status = el('p', 'finance-error'); status.setAttribute('role', 'alert'); if (problem) status.textContent = String(problem);
  choose.onclick = async () => { choose.disabled = true; try { if (await chooseFolder()) location.reload(); } catch (error) { status.textContent = String(error); } finally { choose.disabled = false; } };
  const retry = button('Retry opening workspace', 'button-secondary'); retry.textContent = 'Retry'; retry.onclick = () => location.reload();
  card.append(choose); if (problem) card.append(retry); card.append(status); shell.append(card); mount.append(shell);
}
