// ==========================================
// GENZSTORE BACKEND - server.js
// Supplier: Tokovoucher
// ==========================================
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
app.use(cors());

// ==========================================
// KONFIGURASI TOKOVOUCHER
// ==========================================
const TV_MEMBER_CODE = "M260330PRHL4521UQ";
const TV_SECRET =
  "e2acf6a81220213845c5f66547ab4e5d9be610ad5b62ee3495c068793b9cea57";
const TV_BASE_URL = "https://api.tokovoucher.net/v1";

// ==========================================
// KONFIGURASI PAKASIR
// ==========================================
const PAKASIR_SLUG = "genzstore";

// ==========================================
// KONFIGURASI MARGIN HARGA JUAL
// 15% di atas harga modal GOLD TokoVoucher
// ==========================================
const MARGIN_PERSEN = 15;

// ==========================================
// KONFIGURASI SUPABASE
// ==========================================
const supabaseUrl = "https://hbbbuskvtqoetlfmiiyb.supabase.co";
const supabaseKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhiYmJ1c2t2dHFvZXRsZm1paXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NTkyOTEsImV4cCI6MjA5MDMzNTI5MX0.lx5pwxd81FtXiXh_sDxO3IDLk1PWB5IF7P1w7IzFr2g";
const supabase = createClient(supabaseUrl, supabaseKey);

async function cekKoneksi() {
  const { data, error } = await supabase.from("transaksi").select("*").limit(1);
  if (error) {
    console.error("❌ Gagal konek ke Supabase:", error.message);
  } else {
    console.log("✅ Supabase Cloud Database berhasil tersambung! 🔥");
  }
}
cekKoneksi();

// ==========================================
// HELPER: BUAT SIGNATURE TOKOVOUCHER
// Format: md5(MEMBER_CODE:SECRET:REF_ID)
// ==========================================
function buatSignatureTV(refId) {
  return crypto
    .createHash("md5")
    .update(`${TV_MEMBER_CODE}:${TV_SECRET}:${refId}`)
    .digest("hex");
}

// ==========================================
// HELPER: BUAT SIGNATURE DEFAULT TOKOVOUCHER
// Format: md5(MEMBER_CODE + SECRET) — tanpa ref_id
// Dipakai untuk: list produk, cek saldo, dll
// ==========================================
// Signature default statis dari dashboard TokoVoucher
// (Pengaturan > Secret Key > Signature)
const TV_SIGNATURE_DEFAULT = "a522624414eff2782c8d33c1575cec65";

// ==========================================
// HELPER: KONVERSI KREDIT KE RUPIAH + MARGIN
// Kredit TokoVoucher = Rupiah (1 kredit = Rp 1)
// ==========================================
function hitungHargaJual(hargaModal) {
  const hargaJual = Math.ceil(hargaModal * (1 + MARGIN_PERSEN / 100));
  // Bulatkan ke ratusan terdekat biar rapi
  return Math.ceil(hargaJual / 100) * 100;
}

function formatRupiah(angka) {
  return "Rp " + angka.toLocaleString("id-ID");
}

// ==========================================
// HELPER: PROSES TOP UP KE TOKOVOUCHER
// Dipanggil otomatis setelah pembayaran LUNAS
// ==========================================
async function prosesTopupTokovoucher(orderId) {
  try {
    // 1. Ambil data transaksi dari Supabase
    const { data: transaksi, error } = await supabase
      .from("transaksi")
      .select("*")
      .eq("order_id", orderId)
      .single();

    if (error || !transaksi) {
      console.error(`❌ Data transaksi ${orderId} tidak ditemukan`);
      return;
    }

    console.log(`\n🚀 Mulai proses top up untuk ${orderId}`);
    console.log(`   Produk  : ${transaksi.kode_produk}`);
    console.log(`   Tujuan  : ${transaksi.user_id}`);
    console.log(`   Zone ID : ${transaksi.zone_id}`);

    // 2. Buat signature
    const signature = buatSignatureTV(orderId);

    // 3. Kirim ke Tokovoucher
    const payload = {
      ref_id: orderId,
      produk: transaksi.kode_produk,
      tujuan: transaksi.user_id,
      server_id: transaksi.zone_id || "",
      member_code: TV_MEMBER_CODE,
      signature: signature,
    };

    console.log("📤 Payload ke Tokovoucher:", payload);
    const responsTV = await axios.post(`${TV_BASE_URL}/transaksi`, payload);
    const hasil = responsTV.data;
    console.log("📥 Balasan Tokovoucher:", hasil);

    // 4. Update status di Supabase
    if (hasil.status === "sukses") {
      await supabase
        .from("transaksi")
        .update({
          status_topup: "SUCCESS",
          trx_id: hasil.trx_id || "",
          sn: hasil.sn || "",
        })
        .eq("order_id", orderId);

      console.log(`✅ Top up ${orderId} SUKSES! TRX: ${hasil.trx_id}`);
    } else if (hasil.status === "pending") {
      await supabase
        .from("transaksi")
        .update({
          status_topup: "PENDING",
          trx_id: hasil.trx_id || "",
        })
        .eq("order_id", orderId);

      console.log(`⏳ Top up ${orderId} PENDING. TRX: ${hasil.trx_id}`);
    } else {
      await supabase
        .from("transaksi")
        .update({
          status_topup: "FAILED",
          sn: hasil.sn || "Gagal",
        })
        .eq("order_id", orderId);

      console.error(`❌ Top up ${orderId} GAGAL:`, hasil.message);
    }
  } catch (error) {
    console.error(`❌ Error proses top up ${orderId}:`, error.message);
    await supabase
      .from("transaksi")
      .update({ status_topup: "ERROR" })
      .eq("order_id", orderId);
  }
}

