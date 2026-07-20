import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

const MAX_INPUT_CHARS = 4000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Список моделей: OpenRouter автоматически переключится, если одна из них выдаст 429
const FALLBACK_MODELS = [
  "google/gemma-4-31b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free"
];

// ---------------------------------------------------------------------------
// Шаг 1: Локальный список паттернов текстовых фейков
// ---------------------------------------------------------------------------
const LOCAL_PATTERNS = [
  {
    id: "clickbait-headline",
    label: "Кликбейтный заголовок / Шок-контент",
    keywords: ["шок!", "сенсация", "вы не поверите", "срочно смотреть всем", "читать до конца", "невероятный секрет"],
    note: "Использование искусственного завышения важности.",
  },
  {
    id: "anonymous-source",
    label: "Анонимный или выдуманный источник",
    keywords: ["из достоверных источников", "знакомый из министерства", "инсайдер сообщил", "источник в правительстве", "знакомый врач сказал"],
    note: "Отсутствие ссылки на конкретное ведомство или имя эксперта.",
  },
  {
    id: "emotional-manipulation",
    label: "Искусственное нагнетание паники",
    keywords: ["срочный репост", "максимальный репост", "распространите среди знакомых", "перешлите в родительские чаты", "не молчите"],
    note: "Текст специально пытается вызвать панику или страх.",
  }
];

function findLocalMatches(text) {
  const lower = text.toLowerCase();
  return LOCAL_PATTERNS.filter((p) =>
    p.keywords.some((kw) => lower.includes(kw.toLowerCase()))
  );
}

