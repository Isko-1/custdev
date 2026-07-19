const URL_PATTERN = /^https?:\/\/\S+$/i;
const MAX_PAGE_TEXT_LENGTH = 12000; // защита от гигантских страниц в теле запроса

let activeRequestId = null; // токен текущего запроса — решает и гонку, и отмену
let requestCounter = 0;

function detectInputType(value) {
  return URL_PATTERN.test(value.trim()) ? "url" : "text";
}

function extractPageText() {
  // innerText уже не включает <script>/<style> и скрытые (display:none) элементы —
  // этого достаточно, без самодельного readability-парсера
  const text = document.body.innerText || document.body.textContent || "";
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_TEXT_LENGTH);
}

function createWidget() {
  const button = document.createElement("button");
  button.id = "manip-check-button";
  button.textContent = "🔍";
  button.title = "Проверить текст или ссылку на признаки фейка";

  const panel = document.createElement("div");
  panel.id = "manip-check-panel";
  panel.className = "manip-hidden";
  panel.innerHTML = `
    <div class="manip-panel-header">
      <span>Разбор информации фейк/не фейк</span>
      <button id="manip-close-btn" title="Закрыть">×</button>
    </div>
    <button id="manip-check-page-btn">Проверить эту страницу</button>
    <textarea id="manip-input" placeholder="...или вставьте текст/ссылку, чтобы проверить на фейк"></textarea>
    <button id="manip-submit-btn">Проверить</button>
    <button id="manip-cancel-btn" class="manip-hidden">Отменить проверку</button>
    <div id="manip-result"></div>
  `;

  document.body.appendChild(button);
  document.body.appendChild(panel);

  button.addEventListener("click", () => panel.classList.toggle("manip-hidden"));
  panel.querySelector("#manip-close-btn").addEventListener("click", () => {
    panel.classList.add("manip-hidden");
  });
  panel.querySelector("#manip-submit-btn").addEventListener("click", handleSubmit);
  panel.querySelector("#manip-cancel-btn").addEventListener("click", cancelActiveRequest);
  panel.querySelector("#manip-check-page-btn").addEventListener("click", () => {
    checkContent("page", extractPageText(), window.location.href);
  });
}

function setAnalyzing(isAnalyzing) {
  const mainButton = document.getElementById("manip-check-button");
  const submitBtn = document.getElementById("manip-submit-btn");
  const pageBtn = document.getElementById("manip-check-page-btn");
  const cancelBtn = document.getElementById("manip-cancel-btn");

  mainButton?.classList.toggle("manip-analyzing", isAnalyzing);
  submitBtn?.classList.toggle("manip-analyzing", isAnalyzing);
  pageBtn?.classList.toggle("manip-analyzing", isAnalyzing);
  if (submitBtn) submitBtn.disabled = isAnalyzing;
  if (pageBtn) pageBtn.disabled = isAnalyzing;
  cancelBtn?.classList.toggle("manip-hidden", !isAnalyzing);
}

function renderLoading() {
  const result = document.getElementById("manip-result");
  if (result) {
    result.innerHTML = `
      <div class="manip-loading">
        <span class="manip-spinner"></span>
        <span>Анализируем<span class="manip-dot">.</span><span class="manip-dot">.</span><span class="manip-dot">.</span></span>
      </div>
    `;
  }
}

function renderError(message) {
  const result = document.getElementById("manip-result");
  if (result) {
    result.innerHTML = `<div class="manip-error">Не удалось проверить: ${escapeHtml(message)}</div>`;
  }
}

function renderCancelled() {
  const result = document.getElementById("manip-result");
  if (result) {
    result.innerHTML = `<div class="manip-error">Проверка отменена</div>`;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function renderSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return "";

  const items = sources
    .slice(0, 5) // не даём списку разрастись
    .map((s) => {
      const url = typeof s === "string" ? s : s.url;
      const title = typeof s === "string" ? s : (s.title || s.url);
      if (!url) return "";
      return `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></li>`;
    })
    .join("");

  if (!items) return "";

  return `
    <div class="manip-sources">
      <div class="manip-sources-title">Источники</div>
      <ul class="manip-sources-list">${items}</ul>
    </div>
  `;
}

function renderResult(data) {
  const result = document.getElementById("manip-result");
  if (!result || !data) return;

  const signalsHtml = (data.signals || [])
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join("");

  result.innerHTML = `
    <div class="manip-level manip-level-${escapeHtml(data.riskLevel || 'medium')}">${escapeHtml(data.riskLabel || 'Анализ')}</div>
    <ul class="manip-signals">${signalsHtml || "<li>Явных признаков не найдено</li>"}</ul>
    ${renderSources(data.sources)}
    ${data.riskLevel !== "low" ? `<p class="manip-recheck">⟳ Проверено ИИ — сверьте с независимым источником</p>` : ""}
    <p class="manip-advice">${escapeHtml(data.advice || '')}</p>
  `;
}

function checkContent(inputType, content, url) {
  const requestId = ++requestCounter;
  activeRequestId = requestId;

  setAnalyzing(true);
  renderLoading();

  chrome.runtime.sendMessage(
    { type: "CHECK_CONTENT", requestId, inputType, content, url },
    (response) => {
      // Если пришёл ответ на устаревший (отменённый/перекрытый новым) запрос — игнорируем
      if (requestId !== activeRequestId) return;

      activeRequestId = null;
      setAnalyzing(false);

      if (response?.cancelled) {
        renderCancelled();
        return;
      }
      if (!response || response.ok === false) {
        renderError(response?.error || "нет ответа от расширения");
        return;
      }
      renderResult(response.data);
    }
  );
}

function cancelActiveRequest() {
  if (activeRequestId === null) return;
  chrome.runtime.sendMessage({ type: "CANCEL_CONTENT", requestId: activeRequestId });
  activeRequestId = null; // делает будущий поздний ответ устаревшим — он будет проигнорирован
  setAnalyzing(false);
  renderCancelled();
}

function handleSubmit() {
  const input = document.getElementById("manip-input").value.trim();
  if (!input) return;
  checkContent(detectInputType(input), input);
}

// Запуск создания виджета
createWidget();