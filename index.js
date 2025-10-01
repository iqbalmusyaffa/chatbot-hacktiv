import 'dotenv/config';
import express from 'express';
import multer from 'multer';
// 1. PENINGKATAN: Destrukturisasi GoogleGenAI untuk import yang lebih bersih
import { GoogleGenAI } from "@google/genai";
import * as fs from 'fs/promises'; // Import fs/promises untuk penanganan/pembersihan file

const app = express();

// 2. PENINGKATAN: Mendefinisikan konstanta untuk batas ukuran file inline (4MB dalam byte)
const MAX_UKURAN_FILE_INLINE = 4 * 1024 * 1024; // 4MB

// --- Konfigurasi Multer ---
// Kita menggunakan memory storage agar file disimpan dalam buffer (req.file.buffer)
// Ini cocok untuk file kecil-menengah (seperti gambar atau PDF kecil) yang akan dikirim secara inline.
const upload = multer({ storage: multer.memoryStorage() });

// --- Inisialisasi GoogleGenAI ---
// Klien akan secara otomatis mencari kunci API di variabel lingkungan (process.env.GEMINI_API_KEY atau process.env.API_KEY)
// 3. PENINGKATAN: Tidak perlu meneruskan { apiKey: process.env.API_KEY } jika menggunakan dotenv/config
const ai = new GoogleGenAI({});

// **Tetapkan model Gemini default Anda di sini:**
const GEMINI_MODEL = "gemini-2.5-flash"; // Cocok untuk tugas teks dan multimodal

app.use(express.json());

// ====================================================================
// FUNGSI UTILITAS GEMINI
// ====================================================================

/**
 * Mengekstrak teks yang dihasilkan dengan aman dari berbagai struktur respons API Gemini.
 * @param {object} resp - Objek respons mentah dari panggilan API Gemini.
 * @returns {string} Teks yang diekstrak atau JSON string dari respons lengkap saat terjadi kesalahan/fallback.
 */
function ekstrakTeks(resp) {
  try {
    const text =
      resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ??
      resp?.candidates?.[0]?.content?.parts?.[0]?.text ??
      resp?.response?.text;

    if (text) {
      return text;
    }

    // Fallback: Jika tidak ditemukan teks sederhana, kembalikan respons lengkap sebagai JSON string
    return "Kesalahan: Tidak dapat mengekstrak teks. Respons lengkap di bawah ini:\n" + JSON.stringify(resp, null, 2);
  } catch (error) {
    console.error("Kesalahan saat mengekstrak teks:", error);
    return "Kesalahan ekstraksi. Respons lengkap di bawah ini:\n" + JSON.stringify(resp, null, 2);
  }
}

/**
 * Mengkonversi buffer file Multer menjadi objek GenerativePart API Gemini untuk data inline.
 * Ini digunakan untuk mengirim gambar atau file kecil langsung dalam permintaan.
 * @param {Buffer} buffer - Buffer file dari Multer (req.file.buffer).
 * @param {string} tipeMIME - Tipe MIME file (req.file.mimetype).
 * @returns {object} Objek GenerativePart yang cocok untuk array `contents` API Gemini.
 */
function fileKeGenerativePart(buffer, tipeMIME) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType: tipeMIME,
    },
  };
}

// ====================================================================
// RUTE API
// ====================================================================

// 1. Endpoint Pembuatan Teks Sederhana
/**
 * Endpoint POST untuk menangani pembuatan teks-saja yang sederhana.
 * Penggunaan: Kirim permintaan POST ke endpoint ini dengan body JSON: { "prompt": "Permintaan teks Anda" }
 */
app.post('/generate-text', async (req, res) => {
    try {
        const { prompt } = req.body;

        if (!prompt) {
            return res.status(400).json({ error: 'Kolom "prompt" wajib diisi.' });
        }

        console.log('Memanggil API Gemini untuk pembuatan teks...');
        // 4. PENINGKATAN: Gunakan const untuk deklarasi fungsi async di dalam rute
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt, // Prompt teks sederhana
        });

        res.json({ result: ekstrakTeks(resp) });

    } catch (err) {
        console.error('Kesalahan API:', err);
        // Lebih aman untuk hanya mengekspos pesan kesalahan dan bukan seluruh objek kesalahan
        res.status(500).json({ error: err.message || 'Terjadi kesalahan server internal.' });
    }
});


