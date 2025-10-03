import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { GoogleGenAI } from "@google/genai";
import * as fs from 'fs/promises'; 
import * as os from 'os'; // Diperlukan untuk direktori sementara

const app = express();

// --- Konfigurasi Konstanta ---
const MAX_UKURAN_FILE_INLINE = 4 * 1024 * 1024; // 4MB
const MAX_UKURAN_FILE_GEMINI_API = 2 * 1024 * 1024 * 1024; // 2GB (Batas File API)
const GEMINI_MODEL = "gemini-2.5-flash"; // Model untuk teks dan multimodal

// --- Konfigurasi Multer ---
// Menggunakan memoryStorage karena kita akan menangani file di memori 
// atau menulisnya ke temp disk secara manual untuk diunggah ke Gemini File API
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UKURAN_FILE_GEMINI_API } // Batas besar di Multer
});

// --- Inisialisasi GoogleGenAI ---
const ai = new GoogleGenAI({});

app.use(express.json());

// Middleware untuk menyajikan file frontend
app.use(express.static('public')); 

// ====================================================================
// FUNGSI UTILITAS GEMINI
// ====================================================================

/**
 * Mengekstrak teks yang dihasilkan dengan aman dari berbagai struktur respons API Gemini.
 */
function ekstrakTeks(resp) {
    try {
        const text =
            resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ??
            resp?.candidates?.[0]?.content?.parts?.[0]?.text ??
            resp?.response?.text;

        return text || "Kesalahan: Tidak dapat mengekstrak teks. Respons lengkap di bawah ini:\n" + JSON.stringify(resp, null, 2);
    } catch (error) {
        return "Kesalahan ekstraksi. Respons lengkap di bawah ini:\n" + JSON.stringify(resp, null, 2);
    }
}

/**
 * Mengkonversi buffer file Multer menjadi objek GenerativePart API Gemini untuk data inline.
 */
function fileKeGenerativePart(buffer, tipeMIME) {
    return {
        inlineData: {
            data: buffer.toString("base64"),
            mimeType: tipeMIME,
        },
    };
}

/**
 * Mengkonversi array riwayat percakapan sederhana dari frontend 
 * menjadi format 'contents' API Gemini.
 */
function konversiRiwayat(history) {
    // Gemini API menggunakan peran 'user' dan 'model'
    return history.map(msg => ({
        role: msg.role,
        parts: [{ text: msg.text }]
    }));
}

/**
 * Mengunggah buffer file ke Gemini API menggunakan File API. 
 * Ini memungkinkan pemrosesan file yang lebih besar.
 * CATATAN: File yang diunggah ke Gemini harus dihapus secara eksplisit setelah selesai.
 *
 * @returns {object} Objek FileData dari Gemini.
 */
async function uploadFileKeGemini(buffer, tipeMIME, originalName) {
    const tempFilePath = os.tmpdir() + '/' + Date.now() + '-' + originalName.replace(/[^a-zA-Z0-9.]/g, '_');
    
    // Tulis ke file sementara untuk diunggah
    await fs.writeFile(tempFilePath, buffer);

    let uploadedFile;
    try {
        uploadedFile = await ai.files.upload({
            file: tempFilePath,
            mimeType: tipeMIME,
            displayName: originalName,
        });
        return uploadedFile;
    } finally {
        // Bersihkan file sementara di sistem lokal
        await fs.unlink(tempFilePath).catch(error => console.error("Gagal menghapus file sementara:", error));
    }
}

// ====================================================================
// RUTE API
// ====================================================================

// 1. Endpoint Pembuatan Teks Sederhana
app.post('/generate-text', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Kolom "prompt" wajib diisi.' });
        }
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt,
        });
        res.json({ result: ekstrakTeks(resp) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Terjadi kesalahan server internal.' });
    }
});


