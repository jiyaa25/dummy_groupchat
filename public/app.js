// The load balancer dynamically routes HTTP requests across SYS2/SYS3/SYS4.
// Use a single WebSocket connection so Socket.IO does not depend on sticky polling sessions.
const socket = io({
    transports: ["websocket"],
    upgrade: false
});

const homeScreen = document.getElementById("homeScreen");
const chatScreen = document.getElementById("chatScreen");
const usernameInput = document.getElementById("usernameInput");
const joinButton = document.getElementById("joinButton");
const messagesElement = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const participantCount = document.getElementById("participantCount");
const participantsList = document.getElementById("participantsList");
const participantsToggle = document.getElementById("participantsToggle");
const typingIndicator = document.getElementById("typingIndicator");
const displayMyName = document.getElementById("displayMyName");

let myUsername = "";
let privateKey = null;

async function generateKeys() {
    if (!window.crypto || !window.crypto.subtle) {
        throw new Error("WebCrypto not available. Ensure HTTPS is used.");
    }
    const keyPair = await window.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"]
    );
    privateKey = keyPair.privateKey;
    return await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
}

async function signMessage(text) {
    if (!privateKey) return "";
    const encoder = new TextEncoder();
    const sigBuffer = await window.crypto.subtle.sign(
        { name: "ECDSA", hash: { name: "SHA-256" } },
        privateKey,
        encoder.encode(text)
    );
    return Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

joinButton.addEventListener("click", async () => {
    const name = usernameInput.value.trim();
    if (!name) return;
    
    joinButton.disabled = true;
    joinButton.textContent = "Connecting...";

    try {
        let publicKey = null;
        try {
            publicKey = await generateKeys();
        } catch (e) {
            console.warn("Crypto key generation fallback:", e);
        }
        myUsername = name;
        socket.emit("join_room", { username: name, publicKey });
    } catch (e) {
        alert("Connection Error: " + e.message);
        joinButton.disabled = false;
        joinButton.textContent = "Join Room";
    }
});

socket.on("room_joined", (data) => {
    homeScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    displayMyName.textContent = `You: ${myUsername}`;
    updateParticipantsUI(data.users, data.capacity);
});

socket.on("room_error", (msg) => {
    alert(msg);
    joinButton.disabled = false;
    joinButton.textContent = "Join Room";
});

socket.on("system_log", (text) => addSystemMessage(text));
socket.on("chat_message", (data) => renderMessage(data));

socket.on("message_history", (history) => {
    if (history && history.length > 0) {
        addSystemMessage("--- Past Messages (Shared DB) ---");
        history.forEach(msg => renderMessage(msg));
        addSystemMessage("--- New Messages ---");
    }
});

socket.on("room_users_update", (data) => {
    if (data && data.users) {
        updateParticipantsUI(data.users, data.capacity || 4);
    }
});

sendButton.addEventListener("click", sendMessage);
messageInput.addEventListener("keypress", (e) => { if (e.key === "Enter") sendMessage(); });

async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;
    
    let signature = "";
    try {
        signature = await signMessage(text);
    } catch (e) {
        console.warn("Signature error:", e);
    }

    const messageId = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : "msg-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);

    socket.emit("chat_message", { 
        message: text, 
        signature: signature,
        message_id: messageId 
    });
    messageInput.value = "";
}

function renderMessage(data) {
    const isMine = data.username === myUsername;
    const div = document.createElement("div");
    div.className = `message ${isMine ? "mine" : "other"}`;
    
    const time = data.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const status = data.verified 
        ? `<span style="color:#28a745; font-size:9px; font-weight:bold; margin-left:8px;">✓ Verified</span>` 
        : `<span style="color:#dc3545; font-size:9px; font-weight:bold; margin-left:8px;">✗ Unverified</span>`;
    
    const msgIdHtml = data.message_id 
        ? `<span style="font-size:8px; opacity:0.4; margin-left:6px;" title="${data.message_id}">[#${data.message_id.slice(0, 6)}]</span>` 
        : "";

    div.innerHTML = `
        <div class="message-header">
            ${isMine ? "You" : data.username} 
            <span style="font-size:10px; opacity:0.6">${time}</span>
            ${status}
            ${msgIdHtml}
        </div>
        <div class="message-text">${escapeHtml(data.message)}</div>
    `;
    messagesElement.appendChild(div);
    messagesElement.scrollTop = messagesElement.scrollHeight;
}

function updateParticipantsUI(users, capacity) {
    participantCount.textContent = `${users.length}/${capacity}`;
    participantsList.innerHTML = users.map(u => `<div class="participant">● ${escapeHtml(u)} ${u === myUsername ? "(You)" : ""}</div>`).join("");
}

function addSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "system-message";
    div.textContent = text;
    messagesElement.appendChild(div);
    messagesElement.scrollTop = messagesElement.scrollHeight;
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
