import type { Actor } from "../auth.ts";
import type { TopicSummary } from "../protocol.ts";
import type { AgentInfo } from "./topics.tsx";
import { Page } from "./layout.tsx";

// ── Shared accordion ──

function AccordionSection({ id, label, open, action, children }: {
  id: string; label: string; open?: boolean; action?: string; children?: string;
}): string {
  return (
    <details id={id} open={open} class="border-b border-gray-200">
      <summary class="px-3 py-1.5 bg-gray-50 flex items-center gap-1 cursor-pointer hover:bg-gray-100 select-none text-xs font-semibold text-gray-500 uppercase tracking-wider">
        <span class="flex-1">{label}</span>
        {action ? <span dangerouslySetInnerHTML={{ __html: action }} /> : null}
      </summary>
      <div>{children}</div>
    </details>
  );
}

// ── Left panel (shared between workspace overview and topic view) ──

export interface WorkspaceMemberUI {
  id: string;
  displayName: string;
  role: "owner" | "member";
}

function LeftPanel({ wsName, topicName, topics, agents, members, resourcesUrl, namespace, uiBase }: {
  wsName: string;
  topicName?: string;
  topics: TopicSummary[];
  agents: AgentInfo[];
  members: WorkspaceMemberUI[];
  resourcesUrl: string;
  namespace: string;
  uiBase: string;
}): string {
  return (
    <div class="w-64 shrink-0 bg-white flex flex-col overflow-hidden">
      {/* Workspace header */}
      <div class="px-3 py-1.5 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
        <a href="/ui" class="text-gray-400 hover:text-gray-600 text-sm">&larr;</a>
        <span class="font-semibold text-sm text-gray-900 truncate">{wsName}</span>
      </div>

      <div class="flex-1 overflow-y-auto">
        {/* Topics */}
        <AccordionSection id="acc-topics" label="Topics" open
          action={`<button onclick="event.preventDefault(); event.stopPropagation(); document.getElementById('dlg-topic').showModal()" class="text-indigo-400 hover:text-indigo-700 hover:bg-indigo-100 rounded px-1 py-0.5 cursor-pointer transition" title="New topic"><i class="fa-solid fa-plus text-[10px]"></i></button>`}>
          <div id="tp-list-inner">
            {topics.map(tp => {
              const active = tp.name === topicName;
              const topicUrl = `/ui/${encodeURIComponent(wsName)}/${encodeURIComponent(tp.name)}`;
              return (
                <a href={topicUrl}
                  class={`group flex items-center gap-2 px-3 py-1.5 text-sm ${active ? "bg-indigo-50 text-indigo-700 font-medium" : "text-gray-700 hover:bg-gray-50"}`}
                  onclick={active ? `event.preventDefault(); var fc=document.getElementById('file-content'); if(fc){fc.className='hidden'; fc.innerHTML='';} var tp=document.getElementById('topic-pane'); if(tp) tp.className='flex-1 flex flex-col overflow-hidden'; history.pushState(null,'','${topicUrl}')` : undefined}>
                  <span class="truncate flex-1">{tp.name}</span>
                  {tp.activeRun
                    ? <span class="w-2 h-2 rounded-full bg-green-500 shrink-0"></span>
                    : null}
                  <button onclick={`event.preventDefault(); event.stopPropagation(); if(confirm('Delete topic "${tp.name}"?')) fetch('/apis/v1/namespaces/${namespace}/workspaces/${encodeURIComponent(wsName)}/topics/${encodeURIComponent(tp.name)}',{method:'DELETE',credentials:'include'}).then(function(){location.href='/ui/${encodeURIComponent(wsName)}'})`}
                    class="hidden group-hover:inline text-gray-300 hover:text-red-500 text-xs cursor-pointer"
                    title="Delete topic"><i class="fa-solid fa-trash text-[9px]"></i></button>
                </a>
              );
            })}
          </div>
        </AccordionSection>

        {/* New topic dialog */}
        <dialog id="dlg-topic" class="w-80">
          <form class="p-4"
                hx-post={`/htmx/${encodeURIComponent(wsName)}/topics`}
                hx-target="#tp-list-inner" hx-swap="innerHTML"
                hx-disabled-elt="find button[type=submit]"
                hx-on-htmx-after-request="document.getElementById('dlg-topic').close(); this.reset()">
            <h3 class="text-sm font-bold mb-3">New Topic</h3>
            <input name="name" placeholder="Topic name" required autofocus
              class="w-full border rounded px-3 py-2 text-sm mb-2" />
            {agents.length > 0 && (
              <div class="mb-3">
                <label class="text-xs text-gray-500 mb-1 block">Agent (optional)</label>
                <select name="agent" class="w-full border rounded px-3 py-2 text-sm">
                  <option value="">None (human only)</option>
                  {agents.map(a => <option value={a.id}>{a.name}</option>)}
                </select>
              </div>
            )}
            <div class="flex justify-end gap-2">
              <button type="button" onclick="this.closest('dialog').close()"
                class="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
              <button type="submit"
                class="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50">Create</button>
            </div>
          </form>
        </dialog>

        {/* Files */}
        <AccordionSection id="acc-files-section" label="Files" open
          action={`<button onclick="event.preventDefault(); event.stopPropagation(); document.getElementById('dlg-file').showModal()" class="text-indigo-400 hover:text-indigo-700 hover:bg-indigo-100 rounded px-1 py-0.5 cursor-pointer transition" title="New file"><i class="fa-solid fa-plus text-[10px]"></i></button>`}>
          <div id="acc-files"
               hx-get={`${resourcesUrl}/?path=&base=${encodeURIComponent(resourcesUrl)}&ui=${encodeURIComponent(uiBase)}`}
               hx-trigger="load" hx-swap="innerHTML">
            <p class="px-3 py-2 text-xs text-gray-400">Loading...</p>
          </div>
        </AccordionSection>

        {/* Members */}
        <AccordionSection id="acc-members" label="Members"
          action={`<button onclick="event.preventDefault(); event.stopPropagation(); document.getElementById('dlg-member').showModal()" class="text-indigo-400 hover:text-indigo-700 hover:bg-indigo-100 rounded px-1 py-0.5 cursor-pointer transition" title="Invite member"><i class="fa-solid fa-plus text-[10px]"></i></button>`}>
          <div id="members-list">
            {members.map(m => (
              <div class="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700">
                <span class="inline-flex w-6 h-6 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-600 shrink-0">
                  {m.displayName.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2)}
                </span>
                <span class="truncate flex-1">{m.displayName}</span>
                {m.role === "owner"
                  ? <span class="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">owner</span>
                  : null}
              </div>
            ))}
            {members.length === 0 && (
              <p class="px-3 py-2 text-xs text-gray-400">No members (open access)</p>
            )}
          </div>
        </AccordionSection>

        {/* Invite member dialog */}
        <dialog id="dlg-member" class="w-96">
          <div class="p-4">
            <h3 class="text-sm font-bold mb-3">Invite Member</h3>
            <label class="block text-xs font-medium text-gray-600 mb-1">Search user</label>
            <div class="relative">
              <input id="member-search" type="text" placeholder="Type name or email..." autofocus autocomplete="off"
                class="w-full border rounded px-3 py-2 text-sm" />
              <div id="member-results" class="absolute z-10 top-full left-0 right-0 bg-white border rounded-b shadow-lg max-h-48 overflow-y-auto hidden"></div>
            </div>
            <div id="member-selected" class="mt-2 hidden">
              <div class="flex items-center gap-2 bg-indigo-50 border border-indigo-200 rounded px-3 py-2">
                <span id="member-sel-avatar" class="inline-flex w-7 h-7 items-center justify-center rounded-full bg-indigo-200 text-xs font-medium text-indigo-700 shrink-0"></span>
                <div class="flex-1 min-w-0">
                  <div id="member-sel-name" class="text-sm font-medium truncate"></div>
                  <div id="member-sel-email" class="text-xs text-gray-500 truncate"></div>
                </div>
                <button type="button" id="member-clear" class="text-gray-400 hover:text-red-500 text-sm cursor-pointer">&times;</button>
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-4 pt-3 border-t">
              <button type="button" onclick="this.closest('dialog').close()"
                class="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
              <button type="button" id="member-invite-btn" disabled
                class="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50 cursor-pointer">Invite</button>
            </div>
          </div>
          <script dangerouslySetInnerHTML={{ __html: `
(function() {
  var dlg = document.getElementById('dlg-member');
  var input = document.getElementById('member-search');
  var results = document.getElementById('member-results');
  var selected = document.getElementById('member-selected');
  var selName = document.getElementById('member-sel-name');
  var selEmail = document.getElementById('member-sel-email');
  var selAvatar = document.getElementById('member-sel-avatar');
  var clearBtn = document.getElementById('member-clear');
  var inviteBtn = document.getElementById('member-invite-btn');
  var chosenUser = null;
  var debounce = null;

  input.addEventListener('input', function() {
    var q = input.value.trim();
    if (q.length < 2) { results.classList.add('hidden'); results.innerHTML = ''; return; }
    clearTimeout(debounce);
    debounce = setTimeout(function() {
      fetch('/api/users?q=' + encodeURIComponent(q))
        .then(function(r) { return r.json(); })
        .then(function(users) {
          if (users.length === 0) {
            results.innerHTML = '<div class="px-3 py-2 text-sm text-gray-400">No users found. <button type="button" class="text-indigo-600 underline" onclick="document.getElementById(\\'member-manual\\').classList.remove(\\'hidden\\'); document.getElementById(\\'member-results\\').classList.add(\\'hidden\\')">Enter manually</button></div>';
            results.classList.remove('hidden');
            return;
          }
          results.innerHTML = users.map(function(u) {
            var initials = u.displayName.split(/\\s+/).map(function(w){return w[0]}).join('').toUpperCase().slice(0,2);
            return '<div class="flex items-center gap-2 px-3 py-2 hover:bg-indigo-50 cursor-pointer text-sm" data-id="' + u.id + '" data-name="' + u.displayName.replace(/"/g,'&quot;') + '" data-email="' + (u.email||'').replace(/"/g,'&quot;') + '">'
              + '<span class="inline-flex w-6 h-6 items-center justify-center rounded-full bg-gray-200 text-[10px] font-medium shrink-0">' + initials + '</span>'
              + '<div class="min-w-0"><div class="truncate">' + u.displayName + '</div>'
              + (u.email ? '<div class="text-xs text-gray-400 truncate">' + u.email + '</div>' : '')
              + '</div></div>';
          }).join('');
          results.classList.remove('hidden');
        });
    }, 300);
  });

  results.addEventListener('click', function(e) {
    var el = e.target.closest('[data-id]');
    if (!el) return;
    chosenUser = { id: el.dataset.id, displayName: el.dataset.name, email: el.dataset.email };
    var initials = chosenUser.displayName.split(/\\s+/).map(function(w){return w[0]}).join('').toUpperCase().slice(0,2);
    selAvatar.textContent = initials;
    selName.textContent = chosenUser.displayName;
    selEmail.textContent = chosenUser.email || chosenUser.id;
    selected.classList.remove('hidden');
    input.classList.add('hidden');
    results.classList.add('hidden');
    inviteBtn.disabled = false;
  });

  clearBtn.addEventListener('click', function() {
    chosenUser = null;
    selected.classList.add('hidden');
    input.classList.remove('hidden');
    input.value = '';
    input.focus();
    inviteBtn.disabled = true;
  });

  inviteBtn.addEventListener('click', function() {
    if (!chosenUser) return;
    var token = (document.cookie.match(/ws-token=([^;]+)/)||[])[1]||'';
    fetch('/apis/v1/namespaces/${namespace}/workspaces/' + encodeURIComponent('${wsName}') + '/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ id: chosenUser.id, displayName: chosenUser.displayName })
    }).then(function(r) {
      if (r.ok) { dlg.close(); location.reload(); }
      else { r.json().then(function(j) { alert(j.error || 'Error'); }); }
    });
  });

  // Reset on dialog open
  dlg.addEventListener('close', function() {
    chosenUser = null;
    selected.classList.add('hidden');
    input.classList.remove('hidden');
    input.value = '';
    results.classList.add('hidden');
    inviteBtn.disabled = true;
  });
})();
          `}} />
        </dialog>
      </div>

      {/* Bottom: State + Logs pinned to bottom */}
      <div class="shrink-0 border-t border-gray-200">
        {topicName && (
          <AccordionSection id="acc-state" label="State">
            <div class="px-3 py-2 text-sm">
              <div id="run-state" class="text-gray-400">Idle</div>
              <div id="run-queue"></div>
            </div>
          </AccordionSection>
        )}
      </div>
    </div>
  );
}

