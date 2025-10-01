import 'dotenv/config';
import express from 'express';
import multer from 'multer';
// 1. IMPROVEMENT: Destructure GoogleGenAI for cleaner import
import { GoogleGenAI } from "@google/genai";
import * as fs from 'fs/promises'; // Import fs/promises for potential file handling/cleanup

const app = express();

// 2. IMPROVEMENT: Define a constant for the inline file size limit (4MB in bytes)
const MAX_INLINE_FILE_SIZE = 4 * 1024 * 1024; // 4MB

// --- Multer Configuration ---
// We use memory storage so the file is stored in a buffer (req.file.buffer)
// This is suitable for small-to-medium files (like images or small PDFs) to be sent inline.
const upload = multer({ storage: multer.memoryStorage() });

// --- GoogleGenAI Initialization ---
// The client will automatically look for the API key in the environment variables (process.env.GEMINI_API_KEY or process.env.API_KEY)
// 3. IMPROVEMENT: No need to pass { apiKey: process.env.API_KEY } if using dotenv/config
const ai = new GoogleGenAI({});

// **Set your default Gemini model here:**
const GEMINI_MODEL = "gemini-2.5-flash"; // Suitable for text and multimodal tasks

app.use(express.json());

// ====================================================================
// GEMINI UTILITY FUNCTIONS
// ====================================================================

/**
 * Safely extracts the generated text from various Gemini API response structures.
 * This is based on the logic you provided in the image.
 * @param {object} resp - The raw response object from a Gemini API call.
 * @returns {string} The extracted text or a stringified JSON of the full response on error/fallback.
 */
function extractText(resp) {
  try {
    const text =
      resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text ??
      resp?.candidates?.[0]?.content?.parts?.[0]?.text ??
      resp?.response?.text;

    if (text) {
      return text;
    }

    // Fallback: If no simple text is found, return the full response as a JSON string
    return "Error: Could not extract text. Full response below:\n" + JSON.stringify(resp, null, 2);
  } catch (error) {
    console.error("Error extracting text:", error);
    return "Extraction error. Full response below:\n" + JSON.stringify(resp, null, 2);
  }
}

/**
 * Converts a Multer file buffer into a Gemini API GenerativePart object for inline data.
 * This is used for sending small images or files directly in the request.
 * @param {Buffer} buffer - The file buffer from Multer (req.file.buffer).
 * @param {string} mimeType - The MIME type of the file (req.file.mimetype).
 * @returns {object} A GenerativePart object suitable for the Gemini API `contents` array.
 */
function fileToGenerativePart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType,
    },
  };
}

// ====================================================================
// API ROUTES
// ====================================================================

// 1. Simple Text Generation Endpoint
/**
 * POST endpoint to handle simple text-only generation.
 * Usage: Send a POST request to this endpoint with a JSON body: { "prompt": "Your text query" }
 */
app.post('/generate-text', async (req, res) => {
    try {
        const { prompt } = req.body;

        if (!prompt) {
            return res.status(400).json({ error: 'The "prompt" field is required.' });
        }

        console.log('Calling Gemini API for text generation...');
        // 4. IMPROVEMENT: Use const for the async function declaration within the route
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt, // Simple text prompt
        });

        res.json({ result: extractText(resp) });

    } catch (err) {
        console.error('API Error:', err);
        // It's safer to only expose the error message and not the entire error object
        res.status(500).json({ error: err.message || 'An internal server error occurred.' });
    }
});


// 2. Multimodal Generation Endpoint (Text + Optional File)
/**
 * POST endpoint to handle multimodal generation (text + optional file).
 * Usage: Send a POST request to this endpoint with a multipart/form-data body.
 * - 'prompt': The text instruction for the model.
 * - 'file': The optional file (image, PDF, etc.) to analyze.
 */
