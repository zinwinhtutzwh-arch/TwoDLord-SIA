import * as cheerio from "cheerio";

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_NAMESPACE_ID = process.env.CF_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const MODE = process.env.MODE || "update"; // "reset" or "update"

const KV_BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values`;

// --- Cloudflare KV Helpers ---
async function kvGet(key) {
  const res = await fetch(`${KV_BASE_URL}/${key}`, {
    headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
  });
  if (!res.ok) return null;
  return await res.text();
}

async function kvPut(key, value) {
  const res = await fetch(`${KV_BASE_URL}/${key}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "text/plain",
    },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`KV Put failed for ${key}: ${await res.text()}`);
}

// --- Date & Holiday Helpers ---
function getMyanmarDate() {
  const now = new Date();
  const mmTime = new Date(now.getTime() + 6.5 * 60 * 60 * 1000);
  return mmTime.toISOString().split("T")[0];
}

function getMyanmarHour() {
  const now = new Date();
  const mmTime = new Date(now.getTime() + 6.5 * 60 * 60 * 1000);
  return mmTime.getUTCHours();
}

function parseDrawDateToISO(text) {
  const cleaned = text.replace(/Next draw\s*(?:·|·|·|\u00B7)?\s*/i, "").trim();
  const parsed = new Date(`${cleaned} 12:00:00 UTC`);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split("T")[0];
}

async function isHolidayOrWeekend() {
  const now = new Date();
  const mmTime = new Date(now.getTime() + 6.5 * 60 * 60 * 1000);
  const dayOfWeek = mmTime.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return true;

  try {
    const res = await fetch("https://api.lucky2d.com/api/holiday/GetHolidayList");
    const holidays = await res.json();
    const todayStr = getMyanmarDate();
    if (Array.isArray(holidays)) {
      return holidays.some((h) => h.date && h.date.startsWith(todayStr));
    }
  } catch (e) {
    console.error("Holiday API Error:", e.message);
  }
  return false;
}

// --- 1. Reset 2D Data (6:30 AM) ---
async function reset2DData() {
  console.log("Running 2D Reset...");
  const existingRaw = await kvGet("ALL_MARKET_DATA");
  const existingData = existingRaw ? JSON.parse(existingRaw) : {};

  existingData.updated_at = new Date().toISOString();
  existingData.modern_internet = {
    "09:30_AM": { modern: null, internet: null },
    "02:00_PM": { modern: null, internet: null },
  };

  await kvPut("ALL_MARKET_DATA", JSON.stringify(existingData));
  console.log("2D Data Reset Complete.");
}

// --- 2. Fetch 2D Data with Retry (၁၅ စက္ကန့်ခြား အကြိမ် ၄၀ = ၁၀ မိနစ်တိုင်အောင် Data ရတဲ့အထိ စောင့်မည်) ---
async function fetch2DData() {
  if (await isHolidayOrWeekend()) {
    console.log("Skipping 2D: Weekend or Public Holiday.");
    return null;
  }

  const isAfternoon = getMyanmarHour() >= 12;
  const maxAttempts = 40;
  let modernInternetRaw = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch("https://setlive.myanmarnode.com/en/2d", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      const html = await res.text();
      const $ = cheerio.load(html);

      modernInternetRaw = [];
      $('section[aria-labelledby="modern-internet-heading"] strong').each((_, el) => {
        const val = $(el).text().trim();
        if (val) modernInternetRaw.push(val);
      });

      const isReady = !isAfternoon
        ? modernInternetRaw.length >= 2 && modernInternetRaw[0] !== "--" && modernInternetRaw[1] !== "--"
        : modernInternetRaw.length >= 4 && !modernInternetRaw.includes("--");

      if (isReady) {
        console.log(`2D Data fetched successfully on attempt ${attempt}:`, modernInternetRaw);
        break;
      }

      console.log(`Attempt ${attempt}/${maxAttempts}: 2D data not ready yet (${modernInternetRaw.join(", ")}). Waiting 15s...`);
    } catch (e) {
      console.error(`Attempt ${attempt} error:`, e.message);
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 15000));
    }
  }

  return {
    "09:30_AM": {
      modern: modernInternetRaw[0] && modernInternetRaw[0] !== "--" ? modernInternetRaw[0] : null,
      internet: modernInternetRaw[1] && modernInternetRaw[1] !== "--" ? modernInternetRaw[1] : null,
    },
    "02:00_PM": {
      modern: modernInternetRaw[2] && modernInternetRaw[2] !== "--" ? modernInternetRaw[2] : null,
      internet: modernInternetRaw[3] && modernInternetRaw[3] !== "--" ? modernInternetRaw[3] : null,
    },
  };
}