// 2. Endpoint Pembuatan Multimodal (Fleksibel: Inline atau File API)
app.post('/gemini/generate', upload.single('file'), async (req, res) => {
    let geminiFileToDelete = null; // Untuk melacak file yang perlu dihapus dari Gemini
    
    try {
        const { prompt } = req.body;
        const uploadedFile = req.file;

        if (!prompt && !uploadedFile) {
            return res.status(400).json({ success: false, error: 'Kolom "prompt" atau file wajib diisi.' });
        }

        let contents = [];

        // --- Tangani File ---
        if (uploadedFile) {
            let filePart;
            
            if (uploadedFile.size <= MAX_UKURAN_FILE_INLINE) {
                // File kecil (<= 4MB): Gunakan unggahan inline
                filePart = fileKeGenerativePart(uploadedFile.buffer, uploadedFile.mimetype);
                console.log(`File ${uploadedFile.originalname} diproses secara inline.`);
            } else if (uploadedFile.size > MAX_UKURAN_FILE_GEMINI_API) {
                 // File terlalu besar
                return res.status(400).json({ 
                    success: false,
                    error: `File terlalu besar (${uploadedFile.size} bytes). Ukuran maksimal yang didukung Gemini API adalah 2GB.` 
                });
            } else {
                // File besar (> 4MB): Gunakan Gemini File API
                const geminiFile = await uploadFileKeGemini(
                    uploadedFile.buffer, 
                    uploadedFile.mimetype, 
                    uploadedFile.originalname || 'uploaded_file'
                );
                
                // Simpan referensi untuk penghapusan
                geminiFileToDelete = geminiFile.name; 

                // Generative Part menggunakan URI file
                filePart = { fileData: { mimeType: geminiFile.mimeType, fileUri: geminiFile.uri } };
                console.log(`File ${uploadedFile.originalname} diunggah ke Gemini File API: ${geminiFile.uri}`);
            }
            contents.push(filePart);
        }

        // Tambahkan Prompt Teks
        contents.push({ text: prompt || "Describe or analyze the provided file." }); 

        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents,
        });

        const extractedText = ekstrakTeks(result);
        res.json({ success: true, response: extractedText }); 

    } catch (error) {
        console.error('Kesalahan API Multimodal:', error);
        res.status(500).json({ success: false, error: error.message || 'Terjadi kesalahan server internal saat memproses file.' });
    } finally {
        // Hapus file dari Gemini API jika File API digunakan
        if (geminiFileToDelete) {
            try {
                await ai.files.delete({ name: geminiFileToDelete });
                console.log(`File Gemini ${geminiFileToDelete} berhasil dihapus.`);
            } catch (cleanupError) {
                console.error(`Gagal menghapus file Gemini ${geminiFileToDelete}:`, cleanupError);
            }
        }
    }
});


// 3. Endpoint Khusus Gambar (Dipertahankan, menggunakan inline-upload)
app.post('/generate-from-image', upload.single('image'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const uploadedFile = req.file;

        if (!uploadedFile || !prompt) {
             return res.status(400).json({ error: 'File gambar dan prompt wajib diisi.' });
        }
        
        // Memastikan file tidak melebihi batas inline
        if (uploadedFile.size > MAX_UKURAN_FILE_INLINE) {
            return res.status(400).json({ error: `File terlalu besar. Maksimal 4MB.` });
        }

        const imagePart = fileKeGenerativePart(uploadedFile.buffer, uploadedFile.mimetype);
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: [imagePart, { text: prompt }],
        });
        res.json({ result: ekstrakTeks(resp) });

    } catch (err) {
        res.status(500).json({ error: err.message || 'Terjadi kesalahan server internal selama pembuatan gambar.' });
    }
});


// 6. Endpoint Obrolan Berkelanjutan (Hanya Teks)
app.post('/chat', async (req, res) => {
    try {
        const { conversation } = req.body; 
        if (!conversation || conversation.length === 0) {
            return res.status(400).json({ success: false, message: 'Riwayat percakapan wajib diisi.' });
        }

        const geminiContents = konversiRiwayat(conversation);
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: geminiContents,
        });

        const resultText = ekstrakTeks(resp);
        res.json({ success: true, data: resultText }); 
    } catch (err) {
        res.status(500).json({ success: false, message: err.message || 'Terjadi kesalahan server internal saat memproses obrolan.' });
    }
});


// ====================================================================
// MULAI SERVER
// ====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server siap di http://localhost:${PORT}`));