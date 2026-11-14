document.querySelector('#close').addEventListener('click', () => window.close());
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => {
    window.wizard.navigate(button.dataset.action);
  });
}
