const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const DATA_PATH = path.join(__dirname, 'pins', 'pins.json');
const LOGS_PATH = path.join(__dirname, 'pins', 'scanLogs.json');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Helper to read/write data
function readPins() {
    if (!fs.existsSync(DATA_PATH)) {
        return { pins: {} };
    }
    try {
        return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    } catch (e) {
        return { pins: {} };
    }
}

function writePins(data) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function readLogs() {
    if (!fs.existsSync(LOGS_PATH)) {
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(LOGS_PATH, 'utf8'));
    } catch (e) {
        return [];
    }
}

function writeLogs(data) {
    fs.writeFileSync(LOGS_PATH, JSON.stringify(data, null, 2));
}

// Stats API (Count only UNBOUND and UNEXPIRED pins for stock levels)
app.get('/api/stats', (req, res) => {
    const data = readPins();
    const pins = Object.values(data.pins || {});
    const now = new Date();
    
    const stats = {
        lifetime: pins.filter(p => p.type === 'Lifetime' && !p.hwid && (!p.expiresAt || new Date(p.expiresAt) > now)).length,
        monthly: pins.filter(p => p.type === '1 Month' && !p.hwid && (!p.expiresAt || new Date(p.expiresAt) > now)).length,
        yearly: pins.filter(p => p.type === '1 Year' && !p.hwid && (!p.expiresAt || new Date(p.expiresAt) > now)).length
    };
    res.json(stats);
});

// Member Dashboard Login (using MAK Key)
app.post('/api/member-login', (req, res) => {
    const { pin, browserFingerprint } = req.body;
    const data = readPins();
    const now = new Date();

    if (!data.pins[pin]) {
        return res.json({ valid: false, message: 'Invalid Key' });
    }

    const pinData = data.pins[pin];

    // Check Expiry
    if (pinData.expiresAt && new Date(pinData.expiresAt) < now) {
        return res.json({ valid: false, message: 'Key Expired (10-hour limit reached)' });
    }

    // If already bound to an HWID, check if it matches
    if (pinData.hwid && pinData.hwid !== browserFingerprint) {
        return res.json({ valid: false, message: 'Key already bound to another device' });
    }

    // Bind now if first use
    if (!pinData.hwid) {
        pinData.hwid = browserFingerprint || 'WEB-SESSION-' + Date.now();
        pinData.used = true;
        writePins(data);
    }

    res.json({ valid: true, pin: pinData });
});

// API to create a pin
app.post('/api/create-pin', (req, res) => {
    const { type } = req.body; 
    const digits = '0123456789';
    let pin = 'MAK-';
    for (let i = 0; i < 11; i++) {
        pin += digits.charAt(Math.floor(Math.random() * digits.length));
    }
    
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 60 * 1000); // 10 Hours from now

    const data = readPins();
    data.pins[pin] = { 
        pin,
        type: type || 'Lifetime',
        created: now.toISOString(), 
        expiresAt: expiresAt.toISOString(),
        status: 'PENDING',
        used: false,
        hwid: null
    };
    writePins(data);
    res.json({ pin });
});

// Scanner Verification
app.post('/api/verify-pin', (req, res) => {
    const { pin, hwid } = req.body;
    const data = readPins();
    const now = new Date();
    
    if (data.pins[pin]) {
        const pinData = data.pins[pin];

        // Check Expiry
        if (pinData.expiresAt && new Date(pinData.expiresAt) < now) {
            return res.json({ valid: false, message: 'Key Expired' });
        }

        if (!pinData.hwid) {
            pinData.hwid = hwid;
            pinData.used = true;
            writePins(data);
        } else if (pinData.hwid !== hwid) {
            return res.json({ valid: false, message: 'HWID Mismatch' });
        }
        res.json({ valid: true });
    } else {
        res.json({ valid: false, message: 'Invalid PIN' });
    }
});

// Backward compatibility (Legacy GET verify)
app.get('/api/verify-pin/:pin', (req, res) => {
    const data = readPins();
    const pin = req.params.pin;
    if (data.pins[pin]) {
        res.json({ valid: true });
    } else {
        res.json({ valid: false });
    }
});

// API to get all pins
app.get('/api/pins', (req, res) => {
    const data = readPins();
    res.json(Object.values(data.pins).reverse());
});

// API for the scanner to submit results
app.post('/api/report', (req, res) => {
    const { pin, status, details, files, pcInfo } = req.body;
    const pinsData = readPins();
    const logsData = readLogs();
    
    const logEntry = {
        id: Date.now(),
        pin,
        status,
        details,
        files,
        pcInfo,
        timestamp: new Date().toISOString()
    };
    
    logsData.push(logEntry);
    writeLogs(logsData);
    
    // Update pin status if it exists
    if (pinsData.pins[pin]) {
        pinsData.pins[pin].status = 'FINISHED';
        pinsData.pins[pin].used = true;
    }
    
    writePins(pinsData);
    io.emit('new-log', logEntry);
    res.json({ success: true });
});

app.get('/api/logs', (req, res) => {
    const data = readLogs();
    res.json(data);
});

// Specific pin route (serves the actual .exe)
app.get('/:pin', (req, res) => {
    const pin = req.params.pin;
    const data = readPins();
    
    if (!data.pins[pin] && !/^MAK-\d{11}$/.test(pin)) {
        return res.status(404).send('Geçersiz PİN.');
    }
    
    const exePath = path.join(__dirname, '../dist/SCANNE-win32-x64/SCANNE.exe');
    
    if (fs.existsSync(exePath)) {
        res.download(exePath, `SCANNE_${pin}.exe`);
    } else {
        res.status(500).send('Hata: Build dosyası bulunamadı. Lütfen önce build işlemini kontrol edin.');
    }
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
