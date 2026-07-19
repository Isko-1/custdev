const API_URL = "https://factchecker-woad.vercel.app/api/check";
const controllers = new Map(); // requestId -> AbortController, для реальной отмены fetch

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_CONTENT") {
    const controller = new AbortController();
    controllers.set(message.requestId, controller);

    fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: message.inputType, content: message.content, url: message.url }),
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => {
        if (err.name === "AbortError") {
          sendResponse({ ok: false, cancelled: true });
        } else {
          sendResponse({ ok: false, error: err.message });
        }
      })
      .finally(() => controllers.delete(message.requestId));

    return true; // ответ асинхронный
  }

  if (message.type === "CANCEL_CONTENT") {
    controllers.get(message.requestId)?.abort();
    controllers.delete(message.requestId);
    return false;
  }

  return false;
});