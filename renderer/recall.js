const categories = {
  identity: 'Identity Core',
  preference: 'Preferences',
  goal: 'Life Goals',
  project: 'Active Projects',
  relationship: 'Relationships',
  emotional: 'Milestones',
  behavior: 'Behaviors & Habits',
  practice: 'Practices & Rules',
};

const list = document.querySelector('#memories');
const status = document.querySelector('#recall-status');
const count = document.querySelector('#count');
const filters = document.querySelector('#filters');
const seedCategories = document.querySelector('#seed-categories');
const form = document.querySelector('#seed-form');
const seed = document.querySelector('#seed');
const refresh = document.querySelector('#refresh');
const input = document.querySelector('#memory-text');
const submit = form.querySelector('[type="submit"]');
let memories = [];
let filter = 'all';
let category = 'identity';
let busy = false;
let loaded = false;

function showStatus(message, error = false) {
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('error', error);
}

function setSeedOpen(open) {
  form.hidden = !open;
  seed.setAttribute('aria-expanded', String(open));
  if (open) input.focus();
  else seed.focus();
}

function markSelected(container, value) {
  for (const button of container.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.category === value));
  }
}

function addCategoryButton(container, key, label, select) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'recall-chip';
  button.dataset.category = key;
  button.textContent = label;
  button.addEventListener('click', () => select(key));
  container.append(button);
}

function renderMemories() {
  const visible = filter === 'all' ? memories : memories.filter(memory => memory.category === filter);
  if (loaded) count.textContent = `Saved recollections (${memories.length})`;
  list.replaceChildren(...visible.map(memory => {
    const item = document.createElement('li');
    item.className = 'memory-entry';
    item.dataset.category = memory.category;
    const meta = document.createElement('span');
    meta.className = 'memory-category';
    meta.textContent = categories[memory.category] ?? 'Other';
    const text = document.createElement('p');
    text.textContent = memory.text;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'recall-chip remove-memory';
    remove.textContent = 'Delete';
    remove.disabled = busy;
    remove.addEventListener('click', () => {
      if (window.confirm('Delete this recollection from MEERA?')) {
        void update(async () => {
          const result = await window.recall.remove(memory.id);
          if (!result.success) throw new Error('Delete failed');
          memories = memories.filter(entry => entry.id !== memory.id);
        }, 'Could not delete this recollection.');
      }
    });
    item.append(meta, remove, text);
    return item;
  }));
  if (loaded && !visible.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-memory';
    empty.textContent = filter === 'all' ? 'No memories recorded yet.' : 'No recollections in this category.';
    list.append(empty);
  }
}

async function update(work, errorMessage) {
  if (busy) return;
  busy = refresh.disabled = submit.disabled = true;
  for (const button of list.querySelectorAll('button')) button.disabled = true;
  showStatus('');
  try {
    await work();
  } catch {
    showStatus(errorMessage, true);
  } finally {
    busy = refresh.disabled = submit.disabled = false;
    renderMemories();
  }
}

function loadMemories() {
  return update(async () => {
    showStatus('Loading recollections…');
    const saved = await window.recall.list();
    if (!Array.isArray(saved)) throw new Error('Invalid recollections');
    memories = saved;
    loaded = true;
    showStatus('');
  }, 'Could not load recollections. Start the existing MEERA app and select Refresh.');
}

for (const [key, label] of Object.entries({ all: 'All Memories', ...categories })) {
  addCategoryButton(filters, key, label, (value) => {
    filter = value;
    markSelected(filters, filter);
    renderMemories();
  });
  if (key === 'all') continue;
  addCategoryButton(seedCategories, key, label, (value) => {
    category = value;
    markSelected(seedCategories, category);
  });
}
markSelected(filters, filter);
markSelected(seedCategories, category);

seed.addEventListener('click', () => setSeedOpen(form.hidden));
document.querySelector('#cancel').addEventListener('click', () => setSeedOpen(false));
refresh.addEventListener('click', () => void loadMemories());
document.querySelector('#close').addEventListener('click', () => window.close());
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  void update(async () => {
    const memory = await window.recall.add(category, text);
    if (!memory?.id) throw new Error('Save failed');
    memories = [memory, ...memories.filter(entry => entry.id !== memory.id)];
    filter = 'all';
    markSelected(filters, filter);
    input.value = '';
    setSeedOpen(false);
    showStatus('Recollection saved.');
  }, 'Could not save this recollection.');
});
void loadMemories();
