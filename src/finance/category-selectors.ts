import { el, button } from '../ui/dom';
import type { FinanceCategory } from './categories';

interface Selection { category: string; subcategory: string }
interface Choice { title: string; detail: string; category: string; subcategory: string; create?: boolean }
const normalize = (value: string) => value.trim().toLocaleLowerCase();

export function createCategorySelectors(initialCatalog: FinanceCategory[], initial: Selection, locked = false) {
  const catalog = initialCatalog.map(item => ({ name: item.name, subcategories: [...item.subcategories] }));
  let selection = { ...initial };
  const root = el('div', 'finance-category-fields');
  const categoryButton = button('Choose category', 'field-input finance-select-button');
  const subcategoryButton = button('Choose subcategory', 'field-input finance-select-button');
  for (const [label, control] of [['Category', categoryButton], ['Subcategory', subcategoryButton]] as const) {
    const field = el('div', 'field-label'); field.append(el('span', '', label), control); root.append(field);
    control.setAttribute('aria-haspopup', 'dialog');
  }
  function render() {
    categoryButton.replaceChildren(el('span', '', selection.category || 'Uncategorized'), el('span', 'finance-select-chevron', '⌄'));
    subcategoryButton.replaceChildren(el('span', '', selection.subcategory || (selection.category ? 'Choose subcategory…' : 'Choose a category first')), el('span', 'finance-select-chevron', '⌄'));
    categoryButton.disabled = locked;
    subcategoryButton.disabled = locked || !selection.category;
    categoryButton.setAttribute('aria-label', `Choose category, ${selection.category || 'Uncategorized'}`);
    subcategoryButton.setAttribute('aria-label', `Choose subcategory, ${selection.subcategory || 'None'}`);
    categoryButton.setAttribute('aria-expanded', 'false'); subcategoryButton.setAttribute('aria-expanded', 'false');
  }
  function open(mode: 'category' | 'subcategory') {
    const trigger = mode === 'category' ? categoryButton : subcategoryButton;
    const dialog = el('dialog', 'dialog finance-picker-dialog');
    dialog.setAttribute('aria-label', mode === 'category' ? 'Choose category' : 'Choose subcategory');
    const header = el('div', 'dialog-header');
    const close = button('Close selector'); close.textContent = '×'; close.onclick = () => dialog.close();
    header.append(el('h2', '', mode === 'category' ? 'Choose category' : 'Choose subcategory'), close);
    const search = el('input', 'field-input'); search.type = 'search'; search.maxLength = 120;
    search.placeholder = mode === 'category' ? 'Search categories or subcategories…' : 'Search subcategories…';
    search.setAttribute('aria-label', mode === 'category' ? 'Search categories' : 'Search subcategories');
    search.setAttribute('role', 'combobox'); search.setAttribute('aria-autocomplete', 'list'); search.setAttribute('aria-expanded', 'true');
    const list = el('div', 'finance-picker-list'); list.id = `category-options-${crypto.randomUUID()}`; list.setAttribute('role', 'listbox');
    search.setAttribute('aria-controls', list.id);
    const hint = el('p', 'finance-picker-hint', mode === 'category' ? 'Choose a category, or select a subcategory directly.' : selection.category);
    const count = el('p', 'finance-picker-hint'); count.setAttribute('role', 'status');
    dialog.append(header, hint, search, count, list);
    let active = 0, choices: Choice[] = [];
    function choose(choice: Choice) {
      if (choice.create) {
        let parent = catalog.find(item => item.name === choice.category);
        if (!parent) { parent = { name: choice.category, subcategories: [] }; catalog.push(parent); }
        if (choice.subcategory && !parent.subcategories.includes(choice.subcategory)) parent.subcategories.push(choice.subcategory);
      }
      selection = { category: choice.category, subcategory: mode === 'category' && !choice.subcategory && choice.category === selection.category ? selection.subcategory : choice.subcategory };
      render(); dialog.close();
    }
    function highlight() {
      const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
      options.forEach((option, index) => {
        option.classList.toggle('is-highlighted', index === active);
        // Selection is the stored value; focus is indicated by aria-activedescendant.
      });
      const current = options[active];
      if (current) { search.setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' }); }
      else search.removeAttribute('aria-activedescendant');
    }
    function update() {
      const query = normalize(search.value), parent = catalog.find(item => item.name === selection.category);
      choices = [];
      if (!query) choices.push({ title: mode === 'category' ? 'Uncategorized' : 'No subcategory', detail: 'Clear selection', category: mode === 'category' ? '' : selection.category, subcategory: '' });
      if (mode === 'category') {
        for (const category of catalog) {
          const parentMatches = normalize(category.name).includes(query);
          const children = category.subcategories.filter(name => parentMatches || normalize(name).includes(query));
          if (parentMatches || children.length) choices.push({ title: category.name, detail: `${category.subcategories.length} ${category.subcategories.length === 1 ? 'subcategory' : 'subcategories'}`, category: category.name, subcategory: '' });
          // Browse categories first; searching reveals matching paths for one-click selection.
          if (query) for (const name of children) choices.push({ title: name, detail: category.name, category: category.name, subcategory: name });
        }
      } else for (const name of parent?.subcategories ?? []) if (normalize(name).includes(query)) choices.push({ title: name, detail: selection.category, category: selection.category, subcategory: name });
      const name = search.value.trim();
      const exists = mode === 'category' ? catalog.some(item => normalize(item.name) === query) : parent?.subcategories.some(item => normalize(item) === query);
      if (name && !exists) choices.push({ title: `+ Create “${name}”`, detail: mode === 'category' ? 'New category' : `New subcategory in ${selection.category}`, category: mode === 'category' ? name : selection.category, subcategory: mode === 'subcategory' ? name : '', create: true });
      list.replaceChildren(); active = 0;
      const matches = choices.filter(choice => !choice.create).length;
      count.textContent = query ? `${matches} ${matches === 1 ? 'match' : 'matches'}` : '↑ ↓ to browse · Enter to select';
      for (const [index, choice] of choices.entries()) {
        const option = button(choice.title, `finance-picker-option${choice.create ? ' is-create' : ''}`);
        option.setAttribute('role', 'option'); option.tabIndex = -1; option.id = `${list.id}-${index}`;
        const selected = !choice.create && choice.category === selection.category && choice.subcategory === (mode === 'category' && !choice.subcategory ? '' : selection.subcategory);
        option.setAttribute('aria-selected', String(selected));
        const copy = el('span', 'finance-picker-copy'); copy.append(el('span', '', choice.title), el('small', '', choice.detail));
        option.append(copy, el('span', 'finance-picker-check', selected ? '✓' : ''));
        option.onclick = () => choose(choice); list.append(option);
      }
      if (!choices.length) list.append(el('p', 'finance-no-results', 'No subcategories yet. Type a name to create one.'));
      if (!query) {
        const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
        const selected = options.findIndex(option => option.getAttribute('aria-selected') === 'true');
        if (selected >= 0) active = selected;
      }
      highlight();
    }
    search.oninput = update;
    search.onkeydown = event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); active = Math.max(0, Math.min(choices.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))); highlight();
      } else if (event.key === 'Enter') { event.preventDefault(); if (choices[active]) choose(choices[active]); }
    };
    dialog.addEventListener('close', () => { dialog.remove(); trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); }, { once: true });
    document.body.append(dialog); dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); update(); search.focus();
  }
  categoryButton.onclick = () => open('category'); subcategoryButton.onclick = () => open('subcategory'); render();
  return { root, value: () => ({ ...selection }) };
}
