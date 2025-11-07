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
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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
  const key = "latest";
  if (cache.has(key)) return res.json(cache.get(key));

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
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "Błąd API NBP" });
  }
});

app.get("/rates/:date", async (req, res) => {
  const { date } = req.params;
  const key = date;
  if (cache.has(key)) return res.json(cache.get(key));

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
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "Błąd API NBP (archiwum)" });
  }
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

  try {
    const { data } = await axios.get(
      "https://api.nbp.pl/api/exchangerates/tables/A/?format=json"
    );
    const rate = data[0].rates.find((r) => r.code === currency)?.mid;
    if (!rate) throw "Brak kursu";
    const pln = type === "buy" ? amount * rate : amount / rate;

    await db.runTransaction(async (t) => {
      const userRef = db.collection("users").doc(uid);
      const snap = await t.get(userRef);
      const data = snap.data() || {
        balance: { PLN: 10000, USD: 0, EUR: 0, GBP: 0, CHF: 0 },
      };

      if (type === "buy" && data.balance.PLN < pln) throw "Za mało PLN";
      if (type === "sell" && data.balance[currency] < amount)
        throw "Za mało waluty";

      t.set(
        userRef,
        {
          balance: {
            PLN: (data.balance.PLN || 0) + (type === "buy" ? -pln : pln),
            [currency]:
              (data.balance[currency] || 0) +
              (type === "buy" ? amount : -amount),
          },
          transactions: admin.firestore.FieldValue.arrayUnion({
            type,
            currency,
            amount,
            rate,
            pln: Math.abs(pln),
            timestamp: new Date(),
          }),
        },
        { merge: true }
      );
    });

    const userSnap = await db.collection("users").doc(uid).get();
    const token = userSnap.data()?.pushToken;
    if (token) {
      await messaging.send({
        token,
        notification: {
          title: "Transakcja!",
          body: `${amount} ${currency} za ${pln.toFixed(2)} PLN`,
        },
      });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message || e });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Backend działa na http://localhost:${PORT}`)
);