app.post('/gemini/generate', upload.single('file'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const uploadedFile = req.file;

        if (!prompt) {
            return res.status(400).json({ error: 'The "prompt" field is required.' });
        }

        let contents = [];

        // 1. Handle File (if present)
        if (uploadedFile) {
            console.log(`Processing file: ${uploadedFile.originalname}, MIME: ${uploadedFile.mimetype}`);
            
            // Check if the file is small enough to be sent inline
            if (uploadedFile.size > MAX_INLINE_FILE_SIZE) {
                // 5. IMPROVEMENT: Use the constant and clarify the error message
                return res.status(400).json({ 
                    error: `File is too large (${uploadedFile.size} bytes). Max size for inline upload is ${MAX_INLINE_FILE_SIZE} bytes (4MB).` 
                });
            }

            // Convert the buffer to an inline GenerativePart
            const filePart = fileToGenerativePart(uploadedFile.buffer, uploadedFile.mimetype);
            contents.push(filePart);
        }

        // 2. Add Text Prompt
        // Wrap the prompt in an object to maintain the 'contents' structure as an array of parts
        contents.push({ text: prompt });

        // 3. Call the Gemini API
        console.log('Calling Gemini API...');
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents,
        });

        // 4. Extract and Send Response
        const extractedText = extractText(result);
        res.json({ response: extractedText });

    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'An internal server error occurred while processing the request.' });
    }
});
app.post('/generate-from-image', upload.single('image'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const uploadedFile = req.file;

        if (!uploadedFile) {
            return res.status(400).json({ error: 'An image file named "image" is required.' });
        }
        if (!prompt) {
            // Note: The prompt is often optional for image-to-text, 
            // but requiring it simplifies the flow based on typical usage.
            return res.status(400).json({ error: 'The "prompt" field is required.' });
        }
        
        console.log(`Processing image: ${uploadedFile.originalname}, MIME: ${uploadedFile.mimetype}`);
        
        // Check file size using the existing constant
        if (uploadedFile.size > MAX_INLINE_FILE_SIZE) {
            return res.status(400).json({ 
                error: `File is too large (${uploadedFile.size} bytes). Max size for inline upload is ${MAX_INLINE_FILE_SIZE} bytes (4MB).` 
            });
        }

        // Convert the buffer to an inline GenerativePart
        const imagePart = fileToGenerativePart(uploadedFile.buffer, uploadedFile.mimetype);

        // The contents array puts the text prompt and the image together
        const contents = [
            imagePart,
            { text: prompt }
        ];

        // Call the Gemini API
        console.log('Calling Gemini API for image analysis...');
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents,
        });

        // Extract and Send Response
        res.json({ result: extractText(resp) });

    } catch (err) {
        console.error('API Error:', err);
        // Return a clean error message
        res.status(500).json({ error: err.message || 'An internal server error occurred during image generation.' });
    }
});
app.post('/generate-from-document', upload.single('document'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const uploadedFile = req.file;

        if (!uploadedFile) {
            return res.status(400).json({ error: 'A document file named "document" is required.' });
        }
        
        console.log(`Processing document: ${uploadedFile.originalname}, MIME: ${uploadedFile.mimetype}`);
        
        // Check file size using the existing constant
        if (uploadedFile.size > MAX_INLINE_FILE_SIZE) {
            return res.status(400).json({ 
                error: `File is too large (${uploadedFile.size} bytes). Max size for inline upload is ${MAX_INLINE_FILE_SIZE} bytes (4MB).` 
            });
        }

        // Convert the buffer to an inline GenerativePart
        const documentPart = fileToGenerativePart(uploadedFile.buffer, uploadedFile.mimetype);

        // **Key change based on the slide:** Apply a prefix for summarization.
        const summaryPrefix = "Ringkas dokumen berikut: "; 
        const fullPrompt = summaryPrefix + (prompt || ""); // Append user's prompt (if any)

        // The contents array puts the document part and the final prompt together
        const contents = [
            documentPart,
            { text: fullPrompt }
        ];

        // Call the Gemini API
        console.log('Calling Gemini API for document analysis...');
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents,
        });

        // Extract and Send Response
        res.json({ result: extractText(resp) });

    } catch (err) {
        console.error('API Error:', err);
        // Return a clean error message
        res.status(500).json({ error: err.message || 'An internal server error occurred during document processing.' });
    }
});
app.post('/generate-from-audio', upload.single('audio'), async (req, res) => {
    try {
        const { prompt } = req.body;
        const uploadedFile = req.file;

        if (!uploadedFile) {
            return res.status(400).json({ error: 'An audio file named "audio" is required.' });
        }
        
        console.log(`Processing audio: ${uploadedFile.originalname}, MIME: ${uploadedFile.mimetype}`);
        
        // Check file size using the existing constant
        // Note: For long audio, the 4MB inline limit will be hit quickly. 
        // For production, the File API (ai.files.upload) must be used for large audio/video.
        if (uploadedFile.size > MAX_INLINE_FILE_SIZE) {
            return res.status(400).json({ 
                error: `File is too large (${uploadedFile.size} bytes). Max size for inline upload is ${MAX_INLINE_FILE_SIZE} bytes (4MB). Please use the File API for larger files.` 
            });
        }

        // Convert the buffer to an inline GenerativePart
        const audioPart = fileToGenerativePart(uploadedFile.buffer, uploadedFile.mimetype);

        // **Key change based on the slide:** Apply a prefix for transcription.
        const transcriptionPrefix = "Transkrip audio berikut: "; 
        const fullPrompt = transcriptionPrefix + (prompt || ""); // Append user's prompt (if any)

        // The contents array puts the audio part and the final prompt together
        const contents = [
            audioPart,
            { text: fullPrompt }
        ];

        // Call the Gemini API
        console.log('Calling Gemini API for audio analysis...');
        const resp = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents,
        });

        // Extract and Send Response
        res.json({ result: extractText(resp) });

    } catch (err) {
        console.error('API Error:', err);
        // Return a clean error message
        res.status(500).json({ error: err.message || 'An internal server error occurred during audio processing.' });
    }
});

// ====================================================================
// START SERVER
// ====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ready on http://localhost:${PORT}`));