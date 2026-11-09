'use strict';

const STORAGE_KEY = 'astra.workspace.v1';
const DEFAULT_SETTINGS = {
  apiBaseUrl: '', chatPath: '/v1/chat/completions', modelName: '', apiKey: '', saveApiKey: false,
  authHeader: 'Authorization', authPrefix: 'Bearer', imageUrl: '', imageModel: '', imageSize: '1024x1024',
  systemPrompt: 'Ты — полезный, точный и доброжелательный ИИ-помощник. Отвечай на языке пользователя. Если не уверен, честно обозначай неопределённость.',
  memoryText: '', memoryEnabled: false, temperature: 0.7, maxTokens: 2048, topP: 1,
  frequencyPenalty: 0, presencePenalty: 0, theme: 'system', requestMode: 'openai',
  requestTemplate: '{\n  "model": "{{model}}",\n  "messages": "{{messages}}",\n  "temperature": "{{temperature}}",\n  "max_tokens": "{{max_tokens}}",\n  "top_p": "{{top_p}}",\n  "frequency_penalty": "{{frequency_penalty}}",\n  "presence_penalty": "{{presence_penalty}}",\n  "file_ids": "{{file_ids}}"\n}',
  responsePath: 'choices.0.message.content', imageResponsePath: 'data.0.url',
  imageRequestTemplate: '{\n  "prompt": "{{prompt}}",\n  "size": "{{size}}",\n  "n": 1,\n  "model": "{{model}}"\n}',
  fileUploadUrl: '', fileIdPath: 'id'
};

const $ = (id) => document.getElementById(id);
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));

let persisted = loadPersisted();
let settings = { ...DEFAULT_SETTINGS, ...(persisted.settings || {}) };
let chats = Array.isArray(persisted.chats) ? persisted.chats : [];
let currentChatId = chats.some(chat => chat.id === persisted.currentChatId) ? persisted.currentChatId : null;
let draftChat = { id: null, title: 'Новый чат', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
let secretActive = false;
let secretMessages = [];
let previousChatId = null;
let pendingFiles = [];
let imageMode = false;
let busy = false;
let abortController = null;
let lastError = null;
let savedKeyFromStorage = settings.apiKey || '';

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.warn('Astra: не удалось прочитать локальные данные', error);
    return {};
  }
}

function safePersist() {
  const settingsToSave = { ...settings };
  if (!settingsToSave.saveApiKey) settingsToSave.apiKey = '';
  const safeChats = chats.map(chat => ({ ...chat, messages: (chat.messages || []).map(message => {
    const clean = { ...message };
    delete clean._apiAttachments;
    if (typeof clean.imageUrl === 'string' && clean.imageUrl.startsWith('data:') && clean.imageUrl.length > 1600000) {
      clean.imageUrl = '';
      clean.imageOmitted = true;
      clean.content = `${clean.content || ''}\n\n(Изображение не сохранено локально из-за ограничения размера хранилища.)`;
    }
    return clean;
  }) }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ chats: safeChats, currentChatId, settings: settingsToSave }));
  } catch (error) {
    showToast('Не удалось сохранить данные. Возможно, в браузере закончилось место.', true);
    console.warn('Astra storage error:', error);
  }
}

function activeChat() {
  if (secretActive) return { id: 'secret-session', title: 'Секретный чат', messages: secretMessages, secret: true };
  return chats.find(chat => chat.id === currentChatId) || draftChat;
}

function ensureStoredChat() {
  if (secretActive) return activeChat();
  if (!currentChatId) {
    const chat = { id: uid(), title: 'Новый чат', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    chats.unshift(chat);
    currentChatId = chat.id;
    draftChat = { id: null, title: 'Новый чат', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  }
  return activeChat();
}

function titleFromMessage(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > 38 ? `${clean.slice(0, 38).trim()}…` : (clean || 'Новый чат');
}

function setTheme() {
  const requested = settings.theme || 'system';
  const resolved = requested === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : requested;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', resolved === 'dark' ? '#14151d' : '#f7f8fc');
}

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' error' : ''}`;
  toast.textContent = message;
  $('toastRegion').appendChild(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function safeErrorDetails(error, url = '') {
  return {
    time: new Date().toLocaleString(),
    message: error?.message || String(error),
    url,
    status: error?.status || '',
    body: error?.body || ''
  };
}

function setDiagnostic(error, url = '') {
  lastError = error ? safeErrorDetails(error, url) : null;
  const box = $('diagnosticBox');
  const dot = box.querySelector('.status-dot');
  dot.classList.toggle('error', !!error);
  $('diagnosticText').textContent = error
    ? `${lastError.time}: ${lastError.message}${lastError.status ? ` (HTTP ${lastError.status})` : ''}${lastError.body ? ` · ${lastError.body.slice(0, 260)}` : ''}${lastError.url ? ` · ${lastError.url}` : ''}`
    : 'Ошибок пока нет.';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function safeLink(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) { return ''; }
}

function inlineMarkdown(text) {
  let escaped = escapeHtml(text);
  const codeTokens = [];
  escaped = escaped.replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE${codeTokens.length}@@`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });
  escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, url) => {
    const safe = safeLink(url);
    return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/__(.+?)__/g, '<strong>$1</strong>');
  escaped = escaped.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  escaped = escaped.replace(/~~(.+?)~~/g, '<del>$1</del>');
  codeTokens.forEach((html, index) => { escaped = escaped.replace(`@@CODE${index}@@`, html); });
  return escaped;
}

