const form = document.getElementById('chat-form');
const input = document.getElementById('user-input');
const chatBox = document.getElementById('chat-box');

// Elemen Unggah File (UI)
const fileInput = document.getElementById('file-upload');
const fileInfo = document.getElementById('file-info');
const fileNameSpan = document.getElementById('file-name');
const removeFileBtn = document.getElementById('remove-file');

// Riwayat percakapan hanya untuk teks (Chat Berkelanjutan)
const conversationHistory = []; 

// --- Event Listeners untuk File Upload (Mengatur UI) ---

fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
        fileNameSpan.textContent = fileInput.files[0].name;
        fileInfo.classList.remove('d-none'); // Tampilkan info file
        input.placeholder = "Tambahkan instruksi untuk file ini...";
    } else {
        fileInfo.classList.add('d-none');
        input.placeholder = "Type your message or ask about a file...";
    }
});

removeFileBtn.addEventListener('click', () => {
    fileInput.value = ''; // Hapus file dari input
    fileInfo.classList.add('d-none');
    fileNameSpan.textContent = '';
    input.placeholder = "Type your message or ask about a file...";
});

// --- Fungsi Utama Submit (Logika Pengiriman Gabungan) ---

form.addEventListener('submit', async function (e) {
    e.preventDefault();

    const userMessage = input.value.trim();
    const uploadedFile = fileInput.files[0];
    
    // Periksa apakah ada pesan teks ATAU file
    if (!userMessage && !uploadedFile) return;

    // Nonaktifkan input dan tombol saat memproses
    input.disabled = true;
    form.querySelector('button').disabled = true;
    
    // 1. Tentukan apakah ini pesan Teks-saja atau Multimodal
    const isMultimodal = !!uploadedFile;
    
    let endpoint = isMultimodal ? '/gemini/generate' : '/chat';
    let requestBody;
    
    if (isMultimodal) {
        // --- LOGIKA MULTIMODAL (Mengirim file via FormData) ---
        const formData = new FormData();
        // Gunakan prompt pengguna atau instruksi default
        formData.append('prompt', userMessage || 'Describe or summarize this file.');
        formData.append('file', uploadedFile);
        requestBody = formData;
    } else {
        // --- LOGIKA CHAT BERKELANJUTAN (Mengirim riwayat via JSON) ---
        conversationHistory.push({ role: 'user', text: userMessage });
        requestBody = JSON.stringify({ conversation: conversationHistory });
    }

    // 2. Tampilkan pesan pengguna
    // Meneruskan file untuk ditampilkan di UI
    appendMessage('user', userMessage || `[File: ${uploadedFile.name}]`, uploadedFile);
    input.value = '';

    // 3. Tampilkan pesan "thinking"
    // thinkingMessageElement sekarang adalah kontainer pesan penuh (anak langsung dari chatBox)
    const thinkingMessageElement = appendMessage('bot', 'Gemini is thinking...');

    try {
        // 4. Kirim permintaan
        const fetchOptions = {
            method: 'POST',
        };

        if (isMultimodal) {
            // FormData tidak perlu Content-Type header
            fetchOptions.body = requestBody;
        } else {
            fetchOptions.headers = { 'Content-Type': 'application/json' };
            fetchOptions.body = requestBody;
        }
        
        const response = await fetch(endpoint, fetchOptions);
        
        const data = await response.json();
        const resultText = data.data || data.response || data.error || "Failed to get response.";

        // 5. Hapus pesan "thinking"
        // Berfungsi karena thinkingMessageElement mengembalikan msgContainer (anak langsung dari chatBox)
        chatBox.removeChild(thinkingMessageElement);

        if (response.ok && (data.success || data.response)) {
            // Sukses
            if (!isMultimodal) {
                // Tambahkan ke riwayat HANYA jika ini chat berkelanjutan
                conversationHistory.push({ role: 'model', text: resultText });
            }
            appendMessage('bot', resultText);
        } else {
            // Gagal
            if (!isMultimodal) conversationHistory.pop(); 
            appendMessage('bot', `Error: ${resultText}`);
        }
    } catch (error) {
        // Tangani kesalahan jaringan atau parsing
        chatBox.removeChild(thinkingMessageElement);
        if (!isMultimodal) conversationHistory.pop();
        console.error('Error sending message:', error);
        appendMessage('bot', 'Oops! Something went wrong. Please check the server and file size.');
    } finally {
        // Reset UI
        input.disabled = false;
        form.querySelector('button').disabled = false;
        input.focus();
        
        // Reset file input setelah mengirim
        fileInput.value = ''; 
        fileInfo.classList.add('d-none');
        input.placeholder = "Type your message or ask about a file...";
    }
});

/**
 * Fungsi yang dimodifikasi untuk menampilkan pesan dan file di chat box.
 * @param {string} sender - 'user' atau 'bot'.
 * @param {string} text - Pesan teks.
 * @param {File | null} [file=null] - Objek File yang diunggah.
 * @returns {HTMLElement} - Mengembalikan elemen kontainer pesan penuh (msgContainer).
 */
function appendMessage(sender, text, file = null) {
    // Kontainer utama (anak langsung dari chatBox)
    const msgContainer = document.createElement('div');
    msgContainer.classList.add('message-container', sender);
    
    // Gunakan kelas margin Bootstrap untuk perataan
    const marginClass = sender === 'user' ? 'ms-auto' : 'me-auto';
    msgContainer.classList.add('mb-2', marginClass);

    // 1. Tampilkan Pratinjau File (Hanya untuk pesan pengguna yang memiliki file)
    if (file && sender === 'user') {
        const fileDisplay = document.createElement('div');
        // Kelas CSS untuk styling pratinjau file
        fileDisplay.classList.add('file-display-preview', 'mb-2', 'p-2', 'border', 'rounded');
        
        if (file.type.startsWith('image/')) {
            // Tampilkan gambar
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.alt = `Uploaded Image: ${file.name}`;
            img.classList.add('img-fluid', 'rounded');
            fileDisplay.appendChild(img);
        } else {
            // Tampilkan ikon dan nama untuk file lain
            const icon = document.createElement('span');
            icon.textContent = '📄'; 
            icon.classList.add('me-2', 'fs-5');
            
            const fileName = document.createElement('span');
            fileName.textContent = file.name;
            
            fileDisplay.appendChild(icon);
            fileDisplay.appendChild(fileName);
        }
        
        msgContainer.appendChild(fileDisplay);
    }
    
    // 2. Tampilkan pesan teks
    const msgText = document.createElement('div');
    msgText.classList.add('message', 'p-2', 'rounded', 'shadow-sm');
    
    // Atur kelas Bootstrap untuk gaya gelembung
    if (sender === 'user') {
        msgText.classList.add('bg-primary', 'text-white');
    } else {
        msgText.classList.add('bg-light', 'text-dark', 'border');
    }

    // Gaya khusus untuk pesan "thinking"
    if (text === 'Gemini is thinking...') {
        msgText.classList.remove('p-2', 'shadow-sm', 'border');
        msgText.classList.add('p-1', 'fst-italic');
        msgText.textContent = text;
    } else {
        msgText.textContent = text;
    }

    msgContainer.appendChild(msgText);

    chatBox.appendChild(msgContainer);
    chatBox.scrollTop = chatBox.scrollHeight;
    
    // *** PERBAIKAN KRUSIAL: Kembalikan kontainer penuh (msgContainer)
    // Ini memperbaiki kesalahan NotFoundError.
    return msgContainer; 
}