// --- 3. Fetch Currency Rate ---
async function fetchCurrencyData() {
  try {
    const res = await fetch("https://setlive.myanmarnode.com/en/market-prices/currencies", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    const usdRates = [];
    $('a[href="/en/market-prices/currencies/usd"] p.text-base.font-bold').each((_, el) => {
      const val = $(el).text().trim();
      if (val) usdRates.push(val);
    });

    console.log("Currency fetched:", usdRates);
    return {
      buy: usdRates[0] || null,
      sell: usdRates[1] || null,
    };
  } catch (e) {
    console.error("Currency fetch error:", e.message);
    return null;
  }
}

// --- 4. Fetch 3D Data with Retry (Draw Day ဖြစ်ပါက ၁ မိနစ်ခြား မိနစ် ၂၀ စောင့်ယူမည်) ---
async function fetch3DDataWithRetry() {
  const todayStr = getMyanmarDate();
  let nextDrawDate = await kvGet("NEXT_3D_DRAW_DATE");
  const existingRaw = await kvGet("ALL_MARKET_DATA");
  const existingData = existingRaw ? JSON.parse(existingRaw) : {};

  if (existingData.three_d?.next_new_day && nextDrawDate && nextDrawDate !== todayStr) {
    console.log(`Skipping 3D: Today (${todayStr}) is not draw day (${nextDrawDate}).`);
    return null;
  }

  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch("https://setlive.myanmarnode.com/en/3d", {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const html = await res.text();
      const $ = cheerio.load(html);

      const latest3D = $("p.font-mono.text-7xl").text().trim() || null;
      const history3D = [];

      $('a[href^="/en/3d/20"]').each((_, el) => {
        const href = $(el).attr("href") || "";
        const isoDate = href.replace("/en/3d/", "").trim();
        const date = $(el).find("p.text-sm.font-bold").text().trim();
        const prize1st = $(el).find("p.font-mono.text-xs").text().trim().replace("1st Prize ", "");
        const threeD = $(el).find("span.font-mono.text-lg").text().trim();
        history3D.push({ isoDate, date, prize1st, threeD });
      });

      const match = html.match(/Next draw\s*·\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/);
      const cleanNextDraw = match && match[1] ? match[1].trim() : null;
      const nextDrawISO = cleanNextDraw ? parseDrawDateToISO(cleanNextDraw) : null;

      if (!nextDrawDate && nextDrawISO) {
        nextDrawDate = nextDrawISO;
        await kvPut("NEXT_3D_DRAW_DATE", nextDrawDate);
      }

      const isInitialEmpty = !existingData.three_d || !existingData.three_d.next_new_day;
      const isTodayPublished = history3D.some((item) => item.isoDate === todayStr);

      if (isInitialEmpty || isTodayPublished) {
        console.log(`3D Data ready on attempt ${attempt}!`);
        if (nextDrawISO && nextDrawISO !== todayStr) {
          await kvPut("NEXT_3D_DRAW_DATE", nextDrawISO);
        }
        return {
          next_new_day: cleanNextDraw,
          latest: latest3D,
          history: history3D,
        };
      }

      console.log(`Attempt ${attempt}/${maxAttempts}: 3D result for today not published yet. Waiting 60s...`);
    } catch (e) {
      console.error(`3D Attempt ${attempt} error:`, e.message);
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 60000));
    }
  }

  return null;
}

// --- Master Execution ---
async function main() {
  if (MODE === "reset") {
    await reset2DData();
    return;
  }

  console.log("Starting full update (2D + Currency + 3D)...");
  const [twoDResult, currencyResult, threeDResult] = await Promise.all([
    fetch2DData(),
    fetchCurrencyData(),
    fetch3DDataWithRetry(),
  ]);

  const existingRaw = await kvGet("ALL_MARKET_DATA");
  const existingData = existingRaw ? JSON.parse(existingRaw) : {};

  existingData.updated_at = new Date().toISOString();

  if (twoDResult) {
    const old2D = existingData.modern_internet || {
      "09:30_AM": { modern: null, internet: null },
      "02:00_PM": { modern: null, internet: null },
    };
    existingData.modern_internet = {
      "09:30_AM": {
        modern: twoDResult["09:30_AM"].modern || old2D["09:30_AM"]?.modern || null,
        internet: twoDResult["09:30_AM"].internet || old2D["09:30_AM"]?.internet || null,
      },
      "02:00_PM": {
        modern: twoDResult["02:00_PM"].modern || old2D["02:00_PM"]?.modern || null,
        internet: twoDResult["02:00_PM"].internet || old2D["02:00_PM"]?.internet || null,
      },
    };
  }

  if (currencyResult && (currencyResult.buy || currencyResult.sell)) {
    existingData.usd = currencyResult;
  }

  if (threeDResult) {
    existingData.three_d = threeDResult;
  }

  await kvPut("ALL_MARKET_DATA", JSON.stringify(existingData));
  console.log("All data saved to Cloudflare KV successfully!");
}

main();
