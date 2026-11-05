const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const axios = require("axios");

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require("./service-account.json");
}

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

async function isHolidayOrWeekend() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log("Today is a weekend (Saturday/Sunday).");
    return true;
  }

  try {
    const response = await axios.get("https://api.lucky2d.com/api/holiday/GetHolidayList", { 
      timeout: 5000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*"
      }
    });
    const holidays = response.data;
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Yangon' });
    if (Array.isArray(holidays) && holidays.includes(todayStr)) {
      console.log("Today is a public holiday.");
      return true;
    }
  } catch (error) {
    console.error("Error fetching holiday list: ", error.message);
  }

  return false;
}

// 📅 အနီးဆုံး အတိတ်ဖွင့်ရက် (Last Business/Trading Day) ကို ရှာပေးမည့် Function
async function getLastBusinessDay() {
  let date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon" }));
  date.setDate(date.getDate() - 1);

  let holidays = [];
  try {
    const response = await axios.get("https://api.lucky2d.com/api/holiday/GetHolidayList", { 
      timeout: 5000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*"
      }
    });
    if (Array.isArray(response.data)) {
      holidays = response.data;
    }
  } catch (error) {
    console.error("Error fetching holiday list for last business day:", error.message);
  }

  while (true) {
    const dayOfWeek = date.getDay();
    const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'Asia/Yangon' });

    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    const isHoliday = holidays.includes(dateStr);

    if (!isWeekend && !isHoliday) {
      return dateStr;
    }

    date.setDate(date.getDate() - 1);
  }
}

async function morningArchiveTask() {
  console.log("Checking holiday/weekend status for archive task...");
  if (await isHolidayOrWeekend()) {
    console.log("Today is a weekend or holiday. Skipping morning archive task.");
    return;
  }

  try {
    const latestRef = db.collection("latest").doc("current");
    const latestDoc = await latestRef.get();

    if (latestDoc.exists) {
      const data = latestDoc.data();
      
      const archiveDateStr = await getLastBusinessDay();
      console.log(`Calculated target archive date: ${archiveDateStr}`);

      await db.collection("history").doc(archiveDateStr).set(data);
      console.log(`Archived latest data to history/${archiveDateStr}`);

      const cfWorkerUrl = process.env.CF_WORKER_URL;
      if (cfWorkerUrl) {
        try {
          const workerTriggerUrl = cfWorkerUrl.endsWith('/') 
            ? `${cfWorkerUrl}trigger` 
            : `${cfWorkerUrl}/trigger`;

          await axios.post(workerTriggerUrl, {
            session: "morning",
            action: "clear_latest",
            date: archiveDateStr,
            data: data
          }, { timeout: 5000 });
          
          console.log("[Success] Sent clear_latest & archive action to Cloudflare Worker.");
        } catch (err) {
          console.error("Error sending clear request to Cloudflare Worker:", err.message);
        }
      }

      await latestRef.set({
        updatedAt: FieldValue.serverTimestamp()
      });
      console.log("Latest data reset.");
    } else {
      console.log("No 'latest/current' document found to archive.");
    }

    const historySnapshot = await db.collection("history").orderBy('__name__', 'desc').get();
    if (historySnapshot.size > 10) {
      const docsToDelete = historySnapshot.docs.slice(10);
      const batch = db.batch();
      docsToDelete.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      console.log(`Cleaned up old history records. Deleted ${docsToDelete.length} docs.`);
    }
  } catch (error) {
    console.error("Error in morning archive task: ", error);
  }
}

function getTargetDateTime(sectionName) {
  const now = new Date();
  const yangonDateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Yangon' });
  
  let targetHour = 12;
  let targetMinute = 1;

  if (sectionName.toLowerCase().includes("9:30") || sectionName.toLowerCase().includes("morning")) {
    targetHour = 9;
    targetMinute = 30;
  } else if (sectionName.toLowerCase().includes("2:00") || sectionName.toLowerCase().includes("two_pm")) {
    targetHour = 14;
    targetMinute = 0;
  } else if (sectionName.toLowerCase().includes("4:30") || sectionName.toLowerCase().includes("evening")) {
    targetHour = 16;
    targetMinute = 30;
  }

  const targetString = `${yangonDateStr}T${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')}:00+06:30`;
  return new Date(targetString).getTime();
}

