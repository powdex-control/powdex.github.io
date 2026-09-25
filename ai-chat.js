/* =====================================================================
   POWDEX AI — assistente de chat livre.
   Este arquivo SÓ adiciona o widget de IA ao POWDEX CONTROL.
   Não mexe em nada do Firebase, cabines, senhas ou demais telas.

   Como funciona:
   - O botão flutuante abre um painel de chat.
   - As mensagens do usuário são enviadas para o endpoint definido em
     config/config.js (window.POWDEX_AI_CONFIG.API_ENDPOINT).
   - Esse endpoint é o SEU backend (pasta /backend), que é quem
     realmente conversa com a OpenAI usando a API key protegida.
   - O histórico da conversa fica só na memória da página (variável
     JS); ao recarregar a página, o histórico é reiniciado.
   ===================================================================== */
(function(){
  "use strict";

  const CFG = window.POWDEX_AI_CONFIG || {};
  const API_ENDPOINT = CFG.API_ENDPOINT || "";
  const MAX_HISTORY_MESSAGES = 16; // limite de mensagens enviadas por chamada (economiza contexto/custo)

  const SYSTEM_PROMPT_INFO =
    "Você é o assistente inteligente do POWDEX CONTROL, um sistema desenvolvido para " +
    "auxiliar no acompanhamento e gerenciamento de processos relacionados à reutilização " +
    "e controle de pó de pintura eletrostática. Ajude os usuários a entender dados, " +
    "processos, funcionamento do sistema, desperdício, reaproveitamento, eficiência, " +
    "organização e possíveis melhorias. Responda de forma clara, objetiva e útil. " +
    "Quando não tiver informações suficientes, deixe isso claro e não invente dados.";
  // Observação: este texto também existe (e é o que realmente conta) em backend/api/chat.js,
  // que é onde a chamada à OpenAI acontece de fato. Ele está repetido aqui apenas como
  // referência/documentação do comportamento esperado do assistente.

  let history = []; // {role:"user"|"assistant", content:string}
  let sending = false;

  function el(tag, attrs, ...children){
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs){
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    children.forEach(c => { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }

  /* ---------- Markdown simples e seguro ---------- */
  function escapeHtml(str){
    return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }
  function renderMarkdown(raw){
    const src = escapeHtml(raw);
    const lines = src.split(/\r?\n/);
    let html = "";
    let inList = null; // "ul" | "ol"
    let inCode = false;
    let codeBuf = [];

    function closeList(){ if (inList){ html += `</${inList}>`; inList = null; } }
    function inlineFmt(t){
      t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
      return t;
    }

    for (let i = 0; i < lines.length; i++){
      const line = lines[i];

      if (/^```/.test(line)){
        if (!inCode){ inCode = true; codeBuf = []; }
        else { html += `<pre><code>${codeBuf.join("\n")}</code></pre>`; inCode = false; }
        continue;
      }
      if (inCode){ codeBuf.push(line); continue; }

      if (/^\s*$/.test(line)){ closeList(); continue; }

      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h){ closeList(); const lvl = h[1].length; html += `<h${lvl}>${inlineFmt(h[2])}</h${lvl}>`; continue; }

      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol){ if (inList !== "ol"){ closeList(); html += "<ol>"; inList = "ol"; } html += `<li>${inlineFmt(ol[1])}</li>`; continue; }

      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ul){ if (inList !== "ul"){ closeList(); html += "<ul>"; inList = "ul"; } html += `<li>${inlineFmt(ul[1])}</li>`; continue; }

      closeList();
      html += `<p>${inlineFmt(line)}</p>`;
    }
    closeList();
    if (inCode) html += `<pre><code>${codeBuf.join("\n")}</code></pre>`;
    return html;
  }

  /* ---------- UI ---------- */
  const fab = el("button", { class: "pw-ai-fab", type: "button", "aria-label": "Abrir assistente POWDEX AI", title: "Assistente POWDEX AI" },
    el("span", { class: "pw-ai-ping" }),
    el("span", { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a7 7 0 0 0-7 7c0 2.4 1.2 4.5 3 5.8V19l2.6-1.4c.5.1 1 .1 1.4.1a7 7 0 0 0 0-14Z"/><circle cx="9.5" cy="10.2" r=".9" fill="currentColor" stroke="none"/><circle cx="14.5" cy="10.2" r=".9" fill="currentColor" stroke="none"/></svg>` })
  );

  const closeBtn = el("button", { class: "pw-ai-close", type: "button", "aria-label": "Fechar" },
    el("span", { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>` })
  );

  const statusDot = el("span", { class: "pw-ai-dot" });
  const statusEl = el("div", { class: "pw-ai-status" }, statusDot, el("span", {}, "Assistente online"));

  const head = el("div", { class: "pw-ai-head" },
    el("div", { class: "pw-ai-head-info" },
      el("div", { class: "pw-ai-avatar" }, el("span", { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a7 7 0 0 0-7 7c0 2.4 1.2 4.5 3 5.8V19l2.6-1.4c.5.1 1 .1 1.4.1a7 7 0 0 0 0-14Z"/></svg>` })),
      el("div", { class: "pw-ai-title" }, el("b", {}, "POWDEX AI"), statusEl)
    ),
    closeBtn
  );

  const messagesEl = el("div", { class: "pw-ai-messages" });

  const textarea = el("textarea", { rows: "1", placeholder: "Digite sua mensagem..." });
  const sendBtn = el("button", { class: "pw-ai-send", type: "button", "aria-label": "Enviar" },
    el("span", { html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-2.5-6.5L4 12Z"/></svg>` })
  );
  const inputBar = el("div", { class: "pw-ai-inputbar" }, textarea, sendBtn);

  const panel = el("div", { class: "pw-ai-panel", role: "dialog", "aria-label": "Assistente POWDEX AI" }, head, messagesEl, inputBar);

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  function addMessage(role, content, opts){
    opts = opts || {};
    const bubble = el("div", { class: "pw-ai-msg " + (role === "user" ? "pw-ai-user" : (opts.error ? "pw-ai-error" : "pw-ai-bot")) });
    bubble.innerHTML = role === "assistant" ? renderMarkdown(content) : `<p>${escapeHtml(content)}</p>`;
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function addTyping(){
    const t = el("div", { class: "pw-ai-typing" }, el("span"), el("span"), el("span"));
    t.id = "pw-ai-typing-indicator";
    messagesEl.appendChild(t);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return t;
  }
  function removeTyping(){
    const t = document.getElementById("pw-ai-typing-indicator");
    if (t) t.remove();
  }

  function setStatus(ok){
    statusEl.classList.toggle("pw-ai-status-err", !ok);
    statusEl.lastChild.textContent = ok ? "Assistente online" : "Sem conexão com a IA";
  }

  let opened = false;
  function openPanel(){
    opened = true;
    panel.classList.add("pw-ai-open");
    if (!messagesEl.childElementCount){
      addMessage("assistant", "Olá! Sou o assistente do POWDEX CONTROL. Como posso ajudar?");
    }
    textarea.focus();
  }
  function closePanel(){
    opened = false;
    panel.classList.remove("pw-ai-open");
  }

  fab.addEventListener("click", () => opened ? closePanel() : openPanel());
  closeBtn.addEventListener("click", closePanel);

  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 90) + "px";
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener("click", sendMessage);

  async function sendMessage(){
    const text = textarea.value.trim();
    if (!text || sending) return;

    if (!API_ENDPOINT){
      addMessage("user", text);
      addMessage("assistant", "O endereço do assistente ainda não foi configurado. Abra config/config.js e defina API_ENDPOINT com a URL do seu backend.", { error: true });
      textarea.value = "";
      return;
    }

    sending = true;
    sendBtn.disabled = true;
    textarea.value = "";
    textarea.style.height = "auto";

    addMessage("user", text);
    history.push({ role: "user", content: text });
    if (history.length > MAX_HISTORY_MESSAGES) history = history.slice(-MAX_HISTORY_MESSAGES);

    const typing = addTyping();

    try {
      const res = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history })
      });

      if (!res.ok) throw new Error("Falha na resposta do servidor (" + res.status + ")");
      const data = await res.json();
      const reply = (data && data.reply) ? data.reply : "";

      removeTyping();
      setStatus(true);

      if (!reply){
        addMessage("assistant", "Não recebi uma resposta válida da IA agora. Tente novamente em instantes.", { error: true });
      } else {
        addMessage("assistant", reply);
        history.push({ role: "assistant", content: reply });
        if (history.length > MAX_HISTORY_MESSAGES) history = history.slice(-MAX_HISTORY_MESSAGES);
      }
    } catch (err){
      console.error("POWDEX AI:", err);
      removeTyping();
      setStatus(false);
      addMessage("assistant", "Não foi possível conectar à IA no momento. Verifique sua conexão ou a configuração da API.", { error: true });
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  }
})();
