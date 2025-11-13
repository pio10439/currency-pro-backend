require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const NodeCache = require("node-cache");

const app = express();
app.use(cors());
app.use(express.json());

const cache = new NodeCache({ stdTTL: 3600 });

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
const messaging = admin.messaging();

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Brak tokena" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    res.status(401).json({ error: "Zły token" });
  }
};

app.get("/rates", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const key = "latest";

  if (cache.has(key)) {
    return res.json(cache.get(key));
  }

  try {
    const { data } = await axios.get(
      "https://api.nbp.pl/api/exchangerates/tables/A/?format=json"
    );
    const rates = data[0].rates.reduce(
      (acc, r) => ({ ...acc, [r.code]: r.mid }),
      {}
    );
    rates.PLN = 1;
    const result = { rates, date: data[0].effectiveDate };

    cache.set(key, result);

    await db.collection("rates").doc(today).set(
      {
        rates,
        date: data[0].effectiveDate,
        timestamp: new Date().toISOString(),
      },
      { merge: true }
    );

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "Błąd API NBP" });
  }
});

app.get("/rates/archive", async (req, res) => {
  try {
    const snapshot = await db
      .collection("rates")
      .orderBy("timestamp", "desc")
      .limit(30)
      .get();

    if (snapshot.empty) {
      return res
        .status(404)
        .json({ error: "Brak danych w archiwum – poczekaj na zapis" });
    }

    const archive = {};
    snapshot.forEach((doc) => {
      const data = doc.data();
      archive[doc.id] = {
        rates: data.rates,
        date: data.date || doc.id,
      };
    });

    res.json(archive);
  } catch (e) {
    console.error("Błąd archiwum:", e);
    res.status(500).json({ error: "Błąd odczytu archiwum" });
  }
});

S: app.get("/rates/:date", async (req, res) => {
  const { date } = req.params;
  const key = date;

  if (cache.has(key)) {
    return res.json(cache.get(key));
  }

  try {
    const { data } = await axios.get(
      `https://api.nbp.pl/api/exchangerates/tables/A/${date}/?format=json`
    );
    const rates = data[0].rates.reduce(
      (acc, r) => ({ ...acc, [r.code]: r.mid }),
      {}
    );
    rates.PLN = 1;
    const result = { rates, date: data[0].effectiveDate };
    cache.set(key, result);

    await db.collection("rates").doc(date).set(
      {
        rates,
        date: data[0].effectiveDate,
        timestamp: new Date().toISOString(),
      },
      { merge: true }
    );

    res.json(result);
  } catch (e) {
    res.status(404).json({ error: "Brak danych dla tej daty" });
  }
});

app.get("/user", verifyToken, async (req, res) => {
  const userRef = db.collection("users").doc(req.uid);
  const snap = await userRef.get();

  if (!snap.exists) {
    const initialData = {
      balance: { PLN: 10000, USD: 0, EUR: 0, GBP: 0, CHF: 0 },
      transactions: [],
      createdAt: new Date().toISOString(),
    };
    await userRef.set(initialData);
    return res.json(initialData);
  }

  res.json(snap.data());
});

app.post("/save-token", verifyToken, async (req, res) => {
  const { token } = req.body;
  await db
    .collection("users")
    .doc(req.uid)
    .set({ pushToken: token }, { merge: true });
  res.json({ ok: true });
});

app.post("/transaction", verifyToken, async (req, res) => {
  const { type, currency, amount } = req.body;
  const uid = req.uid;

  if (
    !["buy", "sell"].includes(type) ||
    !["USD", "EUR", "GBP", "CHF"].includes(currency) ||
    amount <= 0
  ) {
    return res.status(400).json({ error: "Nieprawidłowe dane" });
  }

  try {
    const { data } = await axios.get(
      "https://api.nbp.pl/api/exchangerates/tables/A/?format=json"
    );
    const rateObj = data[0].rates.find((r) => r.code === currency);
    if (!rateObj) throw new Error("Brak kursu dla " + currency);
    const currentRate = rateObj.mid;

    const plnAmount = Number((amount * currentRate).toFixed(2));

    await db.runTransaction(async (t) => {
      const userRef = db.collection("users").doc(uid);
      const snap = await t.get(userRef);
      const userData = snap.data() || {
        balance: { PLN: 10000, USD: 0, EUR: 0, GBP: 0, CHF: 0 },
        transactions: [],
      };

      if (type === "buy" && (userData.balance.PLN || 0) < plnAmount) {
        throw new Error("Za mało PLN na koncie");
      }
      if (type === "sell" && (userData.balance[currency] || 0) < amount) {
        throw new Error(`Za mało ${currency} na koncie`);
      }

      const newPLN =
        (userData.balance.PLN || 0) + (type === "buy" ? -plnAmount : plnAmount);
      const newCurrency =
        (userData.balance[currency] || 0) + (type === "buy" ? amount : -amount);

      t.update(userRef, {
        "balance.PLN": newPLN,
        [`balance.${currency}`]: newCurrency,
        transactions: admin.firestore.FieldValue.arrayUnion({
          type,
          currency,
          amount: Number(amount.toFixed(4)),
          rate: Number(currentRate.toFixed(4)),
          pln: plnAmount,
          timestamp: new Date().toISOString(),
        }),
      });
    });

    const userSnap = await db.collection("users").doc(uid).get();
    const token = userSnap.data()?.pushToken;
    if (token) {
      await messaging.send({
        token,
        notification: {
          title: type === "buy" ? "Kupiono!" : "Sprzedano!",
          body: `${amount} ${currency} za ${plnAmount.toFixed(
            2
          )} PLN (kurs: ${currentRate.toFixed(4)})`,
        },
      });
    }

    res.json({ success: true, plnAmount, rate: currentRate });
  } catch (e) {
    console.error("Błąd transakcji:", e);
    res.status(400).json({ error: e.message || "Błąd transakcji" });
  }
});

app.post("/deposit", verifyToken, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 1000) {
    return res.status(400).json({ error: "Minimalna wpłata: 1000 PLN" });
  }

  try {
    const userRef = db.collection("users").doc(req.uid);

    await userRef.update({
      "balance.PLN": admin.firestore.FieldValue.increment(amount),
      transactions: admin.firestore.FieldValue.arrayUnion({
        type: "deposit",
        amount: amount,
        currency: "PLN",
        timestamp: new Date().toISOString(),
        description: "Zasilenie konta",
      }),
    });

    const userSnap = await userRef.get();
    const token = userSnap.data()?.pushToken;
    if (token) {
      await messaging.send({
        token,
        notification: {
          title: "Konto zasilone!",
          body: `+${amount} PLN na Twoim koncie`,
        },
      });
    }

    res.json({ success: true, message: `Zasilono konto o ${amount} PLN` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend działa na http://localhost:${PORT}`);
  console.log(
    `Wszystkie endpointy: /rates, /user, /transaction, /deposit, /rates/archive`
  );
});
