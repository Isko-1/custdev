const URL_PATTERN = /^https?:\/\/\S+$/i;

function detectInputType(value) {
  return URL_PATTERN.test(value.trim()) ? "url" : "text";
}

function createWidget() {
  const button = document.createElement("button");
  button.id = "manip-check-button";
  button.textContent = "🔍";
  button.title = "Проверить текст или ссылку на признаки манипуляции";

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
    <div id="manip-result"></div>
  `;

  document.body.appendChild(button);
  document.body.appendChild(panel);

  button.addEventListener("click", () => panel.classList.toggle("manip-hidden"));
  panel.querySelector("#manip-close-btn").addEventListener("click", () => {
    panel.classList.add("manip-hidden");
  });
  panel.querySelector("#manip-submit-btn").addEventListener("click", handleSubmit);
  panel.querySelector("#manip-check-page-btn").addEventListener("click", () => {
    checkContent("url", window.location.href);
  });
}

function renderLoading() {
  const result = document.getElementById("manip-result");
  if (result) {
    result.innerHTML = `<div class="manip-loading">Анализируем...</div>`;
  }
}

function renderError(message) {
  const result = document.getElementById("manip-result");
  if (result) {
    result.innerHTML = `<div class="manip-error">Не удалось проверить: ${message}</div>`;
  }
}

function renderResult(data) {
  const result = document.getElementById("manip-result");
  if (!result || !data) return;

  const signalsHtml = (data.signals || [])
    .map((s) => `<li>${s}</li>`)
    .join("");

  result.innerHTML = `
    <div class="manip-level manip-level-${data.riskLevel || 'medium'}">${data.riskLabel || 'Анализ'}</div>
    <ul class="manip-signals">${signalsHtml || "<li>Явных признаков не найдено</li>"}</ul>
    ${data.riskLevel !== "low" ? `<p class="manip-recheck">⟳ Проверено ИИ — сверьте с независимым источником</p>` : ""}
    <p class="manip-advice">${data.advice || ''}</p>
  `;
}

function checkContent(inputType, content) {  
  renderLoading(); // Теперь вызывается безопасно на отдельной строке
  
  chrome.runtime.sendMessage(
    { type: "CHECK_CONTENT", inputType, content },
    (response) => {
      if (!response || response.ok === false) {
        renderError(response && response.error ? response.error : "нет ответа от расширения");
        return;
      }
      renderResult(response.data);
    }
  );
}

function handleSubmit() {
  const input = document.getElementById("manip-input").value.trim();
  if (!input) return;
  checkContent(detectInputType(input), input);
}

// Запуск создания виджета
createWidget();