// 2. Endpoint Pembuatan Multimodal (Teks + File Opsional)
/**
 * Endpoint POST untuk menangani pembuatan multimodal (teks + file opsional).
 * Penggunaan: Kirim permintaan POST ke endpoint ini dengan body multipart/form-data.
 * - 'prompt': Instruksi teks untuk model.
 * - 'file': File opsional (gambar, PDF, dll.) untuk dianalisis.
 */
app.post('/gemini/generate', upload.single('file'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const uploadedFile = req.file;

        if (!prompt) {
            return res.status(400).json({ error: 'Kolom "prompt" wajib diisi.' });
        }

        let contents = [];

        // 1. Tangani File (jika ada)
        if (uploadedFile) {
            console.log(`Memproses file: ${uploadedFile.originalname}, MIME: ${uploadedFile.mimetype}`);
            
            // Periksa apakah file cukup kecil untuk dikirim secara inline
            if (uploadedFile.size > MAX_UKURAN_FILE_INLINE) {
                // 5. PENINGKATAN: Gunakan konstanta dan perjelas pesan kesalahan
                return res.status(400).json({ 
                    error: `File terlalu besar (${uploadedFile.size} bytes). Ukuran maksimal untuk upload inline adalah ${MAX_UKURAN_FILE_INLINE} bytes (4MB).` 
                });
            }

            // Konversi buffer ke GenerativePart inline
            const filePart = fileKeGenerativePart(uploadedFile.buffer, uploadedFile.mimetype);
            contents.push(filePart);
        }

        // 2. Tambahkan Prompt Teks
        // Bungkus prompt dalam objek untuk mempertahankan struktur 'contents' sebagai array bagian
        contents.push({ text: prompt });

        // 3. Panggil API Gemini
        console.log('Memanggil API Gemini...');
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents,
        });

        // 4. Ekstrak dan Kirim Respons
        const extractedText = ekstrakTeks(result);
        res.json({ response: extractedText });

    } catch (error) {
        console.error('Kesalahan API:', error);
        res.status(500).json({ error: 'Terjadi kesalahan server internal saat memproses permintaan.' });
    }
});


// 3. Endpoint Khusus Gambar
/**
 * Endpoint POST untuk menangani analisis gambar (teks + gambar).
 * Penggunaan: Kirim permintaan POST dengan multipart/form-data.
 * - 'prompt': Pertanyaan tentang gambar.
 * - 'image': File gambar.
 */
app.post('/generate-from-image', upload.single('image'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const uploadedFile = req.file;

        if (!uploadedFile) {
            return res.status(400).json({ error: 'File gambar bernama "image" wajib diisi.' });
        }
        if (!prompt) {
            // Catatan: Prompt seringkali opsional untuk image-to-text, 
            // tetapi mewajibkannya menyederhanakan alur berdasarkan penggunaan umum.
            return res.status(400).json({ error: 'Kolom "prompt" wajib diisi.' });
        }
        
        console.log(`Memproses gambar: ${uploadedFile.originalname}, MIME: ${uploadedFile.mimetype}`);
        
        // Periksa ukuran file menggunakan konstanta yang sudah ada
        if (uploadedFile.size > MAX_UKURAN_FILE_INLINE) {
            return res.status(400).json({ 
                error: `File terlalu besar (${uploadedFile.size} bytes). Ukuran maksimal untuk upload inline adalah ${MAX_UKURAN_FILE_INLINE} bytes (4MB).` 
            });
        }

        // Konversi buffer ke GenerativePart inline
        const imagePart = fileKeGenerativePart(uploadedFile.buffer, uploadedFile.mimetype);

        // Array contents menggabungkan prompt teks dan gambar
        const contents = [
            imagePart,
            { text: prompt }
        ];

        // Panggil API Gemini
        console.log('Memanggil API Gemini untuk analisis gambar...');
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents,
        });

        // Ekstrak dan Kirim Respons
        res.json({ result: ekstrakTeks(resp) });

    } catch (err) {
        console.error('Kesalahan API:', err);
        // Kembalikan pesan kesalahan yang bersih
        res.status(500).json({ error: err.message || 'Terjadi kesalahan server internal selama pembuatan gambar.' });
    }
});

// 4. Endpoint Khusus Dokumen
/**
 * Endpoint POST untuk menangani ringkasan/analisis dokumen (teks + dokumen).
 * Penggunaan: Kirim permintaan POST dengan multipart/form-data.
 * - 'prompt': Pertanyaan/instruksi tambahan tentang dokumen (opsional).
 * - 'document': File dokumen (misalnya PDF, TXT, DOCX).
 */
