import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

const MAX_INPUT_CHARS = 4000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openrouter/free";

// ---------------------------------------------------------------------------
// Шаг 1: локальный список известных в Казахстане паттернов манипуляции.
// Это НЕ вызов ИИ — обычное сопоставление по ключевым словам, детерминированное
// и бесплатное. Найденные совпадения передаются в LLM как контекст (шаг 2),
// и добавляются жюри-видимой строкой "локальный паттерн" в signals.
// ---------------------------------------------------------------------------
const LOCAL_PATTERNS = [
  {
    id: "urgent-transfer",
    label: "Срочный перевод денег",
    keywords: ["переведи срочно", "закинь на карту", "нужны деньги прямо сейчас", "не могу говорить, переведи"],
    note: "Классическая схема «взлом аккаунта родственника/друга» — просьба срочно перевести деньги без звонка.",
  },
  {
    id: "fake-official-notice",
    label: "Поддельное уведомление от госоргана",
    keywords: ["штраф оплатите в течение", "ваш счёт заблокирован", "égov", "eGov", "уведомление минюст", "уведомление налоговой"],
    note: "Имитация официального уведомления с требованием срочной оплаты/перехода по ссылке.",
  },
  {
    id: "fake-bank-alert",
    label: "Поддельное банковское уведомление",
    keywords: ["ваша карта заблокирована", "подтвердите операцию по ссылке", "код из смс никому не сообщайте, кроме", "служба безопасности банка"],
    note: "Имитация сообщения от банка с целью выманить SMS-код или данные карты.",
  },
  {
    id: "investment-pyramid",
    label: "Инвестиционная пирамида",
    keywords: ["доходность 100% в месяц", "гарантированный доход", "без риска", "вложи и удвой", "закрытый инвестклуб"],
    note: "Обещание нереалистичной доходности без лицензии — признак финансовой пирамиды.",
  },
  {
    id: "job-scam",
    label: "Мошенническая вакансия",
    keywords: ["работа без опыта, зарплата от", "просто пересылай посылки", "дропер", "лёгкий заработок за перевод"],
    note: "Схема «дропперства» — вербовка через объявления о лёгком заработке, оборачивается уголовной ответственностью.",
  },
  {
    id: "chain-forward",
    label: "Цепочное сообщение «перешли всем»",
    keywords: ["перешли этот текст 10 друзьям", "не игнорируй, перешли всем", "родители, срочно прочитайте и перешлите"],
    note: "Формат вирусной цепочки в WhatsApp/Telegram — сама структура «перешли всем» не делает утверждение фактом.",
  },
  {
    id: "secret-info",
    label: "«Скрытая информация»",
    keywords: ["СМИ скрывают", "власти скрывают", "об этом не расскажут по телевизору", "запрещённая правда"],
    note: "Риторика «нам всё скрывают» часто заменяет отсутствие проверяемого источника ощущением эксклюзивности.",
  },
  {
    id: "fake-lottery",
    label: "Фальшивая лотерея/наследство",
    keywords: ["вы выиграли", "получите приз, перейдите по ссылке", "наследство от неизвестного родственника"],
    note: "Классическая схема выманивания личных данных или предоплаты за «приз».",
  },
  {
    id: "deepfake-video-claim",
    label: "Возможное видео-манипуляция",
    keywords: ["на видео он признался", "видео с камеры очевидца", "утечка видео"],
    note: "Заявления об «слитом видео» без указания первоисточника — частый вектор дипфейк-дезинформации.",
  },
  {
    id: "health-panic",
    label: "Паника вокруг здоровья",
    keywords: ["врачи скрывают лекарство", "вакцина вызывает", "не ходите в больницу, а сделайте"],
    note: "Медицинская дезинформация, использующая страх вместо ссылок на исследования.",
  },
  {
    id: "outrage-bait",
    label: "Провокация на этнической/региональной почве",
    keywords: ["наших притесняют", "их специально натравливают", "молчать нельзя, распространи"],
    note: "Контент, рассчитанный на эмоциональную мобилизацию по национальному/региональному признаку — частый инструмент дезинформационных кампаний.",
  },
  {
    id: "exam-leak",
    label: "«Слитые» ответы на экзамен",
    keywords: ["слив ЕНТ", "ответы на экзамен за деньги", "100% проходной вариант"],
    note: "Мошенничество, эксплуатирующее тревогу школьников/абитуриентов перед ЕНТ.",
  },
];

function findLocalMatches(text) {
  const lower = text.toLowerCase();
  return LOCAL_PATTERNS.filter((p) =>
    p.keywords.some((kw) => lower.includes(kw.toLowerCase()))
  );
}

