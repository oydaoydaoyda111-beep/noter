import type { Workspace } from '../types';
import { defaultSettings } from '../settings/model';
export { defaultSettings } from '../settings/model';

export function emptyWorkspace(): Workspace {
  return {
    version: 1, nodes: {}, rootIds: [], openTabs: [], activeNoteId: null,
    collapsedFolders: [], settings: { ...defaultSettings },
  };
}

export function demoWorkspace(): Workspace {
  const workspace = emptyWorkspace();
  const now = Date.now();
  const folder = (id: string, name: string, parentId: string | null, children: string[]) => {
    workspace.nodes[id] = { id, name, parentId, type: 'folder', children, createdAt: now, updatedAt: now };
  };
  const note = (id: string, name: string, parentId: string | null, markdown: string) => {
    workspace.nodes[id] = { id, name, parentId, type: 'note', markdown, createdAt: now, updatedAt: now };
  };
  folder('personal', 'Personal', null, ['daily', 'reading']);
  folder('daily', 'Daily Notes', 'personal', ['oct-2', 'oct-1']);
  folder('projects', 'Projects', null, ['notes-app', 'ideas']);
  note('welcome', 'Welcome', null, `A little room to think. A home for your notes, ideas, and everything in between.

## Make yourself at home

Noter is a quieter place to put things down. Your words stay on your device, ready whenever you need them. No accounts. No distractions. Just you and the page.

This is a **living document**. Click anywhere and start writing. Your formatting stays visible as you work, and every change is saved automatically.

## Find your flow

- **Start a thought.** Create a note with the + button, or press Ctrl / ⌘ + N.
- **Give it a home.** Keep related notes together in folders.
- **Follow your curiosity.** Open a few notes in tabs and move between them.
- **Find it again.** Search every note from the sidebar with Ctrl / ⌘ + F.

> You don't have to capture everything. Just the things you want to come back to.

## A few small details

Try typing \`# \` for a heading, \`- \` for a list, or \`> \` for a quote. Wrap a word in **bold** or *italic*, add \`inline code\`, or use the formatting bar above.

\`\`\`typescript
const thought = "Something worth keeping.";
const nextStep = () => write(thought);
\`\`\`

---

Built around the simplicity of [Markdown](https://www.markdownguide.org/basic-syntax/). Made for the way you think.`);
  note('oct-2', 'October 2', 'daily', `## Friday, October 2

A slow start, a clear head. The best ideas this week came from leaving a little space between things.

### Today’s intentions

- Finish the first version of Noter.
- Take a walk without headphones.
- Read a chapter before bed.

### A thought to keep

> Make fewer things, but make them with care.

The afternoon is for **focused work**. Everything else can wait.`);
  note('oct-1', 'October 1', 'daily', `## Thursday, October 1

The beginning of a new month. A good moment to reset.

1. Clear the desk.
2. Write down what matters.
3. Choose one thing to finish.

*Small steps count, especially the quiet ones.*`);
  note('reading', 'Reading List', 'personal', `## On the nightstand

A few books to spend time with, rather than rush through.

- **The Creative Act** — Rick Rubin
- **A Philosophy of Walking** — Frédéric Gros
- **The Book of Disquiet** — Fernando Pessoa

### Notes from reading

> Attention is a kind of generosity.

Keep a note open while reading. Save the sentences that make you pause, and add a few words about *why*.`);
  note('notes-app', 'Notes App', 'projects', `## A calmer kind of notes app

The idea is simple: make a place that feels good to think in. Every detail should earn its place.

### Principles

1. **The document comes first.** Keep the interface out of the way.
2. **Keep it yours.** Markdown files and local storage.
3. **Make the small things feel right.** Typography, focus, and motion.

### The first version

- Direct visual Markdown editing
- Folders and multiple open notes
- Fast full-text search
- A few thoughtful settings

\`\`\`typescript
interface Idea {
  title: string;
  worthExploring: boolean;
}
\`\`\`

---

The goal: *less friction between a thought and a page.*`);
  note('ideas', 'Ideas', 'projects', `## Things worth exploring

An open-ended list. Some will become projects. Most will just be interesting.

### A tiny ritual

Spend ten minutes every Friday revisiting the week’s notes. Notice what keeps coming up.

### A better bookshelf

Organize books by the questions they answer, rather than by author.

### Space for unfinished thoughts

> An idea doesn't need to be useful to be worth writing down.

Leave the rest of this page open.`);
  workspace.rootIds = ['welcome', 'personal', 'projects'];
  workspace.openTabs = ['welcome', 'notes-app'];
  workspace.activeNoteId = 'welcome';
  return workspace;
}
