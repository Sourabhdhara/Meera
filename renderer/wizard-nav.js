document.querySelector('[data-wizard-back]')?.addEventListener('click', () => {
  window.wizard.navigate('menu');
});

// Load & apply theme across all wizard pages