// ---------------------------------------------------------------------------
// Шаг 2: извлечение текста, если на входе ссылка.
// ---------------------------------------------------------------------------
async function extractTextFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`страница вернула статус ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const paragraphs = $("p")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  return paragraphs.join("\n").slice(0, MAX_INPUT_CHARS);
}

// ---------------------------------------------------------------------------
// Шаг 3: LLM-классификация с учётом локальных совпадений (если есть).
// ---------------------------------------------------------------------------
function buildSystemPrompt(localMatches) {
  const localContext = localMatches.length
    ? `\n\nВ тексте автоматически найдены совпадения с известными в Казахстане паттернами мошенничества/манипуляции: ${localMatches
        .map((m) => `«${m.label}» (${m.note})`)
        .join("; ")}. Обязательно учти это в signals, если релевантно, но не ограничивайся только этим — ищи и другие признаки.`
    : "";

  return `Ты помогаешь читателю из Казахстана распознать признаки манипулятивного контента в тексте (пост, статья, сообщение). Ты НЕ выносишь вердикт "правда/ложь" — ты только называешь конкретные признаки манипуляции, если они есть, на русском или казахском языке в зависимости от языка исходного текста.

Ищи конкретно:
- эмоциональное давление (паника, срочность, "пока не поздно")
- отсутствие проверяемого источника или ссылки на первоисточник
- абсолютные заявления без нюансов ("всегда", "никогда", "все")
- непроверяемая статистика или "секретные данные"
- призыв к немедленному действию (перевести деньги, передать доступ, переслать всем)${localContext}

Ответь СТРОГО в формате JSON, без markdown и пояснений вне JSON:
{
  "riskLevel": "low" | "medium" | "high",
  "riskLabel": "короткая метка на языке текста, например 'Явные признаки манипуляции'",
  "signals": ["конкретный признак 1", "конкретный признак 2"],
  "advice": "одна короткая практическая рекомендация читателю"
}`;
}

async function classifyWithLLM(text, localMatches) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY не задан в переменных окружения Vercel");

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt(localMatches) },
        { role: "user", content: text },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter вернул статус ${response.status}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? "";
  return parseModelOutput(raw);
}

function parseModelOutput(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("модель вернула ответ не в формате JSON");

  const parsed = JSON.parse(jsonMatch[0]);

  const allowedLevels = ["low", "medium", "high"];
  if (!allowedLevels.includes(parsed.riskLevel)) parsed.riskLevel = "medium";
  if (!Array.isArray(parsed.signals)) parsed.signals = [];
  if (typeof parsed.riskLabel !== "string") parsed.riskLabel = "Анализ";
  if (typeof parsed.advice !== "string") parsed.advice = "";

  return parsed;
}

// ---------------------------------------------------------------------------
// Шаг 4: сборка финального ответа — локальные совпадения помечаются отдельно,
// чтобы на защите было видно, что не всё решение генерирует LLM.
// ---------------------------------------------------------------------------
function mergeLocalIntoResult(llmResult, localMatches) {
  if (localMatches.length === 0) return llmResult;

  const localSignals = localMatches.map(
    (m) => `[локальный паттерн] ${m.label}`
  );

  return {
    ...llmResult,
    signals: [...localSignals, ...llmResult.signals],
  };
}

// ---------------------------------------------------------------------------
// Опциональное логирование в Supabase — не блокирует ответ при сбое.
// ---------------------------------------------------------------------------
async function logCheck(content, result) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return;

  try {
    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    await supabase.from("checks").insert([
      { content: content.slice(0, 500), result: JSON.stringify(result) },
    ]);
  } catch (err) {
    console.error("Supabase log failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Vercel serverless entrypoint.
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({
      status: "working",
      message: "Бэкенд активен. Для проверки пришлите POST { type, content }.",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Метод не поддерживается" });
  }

  try {
    const { type, content } = req.body || {};

    if (!content || !["text", "url"].includes(type)) {
      return res.status(400).json({
        error: "нужно поле type ('text' или 'url') и content",
      });
    }

    const text =
      type === "url"
        ? await extractTextFromUrl(content)
        : content.slice(0, MAX_INPUT_CHARS);

    if (!text.trim()) {
      return res.status(422).json({ error: "не удалось извлечь текст для анализа" });
    }

    const localMatches = findLocalMatches(text);
    const llmResult = await classifyWithLLM(text, localMatches);
    const result = mergeLocalIntoResult(llmResult, localMatches);

    await logCheck(text, result);

    // Важно: тело ответа — сам результат, БЕЗ обёртки {ok, data} —
    // именно такую форму ожидает content.js на стороне расширения.
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