// ==========================================
// ROUTE 1: CEK NICKNAME (API ISAN - GRATIS)
// ==========================================
app.post("/api/cek-nickname", async (req, res) => {
  try {
    const { gameId, userId, zoneId } = req.body;
    console.log(
      `[LOG] Cek nickname - Game: ${gameId}, ID: ${userId}, Zone: ${zoneId}`,
    );

    let apiUrl = "";

    if (gameId === "ml") {
      apiUrl = `https://api.isan.eu.org/nickname/ml?id=${userId}&zone=${zoneId}`;
    } else if (gameId === "ff") {
      apiUrl = `https://api.isan.eu.org/nickname/ff?id=${userId}`;
    } else if (gameId === "pubg") {
      apiUrl = `https://api.isan.eu.org/nickname/pubg?id=${userId}`;
    } else {
      return res.json({
        status: "error",
        message:
          "Cek nama otomatis belum didukung untuk game ini. Pastikan ID benar!",
      });
    }

    const responsApi = await axios.get(apiUrl);

    if (
      responsApi.data &&
      responsApi.data.success === true &&
      responsApi.data.name
    ) {
      res.json({
        status: "success",
        nickname: responsApi.data.name,
        message: "Berhasil dapet nama!",
      });
    } else {
      res.json({
        status: "error",
        message: "ID Tidak Ditemukan / Server API Gangguan",
      });
    }
  } catch (error) {
    console.error("Error cek nickname:", error.message);
    res
      .status(500)
      .json({ status: "error", message: "Koneksi ke API pusat gagal." });
  }
});

// ==========================================
// ROUTE 2: BUAT TRANSAKSI (SIMPAN KE SUPABASE)
// ==========================================
app.post("/api/create-transaction", async (req, res) => {
  const {
    userId,
    zoneId,
    nickname,
    kodeProduk,
    namaProduk,
    harga,
    metodeBayar,
  } = req.body;
  const orderId = "GENZ-" + Date.now();

  const { error } = await supabase.from("transaksi").insert([
    {
      order_id: orderId,
      user_id: userId,
      zone_id: zoneId,
      nickname: nickname,
      kode_produk: kodeProduk,
      nama_produk: namaProduk,
      harga: harga,
      metode_bayar: metodeBayar,
      status_bayar: "UNPAID",
      status_topup: "PENDING",
      trx_id: "",
      sn: "",
    },
  ]);

  if (error) {
    console.error("❌ Gagal simpan transaksi:", error.message);
    return res
      .status(500)
      .json({ status: "error", pesan: "Gagal membuat pesanan" });
  }

  console.log(`✅ Transaksi dicatat: ${orderId}`);
  res.json({
    status: "sukses",
    orderId: orderId,
    pesan: "Pesanan berhasil dibuat!",
  });
});

// ==========================================
// ROUTE 3: BIKIN LINK QRIS PAKASIR
// ==========================================
app.post("/api/get-qris", async (req, res) => {
  const { orderId, harga } = req.body;

  try {
    const linkKembali = `https://genzstore-web.vercel.app/topup/invoice_akhir.html?order_id=${orderId}`;
    const checkoutUrl = `https://app.pakasir.com/pay/genzstore/${harga}?order_id=${orderId}&qris_only=1&redirect=${encodeURIComponent(linkKembali)}`;

    res.json({ status: "sukses", checkout_url: checkoutUrl });
  } catch (error) {
    console.error("❌ Error bikin link Pakasir:", error);
    res
      .status(500)
      .json({ status: "error", pesan: "Gagal membuat link pembayaran" });
  }
});

