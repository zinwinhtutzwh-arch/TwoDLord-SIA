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
    const response = await axios.get("https://api.lucky2d.com/api/holiday/GetHolidayList");
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

      // Archive ပြီးပါက latest ကို ရှင်းလင်းထားမည်
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
  let finalData = null;
  const startTime = Date.now();

  console.log(`Starting live fetch loop from API for ${sectionName}: ${apiUrl}`);

  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        const response = await axios.get(apiUrl);
        finalData = response.data;
        console.log(`Fetched live data chunk for ${sectionName}...`);
      } catch (err) {
        console.error("Error fetching section API:", err.message);
      }

      if (Date.now() - startTime >= durationMs) {
        clearInterval(timer);
        (async () => {
          try {
            if (finalData) {
              const latestRef = db.collection("latest").doc("current");
              
              // 🖼️ ပုံထဲကအတိုင်း 12:01 PM နဲ့ 04:30 PM ကို သီးသန့် Field လေးတွေနဲ့ ပုံစံကျကျ သိမ်းဆည်းခြင်း (merge: true သုံး၍ နှစ်ခုစလုံး တည်ရှိစေရန်)
              await latestRef.set({
                [sectionKey]: {
                  section: sectionName,
                  set: finalData.set || "",       // ဥပမာ - "1,524.29"
                  val: finalData.val || finalData.value || "",   // ဥပမာ - "40,440.35"
                  twod: finalData.twod || finalData.number || "" // ဥပမာ - "90"[cite: 4]
                },
                updatedAt: FieldValue.serverTimestamp()
              }, { merge: true });

              console.log(`Live session completed for ${sectionName}. Saved to latest/current.`);
            } else {
              console.log("No data received from API during the live session.");
            }
          } catch (dbErr) {
            console.error("Error saving final live data to Firestore:", dbErr);
          }
          resolve();
        })();
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
    // "noon_data" ဆိုတဲ့ Key နဲ့ 12:01 PM ကို သိမ်းမည်
    await fetchAndSaveLive("https://signalr.crazybossy.com/api/info/Get2dlog_Bysection?section=12:01%20PM", "noon_data", "12:01 PM");
  } else if (task === "evening") {
    console.log("Running Evening Fetch Task (4:30 PM)...");
    // "evening_data" ဆိုတဲ့ Key နဲ့ 04:30 PM ကို သိမ်းမည်
    await fetchAndSaveLive("https://signalr.crazybossy.com/api/info/Get2dlog_Bysection?section=4:30%20PM", "evening_data", "04:30 PM");
  } else {
    console.log("Please specify a valid task: archive, noon, or evening");
  }

  console.log("Task execution finished.");
  process.exit(0);
}

main();