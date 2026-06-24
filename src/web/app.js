const state = {
  token: sessionStorage.getItem('wdtt-fleet-admin-token') ?? '',
  dashboard: null,
};

const titleByView = {
  overview: 'Обзор флота',
  nodes: 'Узлы WDTT',
  users: 'Пользователи флота',
  commands: 'Команды управления',
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function relativeApi(path) {
  return new URL(path.replace(/^\//, ''), window.location.href).toString();
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1; }
  return `${current >= 10 || unit === 0 ? Math.round(current) : current.toFixed(1)} ${units[unit]}`;
}

function isRecent(node) {
  return node.state === 'active' && node.lastSeenAt && Date.now() - new Date(node.lastSeenAt).valueOf() < 2 * 60_000;
}

function notice(message, kind = 'info') {
  const element = $('#notice');
  element.hidden = false;
  element.className = `notice ${kind}`;
  element.textContent = message;
  window.clearTimeout(notice.timeout);
  notice.timeout = window.setTimeout(() => { element.hidden = true; }, 6000);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set('accept', 'application/json');
  if (state.token) headers.set('authorization', `Bearer ${state.token}`);
  if (options.body) headers.set('content-type', 'application/json');
  const response = await fetch(relativeApi(path), { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) setConnected(false);
    throw new Error(body.error?.code === 'unauthenticated' ? 'Не удалось подтвердить доступ.' : 'Операция не выполнена. Проверьте введённые данные и состояние узла.');
  }
  return body;
}

function setConnected(connected) {
  const dot = $('#connection-state');
  dot.className = `status-dot ${connected ? 'ok' : 'muted'}`;
  $('#connection-label').textContent = connected ? (state.token ? 'Токен оператора' : 'Защищено сервером') : 'Не подключено';
}

function showView(view) {
  for (const element of document.querySelectorAll('.view')) element.hidden = element.id !== `view-${view}`;
  for (const button of document.querySelectorAll('.nav-item')) button.classList.toggle('active', button.dataset.view === view);
  $('#page-title').textContent = titleByView[view];
}

function renderOverview(data) {
  const nodes = data.nodes;
  const users = data.users;
  const onlineUsers = users.filter((user) => user.online).length;
  const pending = data.commands.filter((command) => command.status === 'queued' || command.status === 'delivered').length;
  $('#metric-nodes').textContent = nodes.length;
  $('#metric-active').textContent = `${nodes.filter((node) => node.state === 'active').length} активных`;
  $('#metric-users').textContent = users.length;
  $('#metric-online').textContent = onlineUsers;
  $('#metric-pending').textContent = pending;
  $('#overview-nodes').classList.toggle('empty', nodes.length === 0);
  $('#overview-nodes').innerHTML = nodes.length ? nodes.map((node) => `
    <div class="node-row"><span class="status-dot ${isRecent(node) ? 'ok' : node.state === 'revoked' ? 'danger' : 'muted'}"></span>
      <div><strong>${escapeHtml(node.label)}</strong><small>${node.state === 'revoked' ? 'Отозван' : isRecent(node) ? 'На связи' : 'Нет свежего heartbeat'}</small></div>
      <time>${formatDate(node.lastSeenAt)}</time></div>`).join('') : 'Узлы ещё не зарегистрированы.';
}

function renderNodes(data) {
  const nodes = data.nodes;
  $('#nodes-table').innerHTML = nodes.length ? nodes.map((node) => `
    <tr><td><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(node.id)}</small></td>
      <td><span class="badge ${node.state === 'revoked' ? 'danger' : isRecent(node) ? 'success' : 'neutral'}">${node.state === 'revoked' ? 'Отозван' : isRecent(node) ? 'На связи' : 'Ожидает'}</span></td>
      <td>${formatDate(node.lastSeenAt)}</td><td>${escapeHtml(node.reportedVersions?.agentVersion ?? '—')}</td>
      <td>${node.userCount ?? 0}</td><td class="row-actions">${node.state === 'active' ? `<button class="text-button" data-node-action="rotate" data-node-id="${node.id}">Ротация</button><button class="text-button danger-text" data-node-action="revoke" data-node-id="${node.id}">Отозвать</button>` : '—'}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">Нет зарегистрированных узлов.</td></tr>';

  const selected = $('#command-node').value;
  $('#command-node').innerHTML = `<option value="">Выберите узел</option>${nodes.filter((node) => node.state === 'active').map((node) => `<option value="${node.id}">${escapeHtml(node.label)}</option>`).join('')}`;
  $('#command-node').value = [...$('#command-node').options].some((option) => option.value === selected) ? selected : '';
}

function renderUsers(data) {
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  $('#users-table').innerHTML = data.users.length ? data.users.map((user) => `
    <tr><td><strong>${escapeHtml(user.displayName ?? user.sourceUserId)}</strong><small>${escapeHtml(user.sourceUserId)}</small></td>
      <td>${escapeHtml(nodes.get(user.nodeId)?.label ?? user.nodeId)}</td><td>${escapeHtml(user.label ?? '—')}</td>
      <td>${user.devices.length}</td><td>${formatBytes(user.traffic.receivedBytes)} ↓<br>${formatBytes(user.traffic.sentBytes)} ↑</td>
      <td><span class="badge ${user.enabled ? 'success' : 'neutral'}">${user.enabled ? 'Включён' : 'Выключен'}</span></td>
      <td><span class="badge ${user.online ? 'success' : 'neutral'}">${user.online ? 'Online' : 'Offline'}</span></td><td>${formatDate(user.capturedAt)}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">Снимки от агентов ещё не поступали.</td></tr>';
}

function renderCommands(data) {
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  $('#commands-table').innerHTML = data.commands.length ? data.commands.map((command) => `
    <tr><td>${formatDate(command.createdAt)}</td><td>${escapeHtml(nodes.get(command.nodeId)?.label ?? command.nodeId)}</td>
      <td><code>${escapeHtml(command.kind)}</code></td><td><span class="badge ${command.status === 'succeeded' ? 'success' : command.status === 'failed' || command.status === 'expired' ? 'danger' : 'neutral'}">${escapeHtml(command.status)}</span></td>
      <td>${escapeHtml(command.payload.sourceUserId ?? '—')}</td><td>${escapeHtml(command.errorCode ?? '—')}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">Команд ещё нет.</td></tr>';
}

async function refresh() {
  try {
    const data = await api('v1/dashboard');
    state.dashboard = data;
    renderOverview(data);
    renderNodes(data);
    renderUsers(data);
    renderCommands(data);
    setConnected(true);
    $('#access-panel').hidden = true;
  } catch (error) {
    if (state.dashboard) notice(error.message, 'error');
  }
}

function syncCommandFields() {
  const kind = $('#command-kind').value;
  const fields = $('#user-command-fields');
  fields.hidden = kind === 'node.snapshot.read';
  for (const element of document.querySelectorAll('[data-create-only]')) element.hidden = kind !== 'user.create';
  for (const element of document.querySelectorAll('[data-update-only]')) element.hidden = kind !== 'user.update';
}

function toIsoOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error('Неверный срок доступа.');
  return parsed.toISOString();
}

function commandPayload(form, kind) {
  if (kind === 'node.snapshot.read') return {};
  const sourceUserId = form.elements.sourceUserId.value.trim();
  if (!sourceUserId) throw new Error('Укажите локальный ID пользователя.');
  if (kind === 'user.read' || kind === 'user.delete') return { sourceUserId };
  if (kind === 'user.create') {
    return {
      sourceUserId,
      displayName: form.elements.displayName.value.trim() || null,
      label: form.elements.label.value.trim() || null,
      expiresAt: toIsoOrNull(form.elements.expiresAt.value),
      trafficLimitBytes: form.elements.trafficLimitBytes.value === '' ? null : Number(form.elements.trafficLimitBytes.value),
      enabled: form.elements.enabled.checked,
    };
  }
  const patchField = form.elements.patchField.value;
  let patchValue = form.elements.patchValue.value.trim();
  if (!patchValue) throw new Error('Укажите новое значение.');
  if (patchField === 'enabled') {
    if (!['true', 'false'].includes(patchValue)) throw new Error('Для состояния укажите true или false.');
    patchValue = patchValue === 'true';
  } else if (patchField === 'trafficLimitBytes') {
    patchValue = Number(patchValue);
  } else if (patchField === 'expiresAt' && patchValue !== 'null') {
    patchValue = toIsoOrNull(patchValue);
  }
  return { sourceUserId, expectedRevision: form.elements.expectedRevision.value.trim(), patch: { [patchField]: patchValue } };
}

async function createGrant(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const expiry = new Date(Date.now() + Number(form.elements.ttl.value) * 60_000).toISOString();
    const data = await api('v1/enrollment-grants', {
      method: 'POST', body: JSON.stringify({ label: form.elements.label.value, expiresAt: expiry }),
    });
    $('#grant-result').classList.remove('empty');
    $('#grant-result').innerHTML = `<p class="eyebrow">ПЕРЕДАТЬ АГЕНТУ ОДИН РАЗ</p><h2>${escapeHtml(data.grant.label)}</h2><p>Действует до ${formatDate(data.grant.expiresAt)}.</p>${data.agentEndpoint ? `<p class="form-help">Адрес агента</p><code class="secret">${escapeHtml(data.agentEndpoint)}</code>` : ''}<code class="secret" id="grant-token">${escapeHtml(data.token)}</code><button id="copy-grant" class="button secondary">Копировать грант</button><p class="form-help">После закрытия этого сообщения токен не восстановить. Не добавляйте его в логи или чат.</p>`;
    form.reset();
    notice('Одноразовый грант создан.', 'success');
  } catch (error) { notice(error.message, 'error'); }
}

async function submitCommand(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const kind = form.elements.kind.value;
    const payload = commandPayload(form, kind);
    if (!form.elements.nodeId.value) throw new Error('Выберите активный узел.');
    await api('v1/commands', {
      method: 'POST',
      body: JSON.stringify({ nodeId: form.elements.nodeId.value, kind, payload, idempotencyKey: crypto.randomUUID() }),
    });
    notice('Команда поставлена в очередь.', 'success');
    await refresh();
  } catch (error) { notice(error.message, 'error'); }
}

async function nodeAction(event) {
  const button = event.target.closest('[data-node-action]');
  if (!button) return;
  const nodeId = button.dataset.nodeId;
  const action = button.dataset.nodeAction;
  if (action === 'revoke' && !window.confirm('Отозвать узел? Его агент немедленно потеряет доступ.')) return;
  try {
    const path = action === 'rotate' ? `v1/nodes/${nodeId}/credentials/rotate` : `v1/nodes/${nodeId}/revoke`;
    const body = await api(path, { method: 'POST' });
    if (action === 'rotate') {
      $('#grant-result').classList.remove('empty');
      $('#grant-result').innerHTML = `<p class="eyebrow">НОВЫЙ ТОКЕН АГЕНТА</p><h2>Ротация выполнена</h2><code class="secret">${escapeHtml(body.agentToken)}</code><p class="form-help">Показывается один раз. Старый токен уже недействителен.</p>`;
    }
    notice(action === 'rotate' ? 'Учётные данные узла обновлены.' : 'Узел отозван.', 'success');
    await refresh();
  } catch (error) { notice(error.message, 'error'); }
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
  $('#open-access').addEventListener('click', () => { $('#access-panel').hidden = !$('#access-panel').hidden; $('#access-token').focus(); });
  $('#forget-access').addEventListener('click', () => {
    state.token = ''; sessionStorage.removeItem('wdtt-fleet-admin-token'); $('#access-token').value = ''; setConnected(false);
  });
  $('#access-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    state.token = $('#access-token').value.trim();
    sessionStorage.setItem('wdtt-fleet-admin-token', state.token);
    await refresh();
    if (!state.dashboard) notice('Доступ не подтверждён.', 'error');
  });
  $('#refresh-overview').addEventListener('click', refresh);
  $('#refresh-nodes').addEventListener('click', refresh);
  $('#refresh-users').addEventListener('click', refresh);
  $('#refresh-commands').addEventListener('click', refresh);
  $('#grant-form').addEventListener('submit', createGrant);
  $('#command-form').addEventListener('submit', submitCommand);
  $('#command-kind').addEventListener('change', syncCommandFields);
  $('#nodes-table').addEventListener('click', nodeAction);
  $('#grant-result').addEventListener('click', async (event) => {
    if (event.target.id !== 'copy-grant') return;
    const token = $('#grant-token')?.textContent;
    if (!token) return;
    await navigator.clipboard.writeText(token);
    notice('Грант скопирован в буфер обмена.', 'success');
  });
}

bindEvents();
syncCommandFields();
setConnected(false);
refresh();