app.post('/generate-from-document', upload.single('document'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const uploadedFile = req.file;

        if (!uploadedFile) {
            return res.status(400).json({ error: 'File dokumen bernama "document" wajib diisi.' });
        }
        
        console.log(`Memproses dokumen: ${uploadedFile.originalname}, MIME: ${uploadedFile.mimetype}`);
        
        // Periksa ukuran file menggunakan konstanta yang sudah ada
        if (uploadedFile.size > MAX_UKURAN_FILE_INLINE) {
            return res.status(400).json({ 
                error: `File terlalu besar (${uploadedFile.size} bytes). Ukuran maksimal untuk upload inline adalah ${MAX_UKURAN_FILE_INLINE} bytes (4MB).` 
            });
        }

        // Konversi buffer ke GenerativePart inline
        const documentPart = fileKeGenerativePart(uploadedFile.buffer, uploadedFile.mimetype);

        // **Perubahan Kunci:** Terapkan awalan untuk ringkasan.
        const summaryPrefix = "Ringkas dokumen berikut: "; 
        const fullPrompt = summaryPrefix + (prompt || ""); // Tambahkan prompt pengguna (jika ada)

        // Array contents menggabungkan bagian dokumen dan prompt akhir
        const contents = [
            documentPart,
            { text: fullPrompt }
        ];

        // Panggil API Gemini
        console.log('Memanggil API Gemini untuk analisis dokumen...');
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents,
        });

        // Ekstrak dan Kirim Respons
        res.json({ result: ekstrakTeks(resp) });

    } catch (err) {
        console.error('Kesalahan API:', err);
        // Kembalikan pesan kesalahan yang bersih
        res.status(500).json({ error: err.message || 'Terjadi kesalahan server internal selama pemrosesan dokumen.' });
    }
});

// 5. Endpoint Khusus Audio
/**
 * Endpoint POST untuk menangani transkripsi/analisis audio (teks + audio).
 * Penggunaan: Kirim permintaan POST dengan multipart/form-data.
 * - 'prompt': Pertanyaan/instruksi tambahan tentang audio (opsional).
 * - 'audio': File audio.
 */
app.post('/generate-from-audio', upload.single('audio'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const uploadedFile = req.file;

        if (!uploadedFile) {
            return res.status(400).json({ error: 'File audio bernama "audio" wajib diisi.' });
        }
        
        console.log(`Memproses audio: ${uploadedFile.originalname}, MIME: ${uploadedFile.mimetype}`);
        
        // Periksa ukuran file menggunakan konstanta yang sudah ada
        // Catatan: Untuk audio panjang, batas inline 4MB akan cepat tercapai. 
        // Untuk produksi, File API (ai.files.upload) harus digunakan untuk audio/video besar.
        if (uploadedFile.size > MAX_UKURAN_FILE_INLINE) {
            return res.status(400).json({ 
                error: `File terlalu besar (${uploadedFile.size} bytes). Ukuran maksimal untuk upload inline adalah ${MAX_UKURAN_FILE_INLINE} bytes (4MB). Harap gunakan File API untuk file yang lebih besar.` 
            });
        }

        // Konversi buffer ke GenerativePart inline
        const audioPart = fileKeGenerativePart(uploadedFile.buffer, uploadedFile.mimetype);

        // **Perubahan Kunci:** Terapkan awalan untuk transkripsi.
        const transcriptionPrefix = "Transkrip audio berikut: "; 
        const fullPrompt = transcriptionPrefix + (prompt || ""); // Tambahkan prompt pengguna (jika ada)

        // Array contents menggabungkan bagian audio dan prompt akhir
        const contents = [
            audioPart,
            { text: fullPrompt }
        ];

        // Panggil API Gemini
        console.log('Memanggil API Gemini untuk analisis audio...');
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents,
        });

        // Ekstrak dan Kirim Respons
        res.json({ result: ekstrakTeks(resp) });

    } catch (err) {
        console.error('Kesalahan API:', err);
        // Kembalikan pesan kesalahan yang bersih
        res.status(500).json({ error: err.message || 'Terjadi kesalahan server internal selama pemrosesan audio.' });
    }
});

// ====================================================================
// MULAI SERVER
// ====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server siap di http://localhost:${PORT}`));