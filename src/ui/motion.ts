export function motionAllowed(): boolean {
  return document.documentElement.dataset.motion !== 'none' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export async function animateOut(element: HTMLElement): Promise<void> {
  if (!motionAllowed()) return;
  await element.animate([
    { opacity: 1, transform: 'translateY(0)' },
    { opacity: 0, transform: 'translateY(4px)' },
  ], { duration: 130, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
}

export function animateDocument(element: HTMLElement) {
  if (!motionAllowed()) return;
  element.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], {
    duration: document.documentElement.dataset.motion === 'subtle' ? 130 : 230,
    easing: 'cubic-bezier(.16,1,.3,1)',
  });
}
