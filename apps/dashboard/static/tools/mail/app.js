/*
 * ASTER MAIL — adopted as Drevanta Mail. UI and interactions are the original
 * prototype; the data layer is wired to the workspace mail API (Postgres).
 * Sending between workspace mailboxes delivers for real; external recipients
 * are reported as not delivered until the mail stack ships.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'aster-mail-prototype-v1';
  const API = '/api/v1';
  let accounts = [];

  const settingsDefault = { dark: true, compact: false, aiShortcuts: true };
  const stored = readStorage();
  const state = {
    messages: [],
    settings: { ...settingsDefault, ...(stored.settings || {}) },
    folder: 'inbox', filter: 'all', search: '', account: 'all', selectedId: null,
    draftEditingId: null, lastAiReply: '', mobileReading: false, loaded: false
  };

  async function api(path, opts = {}) {
    const res = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('unauthorized'); }
    if (!res.ok) {
      let msg = 'Request failed';
      try { msg = (await res.json()).message ?? msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  async function boot() {
    try {
      const data = await api('/mail/messages');
      accounts = data.accounts || [];
      state.messages = data.messages || [];
      state.loaded = true;
      renderAccountMenu(); render();
      if (!accounts.length) toast('No mailboxes in the registry yet — create one under Email in the workspace.');
    } catch (e) {
      if (e.message !== 'unauthorized') {
        state.loaded = true; renderAccountMenu(); render();
        toast('Could not load mailbox: ' + e.message);
      }
    }
  }

  async function reloadMessages(notify = true) {
    try {
      const data = await api('/mail/messages');
      accounts = data.accounts || [];
      state.messages = data.messages || [];
      renderAccountMenu(); render();
      if (notify) toast('Mailbox up to date');
    } catch (e) {
      if (e.message !== 'unauthorized') toast('Refresh failed: ' + e.message);
    }
  }

  const $ = id => document.getElementById(id);
  const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safe = escapeHtml;
  function readStorage() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } }
  function persist() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: state.settings })); } catch {} }
  const displayFolders = { inbox: 'Inbox', starred: 'Starred', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', spam: 'Spam', trash: 'Trash' };
  const folderInfo = {
    inbox: 'A calmer way to stay on top of things.', starred: 'Everything you want to keep close.',
    sent: 'Messages sent from your mailboxes.', drafts: 'Pick up right where you left off.',
    archive: 'All organized and out of the way.', spam: 'Messages flagged as unwanted.',
    trash: 'Deleted conversations live here.'
  };
  const palettes = [ ['#e7e8ff','#6965d4'], ['#dff5eb','#278c70'], ['#fcebdc','#b87b41'], ['#e6efff','#5474ba'], ['#fae4ef','#b66391'], ['#e7ebf2','#526786'] ];
  function initials(name) { return String(name).split(/[\s@]+/).filter(Boolean).slice(0,2).map(w => w[0]).join('').toUpperCase(); }
  function avatarColor(name) { let sum = 0; for (const c of name) sum += c.charCodeAt(0); return palettes[sum % palettes.length]; }
  function avatar(name) { const [bg, color] = avatarColor(name); return `<span class="message-avatar" style="background:${bg};color:${color}">${safe(initials(name))}</span>`; }
  function timeLabel(value) {
    const date = new Date(value), today = new Date();
    if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString(undefined, { month:'short', day:'numeric' });
  }
  function fullDate(value) { return new Date(value).toLocaleDateString(undefined, { weekday:'short', month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }); }
  const sortByDate = (a,b) => new Date(b.date) - new Date(a.date);
  const filteredForAccount = () => state.messages.filter(m => state.account === 'all' || m.account === state.account);
  function visibleMessages() {
    return filteredForAccount().filter(m => {
      const folder = state.folder;
      const folderMatch = state.search ? (m.folder !== 'trash' && m.folder !== 'spam') : folder === 'starred' ? (m.starred && m.folder !== 'trash' && m.folder !== 'spam') : folder.startsWith('label:') ? (m.labels.includes(folder.slice(6)) && m.folder !== 'trash' && m.folder !== 'spam') : m.folder === folder;
      if (!folderMatch) return false;
      if (state.filter === 'unread' && !m.unread) return false;
      if (state.filter === 'priority' && !m.priority) return false;
      if (state.search) {
        const needle = state.search.toLowerCase();
        const text = [m.from, m.email, m.to, m.subject, m.snippet, m.body, ...m.labels, ...m.attachments.map(a => a.name)].join(' ').toLowerCase();
        if (!text.includes(needle)) return false;
      }
      return true;
    }).sort(sortByDate);
  }
  function selectedMessage() { return state.messages.find(m => m.id === state.selectedId); }
  function ensureSelection(list) { if (!list.some(m => m.id === state.selectedId)) state.selectedId = list.length ? list[0].id : null; }

  function renderAccountMenu() {
    const current = accounts.find(a => a.email === state.account);
    $('currentWorkspace').textContent = current ? current.short : 'All workspaces';
    $('currentAccount').textContent = current ? current.email : 'All mailboxes';
    $('accountMenu').innerHTML = `<div class="account-menu-header">SWITCH MAILBOX</div>` +
      [{ email:'all', name:'All mailboxes', short:'Across all your accounts' }, ...accounts].map(a => `<button type="button" class="account-item ${state.account === a.email ? 'selected' : ''}" data-account="${safe(a.email)}">${icon(a.email === 'all' ? 'grid' : 'mail','small')}<span><strong>${safe(a.name)}</strong><small>${safe(a.email === 'all' ? a.short : a.email)}</small></span>${state.account === a.email ? icon('check','small') : ''}</button>`).join('');
    $('composeFrom').innerHTML = accounts.map(a => `<option value="${safe(a.email)}">${safe(a.email)}</option>`).join('');
  }
  function renderNav() {
    document.querySelectorAll('[data-folder]').forEach(el => el.classList.toggle('active', el.dataset.folder === state.folder));
    const n = filteredForAccount();
    const unread = n.filter(m => m.folder === 'inbox' && m.unread).length;
    const drafts = n.filter(m => m.folder === 'drafts').length;
    $('inboxCount').textContent = unread || '';
    $('draftCount').textContent = drafts || '';
    $('folderTitle').textContent = state.search ? 'Search results' : state.folder.startsWith('label:') ? state.folder.slice(6) : displayFolders[state.folder] || 'Inbox';
    $('folderSubtitle').textContent = state.search ? `Results across your accessible demo mailboxes for “${state.search}”.` : state.folder.startsWith('label:') ? 'Conversations organized by label.' : folderInfo[state.folder];
    const currentUnread = visibleMessages().filter(m => m.unread).length;
    $('unreadPill').textContent = `${currentUnread} unread`;
    $('unreadPill').hidden = currentUnread === 0;
    document.querySelectorAll('[data-filter]').forEach(el => el.classList.toggle('active',el.dataset.filter === state.filter));
  }
  function renderList(list) {
    $('resultsLabel').textContent = `${list.length} ${list.length === 1 ? 'conversation' : 'conversations'}`;
    if (!list.length) {
      $('messageList').innerHTML = `<div class="empty-list">${icon('inbox')}<strong>Nothing here (yet)</strong><p>${state.search ? 'No messages match your search. Try another phrase.' : 'This folder is clear. Select another folder or filter.'}</p></div>`;
      return;
    }
    $('messageList').innerHTML = list.map(m => {
      const sender = m.folder === 'sent' ? `To: ${m.to}` : m.from;
      return `<div class="message-row ${m.id === state.selectedId ? 'selected' : ''} ${m.unread ? 'unread' : ''} ${state.settings.compact ? 'compact' : ''}" role="button" tabindex="0" data-message-id="${m.id}" aria-label="Open ${safe(m.subject)}"><div class="message-mainline">${avatar(m.from)}<div class="message-sender-block"><div class="message-sender">${safe(sender)}</div><div class="message-to">${safe(m.folder === 'sent' ? m.email : m.email)}</div></div><div class="message-time">${safe(timeLabel(m.date))}</div></div><div class="message-subject-line"><div class="message-subject">${safe(m.subject)}</div><button type="button" class="message-star ${m.starred ? 'active' : ''}" data-star-id="${m.id}" title="${m.starred ? 'Unstar' : 'Star'} message" aria-label="Toggle star">${icon('star')}</button></div><div class="message-snippet">${safe(m.snippet)}</div><div class="message-meta">${m.labels.slice(0,2).map(l => `<span class="message-label ${safe(l)}">${safe(l)}</span>`).join('')}${m.priority ? '<span class="priority-mark">Priority</span>' : ''}${m.attachments.length ? icon('paperclip','message-attachment') : ''}${m.unread ? '<span class="unread-dot" title="Unread"></span>' : ''}</div></div>`;
    }).join('');
  }
  function renderReader(list) {
    const m = selectedMessage();
    if (!m || !list.some(x => x.id === m.id)) {
      $('readerContent').innerHTML = `<div class="reader-empty"><span class="reader-empty-icon">${icon('mail')}</span><h2>Your inbox, reimagined.</h2><p>Select a conversation to read it, or compose a new message to explore the demo.</p><button type="button" class="primary-btn" data-reader-action="compose">Compose a message ${icon('plus')}</button></div>`;
      return;
    }
    const index = list.findIndex(x => x.id === m.id);
    const attachmentMarkup = m.attachments.length ? `<div class="reader-attachments"><div class="attachment-title">${icon('paperclip')} ${m.attachments.length} ${m.attachments.length === 1 ? 'attachment' : 'attachments'}</div><div class="attachment-cards">${m.attachments.map(a => `<button type="button" class="attachment-card" data-reader-action="attachment" title="Demo only: no file is attached"> <span class="attachment-icon">${icon('file')}</span><span class="attachment-name"><strong>${safe(a.name)}</strong><small>${safe(a.size)} · Demo file</small></span></button>`).join('')}</div></div>` : '';
    const repliesMarkup = m.thread && m.thread.length ? `<div class="reader-replies"><strong>${m.thread.length} earlier messages in this conversation</strong>${m.thread.map(t => `<div class="reply-history"><span>Earlier message from</span><strong>${safe(t.from)}</strong><p>${safe(t.snippet)}</p></div>`).join('')}</div>` : '';
    const isTrash = m.folder === 'trash';
    const isDraft = m.folder === 'drafts';
    const senderAction = isDraft ? `<button type="button" class="outline-action" data-reader-action="edit">${icon('file')}<span>Edit draft</span></button>` : `<button type="button" class="outline-action" data-reader-action="reply" title="Reply">${icon('reply')}<span>Reply</span></button><button type="button" class="icon-button" data-reader-action="forward" title="Forward">${icon('forward')}</button>`;
    const bottomAction = isDraft ? `<button type="button" class="primary-btn" data-reader-action="edit">${icon('file')} Continue this draft</button>` : `<button type="button" class="primary-btn" data-reader-action="reply">${icon('reply')} Reply to ${safe(m.from.split(' ')[0])}</button><button type="button" class="secondary-btn" data-reader-action="forward">${icon('forward','small')} Forward</button>`;
    const readerContent = `<div class="reader-toolbar"><div class="reader-toolbar-group"><button type="button" class="icon-button mobile-reader-back" data-reader-action="back" title="Back to inbox">${icon('chevron-left')}</button><button type="button" class="icon-button" data-reader-action="${isTrash ? 'restore' : 'archive'}" title="${isTrash ? 'Restore to inbox' : 'Archive'}">${icon(isTrash ? 'inbox' : 'archive')}</button><button type="button" class="icon-button" data-reader-action="trash" title="${isTrash ? 'Delete permanently' : 'Move to trash'}">${icon('trash')}</button><div class="toolbar-separator"></div><button type="button" class="icon-button" data-reader-action="unread" title="Mark as ${m.unread ? 'read' : 'unread'}">${icon('mail')}</button><button type="button" class="icon-button" data-reader-action="star" title="${m.starred ? 'Remove star' : 'Star this message'}" style="color:${m.starred ? '#e6ac44' : 'inherit'}">${icon('star')}</button></div><div class="reader-nav"><span class="reader-counter">${index+1} of ${list.length}</span><button type="button" class="icon-button" data-reader-action="prev" ${index <= 0 ? 'disabled' : ''} title="Previous email">${icon('chevron-left')}</button><button type="button" class="icon-button" data-reader-action="next" ${index >= list.length-1 ? 'disabled' : ''} title="Next email">${icon('chevron-right')}</button></div></div>
    <div class="reader-inner"><div class="reader-top-eyebrow"><span class="reader-tag-pill">${m.folder === 'inbox' ? 'Inbox' : safe(displayFolders[m.folder] || 'Mail')}</span><span class="reader-date-line">${safe(fullDate(m.date))}</span></div><h2 class="reader-title">${safe(m.subject)}</h2><div class="reader-subline">${m.labels.map(l=>`<span class="message-label ${safe(l)}">${safe(l)}</span>`).join('')}${m.priority ? '<span class="priority-mark">● High priority</span>' : ''}</div><div class="sender-card">${avatar(m.from)}<div class="sender-card-info"><strong>${safe(m.from)} <em>&lt;${safe(m.email)}&gt;</em></strong><small>To: ${safe(m.to)}</small></div><div class="sender-actions">${senderAction}</div></div><div class="mail-content">${m.body.split(/\n\n/).map(t=>`<p>${safe(t).replace(/\n/g,'<br>')}</p>`).join('')}</div>${attachmentMarkup}${state.settings.aiShortcuts ? `<div class="reader-ai-suggestion"><span class="suggestion-orb">${icon('sparkle')}</span><div><strong>Let AI take it from here</strong><p>Get a quick summary, draft a reply, or identify your next steps.</p></div><button type="button" data-reader-action="ai">${icon('sparkle','small')} Ask Aster AI</button></div>` : ''}${repliesMarkup}<div class="reader-reply-bottom">${bottomAction}</div></div>`;
    $('readerContent').innerHTML = readerContent;
  }
  function render() {
    applySettings();
    renderNav();
    const list = visibleMessages();
    ensureSelection(list);
    renderList(list);
    renderReader(list);
  }
  function applySettings() {
    document.body.classList.toggle('dark', state.settings.dark);
    $('themeButton').innerHTML = icon(state.settings.dark ? 'sun' : 'moon');
    $('darkSetting').checked = state.settings.dark;
    $('compactSetting').checked = state.settings.compact;
    $('aiSetting').checked = state.settings.aiShortcuts;
  }
  function toast(message) {
    const el = document.createElement('div'); el.className = 'toast';
    el.innerHTML = `${icon('circle-check')}<span>${safe(message)}</span>`;
    $('toastRegion').appendChild(el);
    setTimeout(() => el.remove(), 4100);
  }
  function setFolder(folder) {
    state.folder = folder; state.filter = 'all'; state.search = ''; state.selectedId = null;
    state.mobileReading = false; $('searchInput').value = '';
    document.querySelector('.mail-workspace').classList.remove('show-reader');
    closeMobileMenu(); render();
  }
  function selectMessage(id) {
    const m = state.messages.find(x => x.id === Number(id)); if (!m) return;
    state.selectedId = m.id; m.unread = false;
    persist(); render();
    api(`/mail/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ unread: false }) }).catch(() => {});
    if (m.folder === 'drafts') { openComposer('draft'); return; }
    state.mobileReading = true;
    document.querySelector('.mail-workspace').classList.add('show-reader');
  }
  function updateMessage(action) {
    const m = selectedMessage(); if (!m) return;
    const patch = (payload, note) => { Object.assign(m, payload); persist(); render(); api(`/mail/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify(payload) }).catch(() => toast('Change may not have saved', ) || toast(note)); };
    if (action === 'star') { m.starred = !m.starred; persist(); render(); api(`/mail/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ starred: m.starred }) }).catch(() => {}); toast(m.starred ? 'Message starred' : 'Star removed'); }
    if (action === 'unread') { m.unread = !m.unread; persist(); render(); api(`/mail/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ unread: m.unread }) }).catch(() => {}); toast(m.unread ? 'Marked as unread' : 'Marked as read'); }
    if (action === 'archive') { m.folder = 'archive'; persist(); render(); api(`/mail/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ folder: 'archive' }) }).catch(() => {}); toast('Message moved to Archive'); }
    if (action === 'restore') { m.folder = 'inbox'; persist(); render(); api(`/mail/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ folder: 'inbox' }) }).catch(() => {}); toast('Message restored to Inbox'); }
    if (action === 'trash') {
      if (m.folder === 'trash') {
        if (!confirm('Permanently remove this message?')) return;
        api(`/mail/messages/${m.id}`, { method: 'DELETE' }).catch(() => {});
        state.messages = state.messages.filter(x => x.id !== m.id);
        persist(); render();
        toast('Message permanently deleted');
      } else { m.folder = 'trash'; persist(); render(); api(`/mail/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ folder: 'trash' }) }).catch(() => {}); toast('Message moved to Trash'); }
    }
  }
  function closeMobileMenu() { $('sidebar').classList.remove('mobile-open'); $('mobileOverlay').hidden = true; }
  function showOverlay(type) {
    const overlay = $(`${type}Overlay`), panel = $(type === 'ai' ? 'aiDrawer' : type === 'compose' ? 'composeDrawer' : 'settingsDialog');
    overlay.hidden = false; panel.classList.add('open'); panel.setAttribute('aria-hidden','false'); document.body.classList.add('dialog-open');
  }
  function hideOverlay(type) {
    const overlay = $(`${type}Overlay`), panel = $(type === 'ai' ? 'aiDrawer' : type === 'compose' ? 'composeDrawer' : 'settingsDialog');
    overlay.hidden = true; panel.classList.remove('open'); panel.setAttribute('aria-hidden','true');
    document.body.classList.toggle('dialog-open', ['aiDrawer','composeDrawer','settingsDialog'].some(id => $(id).classList.contains('open')));
  }
  function hideAllOverlays() { ['ai','compose','settings'].forEach(hideOverlay); }
  function openAi() { hideAllOverlays(); showOverlay('ai'); $('aiInput').focus(); }
  function openSettings() { hideAllOverlays(); showOverlay('settings'); }
  function openComposer(mode = 'new', body = '') {
    hideAllOverlays();
    const m = selectedMessage();
    $('composeForm').reset(); state.draftEditingId = null;
    $('composeHeading').textContent = mode === 'new' ? 'Compose email' : mode === 'forward' ? 'Forward email' : mode === 'draft' ? 'Edit draft' : 'Reply to email';
    const currentAccount = state.account !== 'all' ? state.account : (m?.account || accounts[0].email);
    $('composeFrom').value = currentAccount;
    if (mode === 'reply' && m) {
      $('composeTo').value = m.folder === 'sent' ? m.to : m.email;
      $('composeSubject').value = /^Re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
      $('composeBody').value = body;
    } else if (mode === 'forward' && m) {
      $('composeSubject').value = /^Fwd:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`;
      $('composeBody').value = `\n\n---------- Forwarded message ----------\nFrom: ${m.from} <${m.email}>\nSubject: ${m.subject}\n\n${m.body}`;
    } else if (mode === 'draft' && m) {
      state.draftEditingId = m.id;
      $('composeFrom').value = m.account;
      $('composeTo').value = m.to;
      $('composeSubject').value = m.subject;
      $('composeBody').value = m.body;
    }
    showOverlay('compose');
    setTimeout(() => $(mode === 'new' ? 'composeTo' : 'composeBody').focus(), 50);
  }
  function composeValues() { return { account:$('composeFrom').value, to:$('composeTo').value.trim(), subject:$('composeSubject').value.trim(), body:$('composeBody').value.trim() }; }
  const localName = s => { const l = String(s).split('@')[0] || s; return l.charAt(0).toUpperCase() + l.slice(1); };

  async function createOutgoing(folder) {
    const vals = composeValues();
    if (!vals.to || !vals.subject || !vals.body) { toast('Add a recipient, subject, and message first'); return; }
    const payload = { fromEmail: vals.account, to: vals.to, subject: vals.subject, body: vals.body };
    if (folder === 'drafts' && state.draftEditingId) {
      const old = state.messages.find(m => m.id === state.draftEditingId);
      state.draftEditingId = null;
      if (old) {
        try {
          const upd = await api(`/mail/messages/${old.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
          Object.assign(old, upd.message);
          persist(); hideOverlay('compose'); setFolder('drafts');
          state.selectedId = old.id; render();
          toast('Draft updated');
        } catch (e) { if (e.message !== 'unauthorized') toast('Could not save draft: ' + e.message); }
        return;
      }
    }
    const tempId = -Date.now();
    const optimistic = {
      id: tempId, folder, account: vals.account, from: localName(vals.account), email: vals.account, to: vals.to,
      subject: vals.subject, body: vals.body, snippet: vals.body.replace(/\s+/g, ' ').slice(0, 95),
      date: new Date().toISOString(), unread: false, starred: false,
      priority: false, labels: [], attachments: [], thread: []
    };
    state.messages.unshift(optimistic);
    persist(); hideOverlay('compose'); setFolder(folder);
    state.selectedId = tempId; render();
    try {
      const data = folder === 'sent'
        ? await api('/mail/send', { method: 'POST', body: JSON.stringify(payload) })
        : await api('/mail/drafts', { method: 'POST', body: JSON.stringify(payload) });
      const m = data.message;
      const ix = state.messages.findIndex(x => x.id === tempId);
      if (ix >= 0) state.messages[ix] = m;
      state.selectedId = m.id; render();
      if (folder === 'sent') toast(data.delivered ? `Delivered to ${vals.to}` : (data.warning || 'Saved to Sent'));
      else toast('Draft saved');
    } catch (e) {
      const ix = state.messages.findIndex(x => x.id === tempId);
      if (ix >= 0) state.messages.splice(ix, 1);
      persist(); render();
      toast(e.message === 'unauthorized' ? 'Session expired — reloading…' : ('Could not send: ' + e.message));
      if (e.message === 'unauthorized') setTimeout(() => window.location.reload(), 1200);
    }
  }
  function improveDraft() {
    const current = $('composeBody').value.trim();
    if (!current) {
      $('composeBody').value = 'Hello,\n\nThank you for getting in touch. I wanted to follow up and share a quick update on the next steps.\n\nPlease let me know if you have any questions.\n\nBest regards,\nAlex';
    } else {
      let clean = current.replace(/^(hi|hello|hey)[^\n]*\n*/i,'').replace(/\n*(best|regards|thanks|sincerely)[,\s\S]*$/i,'').trim();
      clean = clean.charAt(0).toUpperCase()+clean.slice(1);
      if (clean && !/[.!?]$/.test(clean)) clean += '.';
      $('composeBody').value = `Hello,\n\n${clean}\n\nPlease feel free to reach out if you need anything further.\n\nBest regards,\nAlex`;
    }
    toast('Demo rewrite applied — no AI service was contacted');
  }
  function addChatBubble(text, from, replyButton = false) {
    const bubble = document.createElement('div'); bubble.className = `chat-bubble from-${from}`;
    if (from === 'ai') {
      const heading = document.createElement('strong'); heading.textContent = 'Aster AI · Demo response'; bubble.appendChild(heading);
    }
    const content = document.createElement('span'); content.textContent = text; bubble.appendChild(content);
    if (replyButton) {
      const use = document.createElement('button'); use.type = 'button'; use.textContent = 'Use this reply in composer';
      use.addEventListener('click', () => openComposer('reply', state.lastAiReply)); bubble.appendChild(use);
    }
    $('aiChatHistory').appendChild(bubble);
    bubble.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
  function aiResponse(action) {
    const m = selectedMessage();
    if (!m) return { text:'Choose a message from your inbox first, then try this action again.', reply:false };
    const firstParagraph = m.body.split(/\n\n/).find(p => p.length > 70) || m.snippet;
    const brief = firstParagraph.replace(/\s+/g,' ').slice(0,230).trim();
    if (action === 'summarize') return { text:`Summary of “${m.subject}”\n\n${brief}${brief.length >= 230 ? '…' : ''}\n\nSuggested next step: review the request and respond if action is needed. This is an illustrative, rule-based summary.`, reply:false };
    if (action === 'actions') return { text:`Potential follow-ups from “${m.subject}”:\n\n• Review the email and any referenced attachments.\n• Decide whether a reply or approval is needed.\n• Follow up with ${m.from} if anything is outstanding.\n\nThese are demo suggestions, not model-extracted tasks.`, reply:false };
    if (action === 'reply') {
      state.lastAiReply = `Hi ${m.from.split(' ')[0]},\n\nThank you for your email about ${m.subject.replace(/^Re:\s*/i,'').toLowerCase()}. I've received your message and will review the details.\n\nI'll get back to you with an update as soon as I can.\n\nBest regards,\nAlex`;
      return { text:state.lastAiReply, reply:true };
    }
    return { text:`For this preview, I can demonstrate summaries, suggested replies, and action items for “${m.subject}”.\n\nA production AI integration could search all authorized mailboxes, retrieve relevant context, and provide grounded answers. This demo does not query a language model.`, reply:false };
  }
  function runAiAction(action, userText) {
    const display = userText || ({summarize:'Summarize the selected email', reply:'Draft a thoughtful reply', actions:'Extract next steps'}[action] || 'Help with this email');
    addChatBubble(display,'user');
    const response = aiResponse(action);
    addChatBubble(response.text,'ai',response.reply);
  }
  function changeTheme() { state.settings.dark = !state.settings.dark; persist(); applySettings(); }

  // Event handlers are delegated where content is dynamically rendered.
  $('folderNav').addEventListener('click', e => { const item = e.target.closest('[data-folder]'); if(item) setFolder(item.dataset.folder); });
  $('labelNav').addEventListener('click', e => { const item = e.target.closest('[data-folder]'); if(item) setFolder(item.dataset.folder); });
  $('filterTabs').addEventListener('click', e => { const item = e.target.closest('[data-filter]'); if(!item) return; state.filter = item.dataset.filter; state.selectedId = null; render(); });
  $('searchInput').addEventListener('input', e => { state.search = e.target.value.trim(); state.selectedId = null; render(); });
  $('messageList').addEventListener('click', e => {
    const star = e.target.closest('[data-star-id]');
    if (star) { e.stopPropagation(); const m=state.messages.find(x=>x.id===Number(star.dataset.starId)); if(m) {m.starred=!m.starred;persist();render(); api(`/mail/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ starred: m.starred }) }).catch(()=>{});} return; }
    const row = e.target.closest('[data-message-id]'); if(row) selectMessage(row.dataset.messageId);
  });
  $('messageList').addEventListener('keydown', e => { if ((e.key==='Enter'||e.key===' ') && e.target.matches('[data-message-id]')) { e.preventDefault(); selectMessage(e.target.dataset.messageId); } });
  $('readerContent').addEventListener('click', e => {
    const el = e.target.closest('[data-reader-action]'); if (!el) return;
    const action = el.dataset.readerAction;
    if (['star','unread','archive','trash','restore'].includes(action)) updateMessage(action);
    else if (action === 'reply') openComposer('reply');
    else if (action === 'edit') openComposer('draft');
    else if (action === 'forward') openComposer('forward');
    else if (action === 'compose') openComposer();
    else if (action === 'ai') openAi();
    else if (action === 'attachment') toast('Attachments are placeholders in this prototype');
    else if (action === 'back') document.querySelector('.mail-workspace').classList.remove('show-reader');
    else if (action === 'next' || action === 'prev') {
      const list = visibleMessages(), i = list.findIndex(m=>m.id===state.selectedId);
      if (list[i + (action==='next'?1:-1)]) selectMessage(list[i + (action==='next'?1:-1)].id);
    }
  });
  $('accountButton').addEventListener('click', () => { const el=$('accountMenu'); el.hidden=!el.hidden; $('accountButton').setAttribute('aria-expanded',String(!el.hidden)); });
  $('accountMenu').addEventListener('click', e => {
    const el = e.target.closest('[data-account]'); if (!el) return;
    state.account = el.dataset.account; state.selectedId=null; state.filter='all'; state.search=''; $('searchInput').value='';
    $('accountMenu').hidden=true; $('accountButton').setAttribute('aria-expanded','false'); renderAccountMenu(); render(); closeMobileMenu();
    document.querySelector('.mail-workspace').classList.remove('show-reader');
  });
  document.addEventListener('click', e => { if (!$('accountSwitcher').contains(e.target)) { $('accountMenu').hidden=true; $('accountButton').setAttribute('aria-expanded','false'); } });
  $('mobileMenu').addEventListener('click', () => { $('sidebar').classList.add('mobile-open'); $('mobileOverlay').hidden=false; });
  $('mobileOverlay').addEventListener('click', closeMobileMenu);
  $('composeButton').addEventListener('click', () => { closeMobileMenu(); openComposer(); });
  $('themeButton').addEventListener('click', changeTheme);
  $('settingsButton').addEventListener('click', () => { closeMobileMenu(); openSettings(); });
  $('settingsDone').addEventListener('click', () => hideOverlay('settings'));
  $('closeSettings').addEventListener('click', () => hideOverlay('settings'));
  $('settingsOverlay').addEventListener('click', () => hideOverlay('settings'));
  $('darkSetting').addEventListener('change', e => { state.settings.dark=e.target.checked; persist(); applySettings(); });
  $('compactSetting').addEventListener('change', e => { state.settings.compact=e.target.checked; persist(); render(); });
  $('aiSetting').addEventListener('change', e => { state.settings.aiShortcuts=e.target.checked; persist(); render(); });
  $('openAiTop').addEventListener('click', openAi);
  $('openAiPromo').addEventListener('click', () => { closeMobileMenu(); openAi(); });
  $('closeAi').addEventListener('click', () => hideOverlay('ai'));
  $('aiOverlay').addEventListener('click', () => hideOverlay('ai'));
  $('aiDrawer').addEventListener('click', e => { const el=e.target.closest('[data-ai-action]'); if(el) runAiAction(el.dataset.aiAction); });
  $('aiForm').addEventListener('submit', e => {
    e.preventDefault(); const text = $('aiInput').value.trim(); if(!text)return;
    $('aiInput').value='';
    const phrase=text.toLowerCase(), action = /summari[sz]|overview|tl;dr/.test(phrase)?'summarize':/reply|respond|draft|write/.test(phrase)?'reply':/action|todo|task|next step/.test(phrase)?'actions':'general';
    runAiAction(action,text);
  });
  $('closeCompose').addEventListener('click', () => hideOverlay('compose'));
  $('composeOverlay').addEventListener('click', () => hideOverlay('compose'));
  $('composeForm').addEventListener('submit', e => { e.preventDefault(); createOutgoing('sent'); });
  $('saveDraftButton').addEventListener('click', () => createOutgoing('drafts'));
  $('composeAiButton').addEventListener('click', improveDraft);
  $('refreshButton').addEventListener('click', () => { reloadMessages(); });
  $('labelsInfo').addEventListener('click', () => toast('Labels are sample categories in this prototype'));
  $('resetDemoButton').addEventListener('click', () => { reloadMessages(); });
  document.addEventListener('keydown', e => {
    if (e.key==='Escape') { hideAllOverlays();closeMobileMenu();$('accountMenu').hidden=true; return; }
    if (e.target.closest('input,textarea,select,[contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key==='/' || e.key==='k') { e.preventDefault(); $('searchInput').focus(); }
    if (e.key.toLowerCase()==='n') { e.preventDefault(); openComposer(); }
  });
  // Convenience: open saved drafts for editing rather than replying to them.
  $('messageList').addEventListener('dblclick', e => { const el=e.target.closest('[data-message-id]'); const m=el&&state.messages.find(x=>x.id===Number(el.dataset.messageId)); if(m?.folder==='drafts') openComposer('draft'); });

  renderAccountMenu(); render();
  boot();
})();
