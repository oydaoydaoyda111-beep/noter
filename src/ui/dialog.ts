import { button, el } from './dom';
import { icon } from './icons';
import { animateOut } from './motion';

interface DialogOptions {
  title: string;
  description?: string;
  fields?: { name: string; label: string; value?: string; placeholder?: string; type?: string }[];
  submit: string;
  danger?: boolean;
}

export function askDialog(options: DialogOptions): Promise<Record<string, string> | null> {
  return new Promise(resolve => {
    const dialog = el('dialog', 'dialog');
    const form = el('form');
    const header = el('div', 'dialog-header');
    const title = el('h2', '', options.title);
    title.id = 'dialog-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const close = button('Close dialog');
    close.append(icon('close'));
    header.append(title, close);
    form.append(header);
    if (options.description) form.append(el('p', 'dialog-description', options.description));
    for (const field of options.fields ?? []) {
      const label = el('label', 'field-label', field.label);
      const input = el('input', 'field-input');
      input.name = field.name;
      input.type = field.type ?? 'text';
      input.value = field.value ?? '';
      input.placeholder = field.placeholder ?? '';
      input.required = true;
      input.maxLength = field.name === 'name' ? 120 : 2000;
      input.autocomplete = 'off';
      label.append(input);
      form.append(label);
    }
    const actions = el('div', 'dialog-actions');
    const cancel = button('Cancel', 'button-secondary');
    cancel.textContent = 'Cancel';
    const submit = el('button', options.danger ? 'button-danger' : 'button-primary', options.submit);
    submit.type = 'submit';
    actions.append(cancel, submit);
    form.append(actions);
    dialog.append(form);
    document.body.append(dialog);
    let result: Record<string, string> | null = null;
    let closing = false;
    const finish = async () => {
      if (closing) return;
      closing = true;
      await animateOut(dialog);
      dialog.close();
    };
    form.addEventListener('submit', event => {
      event.preventDefault();
      result = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
      void finish();
    });
    close.onclick = cancel.onclick = () => void finish();
    dialog.addEventListener('cancel', event => { event.preventDefault(); void finish(); });
    dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) void finish(); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
    dialog.showModal();
    const firstInput = form.querySelector('input');
    if (firstInput) { firstInput.focus(); firstInput.select(); } else cancel.focus();
  });
}