// ---------------------------------------------------------------------------
// Шаг 2: Извлечение текста по URL (если передана ссылка)
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
// Шаг 3: Динамический поиск в реальном интернете (Serper API)
// ---------------------------------------------------------------------------
async function searchInternet(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.warn("SERPER_API_KEY не задан. Поиск в интернете пропущен.");
    return "Поиск не удался: отсутствует API ключ.";
  }

  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        gl: "kz", // Фокусируемся на результатах для Казахстана
        hl: "ru",
        num: 4     // Берём топ-4 результата
      }),
    });

    if (!response.ok) return "Не удалось получить результаты поиска.";

    const data = await response.json();
    const results = data.organic || [];
    if (results.length === 0) return "По запросу ничего не найдено в авторитетных источниках.";

    return results
      .map((res, index) => `[Источник ${index + 1}]: ${res.title}\nОписание: ${res.snippet}\nСсылка: ${res.link}`)
      .join("\n\n");
  } catch (err) {
    return `Ошибка поиска: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Шаг 4: Усиленный промпт ИИ и обращение к OpenRouter (с массивом моделей)
// ---------------------------------------------------------------------------
function buildSystemPrompt(searchContext) {
  return `Ты — строгий эксперт по фактчекингу и медиаграмотности.
Твоя задача — изучить текст пользователя и сравнить его с актуальными данными из интернета, которые тебе предоставлены.

ВОТ ДАННЫЕ ИЗ РЕАЛЬНОГО ИНТЕРНЕТА ПО ЭТОЙ ТЕМЕ:
===
${searchContext}
===

Анализируй текст по критериям:
1. Выдумка / Сатира / Юмор: Описывает ли текст заведомо абсурдную или вымышленную шуточную историю (в стиле The Onion, Панорама). Ставь riskLevel: "medium", riskLabel: "Юмористический вымысел / Сатира".
2. Прямой фейк / Дезинформация: Если данные из интернета прямо ОПРОВЕРГАЮТ текст пользователя, или это известная ложь. Ставь riskLevel: "high", riskLabel: "Вероятнее всего фейк".
3. Непроверяемая информация: Если текст сообщает важную новость, но в предоставленных данных из интернета нет никаких официальных подтверждений. Ставь riskLevel: "medium", riskLabel: "Непроверяемая информация".
4. Достоверно: Новость полностью подтверждается авторитетными источниками из интернета. Ставь riskLevel: "low", riskLabel: "Фактических проблем не найдено".

Формат ответа СТРОГО JSON без markdown-разметки:
{
  "riskLevel": "low" | "medium" | "high",
  "riskLabel": "короткая метка",
  "signals": ["конкретная причина на основе сравнения текста с интернетом"],
  "advice": "четкая рекомендация для пользователя"
}`;
}

async function classifyWithLLM(text, searchContext) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY не задан в переменных окружения Vercel");

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      models: FALLBACK_MODELS, // Передаем массив вместо единичной модели
      messages: [
        { role: "system", content: buildSystemPrompt(searchContext) },
        { role: "user", content: text },
      ],
      temperature: 0.1,
    }),
  });

  if (!response.ok) throw new Error(`OpenRouter вернул статус ${response.status}`);

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? "";
  
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("модель вернула ответ не в формате JSON");
  return JSON.parse(jsonMatch[0]);
}

// ---------------------------------------------------------------------------
// Шаг 5: Сборка ответа и страховочные фильтры
// ---------------------------------------------------------------------------
function attachFakePatterns(llmResult, localMatches, originalText) {
  const localSignals = localMatches.map((m) => `[Локальный маркер] ${m.label}: ${m.note}`);
  
  let finalRiskLevel = llmResult.riskLevel || "medium";
  let finalRiskLabel = llmResult.riskLabel || "Анализ";
  let finalAdvice = llmResult.advice || "";

  if (localMatches.length > 0 && finalRiskLevel === "low") {
    finalRiskLevel = "medium";
    finalRiskLabel = "Обнаружены признаки фейки";
  }

  // Мягкая локальная проверка на сатиру
  const lowerText = originalText.toLowerCase();
  if (lowerText.includes("bare-assed") || lowerText.includes("the onion") || lowerText.includes("panorama.pub")) {
    finalRiskLevel = "medium";
    finalRiskLabel = "Юмористический вымысел / Сатира";
    finalAdvice = "Внимание: Обнаружены явные признаки сатирического контекста (шутка).";
  }

  return {
    riskLevel: finalRiskLevel,
    riskLabel: finalRiskLabel,
    signals: [...localSignals, ...(llmResult.signals || [])],
    advice: finalAdvice
  };
}

// ---------------------------------------------------------------------------
// Логирование в Supabase
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
// Главный обработчик Vercel Serverless
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(200).json({ message: "Принимаются только POST-запросы с { type, content }." });
  }

  try {
    const { type, content } = req.body || {};
    if (!content || !["text", "url"].includes(type)) {
      return res.status(400).json({ error: "Неверные параметры запроса" });
    }

    const text = type === "url" ? await extractTextFromUrl(content) : content.slice(0, MAX_INPUT_CHARS);
    if (!text.trim()) return res.status(422).json({ error: "Пустой текст для анализа" });

    // 1. Делаем быструю локальную проверку стоп-слов
    const localMatches = findLocalMatches(text);

    // 2. Формируем поисковый запрос из первых 80 символов (самая суть новости)
    const searchQuery = text.slice(0, 80).replace(/[\n\r]/g, " ");
    
    // 3. Запускаем поиск в реальном времени через Google
    const searchContext = await searchInternet(searchQuery);

    // 4. Передаем новость и данные из сети в ИИ
    const llmResult = await classifyWithLLM(text, searchContext);
    
    // 5. Собираем финальный вердикт
    const result = attachFakePatterns(llmResult, localMatches, text);

    await logCheck(text, result);
    return res.status(200).json(result);

  } catch (err) {
    console.error("Критическая ошибка бэкенда:", err);
    return res.status(500).json({
      riskLevel: "medium",
      riskLabel: "Ошибка проверки",
      signals: [`Бэкенд не смог обработать запрос: ${err.message}`],
      advice: "Пожалуйста, повторите попытку позже."
    });
  }
}