function splitTableRow(line) {
  let clean = line.trim();
  if (clean.startsWith('|')) clean = clean.slice(1);
  if (clean.endsWith('|')) clean = clean.slice(0, -1);
  return clean.split('|').map(cell => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w.+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const language = fence[1] || 'Код';
      i++;
      const code = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      const source = code.join('\n');
      out.push(`<div class="code-block"><div class="code-header"><span>${escapeHtml(language)}</span><button class="code-copy" type="button" data-copy-code="${encodeURIComponent(source)}">Копировать код</button></div><pre><code>${escapeHtml(source)}</code></pre></div>`);
      continue;
    }
    if (/^\s*\|?.+\|.+\|?\s*$/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitTableRow(lines[i++]));
      out.push(`<div class="message-table-wrap"><table><thead><tr>${headers.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, index) => `<td>${inlineMarkdown(row[index] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
    if (heading) { flushParagraph(); const level = heading[1].length; out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); i++; continue; }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { flushParagraph(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) { flushParagraph(); const quote = []; while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, '')); out.push(`<blockquote>${quote.map(inlineMarkdown).join('<br>')}</blockquote>`); continue; }
    const ul = line.match(/^\s*[-+*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ul || ol) {
      flushParagraph();
      const ordered = !!ol; const items = [];
      while (i < lines.length) {
        const match = lines[i].match(ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/);
        if (!match) break; items.push(`<li>${inlineMarkdown(match[1])}</li>`); i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (!line.trim()) { flushParagraph(); i++; continue; }
    paragraph.push(line); i++;
  }
  flushParagraph();
  return out.join('');
}

function avatarMarkup(role) {
  if (role === 'user') return '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.5-4 3-6 7-6s6.5 2 7 6"/></svg>';
  return '<svg viewBox="0 0 24 24"><path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/></svg>';
}

function formatTime(timestamp) {
  return new Date(timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderAttachmentMeta(attachments = []) {
  if (!attachments.length) return '';
  return `<div class="attachment-list">${attachments.map(file => `<span class="attachment-pill" title="${escapeHtml(file.name)}">${file.kind === 'image' ? '▧' : '▤'} <span>${escapeHtml(file.name)}</span></span>`).join('')}</div>`;
}

function renderMessage(message, index) {
  const isUser = message.role === 'user';
  const messageHtml = message.status === 'loading'
    ? '<div class="typing-indicator" aria-label="Astra печатает"><i></i><i></i><i></i></div>'
    : message.status === 'error'
      ? `<div class="message-error">${escapeHtml(message.content || 'Не удалось получить ответ.')}</div>`
      : renderMarkdown(message.content || '');
  const imageHtml = message.imageUrl ? `<img class="message-image" src="${escapeHtml(message.imageUrl)}" alt="Сгенерированное изображение" loading="lazy">` : '';
  let actionHtml = '';
  if (message.status !== 'loading') {
    if (isUser) {
      actionHtml = `<button class="message-action" data-action="edit" data-index="${index}"><svg viewBox="0 0 24 24"><path d="m14 5 5 5M4 20l4.4-.9L19 8.5a2.1 2.1 0 0 0-3-3L5.4 16.1 4 20Z"/></svg>Изменить</button>`;
    } else if (message.status === 'error') {
      actionHtml = `<button class="message-action" data-action="retry" data-index="${index}">↻ Повторить</button>`;
    } else {
      actionHtml = `<button class="message-action" data-action="regenerate" data-index="${index}">↻ Повторить ответ</button>`;
    }
    if (message.content && message.status !== 'error') actionHtml += `<button class="message-action" data-action="copy" data-index="${index}">▢ Копировать</button>`;
  }
  const who = isUser ? 'Вы' : 'Astra';
  return `<article class="message ${isUser ? 'user' : 'assistant'}" data-message-id="${escapeHtml(message.id)}"><div class="message-avatar">${avatarMarkup(message.role)}</div><div class="message-body"><div class="message-meta"><strong>${who}</strong><span>${formatTime(message.createdAt)}</span>${message.edited ? '<span>· изменено</span>' : ''}</div><div class="message-content">${messageHtml}${imageHtml}</div>${isUser ? renderAttachmentMeta(message.attachments) : ''}<div class="message-actions">${actionHtml}</div></div></article>`;
}

function renderChatList() {
  const list = $('chatList');
  list.innerHTML = '';
  chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = `chat-item${chat.id === currentChatId && !secretActive ? ' active' : ''}`;
    item.dataset.chatId = chat.id;
    item.innerHTML = `<span class="chat-item-title">${escapeHtml(chat.title || 'Новый чат')}</span><button class="chat-item-menu" title="Действия с чатом" aria-label="Действия с чатом">···</button>`;
    item.addEventListener('click', (event) => {
      if (event.target.closest('.chat-item-menu')) {
        event.stopPropagation();
        chatActions(chat.id);
        return;
      }
      openChat(chat.id);
    });
    list.appendChild(item);
  });
}

function render() {
  const chat = activeChat();
  $('currentChatTitle').textContent = chat.title || 'Новый чат';
  $('secretLabel').classList.toggle('hidden', !secretActive);
  $('secretNotice').classList.toggle('hidden', !secretActive);
  $('welcome').classList.toggle('hidden', chat.messages.length > 0);
  $('messages').classList.toggle('hidden', chat.messages.length === 0);
  $('messages').innerHTML = chat.messages.map(renderMessage).join('');
  renderChatList();
  $('sendBtn').disabled = busy || (!imageMode && !pendingFiles.length && !$('messageInput').value.trim()) || (imageMode && !$('messageInput').value.trim());
  $('sendBtn').innerHTML = imageMode
    ? '<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  $('stopBtn').classList.toggle('hidden', !busy);
  $('sendBtn').classList.toggle('hidden', busy);
  $('imageModeBtn').classList.toggle('active', imageMode);
  $('imageModeBtn').querySelector('span').textContent = imageMode ? 'Режим изображения' : 'Изображение';
  updateAttachmentTray();
  if (!busy) $('messageInput').disabled = false;
}

function updateAttachmentTray() {
  const tray = $('attachmentTray');
  tray.innerHTML = '';
  tray.classList.toggle('hidden', pendingFiles.length === 0);
  pendingFiles.forEach(file => {
    const chip = document.createElement('div');
    chip.className = 'pending-file';
    chip.innerHTML = `<span>${file.kind === 'image' ? '▧' : '▤'}</span><span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><button type="button" aria-label="Удалить файл">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      pendingFiles = pendingFiles.filter(item => item.id !== file.id);
      updateAttachmentTray();
      render();
    });
    tray.appendChild(chip);
  });
}

function openChat(id) {
  if (busy) { showToast('Сначала остановите текущий запрос.', true); return; }
  if (secretActive && !leaveSecretChat()) return;
  currentChatId = id;
  pendingFiles = [];
  imageMode = false;
  $('messageInput').placeholder = 'Напишите сообщение...';
  safePersist();
  closeSidebar();
  render();
  scrollToBottom();
}

function startNewChat() {
  if (busy) { showToast('Сначала остановите текущий запрос.', true); return; }
  if (secretActive && !leaveSecretChat()) return;
  currentChatId = null;
  draftChat = { id: null, title: 'Новый чат', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  pendingFiles = [];
  imageMode = false;
  $('messageInput').value = '';
  render();
  closeSidebar();
  $('messageInput').focus();
}

function chatActions(id) {
  const chat = chats.find(item => item.id === id);
  if (!chat) return;
  const action = window.prompt(`Действия с чатом «${chat.title}»\nВведите: rename — переименовать, delete — удалить`, 'rename');
  if (action === null) return;
  if (action.toLowerCase() === 'rename') {
    const nextTitle = window.prompt('Новое название чата:', chat.title);
    if (nextTitle && nextTitle.trim()) { chat.title = nextTitle.trim().slice(0, 80); chat.updatedAt = Date.now(); safePersist(); render(); }
  } else if (action.toLowerCase() === 'delete') {
    if (!window.confirm(`Удалить чат «${chat.title}»? Это действие нельзя отменить.`)) return;
    chats = chats.filter(item => item.id !== id);
    if (currentChatId === id) currentChatId = null;
    safePersist(); render();
  } else showToast('Введите rename или delete.');
}

function renameCurrentChat() {
  if (secretActive) { showToast('Секретный чат нельзя сохранить или переименовать.'); return; }
  const chat = activeChat();
  if (!chat.id) { showToast('Отправьте первое сообщение, чтобы создать чат.'); return; }
  const title = window.prompt('Название чата:', chat.title);
  if (title && title.trim()) { chat.title = title.trim().slice(0, 80); chat.updatedAt = Date.now(); safePersist(); render(); }
}

function startSecretChat() {
  if (busy) { showToast('Сначала остановите текущий запрос.', true); return; }
  if (secretActive) { leaveSecretChat(); return; }
  previousChatId = currentChatId;
  secretMessages = [];
  secretActive = true;
  pendingFiles = [];
  imageMode = false;
  $('messageInput').value = '';
  render();
  closeSidebar();
  $('messageInput').focus();
}

function leaveSecretChat() {
  if (!secretActive) return;
  if (secretMessages.length && !window.confirm('Выйти из секретного чата? Его переписка будет удалена из памяти вкладки.')) return false;
  secretMessages = [];
  secretActive = false;
  currentChatId = chats.some(chat => chat.id === previousChatId) ? previousChatId : null;
  previousChatId = null;
  pendingFiles = [];
  imageMode = false;
  $('messageInput').value = '';
  render();
  return true;
}

function scrollToBottom() {
  requestAnimationFrame(() => $('conversation').scrollTo({ top: $('conversation').scrollHeight, behavior: 'smooth' }));
}

function resizeTextarea() {
  const input = $('messageInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  $('sendBtn').disabled = busy || (!input.value.trim() && !pendingFiles.length);
}

function normalizeApiUrl(base, path) {
  const cleanPath = String(path || '').trim();
  if (/^https?:\/\//i.test(cleanPath)) return cleanPath;
  const cleanBase = String(base || '').trim().replace(/\/+$/, '');
  if (!cleanBase) return '';
  return `${cleanBase}/${cleanPath.replace(/^\/+/, '')}`;
}

function authHeaders() {
  const headers = {};
  if (settings.apiKey) {
    const headerName = (settings.authHeader || 'Authorization').trim();
    const prefix = (settings.authPrefix ?? 'Bearer').trim();
    if (headerName) headers[headerName] = prefix ? `${prefix} ${settings.apiKey}` : settings.apiKey;
  }
  return headers;
}

function getByPath(object, path) {
  if (!path) return object;
  return path.split('.').reduce((value, key) => {
    if (value == null) return undefined;
    return value[key];
  }, object);
}

function applyTemplate(templateValue, variables) {
  if (Array.isArray(templateValue)) return templateValue.map(value => applyTemplate(value, variables));
  if (templateValue && typeof templateValue === 'object') {
    return Object.fromEntries(Object.entries(templateValue).map(([key, value]) => [key, applyTemplate(value, variables)]));
  }
  if (typeof templateValue !== 'string') return templateValue;
  const exact = templateValue.match(/^\{\{([a-z_]+)\}\}$/);
  if (exact && Object.prototype.hasOwnProperty.call(variables, exact[1])) return variables[exact[1]];
  return templateValue.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
    const value = variables[key];
    return value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  });
}

function buildApiMessages(chat, fileIds = []) {
  const result = [];
  const systemParts = [];
  if (settings.systemPrompt.trim()) systemParts.push(settings.systemPrompt.trim());
  if (!secretActive && settings.memoryEnabled && settings.memoryText.trim()) {
    systemParts.push(`Память о пользователе (используй только как контекст):\n${settings.memoryText.trim()}`);
  }
  if (systemParts.length) result.push({ role: 'system', content: systemParts.join('\n\n') });
  chat.messages.filter(message => message.role === 'user' || message.role === 'assistant').forEach(message => {
    if (message.status === 'error' || message.status === 'loading') return;
    let content = message.content || '';
    const isLatest = message === chat.messages.filter(item => item.role === 'user').slice(-1)[0];
    const attachments = message._apiAttachments || message.apiAttachmentText || [];
    const textAttachments = attachments.filter(file => file.kind === 'text');
    textAttachments.forEach(file => { content += `\n\n[Содержимое файла: ${file.name}]\n${file.text}`; });
    const oldFiles = (message.attachments || []).filter(item => item.kind === 'image' && !attachments.some(file => file.id === item.id));
    if (oldFiles.length) content += `\n\n[Изображение ${oldFiles.map(file => file.name).join(', ')} ранее прикреплялось, но в текущей сессии файл недоступен.]`;
    const oldBinary = (message.attachments || []).filter(item => item.kind === 'binary' && !attachments.some(file => file.id === item.id));
    if (oldBinary.length) content += `\n\n[Файлы ${oldBinary.map(file => file.name).join(', ')} ранее прикреплялись, но их нужно прикрепить повторно для передачи в API.]`;
    if (message.role === 'user' && attachments.some(file => file.kind === 'binary')) {
      content += `\n\n[Бинарные файлы: ${attachments.filter(file => file.kind === 'binary').map(file => file.name).join(', ')}. ID файлов: ${fileIds.join(', ')}]`;
    }
    const images = attachments.filter(file => file.kind === 'image' && file.dataUrl);
    if (message.role === 'user' && images.length) {
      const parts = [{ type: 'text', text: content }];
      images.forEach(file => parts.push({ type: 'image_url', image_url: { url: file.dataUrl } }));
      result.push({ role: 'user', content: parts });
    } else {
      result.push({ role: message.role, content });
    }
  });
  return result;
}

async function uploadBinaryFiles(files, signal) {
  const binary = files.filter(file => file.kind === 'binary');
  if (!binary.length) return [];
  if (!settings.fileUploadUrl.trim()) throw new Error(`Формат ${binary.map(file => file.name).join(', ')} требует отдельного file upload endpoint. Укажите его в Настройки → Дополнительно.`);
  if (settings.requestMode !== 'custom') throw new Error('Для передачи ID загруженных файлов включите пользовательский JSON-шаблон и используйте {{file_ids}}.');
  const ids = [];
  for (const file of binary) {
    const form = new FormData();
    form.append('file', file.file, file.name);
    const response = await fetch(settings.fileUploadUrl.trim(), { method: 'POST', headers: authHeaders(), body: form, signal });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch (_) { data = { raw }; }
    if (!response.ok) {
      const error = new Error(`Ошибка загрузки файла ${file.name}: ${response.status}`);
      error.status = response.status; error.body = raw.slice(0, 500); throw error;
    }
    const id = getByPath(data, settings.fileIdPath || 'id');
    if (!id) throw new Error(`В ответе загрузки файла ${file.name} не найден ID по пути «${settings.fileIdPath || 'id'}».`);
    ids.push(id);
  }
  return ids;
}

function normalizeAssistantContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => {
    if (typeof part === 'string') return part;
    return part?.text || part?.content || '';
  }).filter(Boolean).join('\n');
  if (value == null) return '';
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

async function callChatApi(chat, fileIds, signal) {
  const url = normalizeApiUrl(settings.apiBaseUrl, settings.chatPath);
  if (!url) throw new Error('Укажите основной URL API в Настройки → Подключение.');
  if (!settings.modelName.trim()) throw new Error('Укажите название модели в Настройки → Подключение.');
  const messages = buildApiMessages(chat, fileIds);
  const variables = {
    model: settings.modelName.trim(), messages,
    temperature: Number(settings.temperature), max_tokens: Number(settings.maxTokens), top_p: Number(settings.topP),
    frequency_penalty: Number(settings.frequencyPenalty), presence_penalty: Number(settings.presencePenalty), file_ids: fileIds
  };
  let body;
  if (settings.requestMode === 'custom') {
    let parsedTemplate;
    try { parsedTemplate = JSON.parse(settings.requestTemplate); }
    catch (error) { throw new Error(`JSON-шаблон запроса некорректен: ${error.message}`); }
    body = applyTemplate(parsedTemplate, variables);
  } else {
    body = { model: variables.model, messages };
    ['temperature', 'max_tokens', 'top_p', 'frequency_penalty', 'presence_penalty'].forEach(key => {
      const value = variables[key];
      if (Number.isFinite(value) && value !== null && value !== undefined) body[key] = value;
    });
  }
  const headers = { 'Content-Type': 'application/json', ...authHeaders() };
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); }
  catch (_) { data = { raw }; }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `API вернул HTTP ${response.status}`);
    error.status = response.status; error.body = raw.slice(0, 800); throw error;
  }
  let content = getByPath(data, settings.responsePath || 'choices.0.message.content');
  if (content === undefined && data?.choices?.[0]?.text !== undefined) content = data.choices[0].text;
  if (content === undefined && typeof data?.output_text === 'string') content = data.output_text;
  if (content === undefined && typeof data?.response === 'string') content = data.response;
  if (content === undefined && typeof data?.raw === 'string') content = data.raw;
  if (content === undefined) throw new Error(`Ответ API получен, но поле «${settings.responsePath}» не найдено. Проверьте путь в Настройки → Дополнительно.`);
  return normalizeAssistantContent(content);
}

async function callImageApi(prompt, signal) {
  const url = settings.imageUrl.trim();
  if (!url) throw new Error('Укажите отдельный URL генерации изображений в Настройки → Подключение.');
  const model = settings.imageModel.trim() || settings.modelName.trim();
  let imageTemplate;
  try { imageTemplate = JSON.parse(settings.imageRequestTemplate || DEFAULT_SETTINGS.imageRequestTemplate); }
  catch (error) { throw new Error(`JSON-шаблон изображения некорректен: ${error.message}`); }
  const body = applyTemplate(imageTemplate, { prompt, size: settings.imageSize || '1024x1024', n: 1, model });
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body), signal });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch (_) { data = { raw }; }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `Сервис изображений вернул HTTP ${response.status}`);
    error.status = response.status; error.body = raw.slice(0, 800); throw error;
  }
  const first = Array.isArray(data?.data) ? data.data[0] : data;
  if (first?.url) return first.url;
  if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`;
  const configured = getByPath(data, settings.imageResponsePath || 'data.0.url');
  if (typeof configured === 'string' && configured.startsWith('http')) return configured;
  if (typeof configured === 'string' && configured.startsWith('data:')) return configured;
  if (typeof configured === 'string' && /^[A-Za-z0-9+/]+=*$/.test(configured)) return `data:image/png;base64,${configured}`;
  throw new Error('Изображение создано не было найдено в ответе. Встроенный обработчик ожидает data[0].url или data[0].b64_json; проверьте формат API.');
}

function persistMessage(chat) {
  if (secretActive) return;
  chat.updatedAt = Date.now();
  safePersist();
}

async function sendMessage() {
  if (busy) return;
  const text = $('messageInput').value.trim();
  if (!text && !pendingFiles.length) return;
  if (imageMode && !text) return;
  const chat = secretActive ? activeChat() : ensureStoredChat();
  const files = imageMode ? [] : pendingFiles.slice();
  pendingFiles = [];
  const message = { id: uid(), role: 'user', content: text || (imageMode ? '' : 'Проанализируй прикреплённые файлы.'), createdAt: Date.now(), attachments: files.map(file => ({ id: file.id, name: file.name, type: file.type, kind: file.kind })), apiAttachmentText: files.filter(file => file.kind === 'text').map(file => ({ name: file.name, text: file.text, kind: 'text' })), _apiAttachments: files };
  if (!chat.messages.length && !secretActive) chat.title = titleFromMessage(message.content || 'Новое изображение');
  chat.messages.push(message);
  $('messageInput').value = '';
  resizeTextarea();
  imageMode ? await generateImage(chat, message) : await generateReply(chat, message);
}

async function generateReply(chat, userMessage) {
  const assistant = { id: uid(), role: 'assistant', content: '', status: 'loading', createdAt: Date.now() };
  chat.messages.push(assistant);
  persistMessage(chat);
  busy = true;
  abortController = new AbortController();
  render(); scrollToBottom();
  try {
    const fileIds = await uploadBinaryFiles(userMessage._apiAttachments || [], abortController.signal);
    const reply = await callChatApi(chat, fileIds, abortController.signal);
    assistant.content = reply || 'Модель вернула пустой ответ.';
    assistant.status = 'done';
    setDiagnostic(null);
  } catch (error) {
    if (error.name === 'AbortError') {
      assistant.content = 'Запрос остановлен.';
      assistant.status = 'done';
    } else {
      assistant.content = 'Не удалось получить ответ. Проверьте подключение и настройки API.';
      assistant.status = 'error';
      setDiagnostic(error, normalizeApiUrl(settings.apiBaseUrl, settings.chatPath));
      showToast('Не удалось получить ответ. Подробности — в настройках.', true);
    }
  } finally {
    busy = false; abortController = null;
    persistMessage(chat); render(); scrollToBottom();
  }
}

async function generateImage(chat, userMessage) {
  const assistant = { id: uid(), role: 'assistant', content: 'Создаю изображение по вашему описанию…', status: 'loading', createdAt: Date.now() };
  chat.messages.push(assistant);
  persistMessage(chat);
  busy = true;
  abortController = new AbortController();
  render(); scrollToBottom();
  try {
    const imageUrl = await callImageApi(userMessage.content, abortController.signal);
    assistant.content = 'Готово. Изображение создано.';
    assistant.imageUrl = imageUrl;
    assistant.status = 'done';
    setDiagnostic(null);
  } catch (error) {
    if (error.name === 'AbortError') {
      assistant.content = 'Генерация остановлена.'; assistant.status = 'done';
    } else {
      assistant.content = 'Не удалось создать изображение. Проверьте URL и формат API генерации изображений.';
      assistant.status = 'error';
      setDiagnostic(error, settings.imageUrl);
      showToast('Генерация изображений недоступна или завершилась ошибкой.', true);
    }
  } finally {
    busy = false; abortController = null;
    persistMessage(chat); render(); scrollToBottom();
  }
}

function stopGeneration() {
  if (abortController) abortController.abort();
}

async function regenerateFrom(userIndex) {
  if (busy) return;
  const chat = activeChat();
  const userMessage = chat.messages[userIndex];
  if (!userMessage || userMessage.role !== 'user') return;
  chat.messages = chat.messages.slice(0, userIndex + 1);
  render();
  await generateReply(chat, userMessage);
}

function editMessage(index) {
  const chat = activeChat();
  const message = chat.messages[index];
  if (!message || message.role !== 'user' || busy) return;
  const article = $('messages').querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  const content = article.querySelector('.message-content');
  const original = message.content;
  content.innerHTML = '';
  const textarea = document.createElement('textarea');
  textarea.className = 'message-edit-area';
  textarea.value = original;
  content.appendChild(textarea);
  const controls = document.createElement('div');
  controls.className = 'edit-controls';
  controls.innerHTML = '<button class="mini-btn" data-edit-cancel>Отмена</button><button class="mini-btn primary" data-edit-save>Сохранить и повторить</button>';
  content.appendChild(controls);
  textarea.focus();
  controls.querySelector('[data-edit-cancel]').addEventListener('click', render);
  controls.querySelector('[data-edit-save]').addEventListener('click', async () => {
    const next = textarea.value.trim();
    if (!next) { showToast('Сообщение не может быть пустым.', true); return; }
    message.content = next;
    message.edited = true;
    message._apiAttachments = [];
    message.attachments = [];
    chat.messages = chat.messages.slice(0, index + 1);
    if (index === 0 && !secretActive) chat.title = titleFromMessage(next);
    persistMessage(chat);
    render();
    await generateReply(chat, message);
  });
}

function handleMessageAction(event) {
  const button = event.target.closest('[data-action], [data-copy-code]');
  if (!button) return;
  if (button.hasAttribute('data-copy-code')) {
    const code = decodeURIComponent(button.getAttribute('data-copy-code'));
    navigator.clipboard?.writeText(code).then(() => showToast('Код скопирован.')).catch(() => showToast('Не удалось скопировать код.', true));
    return;
  }
  const action = button.dataset.action;
  const index = Number(button.dataset.index);
  const chat = activeChat();
  if (action === 'edit') editMessage(index);
  if (action === 'regenerate') {
    let userIndex = index - 1;
    while (userIndex >= 0 && chat.messages[userIndex].role !== 'user') userIndex--;
    if (userIndex >= 0) regenerateFrom(userIndex);
  }
  if (action === 'retry') {
    let userIndex = index - 1;
    while (userIndex >= 0 && chat.messages[userIndex].role !== 'user') userIndex--;
    if (userIndex >= 0) regenerateFrom(userIndex);
  }
  if (action === 'copy') {
    navigator.clipboard?.writeText(chat.messages[index]?.content || '').then(() => showToast('Сообщение скопировано.')).catch(() => showToast('Не удалось скопировать сообщение.', true));
  }
}

async function addFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    if (pendingFiles.length >= 8) { showToast('Можно прикрепить не более 8 файлов за раз.', true); break; }
    const extension = file.name.split('.').pop().toLowerCase();
    const textExtensions = new Set(['txt','md','markdown','csv','tsv','json','xml','yaml','yml','html','htm','css','js','ts','jsx','tsx','py','java','c','cpp','h','hpp','sql','log','sh','rb','go','rs','php','ini','toml','vue','svelte']);
    const isImage = file.type.startsWith('image/');
    const isText = file.type.startsWith('text/') || textExtensions.has(extension) || ['application/json','application/xml'].includes(file.type);
    const item = { id: uid(), name: file.name, type: file.type || 'application/octet-stream', size: file.size, file, kind: isImage ? 'image' : (isText ? 'text' : 'binary') };
    try {
      if (isImage) {
        if (file.size > 8 * 1024 * 1024) throw new Error('Изображение больше 8 МБ.');
        item.dataUrl = await readAsDataUrl(file);
      } else if (isText) {
        if (file.size > 1024 * 1024) throw new Error('Текстовый файл больше 1 МБ.');
        item.text = await file.text();
      }
      pendingFiles.push(item);
    } catch (error) { showToast(`${file.name}: ${error.message}`, true); }
  }
  updateAttachmentTray(); render();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

function openSidebar() { $('sidebar').classList.add('open'); $('sidebarScrim').classList.add('show'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebarScrim').classList.remove('show'); }

function openSettings() {
  fillSettingsForm();
  $('settingsModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeSettings() { $('settingsModal').classList.add('hidden'); document.body.style.overflow = ''; }

function fillSettingsForm() {
  const mapping = {
    apiBaseUrl: 'apiBaseUrl', chatPath: 'chatPath', modelName: 'modelName', imageUrl: 'imageUrl', imageModel: 'imageModel', imageSize: 'imageSize',
    authHeader: 'authHeader', authPrefix: 'authPrefix', systemPrompt: 'systemPrompt', memoryText: 'memoryText', memoryEnabled: 'memoryEnabled',
    temperature: 'temperature', maxTokens: 'maxTokens', topP: 'topP', frequencyPenalty: 'frequencyPenalty', presencePenalty: 'presencePenalty',
    requestMode: 'requestMode', requestTemplate: 'requestTemplate', responsePath: 'responsePath', imageRequestTemplate: 'imageRequestTemplate', imageResponsePath: 'imageResponsePath', fileUploadUrl: 'fileUploadUrl', fileIdPath: 'fileIdPath', saveApiKey: 'saveApiKey'
  };
  Object.entries(mapping).forEach(([elementId, settingKey]) => {
    const el = $(elementId); if (!el) return;
    if (el.type === 'checkbox') el.checked = !!settings[settingKey];
    else el.value = settings[settingKey] ?? '';
  });
  $('apiKey').value = settings.apiKey || '';
  document.querySelectorAll('input[name="theme"]').forEach(input => { input.checked = input.value === settings.theme; });
  $('customRequestFields').classList.toggle('hidden', settings.requestMode !== 'custom');
  setDiagnostic(lastError);
}

function collectSettingsForm() {
  const number = (id, fallback) => {
    const value = Number($(id).value);
    return Number.isFinite(value) ? value : fallback;
  };
  const keyNow = $('apiKey').value.trim();
  const saveKey = $('saveApiKey').checked;
  const settingsNext = {
    ...settings,
    apiBaseUrl: $('apiBaseUrl').value.trim(), chatPath: $('chatPath').value.trim(), modelName: $('modelName').value.trim(),
    apiKey: keyNow || (saveKey ? (settings.apiKey || savedKeyFromStorage) : ''), saveApiKey: saveKey,
    authHeader: $('authHeader').value.trim() || 'Authorization', authPrefix: $('authPrefix').value,
    imageUrl: $('imageUrl').value.trim(), imageModel: $('imageModel').value.trim(), imageSize: $('imageSize').value,
    systemPrompt: $('systemPrompt').value, memoryText: $('memoryText').value, memoryEnabled: $('memoryEnabled').checked,
    temperature: number('temperature', 0.7), maxTokens: number('maxTokens', 2048), topP: number('topP', 1),
    frequencyPenalty: number('frequencyPenalty', 0), presencePenalty: number('presencePenalty', 0),
    requestMode: $('requestMode').value, requestTemplate: $('requestTemplate').value, responsePath: $('responsePath').value.trim(),
    imageRequestTemplate: $('imageRequestTemplate').value, imageResponsePath: $('imageResponsePath').value.trim(),
    fileUploadUrl: $('fileUploadUrl').value.trim(), fileIdPath: $('fileIdPath').value.trim() || 'id',
    theme: document.querySelector('input[name="theme"]:checked')?.value || 'system'
  };
  return settingsNext;
}

function saveSettings() {
  settings = collectSettingsForm();
  savedKeyFromStorage = settings.saveApiKey ? settings.apiKey : '';
  safePersist();
  setTheme();
  $('customRequestFields').classList.toggle('hidden', settings.requestMode !== 'custom');
  $('saveStatus').textContent = 'Сохранено на этом устройстве';
  showToast('Настройки сохранены.');
  window.setTimeout(() => { $('saveStatus').textContent = 'Настройки сохраняются локально'; }, 2200);
}

function clearHistory() {
  if (!window.confirm('Удалить все сохранённые чаты? Это действие нельзя отменить.')) return;
  chats = []; currentChatId = null; draftChat.messages = [];
  safePersist(); render(); showToast('История чатов удалена.');
}

function exportData() {
  const payload = { exportedAt: new Date().toISOString(), chats, settings: { ...settings, apiKey: '' } };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = `astra-export-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); URL.revokeObjectURL(link.href);
}

function bindEvents() {
  $('newChatBtn').addEventListener('click', startNewChat);
  $('secretChatBtn').addEventListener('click', startSecretChat);
  $('settingsBtn').addEventListener('click', openSettings);
  $('topSettingsBtn').addEventListener('click', openSettings);
  $('renameChatBtn').addEventListener('click', renameCurrentChat);
  $('openSidebarBtn').addEventListener('click', openSidebar);
  $('closeSidebarBtn').addEventListener('click', closeSidebar);
  $('sidebarScrim').addEventListener('click', closeSidebar);
  $('messageInput').addEventListener('input', resizeTextarea);
  $('messageInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
  });
  $('sendBtn').addEventListener('click', sendMessage);
  $('stopBtn').addEventListener('click', stopGeneration);
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
  $('imageModeBtn').addEventListener('click', () => {
    imageMode = !imageMode;
    $('messageInput').placeholder = imageMode ? 'Опишите изображение, которое нужно создать...' : 'Напишите сообщение...';
    if (imageMode && pendingFiles.length) showToast('В режиме генерации изображений прикреплённые файлы не используются.');
    render(); $('messageInput').focus();
  });
  document.querySelectorAll('.suggestion-card').forEach(card => card.addEventListener('click', () => {
    $('messageInput').value = card.dataset.prompt || ''; resizeTextarea(); $('messageInput').focus();
  }));
  $('messages').addEventListener('click', handleMessageAction);
  $('closeSettingsBtn').addEventListener('click', closeSettings);
  $('cancelSettingsBtn').addEventListener('click', closeSettings);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('settingsModal').addEventListener('click', event => { if (event.target === $('settingsModal')) closeSettings(); });
  $('requestMode').addEventListener('change', () => $('customRequestFields').classList.toggle('hidden', $('requestMode').value !== 'custom'));
  $('toggleKeyBtn').addEventListener('click', () => {
    const input = $('apiKey'); input.type = input.type === 'password' ? 'text' : 'password';
    $('toggleKeyBtn').textContent = input.type === 'password' ? 'Показать' : 'Скрыть';
  });
  document.querySelectorAll('.settings-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach(item => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.settings-section').forEach(section => section.classList.toggle('hidden', section.dataset.section !== tab.dataset.tab));
  }));
  $('clearDiagnosticBtn').addEventListener('click', () => { setDiagnostic(null); showToast('Диагностика очищена.'); });
  $('clearHistoryBtn').addEventListener('click', clearHistory);
  $('exportDataBtn').addEventListener('click', exportData);
  document.querySelectorAll('input[name="theme"]').forEach(input => input.addEventListener('change', () => {
    settings.theme = input.value; setTheme();
  }));
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); startNewChat(); }
    if (event.key === 'Escape') {
      if (!$('settingsModal').classList.contains('hidden')) closeSettings();
      else if ($('sidebar').classList.contains('open')) closeSidebar();
    }
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (settings.theme === 'system') setTheme(); });
}

function initialize() {
  setTheme();
  bindEvents();
  render();
  resizeTextarea();
}

initialize();
