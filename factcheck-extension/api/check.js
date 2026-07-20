import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

const MAX_INPUT_CHARS = 4000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemma-4-31b-it:free";

// ---------------------------------------------------------------------------
// Шаг 1: локальный список паттернов текстовых фейков и манипуляций в СМИ/соцсетях.
// ---------------------------------------------------------------------------
const LOCAL_PATTERNS = [
  {
    id: "clickbait-headline",
    label: "Кликбейтный заголовок / Шок-контент",
    keywords: ["шок!", "сенсация", "вы не поверите", "срочно смотреть всем", "читать до конца", "невероятный секрет"],
    note: "Использование искусственного завышения важности. Серьёзные новостные ресурсы избегают подобных эмоциональных манипуляций.",
  },
  {
    id: "anonymous-source",
    label: "Анонимный или выдуманный источник",
    keywords: ["из достоверных источников", "знакомый из министерства", "инсайдер сообщил", "источник в правительстве", "знакомый врач сказал"],
    note: "Отсутствие ссылки на конкретное ведомство, имя эксперта или официальный документ делает информацию непроверяемой.",
  },
  {
    id: "emotional-manipulation",
    label: "Искусственное нагнетание паники",
    keywords: ["срочный репост", "максимальный репост", "распространите среди знакомых", "перешлите в родительские чаты", "не молчите"],
    note: "Текст специально пытается вызвать панику, страх или гнев, чтобы заставить вас переслать его дальше до того, как вы успеете подумать.",
  },
  {
    id: "fake-expert",
    label: "Апелляция к абстрактному авторитету",
    keywords: ["ученые доказали", "японские исследователи", "американские специалисты пришли к выводу", "независимые эксперты"],
    note: "Использование размытых фраз вроде 'ученые доказали' без названия конкретного института или научной публикации — частый признак фейка.",
  },
  {
    id: "conspiracy-theory",
    label: "Теория заговора / Конспирология",
    keywords: ["нам не договаривают", "скрывают правду", "мировое правительство", "тайный план", "об этом молчат сми"],
    note: "Конспирологическая риторика, которая заменяет реальные факты и доказательства созданием ощущения всемирного обмана.",
  },
  {
    id: "fake-stats",
    label: "Голословная статистика",
    keywords: ["99% людей не знают", "большинство населения", "статистика показывает, что каждый второй", "в 10 раз увеличилось"],
    note: "Использование конкретных цифр или процентов без указания ссылки на официальное социологическое или статистическое исследование.",
  },
  {
    id: "pseudoscientific-jargon",
    label: "Псевдонаучная терминология",
    keywords: ["квантовое очищение", "биоэнергетическое поле", "структурированная вода", "шлаки и токсины", "активация ДНК"],
    note: "Использование сложных «научно выглядящих» терминов для придания веса вымышленным теориям, магическим практикам или сомнительным товарам.",
  },
  {
    id: "false-dilemma",
    label: "Ложная дилемма (Черно-белое мышление)",
    keywords: ["или мы, или они", "третьего не дано", "если вы не с нами, то вы против", "выбор очевиден"],
    note: "Искусственное сужение выбора до двух крайних вариантов, игнорируя любые промежуточные альтернативы или компромиссы.",
  },
  {
    id: "absolute-generalization",
    label: "Абсолютное обобщение (Сверхобобщение)",
    keywords: ["всегда так происходит", "все чиновники", "никогда такого не было", "абсолютно каждый знает"],
    note: "Перенос частного случая на абсолютно всех людей или ситуации, что стирает индивидуальные факты и контекст.",
  },
  {
    id: "magical-cure",
    label: "Обещание мгновенного чудо-результата",
    keywords: ["излечит за 1 день", "забудьте о боли навсегда", "копеечное средство", "минус 10 кг за неделю", "секретная методика"],
    note: "Агрессивный маркетинг сомнительных медицинских препаратов или методик, обещающий нереалистично быстрое решение сложных проблем.",
  },
  {
    id: "personal-attack",
    label: "Переход на личности (Ad Hominem)",
    keywords: ["да кто он такой", "посмотрите на его внешность", "всем известна его репутация", "человек с таким прошлым"],
    note: "Дискредитация самого автора или спикера вместо критики и разбора его реальных аргументов, фактов или позиции.",
  },
  {
    id: "out-of-context",
    label: "Вырывание из контекста (Сплетни)",
    keywords: ["случайно проговорился", "камера зафиксировала", "подслушанный разговор", "вырванные слова"],
    note: "Использование реальной фразы или кадра, но без объяснения предыстории и общего контекста, что полностью меняет смысл сказанного.",
  },
  {
    id: "post-hoc-ergo-propter-hoc",
    label: "Ложная причинно-следственная связь",
    keywords: ["сразу после этого началось", "совпадение? не думаю", "вследствие этого произошло", "прямая связь между"],
    note: "Логическая ошибка, при которой событие, произошедшее хронологически позже другого, объявляется его прямым следствием.",
  },
  {
    id: "financial-scam-hook",
    label: "Кликбейт легкого заработка (Скам)",
    keywords: ["заработок без вложений", "пассивный доход от 5000р в день", "схема обыгрыша", "узнай секрет богатства"],
    note: "Манипуляция финансовой уязвимостью. Обещания гарантированной легкой прибыли, характерные для финансовых пирамид и мошенников.",
  },
  {
    id: "past-glorification",
    label: "Спекуляция на ностальгии",
    keywords: ["в СССР такого не было", "раньше было лучше", "какую страну потеряли", "золотой век", "предки знали секрет"],
    note: "Идеализация прошлого с целью вызвать у читателя недовольство текущим положением дел, игнорируя исторические недостатки сравниваемой эпохи.",
  }
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
// Шаг 3: LLM-классификация с глубоким анализом скрытых фейков.
// ---------------------------------------------------------------------------
function buildSystemPrompt() {
  return `Ты — продвинутый ИИ-эксперт по медиаграмотности и фактчекингу для пользователей из Казахстана.
Твоя задача — глубоко проанализировать текст на достоверность. Текст может быть написан абсолютно серьезным, нейтральным и сухим языком, но при этом являться абсолютным фейком, вымыслом или искажением реальности.

Используй свои внутренние знания о мире для проверки информации. Анализируй текст по двум направлениям:
1. Фактологическая ложь: Противоречит ли текст общеизвестным историческим, научным или актуальным мировым и локальным фактам (например, "Луна упала", "отменили законы физики" и т.д.).
2. Скрытые манипуляции: Если текст сообщает о громком событии, сенсации, открытии или реформе, но не предоставляет проверяемых ссылок на документы, имена реальных ведомств, экспертов или институтов (проблема "чистых фейков").

Формулировка вердикта (riskLevel):
- "high" — Текст содержит явный вымысел, абсурдные утверждения или грубо противоречит реальным фактам (даже если написан строго и без эмоций). Метка: "Вероятнее всего фейк".
- "medium" — Текст сообщает о важных/резонансных событиях, но не дает никаких проверяемых данных, ссылок и имен, либо тема слишком свежая. Метка: "Подозрительная или непроверяемая информация".
- "low" — Фактических проблем и логического вымысла не обнаружено. Метка: "Фактических проблем не найдено".

Ответь СТРОГО в формате JSON, без markdown разметки и без текста вокруг JSON:
{
  "riskLevel": "low" | "medium" | "high",
  "riskLabel": "короткая метка",
  "signals": ["конкретная причина сомнения, почему это может быть фейком"],
  "advice": "рекомендация для пользователя"
}

Если во входном тексте НЕТ конкретных утверждений (слишком короткий, приветствие, набор букв):
{
  "riskLevel": "low",
  "riskLabel": "Недостаточно текста для анализа",
  "signals": [],
  "advice": "Вставьте текст с конкретными утверждениями."
}`;
}

async function classifyWithLLM(text) {
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
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: text },
      ],
      temperature: 0.1, // Снижаем температуру для более точных и строгих ответов ИИ
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
// Шаг 4: гибридная сборка финального ответа.
// ---------------------------------------------------------------------------
function attachFakePatterns(llmResult, localMatches) {
  const localSignals = localMatches.map((m) => `[Локальный маркер] ${m.label}: ${m.note}`);
  
  // Логика перестраховки: если локальный скрипт нашел ключевые слова манипуляций,
  // мы автоматически повышаем общий уровень угрозы, даже если ИИ посчитал текст спокойным.
  let finalRiskLevel = llmResult.riskLevel;
  let finalRiskLabel = llmResult.riskLabel;
  let finalAdvice = llmResult.advice;

  if (localMatches.length > 0) {
    // Если ИИ поставил low, но стоп-слова сработали -> поднимаем до medium
    if (finalRiskLevel === "low") {
      finalRiskLevel = "medium";
      finalRiskLabel = "Обнаружены маркеры манипуляций";
    }
    if (!finalAdvice.includes("независимый источник")) {
      finalAdvice += " В тексте содержатся явные клише или призывы к панике, перепроверьте информацию.";
    }
  }

  return {
    riskLevel: finalRiskLevel,
    riskLabel: finalRiskLabel,
    signals: [...localSignals, ...llmResult.signals],
    advice: finalAdvice
  };
}

// ---------------------------------------------------------------------------
// Опциональное логирование в Supabase.
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

    // Запускаем оба анализа параллельно
    const localMatches = findLocalMatches(text);
    const llmResult = await classifyWithLLM(text);
    
    // Объединяем результаты с интеллектуальной проверкой рисков
    const result = attachFakePatterns(llmResult, localMatches);

    await logCheck(text, result);

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}