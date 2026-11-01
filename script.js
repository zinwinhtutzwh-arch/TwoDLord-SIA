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
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Yangon' });

      await db.collection("history").doc(todayStr).set(data);
      console.log(`Archived latest data to history/${todayStr}`);

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

async function fetchAndSaveLive(apiUrl, sectionKey, sectionName) {
  console.log(`Checking holiday/weekend status for live fetch task (${sectionName})...`);
  if (await isHolidayOrWeekend()) {
    console.log("Today is a weekend or holiday. Skipping live fetch task.");
    return;
  }

  const durationMs = 90 * 1000; // 90 seconds
  const intervalMs = 10 * 1000; // 10 seconds
  const startTime = Date.now();
  let lastSavedDataString = ""; // ယခင်သိမ်းထားသော ဒေတာနှင့် နှိုင်းယှဉ်ရန်

  console.log(`Starting live fetch loop with change detection for ${sectionName}: ${apiUrl}`);

  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      const elapsed = Date.now() - startTime;
      const isTimeUp = elapsed >= durationMs;

      try {
        const response = await axios.get(apiUrl, { timeout: 5000 });
        const finalData = response.data;

        if (finalData) {
          // 🛡️ 2D String Format ('0x') လုံခြုံရေးအတွက် Padding လုပ်ခြင်း
          const rawTwod = finalData.twod ?? finalData.number ?? "";
          const formattedTwod = rawTwod !== "" ? String(rawTwod).padStart(2, "0") : "";

          const formattedData = {
            section: sectionName,
            set: String(finalData.set || ""),
            val: String(finalData.val || finalData.value || ""),
            twod: formattedTwod
          };

          const currentDataString = JSON.stringify(formattedData);

          // 💡 Data ပြောင်းလဲမှု (Change) ရှိမရှိ (သို့) ၉၀ စက္ကန့်ပြည့်သွားခြင်း ဟုတ်မဟုတ် စစ်ဆေးခြင်း
          if (currentDataString !== lastSavedDataString || isTimeUp) {
            const latestRef = db.collection("latest").doc("current");

            await latestRef.set({
              [sectionKey]: formattedData,
              updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });

            lastSavedDataString = currentDataString;
            console.log(`[Update] Data changed or final save for ${sectionName}. Pushed to Firestore.`);
          } else {
            console.log(`[Skip] No data changes detected for ${sectionName}.`);
          }
        }
      } catch (err) {
        console.error("Error fetching section API:", err.message);
      }

      // ၉၀ စက္ကန့်ပြည့်ပါက Timer ကို ရပ်ပြီး ပြီးဆုံးကြောင်း အကြောင်းကြားမည်
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
    await fetchAndSaveLive("https://signalr.crazybossy.com/api/info/Get2dlog_Bysection?section=4:30%20PM", "evening_data", "04:30 PM");
  } else {
    console.log("Please specify a valid task: archive, noon, or evening");
  }

  console.log("Task execution finished.");
  process.exit(0);
}

main();
