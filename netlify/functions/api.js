// ============================================================
// BAT>EXE API - Netlify Function
// ============================================================

const { Redis } = require('@upstash/redis');

// ---------- VALIDASI ENVIRONMENT ----------
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('❌ Environment variables UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required.');
}

// ---------- INISIALISASI REDIS ----------
let redis = null;
try {
  if (REDIS_URL && REDIS_TOKEN) {
    redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
    console.log('✅ Redis client initialized.');
  }
} catch (err) {
  console.error('❌ Failed to initialize Redis:', err.message);
}

// ---------- HELPER ----------
async function getLocation(ip) {
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1') {
    return { country: 'Unknown', region: 'Unknown', city: 'Unknown' };
  }
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`);
    const data = await res.json();
    if (data.status === 'success') {
      return { country: data.country, region: data.regionName, city: data.city };
    }
  } catch (_) {}
  return { country: 'Unknown', region: 'Unknown', city: 'Unknown' };
}

function generateInvoiceId() {
  return 'INV-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

// ---------- HANDLER UTAMA ----------
exports.handler = async (event, context) => {
  console.log(`📨 ${event.httpMethod} ${event.path}`);

  // CORS Headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Hanya POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' }),
    };
  }

  // Cek koneksi Redis
  if (!redis) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Database not connected. Please set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Netlify environment variables.',
      }),
    };
  }

  // Parse body
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { action, invoice, device_info, ip, fingerprint, serial, newInvoiceId } = body;
  const INVOICE_SET_KEY = 'invoices';

  try {
    // ---------- ACTION HANDLERS ----------
    if (action === 'validate') {
      if (!invoice) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invoice required' }) };
      }
      const raw = await redis.get(`invoice:${invoice}`);
      if (!raw) {
        return { statusCode: 200, headers, body: JSON.stringify({ valid: false, message: 'Invoice not found' }) };
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (data.activated) {
        return { statusCode: 200, headers, body: JSON.stringify({ valid: false, message: 'Invoice already used' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ valid: true, message: 'Invoice valid' }) };
    }

    if (action === 'activate') {
      if (!invoice) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invoice required' }) };
      }
      const key = `invoice:${invoice}`;
      const raw = await redis.get(key);
      if (!raw) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Invoice not found' }) };
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (data.activated) {
        const existingFingerprint = data.fingerprint || '';
        const existingSerial = data.serial || '';
        const currentFingerprint = fingerprint || '';
        const currentSerial = serial || '';
        if (existingFingerprint === currentFingerprint || existingSerial === currentSerial) {
          data.activatedAt = new Date().toISOString();
          await redis.set(key, JSON.stringify(data));
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Re-activation successful' }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Invoice already used by another device' }) };
      }

      const location = await getLocation(ip || 'unknown');
      const updated = {
        ...data,
        activated: true,
        activatedAt: new Date().toISOString(),
        device_info: device_info || '',
        ip: ip || 'unknown',
        fingerprint: fingerprint || '',
        serial: serial || '',
        location,
      };
      await redis.set(key, JSON.stringify(updated));
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Activation successful' }) };
    }

    if (action === 'list') {
      const ids = await redis.smembers(INVOICE_SET_KEY);
      const invoices = [];
      for (const id of ids) {
        const raw = await redis.get(`invoice:${id}`);
        if (raw) {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          invoices.push({ invoice: id, ...data });
        }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: invoices }) };
    }

    if (action === 'add') {
      let id = newInvoiceId ? newInvoiceId.trim() : '';
      if (!id) {
        id = generateInvoiceId();
      } else {
        const exists = await redis.get(`invoice:${id}`);
        if (exists) {
          return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Invoice ID already exists' }) };
        }
      }
      const newData = {
        invoice: id,
        activated: false,
        createdAt: new Date().toISOString(),
        device_info: '',
        ip: '',
        fingerprint: '',
        serial: '',
        location: { country: '', region: '', city: '' }
      };
      await redis.set(`invoice:${id}`, JSON.stringify(newData));
      await redis.sadd(INVOICE_SET_KEY, id);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Invoice added', invoice: id }) };
    }

    if (action === 'delete') {
      if (!invoice) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invoice required' }) };
      }
      const exists = await redis.get(`invoice:${invoice}`);
      if (!exists) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Invoice not found' }) };
      }
      await redis.del(`invoice:${invoice}`);
      await redis.srem(INVOICE_SET_KEY, invoice);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Invoice deleted' }) };
    }

    if (action === 'reset') {
      if (!invoice) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invoice required' }) };
      }
      const raw = await redis.get(`invoice:${invoice}`);
      if (!raw) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Invoice not found' }) };
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const resetData = {
        ...data,
        activated: false,
        activatedAt: null,
        device_info: '',
        ip: '',
        fingerprint: '',
        serial: '',
        location: { country: '', region: '', city: '' }
      };
      await redis.set(`invoice:${invoice}`, JSON.stringify(resetData));
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Invoice reset' }) };
    }

    if (action === 'stats') {
      const ids = await redis.smembers(INVOICE_SET_KEY);
      let total = ids.length;
      let active = 0;
      for (const id of ids) {
        const raw = await redis.get(`invoice:${id}`);
        if (raw) {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data && data.activated) active++;
        }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, total, active, inactive: total - active }) };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Unknown action' })
    };
  } catch (error) {
    console.error('API Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      }),
    };
  }
};