// 🚀 API မှ Data များကို ယူ၍ သိမ်းဆည်းမည့် Function
async function fetchAndSaveLive(apiUrl, sectionKey, sectionName) {
  console.log(`Checking holiday/weekend status for live fetch task (${sectionName})...`);
  if (await isHolidayOrWeekend()) {
    console.log("Today is a weekend or holiday. Skipping live fetch task.");
    return;
  }

  const targetTimeMs = getTargetDateTime(sectionName);
  const nowMs = Date.now();
  const delayMs = targetTimeMs - nowMs;

  console.log(`Target Time for ${sectionName} is set to timestamp: ${targetTimeMs}`);

  if (delayMs > 0) {
    console.log(`[Silent Wait] Script started early. Waiting for ${(delayMs / 1000).toFixed(1)} seconds until exact target time...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  } else {
    console.log(`[Warning] Target time already passed or reached by ${(Math.abs(delayMs) / 1000).toFixed(1)}s. Executing immediately.`);
  }

  console.log(`[Executing] Fetching exact live data for ${sectionName} from API: ${apiUrl}`);

  let response = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await axios.get(apiUrl, { 
        timeout: 5000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://setlive.myanmarnode.com/",
          "Accept": "application/json, text/plain, */*"
        }
      });
      if (response && response.data) {
        break;
      }
    } catch (err) {
      console.error(`[Attempt ${attempt}/3] Error fetching section API:`, err.message);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  if (!response || !response.data) {
    console.error(`[Failed] Could not fetch data for ${sectionName} after multiple attempts.`);
    return;
  }

  const resData = response.data;
  let formattedData = null;

  // 🌐 Modern Internet API အတွက် သီးသန့် structure formatting
  if (apiUrl.includes("setlive.myanmarnode.com")) {
    const rawData = resData.data || resData;
    let modernVal = "";
    let internetVal = "";
    let timeKey = "";

    if (sectionName.toLowerCase().includes("9:30")) {
      modernVal = rawData.modern_930 || "";
      internetVal = rawData.internet_930 || "";
      timeKey = "9:30am";
    } else if (sectionName.toLowerCase().includes("2:00")) {
      modernVal = rawData.modern_200 || "";
      internetVal = rawData.internet_200 || "";
      timeKey = "2:00pm";
    }

    formattedData = {
      [timeKey]: {
        modern: modernVal !== "" ? String(modernVal).padStart(2, "0") : "",
        internet: internetVal !== "" ? String(internetVal).padStart(2, "0") : ""
      }
    };
  } else {
    // မူရင်း API များအတွက် logic အဟောင်း
    let finalData = null;
    let targetHour = 12;
    let targetMinute = 1;
    if (sectionName.toLowerCase().includes("4:30") || sectionName.toLowerCase().includes("evening")) {
      targetHour = 16;
      targetMinute = 30;
    }

    if (Array.isArray(resData) && resData.length > 0) {
      finalData = resData.reduce((closest, current) => {
        const currentDateStr = current.createdAt || current.date || "";
        if (!currentDateStr) return closest;

        const currDate = new Date(currentDateStr);
        const currHour = currDate.getHours();
        const currMinute = currDate.getMinutes();
        const currSecond = currDate.getSeconds();

        const targetTotalSec = targetHour * 3600 + targetMinute * 60;
        const currTotalSec = currHour * 3600 + currMinute * 60 + currSecond;

        const closestDateStr = closest.createdAt || closest.date || "";
        if (!closestDateStr) return current;

        const closeDate = new Date(closestDateStr);
        const closeTotalSec = closeDate.getHours() * 3600 + closeDate.getMinutes() * 60 + closeDate.getSeconds();

        const currDiff = currTotalSec - targetTotalSec;
        const closeDiff = closeTotalSec - targetTotalSec;

        if (Math.abs(currDiff) <= Math.abs(closeDiff)) {
          return current;
        }
        return closest;
      }, resData[0]);
    } else {
      finalData = resData;
    }

    if (finalData) {
      const rawTwod = finalData.result ?? finalData.twod ?? finalData.number ?? "";
      const formattedTwod = rawTwod !== "" ? String(rawTwod).padStart(2, "0") : "";

      formattedData = {
        section: sectionName,
        set: String(finalData.set || ""),
        val: String(finalData.value || finalData.val || ""),
        twod: formattedTwod
      };
    }
  }

  if (formattedData) {
    try {
      const latestRef = db.collection("latest").doc("current");
      
      if (apiUrl.includes("setlive.myanmarnode.com")) {
        const timeKey = sectionName.toLowerCase().includes("9:30") ? "9:30am" : "2:00pm";
        const timeKeyData = formattedData[timeKey];
        
        await latestRef.set({
          [sectionKey]: {
            [timeKey]: timeKeyData
          },
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      } else {
        await latestRef.set({
          [sectionKey]: formattedData,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }

      console.log(`[Firebase Updated] Successfully saved exact live data for ${sectionName} under key [${sectionKey}].`);
    } catch (dbErr) {
      console.error("Error saving data to Firebase:", dbErr.message);
    }
  }

  // 🚀 Cloudflare Worker သို့ လှမ်းနိုးမည်
  console.log(`[Triggering Worker] Waking up Cloudflare Worker for ${sectionName}...`);
  const cfWorkerUrl = process.env.CF_WORKER_URL;
  if (cfWorkerUrl) {
    try {
      const workerTriggerUrl = cfWorkerUrl.endsWith('/') 
        ? `${cfWorkerUrl}trigger` 
        : `${cfWorkerUrl}/trigger`;

      const sessionParam = sectionName.toLowerCase().includes("9:30") ? "morning" : sectionName;

      await axios.post(workerTriggerUrl, {
        session: sessionParam,
        section: sectionKey,
        action: "fetch_and_sync"
      }, { timeout: 3000 });

      console.log(`[Success] Successfully woke up Cloudflare Worker for ${sectionName}.`);
    } catch (workerErr) {
      console.error("Error triggering Cloudflare Worker:", workerErr.message);
    }
  }

  console.log(`Live session completed for ${sectionName}.`);
}

async function main() {
  const task = process.argv[2];
  console.log("Received task argument:", task);

  const modernInternetUrl = "https://setlive.myanmarnode.com/live.json?_st=121bb69dbc947c6b14c5f36d7206c76b31291d8241ca5c60693ec95764ef8c3a";

  if (task === "archive") {
    console.log("Running Morning Archive Task...");
    await morningArchiveTask();
  } else if (task === "morning") {
    console.log("Running Morning Fetch Task (9:30 AM)...");
    await fetchAndSaveLive(modernInternetUrl, "modern_internet", "9:30 AM");
  } else if (task === "noon") {
    console.log("Running Noon Fetch Task (12:01 PM)...");
    await fetchAndSaveLive("https://signalr.crazybossy.com/api/info/Get2dlog_Bysection?section=12:01%20PM", "noon_data", "12:01 PM");
  } else if (task === "two_pm") {
    console.log("Running 2:00 PM Fetch Task...");
    await fetchAndSaveLive(modernInternetUrl, "modern_internet", "2:00 PM");
  } else if (task === "evening") {
    console.log("Running Evening Fetch Task (4:30 PM)...");
    await fetchAndSaveLive("https://signalr.crazybossy.com/api/info/Get2dlog_Bysection?section=04:30%20PM", "evening_data", "4:30 PM");
  } else {
    console.log("Please specify a valid task: archive, morning, noon, two_pm, or evening");
  }

  console.log("Task execution finished.");
  process.exit(0);
}

main();
