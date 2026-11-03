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
    const response = await axios.get("https://api.lucky2d.com/api/holiday/GetHolidayList", { timeout: 5000 });
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
  date.setDate(date.getDate() - 1); // မနေ့က စတင်စစ်မည်

  let holidays = [];
  try {
    const response = await axios.get("https://api.lucky2d.com/api/holiday/GetHolidayList", { timeout: 5000 });
    if (Array.isArray(response.data)) {
      holidays = response.data;
    }
  } catch (error) {
    console.error("Error fetching holiday list for last business day:", error.message);
  }

  while (true) {
    const dayOfWeek = date.getDay(); // 0 = Sun, 6 = Sat
    const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'Asia/Yangon' });

    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    const isHoliday = holidays.includes(dateStr);

    if (!isWeekend && !isHoliday) {
      return dateStr; // ဖွင့်ရက်စွဲ ရပြီဆိုပါက Return ပြန်မည်
    }

    date.setDate(date.getDate() - 1); // စနေ/တနင်္ဂနွေ သို့မဟုတ် ပိတ်ရက်ဖြစ်ပါက ၁ ရက် ထပ်ဆုတ်မည်
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
          const workerHistoryUrl = cfWorkerUrl.endsWith('/') 
            ? `${cfWorkerUrl}history` 
            : `${cfWorkerUrl}/history`;

          await axios.post(workerHistoryUrl, {
            action: "archive",
            date: archiveDateStr,
            data: data
          }, { timeout: 5000 });
          
          console.log("[Success] History data archived to Cloudflare Worker/KV.");
        } catch (err) {
          console.error("Error sending history to Cloudflare Worker:", err.message);
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

// 🎯 Target Time အတိအကျကို တွက်ထုတ်မည့် Helper Function (Asia/Yangon အချိန်အရ)
function getTargetDateTime(sectionName) {
  const now = new Date();
  // Yangon အချိန်ကို ယူရန် string ဖြင့် ပြောင်းမည်
  const yangonDateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Yangon' }); // YYYY-MM-DD
  
  let targetHour = 12;
  let targetMinute = 1;

  if (sectionName.toLowerCase().includes("4:30") || sectionName.toLowerCase().includes("evening")) {
    targetHour = 16;
    targetMinute = 30;
  }

  // Yangon အချိန်နဲ့ Target Time ကို UTC Timestamp သို့ ပြန်ပြောင်းတွက်မည်
  // ဥပမာ - 12:01 PM Yangon time = 05:30 UTC
  // အလွယ်ဆုံးနည်းကတော့ string ကနေ ISO datetime တည်ဆောက်ပြီး Date object တည်ဆောက်ခြင်း
  const targetString = `${yangonDateStr}T${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')}:00+06:30`;
  return new Date(targetString).getTime();
}

async function fetchAndSaveLive(apiUrl, sectionKey, sectionName) {
  console.log(`Checking holiday/weekend status for live fetch task (${sectionName})...`);
  if (await isHolidayOrWeekend()) {
    console.log("Today is a weekend or holiday. Skipping live fetch task.");
    return;
  }

  const durationMs = 150 * 1000; // 150 seconds (၂ မိနစ်ခွဲ)
  const intervalMs = 10 * 1000;  // 10 seconds တစ်ကြိမ်
  const startTime = Date.now();
  let lastSavedDataString = "";
  let hasTriggeredWorker = false; // Worker ကို တစ်ခါပဲ လှမ်းနိုးရန် Flag

  // Target Time အတိအကျကို တွက်မည် (ဥပမာ: 12:01:00 or 16:30:00)
  const targetTimeMs = getTargetDateTime(sectionName);
  console.log(`Target Time for ${sectionName} is set to timestamp: ${targetTimeMs}`);

  console.log(`Starting live fetch loop for ${sectionName}: ${apiUrl}`);

  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      const nowMs = Date.now();
      const elapsed = nowMs - startTime;
      const isTimeUp = elapsed >= durationMs;

      try {
        const response = await axios.get(apiUrl, { timeout: 5000 });
        const resData = response.data;

        let finalData = null;
        if (Array.isArray(resData) && resData.length > 0) {
          finalData = resData.reduce((latest, current) => {
            const latestTime = new Date(latest.createdAt || latest.date || 0).getTime();
            const currentTime = new Date(current.createdAt || current.date || 0).getTime();
            return currentTime > latestTime ? current : latest;
          }, resData[0]);
        } else {
          finalData = resData;
        }

        if (finalData) {
          const rawTwod = finalData.result ?? finalData.twod ?? finalData.number ?? "";
          const formattedTwod = rawTwod !== "" ? String(rawTwod).padStart(2, "0") : "";

          const formattedData = {
            section: sectionName,
            set: String(finalData.set || ""),
            val: String(finalData.value || finalData.val || ""),
            twod: formattedTwod
          };

          const currentDataString = JSON.stringify(formattedData);

          // 1. Data အပြောင်းအလဲ ရှိတိုင်း Firebase ထဲ အမြဲ ကြိုတင် သိမ်းထားမည် (Always up-to-date in Firebase)
          if (currentDataString !== lastSavedDataString || isTimeUp) {
            const latestRef = db.collection("latest").doc("current");
            await latestRef.set({
              [sectionKey]: formattedData,
              updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });

            console.log(`[Firebase Updated] Saved live data for ${sectionName}.`);
            lastSavedDataString = currentDataString;
          }
        }
      } catch (err) {
        console.error("Error fetching section API:", err.message);
      }

      // 2. 🚀 Target Time အတိအကျ (သို့မဟုတ် ကျော်လွန်သွားချိန်) ရောက်ပြီဆိုမှ Worker ကို တစ်ကြိမ်တည်း လှမ်းနိုးမည်
      if (!hasTriggeredWorker && (nowMs >= targetTimeMs || isTimeUp)) {
        hasTriggeredWorker = true;
        console.log(`[Target Time Reached] Triggering Cloudflare Worker for ${sectionName}...`);

        const cfWorkerUrl = process.env.CF_WORKER_URL;
        if (cfWorkerUrl) {
          try {
            const workerTriggerUrl = cfWorkerUrl.endsWith('/') 
              ? `${cfWorkerUrl}trigger` 
              : `${cfWorkerUrl}/trigger`;

            await axios.post(workerTriggerUrl, {
              section: sectionKey,
              action: "fetch_and_sync"
            }, { timeout: 3000 });

            console.log(`[Success] Successfully woke up Cloudflare Worker at target time for ${sectionName}.`);
          } catch (workerErr) {
            console.error("Error triggering Cloudflare Worker:", workerErr.message);
          }
        }
      }

      // Loop ပြီးဆုံးချိန်
      if (isTimeUp) {
        clearInterval(timer);
        console.log(`Live session completed for ${sectionName}.`);
        resolve();
      }
    }, intervalMs);
  });
}

async function main() {
  const task = process.argv[2];
  console.log("Received task argument:", task);

  if (task === "archive") {
    console.log("Running Morning Archive Task...");
    await morningArchiveTask();
  } else if (task === "noon") {
    console.log("Running Noon Fetch Task (12:01 PM)...");
    await fetchAndSaveLive("https://signalr.crazybossy.com/api/info/Get2dlog_Bysection?section=12:01%20PM", "noon_data", "12:01 PM");
  } else if (task === "evening") {
    console.log("Running Evening Fetch Task (4:30 PM)...");
    await fetchAndSaveLive("https://signalr.crazybossy.com/api/info/Get2dlog_Bysection?section=04:30%20PM", "evening_data", "4:30 PM");
  } else {
    console.log("Please specify a valid task: archive, noon, or evening");
  }

  console.log("Task execution finished.");
  process.exit(0);
}

main();