// ==========================================
// ROUTE 4: WEBHOOK PAKASIR (PEMBAYARAN LUNAS)
// ⚠️ Daftarkan URL ini di dashboard Pakasir:
// https://[domain-lu]/api/webhook-pakasir
// ==========================================
app.post("/api/webhook-pakasir", async (req, res) => {
  const data = req.body;
  console.log("\n🔔 Webhook Pakasir masuk:", data);

  if (data.status === "completed") {
    const orderId = data.order_id;
    console.log(`💰 Order ${orderId} LUNAS! Mulai proses top up...`);

    // Update status bayar
    const { error } = await supabase
      .from("transaksi")
      .update({ status_bayar: "PAID" })
      .eq("order_id", orderId);

    if (error) {
      console.error("❌ Gagal update status bayar:", error.message);
    } else {
      // Langsung proses top up ke Tokovoucher
      await prosesTopupTokovoucher(orderId);
    }
  }

  // Wajib balas OK biar Pakasir tidak kirim ulang
  res.send("OK");
});

// ==========================================
// ROUTE 5: CEK SALDO TOKOVOUCHER
// Test di browser: http://localhost:3000/api/cek-saldo
// ==========================================
app.get("/api/cek-saldo", async (req, res) => {
  try {
    const refId = "CEK-" + Date.now();
    const signature = buatSignatureTV(refId);

    const response = await axios.get(`${TV_BASE_URL}/member/saldo`, {
      params: {
        member_code: TV_MEMBER_CODE,
        signature: signature,
      },
    });

    console.log("💰 Saldo Tokovoucher:", response.data);
    res.json({ status: "sukses", data: response.data });
  } catch (error) {
    res.status(500).json({ status: "error", pesan: error.message });
  }
});

// ==========================================
// ROUTE 6: CEK STATUS PESANAN (dari Supabase)
// ==========================================
app.get("/api/cek-status/:orderId", async (req, res) => {
  const { orderId } = req.params;

  try {
    const { data, error } = await supabase
      .from("transaksi")
      .select("*")
      .eq("order_id", orderId)
      .single();

    if (error || !data) {
      return res
        .status(404)
        .json({ status: "error", pesan: "Pesanan tidak ditemukan" });
    }

    res.json({ status: "sukses", data: data });
  } catch (error) {
    res.status(500).json({ status: "error", pesan: "Server error" });
  }
});

// ==========================================
// ROUTE 7: CEK STATUS TRX DI TOKOVOUCHER
// Buat cek manual kalau status masih PENDING
// ==========================================
app.get("/api/cek-trx/:orderId", async (req, res) => {
  const { orderId } = req.params;

  try {
    const signature = buatSignatureTV(orderId);

    const response = await axios.get(`${TV_BASE_URL}/transaksi/status`, {
      params: {
        ref_id: orderId,
        member_code: TV_MEMBER_CODE,
        signature: signature,
      },
    });

    console.log("Cek status TRX:", response.data);
    res.json({ status: "sukses", data: response.data });
  } catch (error) {
    res.status(500).json({ status: "error", pesan: error.message });
  }
});

// ==========================================
// ROUTE 8: AMBIL PRODUK ML DARI TOKOVOUCHER
// ==========================================
app.get("/api/produk-ml", async (req, res) => {
  try {
    // Produk list pakai signature DEFAULT: md5(MEMBER_CODE + SECRET)
    const signature = TV_SIGNATURE_DEFAULT;

    console.log("📦 Mengambil daftar produk ML dari TokoVoucher...");

    const response = await axios.get(
      `https://api.tokovoucher.net/produk/code`,
      {
        params: {
          member_code: TV_MEMBER_CODE,
          signature: signature,
          kode: "MLBB",
        },
      },
    );

    const hasil = response.data;
    console.log("📥 Response:", JSON.stringify(hasil).substring(0, 200));

    if (!hasil || (hasil.status !== 1 && hasil.status !== "1")) {
      return res.status(500).json({
        status: "error",
        pesan: "Gagal ambil produk dari TokoVoucher",
        detail: hasil,
      });
    }

    // Filter hanya yang status aktif
    const produkAktif = hasil.data.filter(
      (p) => p.status === 1 || p.status === "1",
    );

    // Map dan hitung harga jual
    const produkFormatted = produkAktif.map((p) => {
      const hargaModal = parseInt(p.price || 0);
      const hargaJual = hitungHargaJual(hargaModal);

      return {
        kode: p.code,
        nama: p.nama_produk,
        hargaModal: hargaModal,
        hargaJual: hargaJual,
        hargaJualFormat: formatRupiah(hargaJual),
        status: p.status,
      };
    });

    // Urutkan dari harga terendah
    produkFormatted.sort((a, b) => a.hargaJual - b.hargaJual);

    console.log(`✅ Berhasil ambil ${produkFormatted.length} produk ML aktif`);
    res.json({
      status: "sukses",
      total: produkFormatted.length,
      margin: `${MARGIN_PERSEN}%`,
      data: produkFormatted,
    });
  } catch (error) {
    console.error("❌ Error ambil produk ML:", error.message);
    res.status(500).json({
      status: "error",
      pesan: "Gagal menghubungi TokoVoucher: " + error.message,
    });
  }
});

// ==========================================
// NYALAIN SERVER
// ==========================================
module.exports = app;