// ── Workspace overview (no topic selected) ──

interface WorkspaceProps {
  actor: Actor | null;
  oauthEnabled: boolean;
  wsName: string;
  topics: TopicSummary[];
  agents: AgentInfo[];
  members: WorkspaceMemberUI[];
  namespace: string;
  fileContent?: string;
}

export function WorkspacePage({ actor, oauthEnabled, wsName, topics, agents, members, namespace, fileContent }: WorkspaceProps): string {
  const resourcesUrl = `/apis/v1/namespaces/${namespace}/workspaces/${encodeURIComponent(wsName)}/resources`;
  const uiBase = `/ui/${encodeURIComponent(wsName)}`;

  return Page({
    actor,
    oauthEnabled,
    children: (
      <div class="flex h-full" hx-boost="false">
        <LeftPanel wsName={wsName} topics={topics} agents={agents} members={members}
                   resourcesUrl={resourcesUrl} namespace={namespace} uiBase={uiBase} />

        {/* Main area: file content or welcome + console */}
        <div class="flex-1 flex flex-col border-l">
          <div class="flex-1 flex flex-col overflow-hidden">
            <div id="file-content" class={`${fileContent ? "" : "hidden "}flex-1 flex flex-col overflow-hidden`}
                 dangerouslySetInnerHTML={{ __html: fileContent || "" }}></div>
            <div id="welcome" class={`${fileContent ? "hidden " : ""}flex-1 flex items-center justify-center text-gray-400`}>
              <div class="text-center">
                <p class="text-lg font-medium text-gray-500">{wsName}</p>
                <p class="text-sm mt-2">Select a topic to start chatting, or browse files</p>
                {agents.length > 0 && (
                  <div class="mt-4 flex flex-wrap justify-center gap-2">
                    {agents.map(a => (
                      <span class="inline-flex items-center gap-1 text-xs bg-purple-50 text-purple-700 border border-purple-200 rounded-full px-2.5 py-1"
                            title={a.description}>
                        <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0 1 12 2v5h4a1 1 0 0 1 .82 1.573l-7 10A1 1 0 0 1 8 18v-5H4a1 1 0 0 1-.82-1.573l7-10a1 1 0 0 1 1.12-.381Z" clip-rule="evenodd" /></svg>
                        {a.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <ConsolePanel wsName={wsName} namespace={namespace} />
        </div>
      </div>
    ),
  });
}

// ── Topic view (with chat) ──

interface TopicProps {
  actor: Actor | null;
  oauthEnabled: boolean;
  wsName: string;
  topicName: string;
  token: string;
  namespace: string;
  topics: TopicSummary[];
  agents: AgentInfo[];
  members: WorkspaceMemberUI[];
  fileContent?: string;
}

export function TopicPage({ actor, oauthEnabled, wsName, topicName, token, namespace, topics, agents, members, fileContent }: TopicProps): string {
  const resourcesUrl = `/apis/v1/namespaces/${namespace}/workspaces/${encodeURIComponent(wsName)}/resources`;
  const uiBase = `/ui/${encodeURIComponent(wsName)}/${encodeURIComponent(topicName)}`;

  return Page({
    actor,
    oauthEnabled,
    children: (
      <div class="flex h-full" hx-boost="false">
        <LeftPanel wsName={wsName} topicName={topicName} topics={topics} agents={agents} members={members}
                   resourcesUrl={resourcesUrl} namespace={namespace} uiBase={uiBase} />

        {/* Main pane: file OR chat + console */}
        <div class="flex-1 flex flex-col border-l">
          <div class="flex-1 flex flex-col overflow-hidden">
            {/* File pane */}
            <div id="file-content" class={`${fileContent ? "flex-1 flex flex-col overflow-hidden" : "hidden"}`}
                 dangerouslySetInnerHTML={{ __html: fileContent || "" }}></div>

            {/* Topic pane */}
            <div id="topic-pane" class={`${fileContent ? "hidden" : "flex-1 flex flex-col overflow-hidden"}`}>
              <div id="messages" class="flex-1 overflow-y-auto p-4 space-y-4"></div>
              <div class="border-t border-gray-200 bg-white p-3 shrink-0">
                <form id="prompt-form" class="flex gap-2">
                  <input id="prompt-input" type="text" placeholder="Type a message..." autocomplete="off"
                    class="flex-1 rounded-md bg-white px-3 py-2 text-sm text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600"
                    autofocus />
                  <button type="submit"
                    class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500">Send</button>
                  <button type="button" id="btn-interrupt"
                    class="rounded-md bg-red-500 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-red-400 hidden">Stop</button>
                </form>
              </div>
            </div>
          </div>
          <ConsolePanel wsName={wsName} namespace={namespace} />
        </div>

        <ChatScript wsName={wsName} topicName={topicName} token={token} namespace={namespace} />
      </div>
    ),
  });
}

// ── Logs script (shared — works on both workspace and topic pages) ──

function LogsScript({ wsName, namespace }: { wsName: string; namespace: string }): string {
  const script = `
(function() {
  var btn = document.getElementById("btn-logs");
  if (!btn) return;
  var API = "/apis/v1/namespaces/${namespace}/workspaces/${encodeURIComponent(wsName)}";
  btn.addEventListener("click", function() {
    var el = document.getElementById("ws-logs");
    fetch(API + "/logs?lines=50")
      .then(function(r) { return r.text(); })
      .then(function(t) { el.textContent = t; el.classList.remove("hidden"); el.scrollTop = el.scrollHeight; })
      .catch(function(e) { el.textContent = e.message; el.classList.remove("hidden"); });
  });
})();
`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

// ── Console panel (collapsible, tabbed: Logs | Shell) ──

function ConsolePanel({ wsName, namespace }: { wsName: string; namespace: string }): string {
  const api = `/apis/v1/namespaces/${namespace}/workspaces/${encodeURIComponent(wsName)}`;
  return (
    <div id="console-panel" class="shrink-0 border-t border-gray-700 bg-gray-900">
      {/* Header: toggle + tabs */}
      <div class="flex items-center px-2 py-0.5 select-none">
        <button class="text-gray-500 hover:text-gray-300 px-1 cursor-pointer" onclick="var body=document.getElementById('console-body'); body.classList.toggle('hidden'); this.querySelector('.console-chevron').classList.toggle('rotate-180')">
          <i class="fa-solid fa-chevron-down text-[9px] console-chevron transition-transform rotate-180"></i>
        </button>
        <button class="console-tab active text-[11px] px-2 py-0.5 text-gray-300 cursor-pointer" data-tab="logs" onclick="switchTab('logs')">Logs</button>
        <button class="console-tab text-[11px] px-2 py-0.5 text-gray-500 cursor-pointer" data-tab="shell" onclick="switchTab('shell')">Shell</button>
        <span class="flex-1"></span>
        <div id="console-auth-badge" class="hidden text-[10px] text-amber-400 mr-1">
          <i class="fa-solid fa-circle-info"></i> login required
        </div>
      </div>

      <div id="console-body" class="hidden">
        {/* Logs tab */}
        <div id="tab-logs">
          <pre id="console-log" class="text-[11px] text-green-400 whitespace-pre-wrap h-40 overflow-y-auto px-3 py-1 font-mono"></pre>
          <div id="console-auth-bar" class="hidden flex items-center gap-2 px-3 py-1.5 bg-gray-800 border-t border-gray-700 flex-wrap">
            <button id="btn-console-login" class="text-[11px] bg-amber-500 hover:bg-amber-600 text-white px-2 py-1 rounded cursor-pointer">
              <i class="fa-solid fa-play text-[9px] mr-1"></i>Get token
            </button>
            <input id="auth-code" type="text" placeholder="Paste sk-ant-* token here" class="text-[11px] bg-gray-700 text-white border border-gray-600 rounded px-2 py-1 flex-1 min-w-[200px] font-mono" />
            <button id="btn-submit-code" class="text-[11px] bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded cursor-pointer">Set token</button>
          </div>
        </div>

        {/* Shell tab */}
        <div id="tab-shell" class="hidden">
          <pre id="shell-output" class="text-[11px] text-gray-300 whitespace-pre-wrap h-40 overflow-y-auto px-3 py-1 font-mono"></pre>
          <div class="flex items-center gap-1 px-3 py-1.5 bg-gray-800 border-t border-gray-700">
            <span class="text-[11px] text-green-500 font-mono">$</span>
            <input id="shell-input" type="text" placeholder="type command..." autocomplete="off"
              class="flex-1 text-[11px] bg-transparent text-white border-none outline-none font-mono" />
          </div>
        </div>
      </div>

      <script dangerouslySetInnerHTML={{ __html: `
(function() {
  var api = ${JSON.stringify(api)};
  var token = (document.cookie.match(/ws-token=([^;]+)/)||[])[1]||'';
  var logEl = document.getElementById('console-log');
  var authBar = document.getElementById('console-auth-bar');
  var authBadge = document.getElementById('console-auth-badge');
  var loginBtn = document.getElementById('btn-console-login');
  var codeInput = document.getElementById('console-code-input');
  var codeField = document.getElementById('auth-code');
  var submitCodeBtn = document.getElementById('btn-submit-code');
  var shellOutput = document.getElementById('shell-output');
  var shellInput = document.getElementById('shell-input');
  var loginSessionId = null;

  // Tab switching
  window.switchTab = function(tab) {
    document.getElementById('tab-logs').className = tab === 'logs' ? '' : 'hidden';
    document.getElementById('tab-shell').className = tab === 'shell' ? '' : 'hidden';
    document.querySelectorAll('.console-tab').forEach(function(el) {
      el.className = 'console-tab text-[11px] px-2 py-0.5 cursor-pointer ' +
        (el.dataset.tab === tab ? 'text-gray-300 border-b border-gray-300' : 'text-gray-500');
    });
    if (tab === 'shell') shellInput.focus();
  };

  function addLog(text) {
    logEl.textContent += text + '\\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  function addShell(text, cls) {
    var line = document.createElement('div');
    line.className = 'text-[11px] ' + (cls || 'text-gray-300');
    line.textContent = text;
    shellOutput.appendChild(line);
    shellOutput.scrollTop = shellOutput.scrollHeight;
  }

  // SSE log stream
  var evtSrc = new EventSource(api + '/logs/stream');
  evtSrc.onmessage = function(e) {
    try { addLog(JSON.parse(e.data)); } catch { addLog(e.data); }
  };

  // Check auth
  fetch(api + '/auth/status', { headers: { Authorization: 'Bearer ' + token } })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (!j.authenticated) {
        authBar.classList.remove('hidden');
        authBadge.classList.remove('hidden');
        document.getElementById('console-body').classList.remove('hidden');
        addLog('[!] Claude not authenticated — click "claude login" below');
      }
    });

  // Shell
  var history = [];
  var histIdx = -1;

  shellInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      var cmd = shellInput.value.trim();
      if (!cmd) return;
      history.unshift(cmd);
      histIdx = -1;
      shellInput.value = '';
      addShell('$ ' + cmd, 'text-green-500');
      fetch(api + '/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ command: cmd })
      })
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (j.stdout) addShell(j.stdout, 'text-gray-300');
        if (j.stderr) addShell(j.stderr, 'text-red-400');
        if (j.exitCode !== 0) addShell('[exit ' + j.exitCode + ']', 'text-yellow-500');
      })
      .catch(function(err) { addShell('Error: ' + err.message, 'text-red-400'); });
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (history.length > 0) { histIdx = Math.min(histIdx + 1, history.length - 1); shellInput.value = history[histIdx]; } }
    if (e.key === 'ArrowDown') { e.preventDefault(); histIdx = Math.max(histIdx - 1, -1); shellInput.value = histIdx >= 0 ? history[histIdx] : ''; }
  });

  // Login code submission
  // Set token directly
  submitCodeBtn.onclick = function() {
    var tkn = codeField.value.trim();
    if (!tkn) return;
    submitCodeBtn.disabled = true;
    submitCodeBtn.textContent = 'Verifying...';
    addLog('[login] Setting token...');
    fetch(api + '/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ token: tkn })
    })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (j.authenticated) {
        addLog('[login] Authenticated successfully!');
        authBar.classList.add('hidden');
        authBadge.classList.add('hidden');
      } else {
        addLog('[login] Failed: ' + (j.error || 'invalid token'));
        submitCodeBtn.disabled = false;
        submitCodeBtn.textContent = 'Set token';
        codeField.value = '';
        codeField.focus();
      }
    });
  };
  codeField.addEventListener('keydown', function(e) { if (e.key === 'Enter') submitCodeBtn.click(); });

  // Help get token — open Claude subscription page
  loginBtn.onclick = function() {
    addLog('[login] To get a token:');
    addLog('[login] 1. Subscribe to Claude Pro/Team at claude.ai');
    addLog('[login] 2. Run "claude setup-token" in your local terminal');
    addLog('[login] 3. Paste the sk-ant-oat01-* token in the field to the right');
    window.open('https://claude.ai/settings/billing', '_blank');
  };
})();
      `}} />
    </div>
  );
}

// ── Chat script (topic-only, follows ctrl-pln pattern) ──

function ChatScript({ wsName, topicName, token, namespace }: {
  wsName: string; topicName: string; token: string; namespace: string;
}): string {
  const script = `
(function() {
  var API = "/apis/v1/namespaces/" + ${JSON.stringify(namespace)};
  var TOKEN = ${JSON.stringify(token)};
  var WS_NAME = ${JSON.stringify(wsName)};
  var TOPIC_NAME = ${JSON.stringify(topicName)};

  var $ = function(s) { return document.querySelector(s); };
  var messagesEl = $("#messages");
  var form = $("#prompt-form");
  var input = $("#prompt-input");
  var sendBtn = form.querySelector("button[type=submit]");
  var runStateEl = $("#run-state");
  var runQueueEl = $("#run-queue");
  var btnInterrupt = $("#btn-interrupt");

  var currentAssistantEl = null;
  var currentAssistantText = "";
  var toolEls = {};

  function esc(s) {
    if (s == null) return '';
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }
  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function getInitials(name) {
    return name ? name.split(/\\s+/).map(function(w){return w[0]}).join("").toUpperCase().slice(0,2) : "?";
  }

  function nowTime() {
    var d = new Date();
    return ("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2);
  }

  function addMessage(role, text, senderName) {
    var wrapper = document.createElement("div");
    var time = nowTime();

    if (role === "user") {
      var initials = getInitials(senderName);
      wrapper.className = "max-w-3xl ml-auto flex items-start gap-2 justify-end";
      var col = document.createElement("div");
      var lbl = document.createElement("div");
      lbl.className = "text-xs text-right text-gray-400 mb-1";
      lbl.textContent = (senderName||"") + (senderName?" \\u00B7 ":"") + time;
      col.appendChild(lbl);
      var bubble = document.createElement("div");
      bubble.className = "rounded-lg px-4 py-2 bg-indigo-600 text-white whitespace-pre-wrap text-sm";
      bubble.textContent = text;
      col.appendChild(bubble);
      wrapper.appendChild(col);
      var av = document.createElement("span");
      av.className = "inline-flex w-8 h-8 items-center justify-center rounded-full bg-indigo-500 text-xs font-medium text-white shrink-0 mt-5";
      av.textContent = initials;
      wrapper.appendChild(av);
    } else if (role === "assistant") {
      wrapper.className = "max-w-3xl flex items-start gap-2";
      var ai = document.createElement("span");
      ai.className = "inline-flex w-8 h-8 items-center justify-center rounded-full bg-gray-700 text-xs font-medium text-white shrink-0 mt-1";
      ai.textContent = "AI";
      wrapper.appendChild(ai);
      var acol = document.createElement("div");
      acol.className = "flex-1";
      var tlbl = document.createElement("div");
      tlbl.className = "text-xs text-gray-400 mb-1";
      tlbl.textContent = time;
      acol.appendChild(tlbl);
      var bubble = document.createElement("div");
      bubble.className = "rounded-lg px-4 py-2 bg-white text-gray-900 shadow-sm border border-gray-100 text-sm prose prose-sm max-w-none md-preview";
      if (text && typeof marked !== "undefined") {
        bubble.innerHTML = marked.parse(text);
      } else {
        bubble.textContent = text || "";
      }
      acol.appendChild(bubble);
      wrapper.appendChild(acol);
      messagesEl.appendChild(wrapper);
      scrollBottom();
      return bubble;
    }

    messagesEl.appendChild(wrapper);
    scrollBottom();
    return null;
  }

  function addToolCall(id, title, kind) {
    var isBash = kind === "execute" || kind === "bash" || kind === "terminal";
    var icon = isBash ? "\\u26A1" : "\\uD83D\\uDD27";
    var label = isBash ? "bash" : (kind || "tool");
    var el = document.createElement("div");
    el.className = "text-xs text-gray-500 py-0.5 flex items-center gap-1 tool-activity";
    el.innerHTML = '<span class="animate-pulse inline-block w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"></span>' +
      '<span>' + icon + ' <strong>' + esc(label) + '</strong> ' + esc(title || '') + '</span>';
    messagesEl.appendChild(el);
    scrollBottom();
    toolEls[id || "last"] = el;
  }

  function updateToolCall(id, title, kind, status) {
    var el = toolEls[id || "last"];
    if (!el) { addToolCall(id, title, kind); el = toolEls[id || "last"]; }
    var dot = el.querySelector("span");
    if (status === "completed" || status === "failed") {
      if (dot) dot.className = "inline-block w-1.5 h-1.5 rounded-full shrink-0 " + (status === "failed" ? "bg-red-400" : "bg-green-400");
      el.classList.remove("text-gray-500");
      el.classList.add(status === "failed" ? "text-red-400" : "text-gray-400");
    }
    scrollBottom();
  }

  function clearTools() {
    var els = messagesEl.querySelectorAll(".tool-activity");
    for (var i = 0; i < els.length; i++) els[i].remove();
    toolEls = {};
  }

  function updateState(state) {
    if (!state) return;
    if (state.activeRun) {
      runStateEl.innerHTML = '<span class="text-indigo-600"><span class="spinner"></span> ' + esc(state.activeRun.submittedBy?.displayName || '') + '</span>';
      btnInterrupt.classList.remove("hidden");
    } else {
      runStateEl.innerHTML = '<span class="text-gray-400">Idle</span>';
      btnInterrupt.classList.add("hidden");
    }
    var queue = state.queue || [];
    runQueueEl.innerHTML = queue.length === 0
      ? '<span class="text-gray-400">Empty</span>'
      : queue.map(function(r, i) {
          return '<div class="p-1.5 mb-1 bg-yellow-50 border border-yellow-200 rounded text-xs">' +
            '<span class="text-gray-500">#' + (i+1) + '</span> ' + esc(r.submittedBy?.displayName || '?') +
            ': <span class="truncate">' + esc(r.text) + '</span></div>';
        }).join("");
  }

  // WebSocket
  var proto = location.protocol === "https:" ? "wss:" : "ws:";
  var wsURL = proto + "//" + location.host + API +
    "/workspaces/" + encodeURIComponent(WS_NAME) +
    "/topics/" + encodeURIComponent(TOPIC_NAME) + "/events";
  var ws = new WebSocket(wsURL);

  ws.onopen = function() { ws.send(JSON.stringify({ type: "authenticate", token: TOKEN })); };

  ws.onmessage = function(ev) {
    var msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "authenticated":
        runStateEl.textContent = "Connected";
        break;
      case "topic_state":
        updateState(msg);
        break;
      case "run_updated":
        var r = msg.run || msg;
        if (r.state === "running") {
          currentAssistantEl = null; currentAssistantText = "";
        }
        if (r.state === "completed" || r.state === "failed" || r.state === "cancelled") {
          clearTools();
          // Final server-side render with Shiki + Mermaid
          if (currentAssistantEl && currentAssistantText) {
            var finalEl = currentAssistantEl;
            var finalText = currentAssistantText;
            fetch("/api/render-md", { method: "POST", headers: {"Content-Type":"text/plain"}, body: finalText })
              .then(function(resp) { return resp.text(); })
              .then(function(html) { finalEl.innerHTML = html; });
          }
          currentAssistantEl = null; currentAssistantText = "";
          // Refresh file sidebar after run completes
          var filesEl = document.getElementById("acc-files");
          if (filesEl) {
            htmx.ajax("GET", API + "/workspaces/" + encodeURIComponent(WS_NAME) + "/resources/?path=", "#acc-files");
          }
        }
        if (msg.topicState) updateState(msg.topicState);
        break;
      case "message":
        if (msg.role === "user") {
          addMessage("user", msg.text || "", msg.submittedBy?.displayName || "user");
        } else if (msg.role === "assistant" && msg.text && !currentAssistantEl) {
          addMessage("assistant", msg.text);
        }
        break;
      case "text_chunk":
        clearTools();
        currentAssistantText += msg.text || "";
        if (!currentAssistantEl) {
          currentAssistantEl = addMessage("assistant", currentAssistantText);
        } else if (typeof marked !== "undefined") {
          currentAssistantEl.innerHTML = marked.parse(currentAssistantText);
        } else {
          currentAssistantEl.textContent = currentAssistantText;
        }
        scrollBottom();
        break;
      case "tool_call":
        addToolCall(msg.id, msg.title || msg.name, msg.kind);
        break;
      case "tool_update":
        updateToolCall(msg.id, msg.title || msg.name, msg.kind, msg.status);
        break;
      case "error":
        var errDiv = document.createElement("div");
        errDiv.className = "text-xs text-center text-red-500 py-1";
        errDiv.textContent = "Error: " + (msg.data || msg.message || JSON.stringify(msg));
        messagesEl.appendChild(errDiv);
        scrollBottom();
        break;
    }
  };

  ws.onclose = function() {
    runStateEl.innerHTML = '<span class="text-red-500">Disconnected</span>';
  };

  form.addEventListener("submit", function(e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "submit_run", text: text }));
    input.value = "";
  });

  btnInterrupt.addEventListener("click", function() {
    ws.send(JSON.stringify({ type: "interrupt" }));
  });

  // Logs
  var logsBtn = document.getElementById("btn-logs");
  if (logsBtn) {
    logsBtn.addEventListener("click", function() {
      var el = document.getElementById("ws-logs");
      fetch(API + "/workspaces/" + encodeURIComponent(WS_NAME) + "/logs?lines=50",
        { headers: { Authorization: "Bearer " + TOKEN } })
        .then(function(r) { return r.text(); })
        .then(function(t) { el.textContent = t; el.classList.remove("hidden"); el.scrollTop = el.scrollHeight; })
        .catch(function(e) { el.textContent = e.message; el.classList.remove("hidden"); });
    });
  }
})();
`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
